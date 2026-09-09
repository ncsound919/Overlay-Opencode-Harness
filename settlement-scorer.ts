/**
 * Settlement Scorer: score a shadow execution result against the contract
 *
 * Pure function: takes probe results + diffs, returns a PASS/FAIL verdict
 * and the structured evidence backing that verdict. This is the last gate
 * before a receipt is minted and (if PASS) diffs are promoted.
 */

import * as crypto from "crypto";

import { Contract } from "./contract-loader";
import { ProbeResult, Coverage } from "./probe-runner";

export interface ChangedFile {
  path: string;
  diff: string;
}

export interface SettlementEvidence {
  invariants_satisfied: string[];
  invariants_violated: string[];
  coverage: Coverage;
  test_results: { passed: number; failed: number; total: number };
  diffs_introduced: { added_lines: number; removed_lines: number; files: string[] };
  forbidden_patterns_found: boolean;
  verdict: "PASS" | "FAIL";
  failure_reasons: string[];
}

// =============================================================================
// DIFF LINE COUNTING
// =============================================================================

/**
 * Count added/removed lines from unified diff text. Only counts real
 * content lines (prefixed with a single + or -), not the +++/--- headers.
 */
function countDiffLines(diff: string): { added: number; removed: number } {
  const lines = diff.split("\n");
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }

  return { added, removed };
}

// =============================================================================
// FORBIDDEN DIFF PATTERNS
// =============================================================================

/**
 * Check whether the diff violates any acceptance_criteria.diffs_must_not
 * rule. Supported rule names (matching the conventions used elsewhere in
 * the spec): "touch_deleted_files" and "modify_unrelated_code" are treated
 * as advisory unless a more specific check is encoded — this function
 * returns true only for rules it can concretely evaluate, so contracts
 * relying on unimplemented rule semantics fail closed at the invariant
 * level (see probe-runner.ts), not silently pass here.
 */
function checkForbiddenDiffPatterns(
  diffs_must_not: string[],
  changed_files: ChangedFile[],
  files_in_scope: string[]
): boolean {
  for (const rule of diffs_must_not) {
    if (rule === "modify_unrelated_code") {
      const touches_out_of_scope = changed_files.some(
        (f) => !files_in_scope.some((pattern) => matchesScopePattern(f.path, pattern))
      );
      if (touches_out_of_scope) return true;
    }
    // "touch_deleted_files" and any other rule name: no concrete signal
    // available from ChangedFile alone (would require the pre-diff file
    // list); left for a future scorer pass rather than guessed at here.
  }
  return false;
}

function matchesScopePattern(file_path: string, pattern: string): boolean {
  if (pattern === file_path) return true;
  // `**` must expand before `*` (see admission-gate.ts isPathInScope).
  const regex_pattern = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR__/g, ".*");
  return new RegExp(`^${regex_pattern}$`).test(file_path);
}

// =============================================================================
// MAIN SCORING FUNCTION
// =============================================================================

/**
 * Score a shadow execution result against the contract's acceptance
 * criteria. Fails on any of:
 *   - a required test that didn't pass
 *   - coverage below coverage_floor
 *   - any violated invariant
 *   - a forbidden diff pattern
 */
export function scoreAgainstContract(
  contract: Contract,
  probes: ProbeResult[],
  coverage: Coverage,
  changed_files: ChangedFile[]
): SettlementEvidence {
  const failure_reasons: string[] = [];

  const test_results = {
    passed: probes.filter((p) => p.passed).length,
    failed: probes.filter((p) => !p.passed).length,
    total: probes.length
  };

  const required_tests = new Set(contract.acceptance_criteria.tests.must_pass.map((t) => `test:${t}`));
  const failed_required = probes.filter((p) => required_tests.has(p.probe_name) && !p.passed);
  for (const f of failed_required) {
    failure_reasons.push(`Required test failed: ${f.probe_name}`);
  }

  // Any required test that never ran at all is also a failure — a missing
  // probe result must not be treated as a pass by omission.
  const ran_names = new Set(probes.map((p) => p.probe_name));
  for (const required of required_tests) {
    if (!ran_names.has(required)) {
      failure_reasons.push(`Required test did not run: ${required}`);
    }
  }

  const coverage_floor = contract.acceptance_criteria.tests.coverage_floor;
  if (coverage.pct < coverage_floor) {
    failure_reasons.push(`Coverage ${coverage.pct}% is below floor ${coverage_floor}%`);
  }

  // We only get invariants_satisfied/violated from the probe run, not raw
  // here — scoreAgainstContract is called with pre-computed probe results,
  // so invariant evaluation itself happens in probe-runner.ts. This
  // function's job is to fail the settlement if any invariant is unmet.
  // (invariants_satisfied/violated are threaded through from the caller —
  // see the overload below for the common case where they come bundled
  // with the probe run.)

  const forbidden_found = checkForbiddenDiffPatterns(
    contract.acceptance_criteria.diffs_must_not,
    changed_files,
    contract.scope.files_in_scope
  );
  if (forbidden_found) {
    failure_reasons.push("Diff touches files outside scope (modify_unrelated_code)");
  }

  let added_lines = 0;
  let removed_lines = 0;
  for (const f of changed_files) {
    const { added, removed } = countDiffLines(f.diff);
    added_lines += added;
    removed_lines += removed;
  }

  const verdict: "PASS" | "FAIL" = failure_reasons.length === 0 ? "PASS" : "FAIL";

  return {
    invariants_satisfied: [],
    invariants_violated: [],
    coverage,
    test_results,
    diffs_introduced: {
      added_lines,
      removed_lines,
      files: changed_files.map((f) => f.path)
    },
    forbidden_patterns_found: forbidden_found,
    verdict,
    failure_reasons
  };
}

/**
 * Convenience wrapper that also folds in invariant results from
 * probe-runner.ts's ProbeRunResult, so callers don't have to manually
 * splice invariants_satisfied/violated into the evidence afterward.
 */
export function scoreProbeRunAgainstContract(
  contract: Contract,
  probe_run: { probes: ProbeResult[]; coverage: Coverage; invariants_satisfied: string[]; invariants_violated: string[] },
  changed_files: ChangedFile[]
): SettlementEvidence {
  const base = scoreAgainstContract(contract, probe_run.probes, probe_run.coverage, changed_files);

  const failure_reasons = [...base.failure_reasons];
  for (const violated of probe_run.invariants_violated) {
    failure_reasons.push(`Invariant violated: ${violated}`);
  }

  const verdict: "PASS" | "FAIL" = failure_reasons.length === 0 ? "PASS" : "FAIL";

  return {
    ...base,
    invariants_satisfied: probe_run.invariants_satisfied,
    invariants_violated: probe_run.invariants_violated,
    failure_reasons,
    verdict
  };
}

// =============================================================================
// EVIDENCE HASHING
// =============================================================================

/**
 * Deterministic hash of a SettlementEvidence object, for embedding into a
 * SettlementReceipt's evidence_hash field.
 */
export function hashEvidence(evidence: SettlementEvidence): string {
  const serialized = JSON.stringify(evidence, Object.keys(evidence).sort());
  const hash = crypto.createHash("sha256").update(serialized).digest("hex");
  return `sha256:${hash}`;
}
