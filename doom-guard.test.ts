/**
 * Tests for doom-guard.ts — the circuit breaker for repeated identical
 * tool calls.
 */

import { DoomGuard, signatureOf } from "./doom-guard";

describe("doom-guard", () => {
  describe("signatureOf", () => {
    it("is stable regardless of key order", () => {
      expect(signatureOf("read_file", { b: 1, a: "x" })).toBe(signatureOf("read_file", { a: "x", b: 1 }));
    });

    it("distinguishes tools, inputs and nesting", () => {
      const base = signatureOf("read_file", { path: "a.ts" });
      expect(signatureOf("grep", { path: "a.ts" })).not.toBe(base);
      expect(signatureOf("read_file", { path: "b.ts" })).not.toBe(base);
      expect(signatureOf("read_file", { path: "a.ts", extra: 1 })).not.toBe(base);
    });
  });

  describe("DoomGuard", () => {
    it("allows the first calls, trips on the Nth identical", () => {
      const g = new DoomGuard(3);
      const input = { path: "src/payment.ts" };
      expect(g.note("read_file", input)).toBe(false);
      expect(g.note("read_file", input)).toBe(false);
      expect(g.note("read_file", input)).toBe(true);
      expect(g.consecutiveIdentical).toBe(3);
    });

    it("stays tripped while the agent keeps repeating", () => {
      const g = new DoomGuard(3);
      const input = { path: "x" };
      g.note("read_file", input);
      g.note("read_file", input);
      expect(g.note("read_file", input)).toBe(true);
      expect(g.note("read_file", input)).toBe(true);
    });

    it("resets on a different action (variety = progress signal)", () => {
      const g = new DoomGuard(3);
      g.note("read_file", { path: "x" });
      g.note("read_file", { path: "x" });
      expect(g.note("grep", { pattern: "y" })).toBe(false);
      expect(g.consecutiveIdentical).toBe(1);
    });

    it("resets on phase transition", () => {
      const g = new DoomGuard(2);
      g.note("read_file", { path: "x" });
      g.reset();
      expect(g.note("read_file", { path: "x" })).toBe(false);
    });

    it("rejects invalid limits", () => {
      expect(() => new DoomGuard(0)).toThrow();
      expect(() => new DoomGuard(1.5)).toThrow();
    });
  });
});
