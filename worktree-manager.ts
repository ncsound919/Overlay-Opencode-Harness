/**
 * Worktree Manager: git worktree creation, diff extraction, and cleanup
 *
 * Every settled action runs in an isolated git worktree so that failed or
 * rejected actions never touch the real working tree. Only diffs from a
 * PASS-scored worktree are promoted (see settlement-supervisor.ts).
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface Worktree {
  path: string;
  id: string;
  base_repo: string;
  cleanup: () => Promise<void>;
}

export interface FileDiff {
  path: string;
  diff: string;
  content: string;
}

// =============================================================================
// GIT PRECONDITIONS
// =============================================================================

async function assertIsGitRepo(repo_path: string): Promise<void> {
  if (!fs.existsSync(repo_path)) {
    throw new WorktreeError(`Base repo path does not exist: ${repo_path}`);
  }

  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo_path });
  } catch (e) {
    throw new WorktreeError(
      `'${repo_path}' is not a git repository (or git is unavailable): ${(e as Error).message}`
    );
  }
}

// =============================================================================
// WORKTREE CREATION / CLEANUP
// =============================================================================

/**
 * Create a temporary, detached git worktree from base_repo's current HEAD.
 * The worktree is created under the system tmpdir, keyed by worktree_id so
 * concurrent actions never collide.
 *
 * Returns a handle with a `cleanup()` function; callers MUST call cleanup()
 * whether settlement passes or fails — worktrees are always ephemeral, only
 * approved diffs get promoted back into base_repo.
 */
export async function createWorktree(base_repo: string, worktree_id: string): Promise<Worktree> {
  await assertIsGitRepo(base_repo);

  const parent_dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "settlement-wt-"));
  const worktree_path = path.join(parent_dir, worktree_id);

  try {
    // Detached worktree off current HEAD; -f allows reusing branch-less state
    await execFileAsync("git", ["worktree", "add", "--detach", worktree_path, "HEAD"], {
      cwd: base_repo
    });
  } catch (e) {
    throw new WorktreeError(`Failed to create worktree '${worktree_id}': ${(e as Error).message}`);
  }

  let cleaned_up = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned_up) return;
    cleaned_up = true;

    try {
      await execFileAsync("git", ["worktree", "remove", "--force", worktree_path], {
        cwd: base_repo
      });
    } catch {
      // Worktree removal can fail if the directory was already deleted out-of-band.
      // Fall back to a filesystem-level cleanup and prune git's bookkeeping.
      if (fs.existsSync(worktree_path)) {
        fs.rmSync(worktree_path, { recursive: true, force: true });
      }
      try {
        await execFileAsync("git", ["worktree", "prune"], { cwd: base_repo });
      } catch {
        // best-effort; nothing more we can do here
      }
    }

    if (fs.existsSync(parent_dir)) {
      fs.rmSync(parent_dir, { recursive: true, force: true });
    }
  };

  return { path: worktree_path, id: worktree_id, base_repo, cleanup };
}

// =============================================================================
// DIFF EXTRACTION
// =============================================================================

/**
 * Get the set of changed files (relative to base_repo's HEAD) inside a
 * worktree, along with their unified diff and full current content.
 *
 * Includes both tracked modifications and untracked new files, since a
 * settled action may create files that didn't exist before.
 */
export async function getDiffsFromWorktree(worktree_path: string, base_path: string): Promise<FileDiff[]> {
  if (!fs.existsSync(worktree_path)) {
    throw new WorktreeError(`Worktree path does not exist: ${worktree_path}`);
  }

  let changed_paths: string[] = [];
  try {
    const { stdout: modified } = await execFileAsync(
      "git",
      ["diff", "--name-only", "HEAD"],
      { cwd: worktree_path }
    );
    const { stdout: untracked } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: worktree_path }
    );

    changed_paths = Array.from(
      new Set(
        [...modified.split("\n"), ...untracked.split("\n")]
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
      )
    );
  } catch (e) {
    throw new WorktreeError(`Failed to enumerate changes in worktree: ${(e as Error).message}`);
  }

  const diffs: FileDiff[] = [];

  for (const rel_path of changed_paths) {
    const abs_path = path.join(worktree_path, rel_path);

    let diff_text = "";
    try {
      // --no-index-style diff also covers untracked files via `git diff --no-index`
      // against /dev/null when the file isn't tracked yet.
      const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--", rel_path], {
        cwd: worktree_path
      });
      diff_text = stdout;

      if (!diff_text) {
        // Untracked file: fall back to a synthetic diff via `git add --intent-to-add`
        // so `git diff` can render it, without staging real content.
        await execFileAsync("git", ["add", "--intent-to-add", "--", rel_path], {
          cwd: worktree_path
        });
        const { stdout: intent_diff } = await execFileAsync("git", ["diff", "--", rel_path], {
          cwd: worktree_path
        });
        diff_text = intent_diff;
      }
    } catch (e) {
      throw new WorktreeError(`Failed to diff '${rel_path}': ${(e as Error).message}`);
    }

    let content = "";
    if (fs.existsSync(abs_path)) {
      content = fs.readFileSync(abs_path, "utf-8");
    }

    diffs.push({ path: rel_path, diff: diff_text, content });
  }

  return diffs;
}

/**
 * Extract raw file contents (as Buffers) for a specific set of paths from a
 * worktree. Useful when promoting binary or non-UTF8 files where a text
 * diff isn't meaningful.
 */
export async function extractFilesFromWorktree(
  worktree_path: string,
  file_paths: string[]
): Promise<{ path: string; content: Buffer }[]> {
  const results: { path: string; content: Buffer }[] = [];

  for (const rel_path of file_paths) {
    const abs_path = path.join(worktree_path, rel_path);
    if (!fs.existsSync(abs_path)) {
      throw new WorktreeError(`File not found in worktree: ${rel_path}`);
    }
    results.push({ path: rel_path, content: fs.readFileSync(abs_path) });
  }

  return results;
}

// =============================================================================
// TEST HELPER
// =============================================================================

/**
 * Initialize a throwaway git repo for tests. Not used in production code —
 * exported so test files across the project can share one implementation
 * instead of duplicating git bootstrap logic.
 */
export async function initializeTestGitRepo(repo_path: string): Promise<string> {
  fs.mkdirSync(repo_path, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repo_path });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo_path });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo_path });

  fs.mkdirSync(path.join(repo_path, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo_path, "src", "payment.ts"), "// original content\n");
  fs.writeFileSync(path.join(repo_path, "README.md"), "# test repo\n");

  await execFileAsync("git", ["add", "-A"], { cwd: repo_path });
  await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: repo_path });

  return repo_path;
}
