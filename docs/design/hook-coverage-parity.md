# Hook coverage parity — Design (24.8)

> Status: Draft. Backlog item **24.8** — "Hook coverage parity — `post-commit`,
> `post-merge`, `post-checkout`, `prepare-commit-msg`, `pre-rebase`,
> `post-rewrite`, server-side hooks. Layers over the 17.2 hook runner." Extends
> the Phase 17.2 hook subsystem (`design/hooks.md`, ADRs 065–068). ADRs 299–301.

## 1. Goal & scope

Phase 17.2 delivered three lifecycle hooks (`pre-commit`, `commit-msg`,
`pre-push`) through the `HookRunner` port, and built the `runHook` primitive +
`HookName` union so that **"a future phase adds one by extending the `HookName`
union and inserting one call — no structural change"** (`design/hooks.md` §1).
24.8 cashes that in: the six remaining client-side lifecycle hooks tsgit's
command surface can fire.

| Hook | Fires from | Class | git args / stdin |
|------|-----------|-------|------------------|
| `prepare-commit-msg` | `commit` | blocking | args `<editmsg-path> <source>` |
| `commit-msg` *(17.2)* | `commit` | blocking | args `<editmsg-path>` |
| `post-commit` | `commit` | informational | none |
| `post-merge` | `merge` (FF + clean true-merge; via `pull`) | informational | args `<squash-flag>` |
| `post-checkout` | `checkout` (switch + path-restore) | informational | args `<old-head> <new-head> <branch-flag>` |
| `pre-rebase` | `rebase` (run only) | blocking | args `<upstream>` |
| `post-rewrite` | `rebase` (finish) | informational | args `rebase`; stdin `<old> <new>` lines |

**Blocking** hooks (`pre-*`, `prepare-commit-msg`, `commit-msg`) abort their
operation on a non-zero exit — they route through the existing throwing
`runHook`. **Informational** hooks (`post-*`) cannot abort a completed
operation; git ignores their exit code (emitting only a warning). They route
through a new non-throwing sibling, `runInformationalHook` (§4).

### 1.1 Explicitly out of scope

- **Server-side hooks** (`pre-receive`, `update`, `post-receive`,
  `post-update`, `push-to-checkout`). tsgit is a **git client library**: it has
  no `receive-pack` server, so these hooks have **no firing site**. Building a
  server is a separate phase (Phase 25 transport territory, not 24.8). Decided
  in [ADR-299](../adr/299-server-side-hooks-out-of-scope.md).
- **`commit --amend` / `am` family** (`applypatch-msg`, `pre-applypatch`,
  `post-applypatch`) and **`pre-merge-commit`**. tsgit has no `--amend`, no
  `am`, and `merge` writes its commit directly (never through `git commit`), so
  `pre-merge-commit` has no analogue — exactly as documented in 17.2's scope
  (`design/hooks.md` §1). `post-rewrite`'s `amend` source therefore never fires;
  only its `rebase` source does.
- **`clone`'s initial `post-checkout`.** git fires `post-checkout` after a
  clone's checkout, but tsgit (like git) never transfers a remote's hooks, and a
  freshly-created repo has only the non-executable `*.sample` hooks — so the
  call would be **observationally inert** (always `skipped`). There is no point
  in the program where a user could install a hook before clone's own checkout.
  Omitted as inert; documented, not a divergence ([ADR-301](../adr/301-informational-hook-semantics.md)).
- **`pre-auto-gc`, `fsmonitor-watchman`, `sendemail-validate`.** No `gc`, no
  fsmonitor, no `send-email` in tsgit.
- **Hook timeouts** and the **arbitrary-script-execution trust boundary** are
  unchanged from 17.2 (`design/hooks.md` §13) — the same port, same `ctx.signal`
  cancellation, same `core.hooksPath` exposure.

## 2. The `HookName` union extension

`src/domain/hooks/hook-name.ts` is the single source of truth. The union widens
by six literals — the only domain change:

```ts
export type HookName =
  | 'pre-commit'
  | 'prepare-commit-msg'
  | 'commit-msg'
  | 'post-commit'
  | 'post-merge'
  | 'post-checkout'
  | 'pre-rebase'
  | 'post-rewrite';
```

Ordered by lifecycle (commit family, then merge / checkout / rebase) for
readability. This widens `HookRequest.name` and the `HOOK_FAILED` error's
`hook` field — both **additive**, no breaking change. `reports/api.json`
regenerates (the union literals are part of the public type surface, as the
existing three already are).

