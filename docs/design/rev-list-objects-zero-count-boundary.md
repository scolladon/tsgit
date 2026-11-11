# Design — `rev-list --objects -n 0` boundary objects

> Brief: backlog 32.12 — with a commit on the `not` side, `maxCount: 0` must still
> run git's limited walk so boundary trees are marked; tsgit returns before it.
> Status: draft → self-reviewed ×2 → accepted

## Context

`listCommitSeeds` in `src/application/primitives/internal/closure-engine.ts` dispatches
the commit side of a walk-tier closure:

```ts
const { commitSeeds } = resolved;
if (commitSeeds.length === 0 || request.maxCount === 0) return [];
if (request.noWalk === true && request.not.length === 0) return seedsWithoutWalking(commitSeeds, request);
return walkCommitSeeds(ctx, resolved, marks, request);
```

`walkCommitSeeds` runs `collectLimitedWalk` when `marks.commitTips` is non-empty (git's
`limit_list`), then under `objects` marks the edge trees (`markExcludedTrees`), and only
then slices to `maxCount`. The `maxCount === 0` early return skips the walk and the
marking, so pending tree/blob wants that sit under an edge commit's tree are listed.

git sets `revs->limited` only when a commit (or a tag peeling to one) is uninteresting.
Under `limited`, `prepare_revision_walk` runs `limit_list` to completion before
`get_revision` looks at `max_count`. Without it, `get_revision` returns nothing for
`-n 0` and walks nothing. So `-n` bounds what is listed, not whether the range is walked.

Reached only through `revList` (`maxCount` option). `packObjects` never sets `maxCount`
(its `computeClosure` request in `selectObjects`, `src/application/commands/pack-objects.ts`,
passes no count), so `pack-objects --sparse -n 0` cannot be reached through tsgit.
`computeClosure` already routes any `maxCount` to the walk tier.

## Requirements

1. With at least one commit seed and at least one commit `not` tip, `maxCount: 0` runs
   the limited walk and, under `objects`, marks edge trees exactly as an unbounded run
   does; the listed commits stay `[]`.
2. With no commit `not` tip (no `not` side, or only tree/blob/tag-of-tree `not` tips),
   `maxCount: 0` walks nothing, as today: the result is the pending objects only, and a
   missing or corrupt ancestor is never read.
3. A missing commit inside the range refuses with `REVISION_WALK_FAILED` under
   `maxCount: 0`, with and without `objects`, as git's `revision walk setup failed`.
4. Every currently-OK row of the matrix below stays OK.

## Design

### Pinned matrix — git 2.56.0 (scrubbed `GIT_*`, isolated `HOME`)

Fixture: linear n0 → N → W → W2. n0 has only `old.txt`. N has `a.txt` + `sub/x.txt`.
W changes `a.txt`, adds `new.txt` (`sub/` shared with N). W2 adds `w2.txt`. Tn/Tw/T0 =
root trees of N/W/n0; Ts = `N:sub`; Bn/Bw = `a.txt` blob in N/W; U = an unreachable
tree with its own blob; tagTn/tagN = annotated tags of Tn/N. A bitmap was written
(`repack -adb`). Every row carries `--objects`. "ours" is tsgit at `b9c4b523`.

