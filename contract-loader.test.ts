/**
 * Tests for contract-loader.ts — schema, stage-gate, hash, file I/O.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  loadContract,
  validateContract,
  validateContractSchema,
  computeContractHash,
  verifyContractHash,
  loadAndValidateContract,
  summarizeContract,
  ContractValidationError,
  Contract
} from "./contract-loader";
import { createTestContract, createTamperedContract } from "./contract-fixture";

describe("contract-loader", () => {
  describe("valid contracts", () => {
    it("accepts a valid stage-gated contract", () => {
      expect(() => validateContract(createTestContract())).not.toThrow();
    });

    it("computes a hash that verifies", () => {
      const c = createTestContract();
      expect(verifyContractHash(c)).toBe(true);
      expect(c.contract_hash.startsWith("sha256:")).toBe(true);
    });

    it("hash is deterministic for the same content", () => {
      const a = createTestContract();
      const b = createTestContract();
      expect(a.contract_hash).toBe(b.contract_hash);
    });

    it("any content change invalidates the hash", () => {
      const c = createTestContract();
      const mutated = { ...c, scope: { ...c.scope, description: "changed" } };
      expect(verifyContractHash(mutated as Contract)).toBe(false);
    });

    it("summarizeContract mentions phases and scope", () => {
      const summary = summarizeContract(createTestContract());
      expect(summary).toContain("diagnostic");
      expect(summary).toContain("src/payment.ts");
    });
  });

  describe("stage-gate enforcement (CRITICAL)", () => {
    it("REJECTS contract without user_confirmed_at", () => {
      const c = createTestContract({ user_confirmed_at: undefined as unknown as string });
      expect(() => validateContract(c)).toThrow(ContractValidationError);
    });

    it("REJECTS contract with _read_only: false", () => {
      // Build via fixture then flip the flag and re-hash so the failure
      // is the read-only check, not the hash check.
      const base = createTestContract({ _read_only: false });
      expect(() => validateContract(base)).toThrow(/read-only/);
    });

    it("REJECTS tampered hash", () => {
      expect(() => validateContract(createTamperedContract())).toThrow(/hash/i);
    });

    it("REJECTS non-1 version", () => {
      const c = createTestContract({ version: 2 });
      expect(() => validateContractSchema(c)).toThrow(/version/);
    });
  });

  describe("schema validation", () => {
    it("rejects empty files_in_scope", () => {
      const c = createTestContract({
        scope: { description: "x", files_in_scope: [], forbidden_operations: [], invariants: [] }
      });
      expect(() => validateContractSchema(c)).toThrow(/files_in_scope/);
    });

    it("rejects empty phases array", () => {
      const c = createTestContract({ phases: [] });
      expect(() => validateContractSchema(c)).toThrow(/at least one phase/);
    });

    it("rejects a phase with no permitted_tools", () => {
      const c = createTestContract({
        phases: [
          {
            name: "diagnostic",
            description: "x",
            permitted_tools: [],
            claim_types_admitted: ["analysis"],
            exit_criteria: { required_evidence: ["analysis"] }
          }
        ]
      });
      expect(() => validateContractSchema(c)).toThrow(/permitted_tools/);
    });

    it("rejects requires_prior_phase pointing at a missing phase", () => {
      const c = createTestContract({
        phases: [
          {
            name: "edit",
            description: "x",
            permitted_tools: ["write_file"],
            claim_types_admitted: ["refactor_claim"],
            requires_prior_phase: "nonexistent",
            exit_criteria: { required_evidence: ["all_tests_pass"] }
          }
        ]
      });
      expect(() => validateContractSchema(c)).toThrow(/does not exist/);
    });

    it("rejects coverage_floor outside 0-100", () => {
      const base = createTestContract();
      const c = createTestContract({
        acceptance_criteria: { ...base.acceptance_criteria, tests: { ...base.acceptance_criteria.tests, coverage_floor: 101 } }
      });
      expect(() => validateContractSchema(c)).toThrow(/coverage_floor/);
    });

    it("accepts a well-formed evidence_ttl_actions map", () => {
      const base = createTestContract();
      const c = createTestContract({
        acceptance_criteria: { ...base.acceptance_criteria, evidence_ttl_actions: { analysis: 10, test_pass: 0 } }
      });
      expect(() => validateContract(c)).not.toThrow();
    });

    it("rejects negative, fractional, or non-object evidence_ttl_actions", () => {
      const base = createTestContract();
      for (const bad of [{ analysis: -1 }, { analysis: 1.5 }, { analysis: "many" }]) {
        const c = createTestContract({
          acceptance_criteria: { ...base.acceptance_criteria, evidence_ttl_actions: bad as unknown as Record<string, number> }
        });
        expect(() => validateContractSchema(c)).toThrow(/evidence_ttl_actions/);
      }
    });

    it("rejects a first phase that requires a prior phase", () => {
      const c = createTestContract({
        phases: [
          {
            name: "diagnostic",
            description: "x",
            permitted_tools: ["read_file"],
            claim_types_admitted: ["analysis"],
            requires_prior_phase: "edit",
            exit_criteria: { required_evidence: ["analysis"] }
          },
          {
            name: "edit",
            description: "y",
            permitted_tools: ["write_file"],
            claim_types_admitted: ["refactor_claim"],
            exit_criteria: { required_evidence: ["all_tests_pass"] }
          }
        ]
      });
      expect(() => validateContract(c)).toThrow();
    });

    it("rejects empty must_pass (no acceptance signal)", () => {
      const base = createTestContract();
      const c = createTestContract({
        acceptance_criteria: { ...base.acceptance_criteria, tests: { ...base.acceptance_criteria.tests, must_pass: [] } }
      });
      expect(() => validateContract(c)).toThrow(/At least one test/);
    });
  });

  describe("file loading", () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "contract-loader-test-"));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("loads and validates a contract file round-trip", async () => {
      const c = createTestContract();
      const p = path.join(dir, "contract.json");
      fs.writeFileSync(p, JSON.stringify(c), "utf-8");
      await expect(loadAndValidateContract(p)).resolves.toMatchObject({ contract_hash: c.contract_hash });
    });

    it("throws if the contract file is missing", () => {
      expect(() => loadContract(path.join(dir, "nope.json"))).toThrow(/not found/);
    });

    it("throws on invalid JSON", () => {
      const p = path.join(dir, "bad.json");
      fs.writeFileSync(p, "{not json", "utf-8");
      expect(() => loadContract(p)).toThrow(/invalid/i);
    });

    it("loadAndValidateContract rejects a tampered file", async () => {
      const p = path.join(dir, "tampered.json");
      fs.writeFileSync(p, JSON.stringify(createTamperedContract()), "utf-8");
      await expect(loadAndValidateContract(p)).rejects.toThrow(ContractValidationError);
    });
  });
});
