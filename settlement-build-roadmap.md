# Settlement-Layer Harness: Build Roadmap (Phase 1)

## Goal

Implement the **admission gate + shadow execution + settlement receipts** loop that kills 60% of failure modes (constraint violation 38.33%, false self-reporting 22.58%).

**Total estimated lines:** ~1000 (admission gate ~200, shadow executor ~300, scorer ~150, OpenCode harness ~200, wrapper loop ~150).

---

## Stage 1: Foundation (Week 1)

### 1.1 Contract Loader & Validation
**Owner:** You (or LLM-assisted if you want compiler too)  
**Files:** `contract-loader.ts`  
**Lines:** ~100

**What it does:**
- Load contract.json from disk
- Validate schema (all phases present, exit criteria defined, etc.)
- Check `_read_only` flag and `user_confirmed_at` timestamp
- Return typed Contract object
- Raise error if contract not stage-gated

**API:**
```typescript
async function loadContract(contract_path: string): Promise<Contract>;
function validateContract(contract: Contract): void;
```

**Test:**
```typescript
it("rejects contract without user_confirmed_at", () => {
  const invalid = { ...validContract, user_confirmed_at: undefined };
  expect(() => validateContract(invalid)).toThrow();
});
```

**Integration:** Wrapper calls this first thing before initializing phase state.

---

### 1.2 Admission Gate (Core Logic)
**Owner:** You  
**Files:** `admission-gate.ts` (already created)  
**Lines:** ~200 (already done)

**Checklist:**
- [x] Six rules implemented
- [ ] Unit tests for each rule (path scope, autonomy class, phase gating, etc.)
- [ ] Helper functions exported for testing
- [ ] Phase state management (initializePhaseState, updatePhaseState)
- [ ] AgentReadState builder (buildAgentReadState)

**Test examples:**
```typescript
describe("Admission Gate", () => {
  it("permits read_file in diagnostic phase", () => {
    const decision = admitToolCall({
      contract,
      current_phase: contract.phases[0], // diagnostic
      autonomy_class: AutonomyClass.LEARNER,
      tool_name: "read_file",
      tool_input: { path: "src/payment.ts" },
      previous_phase_evidence: [],
      working_tree_root: "/test"
    });
    expect(decision.decision).toBe("PERMIT");
  });

  it("denies write_file in diagnostic phase", () => {
    const decision = admitToolCall({
      ...,
      tool_name: "write_file",
      ...
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.reason).toContain("not permitted");
  });

  it("quarantines write_file for learner autonomy", () => {
    const decision = admitToolCall({
      ...,
      autonomy_class: AutonomyClass.LEARNER,
      tool_name: "write_file",
      current_phase: contract.phases[1], // edit
      ...
    });
    expect(decision.decision).toBe("QUARANTINE");
    expect(decision.requires_shadow_execution).toBe(true);
  });

  it("rejects file outside scope", () => {
    const decision = admitToolCall({
      ...,
      tool_input: { path: "src/unrelated.ts" },
      ...
    });
    expect(decision.decision).toBe("DENY");
    expect(decision.reason).toContain("not in contract scope");
  });
});
```

**Deliverable:** Admission gate module with 90%+ test coverage.

---

### 1.3 Settlement Receipt Schema & Ledger
**Owner:** You  
**Files:** `settlement-ledger.ts`  
**Lines:** ~80

**What it does:**
- Define SettlementReceipt type
- Implement receipt logger (append-only .jsonl)
- Implement receipt reader (parse .jsonl, filter by action_id/phase/settlement)

**API:**
```typescript
interface SettlementReceipt {
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

function appendReceipt(ledger_path: string, receipt: SettlementReceipt): void;
function readReceipts(ledger_path: string): SettlementReceipt[];
function getReceiptsByPhase(ledger_path: string, phase: string): SettlementReceipt[];
function getApprovedReceipts(ledger_path: string): SettlementReceipt[];
```

**Test:**
```typescript
it("appends receipt and preserves order", () => {
  const r1 = { action_id: "act_001", ... };
  const r2 = { action_id: "act_002", ... };
  appendReceipt(ledger_path, r1);
  appendReceipt(ledger_path, r2);
  const receipts = readReceipts(ledger_path);
  expect(receipts).toHaveLength(2);
  expect(receipts[0].action_id).toBe("act_001");
});
```

**Integration:** Wrapper appends to ledger after every tool call settles.

---

## Stage 2: Shadow Execution (Week 2)

### 2.1 Git Worktree Manager
**Owner:** You  
**Files:** `worktree-manager.ts`  
**Lines:** ~120

**What it does:**
- Create temporary git worktree (`git worktree add /tmp/wt_NNN`)
- Clean up worktree on completion (`git worktree remove`)
- Extract diffs from worktree (`git diff HEAD`)
- Handle edge cases (missing .git, not a git repo, cleanup on error)

