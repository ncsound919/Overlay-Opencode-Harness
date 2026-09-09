/**
 * Contract Fixture: generate valid stage-gated test contracts.
 *
 * Auto-computes contract_hash so callers never have to. Supports partial
 * overrides for testing variations, matching the pattern described in
 * STAGE1_README.md ("createTestContract(overrides)").
 */

import { Contract, computeContractHash } from "./contract-loader";

export interface ContractOverrides {
  version?: number;
  created_at?: string;
  user_confirmed_at?: string;
  _read_only?: boolean;
  scope?: Contract["scope"];
  phases?: Contract["phases"];
  acceptance_criteria?: Contract["acceptance_criteria"];
}

/**
 * Build a valid, stage-gated, hash-correct Contract. Pass overrides to
 * mutate any top-level field before the hash is computed — the hash
 * always reflects whatever you passed in, so `createTestContract({...})`
 * never produces a contract that fails verifyContractHash().
 */
export function createTestContract(overrides: ContractOverrides = {}): Contract {
  const base: Omit<Contract, "contract_hash"> = {
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    user_confirmed_at: "2026-01-01T00:05:00.000Z",
    _read_only: true,
    scope: {
      description: "Test contract",
      files_in_scope: ["src/payment.ts", "tests/payment.test.ts"],
      forbidden_operations: [],
      invariants: []
    },
    phases: [
      {
        name: "diagnostic",
        description: "Understand current structure, no writes",
        permitted_tools: ["read_file", "grep", "list_files"],
        claim_types_admitted: ["analysis"],
        exit_criteria: { required_evidence: ["codebase_structure_doc"] }
      },
      {
        name: "edit",
        description: "Make the actual changes",
        permitted_tools: ["write_file", "run_test"],
        claim_types_admitted: ["refactor_claim", "test_claim"],
        requires_prior_phase: "diagnostic",
        exit_criteria: { required_evidence: ["all_tests_pass"] }
      },
      {
        name: "verify",
        description: "Final review",
        permitted_tools: ["read_file", "run_test"],
        claim_types_admitted: ["verification"],
        requires_prior_phase: "edit",
        exit_criteria: { required_evidence: ["integration_tests_pass"] }
      }
    ],
    acceptance_criteria: {
      tests: { path: "tests/payment.test.ts", must_pass: ["basic"], coverage_floor: 0 },
      invariants: [],
      diffs_must_not: []
    },
    ...overrides
  };

  const hash = computeContractHash(base as Contract);
  return { ...base, contract_hash: hash };
}

/**
 * Build a Contract with an intentionally wrong contract_hash, for testing
 * hash-mismatch rejection paths. Any valid contract's hash will do as the
 * "wrong" value since we just need it to not match `base`'s real hash.
 */
export function createTamperedContract(overrides: ContractOverrides = {}): Contract {
  const contract = createTestContract(overrides);
  return { ...contract, contract_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
}
