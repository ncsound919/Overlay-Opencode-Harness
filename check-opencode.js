#!/usr/bin/env node
/**
 * check-opencode.js: verify the real OpenCode binary is installed and report
 * what the settlement harness needs from it.
 *
 * What this checks:
 *   - `opencode --version` runs (binary on PATH, incl. npm's opencode.cmd
 *     shim on Windows).
 *
 * What this does NOT claim:
 *   - The real OpenCode CLI speaks the harness's newline-delimited JSON
 *     tool-call protocol (stdout) / tool-result protocol (stdin). It does
 *     not — it is an interactive agent. Driving live agent iterations
 *     requires an adapter subprocess that translates between the two (see
 *     opencode-settlement-integration.md section 7). Until that adapter
 *     exists, live sessions should use mock-opencode.js; this script only
 *     proves the binary is present and reports its version.
 */

const { execFile } = require("child_process");

const bin = process.platform === "win32" ? "opencode.cmd" : "opencode";

const done = (err, stdout, stderr) => {
  if (err) {
    console.error(`[check-opencode] FAIL: could not run opencode --version: ${err.message}`);
    console.error("[check-opencode] Install via: npm install -g opencode-ai");
    process.exit(1);
    return;
  }
  const version = String(stdout || stderr || "").trim();
  console.log(`[check-opencode] OK: opencode binary found, version: ${version}`);
  console.log("[check-opencode] NOTE: live harness iterations need a protocol adapter;");
  console.log("[check-opencode] NOTE: use `node mock-opencode.js` until the adapter exists.");
};

// .cmd shims need a shell on Windows (else EINVAL); a single command
// string + shell avoids the DEP0190 args-array warning.
if (process.platform === "win32") {
  execFile("opencode.cmd --version", { timeout: 30000, shell: true }, done);
} else {
  execFile(bin, ["--version"], { timeout: 30000 }, done);
}