Nothing else in the port, the adapters' spawn/probe logic, the `resolveHooksDir`
resolver, or the `HOOK_FAILED` factory needs to change — the 17.2 machinery is
hook-name-agnostic by construction.

## 3. Informational vs blocking — the exit-code contract

git's lifecycle hooks split cleanly:

- **Blocking** (`pre-commit`, `prepare-commit-msg`, `commit-msg`, `pre-push`,
  `pre-rebase`): a non-zero exit **aborts** the operation before it mutates any
  ref / object / state file. tsgit throws `HOOK_FAILED` — the existing
  `runHook` behaviour.
- **Informational** (`post-commit`, `post-merge`, `post-checkout`,
  `post-rewrite`): the operation has **already completed** (refs moved, objects
  written, working tree materialised). git runs the hook and **ignores its exit
  code** — at most it prints a warning. tsgit cannot meaningfully abort a
  finished operation without violating git-faithfulness (the SHAs / refs /
  state are already the faithful end state), so it runs the hook and discards
  the exit code. This is **not** a swallowed error: the port never rejects, the
  hook ran to completion, and ignoring the exit code is the git-faithful policy
  ([ADR-301](../adr/301-informational-hook-semantics.md)).

`post-checkout` deserves a note: git's docs say its exit status "becomes the
exit status of `git checkout`", but the checkout itself is **not undone**. tsgit
is a library with no process exit code to propagate and a structured result
that already reflects the faithful end state, so the informational treatment
holds — the observable on-disk state (HEAD, index, working tree) is identical
whether the hook exits 0 or 1.

## 4. Runner refactor — `runInformationalHook`

`src/application/primitives/run-hook.ts` grows a non-throwing sibling. The
shared "resolve runner, read config, build request, invoke" body is extracted
into a module-private `invokeHook` returning the raw `HookResult | undefined`
(`undefined` ⇒ no runner wired); the two public entry points layer exit-code
policy on top:

```ts
/** Resolve `ctx.hooks`, build the request, invoke. `undefined` ⇒ no runner. */
const invokeHook = async (
  ctx: Context,
  name: HookName,
  input: HookInput,
): Promise<HookResult | undefined> => {
  const runner = ctx.hooks;
  if (runner === undefined) return undefined;
  const config = await readConfig(ctx);
  const request: HookRequest = {
    name,
    hooksDir: resolveHooksDir(config.core?.hooksPath, ctx.layout),
    workDir: ctx.layout.workDir,
    gitDir: ctx.layout.gitDir,
    args: input.args ?? [],
    stdin: input.stdin ?? '',
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  };
  return runner.run(request);
};

/** Blocking hook — throws `HOOK_FAILED` on a non-zero exit (unchanged contract). */
export const runHook = async (ctx, name, input = {}): Promise<void> => {
  const result = await invokeHook(ctx, name, input);
  if (result === undefined || result.kind === 'skipped') return;
  if (result.exitCode !== 0) throw hookFailed(name, result.exitCode, result.stderr);
};

/**
 * Informational (`post-*`) hook — fire-and-forget. git ignores a post-hook's
 * exit code (it cannot abort a completed operation), so neither does tsgit:
 * absent runner / skipped / any exit code → no throw, no return value.
 */
export const runInformationalHook = async (ctx, name, input = {}): Promise<void> => {
  await invokeHook(ctx, name, input);
};
```

`runInformationalHook` is exported from the primitives barrel for the command
layer; it is **not** bound on `repo.primitives` (YAGNI — `repo.primitives.runHook`
already gives advanced callers a raw, policy-free-ish entry, and a post-hook is
fired by the command, not the user). The behaviour change to `runHook` is nil:
the extracted `invokeHook` preserves every guard (no-runner short-circuit,
`skipped` no-op, non-zero throw) byte-for-byte.

## 5. Command integration

### 5.1 `commit` — `prepare-commit-msg` (new) + `post-commit` (new)

The 17.2 `commit-msg` round-trip is generalised. `commit-hooks.ts`'s
`applyCommitMsgHook` becomes `applyCommitMessageHooks`, which round-trips
`COMMIT_EDITMSG` through **both** message hooks in git's order:

