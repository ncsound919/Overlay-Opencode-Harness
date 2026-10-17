# Security & Correctness Audit — Overlay OpenCode Harness

**Date:** 2026-09-09
**Scope:** all 44 files at repo root (14 source modules, 13 test files, mocks, docs)
**Method:** static review of the source modules, tests, and the two design docs.

## Findings at a glance

| # | Severity | File | Finding |
|---|----------|------|---------|
| F1 | High | `tool-executor.ts` | Windows absolute paths (different drive / UNC) escape session-root confinement in `rewritePathForWorktree` |
| F2 | Medium | `admission-gate.ts` | Same `startsWith("..")`-only confinement check in `normalizePath` |
| F3 | Medium | `tool-executor.ts` | No symlink/realpath containment — writes through committed symlinks escape the worktree |
| F4 | Low | `opencode-harness.ts` | `executable.split(" ")` misparses quoted paths and paths containing spaces |
| F5 | Low | `check-opencode.js`, `mock-opencode.test.ts` | `execFile("opencode.cmd --version", { shell: true })` — whole-string command with a shell |
| F6 | Docs | `opencode-settlement-integration.md` | Reference implementation teaches the unguarded `String.replace` path rewrite |

---

## F1 — Windows absolute-path escape in `rewritePathForWorktree` (High)

Current guard in `tool-executor.ts`:

```ts
const relative_to_session = path.relative(session_root, absolute_under_session);
if (relative_to_session.startsWith("..")) {
  throw new ToolExecutionError(
    `Path '${original_path}' resolves outside session root '${session_root}'; refusing to rewrite`
  );
}
```

`path.relative()` only returns a `..`-prefixed result when the target is outside the
root **on the same drive**. On Windows, when the agent-supplied absolute path is on a
different drive (`D:\...`) or is a UNC share (`\\host\share\...`), `path.relative`
returns the target unchanged — an absolute path that never starts with `".."`. The
guard passes, the subsequent `session_root → worktree_root` replacement silently
no-ops, and `fs.writeFileSync(target, ...)` writes to an arbitrary absolute path with
the harness's privileges. POSIX is unaffected (crossing the root always yields `..`).

**Patch:**

```diff
   const relative_to_session = path.relative(session_root, absolute_under_session);
-  if (relative_to_session.startsWith("..")) {
+  if (relative_to_session.startsWith("..") || path.isAbsolute(relative_to_session)) {
     throw new ToolExecutionError(
       `Path '${original_path}' resolves outside session root '${session_root}'; refusing to rewrite`
     );
   }
```

---

## F2 — Same gap in `admission-gate.ts` `normalizePath` (Medium)

The gate uses the identical `startsWith("..")`-only check:

```ts
const relative = path.relative(working_tree_root, normalized);

// Prevent escaping the working tree with ..
if (relative.startsWith("..")) {
  throw new Error(`Path escape attempt: ${file_path} resolves outside working tree`);
}
```

Downstream scope matching makes this mostly fail-closed today (a `D:\...` path won't
match scoped file patterns), but the admission gate is the load-bearing control of the
whole architecture — harden it identically so the invariant holds regardless of what
downstream code does:

```diff
   // Prevent escaping the working tree with ..
-  if (relative.startsWith("..")) {
+  if (relative.startsWith("..") || path.isAbsolute(relative)) {
     throw new Error(`Path escape attempt: ${file_path} resolves outside working tree`);
   }
```

---

## F3 — Symlink traversal out of the worktree (Medium)

Containment is purely lexical: no `symlink` / `lstat` / `realpath` handling exists
anywhere in the repo. If the audited repository contains a committed symlink (e.g.
`docs -> /etc` or `vendor -> $HOME`), an in-scope-looking write such as
`docs/pwned.txt` passes both the admission gate and the rewrite guard, and
`fs.writeFileSync` follows the symlink and writes outside the worktree.

**Patch** (in `execWriteFile` and any other write path, after rewriting):