**API:**
```typescript
async function createWorktree(
  base_repo: string,
  worktree_id: string
): Promise<{ path: string; cleanup: () => Promise<void> }>;

async function getDiffsFromWorktree(
  worktree_path: string,
  base_path: string
): Promise<{ path: string; diff: string; content: string }[]>;

async function extractFilesFromWorktree(
  worktree_path: string,
  file_paths: string[]
): Promise<{ path: string; content: Buffer }[]>;
```

**Test:**
```typescript
it("creates and cleans up worktree", async () => {
  const repo = await initializeTestGitRepo("/tmp/test_repo");
  const wt = await createWorktree(repo, "test_wt_001");
  expect(fs.existsSync(wt.path)).toBe(true);
  await wt.cleanup();
  expect(fs.existsSync(wt.path)).toBe(false);
});

it("extracts diffs", async () => {
  // Create worktree, modify a file, extract diffs
  fs.writeFileSync(path.join(wt.path, "src/test.ts"), "new content");
  const diffs = await getDiffsFromWorktree(wt.path, repo);
  expect(diffs).toHaveLength(1);
  expect(diffs[0].path).toBe("src/test.ts");
  expect(diffs[0].diff).toContain("+new content");
});
```

**Integration:** Wrapper creates worktree before shadow execution, cleans up after scoring.

---

### 2.2 Tool Execution Harness
**Owner:** You  
**Files:** `tool-executor.ts`  
**Lines:** ~100

**What it does:**
- Execute a tool call in a worktree (file write, run test, run linter, etc.)
- Path rewriting (src/file.ts → /tmp/wt_001/src/file.ts)
- Capture stdout/stderr
- Return exit code

**API:**
```typescript
async function executeToolInWorktree(
  worktree_path: string,
  tool_name: string,
  tool_input: Record<string, unknown>,
  session_root: string
): Promise<{
  exit_code: number;
  stdout: string;
  stderr: string;
}>;
```

**Test:**
```typescript
it("rewrites paths correctly", async () => {
  const result = await executeToolInWorktree(
    "/tmp/wt_001",
    "write_file",
    { path: "src/test.ts", content: "console.log('test');" },
    "/session"
  );
  // Verify /tmp/wt_001/src/test.ts was written, not /session/src/test.ts
  expect(fs.readFileSync(path.join("/tmp/wt_001", "src/test.ts"), "utf-8")).toBe("console.log('test');");
});
```

**Integration:** Called by shadow executor.

---

### 2.3 Probe Runner
**Owner:** You  
**Files:** `probe-runner.ts`  
**Lines:** ~150

**What it does:**
- Run contract acceptance tests (pytest, jest, etc.)
- Run linter checks (eslint, etc.)
- Check invariants (regex, custom checks)
- Collect coverage metrics
- Return structured probe results

**API:**
```typescript
interface ProbeResult {
  probe_name: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

interface Coverage {
  total: number;
  covered: number;
  pct: number;
}

async function runContractProbes(
  contract: Contract,
  worktree_path: string,
  changed_files: string[]
): Promise<{
  probes: ProbeResult[];
  coverage: Coverage;
  invariants_satisfied: string[];
  invariants_violated: string[];
}>;
```

**Test:**
```typescript
it("runs tests and collects results", async () => {
  const result = await runContractProbes(contract, wt.path, ["src/test.ts"]);
  expect(result.probes.some(p => p.probe_name === "test:async_basic")).toBe(true);
  expect(result.probes.some(p => p.passed === false)).toBe(false); // all should pass in this test
});
```

**Integration:** Called by shadow executor after tool execution.

---

## Stage 3: Settlement Scoring (Week 2)

### 3.1 Settlement Scorer
**Owner:** You  
**Files:** `settlement-scorer.ts`  
**Lines:** ~80

**What it does:**
- Score shadow execution result against contract
- Check: all required tests pass, invariants satisfied, coverage floor met, no forbidden patterns
- Return: PASS or FAIL + evidence structure

**API:**
```typescript
interface SettlementEvidence {
  invariants_satisfied: string[];
  invariants_violated: string[];
  coverage: Coverage;
  test_results: { passed: number; failed: number; total: number };
  diffs_introduced: { added_lines: number; removed_lines: number; files: string[] };
  forbidden_patterns_found: boolean;
  verdict: "PASS" | "FAIL";
}

function scoreAgainstContract(
  contract: Contract,
  probes: ProbeResult[],
  coverage: Coverage,
  changed_files: { path: string; diff: string }[]
): SettlementEvidence;

function hashEvidence(evidence: SettlementEvidence): string;
```

