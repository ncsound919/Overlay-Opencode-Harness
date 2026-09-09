/**
 * Admission Gate: Pure function enforcement of contract rules
 * 
 * Every tool invocation passes through here before execution.
 * This is the load-bearing constraint that makes "forgetting" the contract impossible.
 */

import * as fs from "fs";
import * as path from "path";

// Contract types are defined once in contract-loader.ts (the source of
// truth). This module re-exports them so existing importers
// (`import { Contract } from "./admission-gate"`) keep working without a
// second, drift-prone copy of the interfaces.
import { Contract, Phase, AcceptanceCriteria } from "./contract-loader";
export type { Contract, Phase, AcceptanceCriteria };

// =============================================================================
// SETTLEMENT RECEIPT
// =============================================================================

export interface SettlementReceipt {
  action_id: string;
  timestamp: string;
  phase: string;
  tool_name: string;
  settlement: "APPROVED" | "REJECTED";
  evidence_hash: string;
  evidence_types: string[];
  clauses_satisfied: string[];
  probes_run: string[];
  files_promoted: string[];
  rejection_reason?: string;
}

export enum AutonomyClass {
  LEARNER = "learner", // read-only, all writes in shadow
  SUPERVISED = "supervised", // writes in shadow, requires settlement
  AUTONOMOUS = "autonomous" // writes permitted directly (still settled)
}

export interface AdmissionCheckInput {
  contract: Contract;
  current_phase: Phase;
  autonomy_class: AutonomyClass;
  tool_name: string;
  tool_input: Record<string, unknown>;
  previous_phase_evidence: SettlementReceipt[];
  working_tree_root: string;
}

export interface AdmissionDecision {
  decision: "PERMIT" | "DENY" | "QUARANTINE";
  reason: string;
  phase_transition?: string; // name of next phase if criteria met
  settlement_required: boolean; // does this action need probes to settle?
  requires_shadow_execution: boolean; // does it run in worktree before touching disk?
}

// =============================================================================
// SCOPE CHECKING UTILITIES
// =============================================================================

/**
 * Normalize a file path for scope checking.
 * Resolves relative paths, normalizes separators, collapses . and ..
 *
 * Always returns forward-slash separators, even on Windows (where
 * path.relative yields backslashes), because contract scope patterns are
 * written with forward slashes ("src/payment.ts", "src/**"). Without this,
 * every exact scope match fails on Windows.
 */
function normalizePath(file_path: string, working_tree_root: string): string {
  const abs_path = path.isAbsolute(file_path)
    ? file_path
    : path.join(working_tree_root, file_path);

  const normalized = path.normalize(abs_path);
  const relative = path.relative(working_tree_root, normalized);

  // Prevent escaping the working tree with ..
  if (relative.startsWith("..")) {
    throw new Error(`Path escape attempt: ${file_path} resolves outside working tree`);
  }

  return relative.split(path.sep).join("/");
}

/**
 * Check if a file path matches a scope pattern.
 * Patterns support wildcards: "src/**\/*.ts", "tests/legacy/*"
 */
function isPathInScope(
  file_path: string,
  scope_patterns: string[],
  working_tree_root: string
): boolean {
  const normalized = normalizePath(file_path, working_tree_root);

  return scope_patterns.some((pattern) => {
    // Simple glob-like matching
    // "src/payment.ts" matches "src/payment.ts"
    // "src/payment.ts" matches "src/**"
    // "src/payment.ts" does NOT match "tests/*"

    if (pattern === normalized) return true;

    // Convert glob to regex. `**` must be expanded BEFORE `*`: the old
    // order (`*` first) consumed both asterisks, so "src/**" compiled to
    // ^src/[^/]*[^/]*$ and never matched nested paths like "src/a/b.ts".
    const regex_pattern = pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "__GLOBSTAR__")
      .replace(/\*/g, "[^/]*")
      .replace(/__GLOBSTAR__/g, ".*");

    const regex = new RegExp(`^${regex_pattern}$`);
    return regex.test(normalized);
  });
}

/**
 * Check if a file operation targets only in-scope files
 */
