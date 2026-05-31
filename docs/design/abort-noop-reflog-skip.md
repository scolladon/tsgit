# Design — no-op abort reflog skip + cherry-pick abort guard mutant

## Goal

Two follow-ups surfaced by 22.2a, both pure git-faithfulness alignment (no new
behaviour invented):

1. **No-op reflog skip.** Real git writes **no branch reflog entry** when
   `cherry-pick --abort` / `revert --abort` resets to the *same* oid the branch
   already points at (a lone conflict, where the branch never moved). tsgit's
   `updateRef` records the entry unconditionally, so both `cherryPick.abort` and
   `revert.abort` emit a spurious `reset: moving to <oid>` branch entry in the
   no-move case. Make the branch reflog write conditional on a real ref move, and
   audit the other `updateRef` callers for the same no-op.

2. **`cherryPickAbort` guard mutant.** A pre-existing `ConditionalExpression`
   survivor on `if (source === undefined && seqHead === undefined)` (mutating
   `seqHead === undefined` → `true`). 22.2a hypothesized it provably equivalent
   ("the distinguishing state is unreachable for cherry-pick"). It is **not** —
   confirm reachability and kill it.

The `abortSequencerReset` extraction (22.2b item 3 in the backlog) is **deferred
to 22.3**: it is a rule-of-three trigger that needs `rebase --abort` as the third
consumer before the shared helper is justified. Extracting it now (two consumers)
would be speculative. It is left tracked, not done here.

## Part 1 — no-op reflog skip (verified, not hypothesized)

### What real git writes (the asymmetry 22.2a missed)

Verified against git 2.x with `GIT_*` scrubbed and signing off. A `--abort` (and
plain `reset`) updates the symbolic `HEAD`; git's ref backend splits that into two
updates with **different reflog semantics**:

| no-move operation | `refs/heads/<branch>` reflog | `HEAD` reflog |
|---|---|---|
| `cherry-pick --abort` (lone conflict) | **no entry** | `reset: moving to <oid>` |
| `revert --abort` (lone conflict) | **no entry** | `reset: moving to <oid>` |
| `reset --hard HEAD` (symbolic) | **no entry** | `reset: moving to HEAD` |
| `merge --abort` (conflicted) | **no entry** | `reset: moving to HEAD` |

The branch ref follows git's *needs-commit* rule — when `old == new` nothing is
written (neither the ref nor its reflog). The `HEAD` symref-split is *log-only* —
it logs the move **unconditionally**, even when the oid does not change. So the
faithful behaviour is **not** "skip the reflog when `old == new`"; it is "skip the
**direct ref's** reflog when `old == new`, but always log the coupled `HEAD`".

22.2a's design doc characterized the lone case as "git writes no reflog entry (the
ref value is unchanged)" — correct for the *branch* it inspected, but it overlooked
that `HEAD` still records `reset: moving to <oid>`. A blanket
`if (oldId === newId) return` in the single reflog writer would wrongly drop the
`HEAD` entry too.

For contrast (so the skip is not over-applied):

| no-move operation | reflog written? |
|---|---|
| `reset --hard HEAD` (**detached** HEAD) | **no** `HEAD` entry (direct ref, needs-commit) |
| `checkout <current-branch>` | **writes** `HEAD: checkout: moving from X to X` |

### What tsgit currently does

`updateRef` (`application/primitives/update-ref.ts`) writes the loose ref, then
records the direct ref's reflog, then logs the coupled `HEAD`:

```
await atomicWriteRef(ctx, name, refPath, content);
await recordRefUpdate(ctx, name, oldId, newId, options.reflogMessage);   // direct ref
await logCoupledHead(ctx, store, name, oldId, newId, options.reflogMessage); // HEAD if HEAD→name
```

`recordRefUpdate` is the single reflog writer; it self-gates only on the
`core.logAllRefUpdates` autocreate rule, never on whether the ref moved. So a
no-move call writes a spurious direct-ref entry. `logCoupledHead` calls the same
writer for `HEAD`.

### Decision — gate the direct-ref reflog in `updateRef`, keep `logCoupledHead`

Skip the **direct ref's** reflog when `oldId === newId`; leave the loose-ref write
and `logCoupledHead` unconditional:

