/**
 * Tool Execution Harness: run a single tool call inside a worktree
 *
 * Rewrites any path-bearing input so the tool physically touches the
 * worktree, never the session root — this is what makes shadow execution
 * actually shadow. The agent's tool call always names a path relative to
 * the session root (e.g. "src/payment.ts"); this module is the only place
 * that translates that into a worktree-local path.
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { npmParts } from "./node-shim";

const execFileAsync = promisify(execFile);

/**
 * Pure-Node recursive grep fallback for machines without a `grep` binary
 * (e.g. stock Windows). Walks `target` (file or dir), skipping .git,
 * node_modules and .settlement, and returns matches in `path:line: text`
 * form compatible with the `grep -rn` primary path.
 */
export function nodeGrep(target: string, pattern: string): string {
  const rx = new RegExp(pattern);
  const out: string[] = [];
  const skip = new Set([".git", "node_modules", ".settlement"]);

  const walk = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (skip.has(e.name)) continue;
        walk(path.join(p, e.name));
      }
      return;
    }
    let content: string;
    try {
      const buf = fs.readFileSync(p);
      // Skip likely-binary files (NUL byte in first 8KB).
      if (buf.subarray(0, 8192).includes(0)) return;
      content = buf.toString("utf-8");
    } catch {
      return;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      try {
        if (rx.test(lines[i])) out.push(`${p}:${i + 1}:${lines[i]}`);
      } catch {
        // Invalid regex: fall back to substring search so a bad pattern
        // degrades to literal matching instead of crashing the tool call.
        if (lines[i].includes(pattern)) out.push(`${p}:${i + 1}:${lines[i]}`);
        return;
      }
    }
  };

  walk(target);
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export interface ToolExecutionResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

// =============================================================================
// PATH REWRITING
// =============================================================================

/**
 * Rewrite a tool-call path so it resolves inside the worktree instead of
 * the session root. Mirrors the rewritePathForWorktree() sketch in
 * opencode-settlement-integration.md section 5.
 */
export function rewritePathForWorktree(
  original_path: string,
  worktree_root: string,
  session_root: string
): string {
  const normalized = path.normalize(original_path);
  const is_absolute = path.isAbsolute(normalized);
  const absolute_under_session = is_absolute ? normalized : path.join(session_root, normalized);

  // Guard: refuse to rewrite a path that doesn't actually live under
  // session_root — this would silently write outside the worktree too.
  const relative_to_session = path.relative(session_root, absolute_under_session);
  if (relative_to_session.startsWith("..")) {
    throw new ToolExecutionError(
      `Path '${original_path}' resolves outside session root '${session_root}'; refusing to rewrite`
    );
  }

  return path.join(worktree_root, relative_to_session);
}

// =============================================================================
// TOOL EXECUTION
// =============================================================================

/**
 * Execute a single tool call inside a worktree. Supported tools mirror the
 * ones referenced across admission-gate.ts / mock-opencode.sh:
 * read_file, write_file, grep, list_files, run_test.
 *
 * All file-path-bearing inputs are rewritten to the worktree via
 * rewritePathForWorktree() before execution — callers should pass
 * session-root-relative paths in tool_input, exactly as the agent emitted
 * them.
 */
export async function executeToolInWorktree(
  worktree_path: string,
  tool_name: string,
  tool_input: Record<string, unknown>,
  session_root: string
): Promise<ToolExecutionResult> {
  try {
    switch (tool_name) {
      case "write_file":
        return await execWriteFile(worktree_path, tool_input, session_root);
      case "read_file":
        return await execReadFile(worktree_path, tool_input, session_root);
      case "grep":
        return await execGrep(worktree_path, tool_input, session_root);
      case "list_files":
        return await execListFiles(worktree_path, tool_input, session_root);
      case "run_test":
        return await execRunTest(worktree_path, tool_input);
      case "delete_file":
        return await execDeleteFile(worktree_path, tool_input, session_root);
      default:
        return { exit_code: 1, stdout: "", stderr: `Unknown tool: ${tool_name}` };
    }
  } catch (e) {
    if (e instanceof ToolExecutionError) {
      return { exit_code: 1, stdout: "", stderr: e.message };
    }
    return { exit_code: 1, stdout: "", stderr: `Unexpected error executing ${tool_name}: ${(e as Error).message}` };
  }
}