function checkFileScopeForOperation(
  tool_name: string,
  tool_input: Record<string, unknown>,
  scope_patterns: string[],
  working_tree_root: string
): { ok: boolean; reason?: string; target_paths?: string[] } {
  const write_tools = ["write_file", "create_file", "delete_file", "modify_file"];
  if (!write_tools.includes(tool_name)) {
    return { ok: true };
  }

  const target_path = tool_input.path as string | undefined;
  if (!target_path) {
    return { ok: false, reason: "write_file call missing 'path' input" };
  }

  try {
    const normalized = normalizePath(target_path, working_tree_root);
    const in_scope = isPathInScope(target_path, scope_patterns, working_tree_root);

    if (!in_scope) {
      return {
        ok: false,
        reason: `File '${normalized}' not in contract scope. Scope: ${scope_patterns.join(", ")}`
      };
    }

    return { ok: true, target_paths: [normalized] };
  } catch (e) {
    return {
      ok: false,
      reason: `Invalid path '${target_path}': ${(e as Error).message}`
    };
  }
}

// =============================================================================
// FORBIDDEN OPERATIONS CHECK
// =============================================================================

/**
 * Check if a tool call violates forbidden operations
 */
function checkForbiddenOperations(
  tool_name: string,
  tool_input: Record<string, unknown>,
  forbidden_operations: string[]
): { ok: boolean; reason?: string } {
  // Direct forbidden tool
  if (forbidden_operations.includes(tool_name)) {
    return { ok: false, reason: `Tool '${tool_name}' is forbidden by contract` };
  }

  // Parameterized forbidden operations (e.g., "execute_external_command:curl")
  for (const forbidden of forbidden_operations) {
    if (forbidden.includes(":")) {
      const [tool, param] = forbidden.split(":");
      if (tool === tool_name) {
        const actual_param = tool_input[param] as string | undefined;
        if (actual_param && actual_param.includes(param)) {
          return {
            ok: false,
            reason: `Operation '${forbidden}' is forbidden by contract`
          };
        }
      }
    }
  }

  return { ok: true };
}

// =============================================================================
// AUTONOMY CLASS GATING
// =============================================================================

/**
 * Check if the current autonomy class permits this action
 */
function checkAutonomyClass(
  tool_name: string,
  autonomy_class: AutonomyClass
): { ok: boolean; requires_shadow: boolean; reason?: string } {
  const write_tools = ["write_file", "create_file", "delete_file", "modify_file", "run_test"];
  const is_write = write_tools.includes(tool_name);

  switch (autonomy_class) {
    case AutonomyClass.LEARNER:
      // Learner's permit: destructive ops are off-limits entirely. This is
      // the one capability gate that differs by class — shadow execution
      // itself stays universal (the safety floor never lowers with trust).
      if (tool_name === "delete_file") {
        return {
          ok: false,
          requires_shadow: false,
          reason: "Learner autonomy cannot delete files; earn SUPERVISED through settled approvals"
        };
      }
      if (is_write) {
        return {
          ok: true,
          requires_shadow: true,
          reason: "Learner permit: all writes run in shadow, require settlement"
        };
      }
      return { ok: true, requires_shadow: false };

    case AutonomyClass.SUPERVISED:
      if (is_write) {
        return {
          ok: true,
          requires_shadow: true,
          reason: "Supervised: writes run in shadow, require settlement before promotion"
        };
      }
      return { ok: true, requires_shadow: false };

    case AutonomyClass.AUTONOMOUS:
      // Even autonomous writes are shadowed for correctness, but we'll promote if settlement passes
      return { ok: true, requires_shadow: true };

    default:
      return {
        ok: false,
        requires_shadow: false,
        reason: `Unknown autonomy class: ${autonomy_class}`
      };
  }
}

// =============================================================================
// PHASE GATING
// =============================================================================

/**
 * Check if a tool is permitted in the current phase
 */
function checkPhaseToolPermission(
  tool_name: string,
  current_phase: Phase
): { ok: boolean; reason?: string } {
  if (current_phase.permitted_tools.includes(tool_name)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Tool '${tool_name}' not permitted in phase '${current_phase.name}'. Permitted: ${current_phase.permitted_tools.join(", ")}`
  };
}

/**
 * Check if prior phase has emitted required evidence for phase entry
 */
function checkPhasePrerequites(
  current_phase: Phase,
  contract: Contract,
  previous_phase_evidence: SettlementReceipt[]
): { ok: boolean; reason?: string; missing?: string[] } {
  if (!current_phase.requires_prior_phase) {
    return { ok: true };
  }

  const prior_phase = contract.phases.find((p) => p.name === current_phase.requires_prior_phase);
  if (!prior_phase) {
    return {
      ok: false,
      reason: `Phase '${current_phase.name}' requires prior phase '${current_phase.requires_prior_phase}', which does not exist in contract`
    };
  }

  const required_evidence = prior_phase.exit_criteria.required_evidence;
  const evidence_types_seen = new Set(
    previous_phase_evidence.flatMap((r) => r.evidence_types)
  );

  const missing = required_evidence.filter((e) => !evidence_types_seen.has(e));

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Phase '${current_phase.name}' requires prior evidence: ${missing.join(", ")}`,
      missing
    };
  }

  return { ok: true };
}

