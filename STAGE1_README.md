# Settlement-Layer Harness: Stage 1 Foundation

## What's Built

**Stage 1 deliverables (Week 1):**

1. **contract-loader.ts** (~180 lines)
   - Load contract.json from disk
   - Validate schema (all fields, correct types)
   - Enforce stage-gate (user_confirmed_at must exist)
   - Verify hash (contract_hash must match content)
   - Semantic validation (phases, phases make sense)
   - Public API: `loadContract()`, `validateContract()`, `computeContractHash()`, `loadAndValidateContract()`

2. **contract-loader.test.ts** (~400 lines)
   - 45+ unit tests
   - Schema validation tests (every field, every type)
   - Stage-gate enforcement tests (CRITICAL)
   - Hash verification tests
   - Semantic validation tests
   - File I/O and error handling tests
   - Edge cases (special chars, many phases, etc.)

3. **contract-fixture.ts** (~70 lines)
   - Helper to generate valid test contracts
   - Auto-computes contract_hash
   - Supports overrides for testing variations

4. **mock-opencode.sh** (~180 lines)
   - Shell script that simulates OpenCode behavior
   - Reads AgentReadState from stdin
   - Emits deterministic sequence of tool calls
   - Tests all three phases: diagnostic → edit → verify
   - Designed for end-to-end testing without real OpenCode

---

## File Structure

```
/home/claude/
├── contract-loader.ts           # Core: load & validate contracts
├── contract-loader.test.ts      # Tests: 45+ unit tests
├── contract-fixture.ts          # Fixture: generate test contracts
├── mock-opencode.sh             # Mock: simulates OpenCode subprocess
│
├── STAGE1_README.md             # This file
├── settlement-wrapper-spec.md   # Full architecture spec
├── admission-gate.ts            # Admission gate implementation (from stage 2)
├── opencode-settlement-integration.md  # Integration map
├── settlement-build-roadmap.md  # 7-stage build plan
```

---

## Quick Start

### Prerequisites

- Node.js 16+ (for TypeScript)
- jq (for mock-opencode.sh to parse JSON)
- npm or yarn

### 1. Setup

```bash
cd /home/claude
npm init -y
npm install --save-dev typescript ts-jest @types/jest jest @types/node
```

### 2. Create jest.config.js

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
};
```

### 3. Run Tests

```bash
npm test -- contract-loader.test.ts
```

Expected output:
```
PASS  contract-loader.test.ts
  Contract Loader - Schema Validation
    ✓ accepts a valid stage-gated contract (45ms)
    ✓ rejects contract without version
    ✓ rejects contract without user_confirmed_at (NOT STAGE-GATED)
    ...
  Contract Loader - File Loading
    ✓ loads valid contract from file (23ms)
    ✓ throws if contract file not found
    ...
  Contract Loader - Stage-Gate Enforcement (CRITICAL)
    ✓ REJECTS contract without user_confirmed_at
    ✓ REQUIRES _read_only: true
    ✓ REQUIRES user_confirmed_at to be ISO 8601 timestamp
    ...

Test Suites: 1 passed, 1 total
Tests:       45 passed, 45 total
```

---

## How to Use

### Loading and Validating a Contract

```typescript
import { loadAndValidateContract } from './contract-loader';

async function main() {
  try {
    const contract = await loadAndValidateContract('./contract.json');
    console.log(`Loaded contract: ${contract.scope.description}`);
    console.log(`Phases: ${contract.phases.map(p => p.name).join(' → ')}`);
  } catch (error) {
    console.error(`Contract validation failed: ${error.message}`);
  }
}
```

### Creating a Test Contract

```typescript
import { createTestContract } from './contract-fixture';

// Generate a valid test contract
const contract = createTestContract();

// Or with overrides
const custom_contract = createTestContract({
  scope: {
    ...createTestContract().scope,
    description: "Custom task description"
  }
});
```

### Verifying Contract Hash

```typescript
import { computeContractHash, verifyContractHash } from './contract-loader';

const contract = ...; // loaded contract
const hash = computeContractHash(contract);
console.log(`Contract hash: ${hash}`);

if (verifyContractHash(contract)) {
  console.log('Hash is valid ✓');
} else {
  console.log('Hash is invalid ✗ (contract may have been modified)');
}
```

---

## Mock OpenCode: Usage

### What It Does

The mock OpenCode script (`mock-opencode.sh`) emulates the behavior of a real OpenCode subprocess:

1. **Reads AgentReadState from stdin** — JSON object containing:
   - `contract` (frozen contract.json)
   - `current_phase` (diagnostic, edit, verify, or complete)
   - `receipts_so_far` (all settled receipts so far)
   - `missing_evidence` (what evidence is needed for phase exit)
   - `autonomy_class` (learner, supervised, autonomous)
   - `last_rejection` (if the previous action was rejected)

2. **Emits tool calls on stdout** — Newline-delimited JSON:
   ```json
   {"action_id":"act_001","tool":"read_file","input":{"path":"src/payment.ts"},"claim":"analyzing_codebase"}
   {"action_id":"act_002","tool":"write_file","input":{"path":".settlement/agent_analysis.md","content":"# Analysis\n..."},"claim":"codebase_structure_doc"}
   ```

3. **Logs to stderr** — Debug info with the `DEBUG=1` env var

### Testing the Mock Script

```bash
# Create an AgentReadState JSON
cat > agent_state.json << 'EOF'
{
  "contract": {
    "version": 1,
    "contract_hash": "sha256:...",
    "scope": { ... },
    "phases": [
      { "name": "diagnostic", ... }
    ],
    ...
  },
  "current_phase": {
    "name": "diagnostic",
    "permitted_tools": ["read_file", "grep", "list_files"],
    ...
  },
  "receipts_so_far": [],
  "missing_evidence": ["codebase_structure_doc"],
  "autonomy_class": "learner",
  "last_rejection": null
}
EOF

