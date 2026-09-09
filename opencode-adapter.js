#!/usr/bin/env node
/**
 * opencode-adapter.js: protocol adapter between the settlement harness and
 * the real OpenCode CLI (`opencode run`).
 *
 * The harness speaks NDJSON tool calls on stdout / tool results on stdin
 * (see opencode-settlement-integration.md section 7). The real OpenCode CLI
 * does not speak that protocol — it is an interactive agent that acts with
 * its own tools. This adapter bridges the two WITHOUT weakening settlement:
 *
 *   1. The model is run as a pure PROPOSER. Every `opencode run` child is
 *      spawned with OPENCODE_PERMISSION set to deny-all, so the model
 *      cannot read, write, or execute anything itself. All execution happens
 *      inside the harness's shadow worktrees; the harness remains the sole
 *      executor. Deny-all is strictly stronger than any user permission, so
 *      injecting it cannot weaken the operator's own rules.
 *   2. Per harness iteration the adapter prompts the model for exactly one
 *      tool call, extracts it from `--format json` event output, validates
 *      its shape, and prints it as a single NDJSON line. Only stdout lines
 *      are tool calls; all diagnostics go to stderr.
 *   3. Session continuity: the adapter captures the opencode session ID from
 *      the JSON events and continues it (`--session`) on later iterations.
 *      If no ID is found it falls back to stateless re-prompting with the
 *      accumulated history inline (more tokens, still correct).
 *   4. Misbehavior (unparseable output, direct tool-use events) triggers a
 *      correction re-prompt in the same session, bounded by --max-retries.
 *      On exhaustion the adapter exits non-zero with stderr only, which the
 *      harness treats as a graceful end of session (EOF -> null -> break).
 *
 * Usage (the harness spawns this as its `opencode_executable`):
 *   node opencode-adapter.js --repo <session-repo> [--model p/m]
 *     [--bin <opencode-bin>] [--max-retries N] [--timeout-ms N]
 *     [--max-history N]
 *
 * Env overrides: OPENCODE_BIN (may include prefix args, e.g.
 *   "node ./stub-opencode.js"), OPENCODE_MODEL, ADAPTER_TIMEOUT_MS,
 *   ADAPTER_MAX_RETRIES, ADAPTER_MAX_HISTORY.
 *
 * Live-use note: set the harness's tool_call_timeout_ms HIGHER than this
 * adapter's --timeout-ms (each iteration is at least one LLM call).
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MARK_START = "@@TOOLCALL@@";
const MARK_END = "@@END@@";

// Deny-all permission lockdown for every child `opencode run` invocation.
// Covers every tool key in the permissions doc plus the doom_loop guard so
// a headless run can never block on an approval prompt.
const LOCKDOWN_PERMISSION = JSON.stringify({
  read: "deny",
  edit: "deny",
  glob: "deny",
  grep: "deny",
  bash: "deny",
  task: "deny",
  skill: "deny",
  lsp: "deny",
  question: "deny",
  webfetch: "deny",
  websearch: "deny",
  doom_loop: "deny"
});

// Tool names the real OpenCode agent could execute directly. Used only by
// the direct-tool-use backstop detector (primary enforcement is LOCKDOWN).
const KNOWN_DIRECT_TOOLS = new Set([
  "read", "edit", "write", "patch", "bash", "glob", "grep",
  "task", "skill", "webfetch", "websearch", "lsp", "todowrite", "question"
]);

function defaultBin() {
  return process.platform === "win32" ? "opencode.cmd" : "opencode";
}

function parseArgs(argv) {
  const out = {
    repo: null,
    model: process.env.OPENCODE_MODEL || null,
    agent: process.env.SETTLEMENT_AGENT || process.env.OPENCODE_AGENT || null,
    bin: null,
    maxRetries: parseInt(process.env.ADAPTER_MAX_RETRIES || "2", 10),
    timeoutMs: parseInt(process.env.ADAPTER_TIMEOUT_MS || "300000", 10),
    maxHistory: parseInt(process.env.ADAPTER_MAX_HISTORY || "20", 10)
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--agent") out.agent = argv[++i];
    else if (a === "--bin") out.bin = argv[++i];
    else if (a === "--max-retries") out.maxRetries = parseInt(argv[++i], 10);
    else if (a === "--timeout-ms") out.timeoutMs = parseInt(argv[++i], 10);
    else if (a === "--max-history") out.maxHistory = parseInt(argv[++i], 10);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.repo) throw new Error("Missing required --repo <session-repo>");
  return out;
}

/** Split OPENCODE_BIN/--bin into executable + prefix args (for stubs). */
function binParts(explicitBin) {
  const raw = explicitBin || process.env.OPENCODE_BIN || defaultBin();
  const parts = raw.split(" ").filter((p) => p.length > 0);
  return { command: parts[0], prefixArgs: parts.slice(1) };
}