/**
 * Evidence freshness window for the epistemic ledger. An evidence type
 * counts toward phase exit only if some receipt carrying it is no older
 * than ttl[type] actions. Types absent from ttl never expire (backwards
 * compatible: contracts without evidence_ttl_actions behave exactly as
 * before). Action-based (not wall-clock) so evaluation is deterministic
 * and immune to clock skew; indices come from harness receipt action_ids.
 */
export interface EvidenceFreshness {
  nowIndex: number;
  ttl: Record<string, number>;
}

/**
 * Parse a harness action index from a receipt action_id ("act_007" -> 7).
 * Unparseable ids are treated as genesis (index 0): always fresh unless
 * the contract sets a TTL the current index already exceeds. Documented
 * rather than throwing so hand-built test receipts keep working.
 */
export function actionIndexFromId(action_id: string): number {
  const m = /^act_(\d+)$/.exec(action_id);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * The set of evidence types with at least one fresh receipt. Exported for
 * testing; checkPhaseExitCriteria is the normal entry point.
 */
export function freshEvidenceTypes(
  evidence: SettlementReceipt[],
  freshness?: EvidenceFreshness
): Set<string> {
  const seen = new Set<string>();
  if (!freshness) {
    for (const r of evidence) for (const t of r.evidence_types) seen.add(t);
    return seen;
  }
  for (const r of evidence) {
    const age = freshness.nowIndex - actionIndexFromId(r.action_id);
    for (const t of r.evidence_types) {
      const limit = freshness.ttl[t];
      if (limit === undefined || age <= limit) seen.add(t);
    }
  }
  return seen;
}

/**
 * Determine if phase exit criteria are met for auto-transition
 */
function checkPhaseExitCriteria(
  phase: Phase,
  evidence: SettlementReceipt[],
  freshness?: EvidenceFreshness
): { can_exit: boolean; missing: string[] } {
  const required = phase.exit_criteria.required_evidence;
  const evidence_types_seen = freshEvidenceTypes(evidence, freshness);
  const missing = required.filter((e) => !evidence_types_seen.has(e));

  return {
    can_exit: missing.length === 0,
    missing
  };
}

/**
 * Find the next phase if current phase can exit
 */
function getNextPhase(
  contract: Contract,
  current_phase_name: string,
  evidence: SettlementReceipt[]
): { next_phase?: Phase; can_exit: boolean } {
  const current_phase = contract.phases.find((p) => p.name === current_phase_name);
  if (!current_phase) {
    return { can_exit: false };
  }

  const { can_exit } = checkPhaseExitCriteria(current_phase, evidence);
  if (!can_exit) {
    return { can_exit: false };
  }

  const current_idx = contract.phases.indexOf(current_phase);
  if (current_idx + 1 < contract.phases.length) {
    return {
      can_exit: true,
      next_phase: contract.phases[current_idx + 1]
    };
  }

  return { can_exit: true }; // all phases complete
}

// =============================================================================
// MAIN ADMISSION GATE
// =============================================================================

/**
 * Core admission gate: decide PERMIT | DENY | QUARANTINE
 * Pure function over immutable contract state.
 */
export function admitToolCall(input: AdmissionCheckInput): AdmissionDecision {
  const {
    contract,
    current_phase,
    autonomy_class,
    tool_name,
    tool_input,
    previous_phase_evidence,
    working_tree_root
  } = input;

  // Rule 1: Tool must be in permitted list for current phase
  {
    const check = checkPhaseToolPermission(tool_name, current_phase);
    if (!check.ok) {
      return {
        decision: "DENY",
        reason: check.reason!,
        settlement_required: false,
        requires_shadow_execution: false
      };
    }
  }

  // Rule 2: File operations must target in-scope files
  {
    const check = checkFileScopeForOperation(
      tool_name,
      tool_input,
      contract.scope.files_in_scope,
      working_tree_root
    );
    if (!check.ok) {
      return {
        decision: "DENY",
        reason: check.reason!,
        settlement_required: false,
        requires_shadow_execution: false
      };
    }
  }

  // Rule 3: Forbidden operations are hard blocks
  {
    const check = checkForbiddenOperations(tool_name, tool_input, contract.scope.forbidden_operations);
    if (!check.ok) {
      return {
        decision: "DENY",
        reason: check.reason!,
        settlement_required: false,
        requires_shadow_execution: false
      };
    }
  }

  // Rule 4: Autonomy class gates (learner/supervised can't edit without shadow)
  const autonomy_check = checkAutonomyClass(tool_name, autonomy_class);
  if (!autonomy_check.ok) {
    return {
      decision: "DENY",
      reason: autonomy_check.reason!,
      settlement_required: false,
      requires_shadow_execution: false
    };
  }

  // Rule 5: Phase prerequisites (prior phase must have emitted required evidence)
  {
    const check = checkPhasePrerequites(current_phase, contract, previous_phase_evidence);
    if (!check.ok) {
      return {
        decision: "DENY",
        reason: check.reason!,
        settlement_required: false,
        requires_shadow_execution: false
      };
    }
  }

  // Rule 6: Determine settlement requirements based on tool type
  const write_tools = ["write_file", "create_file", "delete_file", "modify_file"];
  const test_tools = ["run_test"];
  const settlement_required = [...write_tools, ...test_tools].includes(tool_name);

  // All checks passed: PERMIT or QUARANTINE depending on autonomy class
  const next_phase_info = getNextPhase(contract, current_phase.name, previous_phase_evidence);

  return {
    decision: autonomy_check.requires_shadow ? "QUARANTINE" : "PERMIT",
    reason: autonomy_check.reason || "All checks passed",
    phase_transition: next_phase_info.next_phase?.name,
    settlement_required,
    requires_shadow_execution: autonomy_check.requires_shadow
  };
}

// =============================================================================
// LOGGING & AUDIT TRAIL
// =============================================================================

export interface AdmissionLog {
  timestamp: string;
  action_id: string;
  tool_name: string;
  decision: AdmissionDecision;
  input_summary: Record<string, unknown>;
}

/**
 * Log an admission decision (appends to immutable ledger)
 */
export function logAdmissionDecision(
  log_path: string,
  action_id: string,
  tool_name: string,
  decision: AdmissionDecision,
  tool_input: Record<string, unknown>
): void {
  const log_entry: AdmissionLog = {
    timestamp: new Date().toISOString(),
    action_id,
    tool_name,
    decision,
    input_summary: summarizeToolInput(tool_name, tool_input)
  };

  const log_line = JSON.stringify(log_entry) + "\n";
  fs.appendFileSync(log_path, log_line, "utf-8");
}

/**
 * Summarize tool input for logging (omit large payloads)
 */
function summarizeToolInput(tool_name: string, input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 200) {
      summary[key] = `[string, ${value.length} chars]`;
    } else if (Buffer.isBuffer(value)) {
      summary[key] = `[buffer, ${value.length} bytes]`;
    } else if (typeof value === "object" && value !== null) {
      summary[key] = `[object]`;
    } else {
      summary[key] = value;
    }
  }

  return summary;
}

