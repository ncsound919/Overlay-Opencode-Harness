/**
 * Doom Guard: orchestration-layer circuit breaker for repeated identical
 * tool calls.
 *
 * Field data: agents repeat the same failed call dozens of times with no
 * mechanism to recognize prior failure, and the model cannot be trusted to
 * stop itself. The fix is mechanical: track consecutive identical action
 * signatures (tool + canonicalized input). When the run reaches the limit,
 * the harness DENYs without shadow execution — no more work is spent — and
 * tells the agent a strategy change is required. The breaker resets on a
 * different action or a phase transition (new context, clean slate).
 *
 * This complements max_actions (the coarse backstop that aborts the whole
 * session): the breaker stops the WASTE early while letting the session
 * continue if the agent adapts.
 */

import * as crypto from "crypto";

/** Canonical signature: tool name + deterministically-serialized input. */
export function signatureOf(tool: string, input: Record<string, unknown>): string {
  return `sha256:${crypto.createHash("sha256").update(canonical(tool) + "\n" + canonical(input)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export class DoomGuard {
  private readonly maxRepeats: number;
  private lastSignature: string | null = null;
  private runLength = 0;

  constructor(maxRepeats = 3) {
    if (!Number.isInteger(maxRepeats) || maxRepeats < 1) {
      throw new Error("DoomGuard maxRepeats must be a positive integer");
    }
    this.maxRepeats = maxRepeats;
  }

  /**
   * Record an emitted tool call. Returns true when this call completes a
   * run of identical actions at the limit — i.e. the caller must DENY it.
   * The tripped call still counts (blocked actions carry no new
   * information), so the breaker stays sticky until variety or a phase
   * change resets it.
   */
  note(tool: string, input: Record<string, unknown>): boolean {
    const sig = signatureOf(tool, input);
    if (sig === this.lastSignature) {
      this.runLength++;
    } else {
      this.lastSignature = sig;
      this.runLength = 1;
    }
    return this.runLength >= this.maxRepeats;
  }

  /** New context (e.g. phase transition): clean slate. */
  reset(): void {
    this.lastSignature = null;
    this.runLength = 0;
  }

  get consecutiveIdentical(): number {
    return this.runLength;
  }
}