/**
 * On Windows, `opencode.cmd` cannot be spawned directly (EINVAL without a
 * shell, and shell quoting of LLM prompts is fragile). npm's shim is just
 * `node <npm>/node_modules/opencode-ai/bin/opencode ...`, so resolve that
 * launcher and run it with node and a clean argv array — no shell involved.
 * Returns { command, prefixArgs } or null when it cannot resolve (caller
 * keeps the original command and surfaces the error).
 */
function resolveWindowsShim(command) {
  if (process.platform !== "win32" || !/\.cmd$/i.test(command)) return null;
  try {
    const found = spawnSync("where.exe", [command], { encoding: "utf-8", timeout: 10000 });
    const first = String((found && found.stdout) || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (!first) return null;
    const launcher = path.join(path.dirname(first), "node_modules", "opencode-ai", "bin", "opencode");
    if (fs.existsSync(launcher)) return { command: "node", prefixArgs: [launcher] };
  } catch {
    // fall through to null
  }
  return null;
}

// =============================================================================
// PROMPT BUILDERS (pure, unit-tested)
// =============================================================================

const TOOL_VOCABULARY = `read_file {path}, write_file {path, content}, grep {pattern, path}, list_files {path}, run_test {suite, pattern?}, delete_file {path}`;

function describeState(state) {
  const phase = state.current_phase || {};
  const contract = state.contract || {};
  const scope = contract.scope || {};
  const receipts = state.receipts_so_far || [];
  const recent = receipts.slice(-5).map((r) => `- ${r.action_id} ${r.tool_name} -> ${r.settlement}`).join("\n");
  return [
    `Phase: ${phase.name || "?"} — ${phase.description || ""}`,
    `Permitted tools this phase: ${(phase.permitted_tools || []).join(", ")}`,
    `Admitted claim types: ${(phase.claim_types_admitted || []).join(", ")}`,
    `Scope: ${scope.description || ""}`,
    `Files in scope: ${(scope.files_in_scope || []).join(", ")}`,
    `Forbidden operations: ${((scope.forbidden_operations || []).join(", ")) || "(none)"}`,
    `Missing evidence (what the phase needs): ${(state.missing_evidence || []).join(", ") || "(none — phase may be complete)"}`,
    `Autonomy class: ${state.autonomy_class || "?"}`,
    `Settled receipts so far: ${receipts.length}${recent ? "\n" + recent : ""}`,
    state.last_rejection
      ? `Last rejection: [${state.last_rejection.action_id} ${state.last_rejection.tool_name}] ${state.last_rejection.reason}`
      : `Last rejection: none`
  ].join("\n");
}

function protocolBlock() {
  return [
    `PROTOCOL (follow exactly):`,
    `1. You cannot act directly. All tools are disabled for you; the settlement harness executes actions in an isolated worktree and returns real results.`,
    `2. Reply with EXACTLY ONE tool call for this iteration, wrapped as:`,
    `${MARK_START}`,
    `{"tool": "<name>", "input": {...}, "claim": "<evidence-type-you-are-pursuing>"}`,
    `${MARK_END}`,
    `3. Tool vocabulary (input schemas): ${TOOL_VOCABULARY}.`,
    `4. Propose only tools permitted this phase. Set "claim" to one of the admitted claim types, preferably one from missing evidence.`,
    `5. Do not use any other tool. Do not print anything outside the wrapped block except brief reasoning.`
  ].join("\n");
}

function buildInitialPrompt(state) {
  return [
    `You are the proposer for a settlement-gated coding session. The harness executes; you decide WHAT to try next.`,
    ``,
    describeState(state),
    ``,
    protocolBlock()
  ].join("\n");
}

function summarizeResult(result) {
  const parts = [`status=${result.status || "?"}`];
  if (result.settlement) parts.push(`settlement=${result.settlement}`);
  if (result.reason) parts.push(`reason=${result.reason}`);
  if (result.rejection_reason) parts.push(`rejection_reason=${result.rejection_reason}`);
  if (result.failed_probes) parts.push(`failed_probes=${JSON.stringify(result.failed_probes)}`);
  if (result.metrics) parts.push(`metrics=${JSON.stringify(result.metrics)}`);
  if (result.result) parts.push(`output=${String(result.result).slice(0, 2000)}`);
  const ps = result.phase_state || {};
  if (ps.current_phase_name) parts.push(`phase=${ps.current_phase_name}`);
  if (ps.missing_evidence) parts.push(`missing=${JSON.stringify(ps.missing_evidence)}`);
  if (result.phase_transitioned_to) parts.push(`transitioned_to=${result.phase_transitioned_to}`);
  if (result.next_phase) parts.push(`next_phase=${result.next_phase.name}: tools=[${(result.next_phase.permitted_tools || []).join(",")}]`);
  return parts.join(" | ");
}

function buildFollowupPrompt(state, trackedPhase, lastExchange, history, maxHistory = 20) {
  const lines = [
    `Harness result for your last proposal [${lastExchange.tool} claim=${lastExchange.claim || "none"}]:`,
    summarizeResult(lastExchange.result),
    ``
  ];
  if (lastExchange.result && (lastExchange.result.status === "ADMISSION_DENIED" || lastExchange.result.settlement === "REJECTED")) {
    lines.push(`That proposal was REJECTED. Treat the reason above as a hard constraint: do not repeat the same mistake; adapt (different tool, in-scope path, permitted tool, or evidence the phase actually needs).`, ``);
  }
  if (trackedPhase) {
    lines.push(`Current phase is now: ${trackedPhase.name || trackedPhase} (per harness phase_state).`, ``);
  }
  const tail = history.slice(-maxHistory);
  if (tail.length > 0) {
    lines.push(`Recent history (most recent last):`);
    for (const h of tail) lines.push(`- [${h.tool}] ${h.status}: ${(h.note || "").slice(0, 300)}`);
    lines.push(``);
  }
  lines.push(protocolBlock());
  return lines.join("\n");
}

function buildCorrectionPrompt(kind, detail) {
  const why =
    kind === "direct-tool-use"
      ? `You attempted to use your own tools directly (${detail}). Your tools are disabled and any direct action is discarded.`
      : `Your last reply contained no parseable tool call (${detail}).`;
  return [
    why,
    `Propose EXACTLY ONE harness tool call, wrapped as:`,
    `${MARK_START}`,
    `{"tool": "<name>", "input": {...}, "claim": "<type>"}`,
    `${MARK_END}`,
    `Nothing else will be read.`
  ].join("\n");
}

// =============================================================================
// OUTPUT PARSING (pure, unit-tested)
// =============================================================================

/** Recursively collect all string values from parsed JSON events. */
function collectStrings(value, out, budget) {
  if (out.joined >= budget) return out;
  if (typeof value === "string") {
    out.parts.push(value);
    out.joined += value.length;
  } else if (Array.isArray(value)) {
    for (const v of value) {
      collectStrings(v, out, budget);
      if (out.joined >= budget) break;
    }
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      collectStrings(v, out, budget);
      if (out.joined >= budget) break;
    }
  }
  return out;
}

