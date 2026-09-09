/**
 * Tests for node-shim.ts — shell-free execution of npm-family CLIs.
 */

import * as fs from "fs";

import { resolveWindowsShim, npmParts, npxParts } from "./node-shim";

describe("node-shim", () => {
  it("returns null for non-shim commands", () => {
    expect(resolveWindowsShim("node", ["x"])).toBeNull();
  });

  it("returns null for a shim that does not exist", () => {
    expect(resolveWindowsShim("definitely-not-a-shim-xyz.cmd", ["x"])).toBeNull();
  });

  it("resolves npm to node+launcher on win32", () => {
    if (process.platform !== "win32") return;
    const r = npmParts();
    expect(r.command).toBe(process.execPath);
    expect(r.prefixArgs).toHaveLength(1);
    expect(r.prefixArgs[0]).toMatch(/npm-cli\.js$/);
    expect(fs.existsSync(r.prefixArgs[0])).toBe(true);
  });

  it("resolves npx to node+launcher on win32", () => {
    if (process.platform !== "win32") return;
    const r = npxParts();
    expect(r.command).toBe(process.execPath);
    expect(r.prefixArgs).toHaveLength(1);
    expect(r.prefixArgs[0]).toMatch(/npx-cli\.js$/);
    expect(fs.existsSync(r.prefixArgs[0])).toBe(true);
  });
});
