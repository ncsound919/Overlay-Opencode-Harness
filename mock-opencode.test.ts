/**
 * Tests for the mock + real-binary wiring story.
 *
 * - mock-opencode.js must emit the deterministic per-phase sequences (the
 *   Windows-capable equivalent of mock-opencode.sh).
 * - The real `opencode` binary must at least respond to --version (proves
 *   "installed"); the test asserts nothing about the agent protocol, which
 *   needs an adapter (see check-opencode.js).
 */

import { spawn, execFile } from "child_process";
import * as path from "path";

const PHASED_MOCK = path.join(__dirname, "mock-opencode.js");

function runPhasedMock(agent_state: Record<string, unknown>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [PHASED_MOCK], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (c: string) => {
      out += c;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (c: string) => {
      err += c;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`mock exited ${code}: ${err}`));
        return;
      }
      resolve(out.split("\n").filter((l) => l.trim().length > 0));
    });
    child.stdin.write(JSON.stringify(agent_state) + "\n", "utf-8");
    child.stdin.end();
  });
}

function baseState(phase: string, extra: Record<string, unknown> = {}) {
  return { current_phase: { name: phase }, last_rejection: null, ...extra };
}

describe("mock-opencode.js (phased, cross-platform)", () => {
  it("diagnostic phase emits read_file + grep + write_file", async () => {
    const lines = await runPhasedMock(baseState("diagnostic"));
    expect(lines).toHaveLength(3);
    const calls = lines.map((l) => JSON.parse(l));
    expect(calls.map((c) => c.tool)).toEqual(["read_file", "grep", "write_file"]);
    expect(calls[2].claim).toBe("codebase_structure_doc");
    expect(calls[0].action_id).toBe("act_001");
  });

  it("edit phase emits the naive first attempt without a rejection", async () => {
    const lines = await runPhasedMock(baseState("edit"));
    expect(lines).toHaveLength(2);
    const calls = lines.map((l) => JSON.parse(l));
    expect(calls[0].tool).toBe("write_file");
    expect(calls[0].input.content).not.toContain("setTimeout");
  });

  it("edit phase retries with timeout guards after a rejection", async () => {
    const lines = await runPhasedMock(baseState("edit", { last_rejection: { reason: "coverage" } }));
    const calls = lines.map((l) => JSON.parse(l));
    expect(calls[0].input.content).toContain("setTimeout");
    expect(calls[1].tool).toBe("run_test");
  });

  it("verify phase emits run_test x2 + read_file", async () => {
    const lines = await runPhasedMock(baseState("verify"));
    const calls = lines.map((l) => JSON.parse(l));
    expect(calls.map((c) => c.tool)).toEqual(["run_test", "run_test", "read_file"]);
  });

  it("complete phase emits nothing and exits 0", async () => {
    await expect(runPhasedMock(baseState("complete"))).resolves.toEqual([]);
  });
});

describe("real opencode binary", () => {
  it("responds to --version (binary installed)", async () => {
    const bin = process.platform === "win32" ? "opencode.cmd" : "opencode";
    const version: string = await new Promise((resolve, reject) => {
      const done = (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          reject(new Error(`opencode binary not runnable: ${err.message}`));
          return;
        }
        resolve(String(stdout || stderr).trim());
      };
      // NOTE: npm .cmd shims need a shell on Windows (else EINVAL); a
      // single command string + shell avoids the DEP0190 args-array warning.
      if (process.platform === "win32") {
        execFile("opencode.cmd --version", { timeout: 30000, shell: true }, done);
      } else {
        execFile(bin, ["--version"], { timeout: 30000 }, done);
      }
    });
    expect(version).toMatch(/\d+\.\d+/);
  });
});
