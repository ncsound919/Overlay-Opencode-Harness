# Settlement-Layer Harness: OpenCode Integration Map

## Overview

OpenCode is the agent subprocess. The settlement layer is the wrapper around it. This document maps:

1. **Where the wrapper intercepts OpenCode's lifecycle**
2. **How the contract artifact flows into OpenCode**
3. **How tool calls are routed through admission → shadow → settlement**
4. **Where receipts emit back into OpenCode's context**
5. **How worktree isolation works with OpenCode's file operations**

---

## 1. Architecture: Wrapper Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Wrapper Loop                               │
│  (settlement_harness.ts / settlement_supervisor.ts)                │
│                                                                     │
│  • Maintains contract state (frozen after stage-gate)              │
│  • Maintains phase state (diagnostic → edit → verify → complete)   │
│  • Maintains autonomy class (learner/supervised/autonomous)         │
│  • Maintains admission log (append-only .jsonl)                    │
│  • Maintains settlement receipts (append-only .jsonl)              │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ ITERATION N                                                 │  │
│  │                                                             │  │
│  │ 1. Build AgentReadState                                     │  │
│  │    - Current phase                                          │  │
│  │    - Receipts so far                                        │  │
│  │    - Missing evidence                                       │  │
│  │    - Autonomy class                                         │  │
│  │    - Last rejection (if any)                                │  │
│  │                                                             │  │
│  │ 2. Spawn/resume OpenCode subprocess                         │  │
│  │    └→ Pass AgentReadState via stdin or env                  │  │
│  │                                                             │  │
│  │ 3. Read OpenCode's next tool call                           │  │
│  │    ← Tool call (JSON on stdout)                             │  │
│  │                                                             │  │
│  │ 4. Admission gate (pure function)                           │  │
│  │    → Decision: PERMIT | DENY | QUARANTINE                  │  │
│  │    → Log admission decision                                 │  │
│  │                                                             │  │
│  │ 5a. DENY → Send rejection back to OpenCode, loop            │  │
│  │                                                             │  │
│  │ 5b. PERMIT or QUARANTINE → Shadow execution                 │  │
│  │    • Create git worktree in /tmp                            │  │
│  │    • Route tool call to worktree (file paths rewritten)     │  │
│  │    • Run probes in worktree                                 │  │
│  │    • Score against contract                                 │  │
│  │                                                             │  │
│  │ 6. Settlement decision                                       │  │
│  │    ✓ PASS → Mint receipt (APPROVED), promote diffs          │  │
│  │    ✗ FAIL → Mint receipt (REJECTED), send reason to agent   │  │
│  │                                                             │  │
│  │ 7. Update phase state                                       │  │
│  │    • Add receipt to evidence                                │  │
│  │    • Check phase exit criteria                              │  │
│  │    • Auto-transition if ready                               │  │
│  │                                                             │  │
│  │ 8. Check termination                                        │  │
│  │    ✓ phase_state.current_phase_name == "complete" → BREAK   │  │
│  │    ✗ else → loop to step 1                                  │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
             ▲
             │ (spawns/resumes)
             │
       ┌─────┴──────────────────────────────────────────────┐
       │                                                    │
       │        OpenCode Agent Subprocess                  │
       │  (remains stateless across iterations)            │
       │                                                    │
       │  • Receives AgentReadState on each iteration     │
       │  • Emits tool calls (JSON)                       │
       │  • Cannot write to disk directly                 │
       │  • Cannot read rejection reasons without wrapper  │
       │  • Cannot modify contract or phase state          │
       │                                                    │
       └────────────────────────────────────────────────────┘
