/**
 * Settlement Supervisor: orchestrates the full admission -> shadow ->
 * settlement -> receipt -> phase-transition loop.
 *
 * This is the wrapper's main entry point (opencode-settlement-integration.md
 * section 8). It is intentionally the only module that imports from every
 * other layer — everything else stays decoupled and independently testable.
 */

import * as fs from "fs";
import * as path from "path";

import {
  Contract,
  AutonomyClass,
  SettlementReceipt,
  PhaseState,
  admitToolCall,
  buildAgentReadState,
  initializePhaseState,
  updatePhaseState,
  logAdmissionDecision,
  testExports as admissionTestExports
} from "./admission-gate";
import { loadAndValidateContract } from "./contract-loader";
import { createWorktree, getDiffsFromWorktree, Worktree } from "./worktree-manager";
import { executeToolInWorktree } from "./tool-executor";
import { runContractProbes } from "./probe-runner";
import { scoreProbeRunAgainstContract, hashEvidence, ChangedFile } from "./settlement-scorer";
import {
  spawnOpenCode,
  readToolCall,
  sendToolResult,
  terminateOpenCode,
  OpenCodeProcess
} from "./opencode-harness";
import { appendReceipt } from "./settlement-ledger";
import {
  loadTrust,
  saveTrust,
  recordApproval,
  recordRejection,
  recordDenial,
  fingerprintRepo
} from "./trust-store";
import { DoomGuard } from "./doom-guard";

const { checkPhaseExitCriteria } = admissionTestExports;

export interface SettlementHarnessOptions {
  /** Starting autonomy class. Defaults to "learner" (see admission-gate.ts). */
  initial_autonomy_class?: AutonomyClass;
  /** Per-tool-call read timeout while waiting on OpenCode's stdout. */
  tool_call_timeout_ms?: number;
  /** Hard cap on iterations, as a runaway-loop guard. */
  max_actions?: number;
  /** Extra env for the agent subprocess, merged over process.env. */
  opencode_env?: Record<string, string>;
  /**
   * Doom-loop circuit breaker: deny the Nth consecutive identical tool
   * call without spending shadow execution on it. Defaults to 3.
   */
  doom_max_repeats?: number;
}

export interface SettlementHarnessResult {
  total_actions: number;
  approved: number;
  rejected: number;
  denied: number;
  final_phase: string;
  final_autonomy_class: AutonomyClass;
  receipts_path: string;
}

// =============================================================================
// SETTLEMENT DIRECTORY SETUP
// =============================================================================

function initSettlementDir(session_root: string, contract: Contract): { settlement_dir: string; receipts_path: string; admission_log_path: string } {
  const settlement_dir = path.join(session_root, ".settlement");
  const contracts_dir = path.join(settlement_dir, "contracts");
  const receipts_dir = path.join(settlement_dir, "receipts");
  const logs_dir = path.join(settlement_dir, "logs");

  fs.mkdirSync(contracts_dir, { recursive: true });
  fs.mkdirSync(receipts_dir, { recursive: true });
  fs.mkdirSync(logs_dir, { recursive: true });

  fs.writeFileSync(
    path.join(contracts_dir, "contract.pinned.json"),
    JSON.stringify(contract, null, 2),
    "utf-8"
  );

  return {
    settlement_dir,
    receipts_path: path.join(receipts_dir, "receipts.jsonl"),
    admission_log_path: path.join(logs_dir, "admission.jsonl")
  };
}

// =============================================================================
// EVIDENCE TYPE / CLAUSE EXTRACTION
// =============================================================================

/**
 * Derive evidence_types for a receipt. The agent's own `claim` (if any) is
 * always included — it's what phase exit criteria are matched against
 * (see admission-gate.ts's checkPhaseExitCriteria, which reads
 * receipt.evidence_types). read-only/no-probe actions (grep, read_file,
 * list_files) still emit a generic "analysis" type so diagnostic-phase
 * exit criteria that don't require a specific claim can still progress.
 */
function extractEvidenceTypes(tool_name: string, claim: string | undefined, verdict: "PASS" | "FAIL"): string[] {
  const types: string[] = [];
  if (verdict === "PASS" && claim) {
    types.push(claim);
  }
  const read_only_tools = ["read_file", "grep", "list_files"];
  if (verdict === "PASS" && read_only_tools.includes(tool_name)) {
    types.push("analysis");
  }
  if (verdict === "PASS" && tool_name === "run_test") {
    types.push("test_pass");
  }
  // Deduplicate: a claim of "analysis" on a read-only tool would otherwise
  // appear twice (once as the claim, once as the generic read-only type).
  return [...new Set(types)];
}

