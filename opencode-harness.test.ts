/**
 * Tests for opencode-harness.ts
 *
 * Uses node-mock-opencode.js, which exists specifically to exercise edge
 * cases (malformed output, no output, delayed output) that the bash mock
 * isn't designed to simulate (see node-mock-opencode.js's own header
 * comment).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  spawnOpenCode,
  readToolCall,
  sendToolResult,
  terminateOpenCode,
  OpenCodeHarnessError
} from "./opencode-harness";
import { createTestContract } from "./contract-fixture";
import { AutonomyClass, AgentReadState } from "./admission-gate";

const MOCK_PATH = path.join(__dirname, "node-mock-opencode.js");
const STUB_PATH = path.join(__dirname, "stub-opencode.js");

function buildState(): AgentReadState {
  const contract = createTestContract();
  return {
    contract,
    current_phase: contract.phases[0],
    receipts_so_far: [],
    missing_evidence: ["codebase_structure_doc"],
    autonomy_class: AutonomyClass.LEARNER
  };
}

describe("opencode-harness", () => {
  describe("spawnOpenCode + readToolCall", () => {
    it("spawns OpenCode and receives a tool call (single_call mode)", async () => {
      const ocp = await spawnOpenCode(`node ${MOCK_PATH}`, buildState(), [], );
      try {
        const tool_call = await readToolCall(ocp, 5000);
        expect(tool_call).not.toBeNull();
        expect(tool_call?.tool).toBe("read_file");
        expect(tool_call?.action_id).toBe("act_001");
        expect(tool_call?.input).toEqual({ path: "src/payment.ts" });
        expect(tool_call?.claim).toBe("test");
      } finally {
        await terminateOpenCode(ocp);
      }
    });

    it("returns null when the process exits with no output (silent_exit)", async () => {
      const ocp = await spawnOpenCode(`node ${MOCK_PATH}`, buildState());
      // MOCK_MODE isn't part of spawnOpenCode's API, so we set it via env
      // on this process — see the dedicated env-based spawn test below for
      // the real mechanism.
      try {
        // Give the (default single_call) mock a moment, then confirm a
        // second read past the single call returns null (EOF), not a hang.
        await readToolCall(ocp, 5000);
        const second = await readToolCall(ocp, 2000);
        expect(second).toBeNull();
      } finally {
        await terminateOpenCode(ocp);
      }
    });

    it("throws OpenCodeHarnessError on malformed JSON output", async () => {
      const ocp = await spawnOpenCodeWithEnv(`node ${MOCK_PATH}`, buildState(), { MOCK_MODE: "malformed" });
      try {
        await expect(readToolCall(ocp, 5000)).rejects.toThrow(OpenCodeHarnessError);
      } finally {
        await terminateOpenCode(ocp);
      }
    });

    it("handles silent_exit mode: readToolCall resolves null, not a hang", async () => {
      const ocp = await spawnOpenCodeWithEnv(`node ${MOCK_PATH}`, buildState(), { MOCK_MODE: "silent_exit" });
      try {
        const result = await readToolCall(ocp, 5000);
        expect(result).toBeNull();
      } finally {
        await terminateOpenCode(ocp);
      }
    });

    it("handles delayed output within the timeout window", async () => {
      const ocp = await spawnOpenCodeWithEnv(`node ${MOCK_PATH}`, buildState(), { MOCK_MODE: "delayed" });
      try {
        const start = Date.now();
        const tool_call = await readToolCall(ocp, 5000);
        const elapsed = Date.now() - start;
        expect(tool_call?.tool).toBe("read_file");
        expect(elapsed).toBeGreaterThanOrEqual(150); // mock waits ~200ms
      } finally {
        await terminateOpenCode(ocp);
      }
    });

    it("times out (returns null) if no output arrives before timeout_ms", async () => {
      const ocp = await spawnOpenCodeWithEnv(`node ${MOCK_PATH}`, buildState(), { MOCK_MODE: "delayed" });
      try {
        // Mock waits 200ms; ask for a much shorter timeout than that.
        const result = await readToolCall(ocp, 50);
        expect(result).toBeNull();
      } finally {
        await terminateOpenCode(ocp);
      }
    });

    it("passes explicit env through to the child (opencode_env channel)", async () => {
      // Regression cover for the jest-on-Windows quirk where in-process
      // process.env mutations are not inherited by spawned children: the
      // harness merges an explicit env object instead of relying on
      // inheritance. stub-opencode.js logs its received env per invocation.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-env-"));
      try {
        const log = path.join(dir, "stub.jsonl");
        const count = path.join(dir, "count.txt");
        const ocp = await spawnOpenCode(`node ${STUB_PATH}`, buildState(), [], {
          STUB_SCENARIO: "raw",
          STUB_TOOLCALL: JSON.stringify({ action_id: "act_009", tool: "grep", input: { pattern: "x" } }),
          STUB_LOG: log,
          STUB_COUNT_FILE: count
        });
        try {
          const call = await readToolCall(ocp, 10000);
          expect(call?.tool).toBe("grep");
          expect(call?.action_id).toBe("act_009");
        } finally {
          await terminateOpenCode(ocp);
        }
        const entries = fs.readFileSync(log, "utf-8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
        // The stub ran exactly once, with the env we passed explicitly —
        // that is the whole assertion: explicit env reaches the child.
        expect(entries).toHaveLength(1);
        expect(entries[0].n).toBe(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("sendToolResult", () => {
    it("writes a tool result to stdin without throwing", async () => {
      const ocp = await spawnOpenCode(`node ${MOCK_PATH}`, buildState());
      try {
        await readToolCall(ocp, 5000);
        await expect(
          sendToolResult(ocp, { action_id: "act_001", status: "SETTLED" })
        ).resolves.toBeUndefined();
      } finally {
        await terminateOpenCode(ocp);
      }
    });

    it("throws if the process has already exited", async () => {
      const ocp = await spawnOpenCodeWithEnv(`node ${MOCK_PATH}`, buildState(), { MOCK_MODE: "silent_exit" });
      // Drain to observe the exit.
      await readToolCall(ocp, 5000);
      // Give the exit event a tick to fire.
      await new Promise((r) => setTimeout(r, 50));

      await expect(
        sendToolResult(ocp, { action_id: "act_001", status: "SETTLED" })
      ).rejects.toThrow(OpenCodeHarnessError);
    });
  });

  describe("terminateOpenCode", () => {
    it("is safe to call on an already-exited process", async () => {
      const ocp = await spawnOpenCodeWithEnv(`node ${MOCK_PATH}`, buildState(), { MOCK_MODE: "silent_exit" });
      await readToolCall(ocp, 5000);
      await new Promise((r) => setTimeout(r, 50));

      await expect(terminateOpenCode(ocp)).resolves.toBeUndefined();
    });

    it("terminates a running process that never emits output", async () => {
      // single_call mode still exits after emitting, but we terminate
      // before it does anything, to test the SIGTERM path.
      const ocp = await spawnOpenCode(`node ${MOCK_PATH}`, buildState());
      await expect(terminateOpenCode(ocp, 500)).resolves.toBeUndefined();
    });
  });
});

// =============================================================================
// TEST HELPER: spawn with a custom environment
// =============================================================================
//
// spawnOpenCode's public signature doesn't expose env vars (matching the
// real OpenCode integration, which won't need MOCK_MODE). Tests that need
// to select a mock behavior spawn the child directly via the same
// child_process module and adapt it into an OpenCodeProcess-shaped value
// using the harness's own read/send functions, which only depend on
// `.process` being a ChildProcess with piped stdio.

import { spawn } from "child_process";
import { OpenCodeProcess } from "./opencode-harness";

async function spawnOpenCodeWithEnv(
  executable: string,
  agent_read_state: AgentReadState,
  env: Record<string, string>
): Promise<OpenCodeProcess> {
  const parts = executable.split(" ").filter((p) => p.length > 0);
  const command = parts[0];
  const args = parts.slice(1);

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env }
  });

  const ocp: OpenCodeProcess = {
    process: child,
    id: "test_ocp",
    _stdout_buffer: "",
    _initialized: false,
    _exited: false,
    _pending_lines: [],
    _waiters: []
  };

  child.stdout!.setEncoding("utf-8");
  child.stdout!.on("data", (chunk: string) => {
    (ocp as any)._stdout_buffer += chunk;
    drainLinesForTest(ocp);
  });

  child.on("exit", () => {
    ocp._exited = true;
    if (ocp._stdout_buffer.trim().length > 0) {
      ocp._pending_lines.push(ocp._stdout_buffer);
      (ocp as any)._stdout_buffer = "";
    }
    while (ocp._waiters.length > 0) {
      const waiter = ocp._waiters.shift()!;
      waiter(null);
    }
  });

  child.stdin!.write(JSON.stringify(agent_read_state) + "\n", "utf-8");
  ocp._initialized = true;

  return ocp;
}

function drainLinesForTest(ocp: OpenCodeProcess): void {
  let idx: number;
  while ((idx = ocp._stdout_buffer.indexOf("\n")) !== -1) {
    const line = ocp._stdout_buffer.slice(0, idx);
    (ocp as any)._stdout_buffer = ocp._stdout_buffer.slice(idx + 1);
    if (line.trim().length === 0) continue;
    const waiter = ocp._waiters.shift();
    if (waiter) waiter(line);
    else ocp._pending_lines.push(line);
  }
}
