/**
 * live-smoke.test.ts — OPT-IN live test against the real OpenCode CLI.
 *
 * Runs ONLY when LIVE_SMOKE=1 is set (it spends real API credits: up to
 * ~4 small LLM calls on the configured default model). The normal suite
 * always skips it.
 *
 * What it proves: settlementHarnessLoop drives a full iteration with live
 * model output flowing through the adapter (prompt -> opencode run ->
 * tool call -> admission -> shadow -> settlement -> result).
 *
 * What it does NOT assert: settlement outcomes (APPROVED/REJECTED/DENIED
 * depend on nondeterministic model output). It asserts the loop terminates
 * and leaves the expected settlement artifacts behind, and logs everything
 * for human inspection.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { settlementHarnessLoop } from "./settlement-supervisor";
import { readReceipts } from "./settlement-ledger";
import { initializeTestGitRepo } from "./worktree-manager";

const LIVE = process.env.LIVE_SMOKE === "1";
const ADAPTER_PATH = path.join(__dirname, "opencode-adapter.js");

(LIVE ? describe : describe.skip)("live opencode smoke (spends API credits)", () => {
  it(
    "drives a harness session with live model output",
    async () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "live-smoke-"));
      try {
        const repo_path = path.join(parent, "repo");
        await initializeTestGitRepo(repo_path);

        const { createTestContract } = require("./contract-fixture");
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

        // Provider selection: Phoenix Grove via Keywire (run-live-phoenix.js
        // supplies PHOENIX_* in real OS env) or the default opencode model.
        const { phoenixProviderFromEnv } = require("./live-provider");
        const phoenix = phoenixProviderFromEnv();
        console.log(`PROVIDER: ${phoenix.model ?? "(opencode default)"}`);

        let result: unknown = null;
        let thrown: unknown = null;
        const agent = process.env.SETTLEMENT_AGENT ? ` --agent ${process.env.SETTLEMENT_AGENT}` : "";
        try {
          result = await settlementHarnessLoop(
            contract_path,
            repo_path,
            `node ${ADAPTER_PATH} --repo ${repo_path} --max-retries 1 --timeout-ms 420000${agent}` +
              (phoenix.model ? ` --model ${phoenix.model}` : ""),
            { tool_call_timeout_ms: 480000, max_actions: 2, opencode_env: phoenix.env }
          );
        } catch (e) {
          thrown = e;
        }
        console.log("HARNESS_RESULT:" + JSON.stringify(result));
        if (thrown) console.log("HARNESS_THREW:" + String((thrown as Error).message || thrown).slice(0, 500));

        // Settlement artifacts must exist regardless of model behavior.
        const pinned = path.join(repo_path, ".settlement", "contracts", "contract.pinned.json");
        expect(fs.existsSync(pinned)).toBe(true);

        const receipts = readReceipts(path.join(repo_path, ".settlement", "receipts", "receipts.jsonl"));
        console.log("RECEIPTS:" + JSON.stringify(receipts, null, 2).slice(0, 4000));
        const admission_log = path.join(repo_path, ".settlement", "logs", "admission.jsonl");
        let admission_lines = 0;
        if (fs.existsSync(admission_log)) {
          const content = fs.readFileSync(admission_log, "utf-8");
          console.log("ADMISSION:" + content.slice(0, 4000));
          admission_lines = content.split("\n").filter((l) => l.length > 0).length;
        }

        // Participation assertion (deliberately NOT total_actions > 0:
        // the counter increments before the first read, so that would
        // pass vacuously even if the model never emitted). The model
        // participated iff the harness admitted (receipt) or denied
        // (admission log) at least one of its tool calls.
        expect(receipts.length + admission_lines).toBeGreaterThan(0);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    },
    540000
  );
});