```
const oldId = current.kind === 'direct' ? current.id : ZERO_OID;
const content = new TextEncoder().encode(`${newId}\n`);
await atomicWriteRef(ctx, name, refPath, content);
if (oldId !== newId) {
  await recordRefUpdate(ctx, name, oldId, newId, options.reflogMessage);
}
await logCoupledHead(ctx, store, name, oldId, newId, options.reflogMessage);
```

This mirrors git's reflog semantics: a no-move direct update records no reflog
entry, while the `HEAD` symref-split log-only update always logs. The gate lives in
`updateRef` — **not** in `recordRefUpdate` — because the writer cannot distinguish
the two `HEAD` cases (symref log-only "keep" vs direct-HEAD needs-commit "skip");
only the caller knows the semantics, and in `updateRef` both calls are visible.

The backlog scopes the fix to the **reflog** write, so `atomicWriteRef` stays
unconditional: rewriting the loose ref with byte-identical content on a no-move is
observably indistinguishable from git (same 41 bytes), and git's matching
write-skip is an internal optimisation, not observable state. The one place it
*would* be observable — re-materialising a packed-only ref as loose — is
unreachable on the abort paths (the branch ref is always loose mid-sequence). The
`expected` CAS check runs before the gate, so compare-and-swap is preserved;
`delete` returns earlier and is unaffected.

**Why central, not abort-path-only.** The same no-op is reachable from every
`updateRef` caller. A single central fix in `updateRef` covers both abort paths *and* the
audited siblings (`merge --abort` — always no-move; `reset --hard HEAD` symbolic;
an up-to-date `fetch`/`push` tracking-ref update) in one behaviour-preserving
change, and keeps the move cases byte-identical. An abort-path-only guard would
leave the same divergence latent in those callers and duplicate the check.

### Audit of `updateRef` callers (the backlog's "audit other callers" clause)

- **cherry-pick / revert `abort`** — `requireSymbolicHead` guarantees a symbolic
  HEAD; no-move (lone conflict) now skips the branch entry, keeps `HEAD`. Move
  (range committed a pick) is `old != new`, unchanged + already interop-pinned.
- **`abort-merge`** — resets to `ORIG_HEAD`, which equals the current tip
  (HEAD never moves during a conflicted merge), so it is *always* no-move; now
  skips the branch entry, keeps `HEAD`. (Its `HEAD` message text — `merge: aborted`
  vs git's `reset: moving to <oid>` — is a separate, pre-existing gap, logged as a
  follow-up, not fixed here.)
- **`reset` (symbolic HEAD)** — `reset --hard HEAD` becomes faithful (skip branch,
  keep `HEAD`). Move resets unchanged.
- **`fetch` / `push`** — an up-to-date tracking-ref update is no-move; the
  tracking ref has no `HEAD` coupling, so it now writes nothing, matching git.
- **`branch` / `tag` / `remote` / `commit` / `merge`** — create (`old = absent`),
  delete (early return), or a genuine move; never the no-move case.

### Out of scope (audit found, logged as follow-ups, not in this PR)

- **Detached `reset --hard HEAD`** writes a spurious `HEAD` reflog entry. This is a
  *different* writer (`reset` calls `recordRefUpdate(HEAD, …)` directly, not via
  `updateRef`) and a different semantics (detached HEAD is a direct ref →
  needs-commit → git skips). `reset` is not part of the abort/sequencer family the
  feature touches; fixing it needs its own caller-level gate + interop pin.
- **`abort-merge` `HEAD` message** — `merge: aborted` should be
  `reset: moving to <oid>` to match git.

Both are recorded in `docs/BACKLOG.md`; neither balloons this PR.

### Faithfulness pin

22.2a deliberately did not add the lone (no-move) abort to interop "because the
no-op-skip gap … would make tsgit and git disagree there until the separate
follow-up lands". That follow-up is this PR, so the pin is added:
`cherry-pick-interop` and `revert-interop` each get a lone-conflict case that drives
the abort through real git and tsgit over the same seed, then asserts both agree —
the branch reflog top entry is **unchanged** (no `reset: moving to`) and the `HEAD`
reflog top entry is the identical `reset: moving to <full-oid>` (real git as
oracle, scrubbed-`GIT_*` readback). The move case keeps its existing pin.