/**
 * Clauses satisfied: currently mirrors invariants_satisfied from the
 * settlement evidence, since the contract's acceptance_criteria don't
 * define named "clauses" distinct from invariants in this schema. Kept
 * as its own function so a future contract schema with explicit clause
 * IDs only needs to change this one seam.
 */
function extractClausesSatisfied(invariants_satisfied: string[]): string[] {
  return invariants_satisfied;
}

// =============================================================================
// SHADOW EXECUTION FOR A SINGLE ACTION
// =============================================================================

interface ShadowActionResult {
  verdict: "PASS" | "FAIL";
  evidence_hash: string;
  invariants_satisfied: string[];
  invariants_violated: string[];
  coverage: { total: number; covered: number; pct: number };
  probes_run: string[];
  failure_reasons: string[];
  stdout: string;
  files_changed: ChangedFile[];
  worktree: Worktree;
}

/**
 * Run a single tool call in an isolated worktree, probe it, and score it
 * against the contract. Does NOT promote diffs or clean up the worktree —
 * that's the caller's job once it has decided PASS/FAIL, since promotion
 * needs to read from the worktree one more time and cleanup should happen
 * in a finally block around both paths.
 */
async function shadowExecuteAndScore(
  contract: Contract,
  session_root: string,
  worktree_id: string,
  tool_name: string,
  tool_input: Record<string, unknown>
): Promise<ShadowActionResult> {
  const worktree = await createWorktree(session_root, worktree_id);

  const tool_result = await executeToolInWorktree(worktree.path, tool_name, tool_input, session_root);

  const diffs = await getDiffsFromWorktree(worktree.path, session_root);
  const changed_paths = diffs.map((d) => d.path);

  const probe_run = await runContractProbes(contract, worktree.path, changed_paths);

  const changed_files: ChangedFile[] = diffs.map((d) => ({ path: d.path, diff: d.diff }));

  const evidence = scoreProbeRunAgainstContract(contract, probe_run, changed_files);

  return {
    verdict: evidence.verdict,
    evidence_hash: hashEvidence(evidence),
    invariants_satisfied: evidence.invariants_satisfied,
    invariants_violated: evidence.invariants_violated,
    coverage: evidence.coverage,
    probes_run: probe_run.probes.map((p) => p.probe_name),
    failure_reasons: evidence.failure_reasons,
    stdout: tool_result.stdout || tool_result.stderr,
    files_changed: diffs.map((d) => ({ path: d.path, diff: d.diff })),
    worktree
  };
}

/**
 * Promote a PASS-scored worktree's changed files back into session_root.
 * Only called after settlement APPROVED — see section 5 of
 * opencode-settlement-integration.md: "this is the ONLY way a write
 * touches the working tree."
 */
