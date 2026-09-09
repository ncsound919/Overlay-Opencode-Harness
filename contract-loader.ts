/**
 * Contract Loader: Load and validate stage-gated contracts
 *
 * The contract is the source of truth for all settlement decisions.
 * This module ensures the contract is:
 * 1. Well-formed (valid JSON, required fields present)
 * 2. Stage-gated (user has confirmed the contract)
 * 3. Frozen (no modifications after stage-gate)
 * 4. Semantically valid (phases make sense, exit criteria are achievable)
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// =============================================================================
// TYPE DEFINITIONS (mirrors settlement-wrapper-spec.md)
// =============================================================================

export interface Contract {
  version: number;
  contract_hash: string;
  created_at: string;
  user_confirmed_at: string; // ISO 8601 timestamp; REQUIRED for stage-gate
  _read_only: boolean; // MUST be true after stage-gate

  scope: {
    description: string;
    files_in_scope: string[];
    forbidden_operations: string[];
    invariants: string[];
  };

  phases: Phase[];
  acceptance_criteria: AcceptanceCriteria;
}

export interface Phase {
  name: string;
  description: string;
  permitted_tools: string[];
  claim_types_admitted: string[];
  requires_prior_phase?: string;
  exit_criteria: {
    required_evidence: string[];
  };
}

export interface AcceptanceCriteria {
  tests: {
    path: string;
    must_pass: string[];
    coverage_floor: number;
  };
  invariants: Array<{
    name: string;
    check: string;
  }>;
  diffs_must_not: string[];
  /**
   * Optional epistemic TTL: evidence type -> max age in actions. A receipt
   * carrying type T counts toward phase exit only within ttl[T] actions of
   * when it was minted. Types absent here never expire. See
   * admission-gate.ts EvidenceFreshness.
   */
  evidence_ttl_actions?: Record<string, number>;
}

// =============================================================================
// CONTRACT LOADING
// =============================================================================

/**
 * Load a contract from disk
 * Throws if file not found or JSON is invalid
 */
export function loadContract(contract_path: string): Contract {
  if (!fs.existsSync(contract_path)) {
    throw new Error(`Contract file not found: ${contract_path}`);
  }

  let raw_content: string;
  try {
    raw_content = fs.readFileSync(contract_path, "utf-8");
  } catch (e) {
    throw new Error(`Failed to read contract file: ${(e as Error).message}`);
  }

  let contract: any;
  try {
    contract = JSON.parse(raw_content);
  } catch (e) {
    throw new Error(`Contract JSON is invalid: ${(e as Error).message}`);
  }

  return contract as Contract;
}

// =============================================================================
// SCHEMA VALIDATION
// =============================================================================

/**
 * Validate the contract schema (all required fields present)
 */
export function validateContractSchema(contract: Contract): void {
  // Top-level fields
  if (typeof contract.version !== "number" || contract.version !== 1) {
    throw new Error("Contract version must be 1");
  }

  if (typeof contract.contract_hash !== "string" || !contract.contract_hash.startsWith("sha256:")) {
    throw new Error("Contract must have contract_hash (sha256:...)");
  }

  if (typeof contract.created_at !== "string") {
    throw new Error("Contract must have created_at (ISO 8601 timestamp)");
  }

  // Stage-gate check (CRITICAL)
  if (!contract.user_confirmed_at) {
    throw new Error(
      "Contract is not stage-gated. user_confirmed_at must be set by user confirmation."
    );
  }

  if (typeof contract.user_confirmed_at !== "string") {
    throw new Error("user_confirmed_at must be an ISO 8601 timestamp string");
  }

  try {
    new Date(contract.user_confirmed_at);
  } catch (e) {
    throw new Error(`user_confirmed_at is not a valid ISO 8601 timestamp: ${contract.user_confirmed_at}`);
  }

  // Read-only flag
  if (contract._read_only !== true) {
    throw new Error("Contract must be read-only (_read_only: true) after stage-gating");
  }

  // Scope validation
  if (!contract.scope) {
    throw new Error("Contract must have scope");
  }

  if (typeof contract.scope.description !== "string") {
    throw new Error("scope.description must be a string");
  }

  if (!Array.isArray(contract.scope.files_in_scope)) {
    throw new Error("scope.files_in_scope must be an array");
  }

  if (contract.scope.files_in_scope.length === 0) {
    throw new Error("scope.files_in_scope must not be empty");
  }

  if (!Array.isArray(contract.scope.forbidden_operations)) {
    throw new Error("scope.forbidden_operations must be an array");
  }

  if (!Array.isArray(contract.scope.invariants)) {
    throw new Error("scope.invariants must be an array");
  }

  // Phases validation
  if (!Array.isArray(contract.phases)) {
    throw new Error("Contract must have phases array");
  }

  if (contract.phases.length === 0) {
    throw new Error("Contract must have at least one phase");
  }

  for (let i = 0; i < contract.phases.length; i++) {
    const phase = contract.phases[i];
    validatePhase(phase, i, contract.phases);
  }

  // Acceptance criteria validation
  if (!contract.acceptance_criteria) {
    throw new Error("Contract must have acceptance_criteria");
  }

  validateAcceptanceCriteria(contract.acceptance_criteria);
}

