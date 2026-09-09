/**
 * Tests for opencode-adapter.js.
 *
 * Part 1 (unit): prompt builders, output parsing, session-ID capture, and
 * the direct-tool-use backstop — all pure functions, no subprocesses.
 *
 * Part 2 (integration): the adapter subprocess driven over its NDJSON
 * protocol with stub-opencode.js as a deterministic fake `opencode` binary,
 * so no test needs a live LLM call or credentials.
 *
 * Part 3 (harness e2e): settlementHarnessLoop end-to-end with the adapter +
 * stub in the loop, proving the adapter speaks the harness protocol.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, ChildProcess } from "child_process";
import { execFileSync } from "child_process";

const adapter = require("./opencode-adapter");
import { createTestContract } from "./contract-fixture";
import { settlementHarnessLoop } from "./settlement-supervisor";
import { readReceipts } from "./settlement-ledger";
import { initializeTestGitRepo } from "./worktree-manager";

const ADAPTER_PATH = path.join(__dirname, "opencode-adapter.js");
const STUB_PATH = path.join(__dirname, "stub-opencode.js");

function testState() {
  const contract = createTestContract();
  return {
    contract,
    current_phase: contract.phases[0],
    receipts_so_far: [],
    missing_evidence: ["codebase_structure_doc"],
    autonomy_class: "learner",
    last_rejection: null
  };
}

// =============================================================================
// PART 1: UNIT
// =============================================================================

describe("opencode-adapter pure functions", () => {
  describe("extractToolCall", () => {
    const call = { tool: "read_file", input: { path: "src/payment.ts" }, claim: "test" };

    it("parses the @@TOOLCALL@@ marked block", () => {
      const text = `Reasoning here.\n${adapter.MARK_START}\n${JSON.stringify(call)}\n${adapter.MARK_END}\nDone.`;
      expect(adapter.extractToolCall(text)).toEqual(call);
    });

    it("parses fenced json blocks", () => {
      expect(adapter.extractToolCall("```json\n" + JSON.stringify(call) + "\n```")).toEqual(call);
    });

    it("parses a raw whole-text JSON object", () => {
      expect(adapter.extractToolCall(JSON.stringify(call))).toEqual(call);
    });

    it("scans embedded objects out of surrounding prose", () => {
      const text = `I propose ${JSON.stringify(call)} for this iteration, thanks.`;
      expect(adapter.extractToolCall(text)).toEqual(call);
    });

    it("returns null for garbage with no tool call", () => {
      expect(adapter.extractToolCall("Hmm, thinking... no proposal.")).toBeNull();
      expect(adapter.extractToolCall("")).toBeNull();
      expect(adapter.extractToolCall(null)).toBeNull();
    });

    it("rejects wrong shapes", () => {
      expect(adapter.extractToolCall('{"foo": 1}')).toBeNull();
      expect(adapter.extractToolCall('[1,2]')).toBeNull();
      // Missing input defaults to {} rather than failing.
      expect(adapter.extractToolCall('{"tool": "grep"}')).toEqual({ tool: "grep", input: {}, claim: undefined });
    });

    it("prefers the marked block over other JSON in the text", () => {
      const decoy = { tool: "delete_file", input: { path: "everything" } };
      const text = `${JSON.stringify(decoy)}\n${adapter.MARK_START}\n${JSON.stringify(call)}\n${adapter.MARK_END}`;
      expect(adapter.extractToolCall(text)).toEqual(call);
    });
  });

  describe("findSessionId", () => {
    it("finds sessionID nested in events", () => {
      expect(adapter.findSessionId([{ type: "x" }, { session: { sessionID: "abc" } }])).toBe("abc");
    });

    it("accepts snake_case session_id", () => {
      expect(adapter.findSessionId({ session_id: "s1" })).toBe("s1");
    });

    it("returns null when absent", () => {
      expect(adapter.findSessionId([{ type: "text", text: "hi" }])).toBeNull();
    });
  });

  describe("detectDirectToolUse", () => {
    it("flags executed known tools", () => {
      expect(
        adapter.detectDirectToolUse([{ type: "tool.execute", tool: "read", state: "completed", input: {} }])
      ).toEqual(["read"]);
    });

    it("ignores free-text mentions of tools", () => {
      expect(adapter.detectDirectToolUse([{ type: "text", text: "I used the read tool" }])).toEqual([]);
    });

    it("ignores unknown tool names", () => {
      expect(adapter.detectDirectToolUse([{ tool: "frobnicate", state: "completed" }])).toEqual([]);
    });

    it("requires execution evidence, not just a name", () => {
      expect(adapter.detectDirectToolUse([{ tool: "bash" }])).toEqual([]);
    });

    it("finds nested tool calls", () => {
      expect(adapter.detectDirectToolUse({ a: { b: { toolName: "bash", status: "ok" } } })).toEqual(["bash"]);
    });
  });

  describe("prompts", () => {
    it("initial prompt carries phase, tools, evidence and lockdown rules", () => {
      const p = adapter.buildInitialPrompt(testState());
      expect(p).toContain("diagnostic");
      expect(p).toContain("read_file");
      expect(p).toContain("codebase_structure_doc");
      expect(p).toContain(adapter.MARK_START);
      expect(p).toContain("cannot act directly");
    });

    it("followup prompt surfaces rejections as hard constraints", () => {
      const p = adapter.buildFollowupPrompt(
        testState(),
        { name: "diagnostic" },
        {
          tool: "write_file",
          claim: "x",
          result: { status: "ADMISSION_DENIED", reason: "not permitted here" }
        },
        [],
        20
      );
      expect(p).toContain("not permitted here");
      expect(p).toContain("hard constraint");
    });

    it("followup prompt carries phase transitions", () => {
      const p = adapter.buildFollowupPrompt(
        testState(),
        { name: "edit" },
        { tool: "read_file", claim: "c", result: { status: "SETTLED", phase_transitioned_to: "edit" } },
        [],
        20
      );
      expect(p).toContain("edit");
    });
  });

  describe("findFatalError", () => {
    it("flags billing/credit errors", () => {
      expect(
        adapter.findFatalError([{ type: "error", error: { type: "CreditsError", message: "Insufficient balance" } }])
      ).toContain("Insufficient balance");
    });

    it("flags auth errors", () => {
      expect(adapter.findFatalError([{ type: "error", error: { code: 401, message: "Unauthorized" } }])).toContain(
        "Unauthorized"
      );
    });

    it("ignores ordinary events and non-fatal errors", () => {
      expect(adapter.findFatalError([{ type: "text", text: "hi" }])).toBeNull();
      expect(adapter.findFatalError([{ type: "error", error: { type: "Timeout", message: "slow" } }])).toBeNull();
      expect(adapter.findFatalError([])).toBeNull();
    });
  });

  describe("parseArgs", () => {
    it("requires --repo", () => {
      expect(() => adapter.parseArgs([])).toThrow(/--repo/);
      expect(adapter.parseArgs(["--repo", "r"]).repo).toBe("r");
    });
  });

  describe("resolveWindowsShim", () => {    it("returns null for non-shim commands", () => {
      expect(adapter.resolveWindowsShim("node")).toBeNull();
      expect(adapter.resolveWindowsShim("opencode")).toBeNull();
    });

    it("resolves the npm .cmd shim to node+launcher on win32", () => {
      if (process.platform !== "win32") return; // nothing to resolve on unix
      const r = adapter.resolveWindowsShim("opencode.cmd");
      expect(r).not.toBeNull();
      expect(r!.command).toBe("node");
      expect(r!.prefixArgs[0]).toMatch(/bin[\\/]opencode$/);
      expect(fs.existsSync(r!.prefixArgs[0])).toBe(true);
    });
  });
});

// =============================================================================
  describe("buildChildEnv", () => {
    it("strips inherited server/session vars that cause 'Session not found'", () => {
      // Upstream #8502/#24204/#28407: a child `opencode run` inherits
      // OPENCODE_SERVER_PASSWORD from a parent session, its in-process
      // server demands auth its SDK client never sends, and every call
      // dies with "Error: Session not found". Simulate that inheritance
      // via an explicit base (in-test process.env mutation is invisible
      // to children under jest, so buildChildEnv reads process.env —
      // set it through a local override instead).
      const saved: Record<string, string | undefined> = {};
      for (const k of adapter.STRIPPED_SERVER_ENV) {
        saved[k] = process.env[k];
        process.env[k] = "inherited-secret";
      }
      try {
        const env = adapter.buildChildEnv("C:\\fake\\opencode.db");
        for (const k of adapter.STRIPPED_SERVER_ENV) {
          expect(k in env).toBe(false);
        }
        expect(env.OPENCODE_DB).toBe("C:\\fake\\opencode.db");
        expect(JSON.parse(env.OPENCODE_PERMISSION).edit).toBe("deny");
        expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });

// PART 2: ADAPTER SUBPROCESS INTEGRATION (stub binary, no LLM)
// =============================================================================

interface AdapterHarness {
  child: ChildProcess;
  sendLine: (line: string) => void;
  readLine: (timeoutMs?: number) => Promise<string | null>;
  exitCode: () => Promise<number | null>;
  close: () => Promise<number | null>;
}

function spawnAdapter(repo: string, extraArgs: string[], env: Record<string, string>): AdapterHarness {
  const child = spawn("node", [ADAPTER_PATH, "--repo", repo, ...extraArgs], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buf = "";
  const waiters: Array<(l: string | null) => void> = [];
  const lines: string[] = [];
  let exited = false;
  let code: number | null = null;

  child.stdout!.setEncoding("utf-8");
  child.stdout!.on("data", (c: string) => {
    buf += c;
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  child.on("exit", (c) => {
    exited = true;
    code = c;
    while (waiters.length > 0) waiters.shift()!(null);
  });

  return {
    child,
    sendLine: (line: string) => {
      child.stdin!.write(line + "\n", "utf-8");
    },
    readLine: (timeoutMs = 15000) => {
      if (lines.length > 0) return Promise.resolve(lines.shift()!);
      if (exited) return Promise.resolve(null);
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          const i = waiters.indexOf(wrapped);
          if (i !== -1) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        const wrapped = (l: string | null) => {
          clearTimeout(t);
          resolve(l);
        };
        waiters.push(wrapped);
      });
    },
    exitCode: () => {
      if (exited) return Promise.resolve(code);
      return new Promise((resolve) => child.on("exit", resolve));
    },
    close: () => {
      child.stdin!.end();
      if (exited) return Promise.resolve(code);
      return new Promise((resolve) => child.on("exit", resolve));
    }
  };
}

describe("opencode-adapter subprocess (stub binary)", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-test-"));
    repo = path.join(dir, "repo");
    fs.mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function stubEnv(overrides: Record<string, string> = {}) {
    const log = path.join(dir, `stub-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const count = path.join(dir, `count-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    return {
      OPENCODE_BIN: `node ${STUB_PATH}`,
      STUB_SCENARIO: "markers",
      STUB_TOOLCALL: JSON.stringify({ tool: "read_file", input: { path: "src/payment.ts" }, claim: "test" }),
      STUB_LOG: log,
      STUB_COUNT_FILE: count,
      ...overrides,
      _log: log,
      _count: count
    };
  }

  it("emits one NDJSON tool call per iteration and tracks session continuity", async () => {
    const env = stubEnv();
    const a = spawnAdapter(repo, [], env);
    try {
      a.sendLine(JSON.stringify(testState()));
      const line1 = await a.readLine();
      expect(line1).not.toBeNull();
      const call1 = JSON.parse(line1!);
      expect(call1.tool).toBe("read_file");
      expect(call1.input).toEqual({ path: "src/payment.ts" });
      expect(call1.action_id).toBe("act_001");

      // Answer with a settled result advertising the next phase; the
      // adapter must continue the SAME opencode session for iteration 2.
      a.sendLine(
        JSON.stringify({
          action_id: "act_001",
          status: "SETTLED",
          settlement: "APPROVED",
          phase_transitioned_to: "edit",
          next_phase: { name: "edit", permitted_tools: ["write_file", "run_test"] },
          phase_state: { current_phase_name: "edit", missing_evidence: ["all_tests_pass"], receipts_count: 1 }
        })
      );
      const line2 = await a.readLine();
      expect(line2).not.toBeNull();
      expect(JSON.parse(line2!).action_id).toBe("act_002");

      const logLines = fs.readFileSync(env._log, "utf-8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
      expect(logLines).toHaveLength(2);
      expect(logLines[0].session).toBeNull();
      expect(logLines[1].session).toBe("sess_stub_1");
      expect(logLines[1].messageTail).toContain("edit");
      // Lockdown: every invocation ran under deny-all permissions.
      for (const entry of logLines) {
        expect(entry.hasFormatJson).toBe(true);
        expect(entry.dir).toBe(repo);
        const perm = JSON.parse(entry.permission);
        expect(perm.edit).toBe("deny");
        expect(perm.bash).toBe("deny");
        expect(perm.read).toBe("deny");
        // Server-auth stripping: this very test process inherits
        // OPENCODE_SERVER_PASSWORD from the operator session; the stub
        // must never see it (else live runs die "Session not found").
        expect(entry.hasServerPassword).toBe(false);
        expect(entry.hasServerUsername).toBe(false);
      }
    } finally {
      await a.close();
    }
  });

  it("passes --agent through to opencode run invocations", async () => {
    const env = stubEnv();
    const a = spawnAdapter(repo, ["--agent", "settlement-proposer"], env);
    try {
      a.sendLine(JSON.stringify(testState()));
      expect(await a.readLine()).not.toBeNull();
      const logLines = fs.readFileSync(env._log, "utf-8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
      expect(logLines.length).toBeGreaterThanOrEqual(1);
      for (const entry of logLines) {
        expect(entry.agent).toBe("settlement-proposer");
      }
    } finally {
      await a.close();
    }
  });

  it("feeds ADMISSION_DENIED reasons back into the next prompt", async () => {    const env = stubEnv();
    const a = spawnAdapter(repo, [], env);
    try {
      a.sendLine(JSON.stringify(testState()));
      await a.readLine();
      a.sendLine(JSON.stringify({ action_id: "act_001", status: "ADMISSION_DENIED", reason: "Tool 'write_file' not permitted here" }));
      await a.readLine();
      const logLines = fs.readFileSync(env._log, "utf-8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
      expect(logLines[1].messageTail).toContain("not permitted here");
    } finally {
      await a.close();
    }
  });

  it("corrects direct tool use and then emits the clean call", async () => {
    const env = stubEnv({ STUB_SCENARIO: "direct-tool-then-clean" });
    const a = spawnAdapter(repo, ["--max-retries", "3"], env);
    try {
      a.sendLine(JSON.stringify(testState()));
      const line = await a.readLine();
      expect(line).not.toBeNull();
      expect(JSON.parse(line!).tool).toBe("read_file");
      const logLines = fs.readFileSync(env._log, "utf-8").split("\n").filter((l) => l.length > 0);
      // First attempt hit direct-tool-use, correction re-prompted in-session.
      expect(logLines.length).toBeGreaterThanOrEqual(2);
    } finally {
      await a.close();
    }
  });

  it("exits non-zero (stderr only) when output stays unparseable", async () => {
    const env = stubEnv({ STUB_SCENARIO: "garbage" });
    const a = spawnAdapter(repo, ["--max-retries", "1"], env);
    try {
      a.sendLine(JSON.stringify(testState()));
      const line = await a.readLine(20000);
      expect(line).toBeNull(); // never a tool call on stdout
      const code = await a.exitCode();
      expect(code).toBe(1);
    } finally {
      try {
        await a.close();
      } catch {
        // already exited
      }
    }
  });

  it("fails fast with exit 1 on immediate stdin EOF (no state to work from)", async () => {
    // EOF before any AgentReadState is a misconfiguration, not a graceful
    // end: the adapter must refuse to start rather than hallucinate.
    const a = spawnAdapter(repo, [], stubEnv());
    expect(await a.close()).toBe(1);
  });

  it("exits 0 on stdin EOF after iterations (graceful harness end)", async () => {
    const a = spawnAdapter(repo, [], stubEnv());
    a.sendLine(JSON.stringify(testState()));
    expect(await a.readLine()).not.toBeNull();
    // Harness terminated: close stdin, adapter must exit cleanly.
    expect(await a.close()).toBe(0);
  });

  it("fails fast without retrying on provider billing errors", async () => {
    const env = stubEnv({ STUB_SCENARIO: "provider-error" });
    const a = spawnAdapter(repo, ["--max-retries", "3"], env);
    try {
      a.sendLine(JSON.stringify(testState()));
      expect(await a.readLine(20000)).toBeNull();
      expect(await a.exitCode()).toBe(1);
      // Exactly one opencode invocation: billing errors are not retried.
      const invocations = fs.readFileSync(env._log, "utf-8").split("\n").filter((l) => l.length > 0);
      expect(invocations).toHaveLength(1);
    } finally {
      try {
        await a.close();
      } catch {
        // already exited
      }
    }
  });
});

// =============================================================================
// PART 3: HARNESS E2E (adapter + stub inside settlementHarnessLoop)
// =============================================================================

describe("settlementHarnessLoop via opencode-adapter (stubbed LLM)", () => {
  let parent: string;
  let repo_path: string;

  beforeEach(async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-e2e-"));
    repo_path = path.join(parent, "repo");
    await initializeTestGitRepo(repo_path);
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("drives a full harness session through the adapter", async () => {
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

    // Explicit child env (NOT process.env mutation): under jest on
    // Windows, in-process process.env assignments are visible in-test but
    // are NOT inherited by spawned children, so the stub config travels
    // via the harness's opencode_env option instead.
    const stubEnv = {
      OPENCODE_BIN: `node ${STUB_PATH}`,
      STUB_SCENARIO: "single-then-exit",
      STUB_TOOLCALL: JSON.stringify({ tool: "read_file", input: { path: "src/payment.ts" }, claim: "test" }),
      STUB_LOG: path.join(parent, "stub.jsonl"),
      STUB_COUNT_FILE: path.join(parent, "count.txt")
    };

    const result = await settlementHarnessLoop(
      contract_path,
      repo_path,
      `node ${ADAPTER_PATH} --repo ${repo_path} --max-retries 1`,
      { tool_call_timeout_ms: 15000, max_actions: 3, opencode_env: stubEnv }
    );

    // The stub's single read_file settles (REJECTED: the temp repo has no
    // test runner, so the required "basic" probe fails — fail-closed, as
    // designed); the stub then goes silent, the adapter exhausts its one
    // retry and exits 1, and the harness ends the session gracefully.
    expect(result.total_actions).toBeGreaterThan(0);
    const receipts = readReceipts(path.join(repo_path, ".settlement", "receipts", "receipts.jsonl"));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].tool_name).toBe("read_file");

    // Session continuity held across the live loop: the adapter's second
    // opencode invocation carried the captured session ID.
    const logLines = fs.readFileSync(stubEnv.STUB_LOG, "utf-8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    expect(logLines.length).toBeGreaterThanOrEqual(2);
    expect(logLines[1].session).toBe("sess_stub_1");

    // No worktrees leaked.
    const list = execFileSync("git", ["worktree", "list"], { cwd: repo_path }).toString().trim().split("\n");
    expect(list).toHaveLength(1);
  });
});
