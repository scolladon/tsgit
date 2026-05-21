# Git Hooks — Design (Phase 17.2)

> Status: Draft. Backlog item **17.2** — "Hooks (`pre-commit`, `commit-msg`,
> `pre-push` invocation contract; opt-in for the security model)". ADRs
> 065–068.

## 1. Goal & scope

Git lets a repository hang executable scripts off `.git/hooks/`; named hooks
fire at fixed points in `commit`, `push`, and friends. A non-zero exit aborts
the operation. Phase 17.2 delivers the **three highest-value hooks** through a
new hexagonal port:

1. **`pre-commit`** — runs before a commit is built; a non-zero exit aborts
   `commit`. May modify `.git/index` (formatters that re-stage).
2. **`commit-msg`** — runs on the proposed commit message; may rewrite it; a
   non-zero exit aborts `commit`.
3. **`pre-push`** — runs before `push` uploads anything; receives the refs
   being moved on stdin; a non-zero exit aborts `push`.

Hooks are executable scripts. tsgit is portable (Node + browser) and
hexagonal, so script execution is confined to a new **`HookRunner` port**
([ADR-065](../adr/065-hook-runner-port.md)): the Node adapter spawns the real
`.git/hooks/*` scripts via `node:child_process`; the browser has no runner and
hooks are inert; the memory adapter takes an injectable runner for tests.

### Explicitly out of scope

- Every other hook: `post-commit`, `prepare-commit-msg`, `pre-merge-commit`,
  `post-checkout`, `post-merge`, `pre-rebase`, `update`, `post-receive`, the
  `applypatch-*` family, etc. The port and the `runHook` primitive are built so
  a future phase adds one by extending the `HookName` union and inserting one
  call — no structural change.
- `merge`'s own hooks. `merge` writes refs directly and never routes through
  `commit`; git fires `pre-merge-commit` there, which is out of scope. A user
  who *resolves a conflicted merge* with `commit` does get `pre-commit` /
  `commit-msg`, exactly as git.
- A bundled POSIX shell for Windows. tsgit spawns the hook directly; an
  extensionless `#!/bin/sh` hook needs a shell on `PATH`, the same constraint
  git itself carries on Windows ([ADR-068](../adr/068-windows-hook-execution.md)).
- Hook timeouts. Git does not time hooks out; neither do we. `ctx.signal`
  cancels a running hook (§8.1).

## 2. The `HookRunner` port — `src/ports/hook-runner.ts`

A new port. Pure interface, zero implementation. The contract is "resolve the
named hook file, and if it exists and is runnable, spawn it" — nothing
git-specific leaks in; the adapter knows only files and processes.

### 2.1 `HookName` lives in the domain

`HookName` is referenced by **both** this port and the `HOOK_FAILED` domain
error (§4). A port may import domain (`ports/context.ts` already imports
`RefName` from `domain/objects`); domain may **not** import a port. So the
shared name is a tiny domain module — `src/domain/hooks/hook-name.ts`, barrelled
through `src/domain/hooks/index.ts` and re-exported from `src/domain/index.ts`:

```ts
// src/domain/hooks/hook-name.ts
/** The lifecycle hooks tsgit invokes. Extend the union to add a hook. */
export type HookName = 'pre-commit' | 'commit-msg' | 'pre-push';
```

### 2.2 The port

