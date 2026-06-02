# Design — interactive-rebase faithfulness + robustness follow-ups

## Goal

Close the two open follow-ups surfaced by 22.4's mutation grind on
`rebase --interactive` (`design/rebase-interactive.md`). Both are scoped,
behaviour-correcting changes to `application/commands/rebase.ts`; neither widens
the public surface.

1. **Unrelated-history rebase divergence.** `rebaseRun` refuses a no-common-ancestor
   rebase with `UNSUPPORTED_OPERATION` ("no common ancestor between HEAD and
   upstream"). Canonical `git rebase <unrelated>` *succeeds* — an empty
   merge-base replays the whole branch onto the upstream, exactly as `merge`
   treats unrelated histories as an add-add merge against the empty tree. The
   refusal is a prime-directive divergence (ADR-226), pre-existing since 22.3,
   undocumented.
2. **Empty reword/squash message rejected mid-replay.** An inline `reword` /
   `squash` message that cleans to empty currently throws `EMPTY_COMMIT_MESSAGE`
   from `stepReword` / `meldGroupMember` *after* HEAD has detached, leaving a
   partial, un-abortable rebase (no `rebase-merge/` state was persisted). The
   reword-without-message case is already rejected upfront in `planInteractive`;
   the empty-message case must join it.

## Faithfulness is the prime directive (ADR-226)

Verified against real `git` (`GIT_*` scrubbed, `commit.gpgsign=false`) on an
orphan-branch repo:

```
main:    base ── m1            (6026154 → 106691e)
feature: f0 ── f1   (orphan)   (8e17e75 → 904dc70)   merge-base = ∅

$ git rebase main          # HEAD on feature
Rebasing (1/2)(2/2) Successfully rebased and updated refs/heads/feature.

feature: base ── m1 ── f0' ── f1'      (all four files present in the tip tree)
HEAD reflog:  rebase (start): checkout main
              rebase (pick): feature root      ← f0' now has parent = m1
              rebase (pick): feature one
              rebase (finish): returning to refs/heads/feature
feature reflog: rebase (finish): refs/heads/feature onto 106691e…
```

The replayed root `f0'` carries `parent 106691e` (= `m1`): the root commit's
empty parent makes its replay a 3-way merge with **base = the empty tree**,
`ours = onto`, `theirs = f0` — the same add-add path `merge` and `cherry-pick`
already drive through `applyMergeToWorktree` when a parent is absent. The reflog
strings, finish dance, and single-parent shape are **exactly** what the existing
`detachHead` / `replayFrom` / `finishRebase` emit. The only blockers are the
explicit `base === undefined` refusal and the `base: ObjectId` typing.

## Item 1 — replay against the empty-tree base

### The decision tree already degrades correctly

`rebaseRun` resolves `[base] = await mergeBase(ctx, [upstream, headCommit])`.
Unrelated histories → `base === undefined`. Tracing the rest of the function
with `base` undefined:

| check | with `base === undefined` | result |
|---|---|---|
| `onto === base` (up-to-date) | `onto` is a resolved oid, never `undefined` → `false` | not up-to-date ✓ |
| `commitsToReplay(base, head)` | exclusion walk seeded from `[undefined]` | **must guard** |
| `dropCherryEquivalents(…, base, upstream)` | delegates to `commitsToReplay(base, upstream)` | **must guard** |
| `planInteractive(…, base, head)` (candidates) | delegates to `commitsToReplay(base, head)` | **must guard** |
| root-commit replay (`mergeUnderLock`) | `parents[0] === undefined` → `baseTree = undefined` | already faithful ✓ |
| `leadingFold` (interactive) | root's `parents[0] (undefined) !== onto` → fold stops at 0 | whole branch replays ✓ |

So the only mechanical change is making `commitsToReplay` accept
`base: ObjectId | undefined`: when `undefined`, the excluded set is empty and the
walk yields the whole `head` history — the literal meaning of `∅..head`. The
refusal block is deleted; `base` is threaded as `ObjectId | undefined` through
`dropCherryEquivalents`, `InteractivePlan.base`, `rebaseRunInteractive`, and
`planInteractive`.

### Why the empty-base root replay is already correct

`mergeUnderLock` computes `baseTree = parentId !== undefined ? treeOf(parentId)
: undefined` and hands `undefined` to `applyMergeToWorktree`. That primitive is
the same one `merge` uses for unrelated histories (`merge.ts` → `computeMergeTreeResult(…,
undefined)`) and `cherry-pick` uses to pick a root commit. It runs the add-add
merge: paths present on only one side are taken; paths present on both with
divergent content conflict. No new domain code — the root-commit branch of
`mergeUnderLock` simply becomes *reachable* from rebase for the first time
(in the related case the root is always an ancestor of the merge-base, so it was
never in the replay set).

### Cherry-equivalent drop across unrelated histories

`dropCherryEquivalents` patch-ids `base..upstream` (= all of `upstream` when
`base` is `undefined`) and drops any `toReplay` commit whose patch-id matches —
git's default cherry-pick-equivalent skip. Unrelated branches rarely collide,
but the comparison is run unconditionally, faithful to git, and harmless when
nothing matches.

## Item 2 — reject empty reword/squash messages upfront

### Where the throw escapes today

- `stepReword`: `sanitizeMessage(inst.message ?? cData.message, { allowEmpty: false })`
- `meldGroupMember` (group end): `sanitizeMessage(group.inline ?? stripComments(template), { allowEmpty: false })`

Both run during the replay, *after* `detachInteractive` has moved HEAD and reset
the worktree. A message that `stripspace`s to empty throws `EMPTY_COMMIT_MESSAGE`
there, leaving a detached HEAD with no `rebase-merge/` state → the caller cannot
`continue` / `skip` / `abort`. That is both unfaithful (git validates the message
before mutating state in the inline-data model) and a robustness hole.

### The upfront guard

`planInteractive` already runs before any state change and already rejects the
sibling case (reword without a message → `INVALID_OPTION`). Add, inside the
per-instruction loop, immediately after the reword-undefined guard:

```ts
if (
  (inst.action === 'reword' || inst.action === 'squash') &&
  inst.message !== undefined &&
  sanitizeMessage(inst.message, { allowEmpty: true }) === ''
) {
  throw invalidOption('interactive', `${inst.action} message must not be empty`);
}
```

- `sanitizeMessage(msg, { allowEmpty: true })` is `stripspace(msg)` without the
  throw — it returns the cleaned text, so `=== ''` is the exact "would clean to
  empty" predicate the replay's `allowEmpty: false` form tests.
- `reword` messages are always present here (the prior guard caught `undefined`);
  `squash` messages are optional, so the `inst.message !== undefined` clause lets
  a template-only squash through.
- `fixup` messages are ignored by the replay (`meldGroupMember` only reads
  `group.inline` for `squash`), so they are deliberately **not** validated.
- `INVALID_OPTION` (not `EMPTY_COMMIT_MESSAGE`) mirrors the reword-without-message
  refusal — a planning rejection, before HEAD moves.

### The deferred guards become provably equivalent

With empty inline messages rejected upfront, the replay's two `allowEmpty: false`
forms can never see an empty message:

- `stepReword`: on a fresh run `inst.message` was pre-validated non-empty; on a
  resume a reword carries no message (not persisted across a stop, per the design's
  cross-stop note) and falls back to `cData.message`, a real commit's non-empty
  message.
- `meldGroupMember` (group end): `group.inline` was pre-validated non-empty when
  present; otherwise `stripComments(template)` retains the base commit's non-empty
  message.

The two `BooleanLiteral` mutants (`allowEmpty: false` → `true`) — knowingly-killable-
but-deferred survivors today — become genuinely equivalent and are annotated
inline with `// equivalent-mutant: <why>`, no suppression directive.

## Out of scope (recorded, not done here)

- The v1 limitation that inline reword/squash messages scheduled *after* a stop
  are not carried across it (replay uses the original/default) is unchanged.
- `--exec` / `--root` / `--autosquash` remain deferred (their own backlog items).

## Test plan

### Item 1 — unit (`rebase.test.ts`)

`Given two unrelated histories` › `When rebased onto the unrelated upstream` ›
`Then it replays the whole branch onto upstream (root replay gets a parent)`.
Build `main` (base, m1) and an orphan `feature` (createCommit `parents: []`, then
`updateRef`); `rebaseRun({ upstream: 'main' })`. Assert: `kind === 'rebased'`,
the replayed root's `parents` has length 1 and points at the upstream tip, the
tip tree carries files from both histories, the `rebase (start): checkout main`
+ `rebase (pick)` × N + `rebase (finish)` reflog. (The refusal test is **not**
added — it would re-cement the divergence.)

### Item 1 — interop (`rebase-interop.test.ts`)

`Given two unrelated histories` › `Then tsgit matches git: same resulting tree,
commit count, single-parent tip`. `buildUnrelated` via `git checkout --orphan`;
run `git rebase main` on the peer and `repo.rebase.run({ upstream: 'main' })` on
ours; assert `writeTreeOf` and `rev-list --count` parity.

### Item 2 — unit (`rebase.test.ts`)

Under `Given an invalid interactive todo` (or a sibling `Given an empty …
message` block):

- `When a reword message cleans to empty` → `INVALID_OPTION`, `option ===
  'interactive'`, `reason` contains `reword message must not be empty`, **and HEAD
  is unchanged** (no `rebase-merge/` dir, HEAD still the branch tip) — proving the
  guard fires before any state change.
- `When a squash inline message cleans to empty` → same assertions with `squash`.
- (Regression, already covered) `When a squash carries no message` → succeeds via
  the template; `When a reword carries a real message` → succeeds.

Each guard condition gets an isolated test so the `||` / `!== undefined` / `=== ''`
/ `allowEmpty` mutants are all killed independently.

## Files touched

- `src/application/commands/rebase.ts` — delete the refusal; thread `base:
  ObjectId | undefined`; guard `commitsToReplay`; add the `planInteractive`
  upfront empty-message guard; annotate the two now-equivalent mutants.
- `test/unit/application/commands/rebase.test.ts` — unrelated-history replay +
  empty reword/squash guards.
- `test/integration/rebase-interop.test.ts` — unrelated-history parity.
- `docs/adr/238-*.md` — the unrelated-history resolution (Item 1).
- `docs/BACKLOG.md` — flip `22.4a` to `[x]`.