```
DIFF -n 0 W Tn ^N            git: []                      ours: [Tn,Bn,Ts,x-blob]
DIFF -n 0 W Tw ^N            git: [Tw,Bw,new-blob]        ours: [Tw,Bw,new-blob,Ts,x-blob]
OK   -n 0 W U ^N             git: [U,u-blob]
DIFF -n 0 W Ts ^N          git: []                      ours: [Ts,x-blob]
DIFF -n 0 W Bn ^N            git: []                      ours: [Bn]
OK   -n 0 W Bw ^N            git: [Bw]
OK   -n 0 W T0 ^N            git: [T0,old-blob]           (grandparent tree is NOT marked — only the edge)
OK   W T0 ^N                 git: [W,T0,old-blob,Tw,Bw,new-blob]
DIFF -n 0 W tagTn ^N         git: [tagTn]                 ours: [tagTn,Tn,Bn,Ts,x-blob]
OK   -n 0 W tagN ^N          git: [tagN]
OK   -n 0 Tn ^N              git: [Tn,Bn,Ts,x-blob]     (no commit seed: nothing is marked)
OK   Tn ^N                   git: [Tn,Bn,Ts,x-blob]
OK   -n 0 Bn ^N              git: [Bn]
OK   -n 0 U ^N               git: [U,u-blob]
OK   -n 0 W Tn               git: [Tn,Bn,Ts,x-blob]     (no not side)
OK   -n 0 W ^N               git: []
OK   -n 0 W                  git: []
OK   -n 1 W Tn ^N            git: [W,Tw,Bw,new-blob]
DIFF -n 0 W2 Tn ^N           git: []                      ours: [Tn,Bn,Ts,x-blob]
OK   -n 1 W2 Tn ^N           git: [W2,W2tree,Bw,new-blob,w2-blob]
DIFF -n 0 W2 Tw ^N           git: [Tw,Bw,new-blob]        ours: [Tw,Bw,new-blob,Ts,x-blob]
OK   -n 1 W2 Tw ^N           git: [W2,Tw,Bw,new-blob,W2tree,w2-blob]
DIFF -n 0 W2 Tw ^W           git: []                      ours: [Tw,Bw,new-blob,Ts,x-blob]
DIFF -n 0 --no-walk W Tn ^N  git: []                      ours: [Tn,Bn,Ts,x-blob]
OK   -n 0 --no-walk W Tn     git: [Tn,Bn,Ts,x-blob]
DIFF -n 0 --use-bitmap-index W Tn ^N   git: []            ours (useBitmapIndex): [Tn,Bn,Ts,x-blob]
OK   -n 0 W Tn ^Tn           git: []
DIFF -n 0 W Tn ^tagN         git: []                      ours: [Tn,Bn,Ts,x-blob]
DIFF -n 0 W Tn ^N ^Tw        git: []                      ours: [Tn,Bn]
OK   -n 0 W Tw ^N ^Tw        git: []
```

Fault surface, same history with W's loose object removed (W2's parent is missing):

```
                              git                                         ours (b9c4b523)
-n 0 W2 ^N                    exit 128  error: Could not read <W>         ok, []
                                        fatal: revision walk setup failed
-n 0 --objects W2 ^N          exit 128  (same stderr)                     ok, []
-n 0 W2 ^n0                   exit 128  (same stderr)                     —
-n 0 --no-walk W2 ^N          exit 128  (same stderr)                     —
-n 0 --objects W2 Tn ^N       exit 128  (same stderr)                     —
-n 0 W2                       exit 0, empty                               ok, []
-n 0 --objects W2             exit 0, empty                               ok, []
-n 0 --objects W2 ^Tn         exit 0, empty  (tree not tip: not limited)  ok, []
-n 1 W2                       exit 128  fatal: Failed to traverse parents of commit <W2>
```

The two fault DIFFs come from the same early return: the backlog entry did not record them.

### Change

One operand in `listCommitSeeds`: return early on `maxCount === 0` only when nothing
makes the walk limited.

```ts
if (commitSeeds.length === 0 || (request.maxCount === 0 && marks.commitTips.length === 0)) return [];
```

`marks.commitTips` (filled by `markNotTip` in `closure-not-marks.ts`, after tag peeling)
is git's `revs->limited` trigger; `request.not.length` is not, because a tree or blob
`not` tip does not limit the walk. With a commit `not` tip, `request.not.length > 0`, so
`noWalk` falls through to `walkCommitSeeds` as it already does for `maxCount > 0`, and
`walkCommitSeeds` already slices to `[]`.

Verified by an uncommitted local probe (reverted) comparing tsgit to git 2.56 on all 23
pinned shapes × {`objects`, no `objects`} plus the fault rows:

| guard | matrix rows OK | fault rows OK |
|---|---|---|
| current (`maxCount === 0`) | 36/46 | 3/5 |
| proposed (`maxCount === 0 && commitTips.length === 0`) | 46/46 | 5/5 |
| brief's hypothesis (operand dropped) | 46/46 | 2/5 |

The hypothesis is wrong on the fault surface. With the operand dropped, a count of zero
and no commit `not` tip reaches `collectStreamedWalk` with `takeAtMost: 0`. `drain` in
`limit-list.ts` checks `taken.length === takeAtMost` only after a push, so `0` never
stops it: it walks the whole ancestry and refuses on the missing parent, where git exits 0
without walking. The proposed guard keeps `takeAtMost: 0` unreachable, so `limit-list.ts`
is not touched.

### Cost

With a commit `not` tip, `maxCount: 0` now pays the full limited walk, as git does. The
non-`objects` case cannot keep its shortcut: git refuses `-n 0 W2 ^N` without
`--objects` when the range holds a missing commit (fault table), so the walk is
observable even when no tree is marked. Without a commit `not` tip, nothing changes.

