/**
 * OpenCode Harness: subprocess lifecycle for the OpenCode agent
 *
 * Protocol (see opencode-settlement-integration.md section 7 and
 * STAGE1_README.md "Mock OpenCode: Usage"):
 *   - stdin:  first line is the initial AgentReadState (JSON). The pipe
 *             stays open for the rest of the session so the wrapper can
 *             send tool_result messages back on later lines.
 *   - stdout: newline-delimited JSON tool calls, one per line.
 *   - process stays alive across iterations; it is not respawned per
 *     action (see mock-opencode.sh's comment on why stdin is never closed
 *     by this side either).
 */

import { spawn, ChildProcess } from "child_process";

import { AgentReadState } from "./admission-gate";

export class OpenCodeHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeHarnessError";
  }
}

export interface ToolCall {
  action_id: string;
  tool: string;
  input: Record<string, unknown>;
  claim?: string;
}

export interface ToolResultMessage {
  action_id: string;
  status: string;
  [key: string]: unknown;
}

export interface OpenCodeProcess {
  process: ChildProcess;
  id: string;
  /** Buffers stdout bytes until full lines are available. */
  _stdout_buffer: string;
  /** Resolved once the initial AgentReadState has been written to stdin. */
  _initialized: boolean;
  /** Set true once the process has exited. */
  _exited: boolean;
  /** Queued complete lines not yet consumed by readToolCall(). */
  _pending_lines: string[];
  /** Waiters for the next line, FIFO. */
  _waiters: Array<(line: string | null) => void>;
}

// =============================================================================
// SPAWN
// =============================================================================

let _process_counter = 0;

/**
 * Spawn the OpenCode subprocess and write the initial AgentReadState as
 * the first stdin line. The returned handle's stdin stays open for
 * sendToolResult() calls later in the session.
 *
 * @param env extra environment variables for the child, merged over
 *   process.env. Needed because some launchers (notably jest on Windows)
 *   do not propagate in-process process.env mutations to spawned children;
 *   callers that need deterministic child env (stubs, model selection)
 *   should pass it here explicitly.
 */
export async function spawnOpenCode(
  executable: string,
  agent_read_state: AgentReadState,
  args: string[] = [],
  env: Record<string, string> = {}
): Promise<OpenCodeProcess> {
  _process_counter++;
  const id = `ocp_${String(_process_counter).padStart(3, "0")}`;

  // Split "node script.js" / "./mock-opencode.sh" style executables into
  // command + args so callers can pass either a bare path or an
  // interpreter invocation, matching how STAGE1_README.md and
  // e2e.test.ts invoke the mock ("node mock-opencode.js").
  const parts = executable.split(" ").filter((p) => p.length > 0);
  const command = parts[0];
  const command_args = [...parts.slice(1), ...args];

  const child = spawn(command, command_args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env } as NodeJS.ProcessEnv
  });

  const ocp: OpenCodeProcess = {
    process: child,
    id,
    _stdout_buffer: "",
    _initialized: false,
    _exited: false,
    _pending_lines: [],
    _waiters: []
  };

  child.stdout!.setEncoding("utf-8");
  child.stdout!.on("data", (chunk: string) => {
    ocp._stdout_buffer += chunk;
    drainLines(ocp);
  });

  child.on("exit", () => {
    ocp._exited = true;
    // Flush any partial trailing line as a final line, then signal EOF to
    // every waiter so readToolCall() never hangs past process exit.
    if (ocp._stdout_buffer.trim().length > 0) {
      ocp._pending_lines.push(ocp._stdout_buffer);
      ocp._stdout_buffer = "";
    }
    flushWaiters(ocp);
  });

  child.on("error", (e) => {
    ocp._exited = true;
    flushWaiters(ocp);
    throw new OpenCodeHarnessError(`Failed to spawn OpenCode process '${executable}': ${e.message}`);
  });

  // Write the initial AgentReadState as the first stdin line. The wrapper
  // never closes stdin here — mock-opencode.sh explicitly documents that
  // blocking on EOF would hang it forever, since stdin stays open for
  // tool_result messages sent later in the session.
  const initial_line = JSON.stringify(agent_read_state) + "\n";
  child.stdin!.write(initial_line, "utf-8");
  ocp._initialized = true;

  return ocp;
}