function stringsFromEvents(events, budget = 200000) {
  return collectStrings(events, { parts: [], joined: 0 }, budget).parts.join("\n");
}

/** Recursively find an opencode session ID in parsed events. */
function findSessionId(value) {
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findSessionId(v);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "sessionID" || k === "sessionId" || k === "session_id") && typeof v === "string" && v.length > 0) {
        return v;
      }
      const found = findSessionId(v);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Backstop detector for direct tool execution by the model (primary
 * enforcement is the deny-all OPENCODE_PERMISSION lockdown). Flags objects
 * shaped like executed tool calls: a known tool name plus execution
 * evidence (state/status/output/result). Free-text mentions never match
 * because they are strings, not objects with these keys.
 */
function detectDirectToolUse(events) {
  const hits = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      const toolVal = value.tool || value.toolName || value.tool_name;
      const hasEvidence =
        typeof value.state === "string" ||
        typeof value.status === "string" ||
        value.output !== undefined ||
        value.result !== undefined ||
        value.callID !== undefined ||
        value.callId !== undefined;
      if (typeof toolVal === "string" && KNOWN_DIRECT_TOOLS.has(toolVal) && hasEvidence) {
        hits.push(toolVal);
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(events);
  return hits;
}

/**
 * Provider/billing/auth failures will never succeed on retry — surface
 * them immediately instead of burning retries (and the operator's time).
 * Returns the error message, or null when the events show no fatal error.
 */
function findFatalError(events) {
  let found = null;
  const visit = (value) => {
    if (found) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      if (value.type === "error" && value.error && typeof value.error === "object") {
        const tag = `${value.error.type || ""} ${value.error.code || ""} ${value.error.message || ""}`;
        if (/credit|billing|balance|unauthorized|unauthenticated|authentication|forbidden|api.?key/i.test(tag)) {
          found = String(value.error.message || value.error.type || "provider error");
          return;
        }
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(events);
  return found;
}

function validShape(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (typeof obj.tool !== "string" || obj.tool.length === 0) return null;
  return {
    tool: obj.tool,
    input: obj.input && typeof obj.input === "object" && !Array.isArray(obj.input) ? obj.input : {},
    claim: typeof obj.claim === "string" ? obj.claim : undefined
  };
}

/** Find balanced {...} candidates containing `"tool"` via brace matching. */
function scanJsonObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          if (candidate.includes('"tool"')) out.push(candidate);
          break;
        }
      }
    }
  }
  return out;
}