// =============================================================================
// PHASE STATE MANAGEMENT
// =============================================================================

export interface PhaseState {
  current_phase_name: string;
  evidence_collected: SettlementReceipt[];
  evidence_by_type: Map<string, SettlementReceipt[]>;
  completed_at?: string;
}

/**
 * Initialize phase state (start at first phase with no evidence)
 */
export function initializePhaseState(contract: Contract): PhaseState {
  return {
    current_phase_name: contract.phases[0].name,
    evidence_collected: [],
    evidence_by_type: new Map()
  };
}

/**
 * Update phase state with a new receipt, check for phase transition.
 * Pass the contract's evidence_ttl_actions (if any) so stale evidence
 * stops counting: a claim proven 40 actions ago must be re-proven.
 */
export function updatePhaseState(
  contract: Contract,
  current_state: PhaseState,
  new_receipt: SettlementReceipt,
  evidence_ttl_actions?: Record<string, number>
): PhaseState {
  // Only approved receipts contribute evidence
  if (new_receipt.settlement !== "APPROVED") {
    return current_state;
  }

  const updated_evidence = [...current_state.evidence_collected, new_receipt];
  const current_phase = contract.phases.find((p) => p.name === current_state.current_phase_name);

  if (!current_phase) {
    throw new Error(`Phase '${current_state.current_phase_name}' not found in contract`);
  }

  // Check if we can exit current phase
  const freshness: EvidenceFreshness | undefined = evidence_ttl_actions
    ? { nowIndex: actionIndexFromId(new_receipt.action_id), ttl: evidence_ttl_actions }
    : undefined;
  const { can_exit, missing } = checkPhaseExitCriteria(current_phase, updated_evidence, freshness);

  if (can_exit) {
    // Find next phase
    const current_idx = contract.phases.indexOf(current_phase);
    if (current_idx + 1 < contract.phases.length) {
      const next_phase = contract.phases[current_idx + 1];
      console.log(
        `[PHASE TRANSITION] ${current_state.current_phase_name} → ${next_phase.name}`
      );

      // Rebuild evidence_by_type map
      const evidence_by_type = new Map<string, SettlementReceipt[]>();
      for (const receipt of updated_evidence) {
        for (const ev_type of receipt.evidence_types) {
          if (!evidence_by_type.has(ev_type)) {
            evidence_by_type.set(ev_type, []);
          }
          evidence_by_type.get(ev_type)!.push(receipt);
        }
      }

      return {
        current_phase_name: next_phase.name,
        evidence_collected: updated_evidence,
        evidence_by_type
      };
    } else {
      console.log(`[SETTLEMENT COMPLETE]`);
      return {
        current_phase_name: "complete",
        evidence_collected: updated_evidence,
        evidence_by_type: new Map(),
        completed_at: new Date().toISOString()
      };
    }
  } else {
    console.log(`[PHASE GATE] Staying in '${current_phase.name}'. Missing evidence: ${missing.join(", ")}`);

    // Rebuild evidence_by_type map
    const evidence_by_type = new Map<string, SettlementReceipt[]>();
    for (const receipt of updated_evidence) {
      for (const ev_type of receipt.evidence_types) {
        if (!evidence_by_type.has(ev_type)) {
          evidence_by_type.set(ev_type, []);
        }
        evidence_by_type.get(ev_type)!.push(receipt);
      }
    }

    return {
      current_phase_name: current_state.current_phase_name,
      evidence_collected: updated_evidence,
      evidence_by_type
    };
  }
}