### Doc surfaces

- `RevListOptions.maxCount` JSDoc (`src/application/commands/rev-list.ts`): replace
  "`0` yields an empty result." with this: `0` lists no commit. Under `objects`, the
  pending tree, blob and tag wants are still listed, minus whatever the excluded
  commits' edge trees reach. With a commit in `not`, the range is still walked.
- `docs/use/commands/rev-list.md` line on `maxCount: 0`: same correction.
- `reports/api.json`: regenerated from the JSDoc by the pre-push api step, not edited by hand.

## Decision candidates

None. The matrix pins the guard (commit `not` tips, not `not` tips of any type), and the
fault rows pin the non-`objects` case to walking. No ADR needs to diverge.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|

## Test strategy

**Interop** (`test/integration/rev-list-objects-interop.test.ts`), expected values always
from real `git`:

1. In `Given tag, tree and blob tips on either side of a range` (fixture
   `buildNonCommitTipFixture`: `base` ← `main`, `main`'s tree keeps `base.txt`'s blob,
   refs `base-tree`, `base-blob`, `tip-tree`, `tip-blob`, `tag-tree`, `tag-base`): add a
   `describe.each` over `maxCount: 0` with `objects`, comparing to
   `gitIds(dir, '--objects', '-n', '0', ...flags, ...wants, '--not', ...not)`. Rows:
   `main base-tree ^base`, `main base-blob ^base`, `main tip-tree ^base` (pinned on git 2.56: `[tip-tree, tip.txt blob]`, `base.txt`'s blob
   dropped: this row separates "marked the edge" from "returned early"), `main tag-tree ^base`, `main base-tree ^tag-base`,
   `main base-tree ^base` under `noWalk`, `main base-tree` (no `not`),
   `main base-tree ^tip-tree` (tree-only `not`). The fixture has no subdirectory. The
   `Ts` recursion is already pinned by the unbounded rows.
2. Next to `Given a commit whose parent object is missing and an excluded root` (uses
   `writeLiteralCommit`, `ABSENT_PARENT`, `capturing`, `settled`, `walkStderrOf`): a
   `describe.each` over `{ objects: false, true }` with `maxCount: 0`, asserting
   `peer.exitCode === 128` and `walkStderrOf(logged, result) === peer.stderr` for
   `-n 0 [--objects] child ^root`. Add one row for `-n 0 [--objects] child` (no `not`):
   git exit 0 and empty, tsgit `[]` with nothing logged.

**Unit** (`test/unit/application/primitives/internal/closure-engine.test.ts`, helpers
`buildSeededContext`, `writeBlob`, `writeTree`, `writeDatedCommit`, `createObjectTypeTable`;
GWT describe/it split, AAA, `sut = computeClosure`):

| Given / When | Then | Kills |
|---|---|---|
| want commit W + pending tree Tn of its excluded parent N, `not: [N]`, `objects`, `maxCount: 0` | `[]` | early return on `maxCount === 0` alone (`&&` → `\|\|`, `commitTips.length === 0` → `true`) |
| commit whose parent is absent, `not: []`, `objectTypes` set, `maxCount: 0` | `[]`, no throw | `commitTips.length === 0` → `false` (the full walk refuses on the absent parent) |
| same commit, `not: [tree]` only, `objects`, `objectTypes`, `maxCount: 0` | `[]`, no throw | using `request.not.length` instead of `marks.commitTips` |
| commit with an absent in-range ancestor, `not: [root]`, `objectTypes`, `maxCount: 0` | throws; assert `data.code === 'REVISION_WALK_FAILED'` via try/catch | walk skipped under a commit `not` tip |

`objectTypes` is required on the fault rows: without it `ignoreMissing` is true and
an absent parent is skipped silently. The existing `revList` unit row `maxCount: 0` →
empty (`test/unit/application/commands/rev-list.test.ts`, no `not` side) stays green
unchanged. No parser, matcher or serializer is touched, so no property sibling.

## Out of scope

- Bitmap tier: `maxCount` already forces the walk (`closureTierFor`). Its DIFF row is the
  same early return.
- `takeAtMost: 0` never stopping `drain` (`limit-list.ts`): unreachable once the guard
  ships. Changing it would touch a module that needs no change.
- `pack-objects --sparse -n 0`: `packObjects` cannot send a count.