**Test:**
```typescript
it("fails if coverage floor breached", () => {
  const evidence: SettlementEvidence = {
    coverage: { total: 100, covered: 80, pct: 80 }, // 80% < 85% floor
    probes: [{ passed: true }],
    invariants_violated: [],
    verdict: "FAIL"
  };
  expect(evidence.verdict).toBe("FAIL");
});

it("passes if all criteria met", () => {
  const evidence: SettlementEvidence = {
    coverage: { total: 100, covered: 86, pct: 86 },
    probes: [{ passed: true }],
    invariants_violated: [],
    verdict: "PASS"
  };
  expect(evidence.verdict).toBe("PASS");
});
```

**Integration:** Called by wrapper after shadow execution completes.

---

## Stage 4: OpenCode Harness (Week 3)

### 4.1 OpenCode Subprocess Manager
**Owner:** You  
**Files:** `opencode-harness.ts`  
**Lines:** ~150

**What it does:**
- Spawn OpenCode subprocess
- Pass AgentReadState (JSON on stdin or env)
- Read tool calls (JSON from stdout)
- Send tool results back (JSON on stdin)
- Handle subprocess lifecycle (spawn, poll, kill)

**API:**
```typescript
interface OpenCodeProcess {
  process: ChildProcess;
  id: string;
}

async function spawnOpenCode(
  executable: string,
  agent_read_state: AgentReadState
): Promise<OpenCodeProcess>;

async function readToolCall(
  ocp: OpenCodeProcess,
  timeout_ms?: number
): Promise<{ action_id: string; tool: string; input: Record<string, unknown>; claim?: string } | null>;

async function sendToolResult(
  ocp: OpenCodeProcess,
  result: any
): Promise<void>;

async function terminateOpenCode(ocp: OpenCodeProcess): Promise<void>;
```

**Communication Protocol:**

On startup, wrapper writes to OpenCode's stdin:
```json
{
  "__type": "agent_state",
  "contract": { ... },
  "current_phase": { ... },
  "receipts_so_far": [ ... ],
  "missing_evidence": [ ... ],
  "autonomy_class": "learner",
  "last_rejection": null
}
```

OpenCode emits on stdout (newline-delimited JSON):
```json
{"action_id":"act_001","tool":"read_file","input":{"path":"src/payment.ts"},"claim":"analyzing"}
```

Wrapper sends result on stdin:
```json
{
  "__type": "tool_result",
  "action_id": "act_001",
  "status": "SETTLED",
  "result": "...",
  "phase_state": { ... }
}
```

**Test:**
```typescript
it("spawns OpenCode and receives tool call", async () => {
  const ocp = await spawnOpenCode("./mock_opencode.sh", state);
  const tool_call = await readToolCall(ocp, 5000);
  expect(tool_call?.tool).toBe("read_file");
});
```

**Integration:** Wrapper uses this to run OpenCode iterations.

---

## Stage 5: Wrapper Loop (Week 3)

### 5.1 Settlement Supervisor
**Owner:** You  
**Files:** `settlement-supervisor.ts`  
**Lines:** ~200

**What it does:**
- Orchestrate the entire loop
- Initialize: load contract, init phase state, create settlement dir
- Per-iteration: build agent state → spawn/resume OpenCode → read tool call → admission gate → shadow exec → score → receipt → phase transition → send result
- Termination: check if phase_state.current_phase_name == "complete"

**Entry point:**
```typescript
async function settlementHarnessLoop(
  contract_path: string,
  working_tree_root: string,
  opencode_executable: string
): Promise<void>;
```

**Test:**
```typescript
it("completes a full session", async () => {
  // Create a test contract, mock OpenCode, run loop
  await settlementHarnessLoop(contract_path, repo_root, mock_opencode);
  
  // Check receipt ledger
  const receipts = readReceipts(path.join(repo_root, ".settlement/receipts/receipts.jsonl"));
  expect(receipts.length).toBeGreaterThan(0);
  expect(receipts[receipts.length - 1].settlement).toBe("APPROVED");
});
```

**Integration:** This is the main entry point. Wrapper loop drives the entire session.

---

## Stage 6: Test Rig (Week 3)

### 6.1 Mock OpenCode
**Owner:** You  
**Files:** `mock-opencode.ts` (or shell script)  
**Lines:** ~100

**What it does:**
- Emit a fixed sequence of tool calls (for testing)
- Read AgentReadState, adapt behavior (e.g., only write in edit phase)
- Exit gracefully

**Example sequence:**
1. Read contract.json (diagnostic phase)
2. Write analysis doc (should settle APPROVED)
3. Attempt to write code outside scope (should settle REJECTED)
4. Retry with correct scope (should settle APPROVED)
5. Run tests (should emit evidence_types: ["test_pass"])
6. Exit