## Part 2 — `cherryPickAbort` guard mutant (reachable → kill, not equivalent)

### The mutant

```
if (source === undefined && seqHead === undefined) {   // source = CHERRY_PICK_HEAD, seqHead = sequencer head
  throw noOperationInProgress('cherry-pick');
}
```

Stryker mutates `seqHead === undefined` → `true`, reducing the guard to
`source === undefined`. It is killed iff a reachable state has
`source === undefined` (no `CHERRY_PICK_HEAD`) **and** `seqHead !== undefined`
(sequencer present): there the original proceeds with the abort, the mutant throws.

### Why it is reachable (22.2a's hypothesis was wrong)

22.2a reasoned the state is unreachable because cherry-pick's stops (conflict /
empty) always set `CHERRY_PICK_HEAD`, "unlike revert's markerless empty-stop". It
overlooked the **merge-no-mainline partial-apply** path. In `runSequence`:

```
if (isMergeCommit(cData)) {
  if (seq.multiPick) await writeSequencerStop(ctx, seq, todo.slice(i), ourId, opts);
  throw cherryPickMergeNoMainline(source);   // sequencer persisted, NO CHERRY_PICK_HEAD
}
```

A multi-pick range whose work-list reaches a merge commit (no `-m`) persists the
sequencer (head + todo) and throws `CHERRY_PICK_MERGE_NO_MAINLINE` **without**
setting `CHERRY_PICK_HEAD` (the comment is explicit: "no CHERRY_PICK_HEAD, since it
never started"). The user then runs `cherryPick.abort` to unwind — exactly
`source === undefined && seqHead !== undefined`. This is the same shape already
covered for `revert` by the existing test "Given a sequence that committed earlier
reverts before stopping" (`revert.test.ts`), which is why the *revert* guard mutant
is already killed and only the *cherry-pick* one survives.

`-n` / `--no-commit` cannot produce the state: `runNoCommit` never persists a
sequencer and never sets `CHERRY_PICK_HEAD`, even on conflict.

### Decision — kill with the merge-no-mainline abort test

Add a `cherryPickAbort` test mirroring the revert analog: a multi-pick range
(`A..B`) that commits one pick then stops at a merge commit (no mainline), leaving
the sequencer with no `CHERRY_PICK_HEAD`; `abort` must succeed, reset to the
pre-sequence head, and clear the sequencer. The mutant makes `abort` throw
`NO_OPERATION_IN_PROGRESS`, so the test fails on the mutant — killed, no
`// equivalent-mutant` suppression.

## Test conventions

GWT describe/it split, AAA body, `sut` variable, 100% line/branch/function/
statement coverage held, 0 killable mutants. New `updateRef` unit tests isolate the
asymmetry (branch skipped on no-move; `HEAD` kept on no-move) so the gate's
`!==`, conditional-boundary, and `logCoupledHead`-unconditional mutants all die.
The interop pins reuse the suites' scrubbed-`GIT_*` real-git-as-oracle readback.

## Files touched

- `src/application/primitives/update-ref.ts` — gate the direct-ref reflog on
  `oldId !== newId`; keep `logCoupledHead` unconditional.
- `test/unit/application/primitives/update-ref.test.ts` — no-move branch-skip +
  HEAD-kept assertions.
- `test/unit/application/commands/cherry-pick.test.ts` — flip the lone-abort
  assertion to faithful (branch unchanged, `HEAD` gets `reset: moving to`); add the
  merge-no-mainline abort mutant-killer.
- `test/unit/application/commands/revert.test.ts` — flip the lone-abort assertion
  to faithful.
- `test/unit/application/commands/abort-merge.test.ts` — update if it asserted a
  no-move branch entry.
- `test/integration/cherry-pick-interop.test.ts`,
  `test/integration/revert-interop.test.ts` — add the lone (no-move) abort
  reflog-parity pin.
- `docs/BACKLOG.md` — flip 22.2b (items 1 + 3 done, item 2 deferred to 22.3); log
  the detached-reset and `merge --abort` message follow-ups.
