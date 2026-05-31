# Design — abort/reflog audit follow-ups

## Goal

Close the two no-op reflog divergences the 22.2b audit surfaced and deferred (the
"Neutral" section of ADR-225, the "Out of scope" section of
`abort-noop-reflog-skip.md`). Both are pure git-faithfulness alignment — verified
against real git, no new behaviour invented:

1. **Detached `reset --hard HEAD` no-op writes a spurious `HEAD` reflog entry.**
   `reset`'s symbolic path routes through `updateRef`, which 22.2b gated on a real
   move; its **detached** path does **not** — it calls `recordRefUpdate(HEAD, …)`
   directly, so the central gate never reaches it. On a no-move (`reset --hard HEAD`
   while detached) git writes **no** `HEAD` entry (a detached HEAD is a direct ref →
   *needs-commit* semantics), while tsgit records `reset: moving to HEAD`.

2. **`merge --abort` writes the wrong `HEAD` reflog message.** `abortMerge` logs
   `merge: aborted`; real git logs `reset: moving to HEAD` on the `HEAD` symref
   (`merge --abort` is internally a `reset` to `ORIG_HEAD`). 22.2b's central gate
   already suppresses the **branch** entry (the conflicted merge never moved HEAD,
   so the abort is always a no-move) — only the `HEAD` *message text* is left wrong.

Neither item changes any index/tree/HEAD-value observable; both touch reflog
**message** faithfulness only. The PR adds caller-level gates + cross-tool interop
pins (real git as oracle, scrubbed `GIT_*`).

## What real git writes (verified, not hypothesized)

Reproduced against git 2.x with `GIT_*` scrubbed and signing off:

| no-move operation | `refs/heads/<branch>` reflog | `HEAD` reflog |
|---|---|---|
| `reset --hard HEAD` (**symbolic** HEAD) | **no entry** | `reset: moving to HEAD` |
| `reset --hard HEAD` (**detached** HEAD) | n/a (no branch) | **no entry** |
| `merge --abort` (conflicted) | **no entry** | `reset: moving to HEAD` |

The symbolic vs detached asymmetry is git's ref backend: a symbolic-`HEAD` update
splits into a *needs-commit* branch update (skips its reflog on a no-move) plus a
*log-only* `HEAD` symref update (always logs). A **detached** `HEAD` is a single
**direct** ref under *needs-commit* semantics — when `old == new`, git writes
nothing at all. So the faithful detached rule is "skip the `HEAD` reflog when the
oid is unchanged", the mirror image of the symbolic rule "always log the coupled
`HEAD`".

Contrast cases (so the skip is not over-applied):

| no-move operation | reflog written? |
|---|---|
| detached `reset --hard <other-oid>` (a real **move**) | **writes** `reset: moving to <oid>` |
| `checkout <current-branch>` / `checkout --detach HEAD` | **writes** `checkout: moving from X to X` |

`checkout` logs unconditionally even on a self-move — its path is untouched here.

## What tsgit currently does

### Detached reset (`application/commands/reset.ts`)

```ts
const head = await readHeadRaw(ctx);
const reflogMessage = `reset: moving to ${opts.target}`;
if (head.kind === 'symbolic') {
  await updateRef(ctx, head.target, id, { reflogMessage });   // 22.2b-gated
  return { mode: opts.mode, id, branch: head.target };
}
await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${id}\n`);
await recordRefUpdate(ctx, 'HEAD' as RefName, head.id, id, reflogMessage); // UNGATED
return { mode: opts.mode, id, branch: undefined };
```

`recordRefUpdate` self-gates only on the `core.logAllRefUpdates` autocreate rule,
never on whether the ref moved — so the detached no-move call records a spurious
entry.

### Merge abort (`application/commands/abort-merge.ts`)

```ts
await updateRef(ctx, head.target, origHead, { reflogMessage: 'merge: aborted' });
```

`origHead` always equals the current tip (a conflicted merge never advances HEAD),
so 22.2b's gate already skips the **branch** entry; the coupled-`HEAD` log fires
with the wrong message `merge: aborted` where git writes `reset: moving to HEAD`.

## Decision

### Part 1 — gate the detached-reset `HEAD` reflog at the caller

Skip `recordRefUpdate` when the oid is unchanged; keep the `HEAD` file write
unconditional:

```ts
await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${id}\n`);
if (head.id !== id) {
  await recordRefUpdate(ctx, 'HEAD' as RefName, head.id, id, reflogMessage);
}
return { mode: opts.mode, id, branch: undefined };
```

The gate lives in the **caller** (`reset`), not in `recordRefUpdate`. The writer
cannot distinguish the two `HEAD` semantics — the symref-split *log-only* "keep"
(which `updateRef`'s `logCoupledHead` relies on) from this direct-`HEAD`
*needs-commit* "skip" — so a blanket gate in the writer would wrongly drop the
symbolic `reset: moving to HEAD` that git **does** write. Only the caller knows
which semantics apply. This mirrors ADR-225's option-A reasoning (the symbolic gate
lives in `updateRef`, not the writer) and matches the backlog's explicit
prescription "caller-level gate".

The `writeUtf8` stays unconditional: rewriting `.git/HEAD` with byte-identical
content (`${id}\n`) on a no-move is observably indistinguishable from git (same 41
bytes), exactly as ADR-225 kept `atomicWriteRef` unconditional for the symbolic
path. The oid-based gate (`head.id !== id`, not `opts.target !== 'HEAD'`) is the
faithful semantics: `reset --hard <oid-equal-to-current>` is just as much a no-move
as `reset --hard HEAD`, and git skips both.