```ts
// src/ports/hook-runner.ts
import type { HookName } from '../domain/hooks/index.js';

export interface HookRequest {
  /** Hook to run. */
  readonly name: HookName;
  /** Absolute directory holding hook scripts — `core.hooksPath` or `${gitDir}/hooks`. */
  readonly hooksDir: string;
  /** Working directory for the spawned process — the working-tree root. */
  readonly workDir: string;
  /** Absolute `.git` directory — exported to the hook env as `GIT_DIR`. */
  readonly gitDir: string;
  /** Positional arguments (e.g. the `COMMIT_EDITMSG` path for `commit-msg`). */
  readonly args: ReadonlyArray<string>;
  /** Bytes piped to the hook's stdin. Empty string ⇒ stdin closed empty. */
  readonly stdin: string;
  /** Cancels a running hook — the adapter kills the child when it aborts. */
  readonly signal?: AbortSignal;
}

export type HookResult =
  /** Hook file absent or not executable — nothing ran (a success, like git). */
  | { readonly kind: 'skipped' }
  /** Hook ran to completion. */
  | {
      readonly kind: 'ran';
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    };

export interface HookRunner {
  /**
   * Resolve `${hooksDir}/${name}`; when it exists and is executable, spawn it
   * with `args`, `stdin`, `cwd = workDir`, and `GIT_DIR` in the environment.
   * Resolves with the exit code and captured output. NEVER rejects for a
   * non-zero exit — interpreting the exit code is the caller's policy.
   */
  readonly run: (request: HookRequest) => Promise<HookResult>;
}
```

The port is **stateless**: every fact it needs is in the `HookRequest`. The
`runHook` primitive (§6) — which holds `ctx.layout` and the parsed config —
fills the request. A stateless port is trivial to fake and means the Node /
memory adapters take no constructor arguments.