```

---

## 2. Contract Artifact Flow

### Pre-Session: Contract Stage-Gate

1. **User writes intent** in natural language
   ```
   Add async/await to payment processor, don't touch legacy tests.
   Keep coverage above 85%.
   ```

2. **LLM compiler** (outside scope, but critical)
   ```
   user_intent.md → contract_compiler(intent) → contract.json
   ```

3. **Stage-gate UI** (critical UX)
   ```
   User sees: contract.json rendered as a checklist
   - Scope: src/payment.ts, tests/payment.test.ts
   - Forbidden: delete_file, modify tests/legacy/*
   - Phases: diagnostic, edit, verify
   - Exit criteria: all_tests_pass, coverage_maintained
   
   User confirms: [✓] I understand this contract
   → contract_hash = SHA256(contract.json)
   → user_confirmed_at = now()
   → contract._read_only = true
   → save to disk
   ```

4. **Wrapper loads contract at session start**
   ```typescript
   const contract = loadAndValidateContract("contract.json");
   if (!contract._read_only) {
     throw new Error("Contract must be stage-gated before session start");
   }
   ```

### Session: Contract is Read-Only

- Wrapper reads contract at startup
- Contract passed to admission gate (immutable)
- Contract passed to agent in AgentReadState (read-only for agent)
- Agent cannot modify contract.json
- Contract hash pins contract throughout session (auditable)

---

## 3. Tool Call Interception

### Where to Hook OpenCode

OpenCode likely has a point where it decides to execute a tool. The wrapper intercepts there.

**Scenario A: OpenCode emits JSON-RPC calls on stdout**
```
OpenCode subprocess writes to stdout:
{
  "action_id": "act_001",
  "tool": "read_file",
  "input": { "path": "src/payment.ts" }
}

Wrapper reads this, runs admission gate, sends back:
{
  "status": "ADMITTED",
  "decision": "PERMIT",
  ...
}

OpenCode resumes (maybe it polls stdin for the result).
```

**Scenario B: OpenCode is a library**

If OpenCode is imported as a library, we wrap its tool-execution function:

```typescript
// Original: const result = opencode.executeTool(tool_name, tool_input);

// Wrapped:
const admission = admitToolCall({
  contract,
  current_phase,
  autonomy_class,
  tool_name,
  tool_input,
  previous_phase_evidence: phase_state.evidence_collected,
  working_tree_root
});

if (admission.decision === 'DENY') {
  return { error: admission.reason };
}

const shadow_result = await executeInShadow({
  contract,
  tool_name,
  tool_input,
  working_tree_root
});

const receipt = await settlement.scoreAndEmitReceipt(
  shadow_result,
  tool_name,
  admission
);

phase_state = updatePhaseState(contract, phase_state, receipt);
```

**Assumption for this spec:** OpenCode is a subprocess, communication is JSON on stdout/stdin.

---

## 4. OpenCode Integration Points

### 4.1 Initialization

**Before** OpenCode starts, the wrapper:

1. Loads contract.json, validates it's stage-gated
2. Initializes phase state (start at first phase)
3. Sets autonomy class (default: "learner")
4. Creates directories:
   - `session_root/.settlement/contracts/` (stores frozen contract.json)
   - `session_root/.settlement/receipts/` (receipt ledger)
   - `session_root/.settlement/logs/` (admission logs, etc.)
5. Writes contract.json to `.settlement/contracts/contract.pinned.json` with hash

### 4.2 Per-Iteration: OpenCode Lifecycle

```
WRAPPER: Initialize phase state → "diagnostic"

ITERATION 1:
  WRAPPER: Build AgentReadState
    {
      contract: <frozen>,
      current_phase: { name: "diagnostic", permitted_tools: ["read_file", "grep", "list_files"], ... },
      receipts_so_far: [],
      missing_evidence: ["codebase_structure_doc"],
      autonomy_class: "learner",
      last_rejection: null
    }

  WRAPPER: Write AgentReadState to tmpfile
    $ echo '{"current_phase": "diagnostic", ...}' > /tmp/agent_state_001.json

  WRAPPER: Spawn OpenCode
    $ opencode --state=/tmp/agent_state_001.json --contract=/session/.settlement/contracts/contract.pinned.json

  OPENCODE (subprocess): Reads state, understands:
    - Can only use: read_file, grep, list_files (diagnostic tools)
    - Missing evidence: codebase_structure_doc
    - Autonomy class: learner (can't write)
    → Decides to run: grep -r "async" src/

  OPENCODE: Emits on stdout:
    {
      "action_id": "act_001",
      "tool": "grep",
      "input": { "pattern": "async", "path": "src/" },
      "claim": "analyzing_codebase"
    }

  WRAPPER: Reads OpenCode's tool call
    $ jq '.tool' < /tmp/opencode_out_001.json
    → "grep"

  WRAPPER: Admission gate
    admitToolCall({
      contract,
      current_phase: "diagnostic",
      autonomy_class: "learner",
      tool_name: "grep",
      tool_input: { pattern: "async", path: "src/" },
      previous_phase_evidence: [],
      working_tree_root: "/session"
    })
    → Decision: PERMIT (grep is in permitted_tools, no writes, no scope issues)

  WRAPPER: Log admission
    $ echo '{"timestamp": "...", "action_id": "act_001", "decision": {"decision": "PERMIT", ...}}' >> .settlement/logs/admission.jsonl

  WRAPPER: Shadow execution (even for read-only operations, for auditability)
    • Create /tmp/worktree_001
    • Clone working tree
    • Run: grep -r "async" /tmp/worktree_001/src/
    • Collect output
    • (No probes needed for grep, so settlement is immediate)

  WRAPPER: Mint receipt
    $ echo '{"action_id": "act_001", "timestamp": "...", "settlement": "APPROVED", "evidence_types": ["analysis"], ...}' >> .settlement/receipts/receipts.jsonl

  WRAPPER: Update phase state
    → Still in "diagnostic" phase (haven't emitted required evidence yet)

  WRAPPER: Send result back to OpenCode
    {
      "action_id": "act_001",
      "status": "SETTLED",
      "result": "async found in: payment.ts:12, payment.ts:45, ...",
      "receipt_id": "receipt_001"
    }

  OPENCODE: Processes result, updates internal state, decides next action

ITERATION 2:
  WRAPPER: Build AgentReadState (same phase, but one receipt collected)
  WRAPPER: Spawn/Resume OpenCode (or poll for next action if long-running)
  OPENCODE: Decides to write a diagnostic summary doc
    {
      "action_id": "act_002",
      "tool": "write_file",
      "input": { "path": ".settlement/agent_analysis.md", "content": "# Codebase Structure\n..." },
      "claim": "codebase_structure_doc"
    }

  WRAPPER: Admission gate
    admitToolCall({
      ...,
      tool_name: "write_file",
      tool_input: { path: ".settlement/agent_analysis.md", ... }
    })
    → Decision: QUARANTINE (write_file, learner autonomy class)
    → requires_shadow: true

  WRAPPER: Shadow execution
    • Create /tmp/worktree_002
    • Execute: write_file(path=".settlement/agent_analysis.md", content="...")
      (but in the worktree, so: /tmp/worktree_002/.settlement/agent_analysis.md)
    • Run acceptance tests (none defined for diagnostic phase, so skip)
    • Score: PASS (no tests to fail)

  WRAPPER: Mint receipt (APPROVED)
    $ echo '{"action_id": "act_002", ..., "settlement": "APPROVED", "evidence_types": ["codebase_structure_doc"], ...}' >> receipts.jsonl

  WRAPPER: **Promote diffs to working tree**
    • Copy /tmp/worktree_002/.settlement/agent_analysis.md → /session/.settlement/agent_analysis.md
    • (This is the ONLY way a write touches the working tree)

  WRAPPER: Update phase state
    → Required evidence for "diagnostic" phase is now ["codebase_structure_doc"]
    → checkPhaseExitCriteria returns can_exit: true
    → **AUTO-TRANSITION to "edit" phase**
    → current_phase_name = "edit"

  WRAPPER: Send result + phase transition info back to OpenCode
    {
      "action_id": "act_002",
      "status": "SETTLED",
      "receipt_id": "receipt_002",
      "phase_transitioned_to": "edit",
      "next_phase": {
        "name": "edit",
        "permitted_tools": ["write_file", "run_test", ...],
        "claim_types_admitted": ["refactor_claim", "test_claim"]
      }
    }

ITERATION 3 (Phase 2: Edit):
  WRAPPER: Build AgentReadState
    {
      current_phase: { name: "edit", permitted_tools: ["write_file", "run_test", ...], ... },
      receipts_so_far: [act_001, act_002],
      missing_evidence: ["all_tests_pass", "coverage_maintained"],
      ...
    }

  OPENCODE: Now understands it's in edit phase, can write code
    → Decides to refactor payment.ts with async/await
    {
      "action_id": "act_003",
      "tool": "write_file",
      "input": { "path": "src/payment.ts", "content": "async function processPayment(...) { ... }" },
      "claim": "refactor_claim"
    }

  WRAPPER: Admission gate
    → Decision: QUARANTINE (supervised: writes run in shadow)

  WRAPPER: Shadow execution
    • /tmp/worktree_003/src/payment.ts ← new refactored code
    • Run contract.acceptance_criteria.tests.must_pass: ["async_basic", "async_timeout"]
    • Probe results: async_basic ✓, async_timeout ✗
    • Coverage: 83% (below 85% floor)

  WRAPPER: Score: FAIL
    invariants_violated: ["timeout_guards", "coverage_floor"]

  WRAPPER: Mint receipt (REJECTED)
    $ echo '{"action_id": "act_003", ..., "settlement": "REJECTED", "rejection_reason": "Test async_timeout failed; coverage 83% < 85% floor", ...}' >> receipts.jsonl

  WRAPPER: **Do NOT promote diffs**
    • /tmp/worktree_003 is cleaned up
    • working_tree remains unchanged
    • src/payment.ts is still the old version

  WRAPPER: Send result back to OpenCode
    {
      "action_id": "act_003",
      "status": "SETTLEMENT_REJECTED",
      "receipt_id": "receipt_003",
      "rejection_reason": "Test async_timeout failed; coverage 83% < 85% floor",
      "failed_probes": ["test:async_timeout"],
      "metrics": { "coverage": 83, "floor": 85 }
    }

  OPENCODE: Sees rejection, must try a different refactor
    → Adds timeout guards, increases coverage
    {
      "action_id": "act_004",
      "tool": "write_file",
      "input": { "path": "src/payment.ts", "content": "async function processPayment(...) { setTimeout(...); ...}" },
      "claim": "refactor_claim"
    }

  WRAPPER: Admission gate → QUARANTINE
  WRAPPER: Shadow execution
    • Run probes
    • async_basic ✓, async_timeout ✓
    • Coverage: 86%
  WRAPPER: Score: PASS
  WRAPPER: Mint receipt (APPROVED)
  WRAPPER: **Promote diffs**
    • src/payment.ts is updated
  WRAPPER: Phase state: still in "edit" phase (need to emit "all_tests_pass" + "coverage_maintained")
    → receipt evidence_types: ["refactor_claim", "test_pass", "coverage_maintained"]
    → Now evidence has both required types → can exit phase

  WRAPPER: AUTO-TRANSITION to "verify" phase

ITERATION 4 (Phase 3: Verify):
  WRAPPER: Phase = "verify"
  WRAPPER: permitted_tools = ["read_file", "run_test"] (no more writes)
  OPENCODE: Runs final integration tests
  OPENCODE: Emits receipt with "integration_tests_pass"
  WRAPPER: Phase exit criteria met
  WRAPPER: AUTO-TRANSITION to "complete"

TERMINATION:
  WRAPPER: phase_state.current_phase_name == "complete"
  WRAPPER: Break out of loop
  WRAPPER: Print summary:
    [SETTLEMENT COMPLETE]
    Total actions: 4
    Approved: 3
    Rejected: 1
    Final contract clause satisfaction: 100%
    Session time: 2m 34s
```

---

## 5. Worktree Isolation

### How it works:

1. **Wrapper maintains a base working tree** at `/session/` (or wherever the user's code is)
2. **For each tool call that requires settlement**, wrapper creates a temporary git worktree
   ```bash
   git worktree add /tmp/worktree_NNN
   cd /tmp/worktree_NNN
   # Execute tool call here
   # Run probes here
   git diff HEAD > /tmp/worktree_NNN/diffs.patch
   ```

3. **Tool calls are path-rewritten to the worktree**
   ```
   Original:  write_file(path="src/payment.ts", content="...")
   Rewritten: write_file(path="/tmp/worktree_NNN/src/payment.ts", content="...")
   ```

4. **If settlement passes**, diffs are extracted and promoted
   ```bash
   cd /session/
   git apply < /tmp/worktree_NNN/diffs.patch
   ```

5. **If settlement fails**, worktree is deleted (diffs discarded)
   ```bash
   git worktree remove /tmp/worktree_NNN
   ```

### File path handling:

Agent never sees the worktree path. It thinks it's writing to `src/payment.ts`, but:

```typescript
function rewritePathForWorktree(
  original_path: string,
  worktree_root: string,
  session_root: string
): string {
  // "src/payment.ts" → "/tmp/worktree_001/src/payment.ts"
  const normalized = path.normalize(original_path);
  const is_absolute = path.isAbsolute(normalized);
  const final_path = is_absolute ? normalized : path.join(session_root, normalized);
  return final_path.replace(session_root, worktree_root);
}

// When intercepting tool calls:
const rewritten_input = {
  ...tool_input,
  path: rewritePathForWorktree(tool_input.path, worktree_root, session_root)
};

const result = await opencode.executeTool(tool_name, rewritten_input);
```

---

## 6. Receipt Emission

### Settlement Receipt Ledger

```
.settlement/receipts/receipts.jsonl (append-only, immutable)

{"action_id":"act_001","timestamp":"2026-09-08T14:35:42Z","phase":"diagnostic","tool_name":"grep","settlement":"APPROVED","evidence_hash":"sha256:abc...","evidence_types":["analysis"],"clauses_satisfied":[],"probes_run":[],"files_promoted":[]}
{"action_id":"act_002","timestamp":"2026-09-08T14:36:10Z","phase":"diagnostic","tool_name":"write_file","settlement":"APPROVED","evidence_hash":"sha256:def...","evidence_types":["codebase_structure_doc"],"clauses_satisfied":[],"probes_run":[],"files_promoted":[".settlement/agent_analysis.md"]}
{"action_id":"act_003","timestamp":"2026-09-08T14:36:45Z","phase":"edit","tool_name":"write_file","settlement":"REJECTED","evidence_hash":"sha256:ghi...","evidence_types":[],"clauses_satisfied":[],"probes_run":["test:async_timeout"],"files_promoted":[],"rejection_reason":"Test async_timeout failed"}
{"action_id":"act_004","timestamp":"2026-09-08T14:37:12Z","phase":"edit","tool_name":"write_file","settlement":"APPROVED","evidence_hash":"sha256:jkl...","evidence_types":["refactor_claim","test_pass","coverage_maintained"],"clauses_satisfied":["async_refactor"],"probes_run":["test:async_basic","test:async_timeout","invariant:coverage"],"files_promoted":["src/payment.ts"]}
```

### Admission Log

```
.settlement/logs/admission.jsonl (append-only, immutable)

{"timestamp":"2026-09-08T14:35:42Z","action_id":"act_001","tool_name":"grep","decision":{"decision":"PERMIT","reason":"All checks passed","settlement_required":false,"requires_shadow_execution":false},"input_summary":{"pattern":"async","path":"src/"}}
{"timestamp":"2026-09-08T14:36:10Z","action_id":"act_002","tool_name":"write_file","decision":{"decision":"QUARANTINE","reason":"Learner permit: writes run in shadow, require settlement","settlement_required":true,"requires_shadow_execution":true},"input_summary":{"path":".settlement/agent_analysis.md","content":"[string, 1234 chars]"}}
```

---

## 7. Agent Interface (What OpenCode Sees)

### Input: AgentReadState (per iteration)

```json
{
  "contract": {
    "version": 1,
    "contract_hash": "sha256:abc123...",
    "scope": {
      "description": "Add async/await to payment processor",
      "files_in_scope": ["src/payment.ts", "tests/payment.test.ts"],
      "forbidden_operations": ["delete_file", "modify tests/legacy/*"],
      "invariants": ["no_global_state_mutation", "all_async_functions_must_have_timeout", "test_coverage_must_not_decrease"]
    },
    "phases": [
      {
        "name": "diagnostic",
        "description": "Understand current structure, no writes",
        "permitted_tools": ["read_file", "list_files", "grep"],
        "claim_types_admitted": ["analysis", "diagnosis"],
        "exit_criteria": { "required_evidence": ["codebase_structure_doc"] }
      },
      {
        "name": "edit",
        "description": "Make the actual changes",
        "permitted_tools": ["write_file", "run_test", "run_linter"],
        "claim_types_admitted": ["refactor_claim", "test_claim"],
        "requires_prior_phase": "diagnostic",
        "exit_criteria": { "required_evidence": ["all_tests_pass", "coverage_maintained"] }
      },
      {
        "name": "verify",
        "description": "Final review",
        "permitted_tools": ["read_file", "run_test"],
        "claim_types_admitted": ["verification"],
        "requires_prior_phase": "edit",
        "exit_criteria": { "required_evidence": ["integration_tests_pass"] }
      }
    ],
    "acceptance_criteria": {
      "tests": { "path": "tests/payment.test.ts", "must_pass": ["async_basic", "async_timeout"], "coverage_floor": 85 },
      "invariants": [
        { "name": "no_global_mutation", "check": "eslint-rule:no-global-mutation" },
        { "name": "timeout_guards", "check": "regex:async\\s+function.*\\{[^}]*setTimeout" }
      ],
      "diffs_must_not": ["touch_deleted_files", "modify_unrelated_code"]
    }
  },
  "current_phase": {
    "name": "diagnostic",
    "description": "Understand current structure, no writes",
    "permitted_tools": ["read_file", "list_files", "grep"],
    "claim_types_admitted": ["analysis", "diagnosis"],
    "exit_criteria": { "required_evidence": ["codebase_structure_doc"] }
  },
  "receipts_so_far": [],
  "missing_evidence": ["codebase_structure_doc"],
  "autonomy_class": "learner",
  "last_rejection": null
}
```

### Output: ToolCall (OpenCode emits)

```json
{
  "action_id": "act_001",
  "tool": "grep",
  "input": { "pattern": "async", "path": "src/" },
  "claim": "analyzing_codebase"
}
```

### Input: ToolResult (wrapper sends back)

```json
{
  "action_id": "act_001",
  "status": "SETTLED",
  "result": "async found in: payment.ts:12, payment.ts:45, ...",
  "receipt_id": "receipt_001",
  "settlement": "APPROVED",
  "phase_state": {
    "current_phase_name": "diagnostic",
    "missing_evidence": ["codebase_structure_doc"],
    "receipts_count": 1
  }
}
```

Or on rejection:

```json
{
  "action_id": "act_003",
  "status": "SETTLEMENT_REJECTED",
  "receipt_id": "receipt_003",
  "settlement": "REJECTED",
  "rejection_reason": "Test async_timeout failed; coverage 83% < 85% floor",
  "failed_probes": ["test:async_timeout"],
  "metrics": {
    "tests": { "passed": 1, "failed": 1 },
    "coverage": 83,
    "coverage_floor": 85
  },
  "phase_state": {
    "current_phase_name": "edit",
    "missing_evidence": ["all_tests_pass", "coverage_maintained"],
    "receipts_count": 3
  }
}
```

---

## 8. Wrapper Entry Point (Pseudocode)

```typescript
// settlement_supervisor.ts

import { admitToolCall, buildAgentReadState, updatePhaseState, initializePhaseState } from "./admission-gate";
import { loadContract, stagegateContract } from "./contract-loader";
import { executeInShadow } from "./shadow-executor";
import { scoreAgainstContract } from "./settlement-scorer";
import { spawnOpenCode, resumeOpenCode, readToolCall, sendToolResult } from "./opencode-harness";

async function settlementHarnessLoop(
  contract_path: string,
  working_tree_root: string,
  opencode_executable: string
) {
  // 1. Load and stage-gate contract
  const contract = await loadContract(contract_path);
  if (!contract._read_only) {
    throw new Error("Contract must be stage-gated (user_confirmed_at must be set)");
  }

  // 2. Initialize settlement infrastructure
  const session_root = working_tree_root;
  const settlement_dir = path.join(session_root, ".settlement");
  fs.mkdirSync(path.join(settlement_dir, "contracts"), { recursive: true });
  fs.mkdirSync(path.join(settlement_dir, "receipts"), { recursive: true });
  fs.mkdirSync(path.join(settlement_dir, "logs"), { recursive: true });

  // Write frozen contract
  fs.writeFileSync(
    path.join(settlement_dir, "contracts", "contract.pinned.json"),
    JSON.stringify(contract, null, 2)
  );

  // 3. Initialize state
  let phase_state = initializePhaseState(contract);
  let autonomy_class = AutonomyClass.LEARNER;
  let last_rejection: any = null;
  let action_counter = 0;
  let opencode_process: ChildProcess | null = null;

  console.log(`[SETTLEMENT] Starting harness loop`);
  console.log(`[CONTRACT] Hash: ${contract.contract_hash}`);
  console.log(`[PHASES] ${contract.phases.map((p) => p.name).join(" → ")}`);

  // 4. Main loop
  while (phase_state.current_phase_name !== "complete") {
    action_counter++;
    const action_id = `act_${String(action_counter).padStart(3, "0")}`;

    // Build readable state
    const current_phase = contract.phases.find(
      (p) => p.name === phase_state.current_phase_name
    )!;
    const agent_read_state = buildAgentReadState(
      contract,
      phase_state,
      autonomy_class,
      last_rejection
    );

    // Spawn/resume OpenCode
    if (!opencode_process) {
      opencode_process = await spawnOpenCode(opencode_executable, agent_read_state);
    }

    // Read next tool call from OpenCode
    const tool_call = await readToolCall(opencode_process);
    if (!tool_call) {
      console.log(`[SETTLEMENT] OpenCode terminated`);
      break;
    }

    console.log(`[ACTION ${action_id}] Tool: ${tool_call.tool}, Claim: ${tool_call.claim || "none"}`);

    // Admission gate
    const admission = admitToolCall({
      contract,
      current_phase,
      autonomy_class,
      tool_name: tool_call.tool,
      tool_input: tool_call.input,
      previous_phase_evidence: phase_state.evidence_collected,
      working_tree_root: session_root
    });

    // Log admission
    logAdmissionDecision(
      path.join(settlement_dir, "logs", "admission.jsonl"),
      action_id,
      tool_call.tool,
      admission,
      tool_call.input
    );

    // Handle DENY
    if (admission.decision === "DENY") {
      console.log(`[ADMISSION] DENY: ${admission.reason}`);
      const result = {
        action_id,
        status: "ADMISSION_DENIED",
        reason: admission.reason
      };
      await sendToolResult(opencode_process, result);
      last_rejection = { action_id, tool_name: tool_call.tool, reason: admission.reason };
      continue;
    }

    // Shadow execution (PERMIT or QUARANTINE)
    console.log(`[EXECUTION] Running in shadow worktree`);
    const shadow_result = await executeInShadow({
      contract,
      tool_name: tool_call.tool,
      tool_input: tool_call.input,
      working_tree_root: session_root,
      worktree_id: `wt_${action_id}`
    });

    // Settlement scoring
    const verdict = scoreAgainstContract(contract, shadow_result.evidence);
    console.log(`[SETTLEMENT] ${verdict}`);

    // Mint receipt
    const receipt: SettlementReceipt = {
      action_id,
      timestamp: new Date().toISOString(),
      phase: current_phase.name,
      tool_name: tool_call.tool,
      settlement: verdict === "PASS" ? "APPROVED" : "REJECTED",
      evidence_hash: hashEvidence(shadow_result.evidence),
      evidence_types: extractEvidenceTypes(shadow_result.evidence),
      clauses_satisfied: extractClausesSatisfied(shadow_result.evidence, contract),
      probes_run: shadow_result.probes_run.map((p) => p.probe_name),
      files_promoted: verdict === "PASS" ? shadow_result.files_changed.map((f) => f.path) : [],
      rejection_reason: verdict === "FAIL" ? shadow_result.evidence.invariants_violated[0] : undefined
    };

    // Append to ledger
    fs.appendFileSync(
      path.join(settlement_dir, "receipts", "receipts.jsonl"),
      JSON.stringify(receipt) + "\n"
    );

    // Promote diffs if APPROVED
    if (receipt.settlement === "APPROVED") {
      console.log(`[PROMOTION] Promoting ${shadow_result.files_changed.length} file(s)`);
      for (const file_change of shadow_result.files_changed) {
        const target_path = path.join(session_root, file_change.path);
        fs.mkdirSync(path.dirname(target_path), { recursive: true });
        fs.writeFileSync(target_path, file_change.content);
      }
    }

    // Update phase state
    const old_phase = phase_state.current_phase_name;
    phase_state = updatePhaseState(contract, phase_state, receipt);
    if (phase_state.current_phase_name !== old_phase) {
      console.log(`[PHASE TRANSITION] ${old_phase} → ${phase_state.current_phase_name}`);
    }

    // Send result back to OpenCode
    const tool_result = {
      action_id,
      status: receipt.settlement === "APPROVED" ? "SETTLED" : "SETTLEMENT_REJECTED",
      result: shadow_result.stdout,
      receipt_id: `${action_id}_rcpt`,
      settlement: receipt.settlement,
      rejection_reason: receipt.rejection_reason,
      phase_state: {
        current_phase_name: phase_state.current_phase_name,
        missing_evidence: phase_state.current_phase_name === "complete"
          ? []
          : checkPhaseExitCriteria(current_phase, phase_state.evidence_collected).missing
      }
    };

    await sendToolResult(opencode_process, tool_result);
    last_rejection = receipt.settlement === "REJECTED" ? { action_id, tool_name: tool_call.tool, reason: receipt.rejection_reason } : null;
  }

  console.log(`[SETTLEMENT COMPLETE]`);
  console.log(`Total actions: ${action_counter}`);
  console.log(`Session receipt ledger: ${path.join(settlement_dir, "receipts", "receipts.jsonl")}`);

  if (opencode_process) {
    opencode_process.kill();
  }
}

settlementHarnessLoop(
  process.argv[2], // contract.json path
  process.argv[3] || process.cwd(), // working tree root
  process.argv[4] || "opencode" // opencode executable
).catch((e) => {
  console.error(`[ERROR] ${e.message}`);
  process.exit(1);
});
```

---

## 9. Key Insights

1. **OpenCode is stateless across iterations.** Each iteration passes a fresh AgentReadState. This means OpenCode can't "remember" context decay, can't hide state, can't game the settlement engine.

2. **The contract is immutable and hash-pinned.** OpenCode reads it but cannot modify it. The stage-gate is the user's last chance to fix intent bugs.

3. **Receipts are the source of truth.** Phase state, evidence, settlement decisions — all derive from the receipt ledger, which is append-only and immutable.

4. **Worktrees are ephemeral.** Every action runs in shadow. Only settled diffs are promoted. Failed actions leave no trace.

5. **Autonomy class is a mechanism, not a configuration.** The wrapper can downgrade autonomy after incidents (phase 2 feature: incident directives).

---

## 10. Deployment Checklist

- [ ] Load contract.json, validate stage-gated
- [ ] Create settlement directory structure (.settlement/{contracts,receipts,logs})
- [ ] Implement admission gate (TypeScript module ready)
- [ ] Implement shadow executor (git worktree creation/cleanup)
- [ ] Implement settlement scorer (probe runner + contract evaluation)
- [ ] Implement OpenCode harness (spawn, I/O, tool call routing)
- [ ] Wire up the loop (orchestration)
- [ ] Test with a simple repo (add a function, run tests)
- [ ] Measure: receipt volume, settlement rate, phase transitions, autonomy ratcheting
- [ ] Phase 2: Epistemic ledger (TTL + staleness), incident directives

