#!/usr/bin/env node
/**
 * stub-opencode.js: deterministic fake for the `opencode` CLI, used by
 * opencode-adapter.test.ts (and the adapter e2e) so no test ever needs a
 * live LLM call or credentials.
 *
 * Emulates only the CLI surface the adapter uses:
 *   washing: `<bin> run --format json --dir <repo> [--model m] [--session s] <message>`
 *
 * Behavior is driven by env:
 *   STUB_SCENARIO: markers | fenced | raw | direct-tool-then-clean |
 *                  single-then-exit | garbage
 *   STUB_TOOLCALL: JSON for the fake tool call, e.g.
 *                  {"tool":"read_file","input":{"path":"x"},"claim":"c"}
 *   STUB_LOG:      file path to append {args, message, session} per invocation
 *   STUB_COUNT_FILE: file path used as an invocation counter (created if missing)
 *   STUB_SESSION_ID: session id to emit (default "sess_stub_1")
 *
 * Directives:
 *   - Prints one JSON object per stdout line (mimics --format json events).
 *   - single-then-exit: first invocation emits markers; later invocations
 *     exit 0 silently (lets the harness loop terminate via EOF).
 *   - direct-tool-then-clean: first invocation emits a fake executed-tool
 *     event with no tool call; later invocations emit markers.
 *   - garbage: always prints unparseable text, exit 0.
 */

const fs = require("fs");

function count() {
  const f = process.env.STUB_COUNT_FILE;
  if (!f) return 1;
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(f, "utf-8"), 10) || 0;
  } catch {
    n = 0;
  }
  n++;
  fs.writeFileSync(f, String(n), "utf-8");
  return n;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) {
    console.log("9.9.9-stub");
    return;
  }

  const n = count();
  const scenario = process.env.STUB_SCENARIO || "markers";
  const sessionId = process.env.STUB_SESSION_ID || "sess_stub_1";

  // Log what the adapter asked for (message + session continuity).
  const logPath = process.env.STUB_LOG;
  if (logPath) {
    const sessionIdx = argv.indexOf("--session");
    const entry = {
      n,
      session: sessionIdx !== -1 ? argv[sessionIdx + 1] : null,
      hasFormatJson: argv.includes("json"),
      permission: process.env.OPENCODE_PERMISSION || null,
      autoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE || null,
      // Booleans only, never values: the adapter must strip inherited
      // server auth (upstream "Session not found" bug).
      hasServerPassword: "OPENCODE_SERVER_PASSWORD" in process.env,
      hasServerUsername: "OPENCODE_SERVER_USERNAME" in process.env,
      dir: (() => {
        const i = argv.indexOf("--dir");
        return i !== -1 ? argv[i + 1] : null;
      })(),
      model: (() => {
        const i = argv.indexOf("--model");
        return i !== -1 ? argv[i + 1] : null;
      })(),
      agent: (() => {
        const i = argv.indexOf("--agent");
        return i !== -1 ? argv[i + 1] : null;
      })(),
      messageTail: argv[argv.length - 1] ? String(argv[argv.length - 1]).slice(-1500) : ""
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  let toolCall;
  try {
    toolCall = JSON.parse(process.env.STUB_TOOLCALL || '{"tool":"read_file","input":{"path":"src/payment.ts"},"claim":"test"}');
  } catch {
    toolCall = { tool: "read_file", input: { path: "src/payment.ts" }, claim: "test" };
  }

  const markersBlock = `@@TOOLCALL@@\n${JSON.stringify(toolCall)}\n@@END@@`;

  if (scenario === "single-then-exit") {
    if (n === 1) {
      emit({ sessionID: sessionId });
      emit({ type: "text", text: `Here is my proposal:\n${markersBlock}` });
    }
    return; // later invocations: silent exit 0
  }

  if (scenario === "direct-tool-then-clean") {
    if (n === 1) {
      emit({ sessionID: sessionId });
      emit({ type: "tool.execute", tool: "read", state: "completed", input: { path: "x" }, output: "oops" });
      emit({ type: "text", text: "I read the file directly." });
      return;
    }
    emit({ sessionID: sessionId });
    emit({ type: "text", text: `Corrected proposal:\n${markersBlock}` });
    return;
  }

  if (scenario === "garbage") {
    emit({ type: "text", text: "Hmm, let me think about this some more... no concrete proposal." });
    return;
  }

  if (scenario === "provider-error") {
    emit({ sessionID: sessionId });
    emit({ type: "error", error: { type: "CreditsError", message: "Insufficient balance. Manage your billing here: https://example.invalid/billing" } });
    return;
  }

  if (scenario === "fenced") {
    emit({ sessionID: sessionId });
    emit({ type: "text", text: `My proposal:\n\`\`\`json\n${JSON.stringify(toolCall)}\n\`\`\`` });
    return;
  }

  if (scenario === "raw") {
    process.stdout.write(JSON.stringify(toolCall) + "\n");
    return;
  }

  // default: markers
  emit({ sessionID: sessionId });
  emit({ type: "text", text: `Proposal:\n${markersBlock}` });
}

main();