`HookResult` separates `skipped` (no hook file, or present-but-not-executable —
both are git's "no hook, proceed") from `ran` (carries the real `exitCode`).
The caller never has to guess whether `exitCode 0` meant "passed" or "absent".

## 3. Context addition — `Context.hooks`

```ts
export interface Context {
  // …existing ports…
  /** Optional hook runner. Absent ⇒ hooks are inert (browser, or opted out). */
  readonly hooks?: HookRunner;
}
```

`hooks` is **optional**, like `config` / `logger` / `signal`. Its absence is
the natural "no hooks" state — the browser adapter simply never sets it.
`CreateContextParts` gains the same optional field; `createContext` already
spreads `...parts`, so no code change there — only the type.

## 4. New error — `HOOK_FAILED`

A new `CommandError` variant (`src/domain/commands/error.ts`, importing
`HookName` from the sibling `domain/hooks` module — domain→domain, allowed):

```ts
| {
    readonly code: 'HOOK_FAILED';
    readonly hook: HookName;
    readonly exitCode: number;
    readonly stderr: string;
  }
```

Factory, with a bounded, sanitised `stderr` — a hook can emit megabytes, and an
unbounded string inside a thrown error is an amplification vector when callers
log or serialise it (mirrors `MAX_CONFLICT_PATHS_IN_ERROR`):

```ts
export const MAX_HOOK_STDERR_IN_ERROR = 4096;

export const hookFailed = (
  hook: HookName,
  exitCode: number,
  stderr: string,
): TsgitError =>
  new TsgitError({
    code: 'HOOK_FAILED',
    hook,
    exitCode,
    stderr: sanitizeForDisplay(stderr).slice(0, MAX_HOOK_STDERR_IN_ERROR),
  });
```

`extractDetail` arm: `` `hook ${data.hook} failed with exit code ${data.exitCode}` ``.

## 5. `config-read` — `core.hooksPath`

`ParsedConfig.core` gains `hooksPath?: string`. `mergeCore` parses the
`hookspath` key (case-insensitive, like its siblings); `finalize` adds the
`hooksPath !== undefined` arm to the `out.core` guard. One key, mechanical —
the same shape as the `excludesFile` field already there.

## 6. The `runHook` primitive — `src/application/primitives/run-hook.ts`

The single chokepoint every command funnels hook invocation through. It owns
config-driven hooks-dir resolution and exit-code policy; it depends on
`readConfig` (same tier) and `ctx.hooks`.

```ts
export interface HookInput {
  readonly args?: ReadonlyArray<string>;
  readonly stdin?: string;
}

/**
 * Run a named git hook. Resolves (no-op) when no `HookRunner` is on the
 * Context, or the hook file is absent / not executable, or the hook exits 0.
 * Throws `HOOK_FAILED` when the hook exits non-zero.
 */
export const runHook = async (
  ctx: Context,
  name: HookName,
  input: HookInput = {},
): Promise<void> => {
  if (ctx.hooks === undefined) return;
  const config = await readConfig(ctx);
  const hooksDir = resolveHooksDir(config.core?.hooksPath, ctx.layout);
  const request: HookRequest = {
    name,
    hooksDir,
    workDir: ctx.layout.workDir,
    gitDir: ctx.layout.gitDir,
    args: input.args ?? [],
    stdin: input.stdin ?? '',
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  };
  const result = await ctx.hooks.run(request);
  if (result.kind === 'skipped') return;
  if (result.exitCode !== 0) throw hookFailed(name, result.exitCode, result.stderr);
};
```

### 6.1 `resolveHooksDir` — pure helper

```ts
/** Resolve the hooks directory: `core.hooksPath` or `${gitDir}/hooks`. */
export const resolveHooksDir = (
  hooksPath: string | undefined,
  layout: RepositoryLayout,
): string;
```

- `hooksPath` undefined → `${layout.gitDir}/hooks`.
- absolute (`/…`, or `~/…` with a known `homeDir`) → used as resolved.
- `~/…` with no `homeDir` → falls back to `${layout.gitDir}/hooks` (the
  expansion source is missing — same defensive stance as the gitignore
  `core.excludesFile` loader).
- relative → resolved against `layout.workDir` (git resolves `core.hooksPath`
  against the working-tree top level).

Pure and clock-free — unit-tested arm by arm.

`runHook` is exported from the primitives barrel and bound on
`repo.primitives.runHook` for advanced callers, the same way `recordRefUpdate`
is exposed.

## 7. Command integration

Both commands gain `readonly noVerify?: boolean` — git's `--no-verify`. When
`true`, the command skips its hook calls entirely (it never reaches `runHook`).

### 7.1 `commit` — `pre-commit` then `commit-msg`

New helpers live in `src/application/commands/internal/commit-hooks.ts` to keep
`commit.ts` lean:

```ts
/** Fire the pre-commit hook unless verification is disabled. */
export const runPreCommitHook = (ctx: Context, noVerify: boolean): Promise<void>;

/**
 * Round-trip the message through the commit-msg hook. Writes `message` to
 * `.git/COMMIT_EDITMSG`, runs the hook with that path as `argv[1]`, re-reads
 * the (possibly rewritten) file, and re-sanitises. No-op (returns `message`
 * unchanged) when verification is disabled or no runner is wired.
 */
export const applyCommitMsgHook = (
  ctx: Context,
  message: string,
  opts: { readonly noVerify: boolean; readonly allowEmptyMessage: boolean },
): Promise<string>;
```

`commit()`'s revised flow (insertions in **bold**):

1. `assertRepository`, `assertNotBare`.
2. `readMergeHead`, `assertNoPendingOperation`.
3. **`runPreCommitHook(ctx, noVerify)`** — before `readIndex`, so a hook that
   re-stages files is picked up by step 7. A non-zero exit throws `HOOK_FAILED`
   here, before any work.
4. `resolveCommitMessage` → `resolved`.
5. `readConfig`, resolve author / committer.
6. `readIndex`, reject unmerged entries.
7. `buildTreeFromIndex`.
8. `readHeadRaw`, derive `parentId` / `parents`.
9. Tree-equality `nothingToCommit` guard.
10. **`message = applyCommitMsgHook(ctx, resolved, { noVerify, allowEmptyMessage })`**
    — after the guard (no point validating a message for a commit that will
    not happen). The hook-rewritten `message` feeds both `commitData` and
    `commitReflogMessage`.
11. `createCommit`, `updateRef` / detached write, `clearMergeState`.

`pre-commit` is placed **before** `readIndex` deliberately: git's `pre-commit`
convention permits a hook to re-stage (a formatter runs, then `git add`s its
edits). Reading the index afterwards honours that. `commit-msg` round-trips
through `.git/COMMIT_EDITMSG` exactly as git does
([ADR-067](../adr/067-commit-msg-editmsg-roundtrip.md)).

### 7.2 `push` — `pre-push`

A `push.ts`-local helper `runPrePushHook(ctx, noVerify, remote, url, movers)`
builds the stdin payload and calls `runHook` — it stays in `push.ts` because it
consumes the file-private `ResolvedRefspec` type. `pre-push` fires after the
refspecs are resolved and the no-op refs filtered out (`movers`), and before
`sendUpdates`:

```
…resolveAllRefspecs → movers …
if (movers.length === 0) return { …, pushedRefs: [] };   // nothing to push
await runPrePushHook(ctx, opts.noVerify ?? false, remoteName, url, movers);
const pushedRefs = await sendUpdates(…);
```

stdin is git's one-line-per-ref format:

```
<local-ref> SP <local-oid> SP <remote-ref> SP <remote-oid> LF
```

- normal update: `<src> <localOid> <dst> <remoteOid>`.
- creating a new remote ref: `<remoteOid>` is `ZERO_OID`.
- delete refspec: local-ref is the literal `(delete)`, local-oid is `ZERO_OID`.

args are `[remoteName, url]`. A non-zero exit throws `HOOK_FAILED` before a
single byte is uploaded. `pre-push` not firing on an up-to-date push (the early
return above) is a deliberate, documented minor divergence — there is nothing
to verify when nothing moves.

## 8. Adapters

### 8.1 Node — `src/adapters/node/node-hook-runner.ts`

`NodeHookRunner implements HookRunner`, stateless:

1. **Resolve & probe.** `scriptPath = nodePath.join(hooksDir, name)`. `lstat`
   it. `ENOENT` or not a regular file → `{ kind: 'skipped' }`. On POSIX, a
   regular file with no executable bit (`(mode & 0o111) === 0`) → `skipped`
   (git's rule). On Windows there is no executable bit — a regular file is
   considered runnable ([ADR-068](../adr/068-windows-hook-execution.md)).
2. **Spawn.** `child_process.spawn(scriptPath, [...args], { cwd: workDir, env:
   { ...process.env, GIT_DIR: gitDir }, stdio: ['pipe','pipe','pipe'] })`.
   Write `stdin`, then `end()` it.
3. **Capture, bounded.** stdout / stderr accumulate up to
   `MAX_HOOK_OUTPUT_BYTES` (1 MiB) per stream; bytes past the cap are dropped
   (a runaway hook cannot exhaust memory).
4. **Cancel.** When `request.signal` aborts, `child.kill()`. A signal-killed
   child resolves as `{ kind: 'ran', exitCode: 128 }` so the caller surfaces
   `HOOK_FAILED` rather than a silent pass.
5. **Resolve.** On `close`: `{ kind: 'ran', exitCode: code ?? 128, stdout,
   stderr }`. On a spawn-level `error` event (e.g. a broken interpreter):
   resolve `{ kind: 'ran', exitCode: 126, stderr: <message> }` — 126 is the
   conventional "found but not executable", so it funnels into `HOOK_FAILED`
   instead of crashing the command.

`NodeHookRunner` holds no resource between calls — it has no `dispose`, so
`disposeAdapters` is unchanged.

### 8.2 Memory — `src/adapters/memory/memory-hook-runner.ts`

`MemoryHookRunner implements HookRunner` — a programmable test double. It is
constructed with a per-hook outcome map (or a default), so unit / integration
tests assert hook-driven behaviour without spawning a process:

```ts
new MemoryHookRunner({
  'pre-commit': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'lint failed' },
});
```

An unmapped hook returns `{ kind: 'skipped' }`. `MemoryAdapterOptions` gains
`hooks?: HookRunner`; absent ⇒ no runner ⇒ hooks inert (the default for the
existing test corpus, so nothing regresses).

### 8.3 Browser

No runner. Browsers cannot spawn processes; `Context.hooks` stays `undefined`
and every command's hook call is a no-op. Documented, not engineered around.

## 9. Facade & runtime wiring — "same as git" default-on

The user's directive ([ADR-066](../adr/066-hooks-default-on.md)): behave like
git. Git runs hooks by default; `--no-verify` skips them. So:

- **`createNodeContext`** (`node-adapter.ts`) — `NodeAdapterOptions` gains
  `hooks?: boolean` (default `true`). Default wires a `NodeHookRunner`;
  `hooks: false` omits it (the security-conscious full opt-out).
- **`index.node.ts`** — `RuntimeFallback` gains `hooks?: HookRunner`; the Node
  shim sets `fallback.hooks = new NodeHookRunner()`.
- **`openRepository`** — `OpenRepositoryOptions.hooks?: HookRunner | false`.
  `undefined` ⇒ use `fallback.hooks` (Node: on). A `HookRunner` ⇒ use it.
  `false` ⇒ no runner ⇒ hooks off. Resolution sits next to the existing
  `config` / `logger` handling:
  `const hooks = opts.hooks === false ? undefined : (opts.hooks ?? fallback.hooks);`
  then `...(hooks !== undefined ? { hooks } : {})` in the ctx spread.
- **Memory / browser shims** — no `fallback.hooks`; hooks inert unless a test
  injects a runner.

The HookRunner is **not** wrapped by `wrapFsValidator` / `wrapTransportValidator`
— it is neither a filesystem nor a transport. `composeAdapters` stays a
four-port merge; `hooks` threads through `RuntimeFallback` / `OpenRepositoryOptions`
directly, exactly as `config` does.

Net effect: a plain `openRepository()` on Node runs `.git/hooks/*` just like
git. A repo with no hook files sees `{ kind: 'skipped' }` on every call — zero
behaviour change, one extra `lstat`. `repo.commit({ …, noVerify: true })` and
`repo.push({ …, noVerify: true })` skip verification.

## 10. Module / file layout

```
src/domain/hooks/hook-name.ts       NEW  — HookName union
src/domain/hooks/index.ts           NEW  — barrel
src/domain/index.ts                 MOD  — re-export domain/hooks
src/domain/commands/error.ts        MOD  — + HOOK_FAILED variant, hookFailed(), MAX_HOOK_STDERR_IN_ERROR
src/domain/error.ts                 MOD  — extractDetail HOOK_FAILED arm

src/ports/hook-runner.ts            NEW  — HookRunner port + HookRequest/HookResult
src/ports/context.ts                MOD  — + hooks?: HookRunner (Context + CreateContextParts)
src/ports/index.ts                  MOD  — export hook-runner types

src/application/primitives/
  run-hook.ts                       NEW  — runHook + resolveHooksDir
  config-read.ts                    MOD  — ParsedConfig.core.hooksPath
  index.ts                          MOD  — export runHook

src/application/commands/
  commit.ts                         MOD  — pre-commit + commit-msg wiring, noVerify
  push.ts                           MOD  — pre-push wiring, noVerify
  internal/commit-hooks.ts          NEW  — runPreCommitHook + applyCommitMsgHook

src/adapters/node/
  node-hook-runner.ts               NEW  — NodeHookRunner
  node-adapter.ts                   MOD  — wire NodeHookRunner (hooks?: boolean)
  index.ts                          MOD  — export NodeHookRunner
src/adapters/memory/
  memory-hook-runner.ts             NEW  — MemoryHookRunner
  memory-adapter.ts                 MOD  — hooks?: HookRunner option
  index.ts                          MOD  — export MemoryHookRunner

src/repository.ts                   MOD  — OpenRepositoryOptions.hooks, RuntimeFallback.hooks,
                                            ctx wiring, repo.primitives.runHook
src/index.node.ts                   MOD  — fallback.hooks = new NodeHookRunner()

README.md DESIGN.md RUNBOOK.md CONTRIBUTING.md   docs refresh
test/fixtures/hooks/*               NEW  — fixture hook scripts (exec bit committed)
```

### Implementation slices (parallelism for the plan)

1. **Port + domain + config** — `hook-runner.ts`, `Context.hooks`,
   `HOOK_FAILED` + `extractDetail`, `config-read` `hooksPath`. Self-contained.
2. **`runHook` primitive** — `run-hook.ts`, `resolveHooksDir`, barrel export.
   Depends on slice 1.
3. **Node adapter** — `NodeHookRunner` + `node-adapter.ts` wiring. Depends on
   slice 1. *(Parallelizable with slices 2 / 4.)*
4. **Memory adapter** — `MemoryHookRunner` + `memory-adapter.ts` wiring.
   Depends on slice 1. *(Parallelizable with slices 2 / 3.)*
5. **Command integration** — `commit-hooks.ts`, `commit.ts`, `push.ts`,
   `noVerify`. Depends on slices 2 + 4.
6. **Facade** — `repository.ts`, `index.node.ts`, `repo.primitives.runHook`.
   Depends on slices 2 + 3.
7. **Docs refresh.** Depends on 5 + 6.

Each slice lands as one or more atomic conventional commits.

## 11. Testing strategy

Per `CLAUDE.md`: 100% line/branch/function/statement coverage, 0 surviving
mutants, Given/When/Then titles, AAA bodies, `sut`.

### Unit

- **`resolveHooksDir`** — every arm: undefined → `${gitDir}/hooks`; absolute;
  `~/` with `homeDir`; `~/` without `homeDir`; relative → `workDir`-anchored.
- **`runHook`** — no runner → no-op; `skipped` → no-op; `exitCode 0` → no-op;
  `exitCode !== 0` → throws `HOOK_FAILED` carrying `hook` / `exitCode` /
  `stderr` (try/catch + `.data` assertions, not `toThrow`); `hooksDir` derived
  from `core.hooksPath`; `args` / `stdin` forwarded verbatim; `ctx.signal`
  forwarded only when present. Isolated guard tests for the
  `skipped`-vs-`exitCode` branch.
- **`hookFailed`** — `stderr` sanitised; `stderr` truncated at
  `MAX_HOOK_STDERR_IN_ERROR` (a `+1`-length input proves the boundary).
- **`extractDetail`** — `HOOK_FAILED` arm.
- **`config-read`** — `hookspath` key parsed (case-insensitive); `finalize`
  emits `core` when only `hooksPath` is set.
- **`MemoryHookRunner`** — mapped outcome returned; unmapped → `skipped`.
- **`commit-hooks`** — `runPreCommitHook` skips when `noVerify`; `applyCommitMsgHook`
  returns the message unchanged when `noVerify` / no runner; writes
  `COMMIT_EDITMSG`, runs the hook, re-reads, re-sanitises otherwise; an
  emptied message re-throws `EMPTY_COMMIT_MESSAGE` unless `allowEmptyMessage`.

### Integration (`test/integration/`)

`NodeHookRunner` spawns real processes — fixture scripts under
`test/fixtures/hooks/` (executable bit committed): `exit-zero`, `exit-nonzero`,
`echo-stdin`, `print-args`, `print-env`, `huge-output`, `sleep`.

- **`NodeHookRunner`** (`posix-only/` for the exec-bit arm) — absent hook →
  `skipped`; non-executable regular file → `skipped` (POSIX); `exit-zero` →
  `ran` exitCode 0; `exit-nonzero` → `ran` exitCode N; stdin delivered
  (`echo-stdin` round-trip); args delivered (`print-args`); `GIT_DIR` and
  `cwd` correct (`print-env`); output capped at `MAX_HOOK_OUTPUT_BYTES`
  (`huge-output`); `signal` abort kills `sleep` and yields a non-zero exit.
- **`commit` + hooks** — `pre-commit` exit 0 → commit proceeds; exit 1 → commit
  aborts with `HOOK_FAILED`, no commit object written; a `pre-commit` that
  re-stages a file → that file lands in the commit tree; `commit-msg` rewrites
  `COMMIT_EDITMSG` → the commit message and the reflog subject reflect the
  rewrite; `commit-msg` exit 1 → abort; `noVerify` skips both; no runner →
  hooks inert.
- **`push` + hooks** — `pre-push` exit 0 → push proceeds; exit 1 → push aborts
  before upload; stdin lines match the `<local-ref> <local-oid> <remote-ref>
  <remote-oid>` format for update / create / delete refspecs (`echo-stdin`
  fixture captures them); `noVerify` skips.
- **Interop** — a hook authored as a normal POSIX shell script behaves under
  `NodeHookRunner` the way it does under canonical `git` (exit-code semantics).

### Mutation

Guard clauses (`ctx.hooks === undefined`, `result.kind === 'skipped'`,
`exitCode !== 0`, the `resolveHooksDir` ladder, the POSIX exec-bit mask) get
isolated per-condition tests. The 1 MiB / 4 KiB caps are pinned with
boundary-length inputs.

## 12. Key design decisions → ADRs

| ADR | Decision |
|-----|----------|
| [065](../adr/065-hook-runner-port.md) | Hooks run through a new `HookRunner` **port**; the Node adapter spawns the real `.git/hooks/*` scripts via `node:child_process`. Chosen over programmatic JS-callback hooks — keeps tsgit git-faithful and hexagonal. |
| [066](../adr/066-hooks-default-on.md) | Hooks run **by default** when a runner is wired ("same as git"). Opt-outs: per-command `noVerify` (git's `--no-verify`) and `createNodeContext({ hooks: false })` / `openRepository({ hooks: false })`. Supersedes the backlog's "opt-in" wording. |
| [067](../adr/067-commit-msg-editmsg-roundtrip.md) | `commit-msg` round-trips the message through `.git/COMMIT_EDITMSG` — write, run hook with the path as `argv[1]`, re-read. Git-faithful; lets a hook rewrite the message. |
| [068](../adr/068-windows-hook-execution.md) | Windows: spawn the hook file directly; no bundled POSIX shell. Native executables and `.bat`/`.cmd` hooks run; extensionless shell-script hooks need a shell on `PATH` — the same constraint git imposes on Windows. |

## 13. Risks & mitigations

- **Arbitrary script execution.** Wiring the runner runs whatever sits in
  `.git/hooks/`. Mitigations: hooks are *not* transferred over the wire — a
  `clone` never imports a remote's hooks, so cloning an untrusted URL brings no
  hostile hook; the trust boundary is exactly git's ("you trust this local
  repo"). The full opt-out (`hooks: false`) covers hardened deployments
  operating on untrusted on-disk repos.
- **`core.hooksPath` traversal.** A crafted `.git/config` can point `hooksPath`
  anywhere on disk. Git has the identical exposure; the HookRunner is not
  rooted by `wrapFsValidator` because it is not a filesystem. Documented as
  git-faithful — trusting `.git/config` is trusting the repo.
- **Environment inheritance.** Hooks inherit `process.env`, including secrets.
  Git-faithful; documented.
- **Output / runaway DoS.** Captured output is capped at 1 MiB per stream in
  the adapter; the `HOOK_FAILED` payload truncates `stderr` to 4 KiB. A hook
  that hangs is killed via `ctx.signal`; no fixed timeout (git-faithful).
- **`pre-commit` config-cache staleness.** A `pre-commit` hook that rewrites
  `.git/config` is not reflected — `readConfig` is `Context`-cached. Vanishingly
  rare; documented, not engineered around (the reflog feature accepts the same).
- **Windows shell-script hooks.** An extensionless `#!/bin/sh` hook will not run
  on Windows without a shell on `PATH`. Same as git-for-Windows' constraint;
  surfaced as `HOOK_FAILED` exitCode 126, not a crash. Documented in
  [ADR-068](../adr/068-windows-hook-execution.md).
- **Breaking `OpenRepositoryOptions` / `NodeAdapterOptions`.** Both gain an
  optional field only — additive, no migration. 17.x targets v2.0 regardless.
