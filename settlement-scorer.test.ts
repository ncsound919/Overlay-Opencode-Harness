/**
 * Tests for settlement-scorer.ts — PASS/FAIL semantics + evidence hashing.
 */

import { scoreAgainstContract, scoreProbeRunAgainstContract, hashEvidence } from "./settlement-scorer";
import { createTestContract } from "./contract-fixture";
import { ProbeResult, Coverage } from "./probe-runner";

function probe(name: string, passed: boolean): ProbeResult {
  return { probe_name: name, passed, stdout: "", stderr: "", duration_ms: 1 };
}

const FULL_COVERAGE: Coverage = { total: 100, covered: 100, pct: 100 };

describe("settlement-scorer", () => {
  it("passes when required tests pass and coverage floor is met", () => {
    const contract = createTestContract();
    const ev = scoreAgainstContract(contract, [probe("test:basic", true)], FULL_COVERAGE, []);
    expect(ev.verdict).toBe("PASS");
    expect(ev.failure_reasons).toHaveLength(0);
  });

  it("fails when a required test fails", () => {
    const contract = createTestContract();
    const ev = scoreAgainstContract(contract, [probe("test:basic", false)], FULL_COVERAGE, []);
    expect(ev.verdict).toBe("FAIL");
    expect(ev.failure_reasons.join(" ")).toContain("test:basic");
  });

  it("fails when a required test never ran (no pass by omission)", () => {
    const contract = createTestContract();
    const ev = scoreAgainstContract(contract, [], FULL_COVERAGE, []);
    expect(ev.verdict).toBe("FAIL");
    expect(ev.failure_reasons.join(" ")).toContain("did not run");
  });

  it("fails when coverage is below the floor", () => {
    const base = createTestContract();
    const contract = createTestContract({
      acceptance_criteria: {
        ...base.acceptance_criteria,
        tests: { ...base.acceptance_criteria.tests, coverage_floor: 85 }
      }
    });
    const ev = scoreAgainstContract(
      contract,
      [probe("test:basic", true)],
      { total: 100, covered: 80, pct: 80 },
      []
    );
    expect(ev.verdict).toBe("FAIL");
    expect(ev.failure_reasons.join(" ")).toContain("Coverage");
  });

  it("fails on modify_unrelated_code diffs", () => {
    const contract = createTestContract();
    const ev = scoreAgainstContract(
      createTestContract({
        scope: contract.scope,
        acceptance_criteria: { ...contract.acceptance_criteria, diffs_must_not: ["modify_unrelated_code"] }
      }),
      [probe("test:basic", true)],
      FULL_COVERAGE,
      [{ path: "src/outside-scope.ts", diff: "+x\n" }]
    );
    expect(ev.verdict).toBe("FAIL");
    expect(ev.forbidden_patterns_found).toBe(true);
  });

  it("folds invariant violations into the verdict", () => {
    const contract = createTestContract();
    const ev = scoreProbeRunAgainstContract(
      contract,
      { probes: [probe("test:basic", true)], coverage: FULL_COVERAGE, invariants_satisfied: [], invariants_violated: ["no_global_mutation"] },
      []
    );
    expect(ev.verdict).toBe("FAIL");
    expect(ev.invariants_violated).toContain("no_global_mutation");
  });

  it("counts added/removed diff lines excluding headers", () => {
    const contract = createTestContract();
    const ev = scoreAgainstContract(
      contract,
      [probe("test:basic", true)],
      FULL_COVERAGE,
      [{ path: "src/payment.ts", diff: "--- a\n+++ b\n+new\n-old\n context\n" }]
    );
    expect(ev.diffs_introduced.added_lines).toBe(1);
    expect(ev.diffs_introduced.removed_lines).toBe(1);
  });

  it("hashEvidence is deterministic and sha256-prefixed", () => {
    const contract = createTestContract();
    const ev = scoreAgainstContract(contract, [probe("test:basic", true)], FULL_COVERAGE, []);
    expect(hashEvidence(ev)).toBe(hashEvidence(ev));
    expect(hashEvidence(ev).startsWith("sha256:")).toBe(true);
  });
});
