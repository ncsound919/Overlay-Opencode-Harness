/**
 * node-shim.ts: run npm/npx-family CLIs on Windows without a shell.
 *
 * Bare `npm.cmd`/`npx.cmd` cannot be spawned without `shell: true`
 * (EINVAL), and shell quoting of argv is fragile. But both shims are just
 * `node <launcher>.js` wrappers, so resolve the launcher once and spawn
 * `node` with a clean argv array — the same trick opencode-adapter.js uses
 * for the opencode shim. On non-Windows platforms (or when resolution
 * fails) callers fall back to the bare command name.
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

export interface ResolvedCommand {
  command: string;
  prefixArgs: string[];
}

/**
 * Resolve a `.cmd` shim (e.g. "npm.cmd") to `node <launcher>` by locating
 * the shim with where.exe and joining the npm-layout launcher path.
 * Returns null on any failure (non-Windows, shim not found, launcher
 * missing) so callers can fall back with a clear error.
 */
export function resolveWindowsShim(shimName: string, launcherRelative: string[]): ResolvedCommand | null {
  if (process.platform !== "win32") return null;
  if (!/\.cmd$/i.test(shimName)) return null;
  try {
    const found = spawnSync("where.exe", [shimName], { encoding: "utf-8", timeout: 10000 });
    const first = String((found && found.stdout) || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (!first) return null;
    const launcher = path.join(path.dirname(first), ...launcherRelative);
    if (!fs.existsSync(launcher)) return null;
    return { command: process.execPath, prefixArgs: [launcher] };
  } catch {
    return null;
  }
}

/** Preferred spawn parts for npm (falls back to the bare name). */
export function npmParts(): ResolvedCommand {
  return (
    resolveWindowsShim("npm.cmd", ["node_modules", "npm", "bin", "npm-cli.js"]) ?? {
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      prefixArgs: []
    }
  );
}

/** Preferred spawn parts for npx (falls back to the bare name). */
export function npxParts(): ResolvedCommand {
  return (
    resolveWindowsShim("npx.cmd", ["node_modules", "npm", "bin", "npx-cli.js"]) ?? {
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      prefixArgs: []
    }
  );
}