function promoteFiles(worktree_path: string, session_root: string, changed_paths: string[]): void {
  for (const rel_path of changed_paths) {
    const src = path.join(worktree_path, rel_path);
    const dest = path.join(session_root, rel_path);

    if (!fs.existsSync(src)) {
      // File was deleted in the worktree; mirror the deletion.
      if (fs.existsSync(dest)) fs.rmSync(dest);
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// =============================================================================
// MAIN LOOP
// =============================================================================

/**
 * Run the settlement harness loop end-to-end: load the contract, spawn
 * OpenCode, and drive iterations until the phase state reaches "complete"
 * or OpenCode terminates on its own.
 */
export async function settlementHarnessLoop(
  contract_path: string,
  working_tree_root: string,
  opencode_executable: string,
  options: SettlementHarnessOptions = {}
): Promise<SettlementHarnessResult> {
  const {
    initial_autonomy_class = AutonomyClass.LEARNER,
    tool_call_timeout_ms = 30000,
    max_actions = 500,
    opencode_env = {},
    doom_max_repeats = 3
  } = options;

  // 1. Load and stage-gate the contract.
  const contract = await loadAndValidateContract(contract_path);
  if (!contract._read_only) {
    throw new Error("Contract must be stage-gated (user_confirmed_at must be set) before session start");
  }

  // 2. Initialize settlement infrastructure.
  const session_root = working_tree_root;
  const { receipts_path, admission_log_path } = initSettlementDir(session_root, contract);

  // 3. Initialize state.
  let phase_state: PhaseState = initializePhaseState(contract);
  // Graduated autonomy: resume this repo's license from the persisted
  // trust file (fresh repos start at initial_autonomy_class). The class
  // is re-read from `trust` every iteration — never cached in a local.
  const trust_path = path.join(session_root, ".settlement", "trust.json");
  let trust = loadTrust(trust_path, fingerprintRepo(session_root), initial_autonomy_class);
  console.log(`[TRUST] Repo license: ${trust.autonomy_class} (streak ${trust.consecutive_settled}, incidents ${trust.incidents.length})`);
  const doom = new DoomGuard(doom_max_repeats);
  let last_rejection: { reason: string; action_id: string; tool_name: string } | undefined = undefined;
  let action_counter = 0;
  let opencode_process: OpenCodeProcess | null = null;

  let approved_count = 0;
  let rejected_count = 0;
  let denied_count = 0;

  console.log(`[SETTLEMENT] Starting harness loop`);
  console.log(`[CONTRACT] Hash: ${contract.contract_hash}`);
  console.log(`[PHASES] ${contract.phases.map((p) => p.name).join(" → ")}`);

  try {
    // 4. Main loop.
    while (phase_state.current_phase_name !== "complete") {
      if (action_counter >= max_actions) {
        throw new Error(`Exceeded max_actions (${max_actions}); aborting to avoid a runaway loop`);
      }

      action_counter++;
      const action_id = `act_${String(action_counter).padStart(3, "0")}`;

      const current_phase = contract.phases.find((p) => p.name === phase_state.current_phase_name);
      if (!current_phase) {
        throw new Error(`Phase '${phase_state.current_phase_name}' not found in contract`);
      }

      const agent_read_state = buildAgentReadState(
        contract,
        phase_state,
        trust.autonomy_class,
        last_rejection,
        contract.acceptance_criteria.evidence_ttl_actions
      );

      // Spawn OpenCode once; subsequent iterations resume the same
      // process (see opencode-harness.ts: stdin stays open for the whole
      // session, matching mock-opencode.sh's protocol notes).
      if (!opencode_process) {
        opencode_process = await spawnOpenCode(opencode_executable, agent_read_state, [], opencode_env);
      }

      // Read next tool call from OpenCode.
      const tool_call = await readToolCall(opencode_process, tool_call_timeout_ms);
      if (!tool_call) {
        console.log(`[SETTLEMENT] OpenCode terminated`);
        break;
      }

      console.log(`[ACTION ${action_id}] Tool: ${tool_call.tool}, Claim: ${tool_call.claim ?? "none"}`);

      // Doom-loop circuit breaker: identical resubmission without progress
      // is denied BEFORE admission, spending no shadow execution on it.
      // Synthesized as a DENY so the ledger stays complete and the agent
      // gets the strategy-change signal through the normal channel.
      const admission = doom.note(tool_call.tool, tool_call.input)
        ? {
            decision: "DENY" as const,
            reason: `Doom-loop circuit breaker: identical action repeated ${doom.consecutiveIdentical} times with no progress; change strategy (different tool, path, or evidence)`,
            settlement_required: false,
            requires_shadow_execution: false
          }
        : admitToolCall({
            contract,
            current_phase,
            autonomy_class: trust.autonomy_class,
            tool_name: tool_call.tool,
            tool_input: tool_call.input,
            previous_phase_evidence: phase_state.evidence_collected,
            working_tree_root: session_root
          });

      logAdmissionDecision(admission_log_path, action_id, tool_call.tool, admission, tool_call.input);

      // Freshness window for the missing-evidence report: stale evidence
      // must show up as missing so the agent re-proves it.
      const freshness_now = {
        nowIndex: action_counter,
        ttl: contract.acceptance_criteria.evidence_ttl_actions ?? {}
      };

      // Handle DENY: no shadow execution, no receipt — just tell the agent why.
      if (admission.decision === "DENY") {
        console.log(`[ADMISSION] DENY: ${admission.reason}`);
        denied_count++;
        trust = recordDenial(trust, { action_id, reason: admission.reason });
        saveTrust(trust_path, trust);
        last_rejection = { action_id, tool_name: tool_call.tool, reason: admission.reason };

        await sendToolResult(opencode_process, {
          action_id,
          status: "ADMISSION_DENIED",
          reason: admission.reason,
          phase_state: {
            current_phase_name: phase_state.current_phase_name,
            missing_evidence: checkPhaseExitCriteria(current_phase, phase_state.evidence_collected, freshness_now).missing,
            receipts_count: phase_state.evidence_collected.length
          }
        });
        continue;
      }

      // PERMIT or QUARANTINE: shadow-execute and score.
      console.log(`[EXECUTION] Running in shadow worktree`);
      const shadow = await shadowExecuteAndScore(
        contract,
        session_root,
        `wt_${action_id}`,
        tool_call.tool,
        tool_call.input
      );

      try {
        console.log(`[SETTLEMENT] ${shadow.verdict}`);

        const evidence_types = extractEvidenceTypes(tool_call.tool, tool_call.claim, shadow.verdict);

        const receipt: SettlementReceipt = {
          action_id,
          timestamp: new Date().toISOString(),
          phase: current_phase.name,
          tool_name: tool_call.tool,
          settlement: shadow.verdict === "PASS" ? "APPROVED" : "REJECTED",
          evidence_hash: shadow.evidence_hash,
          evidence_types,
          clauses_satisfied: extractClausesSatisfied(shadow.invariants_satisfied),
          probes_run: shadow.probes_run,
          files_promoted: shadow.verdict === "PASS" ? shadow.files_changed.map((f) => f.path) : [],
          rejection_reason: shadow.verdict === "FAIL" ? shadow.failure_reasons[0] : undefined
        };

        appendReceipt(receipts_path, receipt);

        if (receipt.settlement === "APPROVED") {
          approved_count++;
          trust = recordApproval(trust);
          console.log(`[PROMOTION] Promoting ${shadow.files_changed.length} file(s)`);
          promoteFiles(
            shadow.worktree.path,
            session_root,
            shadow.files_changed.map((f) => f.path)
          );
        } else {
          rejected_count++;
          trust = recordRejection(trust, {
            action_id,
            reason: receipt.rejection_reason ?? "Settlement rejected"
          });
        }
        saveTrust(trust_path, trust);

        const old_phase = phase_state.current_phase_name;
        phase_state = updatePhaseState(
          contract,
          phase_state,
          receipt,
          contract.acceptance_criteria.evidence_ttl_actions
        );
        if (phase_state.current_phase_name !== old_phase) {
          console.log(`[PHASE TRANSITION] ${old_phase} → ${phase_state.current_phase_name}`);
          doom.reset(); // new context, clean slate for the breaker
        }

        last_rejection =
          receipt.settlement === "REJECTED"
            ? { action_id, tool_name: tool_call.tool, reason: receipt.rejection_reason ?? "Settlement rejected" }
            : undefined;

        const next_phase =
          phase_state.current_phase_name === "complete"
            ? undefined
            : contract.phases.find((p) => p.name === phase_state.current_phase_name);

        await sendToolResult(opencode_process, {
          action_id,
          status: receipt.settlement === "APPROVED" ? "SETTLED" : "SETTLEMENT_REJECTED",
          result: shadow.stdout,
          receipt_id: `${action_id}_rcpt`,
          settlement: receipt.settlement,
          rejection_reason: receipt.rejection_reason,
          failed_probes: shadow.invariants_violated,
          metrics: {
            coverage: shadow.coverage.pct,
            coverage_floor: contract.acceptance_criteria.tests.coverage_floor
          },
          phase_transitioned_to: phase_state.current_phase_name !== old_phase ? phase_state.current_phase_name : undefined,
          next_phase,
          phase_state: {
            current_phase_name: phase_state.current_phase_name,
            missing_evidence:
              phase_state.current_phase_name === "complete"
                ? []
                : checkPhaseExitCriteria(
                    contract.phases.find((p) => p.name === phase_state.current_phase_name)!,
                    phase_state.evidence_collected,
                    freshness_now
                  ).missing,
            receipts_count: phase_state.evidence_collected.length
          }
        });
      } finally {
        // Worktrees are always ephemeral (section 9, point 4) — clean up
        // whether settlement passed or failed.
        await shadow.worktree.cleanup();
      }
    }

    console.log(`[SETTLEMENT COMPLETE]`);
    console.log(`Total actions: ${action_counter}`);
    console.log(`Approved: ${approved_count}, Rejected: ${rejected_count}, Denied: ${denied_count}`);
    console.log(`Session receipt ledger: ${receipts_path}`);

    return {
      total_actions: action_counter,
      approved: approved_count,
      rejected: rejected_count,
      denied: denied_count,
      final_phase: phase_state.current_phase_name,
      final_autonomy_class: trust.autonomy_class,
      receipts_path
    };
  } finally {
    if (opencode_process) {
      await terminateOpenCode(opencode_process);
    }
  }
}

// =============================================================================
// CLI ENTRY POINT
// =============================================================================

if (require.main === module) {
  settlementHarnessLoop(
    process.argv[2],
    process.argv[3] || process.cwd(),
    process.argv[4] || "opencode"
  ).catch((e) => {
    console.error(`[ERROR] ${e.message}`);
    process.exitCode = 1;
  });
}