// =============================================================================
// READABLE STATE FOR AGENT
// =============================================================================

export interface AgentReadState {
  contract: Contract;
  current_phase: Phase;
  receipts_so_far: SettlementReceipt[];
  missing_evidence: string[];
  autonomy_class: AutonomyClass;
  last_rejection?: {
    reason: string;
    action_id: string;
    tool_name: string;
  };
}

/**
 * Build the readable state that gets passed to the agent
 */
export function buildAgentReadState(
  contract: Contract,
  phase_state: PhaseState,
  autonomy_class: AutonomyClass,
  last_rejection?: { reason: string; action_id: string; tool_name: string },
  evidence_ttl_actions?: Record<string, number>
): AgentReadState {
  const current_phase = contract.phases.find((p) => p.name === phase_state.current_phase_name);
  if (!current_phase) {
    throw new Error(`Phase '${phase_state.current_phase_name}' not found`);
  }

  // "Now" for freshness purposes is the latest receipt index (0 when the
  // ledger is empty), so missing_evidence already reflects staleness.
  const nowIndex = phase_state.evidence_collected.reduce(
    (m, r) => Math.max(m, actionIndexFromId(r.action_id)),
    0
  );
  const freshness: EvidenceFreshness | undefined = evidence_ttl_actions
    ? { nowIndex, ttl: evidence_ttl_actions }
    : undefined;
  const { missing } = checkPhaseExitCriteria(current_phase, phase_state.evidence_collected, freshness);

  return {
    contract,
    current_phase,
    receipts_so_far: phase_state.evidence_collected,
    missing_evidence: missing,
    autonomy_class,
    last_rejection
  };
}

// =============================================================================
// EXPORTS FOR TESTING
// =============================================================================

export const testExports = {
  normalizePath,
  isPathInScope,
  checkFileScopeForOperation,
  checkForbiddenOperations,
  checkAutonomyClass,
  checkPhaseToolPermission,
  checkPhasePrerequites,
  checkPhaseExitCriteria,
  getNextPhase,
  actionIndexFromId,
  freshEvidenceTypes
};
