/**
 * Tests for settlement-ledger.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  appendReceipt,
  readReceipts,
  getReceiptsByPhase,
  getApprovedReceipts,
  getRejectedReceipts,
  getReceiptByActionId,
  LedgerError
} from "./settlement-ledger";
import { SettlementReceipt } from "./admission-gate";

function makeReceipt(overrides: Partial<SettlementReceipt> = {}): SettlementReceipt {
  return {
    action_id: "act_001",
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "diagnostic",
    tool_name: "read_file",
    settlement: "APPROVED",
    evidence_hash: "sha256:abc",
    evidence_types: ["analysis"],
    clauses_satisfied: [],
    probes_run: [],
    files_promoted: [],
    ...overrides
  };
}

describe("settlement-ledger", () => {
  let tmp_dir: string;
  let ledger_path: string;

  beforeEach(() => {
    tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
    ledger_path = path.join(tmp_dir, "receipts.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmp_dir, { recursive: true, force: true });
  });

  describe("appendReceipt / readReceipts", () => {
    it("appends receipts and preserves order", () => {
      const r1 = makeReceipt({ action_id: "act_001" });
      const r2 = makeReceipt({ action_id: "act_002" });

      appendReceipt(ledger_path, r1);
      appendReceipt(ledger_path, r2);

      const receipts = readReceipts(ledger_path);
      expect(receipts).toHaveLength(2);
      expect(receipts[0].action_id).toBe("act_001");
      expect(receipts[1].action_id).toBe("act_002");
    });

    it("creates missing parent directories", () => {
      const nested_path = path.join(tmp_dir, "a", "b", "receipts.jsonl");
      appendReceipt(nested_path, makeReceipt());
      expect(fs.existsSync(nested_path)).toBe(true);
    });

    it("returns an empty array for a ledger that doesn't exist yet", () => {
      const missing_path = path.join(tmp_dir, "does-not-exist.jsonl");
      expect(readReceipts(missing_path)).toEqual([]);
    });

    it("writes exactly one JSON object per line (no pretty-printing)", () => {
      appendReceipt(ledger_path, makeReceipt());
      const raw = fs.readFileSync(ledger_path, "utf-8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();
    });

    it("skips blank lines when reading", () => {
      fs.writeFileSync(
        ledger_path,
        JSON.stringify(makeReceipt({ action_id: "act_001" })) + "\n\n\n" +
          JSON.stringify(makeReceipt({ action_id: "act_002" })) + "\n"
      );
      const receipts = readReceipts(ledger_path);
      expect(receipts).toHaveLength(2);
    });

    it("throws LedgerError with the line number on malformed entries", () => {
      fs.writeFileSync(
        ledger_path,
        JSON.stringify(makeReceipt({ action_id: "act_001" })) + "\n" + "{not valid json\n"
      );
      expect(() => readReceipts(ledger_path)).toThrow(LedgerError);
      expect(() => readReceipts(ledger_path)).toThrow(/:2:/);
    });
  });

  describe("getReceiptsByPhase", () => {
    it("filters by phase", () => {
      appendReceipt(ledger_path, makeReceipt({ action_id: "act_001", phase: "diagnostic" }));
      appendReceipt(ledger_path, makeReceipt({ action_id: "act_002", phase: "edit" }));
      appendReceipt(ledger_path, makeReceipt({ action_id: "act_003", phase: "diagnostic" }));

      const diagnostic = getReceiptsByPhase(ledger_path, "diagnostic");
      expect(diagnostic.map((r) => r.action_id)).toEqual(["act_001", "act_003"]);
    });
  });

  describe("getApprovedReceipts / getRejectedReceipts", () => {
    it("separates approved and rejected receipts", () => {
      appendReceipt(ledger_path, makeReceipt({ action_id: "act_001", settlement: "APPROVED" }));
      appendReceipt(ledger_path, makeReceipt({ action_id: "act_002", settlement: "REJECTED" }));
      appendReceipt(ledger_path, makeReceipt({ action_id: "act_003", settlement: "APPROVED" }));

      expect(getApprovedReceipts(ledger_path).map((r) => r.action_id)).toEqual(["act_001", "act_003"]);
      expect(getRejectedReceipts(ledger_path).map((r) => r.action_id)).toEqual(["act_002"]);
    });
  });

  describe("getReceiptByActionId", () => {
    it("finds a receipt by action_id", () => {
      appendReceipt(ledger_path, makeReceipt({ action_id: "act_001" }));
      appendReceipt(ledger_path, makeReceipt({ action_id: "act_002" }));

      const found = getReceiptByActionId(ledger_path, "act_002");
      expect(found?.action_id).toBe("act_002");
    });

    it("returns undefined (not throw) for a missing action_id", () => {
      appendReceipt(ledger_path, makeReceipt({ action_id: "act_001" }));
      expect(getReceiptByActionId(ledger_path, "act_999")).toBeUndefined();
    });

    it("returns undefined for a ledger that doesn't exist", () => {
      const missing_path = path.join(tmp_dir, "nope.jsonl");
      expect(getReceiptByActionId(missing_path, "act_001")).toBeUndefined();
    });
  });
});
