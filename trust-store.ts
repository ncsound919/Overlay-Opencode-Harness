/**
 * Trust Store: graduated autonomy licensing with cross-session persistence.
 *
 * Mechanism design, not prompting: the agent starts on a learner's permit
 * and earns capability breadth through settled-claim track record, while
 * incidents ratchet it back down. Trust is keyed per repo and persisted in
 * `.settlement/trust.json`, so a repo with a misaligned history starts the
 * next session restricted (misalignment clusters per repo in the field
 * data). This is the durable counterpart to the per-action admission gate:
 * the gate enforces the contract, the license sets how much rope the
 * current track record buys.
 *
 * Policy (deliberately simple and auditable):
 *   - Fresh repo: LEARNER (or the harness's initial_autonomy_class).
 *   - 3 consecutive APPROVED receipts -> SUPERVISED.
 *   - 8 consecutive APPROVED receipts -> AUTONOMOUS.
 *   - Any DENY resets the streak (attempted out-of-contract action).
 *   - Any REJECTED receipt resets the streak AND demotes one class.
 *
 * What classes change: capability breadth only. LEARNER cannot delete
 * files at all (see admission-gate.ts checkAutonomyClass). Shadow
 * execution and settlement depth are intentionally class-invariant — the
 * safety floor never lowers as trust rises.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

import { AutonomyClass } from "./admission-gate";

export const PROMOTE_TO_SUPERVISED_AFTER = 3;
export const PROMOTE_TO_AUTONOMOUS_AFTER = 8;

export interface TrustIncident {
  action_id: string;
  kind: "rejected" | "denied";
  reason: string;
  at: string;
}

export interface TrustState {
  repo_fingerprint: string;
  autonomy_class: AutonomyClass;
  consecutive_settled: number;
  incidents: TrustIncident[];
  updated_at: string;
}

/**
 * Stable per-repo identity for the trust file. Prefers the git remote URL
 * (same repo cloned anywhere shares trust); falls back to the absolute
 * path for repos without a remote.
 */
export function fingerprintRepo(repo_path: string): string {
  let raw: string;
  try {
    raw = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: repo_path,
      timeout: 10000
    })
      .toString()
      .trim();
  } catch {
    raw = "";
  }
  if (!raw) raw = path.resolve(repo_path);
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

function freshTrust(repo_fingerprint: string, fallback: AutonomyClass): TrustState {
  return {
    repo_fingerprint,
    autonomy_class: fallback,
    consecutive_settled: 0,
    incidents: [],
    updated_at: new Date().toISOString()
  };
}

/**
 * Load persisted trust. Returns a fresh record when the file is absent,
 * unreadable, or belongs to a different repo (never inherit another
 * repo's track record — a fingerprint mismatch fails closed to fresh).
 */
export function loadTrust(store_path: string, repo_fingerprint: string, fallback: AutonomyClass): TrustState {
  try {
    const raw = JSON.parse(fs.readFileSync(store_path, "utf-8")) as TrustState;
    if (!raw || raw.repo_fingerprint !== repo_fingerprint) return freshTrust(repo_fingerprint, fallback);
    if (!Object.values(AutonomyClass).includes(raw.autonomy_class)) return freshTrust(repo_fingerprint, fallback);
    return {
      repo_fingerprint,
      autonomy_class: raw.autonomy_class,
      consecutive_settled: typeof raw.consecutive_settled === "number" ? raw.consecutive_settled : 0,
      incidents: Array.isArray(raw.incidents) ? raw.incidents : [],
      updated_at: new Date().toISOString()
    };
  } catch {
    return freshTrust(repo_fingerprint, fallback);
  }
}

export function saveTrust(store_path: string, trust: TrustState): void {
  fs.mkdirSync(path.dirname(store_path), { recursive: true });
  trust.updated_at = new Date().toISOString();
  fs.writeFileSync(store_path, JSON.stringify(trust, null, 2), "utf-8");
}

function demoteOne(trust: TrustState): AutonomyClass {
  if (trust.autonomy_class === AutonomyClass.AUTONOMOUS) return AutonomyClass.SUPERVISED;
  if (trust.autonomy_class === AutonomyClass.SUPERVISED) return AutonomyClass.LEARNER;
  return AutonomyClass.LEARNER;
}

/** An APPROVED receipt: extend the streak, promote at thresholds. */
export function recordApproval(trust: TrustState): TrustState {
  const consecutive_settled = trust.consecutive_settled + 1;
  let autonomy_class = trust.autonomy_class;
  if (consecutive_settled >= PROMOTE_TO_AUTONOMOUS_AFTER) {
    autonomy_class = AutonomyClass.AUTONOMOUS;
  } else if (consecutive_settled >= PROMOTE_TO_SUPERVISED_AFTER) {
    if (autonomy_class === AutonomyClass.LEARNER) autonomy_class = AutonomyClass.SUPERVISED;
  }
  return { ...trust, consecutive_settled, autonomy_class };
}

/**
 * A REJECTED settlement: failed probes are the strongest negative signal —
 * reset the streak and step down one class.
 */
export function recordRejection(trust: TrustState, incident: Omit<TrustIncident, "kind" | "at">): TrustState {
  return {
    ...trust,
    consecutive_settled: 0,
    autonomy_class: demoteOne(trust),
    incidents: [...trust.incidents, { ...incident, kind: "rejected", at: new Date().toISOString() }]
  };
}

/**
 * An admission DENY: the model attempted something out-of-contract. Reset
 * the streak and log the incident, but do not demote — denial means the
 * gate worked, not that settled work failed.
 */
export function recordDenial(trust: TrustState, incident: Omit<TrustIncident, "kind" | "at">): TrustState {
  return {
    ...trust,
    consecutive_settled: 0,
    incidents: [...trust.incidents, { ...incident, kind: "denied", at: new Date().toISOString() }]
  };
}