async function execWriteFile(
  worktree_path: string,
  input: Record<string, unknown>,
  session_root: string
): Promise<ToolExecutionResult> {
  const rel_path = input.path as string | undefined;
  const content = input.content as string | undefined;
  if (!rel_path) throw new ToolExecutionError("write_file requires 'path'");
  if (content === undefined) throw new ToolExecutionError("write_file requires 'content'");

  const target = rewritePathForWorktree(rel_path, worktree_path, session_root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");

  return { exit_code: 0, stdout: `Wrote ${content.length} bytes to ${rel_path}`, stderr: "" };
}

async function execDeleteFile(
  worktree_path: string,
  input: Record<string, unknown>,
  session_root: string
): Promise<ToolExecutionResult> {
  const rel_path = input.path as string | undefined;
  if (!rel_path) throw new ToolExecutionError("delete_file requires 'path'");

  const target = rewritePathForWorktree(rel_path, worktree_path, session_root);
  if (!fs.existsSync(target)) {
    return { exit_code: 1, stdout: "", stderr: `File not found: ${rel_path}` };
  }
  fs.rmSync(target);
  return { exit_code: 0, stdout: `Deleted ${rel_path}`, stderr: "" };
}

async function execReadFile(
  worktree_path: string,
  input: Record<string, unknown>,
  session_root: string
): Promise<ToolExecutionResult> {
  const rel_path = input.path as string | undefined;
  if (!rel_path) throw new ToolExecutionError("read_file requires 'path'");

  const target = rewritePathForWorktree(rel_path, worktree_path, session_root);
  if (!fs.existsSync(target)) {
    return { exit_code: 1, stdout: "", stderr: `File not found: ${rel_path}` };
  }
  const content = fs.readFileSync(target, "utf-8");
  return { exit_code: 0, stdout: content, stderr: "" };
}

async function execGrep(
  worktree_path: string,
  input: Record<string, unknown>,
  session_root: string
): Promise<ToolExecutionResult> {
  const pattern = input.pattern as string | undefined;
  const search_path = (input.path as string | undefined) ?? ".";
  if (!pattern) throw new ToolExecutionError("grep requires 'pattern'");

  const target = rewritePathForWorktree(search_path, worktree_path, session_root);

  if (!fs.existsSync(target)) {
    return { exit_code: 1, stdout: "", stderr: `grep path not found: ${search_path}` };
  }

  try {
    const { stdout } = await execFileAsync("grep", ["-rn", "--", pattern, target], { timeout: 15000 });
    return { exit_code: 0, stdout, stderr: "" };
  } catch (e: any) {
    // grep exits 1 with empty stdout when there are no matches — not an error
    if (e.code === 1 && !e.stderr) {
      return { exit_code: 0, stdout: "", stderr: "" };
    }
    // ENOENT / spawn failure (no grep binary, e.g. stock Windows):
    // fall back to the pure-Node implementation instead of failing.
    if (e.code === "ENOENT" || /ENOENT/i.test(String(e.message ?? e))) {
      try {
        return { exit_code: 0, stdout: nodeGrep(target, pattern), stderr: "" };
      } catch (fallback_err) {
        return { exit_code: 1, stdout: "", stderr: `grep fallback failed: ${(fallback_err as Error).message}` };
      }
    }
    return { exit_code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(e) };
  }
}

async function execListFiles(
  worktree_path: string,
  input: Record<string, unknown>,
  session_root: string
): Promise<ToolExecutionResult> {
  const search_path = (input.path as string | undefined) ?? ".";
  const target = rewritePathForWorktree(search_path, worktree_path, session_root);

  if (!fs.existsSync(target)) {
    return { exit_code: 1, stdout: "", stderr: `Directory not found: ${search_path}` };
  }

  const entries = fs.readdirSync(target, { withFileTypes: true });
  const listing = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
  return { exit_code: 0, stdout: listing, stderr: "" };
}

async function execRunTest(
  worktree_path: string,
  input: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const suite = input.suite as string | undefined;
  if (!suite) throw new ToolExecutionError("run_test requires 'suite'");

  // Run within the worktree so tests see the shadow-execution copy of the
  // codebase, not the real session root. npm via node+launcher
  // (node-shim): bare npm.cmd cannot spawn shell-free on Windows.
  try {
    const npm = npmParts();
    const args = [...npm.prefixArgs, "test", "--", suite];
    const { stdout, stderr } = await execFileAsync(npm.command, args, { cwd: worktree_path, timeout: 120000 });
    return { exit_code: 0, stdout, stderr };
  } catch (e: any) {
    return {
      exit_code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? `Test run failed: ${(e as Error).message}`
    };
  }
}