**Considered alternative — route the detached path through `updateRef(ctx, 'HEAD',
id, …)`** to inherit the central gate instead of duplicating it. Feasible
(`looseRefPath(gitDir, 'HEAD')` → `.git/HEAD`, `validateRefName('HEAD')` passes,
`logCoupledHead` early-returns since `HEAD` is direct, so no double-log), but it
swaps the detached write mechanism from a plain `writeUtf8` to `atomicWriteRef`
(lock-file + rename) — a larger, behaviour-adjacent change for a message-only fix,
and `updateRef` is modelled around branch refs with HEAD coupling, not HEAD-as-the-
written-ref. Rejected for this PR on KISS/minimal-blast-radius grounds; the
unification is reconsidered in the architecture-refactor pass (Step 7) and, if not
taken, logged as a backlog follow-up rather than smuggled into the feature diff.

### Part 2 — align the merge-abort `HEAD` message

Change the reflog message from `merge: aborted` to `reset: moving to HEAD`:

```ts
await updateRef(ctx, head.target, origHead, { reflogMessage: 'reset: moving to HEAD' });
```

The literal `HEAD` (not the resolved oid) is what git writes — `merge --abort`
delegates to a `reset` whose rev argument is the symbolic `HEAD`, so the `%gs`
subject reads `reset: moving to HEAD`. No branch entry appears (22.2b's no-move
gate); only the coupled-`HEAD` message changes. `abortMerge` already rejects a
detached HEAD upstream (`unsupportedOperation`), so the symbolic-only path is the
sole case.

## Audit — are any other callers still divergent?

The 22.2b audit enumerated every `updateRef` caller. This PR closes the two it
flagged as out-of-scope; re-confirming nothing else regresses:

- **`checkout` detached HEAD write** — also a direct `recordRefUpdate(HEAD, …)`, but
  git logs `checkout: moving from X to Y` **unconditionally** (even a self-move), so
  no gate belongs there. Untouched.
- **`commit` / `clone`** direct HEAD writes — always a genuine move (a new commit
  oid, a freshly-fetched tip); the no-move case is unreachable. Untouched.
- **symbolic `reset` / abort paths / `fetch` / `push`** — already gated centrally by
  22.2b. Untouched.

No further divergence remains in the abort/reset/reflog family after this PR.

## Faithfulness pins

Cross-tool interop, real git as oracle, scrubbed-`GIT_*` readback via
`topReflogSubject` (`git log -g --format=%gs`, reads whichever `.git/logs` the dir
holds):

1. **Detached no-move** (`reset-interop.test.ts`): seed two date-pinned commits in
   both repos, detach HEAD to the tip in both (`git checkout --detach` / `repo.checkout
   { detach: true }`), capture each tool's `HEAD` reflog top, then `reset --hard HEAD`
   on both. Assert each tool's `HEAD` reflog top is **unchanged by the reset**
   (before == after) — neither git nor tsgit appends a `reset: moving to` entry. The
   before/after-per-tool form isolates the reset gate from any unrelated
   `checkout`-message formatting difference (tsgit's detach label is the oid, git's
   may be `HEAD`), which a cross-tool top-equality assertion would spuriously couple
   to.
2. **Detached move** (`reset-interop.test.ts`): same seed, detached at the tip, then
   `reset --hard <c0>` on both → assert both write the identical
   `reset: moving to <c0>` `HEAD` entry (guards the gate from over-skipping a real
   move — kills the `head.id !== id` → `false` mutant).
3. **Merge abort** (new `merge-abort-interop.test.ts`): build the same conflicting
   merge via real git in both repos (date-pinned, identical SHAs), conflict on both
   (`git merge` / `repo.merge`), abort on both (`git merge --abort` /
   `repo.abortMerge`). Assert the `HEAD` reflog top is the identical
   `reset: moving to HEAD` and the branch reflog top is unchanged on both.

## Test conventions

GWT describe/it split, AAA body, `sut` variable, 100% line/branch/function/
statement coverage held, 0 killable mutants. Unit tests isolate each gate:

- `reset.test.ts` — detached no-move skips the `HEAD` reflog (kill the `head.id !==
  id` boundary + `!==`→`===` mutants with a paired no-move-skip / move-writes test);
  detached move still records.
- `abort-merge.test.ts` — the `HEAD` reflog top reads `reset: moving to HEAD`
  exactly (specific string assertion kills the `StringLiteral` mutant; never a
  type-only check).

These are message/`StringLiteral`-sensitive, so assertions read the exact reflog
subject, never just "an entry exists".

## Files touched

- `src/application/commands/reset.ts` — gate the detached-`HEAD` reflog on
  `head.id !== id`.
- `src/application/commands/abort-merge.ts` — `merge: aborted` →
  `reset: moving to HEAD`.
- `test/unit/application/commands/reset.test.ts` — detached no-move skip + move
  records.
- `test/unit/application/commands/abort-merge.test.ts` — assert the
  `reset: moving to HEAD` `HEAD` reflog message.
- `test/integration/reset-interop.test.ts` — detached no-move + detached-move
  reflog parity pins.
- `test/integration/merge-abort-interop.test.ts` (new) — merge-abort `HEAD` message
  parity pin.
- `docs/BACKLOG.md` — flip 22.2c to done.