function drainLines(ocp: OpenCodeProcess): void {
  let newline_idx: number;
  while ((newline_idx = ocp._stdout_buffer.indexOf("\n")) !== -1) {
    const line = ocp._stdout_buffer.slice(0, newline_idx);
    ocp._stdout_buffer = ocp._stdout_buffer.slice(newline_idx + 1);

    if (line.trim().length === 0) continue;

    const waiter = ocp._waiters.shift();
    if (waiter) {
      waiter(line);
    } else {
      ocp._pending_lines.push(line);
    }
  }
}

function flushWaiters(ocp: OpenCodeProcess): void {
  while (ocp._waiters.length > 0) {
    const waiter = ocp._waiters.shift()!;
    waiter(null);
  }
}

// =============================================================================
// READ TOOL CALL
// =============================================================================

/**
 * Read the next tool call from OpenCode's stdout. Returns null if the
 * process has exited with no more output (a graceful end of session, not
 * an error — see settlement-supervisor's loop, which breaks on null).
 *
 * A malformed JSON line is surfaced as a rejected promise rather than
 * silently skipped: the wrapper cannot admit or execute a tool call it
 * can't parse, and silently skipping it would desynchronize the
 * action_id sequence the ledger depends on.
 */
export async function readToolCall(
  ocp: OpenCodeProcess,
  timeout_ms: number = 30000
): Promise<ToolCall | null> {
  const line = await nextLine(ocp, timeout_ms);
  if (line === null) {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    throw new OpenCodeHarnessError(
      `OpenCode emitted malformed JSON on stdout: ${(e as Error).message}. Raw line: ${line}`
    );
  }

  if (typeof parsed.action_id !== "string" || typeof parsed.tool !== "string") {
    throw new OpenCodeHarnessError(
      `OpenCode tool call missing required fields (action_id, tool). Got: ${line}`
    );
  }

  return {
    action_id: parsed.action_id,
    tool: parsed.tool,
    input: parsed.input ?? {},
    claim: parsed.claim
  };
}

function nextLine(ocp: OpenCodeProcess, timeout_ms: number): Promise<string | null> {
  if (ocp._pending_lines.length > 0) {
    return Promise.resolve(ocp._pending_lines.shift()!);
  }

  if (ocp._exited) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Remove this waiter from the queue so a late line doesn't resolve
      // a promise nobody is awaiting anymore.
      const idx = ocp._waiters.indexOf(wrapped);
      if (idx !== -1) ocp._waiters.splice(idx, 1);
      resolve(null);
    }, timeout_ms);

    const wrapped = (line: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(line);
    };

    ocp._waiters.push(wrapped);
  });
}

// =============================================================================
// SEND TOOL RESULT
// =============================================================================

/**
 * Send a tool result (or a full AgentReadState refresh) back to OpenCode
 * as the next stdin line. Throws if the process has already exited, since
 * writing to a dead process's stdin would otherwise fail silently or
 * throw an unhelpful EPIPE deep in Node internals.
 */
export async function sendToolResult(ocp: OpenCodeProcess, result: ToolResultMessage): Promise<void> {
  if (ocp._exited) {
    throw new OpenCodeHarnessError(
      `Cannot send tool result '${result.action_id}': OpenCode process '${ocp.id}' has already exited`
    );
  }

  const line = JSON.stringify(result) + "\n";

  return new Promise((resolve, reject) => {
    ocp.process.stdin!.write(line, "utf-8", (err) => {
      if (err) {
        reject(new OpenCodeHarnessError(`Failed to write tool result to stdin: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}

// =============================================================================
// TERMINATE
// =============================================================================

/**
 * Terminate the OpenCode subprocess. Closes stdin first (so a
 * well-behaved process can exit on EOF), then SIGTERM, escalating to
 * SIGKILL if it hasn't exited after grace_ms. Safe to call on an
 * already-exited process.
 */
export async function terminateOpenCode(ocp: OpenCodeProcess, grace_ms: number = 2000): Promise<void> {
  if (ocp._exited) return;

  try {
    ocp.process.stdin?.end();
  } catch {
    // stdin may already be closed; not fatal.
  }

  ocp.process.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    if (ocp._exited) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      if (!ocp._exited) {
        ocp.process.kill("SIGKILL");
      }
      resolve();
    }, grace_ms);

    ocp.process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