```
write COMMIT_EDITMSG
  → prepare-commit-msg <path> <source>   (ALWAYS — not gated by --no-verify)
  → re-read
  → commit-msg <path>                    (gated by --no-verify)
  → re-read
  → sanitise
```

Key faithfulness point: **`--no-verify` bypasses only `pre-commit` and
`commit-msg`** (per `git commit` docs) — `prepare-commit-msg` runs regardless.
So `prepare-commit-msg` is gated on the runner existing, **not** on `noVerify`;
`commit-msg` keeps its `noVerify` gate.

The `<source>` argument is git's message source. tsgit has no `-t`/`commit.template`
(→ never `template`), no `SQUASH_MSG` (→ never `squash`), and no
`-c`/`-C`/`--amend` (→ never `commit` + sha). The only two reachable sources:

- `merge` — when `MERGE_MSG` exists / it is a merge resolution. tsgit reaches
  this when resolving a conflicted **merge / cherry-pick / revert** with
  `commit()` (the `usePendingDraft` condition already computed in
  `resolveCommitMessage`: `mergeHead || cherryPickHead || revertHead`).
- `message` — every other commit (a message was supplied programmatically).

So no third (sha) argument is ever passed — faithful, since tsgit has no source
that carries one.

`post-commit` fires **after** the ref/HEAD update and `clearResolvedState`,
right before `commit()` returns — no args, informational. It fires for every
successful commit, including merge / cherry-pick / revert resolutions (git fires
`post-commit` on those too, since they go through `git commit`).

`commit()` flow with insertions in **bold**:

1. `assertRepository`, `assertNotBare`, pending-marker checks.
2. `runPreCommitHook(ctx, noVerify)` *(17.2)*.
3. … resolve message, identity, build tree, parents, nothing-to-commit guard …
4. **`message = applyCommitMessageHooks(ctx, resolved, { noVerify, allowEmptyMessage, source })`**
   — `prepare-commit-msg` then (unless `noVerify`) `commit-msg`.
5. `createCommit`, `updateRef` / detached write, `clearResolvedState`.
6. **`runInformationalHook(ctx, 'post-commit')`**.

### 5.2 `merge` — `post-merge` (new)

