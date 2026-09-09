/**
 * Tests for trust-store.ts — graduated autonomy licensing.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  loadTrust,
  saveTrust,
  recordApproval,
  recordRejection,
  recordDenial,
  fingerprintRepo,
  PROMOTE_TO_SUPERVISED_AFTER,
  PROMOTE_TO_AUTONOMOUS_AFTER
} from "./trust-store";
import { AutonomyClass } from "./admission-gate";
import { settlementHarnessLoop } from "./settlement-supervisor";
import { initializeTestGitRepo } from "./worktree-manager";
import { createTestContract } from "./contract-fixture";

const FP = "sha256:test";

function incident(n: number) {
  return { action_id: `act_${String(n).padStart(3, "0")}`, reason: "probe failed" };
}

describe("trust-store policy", () => {
  it("starts fresh repos at the fallback class with no streak", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-"));
    try {
      const t = loadTrust(path.join(dir, "trust.json"), FP, AutonomyClass.LEARNER);
      expect(t.autonomy_class).toBe(AutonomyClass.LEARNER);
      expect(t.consecutive_settled).toBe(0);
      expect(t.incidents).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("promotes LEARNER -> SUPERVISED after consecutive approvals", () => {
    let t = loadTrust("/nonexistent/trust.json", FP, AutonomyClass.LEARNER);
    for (let i = 0; i < PROMOTE_TO_SUPERVISED_AFTER; i++) t = recordApproval(t);
    expect(t.autonomy_class).toBe(AutonomyClass.SUPERVISED);
    expect(t.consecutive_settled).toBe(PROMOTE_TO_SUPERVISED_AFTER);
  });

  it("promotes to AUTONOMOUS only after a longer clean run", () => {
    let t = loadTrust("/nonexistent/trust.json", FP, AutonomyClass.LEARNER);
    for (let i = 0; i < PROMOTE_TO_AUTONOMOUS_AFTER; i++) t = recordApproval(t);
    expect(t.autonomy_class).toBe(AutonomyClass.AUTONOMOUS);
  });

  it("rejection resets the streak and demotes one class", () => {
    let t = loadTrust("/nonexistent/trust.json", FP, AutonomyClass.LEARNER);
    for (let i = 0; i < PROMOTE_TO_AUTONOMOUS_AFTER; i++) t = recordApproval(t);
    expect(t.autonomy_class).toBe(AutonomyClass.AUTONOMOUS);
    t = recordRejection(t, incident(9));
    expect(t.autonomy_class).toBe(AutonomyClass.SUPERVISED);
    expect(t.consecutive_settled).toBe(0);
    expect(t.incidents).toHaveLength(1);
    expect(t.incidents[0].kind).toBe("rejected");
    t = recordRejection(t, incident(10));
    expect(t.autonomy_class).toBe(AutonomyClass.LEARNER);
  });

  it("denial resets the streak but does not demote (the gate worked)", () => {
    let t = loadTrust("/nonexistent/trust.json", FP, AutonomyClass.LEARNER);
    for (let i = 0; i < PROMOTE_TO_SUPERVISED_AFTER; i++) t = recordApproval(t);
    t = recordDenial(t, incident(4));
    expect(t.autonomy_class).toBe(AutonomyClass.SUPERVISED);
    expect(t.consecutive_settled).toBe(0);
    expect(t.incidents[0].kind).toBe("denied");
  });

  it("never demotes below LEARNER", () => {
    let t = loadTrust("/nonexistent/trust.json", FP, AutonomyClass.LEARNER);
    t = recordRejection(t, incident(1));
    expect(t.autonomy_class).toBe(AutonomyClass.LEARNER);
  });

  it("persists and resumes across sessions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-"));
    try {
      const p = path.join(dir, "trust.json");
      let t = loadTrust(p, FP, AutonomyClass.LEARNER);
      for (let i = 0; i < PROMOTE_TO_SUPERVISED_AFTER; i++) t = recordApproval(t);
      saveTrust(p, t);
      const resumed = loadTrust(p, FP, AutonomyClass.LEARNER);
      expect(resumed.autonomy_class).toBe(AutonomyClass.SUPERVISED);
      expect(resumed.consecutive_settled).toBe(PROMOTE_TO_SUPERVISED_AFTER);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on fingerprint mismatch or corrupt files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-"));
    try {
      const p = path.join(dir, "trust.json");
      saveTrust(p, { ...loadTrust(p, "sha256:other", AutonomyClass.AUTONOMOUS), consecutive_settled: 99 });
      const resumed = loadTrust(p, FP, AutonomyClass.LEARNER);
      expect(resumed.autonomy_class).toBe(AutonomyClass.LEARNER);
      expect(resumed.consecutive_settled).toBe(0);
      fs.writeFileSync(p, "{corrupt", "utf-8");
      expect(loadTrust(p, FP, AutonomyClass.SUPERVISED).autonomy_class).toBe(AutonomyClass.SUPERVISED);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fingerprints are stable per repo and differ across repos", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "fp-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "fp-b-"));
    try {
      expect(fingerprintRepo(a)).toBe(fingerprintRepo(a));
      expect(fingerprintRepo(a)).not.toBe(fingerprintRepo(b));
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe("trust persistence through the harness loop", () => {
  it("writes trust.json with the session's incidents", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "trust-e2e-"));
    const repo_path = path.join(parent, "repo");
    try {
      await initializeTestGitRepo(repo_path);
      // single_call mock emits one read_file; with no test runner the
      // required probe fails -> REJECTED -> incident recorded.
      const contract = createTestContract({
        phases: [
          {
            name: "diagnostic",
            description: "read-only",
            permitted_tools: ["read_file", "grep", "list_files"],
            claim_types_admitted: ["analysis"],
            exit_criteria: { required_evidence: ["analysis"] }
          }
        ]
      });
      const contract_path = path.join(repo_path, "contract.json");
      fs.writeFileSync(contract_path, JSON.stringify(contract, null, 2), "utf-8");

      const mock_path = path.join(__dirname, "node-mock-opencode.js");
      const result = await settlementHarnessLoop(contract_path, repo_path, `node ${mock_path}`, {
        tool_call_timeout_ms: 1500,
        max_actions: 2
      });

      expect(result.final_autonomy_class).toBe(AutonomyClass.LEARNER);
      const trust_path = path.join(repo_path, ".settlement", "trust.json");
      expect(fs.existsSync(trust_path)).toBe(true);
      const trust = JSON.parse(fs.readFileSync(trust_path, "utf-8"));
      expect(trust.repo_fingerprint).toMatch(/^sha256:/);
      expect(trust.incidents.length).toBeGreaterThan(0);
      expect(trust.incidents[0].kind).toBe("rejected");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
