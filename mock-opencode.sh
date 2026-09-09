#!/bin/bash

##
## Mock OpenCode Subprocess
##
## This script simulates OpenCode's behavior in the settlement wrapper loop.
## It reads AgentReadState from stdin and emits a sequence of tool calls.
##
## Communication protocol:
##   - STDIN:  AgentReadState (JSON)
##   - STDOUT: Tool calls (newline-delimited JSON)
##   - Environment: DEBUG (optional, for logging)
##

set -e

# Colors for logging
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Read the first line of stdin (the initial AgentReadState) rather than
# blocking on EOF. The wrapper protocol keeps stdin open for the whole
# session so it can send tool *results* back later (see
# opencode-settlement-integration.md section 7); blocking on `$(cat)` here
# would hang forever waiting for the wrapper to close a pipe it's not
# supposed to close. This mock only consumes the first line since it
# doesn't react to tool results, but reading line-by-line matches the real
# streaming protocol instead of assuming stdin ever closes.
IFS= read -r AGENT_STATE

# Helper: log to stderr (so stdout stays clean for tool calls)
log_debug() {
  if [ -n "$DEBUG" ]; then
    echo -e "${BLUE}[MockOpenCode]${NC} $*" >&2
  fi
}

log_info() {
  echo -e "${GREEN}[MockOpenCode]${NC} $*" >&2
}

log_error() {
  echo -e "${RED}[MockOpenCode ERROR]${NC} $*" >&2
}

# Helper: extract a field from JSON using jq (assumes jq is available)
get_json_field() {
  local json="$1"
  local field="$2"
  echo "$json" | jq -r "$field // empty" 2>/dev/null || echo ""
}

# Parse AgentReadState
log_debug "Parsing AgentReadState..."
CURRENT_PHASE=$(get_json_field "$AGENT_STATE" ".current_phase.name")
AUTONOMY_CLASS=$(get_json_field "$AGENT_STATE" ".autonomy_class")
MISSING_EVIDENCE=$(get_json_field "$AGENT_STATE" ".missing_evidence")
LAST_REJECTION=$(get_json_field "$AGENT_STATE" ".last_rejection.reason")

log_debug "Phase: $CURRENT_PHASE"
log_debug "Autonomy: $AUTONOMY_CLASS"
log_debug "Missing evidence: $MISSING_EVIDENCE"

if [ -n "$LAST_REJECTION" ]; then
  log_debug "Last rejection: $LAST_REJECTION"
fi

# =============================================================================
# TOOL CALL SEQUENCE
# =============================================================================
#
# This sequence is deterministic and designed to test the settlement loop:
# 1. diagnostic phase: read files, write analysis doc (should SETTLE APPROVED)
# 2. edit phase attempt 1: try to write refactored code (may fail settlement)
# 3. edit phase attempt 2: retry with better code (should SETTLE APPROVED)
# 4. verify phase: run tests and write summary (should SETTLE APPROVED)

ACTION_COUNTER=0

emit_tool_call() {
  local tool="$1"
  local input_json="$2"
  local claim="$3"

  ACTION_COUNTER=$((ACTION_COUNTER + 1))
  local action_id=$(printf "act_%03d" $ACTION_COUNTER)

  # IMPORTANT: the wrapper protocol is newline-delimited JSON — exactly one
  # JSON object per stdout line (see opencode-settlement-integration.md
  # section 7 and STAGE1_README.md). Build the call with jq -c (compact) so
  # it can never contain an embedded newline, instead of a pretty-printed
  # heredoc which would break any line-buffered reader on the wrapper side.
  local call
  call=$(jq -cn \
    --arg action_id "$action_id" \
    --arg tool "$tool" \
    --argjson input "$input_json" \
    --arg claim "$claim" \
    '{action_id: $action_id, tool: $tool, input: $input, claim: $claim}')

  log_debug "Emitting: $tool"
  echo "$call"
}

wait_for_result() {
  # In a real implementation, the wrapper would send a result back on stdin.
  # For simplicity, we just sleep a bit to simulate processing time.
  sleep 0.1
}

