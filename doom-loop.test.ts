/**
 * Doom-loop e2e: a stuck agent repeating the identical tool call must be
 * cut off by the circuit breaker — not by burning shadow executions until
 * max_actions, and never by hanging.
 *
 * Uses node-mock-opencode.js "repeat" mode (re-emits the same read_file
 * call for every tool result). Flow with doom_max_repeats=3:
 *   act_001 settle (REJECTED, no test runner) -> receipt
 *   act_002 settle (REJECTED) -> receipt
 *   act_003 breaker DENY (no receipt, no shadow work)
 *   act_004 breaker DENY
 *   counter hits max_actions -> throw (the coarse backstop)
 * Asserts: exactly 2 receipts (breaker stopped the waste), 2 doom DENYs
 * in the admission log, no leaked worktrees.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

import { settlementHarnessLoop } from "./settlement-supervisor";
import { readReceipts } from "./settlement-ledger";
import { initializeTestGitRepo } from "./worktree-manager";
import { createTestContract } from "./contract-fixture";

const MOCK_PATH = path.join(__dirname, "node-mock-opencode.js");

describe("doom-loop circuit breaker (e2e)", () => {
  let repo_path: string;
  let parent: string;

  beforeEach(async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), "doom-test-"));
    repo_path = path.join(parent, "repo");
    await initializeTestGitRepo(repo_path);
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("breaker-denies repeats and the session backstops on max_actions", async () => {
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

    await expect(
      settlementHarnessLoop(contract_path, repo_path, `node ${MOCK_PATH}`, {
        tool_call_timeout_ms: 1500,
        max_actions: 4,
        opencode_env: { MOCK_MODE: "repeat" }
      })
    ).rejects.toThrow(/max_actions/);

    // Only the first two identical actions did real work (both REJECTED —
    // no test runner in the temp repo). The breaker stopped settlement
    // work for every repeat after that.
    const receipts = readReceipts(path.join(repo_path, ".settlement", "receipts", "receipts.jsonl"));
    expect(receipts).toHaveLength(2);

    const admission_raw = fs.readFileSync(path.join(repo_path, ".settlement", "logs", "admission.jsonl"), "utf-8");
    const admission_lines = admission_raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    expect(admission_lines).toHaveLength(4);
    const doom_denies = admission_lines.filter((l) => String(l.decision?.reason || "").includes("Doom-loop circuit breaker"));
    expect(doom_denies).toHaveLength(2);
    expect(doom_denies[0].action_id).toBe("act_003");

    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repo_path }).toString().trim().split("\n");
    expect(worktrees).toHaveLength(1);
  }, 30000);
});