git: `post-merge` fires after `git merge` (and `git pull`'s internal merge)
**updates the working tree** — both fast-forward and clean true-merge — and is
**not** run on a conflict or an "Already up to date" no-op. Its single argument
is a squash flag; tsgit has no `--squash`, so it is always `0`.

`mergeRun` returns `up-to-date` / `fast-forward` / `merge` / `conflict`. The
fire is a **single chokepoint**: after the merge computation yields its result,
fire `post-merge` iff `result.kind` is `fast-forward` or `merge`. The current
`mergeRun` body (asserts + the FF / true-merge / conflict dispatch) is extracted
into a `computeMerge` helper; `mergeRun` wraps it:

```ts
export const mergeRun = async (ctx, opts, internal = {}): Promise<MergeResult> => {
  const result = await computeMerge(ctx, opts, internal);
  if (result.kind === 'fast-forward' || result.kind === 'merge') {
    await runInformationalHook(ctx, 'post-merge', { args: [SQUASH_FLAG_OFF] });
  }
  return result;
};
```

`SQUASH_FLAG_OFF = '0'` is a named module constant. Because `pull` delegates to
`mergeRun`, `git pull`'s `post-merge` is covered for free — no `pull` change.

### 5.3 `checkout` — `post-checkout` (new)

git: `post-checkout` fires after the worktree is updated, with
`<prev-head-sha> <new-head-sha> <flag>` where `flag` is `1` for a **branch
checkout** (HEAD moves) and `0` for a **file checkout** (path restore, HEAD
unchanged). Informational.

- `switchBranch` → `[oldOid, oid, BRANCH_FLAG]` (`BRANCH_FLAG = '1'`). `oldOid`
  is the pre-switch HEAD oid (already resolved), `oid` the new target. Fired
  once after the HEAD move, before returning, for both the detached and the
  branch sub-paths (a single fire site at the end of `switchBranch`, reached by
  refactoring the two `return`s into one tail).
- `pathRestore` → `[head, head, FILE_FLAG]` (`FILE_FLAG = '0'`) — HEAD does not
  move, so prev == new. Fired after the restore materialises (the main path,
  `pathSet.size > 0`). The zero-glob-match early return changes nothing on disk
  and does not fire (documented edge — git's behaviour there is moot for a
  no-op).

### 5.4 `rebase` — `pre-rebase` (new) + `post-rewrite` (new)

**`pre-rebase`** (blocking): fires in `rebaseRun` **after `assertCleanWorkTree`**
(so a dirty-worktree refusal keeps git's precedence) and **before any state
mutation** (`writeOrigHead` / detach / replay) — placed before `mergeBase` so it
covers **both** the plain and the interactive path (which branch off later) and
the up-to-date short-circuit. A non-zero exit throws `HOOK_FAILED`, aborting the
rebase before it touches a ref — faithful. It fires for **`rebaseRun` only**; the
resumption verbs (`continue` / `skip` / `abort`) are not a fresh rebase and do
not re-fire it. Args: `[input.upstream]` — git passes `<upstream> [<branch>]`,
and tsgit always rebases the current HEAD (no explicit branch operand), so only
the upstream operand is passed (the upstream commit-ish string verbatim). The
exact ordering relative to the clean-worktree refusal and the up-to-date
short-circuit is **pinned by interop against canonical git** (§9), not guessed —
whatever real `git` does on `pre-rebase exit 1` over an up-to-date / dirty repo,
tsgit matches.

**`post-rewrite`** (informational): fires once at **rebase finish** with arg
`rebase` and stdin one `<old-sha> SP <new-sha> LF` line per replayed commit —
exactly the `rewritten` pairs tsgit already accumulates (and persists to
`.git/rebase-merge/rewritten-list`, which is literally what canonical git feeds
the hook on stdin). Both finish sites — `replayFrom` (plain) and
`replayInteractive` (interactive) — already hold the `rewritten` array and call
`finishRebase(...)` + `clearRebaseState(...)`. A shared
`firePostRewrite(ctx, rewritten)` helper, invoked at both sites between
`finishRebase` and `clearRebaseState`, fires the hook **iff `rewritten.length > 0`**
(no rewrites → no notification, faithful — e.g. an all-cherry-equivalent-drop
rebase). Stdin lines are built by a small pure `rewrittenStdin(pairs)` helper.

`post-rewrite` is **not** fired by `cherry-pick` / `revert` (git only fires it
for `rebase` and `commit --amend`).

## 6. Adapters

No adapter change. The Node / memory runners are hook-name-agnostic — they
resolve `${hooksDir}/${name}` and spawn whatever is there. The `MemoryHookRunner`
already records every `HookRequest` on its `calls` array, so the new wirings'
`name` / `args` / `stdin` are asserted in unit / integration tests without a
real process. The browser stays runner-less (every new call a no-op), unchanged.

## 7. Facade & wiring

No facade change beyond the (automatic) `repo.primitives.runHook` accepting the
widened `HookName`. `runInformationalHook` stays internal to the application
layer. No new `Context` field, no new port method, no `OpenRepositoryOptions`
change.

## 8. Module / file layout

```
src/domain/hooks/hook-name.ts                       MOD  — +6 union literals

src/application/primitives/run-hook.ts              MOD  — extract invokeHook; + runInformationalHook
src/application/primitives/index.ts                 MOD  — export runInformationalHook

src/application/commands/internal/commit-hooks.ts   MOD  — applyCommitMessageHooks (prepare-commit-msg), PrepareCommitMsgSource
src/application/commands/commit.ts                  MOD  — source arg; post-commit fire
src/application/commands/merge.ts                   MOD  — extract computeMerge; post-merge fire; SQUASH_FLAG_OFF
src/application/commands/checkout.ts                MOD  — post-checkout fires (switch + path-restore); BRANCH_FLAG/FILE_FLAG
src/application/commands/rebase.ts                  MOD  — pre-rebase fire; firePostRewrite + rewrittenStdin

reports/api.json                                    MOD  — regenerated (HookName widened)

test/unit/application/primitives/run-hook.test.ts   MOD  — runInformationalHook arms
test/unit/.../commit-hooks.test.ts                  MOD  — prepare-commit-msg round-trip, source, --no-verify gate
test/integration/hooks-*.test.ts                    NEW/MOD — real-process firings
test/integration/.../*-interop.test.ts              NEW/MOD — cross-tool parity vs canonical git
docs/design/hook-coverage-parity.md                 NEW  — this doc
docs/adr/299..301                                   NEW
README.md RUNBOOK.md CONTRIBUTING.md docs/use/*      MOD  — hook list refresh
```

### Implementation slices (TDD order)

1. **Union + runner** — widen `HookName`; extract `invokeHook`; add
   `runInformationalHook` + barrel export + unit tests. Self-contained.
2. **`commit`** — `applyCommitMessageHooks` (prepare-commit-msg, source,
   `--no-verify` gate) + `post-commit`. Depends on 1.
3. **`merge`** — `computeMerge` extraction + `post-merge`. Depends on 1.
4. **`checkout`** — `post-checkout` (switch + path-restore). Depends on 1.
5. **`rebase`** — `pre-rebase` + `post-rewrite` (`firePostRewrite`,
   `rewrittenStdin`). Depends on 1.
6. **Interop** — cross-tool parity suites (one per hook family) reconstructing
   canonical git's firing + args / stdin / exit semantics. Depends on 2–5.
7. **api.json + docs.** Depends on 1–6.

Slices 2–5 are mutually independent (different commands) and parallelizable
after slice 1; each lands as one atomic conventional commit.

## 9. Testing strategy

Per `CLAUDE.md`: 100% line/branch/function/statement, 0 killable mutants, GWT
titles, AAA bodies, `sut`.

### Unit

- **`runInformationalHook`** — no runner → no-op (no throw); `skipped` → no-op;
  `exitCode 0` → no-op; **`exitCode !== 0` → still no-op (no throw)** — the
  defining contrast with `runHook`, pinned by a `MemoryHookRunner` mapped to a
  non-zero outcome asserting it resolves and `calls` recorded the fire; `args` /
  `stdin` / `hooksDir` forwarded verbatim; `ctx.signal` forwarded only when
  present. Isolated guard tests for the no-runner short-circuit.
- **`runHook`** — unchanged contract re-pinned after the `invokeHook` extraction
  (the existing arms must still pass).
- **`applyCommitMessageHooks`** — `prepare-commit-msg` runs even when
  `noVerify` (the load-bearing faithfulness arm); `commit-msg` skipped when
  `noVerify`; both run otherwise; source `merge` vs `message` selected
  correctly; an empty re-read re-throws `EMPTY_COMMIT_MESSAGE` unless
  `allowEmptyMessage`; no runner → message unchanged, no file write.
- **`rewrittenStdin`** — empty → `''`; one pair → `<old> <new>\n`; multi-pair
  order preserved; boundary on the trailing newline.
- The flag constants (`SQUASH_FLAG_OFF`, `BRANCH_FLAG`, `FILE_FLAG`) are pinned
  by the integration / interop assertions on the recorded `args`.

### Integration (`MemoryHookRunner` recording + Node real-process)

Per command, assert the hook fired with the right `name` / `args` / `stdin`,
and that a **blocking** hook's non-zero exit aborts while an **informational**
hook's non-zero exit does **not**:

- `commit`: `prepare-commit-msg` fires with `[editmsg, 'message']` (and
  `'merge'` on a merge resolution); fires even under `noVerify`; a non-zero
  `prepare-commit-msg` aborts (no commit object written); `post-commit` fires
  after a successful commit with no args; a non-zero `post-commit` does **not**
  abort (the commit stands).
- `merge`: `post-merge` fires `['0']` on FF and on clean true-merge; does **not**
  fire on up-to-date or conflict; non-zero `post-merge` does not abort.
- `checkout`: `post-checkout` fires `[old, new, '1']` on branch switch (and
  detached), `[head, head, '0']` on path restore; non-zero does not abort.
- `rebase`: `pre-rebase` fires `[upstream]` and a non-zero exit aborts before any
  ref moves; `post-rewrite` fires `['rebase']` with the `<old> <new>` stdin lines
  after a finished rebase (plain + interactive + a continue-after-conflict path);
  does not fire on an up-to-date / no-rewrite rebase.

### Interop (cross-tool parity vs canonical `git`)

The prime directive: pin the **observable git behaviour** with a hook authored
as a real POSIX script run under both `git` and tsgit (signing off, scrubbed
`GIT_*`). Reconstruct, from tsgit's recorded firing, the exact args / stdin /
fire-or-skip decision canonical git makes:

- A `post-merge` script that records `$1` → identical (`0`) after FF + merge,
  silent after up-to-date / conflict.
- A `post-checkout` script recording `$1 $2 $3` → identical old/new/flag after a
  branch switch and a path restore.
- A `pre-rebase` script that `exit 1` → both `git rebase` and tsgit abort with
  no ref movement; an `exit 0` script lets both proceed identically.
- A `post-rewrite` script recording stdin → identical `<old> <new>` line set
  after a rebase (compared as a set, since oid pairs are deterministic given
  fixed identities/timestamps).
- A `prepare-commit-msg` script that rewrites `$1` → the committed message and
  reflog subject reflect the rewrite identically; a `commit-msg` after it also
  rewrites → both apply in order.

### Mutation

Guard clauses get isolated per-condition tests: the `runInformationalHook`
no-runner short-circuit; the `post-merge` `kind === 'fast-forward' || kind === 'merge'`
disjunction (separate FF-only and merge-only tests); the `firePostRewrite`
`rewritten.length > 0` guard (a zero-length and a one-length case); the
`prepare-commit-msg` "always, even under noVerify" branch (a `noVerify: true`
test asserting `prepare-commit-msg` *did* fire while `commit-msg` did *not*).
The flag string literals (`'0'` / `'1'`) are killed by the interop arg
assertions.

## 10. Key decisions → ADRs

| ADR | Decision |
|-----|----------|
| [299](../adr/299-server-side-hooks-out-of-scope.md) | Server-side hooks (`pre-receive`/`update`/`post-receive`/`post-update`) are **out of scope** — tsgit has no `receive-pack` server, so they have no firing site; a server is a separate phase. |
| [300](../adr/300-extend-hook-name-union.md) | The six new hooks ship by **extending the `HookName` union + inserting calls**, exactly as 17.2's port was designed for — no new port, Context field, or adapter change. |
| [301](../adr/301-informational-hook-semantics.md) | **Informational (`post-*`) hooks ignore their exit code** (non-throwing `runInformationalHook`), git-faithful; `prepare-commit-msg` runs even under `--no-verify`; `clone`'s `post-checkout` is omitted as observationally inert. |

## 10a. Architecture pass

Behaviour-preserving structural review of what the feature diff reaches — a
**no-op**. The six new firings each sit at their command's lifecycle point with
command-local arguments (`merge` result kind, checkout old/new oids, the rebase
rewritten-pair list), exactly as the pre-existing `pre-commit` / `commit-msg` /
`pre-push` sites do — the extension path 17.2 was built for (ADR-300). A shared
hook registry was already weighed and rejected there (the args are command-local
state no table could hold); the per-command flag/label constants are distinct
command semantics, not shared literals (cross-command literal consolidation is
26.1's remit, and these are not shared). Hexagonal layering is intact: domain
`HookName` → primitive `runHook`/`runInformationalHook` → command call sites →
adapter spawn. The two `post-checkout` sites in `checkout` were considered for a
3-arg passthrough helper and left inline (trivial bodies; KISS over a cosmetic
wrapper, unlike `rebase`'s `firePreRebase`/`firePostRewrite`, which carry real
logic — the guard and the rewritten-list serialisation).

## 11. Risks & mitigations

- **Arbitrary script execution / `core.hooksPath` traversal / env inheritance.**
  Unchanged from 17.2 (`design/hooks.md` §13). Wiring more hooks runs more of
  what already sits in `.git/hooks/`; the trust boundary ("you trust this local
  repo") and the `hooks: false` full opt-out are identical. No new attack
  surface — same port, same adapter, no new input parsing.
- **`post-rewrite` stdin amplification.** The stdin is `O(commits replayed)`
  lines of `40 + 1 + 40 + 1` bytes — bounded by the rebase todo length, which is
  itself bounded by reachable history. No unbounded user-controlled growth.
- **`computeMerge` extraction regressing `merge`'s mutation-tested invariants.**
  Behaviour-preserving: the extracted body is the verbatim current `mergeRun`
  body; the wrapper only adds the post-fire. Re-validated by the full merge
  suite + 100% mutation on `merge.ts`.
- **`prepare-commit-msg` writing `COMMIT_EDITMSG` on the `noVerify` path.** When
  a runner is wired, the message now round-trips through `COMMIT_EDITMSG` even
  under `noVerify` (so `prepare-commit-msg` can run). The re-read + sanitise is
  idempotent for an unmodified file, so the committed message is unchanged when
  no hook edits it. When no runner is wired (browser), `COMMIT_EDITMSG` is not
  written — status quo, unchanged.
```