function extractToolCall(text) {
  if (!text || typeof text !== "string") return null;

  const marked = text.match(new RegExp(`${MARK_START}\\s*([\\s\\S]*?)\\s*${MARK_END}`));
  if (marked) {
    try {
      const shaped = validShape(JSON.parse(marked[1]));
      if (shaped) return shaped;
    } catch {
      // fall through to other strategies
    }
  }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      const shaped = validShape(JSON.parse(fence[1].trim()));
      if (shaped) return shaped;
    } catch {
      // fall through
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const shaped = validShape(JSON.parse(trimmed));
      if (shaped) return shaped;
    } catch {
      // fall through
    }
  }

  for (const candidate of scanJsonObjects(text)) {
    try {
      const shaped = validShape(JSON.parse(candidate));
      if (shaped) return shaped;
    } catch {
      continue;
    }
  }

  return null;
}

// =============================================================================
// OPENCODE INVOCATION
// =============================================================================

// Server/session vars that must NEVER reach the child (see buildChildEnv).
const STRIPPED_SERVER_ENV = [
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE",
  "OPENCODE_PID",
  "OPENCODE_RUN_ID"
];

/**
 * Build the child env for `opencode run`: lockdown permissions, no
 * auto-update, isolated DB — and with inherited server/session vars
 * stripped. When this adapter runs inside an OpenCode session (Desktop,
 * parent CLI, or this very harness driven by an agent), the parent
 * environment carries OPENCODE_SERVER_PASSWORD/USERNAME for a DIFFERENT
 * server. A plain `opencode run` child starts its own in-process server
 * which then demands that auth while its in-process SDK client sends
 * none, and every invocation dies with "Error: Session not found"
 * (upstream #8502, #24204, #28407; same fix as Open Design PR #3806).
 * The child never uses --attach, so dropping these keys is always safe.
 */