**Integration:** Used for end-to-end testing before integrating real OpenCode.

---

### 6.2 Test Repository
**Owner:** You  
**Files:** `test-repos/simple-async-refactor/`

**Setup:**
- Initial src/payment.ts (synchronous code)
- tests/payment.test.ts (failing async tests)
- contract.json (refactor payment.ts with async, keep coverage above 80%)

**Expected session:**
1. Diagnostic: agent reads code, writes analysis
2. Edit: agent refactors, runs tests (may reject once if coverage drops)
3. Verify: agent confirms final tests pass
4. Complete: settlement done

**Measure:**
- Receipt count (expect 4-6)
- Settlement success rate (expect 80%+)
- Phase transitions (expect 3)
- Time (expect <30s with mocked probes)

---

## Stage 7: Integration (Week 4)

### 7.1 Wire Up Real OpenCode
**Owner:** You (coordination with OpenCode authors)  
**Files:** `opencode-integration.ts`

**Checklist:**
- [ ] OpenCode runs as subprocess
- [ ] OpenCode receives AgentReadState on startup
- [ ] OpenCode emits tool calls with action_id, tool, input, claim
- [ ] Wrapper sends results back, including rejection reasons
- [ ] OpenCode adapts to phase constraints (doesn't try write_file in diagnostic)
- [ ] OpenCode respects autonomy class (doesn't expect direct writes)

**Integration point:** Replace mock-opencode with real OpenCode binary.

---

### 7.2 End-to-End Test
**Owner:** You  
**Files:** `e2e.test.ts`

```typescript
describe("Settlement Harness E2E", () => {
  it("completes async refactor with mock OpenCode", async () => {
    await settlementHarnessLoop(
      "test-repos/simple-async-refactor/contract.json",
      "test-repos/simple-async-refactor",
      "node mock-opencode.js"
    );
    
    const receipts = readReceipts("test-repos/simple-async-refactor/.settlement/receipts/receipts.jsonl");
    expect(receipts.filter(r => r.settlement === "APPROVED").length).toBeGreaterThan(0);
  });

  it("rejects actions outside scope", async () => {
    // Create contract with tight scope
    // OpenCode tries to edit src/unrelated.ts
    // Expect ADMISSION_DENIED
  });

  it("enforces phase gating", async () => {
    // Start in diagnostic phase
    // OpenCode tries write_file
    // Expect QUARANTINE (shadow execution) or DENY depending on autonomy class
  });
});
```

---

## Build Checklist

**Stage 1 (Foundation):**
- [ ] contract-loader.ts (100 lines)
- [ ] admission-gate.ts (200 lines, ~done)
- [ ] settlement-ledger.ts (80 lines)
- [ ] Unit tests for all three (~200 lines)

**Stage 2 (Shadow):**
- [ ] worktree-manager.ts (120 lines)
- [ ] tool-executor.ts (100 lines)
- [ ] probe-runner.ts (150 lines)
- [ ] Integration tests (~150 lines)

**Stage 3 (Scoring):**
- [ ] settlement-scorer.ts (80 lines)
- [ ] Unit tests (~80 lines)

**Stage 4 (OpenCode):**
- [ ] opencode-harness.ts (150 lines)
- [ ] mock-opencode.ts (100 lines)
- [ ] Mock tests (~100 lines)

**Stage 5 (Wrapper):**
- [ ] settlement-supervisor.ts (200 lines)
- [ ] End-to-end tests (~150 lines)

**Stage 6 (Test Rig):**
- [ ] test-repos/simple-async-refactor (setup)
- [ ] Mock OpenCode behavior sequence

**Stage 7 (Integration):**
- [ ] Wire to real OpenCode
- [ ] E2E testing with real subprocess

**Total code:** ~1500 lines (core) + ~600 lines (tests) = ~2100 lines.

---

## Success Metrics

By end of Phase 1:

1. **Admission gate kills constraint violations:** Run a test where tool tries to violate contract; gate blocks it.
2. **Shadow execution is isolating:** Changes in worktree don't touch working tree until settled.
3. **Settlement receipts are complete:** Every action logged with evidence hash, clauses satisfied, probes run.
4. **Phase gating works:** Diagnostic phase rejects write_file; edit phase requires prior evidence.
5. **Wrapper loop terminates correctly:** Session completes when all phases are done.

---

## Next Immediate Step

**Start with Stage 1.1 (contract-loader).**

Implement:
```typescript
async function loadContract(path: string): Promise<Contract>;
function validateContract(c: Contract): void;
```

With tests:
```typescript
it("rejects contract without user_confirmed_at");
it("accepts valid stage-gated contract");
it("validates phase prerequisites");
```

Once this lands, move to Stage 1.2 (admission gate unit tests).

