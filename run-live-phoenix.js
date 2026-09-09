#!/usr/bin/env node
/**
 * run-live-phoenix.js — opt-in live smoke runner using the Phoenix Grove
 * credential from Keywire (project prj-mt7jrul1 / production).
 *
 * Flow (secrets never touch disk, never printed — only counts/lengths):
 *   1. Sign a workload SVID with the local Keywire key material (same
 *      machine-auth path as Keywire/scripts/keywire-pull.mts) and fetch
 *      PHOENIX_API_KEY / PHOENIX_BASE_URL / PHOENIX_FAST_MODEL over
 *      loopback (audited read in the vault ledger).
 *   2. Spawn `jest live-smoke` with LIVE_SMOKE=1 and the values in real OS
 *      env. The test builds an inline opencode custom provider
 *      (OPENCODE_CONFIG_CONTENT) and runs the harness loop against it.
 *
 * Usage: node run-live-phoenix.js
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const KEYWIRE_DIR = "C:\\Users\\User\\Downloads\\Uplift\\Keywire";
const BASE = process.env.KEYWIRE_URL || "http://localhost:3000";
const PROJECT = "prj-mt7jrul1";
const ENV_SLUG = "production";
const KEYS = ["PHOENIX_API_KEY", "PHOENIX_BASE_URL", "PHOENIX_FAST_MODEL"];

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function signSvid(jwtSecret, sub, ttlSeconds) {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({ sub, iss: "keywire-local-consumer", aud: "keywire-vault-api", projectId: PROJECT, iat: now, exp: now + ttlSeconds })
  );
  const sig = crypto.createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64Url(sig)}`;
}

async function main() {
  const keysFile = path.join(KEYWIRE_DIR, "data", "keywire-keys.json");
  if (!fs.existsSync(keysFile)) throw new Error(`Key material not found at ${keysFile}`);
  const { jwtSecret } = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  if (!jwtSecret) throw new Error("jwtSecret missing from key material");

  const svid = signSvid(jwtSecret, "spiffe://ecosystem/settlement-harness", 120);
  const res = await fetch(`${BASE}/api/v1/workload/fetch-secrets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${svid}` },
    body: JSON.stringify({ svid, projectId: PROJECT, envSlug: ENV_SLUG })
  });
  if (!res.ok) throw new Error(`fetch-secrets failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const missing = KEYS.filter((k) => !body.secrets || !body.secrets[k]);
  if (missing.length > 0) throw new Error(`Keywire response missing keys: ${missing.join(",")}`);
  console.log(`[run-live-phoenix] fetched ${KEYS.length} keys from Keywire (values withheld)`);

  // Spawn jest directly via node (no shell, no PATH lookup for npx shims).
  // Literal file path (not a package subpath) to bypass exports maps.
  // Optional argv[2]: which live test file to run (default live-smoke).
  const testFile = process.argv[2] || "live-smoke";
  const jestBin = path.join(__dirname, "node_modules", "jest-cli", "bin", "jest.js");
  const child = spawn(process.execPath, [jestBin, testFile, "--runInBand"], {
    cwd: __dirname,
    env: {
      ...process.env,
      LIVE_SMOKE: "1",
      SETTLEMENT_AGENT: "settlement-proposer",
      PHOENIX_API_KEY: body.secrets.PHOENIX_API_KEY,
      PHOENIX_BASE_URL: body.secrets.PHOENIX_BASE_URL,
      PHOENIX_FAST_MODEL: body.secrets.PHOENIX_FAST_MODEL
    },
    stdio: "inherit"
  });
  child.on("exit", (code) => process.exit(code === null ? 1 : code));
  child.on("error", (e) => {
    console.error(`[run-live-phoenix] spawn failed: ${e.message}`);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(`[run-live-phoenix] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