# Phase 1: DIAGNOSTIC (read-only, no writes)
if [ "$CURRENT_PHASE" = "diagnostic" ]; then
  log_info "Phase: diagnostic (no writes allowed)"

  # Tool 1: Read main file
  emit_tool_call "read_file" \
    '{"path": "src/payment.ts"}' \
    "analyzing_codebase"
  wait_for_result

  # Tool 2: Grep for async patterns
  emit_tool_call "grep" \
    '{"pattern": "async", "path": "src/"}' \
    "checking_async_usage"
  wait_for_result

  # Tool 3: Write analysis document
  emit_tool_call "write_file" \
    '{"path": ".settlement/agent_analysis.md", "content": "# Codebase Analysis\n\n## Current State\n\nThe payment processor is currently synchronous. Found async patterns in:\n- payment.ts:45 (callback-based)\n\n## Refactoring Plan\n\n1. Convert main function to async\n2. Add timeout guards\n3. Update all call sites\n4. Run tests\n\n## Coverage Impact\n\nCurrent: 80%, Target: 85%+\n"}' \
    "codebase_structure_doc"
  wait_for_result

# Phase 2: EDIT (write allowed, settlement required)
elif [ "$CURRENT_PHASE" = "edit" ]; then
  log_info "Phase: edit (writes allowed, settlement required)"

  # Check if there was a last rejection
  if [ -n "$LAST_REJECTION" ]; then
    log_info "Last action was rejected: $LAST_REJECTION"
    log_info "Retrying with improved refactor..."

    # Tool: Retry refactor (with timeout guards)
    emit_tool_call "write_file" \
      '{"path": "src/payment.ts", "content": "async function processPayment(amount) {\n  const timeoutPromise = new Promise((_, reject) => {\n    setTimeout(() => reject(new Error(\"Timeout\")), 5000);\n  });\n  \n  try {\n    const result = await Promise.race([fetchPaymentStatus(amount), timeoutPromise]);\n    return result;\n  } catch (e) {\n    console.error(\"Payment failed\", e);\n    throw e;\n  }\n}\n\nasync function fetchPaymentStatus(amount) {\n  // Implementation\n  return { status: \"success\" };\n}\n"}' \
      "refactor_claim"
    wait_for_result

    # Tool: Run tests
    emit_tool_call "run_test" \
      '{"suite": "tests/payment.test.ts", "pattern": "async.*"}' \
      "test_claim"
    wait_for_result

  else
    log_info "First attempt at refactoring..."

    # Tool: Attempt refactor (naive version, likely to fail coverage check)
    emit_tool_call "write_file" \
      '{"path": "src/payment.ts", "content": "async function processPayment(amount) {\n  const result = await fetchPaymentStatus(amount);\n  return result;\n}\n\nfunction fetchPaymentStatus(amount) {\n  // Sync implementation\n  return { status: \"success\" };\n}\n"}' \
      "refactor_claim"
    wait_for_result

    # Tool: Run tests (will likely fail because coverage drops)
    emit_tool_call "run_test" \
      '{"suite": "tests/payment.test.ts", "pattern": "async.*"}' \
      "test_claim"
    wait_for_result
  fi

# Phase 3: VERIFY (read-only, final checks)
elif [ "$CURRENT_PHASE" = "verify" ]; then
  log_info "Phase: verify (read-only, final checks)"

  # Tool 1: Run full test suite
  emit_tool_call "run_test" \
    '{"suite": "tests/payment.test.ts"}' \
    "verification"
  wait_for_result

  # Tool 2: Verify coverage
  emit_tool_call "run_test" \
    '{"suite": "tests/payment.test.ts", "coverage": true}' \
    "coverage_verification"
  wait_for_result

  # Tool 3: Write verification summary
  emit_tool_call "read_file" \
    '{"path": "src/payment.ts"}' \
    "verification"
  wait_for_result

elif [ "$CURRENT_PHASE" = "complete" ]; then
  log_info "Settlement complete, exiting"
  exit 0

else
  log_error "Unknown phase: $CURRENT_PHASE"
  exit 1
fi

log_info "Sequence complete, awaiting wrapper response"