```ts
const parentDir = path.dirname(target);
fs.mkdirSync(parentDir, { recursive: true });

// Resolve the real parent and re-verify containment under the real worktree root.
const realParent = fs.realpathSync(parentDir);
const realWorktree = fs.realpathSync(worktree_path);
const relFromWorktree = path.relative(realWorktree, realParent);
if (relFromWorktree.startsWith("..") || path.isAbsolute(relFromWorktree)) {
  throw new ToolExecutionError(
    `Refusing to write through symlink escaping the worktree: ${target}`
  );
}

// And refuse to overwrite an existing symlink outright.
if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
  throw new ToolExecutionError(`Refusing to write through symlink: ${target}`);
}
```

---

## F4 — `executable.split(" ")` in `opencode-harness.ts` (Low)

`spawnOpenCode` splits the executable string on spaces so `"node script.js"` works. A
path containing spaces (`C:\Program Files\...`) or quoted arguments mis-splits
silently. Prefer accepting `string[]` from callers, or a minimal tokenizer that honors
double quotes.

---

## F5 — `execFile` with whole-string command + `shell: true` (Low)

`check-opencode.js` and `mock-opencode.test.ts`:

```js
execFile("opencode.cmd --version", { timeout: 30000, shell: true }, done);
```

The string is a constant, so it is not injectable — but it is exactly the pattern the
rest of the codebase (`node-shim.ts`, `opencode-adapter.js`) deliberately avoids.
Prefer the repo's own node+launcher resolution, or `spawn` with an argv array.

---

## F6 — Documentation teaches the unguarded pattern (Docs)

`opencode-settlement-integration.md` shows the reference path-rewrite as:

```ts
return final_path.replace(session_root, worktree_root);
```

with no confinement guard. Anyone implementing from the doc reproduces F1 and F3.
Update the doc to match the hardened implementation (the `isAbsolute` check plus the
realpath re-verification).

---

## Verified strengths (keep doing these)

- **Model is a pure proposer:** the adapter injects `OPENCODE_PERMISSION` deny-all on
  every `opencode run` child; the harness remains the sole executor. Deny-all is
  strictly stronger than user config, so injecting it cannot weaken operator rules.
- **No hardcoded secrets:** repo-wide search for token/secret/password/api_key returns
  zero hits. Live keys come from an external Keywire vault file; values are withheld
  from logs.
- **All `JSON.parse` of agent/ledger/contract input is wrapped** in try/catch with
  explicit, located error messages.
- **Subprocess lifecycle is sound:** stdin EOF first, then SIGTERM, escalating to
  SIGKILL after a grace period; safe on already-exited processes.
- **Doom-loop circuit breaker** denies repeated identical actions without spending
  further shadow executions.
- **Fail-closed trust store:** enum-validated autonomy class, repo-fingerprint
  binding, corrupt-file fallback; settlement depth is deliberately class-invariant
  ("the safety floor never lowers as trust rises").
- **Contracts are sha256-pinned** and version-checked; malformed ledger entries throw
  with line numbers.
- POSIX `..` traversal was already guarded in both the gate and the executor — this
  audit extends the same invariant to absolute `path.relative` results.

## Trust assumptions worth documenting in the README

- The pinned contract is trusted policy: `probe-runner` executes the acceptance-criteria
  commands from the contract. Whoever authors the contract gets code execution inside
  the shadow worktree.
- `run-live-phoenix.js` reads key material from the operator's local Keywire directory;
  keep that path outside the repo and out of CI artifacts.

## Test coverage added in this branch

`path-confinement.test.ts`:

1. In-scope relative rewrite sanity check.
2. `..` traversal rejected (locks current behavior).
3. Absolute sibling path rejected (locks current behavior).
4. **Windows-only:** different-drive absolute path rejected — fails before the F1 fix.
5. **Symlink-in-worktree write rejected** — fails before the F3 fix.
