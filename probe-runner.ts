/**
 * Probe Runner: run contract acceptance probes against a shadow worktree
 *
 * A "probe" is any check the contract's acceptance_criteria demands: a
 * named test, an invariant regex/rule, or a coverage measurement. This
 * module runs them all and returns structured results — it does not decide
 * PASS/FAIL itself (that's settlement-scorer.ts); it only reports facts.
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

import { Contract } from "./contract-loader";
import { npmParts, npxParts } from "./node-shim";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  probe_name: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export interface Coverage {
  total: number;
  covered: number;
  pct: number;
}

export interface ProbeRunResult {
  probes: ProbeResult[];
  coverage: Coverage;
  invariants_satisfied: string[];
  invariants_violated: string[];
}

// =============================================================================
// TEST PROBES
// =============================================================================

/**
 * Run each named test in acceptance_criteria.tests.must_pass against the
 * worktree. Uses `npm test -- <suite> -t <name>` convention (jest-style
 * `-t` name filter); if the test runner doesn't recognize a name filter it
 * will simply run the whole suite and the individual probe result will
 * reflect the suite's overall exit code.
 */
async function runTestProbes(contract: Contract, worktree_path: string): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const suite_path = contract.acceptance_criteria.tests.path;

  for (const test_name of contract.acceptance_criteria.tests.must_pass) {
    const started = Date.now();
    try {
      // npm via node+launcher (node-shim): bare npm.cmd cannot spawn
      // without a shell on Windows (EINVAL) — which previously failed
      // EVERY probe here, masked by fail-closed scoring.
      const npm = npmParts();
      const { stdout, stderr } = await execFileAsync(
        npm.command,
        [...npm.prefixArgs, "test", "--", suite_path, "-t", test_name],
        { cwd: worktree_path, timeout: 120000 }
      );
      results.push({
        probe_name: `test:${test_name}`,
        passed: true,
        stdout,
        stderr,
        duration_ms: Date.now() - started
      });
    } catch (e: any) {
      results.push({
        probe_name: `test:${test_name}`,
        passed: false,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(e),
        duration_ms: Date.now() - started
      });
    }
  }

  return results;
}

// =============================================================================
// COVERAGE
// =============================================================================

/**
 * Run the suite with coverage enabled and parse a coverage summary.
 * Expects a jest-style `coverage-summary.json` under
 * `<worktree>/coverage/coverage-summary.json` after the run — callers using
 * a different test runner should adapt this or pre-seed that file.
 *
 * On any failure to run or parse coverage, returns a zeroed Coverage object
 * rather than throwing, so a missing coverage setup degrades to "0% until
 * configured" instead of crashing the whole probe run.
 */
async function runCoverage(contract: Contract, worktree_path: string): Promise<Coverage> {
  const suite_path = contract.acceptance_criteria.tests.path;

  try {
    const npm = npmParts();
    await execFileAsync(npm.command, [...npm.prefixArgs, "test", "--", suite_path, "--coverage"], { cwd: worktree_path, timeout: 180000 });
  } catch {
    // Test failures still produce a coverage report in most runners; keep going
    // and try to read whatever summary was written.
  }

  const summary_path = path.join(worktree_path, "coverage", "coverage-summary.json");
  if (!fs.existsSync(summary_path)) {
    return { total: 0, covered: 0, pct: 0 };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(summary_path, "utf-8"));
    const total_summary = raw.total?.lines;
    if (!total_summary) {
      return { total: 0, covered: 0, pct: 0 };
    }
    return {
      total: total_summary.total,
      covered: total_summary.covered,
      pct: total_summary.pct
    };
  } catch {
    return { total: 0, covered: 0, pct: 0 };
  }
}

// =============================================================================
// INVARIANTS
// =============================================================================

/**
 * Check each acceptance_criteria.invariants entry against the changed
 * files. Supports two check syntaxes (matching the "regex:" and
 * "eslint-rule:" conventions used in opencode-settlement-integration.md):
 *   - "regex:<pattern>"     — the pattern must match somewhere in at least
 *                              one changed file's content
 *   - "eslint-rule:<name>"  — runs eslint scoped to that single rule; a
 *                              rule name we can't map to a real eslint
 *                              invocation is treated as unsatisfied rather
 *                              than silently skipped, since a silently
 *                              skipped invariant is indistinguishable from
 *                              a satisfied one to the settlement scorer.
 */
async function checkInvariants(
  contract: Contract,
  worktree_path: string,
  changed_files: string[]
): Promise<{ satisfied: string[]; violated: string[] }> {
  const satisfied: string[] = [];
  const violated: string[] = [];

  for (const invariant of contract.acceptance_criteria.invariants) {
    const [check_kind, check_value] = splitCheck(invariant.check);

    if (check_kind === "regex") {
      const matched = changed_files.some((rel_path) => {
        const abs_path = path.join(worktree_path, rel_path);
        if (!fs.existsSync(abs_path)) return false;
        try {
          const content = fs.readFileSync(abs_path, "utf-8");
          return new RegExp(check_value).test(content);
        } catch {
          return false;
        }
      });

      if (matched) {
        satisfied.push(invariant.name);
      } else {
        violated.push(invariant.name);
      }
      continue;
    }

    if (check_kind === "eslint-rule") {
      if (changed_files.length === 0) {
        violated.push(invariant.name);
        continue;
      }
      try {
        const npx = npxParts();
        await execFileAsync(
          npx.command,
          [...npx.prefixArgs, "--no-install", "eslint", "--no-eslintrc", "--rule", `{"${check_value}":"error"}`, ...changed_files],
          { cwd: worktree_path, timeout: 60000 }
        );
        satisfied.push(invariant.name);
      } catch {
        violated.push(invariant.name);
      }
      continue;
    }

    // Unknown check syntax: fail closed. An invariant we can't evaluate must
    // not be silently treated as satisfied.
    violated.push(invariant.name);
  }

  return { satisfied, violated };
}

function splitCheck(check: string): [string, string] {
  const idx = check.indexOf(":");
  if (idx === -1) return [check, ""];
  return [check.slice(0, idx), check.slice(idx + 1)];
}

// =============================================================================
// MAIN ENTRY POINT
// =============================================================================

/**
 * Run all contract probes (tests, coverage, invariants) against a worktree
 * and return the structured results. This is the single call site
 * settlement-scorer.ts depends on.
 */
export async function runContractProbes(
  contract: Contract,
  worktree_path: string,
  changed_files: string[]
): Promise<ProbeRunResult> {
  const [probes, coverage, invariant_results] = await Promise.all([
    runTestProbes(contract, worktree_path),
    runCoverage(contract, worktree_path),
    checkInvariants(contract, worktree_path, changed_files)
  ]);

  return {
    probes,
    coverage,
    invariants_satisfied: invariant_results.satisfied,
    invariants_violated: invariant_results.violated
  };
}
