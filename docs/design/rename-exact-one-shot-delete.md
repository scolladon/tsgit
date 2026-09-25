# Design — exact rename pass consumes each deleted source once

> Brief: GitHub issue #300, part A. `detectRenames` (`src/domain/diff/rename-detect.ts`)
> lets one deleted file be the source of several R100 renames when two or more adds
> share its blob id: the extra adds disappear from the output as renames of a source
> that was already renamed. Git consumes a deleted source once under `-M`. Fix the exact
> pass so tsgit pairs the same way git does, and pin it against real git.
> Part B (basename tie-break in the similarity pass `sortTriples`) is out of scope (§10).
> Status: draft → self-reviewed ×3

## 1. Context

### 1.1 The defect

`detectRenames` groups deletes by `oldId` (`buildDeletesByOldId`, `rename-detect.ts:43`)
and folds an add into a rename when its `newId` group holds **exactly one** delete
(`tryFoldAdd`, `:64`, guard `matches.length !== 1`). The consumed delete goes into the
`consumedDeletes` Set (`:103`) but **stays in the Map**. The next add with the same id
finds the same one-delete group and folds again:

```ts
detectRenames({ changes: [
  { type: 'delete', oldPath: 'a/Foo.meta', oldId: OID, oldMode: '100644' },
  { type: 'add',    newPath: 'b/Bar.meta', newId: OID, newMode: '100644' },
  { type: 'add',    newPath: 'b/Baz.meta', newId: OID, newMode: '100644' },
] })
// today: rename Foo→Bar, rename Foo→Baz   (Baz is not reported as an add)
// git:   rename Foo→Bar, add Baz
```

A realistic trigger is copying a directory next to moving it (`mv x y; cp -r y z`). Under
`-r`, every file in `z/` shows up as a second rename of its `x/` source.

### 1.2 How the passes compose

```
diffTrees (primitives/diff-trees.ts:91)
  └─ detectSimilarityRenames (primitives/detect-similarity-renames.ts:818)
       ├─ runBreakPass                       (-B, optional)
       ├─ detectRenames(workingDiff, { ...options, limit: MAX_SAFE_INTEGER })   ← exact pass (domain)
       ├─ partitionLeftovers (:347)          gitlinks → other (ADR-405)
       ├─ limit gate  num_create·num_src > limit²  → skip inexact (ADR-370)
       └─ runInexactPass → buildAllTriples → sortTriples (:260) → greedySelect
```

- The exact pass always runs with an unlimited `limit` (ADR-370). The one exact-pass cap
  that still applies is `maxSameIdDeletes` (default 100). It **prunes** any id group
  larger than the cap, so the adds for that id get no exact pairing at all.
- When an id group has two or more deletes, the `length !== 1` guard leaves it unpaired
  and it falls through to the similarity pass. There, identical blobs score `MAX_SCORE`
  and `sortTriples`' stable sort picks the **first delete in path order**. This has no
  basename preference and is subject to the rename limit.
- Consumers with rename detection on: `diff` (opt-in), `diffCommitAgainstParent`
  (`commands/internal/commit-diff.ts:23` → `show`, `log`, `whatchanged`), `range-diff`
  (`commands/range-diff.ts:75`), and `blame` (`renamedSource`, `commands/blame.ts:519`).
  `detectRenames` is also public API (`src/public-types.ts:49`).

### 1.3 Constraining decisions (fixed, not re-litigated)

| ADR | Constraint |
|---|---|
| 226 | Byte-faithful to git's pairing decisions; pin with a cross-tool interop test. |
| 249 | Pairing is structured data (`RenameChange`/`CopyChange`); `R100`/`A` text is rebuilt in the test. |
| 366 | The exact pass stays a pure, byte-free domain function; I/O stays in the primitive. |
| 367 / 368 | `RenameChange` shape; R100 ⇔ `similarity.score === MAX_SCORE`. |
| 370 | The exact pass is **never** limited by `renameOptions.limit`; only the inexact pass is. |
| 405 | Same-oid gitlinks pair exactly (`R100`); gitlinks are excluded from the inexact pools. |

## 2. Git's algorithm, read from source and pinned against the binary

