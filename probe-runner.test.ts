/**
 * Tests for probe-runner.ts — the fact layer underneath settlement scoring.
 *
 * Includes the regression test for the Windows EINVAL bug: bare npm.cmd
 * cannot spawn shell-free, so every probe failed and fail-closed scoring
 * masked it. A passing runner must produce a passing probe.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

import { runContractProbes } from "./probe-runner";
import { createTestContract } from "./contract-fixture";

const PASS_RUNNER = `const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
describe("s", () => { it("basic", () => { assert.ok(true); }); });
`;

async function makeRepo(runnerJs: string): Promise<{ parent: string; repo: string }> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "probe-test-"));
  const repo = path.join(parent, "repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "node ./run-tests.js" } }), "utf-8");
  fs.writeFileSync(path.join(repo, "run-tests.js"), runnerJs, "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  return { parent, repo };
}

describe("probe-runner", () => {
  it("a passing runner produces a passing probe (no EINVAL)", async () => {
    const { parent, repo } = await makeRepo(PASS_RUNNER);
    try {
      const contract = createTestContract();
      const result = await runContractProbes(contract, repo, []);
      const basic = result.probes.find((p) => p.probe_name === "test:basic");
      expect(basic).toBeDefined();
      expect(basic!.passed).toBe(true);
      expect(result.invariants_violated).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }, 120000);

  it("a failing runner produces a failing probe", async () => {
    const { parent, repo } = await makeRepo("process.exit(1);\n");
    try {
      const contract = createTestContract();
      const result = await runContractProbes(contract, repo, []);
      expect(result.probes.find((p) => p.probe_name === "test:basic")!.passed).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }, 120000);

  it("regex invariants check changed-file content", async () => {
    const { parent, repo } = await makeRepo(PASS_RUNNER);
    try {
      fs.writeFileSync(path.join(repo, "run-tests.js"), PASS_RUNNER + "\n// async marker\n", "utf-8");
      const base = createTestContract();
      const contract = createTestContract({
        acceptance_criteria: {
          ...base.acceptance_criteria,
          invariants: [{ name: "has_marker", check: "regex:async marker" }]
        }
      });
      const result = await runContractProbes(contract, repo, ["run-tests.js"]);
      expect(result.invariants_satisfied).toContain("has_marker");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }, 120000);
});