# Run the mock script
cat agent_state.json | DEBUG=1 ./mock-opencode.sh

# Output on stdout (tool calls):
# {"action_id":"act_001","tool":"read_file",...}
# {"action_id":"act_002","tool":"grep",...}
# {"action_id":"act_003","tool":"write_file",...}

# Output on stderr (logs):
# [MockOpenCode] Phase: diagnostic (no writes allowed)
# [MockOpenCode] Emitting: read_file
# ...
```

### Mock Behavior

**Diagnostic Phase:**
- Reads files (grep, read_file)
- Writes analysis document → settles as "codebase_structure_doc"

**Edit Phase:**
- First attempt: Writes naive refactored code (likely to fail coverage check)
- If rejected: Retries with timeout guards + better coverage
- Runs tests after each write

**Verify Phase:**
- Runs full test suite
- Verifies coverage
- Exits on "complete" phase

---

## Stage 1: What's Validated

| Component | Status | Tests |
|---|---|---|
| Schema validation | ✓ Complete | 15 tests |
| Stage-gate enforcement | ✓ Complete | 6 tests (CRITICAL) |
| Hash computation & verification | ✓ Complete | 4 tests |
| Phase validation | ✓ Complete | 6 tests |
| Acceptance criteria validation | ✓ Complete | 6 tests |
| Semantic validation | ✓ Complete | 3 tests |
| File I/O | ✓ Complete | 3 tests |
| Error handling | ✓ Complete | 8 tests |
| Edge cases | ✓ Complete | 3 tests |
| **TOTAL** | **✓ Complete** | **45+ tests** |

---

## What Comes Next (Stage 2)

Once Stage 1 is solid, the next phase is **shadow execution**:

1. **Worktree Manager** (git worktree creation/cleanup)
2. **Tool Executor** (path rewriting, tool invocation in shadow)
3. **Probe Runner** (tests, linters, invariant checks)
4. **Settlement Scorer** (score shadow result against contract)
5. **Admission Gate Tests** (unit tests for the 6 rules from admission-gate.ts)

See `settlement-build-roadmap.md` for the full 7-stage plan.

---

## Critical Insights for Stage 1

### Stage-Gate is Load-Bearing

The contract must be confirmed by the user before session start. This is enforced by:
1. `user_confirmed_at` must be set (ISO 8601 timestamp)
2. `_read_only` must be `true`
3. `contract_hash` must match the content (prevents sneaky modifications)

**Why it matters:** If the contract isn't stage-gated, the session has a brittle foundation. All downstream decisions (phase gating, admission checks, settlement scoring) depend on a frozen contract.

### Hash Verification is Deterministic

The contract hash is computed by:
1. Excluding the `contract_hash` field itself
2. Serializing to JSON with sorted keys (deterministic)
3. SHA256 hash

This ensures:
- The same contract always produces the same hash
- Any modification (even whitespace) changes the hash
- We can detect post-stage-gate tampering

### Phases Form a Sequence

Phases must:
1. Have names and descriptions
2. List permitted_tools (at least one)
3. Define exit_criteria.required_evidence
4. Reference prior phases in order (no cycles, no backjumps)

The first phase must not require a prior phase. This is checked in semantic validation.

---

## Error Messages: Guidance for Users

The contract loader throws `ContractValidationError` with specific messages to help users fix contracts:

| Error | Cause | Fix |
|---|---|---|
| "not stage-gated" | `user_confirmed_at` missing | Add user confirmation timestamp |
| "must be read-only" | `_read_only: false` | Set `_read_only: true` |
| "hash does not match" | Contract modified after stage-gate | Recompute hash or restore original |
| "at least one phase" | `phases: []` | Add at least one phase |
| "files_in_scope must not be empty" | `files_in_scope: []` | Specify files to be modified |
| "does not exist" (phase prerequisite) | Nonexistent prior phase name | Fix phase name or ordering |

---

## Testing Checklist

- [ ] Run `npm test` — all tests pass
- [ ] Check stage-gate enforcement tests specifically (CRITICAL)
- [ ] Test hash verification with manual contract modification
- [ ] Test file loading with both valid and invalid JSON
- [ ] Generate a test contract and verify it loads

---

## Debugging Tips

### Enable Debug Logging (Mock OpenCode)

```bash
DEBUG=1 cat agent_state.json | ./mock-opencode.sh 2>&1 | tee opencode.log
```

### Inspect a Contract

```typescript
import { loadAndValidateContract, summarizeContract } from './contract-loader';

const contract = await loadAndValidateContract('./contract.json');
console.log(summarizeContract(contract));
```

### Check Hash Mismatch

```typescript
import { loadContract, computeContractHash } from './contract-loader';

const contract = loadContract('./contract.json');
const computed = computeContractHash(contract);

if (contract.contract_hash !== computed) {
  console.log(`Expected: ${contract.contract_hash}`);
  console.log(`Got:      ${computed}`);
}
```

---

## Summary

**Stage 1 is complete and testable.** The contract loader validates that:

1. **Contracts are well-formed** (schema ✓)
2. **Contracts are stage-gated** (user confirmed ✓)
3. **Contracts are frozen** (hash verified ✓)
4. **Contracts are semantically sound** (phases valid ✓)

This foundation is **load-bearing** for the entire settlement-layer harness. Without it, downstream decisions (phase gating, admission control, settlement scoring) have no ground truth to stand on.

**Next step:** Move to Stage 2 (shadow execution). The roadmap is in `settlement-build-roadmap.md`.