function buildChildEnv(dbPath) {
  const env = {
    ...process.env,
    OPENCODE_PERMISSION: LOCKDOWN_PERMISSION,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DB: dbPath
  };
  for (const k of STRIPPED_SERVER_ENV) delete env[k];
  return env;
}

function runOpencodeOnce({ command, prefixArgs, repo, model, agent, sessionId, message, timeoutMs, dbPath }) {
  return new Promise((resolve) => {
    const args = ["run", "--format", "json", "--dir", repo];
    if (model) args.push("--model", model);
    if (agent) args.push("--agent", agent);
    if (sessionId) args.push("--session", sessionId);
    args.push(message);

    const child = spawn(command, [...prefixArgs, ...args], {
      cwd: repo,
      env: buildChildEnv(dbPath),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (e) => {
      const hint =
        process.platform === "win32" && /\.cmd$/i.test(command)
          ? " (Windows .cmd shim could not be launched; set OPENCODE_BIN to `node <npm>/node_modules/opencode-ai/bin/opencode`)"
          : "";
      resolve({ ok: false, error: `spawn failed: ${e.message}${hint}`, events: [], stdout: "", stderr: "" });
    });
    child.on("close", (code, signal) => {
      if (signal) {
        resolve({ ok: false, error: `killed by ${signal} (timeout ${timeoutMs}ms?)`, events: [], stdout, stderr });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, error: `exit code ${code}: ${stderr.slice(-2000)}`, events: [], stdout, stderr });
        return;
      }
      const events = [];
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          events.push(JSON.parse(t));
        } catch {
          events.push({ _raw: t });
        }
      }
      resolve({ ok: true, events, stdout, stderr });
    });
  });
}

// =============================================================================
// MAIN LOOP
// =============================================================================

function log(...args) {
  console.error("[adapter]", ...args);
}