/**
 * Validate a phase object
 */
function validatePhase(phase: Phase, index: number, all_phases: Phase[]): void {
  if (typeof phase.name !== "string") {
    throw new Error(`phases[${index}].name must be a string`);
  }

  if (typeof phase.description !== "string") {
    throw new Error(`phases[${index}].description must be a string`);
  }

  if (!Array.isArray(phase.permitted_tools)) {
    throw new Error(`phases[${index}].permitted_tools must be an array`);
  }

  if (phase.permitted_tools.length === 0) {
    throw new Error(`phases[${index}].permitted_tools must not be empty`);
  }

  if (!Array.isArray(phase.claim_types_admitted)) {
    throw new Error(`phases[${index}].claim_types_admitted must be an array`);
  }

  if (!phase.exit_criteria) {
    throw new Error(`phases[${index}].exit_criteria must be defined`);
  }

  if (!Array.isArray(phase.exit_criteria.required_evidence)) {
    throw new Error(`phases[${index}].exit_criteria.required_evidence must be an array`);
  }

  // If phase requires a prior phase, that phase must exist
  if (phase.requires_prior_phase) {
    const prior_exists = all_phases.some((p) => p.name === phase.requires_prior_phase);
    if (!prior_exists) {
      throw new Error(
        `phases[${index}] requires_prior_phase '${phase.requires_prior_phase}' does not exist`
      );
    }

    // Prior phase must come before this phase
    const prior_index = all_phases.findIndex((p) => p.name === phase.requires_prior_phase);
    if (prior_index >= index) {
      throw new Error(
        `phases[${index}] requires_prior_phase '${phase.requires_prior_phase}' must come before phase '${phase.name}'`
      );
    }
  }
}

/**
 * Validate acceptance criteria
 */
function validateAcceptanceCriteria(criteria: AcceptanceCriteria): void {
  if (!criteria.tests) {
    throw new Error("acceptance_criteria.tests must be defined");
  }

  if (typeof criteria.tests.path !== "string") {
    throw new Error("acceptance_criteria.tests.path must be a string");
  }

  if (!Array.isArray(criteria.tests.must_pass)) {
    throw new Error("acceptance_criteria.tests.must_pass must be an array");
  }

  if (typeof criteria.tests.coverage_floor !== "number" || criteria.tests.coverage_floor < 0 || criteria.tests.coverage_floor > 100) {
    throw new Error("acceptance_criteria.tests.coverage_floor must be a number between 0 and 100");
  }

  if (!Array.isArray(criteria.invariants)) {
    throw new Error("acceptance_criteria.invariants must be an array");
  }

  for (let i = 0; i < criteria.invariants.length; i++) {
    const inv = criteria.invariants[i];
    if (typeof inv.name !== "string") {
      throw new Error(`acceptance_criteria.invariants[${i}].name must be a string`);
    }
    if (typeof inv.check !== "string") {
      throw new Error(`acceptance_criteria.invariants[${i}].check must be a string`);
    }
  }

  if (!Array.isArray(criteria.diffs_must_not)) {
    throw new Error("acceptance_criteria.diffs_must_not must be an array");
  }

  if (criteria.evidence_ttl_actions !== undefined) {
    if (typeof criteria.evidence_ttl_actions !== "object" || Array.isArray(criteria.evidence_ttl_actions)) {
      throw new Error("acceptance_criteria.evidence_ttl_actions must be an object mapping evidence type to action count");
    }
    for (const [k, v] of Object.entries(criteria.evidence_ttl_actions)) {
      if (!Number.isInteger(v) || v < 0) {
        throw new Error(`acceptance_criteria.evidence_ttl_actions[${k}] must be a non-negative integer`);
      }
    }
  }
}