Source: git **v2.55.0** `diffcore-rename.c`. Behaviour: probed with the real
`git version 2.55.0` (§3).

`find_exact_renames` (`:347`) inserts every source into a hash table keyed by oid,
**in reverse order**, then retrieves them LIFO, so sources are visited in forward
(path-sorted queue) order. Then it walks the **destinations in order** and calls
`find_identical_files` (`:276`) for each one:

```c
int i = 100, best_score = -1;
hashmap_for_each_entry_from(srcs, p, entry) {
    if (!oideq(&source->oid, &target->oid)) continue;          /* hash collision */
    if (!S_ISREG(source->mode) || !S_ISREG(target->mode))
        if (source->mode != target->mode) continue;           /* non-regular: modes must match */
    score = !source->rename_used;
    if (source->rename_used && detect_rename != DIFF_DETECT_COPY) continue;  /* -M: one-shot */
    score += basename_same(source, target);
    if (score > best_score) { best = p; best_score = score; if (score == 2) break; }
    if (!--i) break;                                           /* examine at most 100 */
}
if (best) record_rename_pair(dst_index, best->index, MAX_SCORE); /* rename_used++ */
```

Points that bear on this design:

1. **Destination-major, first-come.** Each add in path order takes the best source still
   available. With several adds and one source, the first add in path order wins, even
   when a later add has the matching basename (probe #2).
2. **One-shot under `-M`.** A used source is skipped (`continue`), so it can never feed a
   second rename. That is the bug.
3. **Basename preference among sources.** Score is `1 + basename_same`. A same-basename
   unused source beats an earlier different-basename one, and a strict `>` keeps the
   first source among equal scores (probes #4, #7, #18).
4. **Mode rule.** Regular files (`100644`/`100755`) pair freely with each other.
   Symlinks, gitlinks and trees pair only with an identical mode (probes #11–#13, and
   `diff-tree` non-recursive tree rename #D1).
5. **Candidate cap, not group prune.** At most 100 *eligible* candidates are examined per
   destination. Collisions, mode mismatches and used sources `continue` before `--i`, so
   they do not count toward the 100. A group larger than 100 still pairs, with the best
   among the first 100 (probes #15–#17).
6. **Not limited.** The exact pass runs before and regardless of `diff.renameLimit`
   (probes #8, #17). This matches ADR-370.
7. **Copies (`-C`) differ.** Used sources stay eligible at score 0. Each extra
   destination is recorded against the same source, and `diff.c:6699`
   (`--p->one->rename_used > 0 ? COPIED : RENAMED`) turns every pairing except the last
   into a **copy** (probes #9, #10).
8. **`rename_empty`** is on for `diff`, so empty blobs pair exactly (probe #14).
9. **`single_follow`.** `blame.c:1435` (`find_rename`) sets
   `diff_opts.single_follow = origin->path`. `diffcore_rename` (`:1423`) then registers
   **only that path** as a destination. Other adds never compete for the source, so every
   fan-out copy blames back to the original (probe #B1).

## 3. Pinned matrix (real git 2.55.0 vs tsgit)

Environment: every `GIT_*` unset, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
isolated `HOME`, signing off, `mktemp -d` repos. Git column: `git diff --name-status
<flags> HEAD~1 HEAD` (all `.meta` blobs hold `x\n` unless noted). tsgit columns:
`diff(ctx, { from:'HEAD~1', to:'HEAD', detectRenames:true, recursive:true, renameOptions })`
through the node adapter, run against the **same** repos. **(a)** and **(b)** are the two
fix candidates of D1, prototyped in a scratch copy of `src/` and run end-to-end
(similarity pass included). `✓` means the output equals git.

| # | Scenario (flags) | git 2.55.0 | tsgit today | (a) minimal | (b) faithful |
|---|---|---|---|---|---|
| 1 | 1 del `a/Foo` → adds `b/Bar`,`b/Baz` | `R Foo→Bar ; A Baz` | `R Foo→Bar ; R Foo→Baz` ✗ | ✓ | ✓ |
| 2 | 1 del → `b/Bar`,`b/Foo` (basename add 2nd) | `R Foo→Bar ; A b/Foo` | two R ✗ | ✓ | ✓ |
| 3 | 2 del `a/Foo`,`a/Qux` → `b/Bar` | `D Qux ; R Foo→Bar` | ✓ (via similarity) | ✓ | ✓ |
| 4 | 2 del → `b/Qux` (basename = 2nd del) | `D Foo ; R Qux→Qux` | `D Qux ; R Foo→Qux` ✗ | ✗ | ✓ |
| 5 | 2 del → `b/Bar`,`b/Baz` | `R Foo→Bar ; R Qux→Baz` | ✓ (via similarity) | ✓ | ✓ |
| 6 | 1 del → `b/A`,`b/B`,`b/C` | `R Foo→A ; A B ; A C` | three R ✗ | ✓ | ✓ |
| 7 | 2 del `Foo`,`Qux` → `b/Qux`,`b/Zed` | `R Qux→Qux ; R Foo→Zed` | `R Foo→Qux ; R Qux→Zed` ✗ | ✗ | ✓ |
| 8 | #3 with `-l1` | `D Qux ; R Foo→Bar` | `D Foo ; D Qux ; A Bar` ✗ | ✗ | ✓ |
| 9 | #1 with `-C` | `C Foo→Bar ; R Foo→Baz` | two R ✗ | `R ; A` ✗ | `R ; A` ✗ |
| 10 | #1 with `-C -C` | `C Foo→Bar ; R Foo→Baz` | two R ✗ | `R Foo→Bar ; C Foo→Baz` ✗ | `R Foo→Bar ; C Foo→Baz` ✗ |
| 11 | symlink `a/link`→`target` deleted; regular `b/file` = `target` | `D a/link ; A b/file` | `R link→file` ✗ | ✗ | ✗ (similarity pass pairs it) |
| 12 | #11 plus symlink `b/link2`→`target` | `A b/file ; R link→link2` | `R link→file ; R link→link2` ✗ | `R link→file ; A link2` ✗ | ✓ |
| 13 | `a/Foo.sh` 644 → `b/Bar.sh` 755, `b/Baz.sh` 644 | `R Foo→Bar ; A Baz` | two R ✗ | ✓ | ✓ |
| 14 | empty blob, 1 del → 2 adds | `R Foo→Bar ; A Baz` | two R ✗ | ✓ | ✓ |
| 15 | 101 del `a/F001..F101` → `b/Bar` | `R F001→Bar` + 100 D | ✓ (via similarity) | ✓ | ✓ |
| 16 | 101 del + `a/Zzz` → `b/Zzz` (basename is 102nd) | `R F001→Zzz` + D Zzz… | ✓ (via similarity) | ✓ | ✓ (cap hides `Zzz`) |
| 17 | #15 with `-l1` | `R F001→Bar` + 100 D | `A Bar` + 101 D ✗ | ✗ | ✓ |
| 18 | 3 del `Foo`,`Qux`,`Zed` → `b/Zed` | `D Foo ; D Qux ; R Zed→Zed` | `R Foo→Zed` ✗ | ✗ | ✓ |
| D1 | `mv x y; cp -r y z` — `diff-tree -M` (non-recursive) | `R x→y ; A z` | `R x→y ; R x→z` ✗ | ✓ | ✓ |
| D1r | same, `-r` | `R x/f→y/f ; R x/g→y/g ; A z/f ; A z/g` | four R ✗ | ✓ | ✓ |
| B1 | `git blame` of each add in #1 and #6 | every file → `a/Foo.meta` | every file → `a/Foo.meta` ✓ | **only the first** → `a/Foo`; others → themselves ✗ | same regression as (a) ✗ |

Reading the table:

- **(a) fixes the reported rows** (#1, #2, #6, #13, #14, D1) and regresses none of the
  diff rows. It leaves #4, #7, #8, #12, #17 and #18 wrong. On those rows git's exact pass
  resolves a multi-delete group (basename preference, mode rule, never limited), while
  tsgit hands the group to the similarity pass, which has no basename preference and is
  subject to the limit. #8 and #17 also violate ADR-370 ("exact pairing is never
  limited"), because a multi-delete group only pairs when the inexact pass runs.
- **(b) matches git on every `-M` row except #11.** #11 stays wrong under both options:
  (b) refuses the symlink→file exact pair, but the similarity pass then scores the two
  identical blobs at `MAX_SCORE`. git's `estimate_similarity` (`:158`) returns 0 for any
  non-regular side. That is a separate inexact-pool gap (§10).
- **#9 and #10 (`-C`) are wrong under every option**, including today's code. Doing
  what git does needs copy-aware exact pairing: used sources stay eligible, and all
  pairings but the last become copies. The domain exact pass cannot express that today
  (it has no copy notion; copies live in the primitive). See D1 (c).
- **B1 is a regression that both fixes introduce.** tsgit's blame
  (`renamedSource`, `blame.ts:519`) runs full-tree rename detection and looks for a
  `rename` whose `newPath` is the blamed path. Today it relies on the fan-out bug. Git
  blame uses `single_follow` (§2.9), so every copy follows back. The fix must ship with
  single-follow blame (D3), or `blame b/Baz.meta` stops following a rename that git
  follows.

Reproduction: the probe script and the tsgit runner live outside the repo (scratchpad).
Each row is re-expressed as an interop case (§6 Part 4), which is the durable copy.

## 4. Design

### 4.1 Exact pass (depends on D1, D2)

Under **D1 (b)**, `detectRenames` transcribes `find_identical_files` for `-M`:

```
for add in adds (input order = path order — the raw diff is path-sorted and
                 patchDiffWithBroken splices -B halves in place):
  candidates = groupsById.get(add.newId) ?? []         // unused deletes only, path order
  best = first candidate c, within the first `cap` mode-compatible candidates,
         maximising 1 + basenameSame(c.oldPath, add.newPath); stop at score 2
  if best: emit rename(best, add, MAX_SCORE); remove best from its group
  else:    keep add
leftover deletes = deletes not consumed
```

- **Mode compatibility.** Both sides have `kindOf(mode) === 'file'`, or `oldMode === newMode`.
  Reuses `kindOf` (`src/domain/diff/mode-kind.ts`). No new mode table.
- **basenameSame.** The last path segments are equal. This is equivalent to git's
  backwards scan to `/`. Paths are `FilePath` and never end in `/`.
- **One-shot.** A consumed delete is removed from its group, so later adds never see it.
  The group arrays are local, mutable working state inside the function; the input and
  output stay immutable. Removing the delete keeps each scan within `cap` *unused*
  candidates, where git scans past used sources. The chosen source is the same either
  way, because git's `continue` does not count used sources toward the cap.
- **Cost.** Per add: O(min(k, cap)) scan plus O(k) removal, where k is the size of the
  same-id group. Typical k = 1, which reduces to today's single lookup. Worst case
  O(adds · k), the same bound as git. No `limit` gate, per ADR-370.
- **Output order** stays `sortByPath(merged, primaryPath)`. Pinned: git's `--name-status`
  order equals `primaryPath` order on every row in §3 (a rename sits at its destination
  path).

Under **D1 (a)**, the only change is to remove the consumed id from `deletesByOldId` after
a fold. The `length !== 1` refusal and the `maxSameIdDeletes` prune stay.

### 4.2 `maxSameIdDeletes` (depends on D2)

Under (b), the option's current meaning ("prune the whole id group above N") contradicts
git (rows #15–#17 pair in git). D2 decides its fate. The recommended option keeps the name
and re-defines it as git's per-destination **examined-candidate cap** (default 100, which
equals git's hard-coded `i = 100`). `0` keeps meaning "no exact pairing". The DoS bound
it was introduced for (`docs/design/diff-and-merge.md` §4.5) is preserved: the scan per
add is bounded by the cap.

### 4.3 Blame follows a single destination (depends on D3)

`renamedSource` (`blame.ts:519`) must detect renames with **only the blamed path** as a
destination, as git's `single_follow` does. Recommended shape (D3 b): blame asks
`diffTrees` for the raw recursive diff (no detection), keeps every `delete` plus the one
`add` whose `newPath === path`, and passes that to `detectSimilarityRenames(ctx, diff)`.
The result is the same pairing git blame computes: that add is the only destination, and
it competes with no sibling adds for the source, whether the match is exact or inexact.
This also fixes a latent divergence: today many unrelated adds in the commit can push a
blame lookup over the rename limit, while git's `num_create` is 1.

### 4.4 What does not change

- The inexact pass (`detect-similarity-renames.ts`), apart from the blame caller.
- `RenameChange` / `CopyChange` shapes. No public type change under D2 (a); under
  D2 (c) the option is removed (breaking change).
- ADR-405 gitlink behaviour. Same-oid, same-mode gitlinks still pair exactly, and the
  mode rule keeps them from pairing with anything else.

## 5. Edge cases

| Case | Behaviour after the fix (b + D3) | Pin |
|---|---|---|
| 1 source, N identical adds | first add in path order gets R100; the rest stay `A` | #1, #6 |
| basename-matching add is not first | path order wins over basename | #2 |
| N identical sources, 1 add | basename-matching source if any, else first in path order | #3, #4, #18 |
| N×M identical | per add in order: best unused source | #5, #7 |
| 644 ↔ 755 | regular files pair across the exec bit | #13 |
| symlink/gitlink/tree | pairs only with an identical mode | #12, D1, ADR-405 |
| empty blob | pairs exactly | #14 |
| > cap identical sources | best among the first `cap` examined | #15, #16 |
| rename limit exceeded | exact pairing unaffected | #8, #17 |
| `-C` / `-C -C` fan-out | **unchanged divergence** (D1 c / follow-up) | #9, #10 |
| symlink ↔ regular, identical blob | **unchanged divergence** (similarity pass) | #11 |
| `-B` broken delete halves | unchanged: tsgit does not seed git's `rename_used` for `broken_pair && !score` | — |
| blame of a fan-out copy | follows to the original source | B1 |

## 6. Implementation parts (pre-chewed context)

### Part 1 — exact pass (`src/domain/diff/rename-detect.ts`)

- Symbols: `buildDeletesByOldId` (`:43`), `tryFoldAdd` (`:64`), `detectRenames` (`:87`),
  `DEFAULT_MAX_SAME_ID_DELETES` (`:25`), `RenameDetectOptions.maxSameIdDeletes` (`:9`).
  Current signatures: `detectRenames(diff: TreeDiff, options: RenameDetectOptions = {}):
  TreeDiff`; `tryFoldAdd(add, deletesByOldId: Map<ObjectId, ReadonlyArray<DeleteChange>>)
  → { rename; consumedDelete } | undefined`.
- Helpers to reuse: `kindOf` (`src/domain/diff/mode-kind.ts`), `sortByPath`/`primaryPath`,
  `MAX_SCORE`.
- New private helpers (b): `isExactModeCompatible(oldMode, newMode)`,
  `hasSameBasename(oldPath, newPath)`, `pickExactSource(add, group, cap)`. Each is under
  20 lines, with early returns and no boolean params.
- Tests: `test/unit/domain/diff/rename-detect.test.ts` (fixtures `addChange`,
  `deleteChange`, `diff`, `ID_A..C`). **Existing tests whose expectation flips under (b):**
  "multiple deletion candidates → no fold" (`:79`, now folds `a.txt→c.txt`), "exactly
  maxSameIdDeletes … skipped" (`:179`) and "maxSameIdDeletes + 1 … pruned" (`:198`), both
  now fold under cap semantics. `maxSameIdDeletes=0` (`:280`) and `=1` (`:253`) keep
  their outcome. Each flipped test is rewritten to the git-pinned outcome, not deleted.
  New example rows: #1, #2, #4, #6, #7, #12, #13, #16 at the domain level (mode and
  basename guards each get an isolated test).

### Part 2 — blame single-follow (`src/application/commands/blame.ts`)

- Symbol: `renamedSource` (`:519`). Its `diffTrees(ctx, parentTree, childTree,
  { recursive: true, detectRenames: true })` call (`:532`) becomes raw diff → filter adds
  to `path` → `detectSimilarityRenames(ctx, filtered)`
  (`primitives/detect-similarity-renames.ts:818`, signature
  `(ctx, diff, options?, preimage?) → Promise<TreeDiff>`).
- Also correct the doc comment (`:512-518`). It says a rename-with-edit is not followed,
  but `diffTrees` with `detectRenames` already runs the similarity pass, so a `rename` at
  `newPath === path` is followed whatever its score. Pin this in the Part 2 tests
  before rewording.
- Tests: `test/unit/application/commands/blame.test.ts` (rename describes at
  `:331`, `:795`, `:822`, `:869`). Add "Given a file copied to two paths alongside the
  delete" → both paths blame to the source.

### Part 3 — property sibling (D5)

- New `test/unit/domain/diff/rename-detect.properties.test.ts`, with generators added to
  `test/unit/domain/diff/arbitraries.ts`: small id and path pools to force collisions,
  plus `arbNonDirMode`.
- Invariants (lenses 2 and 4, `numRuns` 100). (i) Each delete path is the `oldPath` of at
  most one rename (the #300 regression). (ii) Conservation: every input add path appears
  exactly once, as an `add.newPath` or a `rename.newPath`; every input delete path appears
  exactly once, as a `delete.oldPath` or a `rename.oldPath`. (iii) Every rename has
  `oldId === newId` and exact-mode-compatible modes. (iv) Non-add/delete changes pass
  through unchanged. (v) Idempotence. None of these re-implements the selection loop, so
  there is no tautology oracle. The two inline example "properties" (`:303`, `:324`)
  stay; properties are additive per ADR-136.

### Part 4 — interop pins (D4)

- New `test/integration/rename-exact-interop.test.ts`, modelled on
  `diff-type-change-interop.test.ts`: git builds one repo per row, tsgit opens the same
  repo through `createNodeContext`, and a local `nameStatusFrom` rebuilds `--name-status`
  for a string-equal comparison with live `git diff --name-status`. Helpers:
  `GIT_AVAILABLE`, `git`, `runGit`, `runGitEnv` (`test/integration/interop-helpers.ts`).
  Rows: #1–#8, #12–#18, D1, D1r. `@proves` header `surface: diff.renames`,
  `bucket: cross-tool-interop`.
- Blame row B1: add to `test/integration/blame-interop.test.ts` (existing `git blame
  --porcelain` comparison helpers at `:136`/`:140`).
- Known divergences #9, #10 and #11 are **not** asserted as passing. If they are pinned
  at all, pin them as documented divergences only once a follow-up owns them.

## 7. Test strategy (summary)

TDD per part: RED example rows from §3 → GREEN → refactor. Domain unit tests carry every
guard in isolation (mode rule, basename tie, cap boundary at `cap` and `cap+1`, one-shot).
The property sibling proves one-shot and conservation over arbitrary collisions. Interop
proves each row against live git. Coverage 100%; mutation target 0 survivors. The
`hasSameBasename` scan, the `score === 2` early exit and the cap counter each get a
killing row (#4, #18, #16).

## 8. Performance

The exact pass is on the hot path of every `show`/`log`/`range-diff` commit diff.
With k = 1 (the norm), (b) does one map lookup, one scan of one element and one removal,
the same as today plus the removal. There is no allocation beyond the existing grouping
Map. Blame (Part 2) does less rename work per lookup: one destination instead of every
add in the commit. No bench gate expected. Run `bench:ab` on the log/show fixtures if the
review asks.

## 9. Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Scope of the exact-pass fix | (a) **minimal**: drop the consumed id from `deletesByOldId`; keep the `length !== 1` refusal and the group prune, and leave multi-delete groups to the similarity pass. (b) **faithful `-M` port** of `find_identical_files`: per add in order, best unused mode-compatible same-id delete, score `1 + basename`, first wins, examined-candidate cap. (c) (b) **plus copy-aware exact pairing** under `copies ≠ 'off'` (used sources eligible at score 0; all pairings but the last become `copy`) | **(b)** | (a) fixes #300 but leaves six pinned `-M` rows wrong (#4, #7, #8, #12, #17, #18), and #8/#17 violate ADR-370's "exact pairing is never limited". (b) matches git on every pinned `-M` row except #11 (an inexact-pool gap) at the same cost. (c) is the only way to fix #9/#10, but it moves copy semantics into the byte-free domain pass (or the exact pass into the primitive) and changes `-C` output shape; it deserves its own pin matrix and follow-up |
| D2 | Fate of `RenameDetectOptions.maxSameIdDeletes` under D1 (b) (moot under D1 a) | (a) keep the name, redefine as git's per-add **examined-candidate cap** (default 100 = git's `i = 100`; `0` = no exact pairing); (b) keep the prune semantics (diverges on groups > 100, rows #15–#17); (c) remove the option (breaking, `feat!`) | **(a)** | keeps the DoS bound it was added for and the public type, while making the default git-exact. (b) keeps a known divergence. (c) breaks the public API for no faithfulness gain over (a). Note that (a) is a semantic change for callers who set the option; the changelog must say so |
| D3 | Blame's rename lookup after the fix | (a) new `followPath` option on `RenameDetectOptions` (git's `single_follow`) applied in `detectSimilarityRenames`: adds at other paths are not destinations; (b) blame-local: raw diff → keep all deletes and the add at `path` → `detectSimilarityRenames`; (c) accept the regression and defer | **(b)** | without it, both D1 fixes regress `blame` against git (row B1). (b) is faithful to `single_follow` for exact and inexact pairing, and adds no public surface (YAGNI: blame is the only follower; there is no `log --follow`). (a) is right if a second follower appears. (c) ships a known regression |
| D4 | Where the regression pins live | (a) unit rows in `rename-detect.test.ts` + new `test/integration/rename-exact-interop.test.ts` (diff rows) + a B1 row in `blame-interop.test.ts`; (b) unit rows + new describes in the existing 2,500-line `rename-similarity-interop.test.ts`; (c) unit rows only, with the §3 matrix as documentation | **(a)** | only the interop harness proves faithfulness (`faithfulness.md`). The exact pass is a distinct git routine (`find_identical_files`) with its own matrix, so a dedicated file keeps the similarity suite focused. Blame rows belong with blame's porcelain comparison. (c) proves nothing against git |
| D5 | Property-test sibling | (a) new `rename-detect.properties.test.ts` (fast-check, lenses 2 + 4): one-shot, conservation, id/mode soundness, pass-through, idempotence; (b) examples only (the inline "property" examples stay as they are) | **(a)** | `detectRenames` is a matcher that reduces changes to a pairing (lens 2), and conservation is a counting invariant (lens 4). The #300 bug is exactly a conservation violation that no property caught. The invariants need no production-loop oracle |
| D6 | Widen scope to row #11 (symlink ↔ regular pairs via the similarity pass) | (a) follow-up issue: extend ADR-405's gitlink exclusion to "non-regular" in `partitionLeftovers`/copy/break pools, with its own pins; (b) include it here | **(a)** | it is an inexact-pass defect (git `estimate_similarity` `:158`) that neither D1 option touches. It changes three pool builders shared with `-C`/`-B` and needs its own matrix (symlink modify under `-B`, symlink copy sources) |

If D1 (b) is ratified, it warrants an ADR ("the exact rename pass transcribes git's
`find_identical_files`"). D2 (a) and D3 (b) each need one too: one for the public option
semantic change, one for blame's single-follow.

## 10. Non-goals and follow-ups

- **Issue #300 part B:** a basename tie-break in the similarity pass (`sortTriples`,
  `detect-similarity-renames.ts:260`). Git's `score_compare` breaks equal scores on
  `name_score = basename_same`, and git ≥ 2.33 also runs `find_basename_matches` before
  the matrix. Under D1 (b), the exact-content rows no longer reach the similarity pass, so
  part B only concerns *inexact* ties.
- **Copy-aware exact pairing** (`-C` rows #9/#10): D1 (c), follow-up.
- **Non-regular files in the inexact pools** (row #11): D6, follow-up.
- **`-B` `rename_used` seeding** for broken delete halves (`diffcore-rename.c:1443`):
  unchanged, not pinned here.
- git's stderr rename-limit warning: rendering (ADR-249/370).
