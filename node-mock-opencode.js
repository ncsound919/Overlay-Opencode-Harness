#!/usr/bin/env node
/**
 * Minimal Node mock OpenCode subprocess, used only by opencode-harness.test.ts
 * to exercise edge cases (malformed output, no output, delayed output) that
 * the bash mock-opencode.sh isn't designed to simulate.
 *
 * Behavior is controlled by the MOCK_MODE env var:
 *   - "single_call"  (default): emit one valid tool call, then wait for a result
 *   - "malformed":    emit one line of invalid JSON
 *   - "silent_exit":  emit nothing, exit immediately
 *   - "delayed":      wait 200ms, then emit one valid tool call
 *   - "repeat":       emit the same valid tool call on startup AND again for
 *                     every non-empty stdin line received (simulates a stuck
 *                     agent for doom-loop breaker tests). Exits on stdin EOF
 *                     (harness terminate closes stdin) or SIGTERM.
 */

const mode = process.env.MOCK_MODE || "single_call";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  // Drain the initial AgentReadState line from stdin (not used by this mock).
  process.stdin.resume();

  if (mode === "silent_exit") {
    process.exit(0);
  }

  if (mode === "malformed") {
    process.stdout.write("{not valid json\n");
    return;
  }

  if (mode === "delayed") {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const call = { action_id: "act_001", tool: "read_file", input: { path: "src/payment.ts" }, claim: "test" };

  if (mode === "repeat") {
    emit(call);
    // Re-emit the identical call for every tool-result line the harness
    // sends back — the harness always terminates us via stdin EOF/SIGTERM.
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim().length > 0) emit(call);
      }
    });
    return;
  }

  emit(call);
}

main();
