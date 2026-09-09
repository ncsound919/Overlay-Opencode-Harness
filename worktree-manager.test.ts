/**
 * Tests for worktree-manager.ts — isolated shadow worktrees via git.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

import { createWorktree, getDiffsFromWorktree, initializeTestGitRepo } from "./worktree-manager";

describe("worktree-manager", () => {
  let repo: string;
  let parent: string;

  beforeEach(async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-"));
    repo = path.join(parent, "repo");
    await initializeTestGitRepo(repo);
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("creates a worktree and cleans it up", async () => {
    const wt = await createWorktree(repo, "wt_unit_001");
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(fs.existsSync(path.join(wt.path, "src", "payment.ts"))).toBe(true);
    await wt.cleanup();
    expect(fs.existsSync(wt.path)).toBe(false);
    // cleanup is idempotent
    await wt.cleanup();
  });

  it("isolates writes: worktree edits do not touch the base repo", async () => {
    const wt = await createWorktree(repo, "wt_unit_002");
    try {
      fs.writeFileSync(path.join(wt.path, "src", "payment.ts"), "// shadow edit\n");
      expect(fs.readFileSync(path.join(repo, "src", "payment.ts"), "utf-8")).toBe("// original content\n");
    } finally {
      await wt.cleanup();
    }
  });

  it("extracts tracked diffs", async () => {
    const wt = await createWorktree(repo, "wt_unit_003");
    try {
      fs.writeFileSync(path.join(wt.path, "src", "payment.ts"), "// changed\n");
      const diffs = await getDiffsFromWorktree(wt.path, repo);
      expect(diffs.map((d) => d.path)).toContain("src/payment.ts");
      const entry = diffs.find((d) => d.path === "src/payment.ts")!;
      expect(entry.diff).toContain("+// changed");
      expect(entry.content).toContain("// changed");
    } finally {
      await wt.cleanup();
    }
  });

  it("extracts untracked new files", async () => {
    const wt = await createWorktree(repo, "wt_unit_004");
    try {
      fs.writeFileSync(path.join(wt.path, "src", "brand-new.ts"), "export const x = 1;\n");
      const diffs = await getDiffsFromWorktree(wt.path, repo);
      expect(diffs.map((d) => d.path)).toContain("src/brand-new.ts");
    } finally {
      await wt.cleanup();
    }
  });

  it("removes the worktree from git bookkeeping after cleanup", async () => {
    const wt = await createWorktree(repo, "wt_unit_005");
    await wt.cleanup();
    const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo }).toString();
    expect(list).not.toContain("wt_unit_005");
  });

  it("throws for a non-git directory", async () => {
    const plain = path.join(parent, "plain");
    fs.mkdirSync(plain, { recursive: true });
    await expect(createWorktree(plain, "wt_bad")).rejects.toThrow();
  });
});
