/**
 * live-approval.test.ts — OPT-IN live ladder climb (spends API credits).
 *
 * Runs ONLY when LIVE_SMOKE=1. Unlike live-smoke (bare repo, everything
 * REJECTED by design), this repo ships a REAL passing test runner
 * (node:test, zero dependencies), so the required probe genuinely passes
 * and receipts settle APPROVED.
 *
 * Contract: three consecutive read-only phases, each exiting on fresh
 * "analysis" evidence. Every approved read advances exactly one phase, so
 * three approvals complete the session AND push the trust streak to 3 —
 * promoting the repo license LEARNER -> SUPERVISED mid-session. That is
 * the full settlement story, live: admit -> shadow -> approve -> promote
 * evidence -> phase transition -> license ratchet.
 *
 * Uses the settlement-proposer agent when SETTLEMENT_AGENT is set
 * (run-live-phoenix.js sets it).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { settlementHarnessLoop } from "./settlement-supervisor";
import { readReceipts } from "./settlement-ledger";
import { initializeTestGitRepo } from "./worktree-manager";
import { AutonomyClass } from "./admission-gate";

const LIVE = process.env.LIVE_SMOKE === "1";
const ADAPTER_PATH = path.join(__dirname, "opencode-adapter.js");

const RUNNER_JS = `// Dependency-free test runner: real assertions via node:test.
// Invoked by probe-runner as \`npm test -- <suite> -t <name>\`; extra argv
// is ignored and the exit code carries the verdict (0 = all pass).
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

describe("payment module", () => {
  it("basic: source file exists and is non-empty", () => {
    const p = path.join(__dirname, "src", "payment.ts");
    assert.ok(fs.existsSync(p), "src/payment.ts must exist");
    const content = fs.readFileSync(p, "utf-8");
    assert.ok(content.length > 0, "src/payment.ts must be non-empty");
  });

  it("basic: suite sanely reports its own path filter", () => {
    assert.ok(Array.isArray(process.argv), "argv must exist");
  });
});
`;

function readPhase(name: string, prev?: string) {
  return {
    name,
    description: `read-only survey (${name})`,
    permitted_tools: ["read_file", "grep", "list_files"],
    claim_types_admitted: ["analysis"],
    ...(prev ? { requires_prior_phase: prev } : {}),
    exit_criteria: { required_evidence: ["analysis"] }
  };
}

(LIVE ? describe : describe.skip)("live approval ladder (spends API credits)", () => {
  it(
    "approvals advance phases and ratchet the license to SUPERVISED",
    async () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "live-approval-"));
      try {
        const repo_path = path.join(parent, "repo");
        await initializeTestGitRepo(repo_path);
        fs.writeFileSync(path.join(repo_path, "package.json"), JSON.stringify({ scripts: { test: "node ./run-tests.js" } }, null, 2), "utf-8");
        fs.writeFileSync(path.join(repo_path, "run-tests.js"), RUNNER_JS, "utf-8");
        // Commit the runner: shadow worktrees check out HEAD, so untracked
        // setup files would be invisible to probes (npm test would fail
        // with "missing script", failing every settlement).
        const { execFileSync } = require("child_process");
        execFileSync("git", ["add", "-A"], { cwd: repo_path });
        execFileSync("git", ["commit", "-m", "test runner"], { cwd: repo_path });

        const { createTestContract } = require("./contract-fixture");
        const contract = createTestContract({
          phases: [readPhase("survey"), readPhase("survey2", "survey"), readPhase("confirm", "survey2")]
        });
        const contract_path = path.join(repo_path, "contract.json");
        fs.writeFileSync(contract_path, JSON.stringify(contract, null, 2), "utf-8");

        const agent = process.env.SETTLEMENT_AGENT ? ` --agent ${process.env.SETTLEMENT_AGENT}` : "";
        const { phoenixProviderFromEnv } = require("./live-provider");
        const phoenix = phoenixProviderFromEnv();
        console.log(`PROVIDER: ${phoenix.model ?? "(opencode default)"}`);
        const result = await settlementHarnessLoop(
          contract_path,
          repo_path,
          `node ${ADAPTER_PATH} --repo ${repo_path} --max-retries 1 --timeout-ms 240000${agent}` +
            (phoenix.model ? ` --model ${phoenix.model}` : ""),
          { tool_call_timeout_ms: 300000, max_actions: 6, opencode_env: phoenix.env }
        );

        console.log("HARNESS_RESULT:" + JSON.stringify(result));
        const receipts = readReceipts(path.join(repo_path, ".settlement", "receipts", "receipts.jsonl"));
        console.log("RECEIPTS:" + JSON.stringify(receipts.map((r) => ({ id: r.action_id, tool: r.tool_name, settlement: r.settlement, evidence: r.evidence_types }))));

        // Three read-only approvals complete all three phases.
        expect(result.final_phase).toBe("complete");
        expect(result.approved).toBeGreaterThanOrEqual(3);
        // Read-only actions never promote files, even when approved.
        expect(receipts.every((r) => r.files_promoted.length === 0)).toBe(true);

        // The license ratcheted on the clean streak.
        expect(result.final_autonomy_class).toBe(AutonomyClass.SUPERVISED);
        const trust = JSON.parse(fs.readFileSync(path.join(repo_path, ".settlement", "trust.json"), "utf-8"));
        console.log("TRUST:" + JSON.stringify({ class: trust.autonomy_class, streak: trust.consecutive_settled, incidents: trust.incidents.length }));
        expect(trust.autonomy_class).toBe(AutonomyClass.SUPERVISED);
        expect(trust.consecutive_settled).toBeGreaterThanOrEqual(3);
        expect(trust.incidents).toHaveLength(0);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
    540000
  );
});
