/**
 * End-to-end tests: settlementHarnessLoop against a real git repo and the
 * node mock OpenCode subprocess. Matches settlement-build-roadmap.md's
 * Stage 7.2 spec.
 *
 * IMPORTANT: node-mock-opencode.js's "single_call" mode (the default)
 * emits exactly one tool call and then sits waiting on stdin — it never
 * exits on its own (see its docstring: "emit one valid tool call, then
 * wait for a result"). It only exits once its stdin hits EOF, which
 * happens when settlementHarnessLoop terminates the process at the end of
 * the loop, or when the loop's own tool_call_timeout_ms elapses on the
 * *second* readToolCall and the loop breaks out. Every test below passes
 * a short tool_call_timeout_ms so that second-iteration timeout is fast
 * rather than the 30s production default.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

import { settlementHarnessLoop } from "./settlement-supervisor";
import { readReceipts } from "./settlement-ledger";
import { initializeTestGitRepo } from "./worktree-manager";
import { createTestContract, ContractOverrides } from "./contract-fixture";
import { Contract } from "./contract-loader";

const MOCK_PATH = path.join(__dirname, "node-mock-opencode.js");
const FAST_TIMEOUT = { tool_call_timeout_ms: 1500 };

function writeContract(
  repo_path: string,
  overrides: ContractOverrides = {}
): { contract: Contract; contract_path: string } {
  const contract = createTestContract(overrides);
  const contract_path = path.join(repo_path, "contract.json");
  fs.writeFileSync(contract_path, JSON.stringify(contract, null, 2), "utf-8");
  return { contract, contract_path };
}

const SINGLE_PHASE_DIAGNOSTIC: NonNullable<ContractOverrides["phases"]> = [
  {
    name: "diagnostic",
    description: "read-only",
    permitted_tools: ["read_file", "grep", "list_files"],
    claim_types_admitted: ["analysis"],
    exit_criteria: { required_evidence: ["analysis"] }
  }
];

describe("settlementHarnessLoop (e2e)", () => {
  let repo_path: string;

  beforeEach(async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-test-"));
    repo_path = path.join(parent, "repo");
    await initializeTestGitRepo(repo_path);
  });

  afterEach(() => {
    fs.rmSync(path.dirname(repo_path), { recursive: true, force: true });
  });

  it("completes a session and produces at least one receipt", async () => {
    // single_call mode's one read_file action settles (APPROVED or
    // REJECTED depending on probe outcome) and mints exactly one receipt.
    // The loop's second readToolCall then times out (mock is still
    // waiting on stdin) and the loop exits via max_actions / timeout.
    const { contract_path } = writeContract(repo_path, { phases: SINGLE_PHASE_DIAGNOSTIC });

    const result = await settlementHarnessLoop(contract_path, repo_path, `node ${MOCK_PATH}`, {
      ...FAST_TIMEOUT,
      max_actions: 2
    });

    expect(result.total_actions).toBeGreaterThan(0);

    const receipts = readReceipts(path.join(repo_path, ".settlement", "receipts", "receipts.jsonl"));
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts[0].action_id).toBe("act_001");
    expect(receipts[0].tool_name).toBe("read_file");
  });

  it("writes the pinned contract to .settlement/contracts/", async () => {
    const { contract_path, contract } = writeContract(repo_path, { phases: SINGLE_PHASE_DIAGNOSTIC });
    await settlementHarnessLoop(contract_path, repo_path, `node ${MOCK_PATH}`, { ...FAST_TIMEOUT, max_actions: 2 });

    const pinned_path = path.join(repo_path, ".settlement", "contracts", "contract.pinned.json");
    expect(fs.existsSync(pinned_path)).toBe(true);
    const pinned = JSON.parse(fs.readFileSync(pinned_path, "utf-8"));
    expect(pinned.contract_hash).toBe(contract.contract_hash);
  });

  it("logs every admission decision", async () => {
    const { contract_path } = writeContract(repo_path, { phases: SINGLE_PHASE_DIAGNOSTIC });

    await settlementHarnessLoop(contract_path, repo_path, `node ${MOCK_PATH}`, { ...FAST_TIMEOUT, max_actions: 2 });

    const admission_path = path.join(repo_path, ".settlement", "logs", "admission.jsonl");
    expect(fs.existsSync(admission_path)).toBe(true);
    const lines = fs
      .readFileSync(admission_path, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]);
    expect(entry.action_id).toBe("act_001");
    expect(entry.tool_name).toBe("read_file");
  });

  it("never promotes files for a read-only tool call, regardless of scope", async () => {
    // read_file isn't a write tool, so admission-gate.ts's scope check
    // (checkFileScopeForOperation) doesn't restrict it — this test
    // confirms that a read-only settled action still never appears in
    // files_promoted, independent of what's in scope.
    const { contract_path } = writeContract(repo_path, {
      scope: {
        description: "Deliberately excludes src/",
        files_in_scope: ["docs/**"],
        forbidden_operations: [],
        invariants: []
      },
      phases: SINGLE_PHASE_DIAGNOSTIC
    });

    const result = await settlementHarnessLoop(contract_path, repo_path, `node ${MOCK_PATH}`, {
      ...FAST_TIMEOUT,
      max_actions: 2
    });
    const receipts = readReceipts(path.join(repo_path, ".settlement", "receipts", "receipts.jsonl"));
    expect(receipts.every((r) => r.files_promoted.length === 0)).toBe(true);
    expect(result.denied).toBe(0);
  });

  it("cleans up all worktrees after the session ends", async () => {
    const { contract_path } = writeContract(repo_path, { phases: SINGLE_PHASE_DIAGNOSTIC });
    await settlementHarnessLoop(contract_path, repo_path, `node ${MOCK_PATH}`, { ...FAST_TIMEOUT, max_actions: 2 });

    const output = execFileSync("git", ["worktree", "list"], { cwd: repo_path }).toString();
    const worktree_lines = output.trim().split("\n");
    // Only the main working tree should remain.
    expect(worktree_lines).toHaveLength(1);
  });

  it("terminates via tool_call_timeout_ms when the phase can never exit", async () => {
    // Required evidence type is never emitted by any tool, so the phase
    // can never auto-transition. The mock still only emits one action
    // (single_call), then sits waiting; the loop's second readToolCall
    // times out and the loop exits with the phase still open, not hung.
    const { contract_path } = writeContract(repo_path, {
      phases: [
        {
          name: "diagnostic",
          description: "read-only",
          permitted_tools: ["read_file"],
          claim_types_admitted: ["analysis"],
          exit_criteria: { required_evidence: ["never_satisfied_evidence_type"] }
        }
      ]
    });

    const start = Date.now();
    const result = await settlementHarnessLoop(contract_path, repo_path, `node ${MOCK_PATH}`, {
      ...FAST_TIMEOUT,
      max_actions: 5
    });
    const elapsed = Date.now() - start;

    expect(result.final_phase).toBe("diagnostic");
    expect(result.total_actions).toBeGreaterThan(0);
    // Should terminate close to the timeout, not hang for the production
    // 30s default.
    expect(elapsed).toBeLessThan(10000);
  });

  it("throws if the contract is not stage-gated", async () => {
    const contract = createTestContract({ user_confirmed_at: undefined as unknown as string });
    const contract_path = path.join(repo_path, "contract.json");
    fs.writeFileSync(contract_path, JSON.stringify(contract, null, 2), "utf-8");

    await expect(
      settlementHarnessLoop(contract_path, repo_path, `node ${MOCK_PATH}`, FAST_TIMEOUT)
    ).rejects.toThrow();
  });

  it("denies a tool call that is not in the current phase's permitted_tools", async () => {
    // The mock's diagnostic-phase call is always read_file; if the
    // contract's diagnostic phase doesn't permit it, admission must DENY
    // and no receipt should be minted for that action.
    const { contract_path } = writeContract(repo_path, {
      phases: [
        {
          name: "diagnostic",
          description: "read-only, but read_file isn't allowed",
          permitted_tools: ["grep", "list_files"],
          claim_types_admitted: ["analysis"],
          exit_criteria: { required_evidence: ["analysis"] }
        }
      ]
    });

    const result = await settlementHarnessLoop(contract_path, repo_path, `node ${MOCK_PATH}`, {
      ...FAST_TIMEOUT,
      max_actions: 2
    });

    expect(result.denied).toBeGreaterThan(0);
    const receipts = readReceipts(path.join(repo_path, ".settlement", "receipts", "receipts.jsonl"));
    expect(receipts).toHaveLength(0);
  });
});