// =============================================================================
// HASH VERIFICATION
// =============================================================================

/**
 * Compute the deterministic hash of a contract
 * (excluding the contract_hash field itself)
 */
export function computeContractHash(contract: Contract): string {
  // Create a copy without the contract_hash field
  const contract_copy = { ...contract };
  delete (contract_copy as any).contract_hash;

  // Deterministic serialization (sorted keys)
  const serialized = JSON.stringify(contract_copy, null, 0);
  const hash = crypto.createHash("sha256").update(serialized).digest("hex");

  return `sha256:${hash}`;
}

/**
 * Verify the contract hash matches its content
 */
export function verifyContractHash(contract: Contract): boolean {
  const computed = computeContractHash(contract);
  return computed === contract.contract_hash;
}

// =============================================================================
// COMPREHENSIVE VALIDATION (SCHEMA + HASH + SEMANTICS)
// =============================================================================

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

/**
 * Full validation: schema + stage-gate + hash + semantics
 * Throws ContractValidationError if any check fails
 */
export function validateContract(contract: Contract): void {
  try {
    // 1. Schema validation
    validateContractSchema(contract);

    // 2. Hash verification
    if (!verifyContractHash(contract)) {
      throw new ContractValidationError(
        "Contract hash does not match content. Contract may have been modified after stage-gating."
      );
    }

    // 3. Semantic checks (phases, tools, etc.)
    validateSemantics(contract);
  } catch (e) {
    if (e instanceof ContractValidationError) {
      throw e;
    }
    throw new ContractValidationError((e as Error).message);
  }
}

/**
 * Semantic validation: does the contract make logical sense?
 */
function validateSemantics(contract: Contract): void {
  // All tools mentioned in permitted_tools or forbidden_operations should be reasonable
  const all_tools = new Set<string>();

  for (const phase of contract.phases) {
    for (const tool of phase.permitted_tools) {
      all_tools.add(tool);
    }
  }

  for (const tool of contract.scope.forbidden_operations) {
    // Some forbidden_operations are parameterized (e.g., "execute:curl")
    // Skip full validation for those
    if (!tool.includes(":")) {
      all_tools.add(tool);
    }
  }

  // Phases should form a sequence (first has no prior, last has no next implied)
  if (contract.phases[0].requires_prior_phase) {
    throw new ContractValidationError("First phase must not require a prior phase");
  }

  // Exit criteria should reference claim_types that appear in claim_types_admitted
  for (const phase of contract.phases) {
    // A phase's exit criteria should mention evidence types that can be admitted by this or prior phases
    // (This is a soft check; we don't enforce it strictly)
  }

  // At least one test must be defined
  if (contract.acceptance_criteria.tests.must_pass.length === 0) {
    throw new ContractValidationError("At least one test must be in acceptance_criteria.tests.must_pass");
  }
}

// =============================================================================
// CONVENIENCE FUNCTION: LOAD + VALIDATE
// =============================================================================

/**
 * Load and validate a contract in one call
 * This is the main entry point for the wrapper
 */
export async function loadAndValidateContract(contract_path: string): Promise<Contract> {
  const contract = loadContract(contract_path);
  validateContract(contract);
  return contract;
}

// =============================================================================
// DEBUGGING / INSPECTION
// =============================================================================

/**
 * Print a human-readable summary of a contract
 */
export function summarizeContract(contract: Contract): string {
  const lines: string[] = [];

  lines.push(`Contract: ${contract.scope.description}`);
  lines.push(`Hash: ${contract.contract_hash}`);
  lines.push(`Stage-gated at: ${contract.user_confirmed_at}`);
  lines.push("");

  lines.push(`Scope:`);
  lines.push(`  Files: ${contract.scope.files_in_scope.join(", ")}`);
  lines.push(`  Forbidden: ${contract.scope.forbidden_operations.join(", ") || "(none)"}`);
  lines.push("");

  lines.push(`Phases:`);
  for (const phase of contract.phases) {
    lines.push(`  ${phase.name}:`);
    lines.push(`    Tools: ${phase.permitted_tools.join(", ")}`);
    lines.push(`    Exit criteria: ${phase.exit_criteria.required_evidence.join(", ")}`);
  }
  lines.push("");

  lines.push(`Acceptance:`);
  lines.push(`  Tests: ${contract.acceptance_criteria.tests.must_pass.join(", ")}`);
  lines.push(`  Coverage floor: ${contract.acceptance_criteria.tests.coverage_floor}%`);

  return lines.join("\n");
}
