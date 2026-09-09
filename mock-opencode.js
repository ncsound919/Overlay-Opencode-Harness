#!/usr/bin/env node
/**
 * Cross-platform phased mock OpenCode subprocess.
 *
 * Mirrors mock-opencode.sh's deterministic per-phase tool-call sequences
 * (diagnostic -> edit -> verify), but runs on plain Node so it works on
 * stock Windows where bash/jq are unavailable. mock-opencode.sh remains the
 * Unix reference; this file is the Windows-capable equivalent.
 *
 * Protocol (same as the .sh mock and opencode-settlement-integration.md):
 *   - stdin:  first line is the initial AgentReadState (JSON). Remaining
 *             stdin (tool results) is drained and ignored.
 *   - stdout: newline-delimited JSON tool calls, one object per line.
 *   - exits after emitting its sequence (the harness treats EOF as end of
 *     session and breaks its read loop via readToolCall() -> null).
 */

let counter = 0;

function emit(tool, input, claim) {
  counter += 1;
  const action_id = `act_${String(counter).padStart(3, "0")}`;
  process.stdout.write(JSON.stringify({ action_id, tool, input, claim }) + "\n");
}

async function readFirstLine() {
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
      resolve(buf);
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

function field(obj, dotted) {
  return dotted.split(".").reduce((acc, k) => (acc != null ? acc[k] : undefined), obj);
}

async function main() {
  const firstLine = await readFirstLine();
  // Keep draining tool-result lines so the harness never gets EPIPE/SIGPIPE.
  process.stdin.resume();
  process.stdin.on("data", () => {});

  let state = {};
  try {
    state = JSON.parse(firstLine || "{}");
  } catch {
    state = {};
  }

  const phase = field(state, "current_phase.name") || "diagnostic";
  const lastRejection = field(state, "last_rejection.reason") || "";

  if (phase === "diagnostic") {
    emit("read_file", { path: "src/payment.ts" }, "analyzing_codebase");
    emit("grep", { pattern: "async", path: "src/" }, "checking_async_usage");
    emit(
      "write_file",
      {
        path: ".settlement/agent_analysis.md",
        content:
          "# Codebase Analysis\n\nThe payment processor is currently synchronous.\n\n## Refactoring Plan\n\n1. Convert main function to async\n2. Add timeout guards\n3. Update all call sites\n4. Run tests\n"
      },
      "codebase_structure_doc"
    );
    return;
  }

  if (phase === "edit") {
    if (lastRejection) {
      emit(
        "write_file",
        {
          path: "src/payment.ts",
          content:
            "async function processPayment(amount) {\n  const timeoutPromise = new Promise((_, reject) => {\n    setTimeout(() => reject(new Error(\"Timeout\")), 5000);\n  });\n  const result = await Promise.race([fetchPaymentStatus(amount), timeoutPromise]);\n  return result;\n}\n"
        },
        "refactor_claim"
      );
      emit("run_test", { suite: "tests/payment.test.ts", pattern: "async.*" }, "test_claim");
      return;
    }
    emit(
      "write_file",
      {
        path: "src/payment.ts",
        content:
          "async function processPayment(amount) {\n  const result = await fetchPaymentStatus(amount);\n  return result;\n}\n"
      },
      "refactor_claim"
    );
    emit("run_test", { suite: "tests/payment.test.ts", pattern: "async.*" }, "test_claim");
    return;
  }

  if (phase === "verify") {
    emit("run_test", { suite: "tests/payment.test.ts" }, "verification");
    emit("run_test", { suite: "tests/payment.test.ts", coverage: true }, "coverage_verification");
    emit("read_file", { path: "src/payment.ts" }, "verification");
    return;
  }

  if (phase === "complete") {
    return;
  }

  console.error(`[mock-opencode.js] Unknown phase: ${phase}`);
  process.exitCode = 1;
}

main();
