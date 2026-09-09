/**
 * Tests for tool-executor.ts — path rewriting, shadow execution, and the
 * cross-platform grep fallback (stock Windows has no grep binary).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  rewritePathForWorktree,
  executeToolInWorktree,
  nodeGrep
} from "./tool-executor";
import { npmParts } from "./node-shim";
import { initializeTestGitRepo, createWorktree } from "./worktree-manager";

describe("tool-executor", () => {
  describe("rewritePathForWorktree", () => {
    it("maps a session-relative path into the worktree", () => {
      const session = path.join("s");
      const wt = path.join("w");
      const abs_session = path.resolve(session);
      const abs_wt = path.resolve(wt);
      const got = rewritePathForWorktree("src/a.ts", abs_wt, abs_session);
      expect(got).toBe(path.join(abs_wt, "src", "a.ts"));
    });

    it("refuses paths escaping the session root", () => {
      const abs_session = path.resolve("s");
      const abs_wt = path.resolve("w");
      expect(() => rewritePathForWorktree("../evil.ts", abs_wt, abs_session)).toThrow(/outside session root/);
    });
  });

  describe("executeToolInWorktree", () => {
    let parent: string;
    let repo: string;

    beforeEach(async () => {
      parent = fs.mkdtempSync(path.join(os.tmpdir(), "tool-exec-test-"));
      repo = path.join(parent, "repo");
      await initializeTestGitRepo(repo);
    });

    afterEach(() => {
      fs.rmSync(parent, { recursive: true, force: true });
    });

    it("write_file then read_file round-trips inside the worktree only", async () => {
      const wt = await createWorktree(repo, "wt_tool_001");
      try {
        const w = await executeToolInWorktree(wt.path, "write_file", { path: "src/note.txt", content: "hello" }, repo);
        expect(w.exit_code).toBe(0);
        const r = await executeToolInWorktree(wt.path, "read_file", { path: "src/note.txt" }, repo);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe("hello");
        // Base repo untouched (shadow isolation).
        expect(fs.existsSync(path.join(repo, "src", "note.txt"))).toBe(false);
      } finally {
        await wt.cleanup();
      }
    });

    it("grep finds a pattern via binary or Node fallback", async () => {
      const wt = await createWorktree(repo, "wt_tool_002");
      try {
        const r = await executeToolInWorktree(wt.path, "grep", { pattern: "original", path: "src/" }, repo);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toContain("original");
      } finally {
        await wt.cleanup();
      }
    });

    it("grep with no matches returns exit 0 and empty stdout", async () => {
      const wt = await createWorktree(repo, "wt_tool_003");
      try {
        const r = await executeToolInWorktree(wt.path, "grep", { pattern: "zzz_no_such_token_zzz", path: "src/" }, repo);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toBe("");
      } finally {
        await wt.cleanup();
      }
    });

    it("returns an error result for unknown tools (no throw)", async () => {
      const wt = await createWorktree(repo, "wt_tool_004");
      try {
        const r = await executeToolInWorktree(wt.path, "frobnicate", {}, repo);
        expect(r.exit_code).toBe(1);
        expect(r.stderr).toContain("Unknown tool");
      } finally {
        await wt.cleanup();
      }
    });

    it("list_files lists the worktree directory", async () => {
      const wt = await createWorktree(repo, "wt_tool_005");
      try {
        const r = await executeToolInWorktree(wt.path, "list_files", { path: "src" }, repo);
        expect(r.exit_code).toBe(0);
        expect(r.stdout).toContain("payment.ts");
      } finally {
        await wt.cleanup();
      }
    });
  });

  describe("nodeGrep fallback", () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-grep-"));
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "a.ts"), "first line\nneedle here\nlast\n");
      fs.writeFileSync(path.join(dir, "src", "b.ts"), "nothing\n");
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("finds matches in path:line:text form", () => {
      const out = nodeGrep(dir, "needle");
      expect(out).toContain("a.ts:2:needle here");
      expect(out).not.toContain("b.ts");
    });

    it("returns empty string when nothing matches", () => {
      expect(nodeGrep(dir, "zzz_no_such_token_zzz")).toBe("");
    });
  });

  it("npmParts resolves to a runnable node launcher", () => {
    const npm = npmParts();
    expect(npm.command.length).toBeGreaterThan(0);
    if (process.platform === "win32") {
      expect(npm.command).toBe(process.execPath);
      expect(npm.prefixArgs[0]).toMatch(/npm-cli\.js$/);
    }
  });
});