function readLine() {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf-8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        cleanup();
        resolve(buf.slice(0, idx));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let { command, prefixArgs } = binParts(opts.bin);
  const shim = resolveWindowsShim(command);
  if (shim) {
    log(`resolved Windows shim ${command} -> node ${shim.prefixArgs[0]}`);
    command = shim.command;
    prefixArgs = [...shim.prefixArgs, ...prefixArgs];
  }

  const firstLine = await readLine();
  if (firstLine === null || firstLine.trim() === "") {
    throw new Error("No initial AgentReadState on stdin; refusing to start");
  }
  const state = JSON.parse(firstLine);
  // Keep draining stdin (tool results arrive on later lines).
  process.stdin.pause();

  log(`repo=${opts.repo} model=${opts.model || "(default)"} agent=${opts.agent || "(default)"} maxRetries=${opts.maxRetries}`);

  // Per-session isolated opencode database (see runOpencodeOnce). Ensure
  // the parent dir exists — sqlite will not create it.
  const dbPath = path.join(opts.repo, ".settlement", "opencode.db");
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch (e) {
    throw new Error(`Cannot create settlement dir for isolated DB: ${(e && e.message) || e}`);
  }
  log(`isolated OPENCODE_DB=${dbPath}`);

  let sessionId = null;
  let statelessFallback = false;
  let trackedPhase = state.current_phase || null;
  const history = [];
  let actionSeq = 0;
  let firstIteration = true;
  let pendingResult = null;

  for (;;) {
    const prompt = firstIteration
      ? buildInitialPrompt(state)
      : buildFollowupPrompt(state, trackedPhase, pendingResult.exchange, history, opts.maxHistory);

    let toolCall = null;
    let attemptPrompt = prompt;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      const res = await runOpencodeOnce({
        command,
        prefixArgs,
        repo: opts.repo,
        model: opts.model,
        agent: opts.agent,
        sessionId: statelessFallback ? null : sessionId,
        message: attemptPrompt,
        timeoutMs: opts.timeoutMs,
        dbPath
      });
      if (!res.ok) {
        log(`opencode invocation failed (attempt ${attempt + 1}): ${res.error}`);
        if (attempt >= opts.maxRetries) {
          throw new Error(`opencode invocation failed after ${opts.maxRetries + 1} attempts: ${res.error}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      const foundId = findSessionId(res.events);
      if (foundId && !sessionId) {
        sessionId = foundId;
        log(`captured session ${sessionId}`);
      } else if (!foundId && sessionId === null && !statelessFallback) {
        statelessFallback = true;
        log("no session ID in events; falling back to stateless re-prompting with inline history");
      }

      const fatalProviderError = findFatalError(res.events);
      if (fatalProviderError) {
        throw new Error(`opencode provider error (not retried): ${fatalProviderError.slice(0, 300)}`);
      }

      const directHits = detectDirectToolUse(res.events);
      if (directHits.length > 0) {
        log(`direct tool use detected (${directHits.join(",")}); correcting`);
        if (attempt >= opts.maxRetries) {
          throw new Error(`model kept using direct tools (${directHits.join(",")}); aborting session`);
        }
        attemptPrompt = buildCorrectionPrompt("direct-tool-use", directHits.join(", "));
        continue;
      }

      const text = stringsFromEvents(res.events);
      if (res.stderr) log(`opencode stderr (tail): ${res.stderr.slice(-500)}`);
      toolCall = extractToolCall(text);
      if (!toolCall) {
        log(`no parseable tool call (attempt ${attempt + 1}); model text (tail): ${text.slice(-1500)}`);
        if (attempt >= opts.maxRetries) break;
        attemptPrompt = buildCorrectionPrompt("unparseable", text.slice(0, 300));
        continue;
      }
      break;
    }

    if (!toolCall) {
      throw new Error(`Could not obtain a valid tool call after ${opts.maxRetries + 1} attempts; aborting session`);
    }

    actionSeq++;
    const action_id = `act_${String(actionSeq).padStart(3, "0")}`;
    process.stdout.write(JSON.stringify({ action_id, tool: toolCall.tool, input: toolCall.input, claim: toolCall.claim }) + "\n");

    const nextLine = await readLine();
    if (nextLine === null) {
      log("stdin EOF; harness is done. Exiting 0.");
      process.exit(0);
    }
    let result;
    try {
      result = JSON.parse(nextLine);
    } catch {
      log("ignoring non-JSON stdin line");
      continue;
    }
    const status = result.settlement === "REJECTED" || result.status === "ADMISSION_DENIED" ? result.status || "SETTLEMENT_REJECTED" : result.status || result.settlement || "?";
    history.push({
      tool: toolCall.tool,
      status,
      note: result.rejection_reason || result.reason || summarizeResult(result)
    });
    if (history.length > opts.maxHistory * 2) history.splice(0, history.length - opts.maxHistory * 2);

    const ps = result.phase_state || {};
    if (result.next_phase) trackedPhase = result.next_phase;
    else if (ps.current_phase_name) trackedPhase = { ...(trackedPhase || {}), name: ps.current_phase_name };

    pendingResult = { exchange: { tool: toolCall.tool, claim: toolCall.claim, result } };
    firstIteration = false;
  }
}

if (require.main === module) {
  // Exit paths: stdin EOF -> 0 (harness done). Any fatal -> 1 with stderr
  // only, so the harness sees a clean EOF and ends the session gracefully.
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(`[adapter] FATAL: ${e && e.message ? e.message : e}`);
      process.exit(1);
    }
  );
}

module.exports = {
  MARK_START,
  MARK_END,
  LOCKDOWN_PERMISSION,
  STRIPPED_SERVER_ENV,
  parseArgs,
  binParts,
  resolveWindowsShim,
  buildChildEnv,
  buildInitialPrompt,
  buildFollowupPrompt,
  buildCorrectionPrompt,
  summarizeResult,
  extractToolCall,
  findFatalError,
  collectStrings,
  stringsFromEvents,
  findSessionId,
  detectDirectToolUse,
  validShape,
  describeState
};
