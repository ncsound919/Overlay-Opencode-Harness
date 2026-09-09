/**
 * Settlement Ledger: append-only .jsonl log of settlement receipts
 *
 * The ledger is the source of truth for phase state, evidence, and
 * settlement history (see opencode-settlement-integration.md section 6 and
 * section 9, point 3: "Receipts are the source of truth"). This module
 * only reads/writes the file — it does not interpret receipts; that's
 * admission-gate.ts's updatePhaseState().
 */

import * as fs from "fs";
import * as path from "path";

import { SettlementReceipt } from "./admission-gate";

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

// =============================================================================
// APPEND
// =============================================================================

/**
 * Append a single receipt to the ledger file. Creates the file (and any
 * missing parent directories) if it doesn't exist yet. Each receipt is
 * written as exactly one JSON line, matching the newline-delimited format
 * used throughout the wrapper protocol (see mock-opencode.sh's comments on
 * why NDJSON, not pretty-printed JSON, is required).
 */
export function appendReceipt(ledger_path: string, receipt: SettlementReceipt): void {
  const dir = path.dirname(ledger_path);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify(receipt) + "\n";
  fs.appendFileSync(ledger_path, line, "utf-8");
}

// =============================================================================
// READ
// =============================================================================

/**
 * Read and parse every receipt in the ledger, in append order.
 * Returns an empty array if the ledger file doesn't exist yet — an absent
 * ledger is a fresh session, not an error.
 *
 * Blank lines are skipped. A malformed line throws LedgerError with the
 * line number, since a corrupted ledger silently truncated to "valid
 * receipts only" would misrepresent settlement history.
 */
export function readReceipts(ledger_path: string): SettlementReceipt[] {
  if (!fs.existsSync(ledger_path)) {
    return [];
  }

  const raw = fs.readFileSync(ledger_path, "utf-8");
  const lines = raw.split("\n");
  const receipts: SettlementReceipt[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    try {
      receipts.push(JSON.parse(line) as SettlementReceipt);
    } catch (e) {
      throw new LedgerError(
        `Malformed ledger entry at ${ledger_path}:${i + 1}: ${(e as Error).message}`
      );
    }
  }

  return receipts;
}

// =============================================================================
// QUERIES
// =============================================================================

/**
 * All receipts recorded for a given phase name, in append order.
 */
export function getReceiptsByPhase(ledger_path: string, phase: string): SettlementReceipt[] {
  return readReceipts(ledger_path).filter((r) => r.phase === phase);
}

/**
 * All receipts with settlement === "APPROVED", in append order.
 * This is the evidence set that admission-gate.ts's phase-state logic
 * cares about — REJECTED receipts don't contribute evidence.
 */
export function getApprovedReceipts(ledger_path: string): SettlementReceipt[] {
  return readReceipts(ledger_path).filter((r) => r.settlement === "APPROVED");
}

/**
 * All receipts with settlement === "REJECTED", in append order.
 */
export function getRejectedReceipts(ledger_path: string): SettlementReceipt[] {
  return readReceipts(ledger_path).filter((r) => r.settlement === "REJECTED");
}

/**
 * Look up a single receipt by action_id. Returns undefined if not found
 * (rather than throwing) since callers frequently probe for a receipt
 * that may not have been minted yet.
 */
export function getReceiptByActionId(
  ledger_path: string,
  action_id: string
): SettlementReceipt | undefined {
  return readReceipts(ledger_path).find((r) => r.action_id === action_id);
}
