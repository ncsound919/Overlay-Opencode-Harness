/**
 * path-confinement.test.ts — regression tests for the shadow-execution
 * path-confinement audit (see AUDIT.md, findings F1–F3).
 *
 * Two of these tests encode the FIXED behavior and are expected to FAIL on
 * pre-fix code:
 *   - "rejects an absolute path on a different drive" (Windows-only; F1)
 *   - "refuses to write through a symlink pointing outside the worktree" (F3)
 * The rest lock in behavior that is already correct today.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { rewritePathForWorktree, executeToolInWorktree } from "./tool-executor";

describe("path confinement (audit F1–F3)", () => {
  let parent: string;
  let session_root: string;
  let worktree: string;

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), "confinement-test-"));
    session_root = path.join(parent, "session");
    worktree = path.join(parent, "wt");
    fs.mkdirSync(path.join(session_root, "src"), { recursive: true });
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("rewrites an in-scope relative path into the worktree", () => {
    const out = rewritePathForWorktree("src/payment.ts", worktree, session_root);
    expect(out).toBe(path.join(worktree, "src", "payment.ts"));
  });

  it("rejects '..' traversal outside the session root", () => {
    expect(() =>
      rewritePathForWorktree("../escape.ts", worktree, session_root)
    ).toThrow(/outside session root/i);
  });

  it("rejects an absolute path that resolves outside the session root", () => {
    const sibling = path.join(parent, "outside", "evil.ts");
    expect(() =>
      rewritePathForWorktree(sibling, worktree, session_root)
    ).toThrow(/outside session root/i);
  });

  // F1: on Windows, path.relative() returns a different-drive or UNC target
  // unchanged (i.e. absolute) — it never starts with "..". Purely lexical, so
  // no D: drive needs to exist; only meaningful on win32.
  const itWindows = process.platform === "win32" ? it : it.skip;
  itWindows("rejects an absolute path on a different drive (F1)", () => {
    const sessionDrive = path.parse(session_root).root.toUpperCase();
    const otherDrive = sessionDrive.startsWith("C:") ? "D:" : "C:";
    const evil = `${otherDrive}\\confinement-escape-${Date.now()}\\evil.ts`;
    expect(() =>
      rewritePathForWorktree(evil, worktree, session_root)
    ).toThrow(/outside session root/i);
  });

  // F3: containment is lexical; a symlink inside the worktree that points
  // outside turns an in-scope-looking write into an out-of-tree write.
  it("refuses to write through a symlink pointing outside the worktree (F3)", async () => {
    const outsideDir = path.join(parent, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });

    let linked = true;
    try {
      fs.symlinkSync(outsideDir, path.join(worktree, "link"), "dir");
    } catch {
      linked = false; // platforms without symlink privilege (e.g. unelevated Windows)
    }
    if (!linked) {
      console.warn("symlink unavailable; skipping F3 assertion");
      return;
    }

    await expect(
      executeToolInWorktree(
        worktree,
        "write_file",
        { path: "link/pwned.txt", content: "audit-escape" },
        session_root
      )
    ).rejects.toThrow(/outside|symlink|escape|refus/i);

    expect(fs.existsSync(path.join(outsideDir, "pwned.txt"))).toBe(false);
  });
});
