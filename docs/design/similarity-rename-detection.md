# Design — similarity rename / copy / break detection

> Brief: pair an `add` with a `delete` when their blob CONTENTS are ≥ git's
> default 50% similarity (not just on identical blob ids), reproducing git's
> pairing decisions and reported similarity score byte-for-byte. Per ADR-369
> the scope is widened to the full diffcore detection surface: inexact renames
> (`-M`), **copy detection** (`-C`, incl. `--find-copies-harder`), **break
> detection** (`-B`), and a **configurable threshold** — each byte-faithful and
> interop-pinned.
> Status: draft → ratified (ADRs 366–371) → revised against ADRs → self-reviewed ×3

## 1. Context

Rename detection today is **exact-match only** (R100). `detectRenames`
(`src/domain/diff/rename-detect.ts`) is a pure-domain function over a `TreeDiff`:
it buckets deletes by `del.oldId` and folds an `add` into a `rename` only on an
**identical blob-id** hit (`add.newId === del.oldId`, `matches.length === 1`).
It never reads blob bytes — it has no `Context`. The quadratic guard
(`adds.length * deletes.length > limit`, `DEFAULT_LIMIT = 1000`) bails the whole
pass when the candidate matrix is too large.

`detectRenames` is invoked from the **primitive** tier, not the domain:
`src/application/primitives/diff-trees.ts:43` calls it after `domainDiffTrees`,
so the orchestration point **already holds `ctx`**. Precedent for hydrating blob
bytes at this exact tier: `attachStats` (same file) and `materialisePatchFiles`
(`src/application/primitives/materialise-patch-files.ts`) both `readBlob` change
contents through `Context` with a bounded concurrency pool.

Prerequisite **24.12** (recursive `diffTrees`) has landed: cross-directory rename
candidates surface as flat full-path adds/deletes
(`docs/design/diff-recursive-tree-diff.md`), so similarity pairing operates over a
flat candidate list regardless of directory nesting.

`RenameChange` (`src/domain/diff/diff-change.ts`) carries a **single** `id`/`mode`,
baked on the R100 assumption `oldId === newId` and `oldMode === newMode`. A
similarity rename, a copy, and a break all violate this. The shape and every
consumer grow.

### 1.1 Constraining decisions (FIXED — ratified, not re-litigated here)

| ADR | Decision this design must implement |
|---|---|
| 226 / CLAUDE.md | Replicate git's observable pairing + reported score byte-for-byte; pin against real `git`. |
| 249 | Similarity/dissimilarity is a structured **field**; the `R<n>`/`C<n>`/`M<n>` and `similarity index`/`copy from`/`dissimilarity index` *text* is reconstructed by the caller-facing serializer, never returned pre-rendered. |
| 366 | Pure-domain `estimateSimilarity` scorer + primitive `detectSimilarityRenames` orchestrator. The copy/break passes share that orchestrator. |
| 367 | ONE `rename` variant: `oldId`/`newId`/`oldMode`/`newMode` + structured `similarity`. R100 = `similarity.score === MAX_SCORE`. A new `copy` change follows the same two-sided + `similarity` convention. |
| 368 | `similarity = { score: 0..60000, maxScore: 60000 }`; export `MAX_SCORE` + `toSimilarityPercent`. The same shape carries copy scores. |
| 369 | **Ship `-C` + `-B` + threshold all now**, each byte-faithful + interop-pinned. |
| 370 | Over-limit ⇒ skip the inexact pass silently; exact pass never limited; `renameOptions.limit`, `0` = unlimited. The cap gates renames **and** copies. |
| 371 | Replicate git's score-sorted greedy `record_if_better`; NOT optimal/Hungarian. Copies share the machinery. |

### 1.2 Consumers of `RenameChange` (and the new `CopyChange`) — full audit

| Consumer | File:line | Uses today | Impact |
|---|---|---|---|
| patch render | `src/domain/diff/patch-serializer.ts:498` `renderRenameBlock` | hardcodes `similarity index 100%`, no `index`/hunk | render real `index N%`, mode preamble, `index <o>..<n> <mode>`, hunk; **add `renderCopyBlock`**; route `copy` in `renderFile` (`:537`) |
| blame | `src/application/commands/blame.ts:339` `renamedSource` | `change.id` (source blob) | read `oldId` (single `id` removed) |
| range-diff text | `src/domain/range-diff/patch-text.ts:68,77` | `oldPath`/`newPath` only | `rename` unchanged; **add a `copy` case** to `fileHeader`/`displayName` (path-only) |
| sort key | `src/domain/diff/change-path.ts:5` `primaryPath` | `newPath` for `rename` | **add a `copy` case** → `change.newPath` |
| hydrate | `src/application/primitives/materialise-patch-files.ts:43` `materialiseOne` | `rename` returns `{ change }` (loads nothing) | rename loads both sides when `score < MAX_SCORE`; **copy always loads both sides** (source preimage + dst) |
| public re-export | `src/application/commands/index.ts:1` → `src/index.ts:3` (`public-types`) | exports `RenameChange` etc. | **add `CopyChange`**; `reports/api.json` regenerates |

Pass-detection sites (all must keep working): `commands/diff.ts`, `blame.ts:335`,
`range-diff.ts`, `internal/commit-diff.ts` (→ `show` / `log -p`); facade options
`ports/context.ts:84`, `primitives/types.ts:187`.

## 2. Requirements

1. An `add`/`delete` pair ≥ the configured threshold (default 50%) pairs into a
   `rename`; below does not — matching git's `score >= minimum_score` decision.
2. The reported similarity equals git's truncated integer percent
   `(int)(score·100/MAX_SCORE)` over git's spanhash-counted copied bytes.
3. Exact (R100) pairing is unchanged and runs **before** the inexact pass.
4. Over the rename limit, the **inexact** pass (renames + copies) is skipped;
   exact pairing is never limited (corrects the current whole-pass bail).
5. Multiple candidates → git's score-sorted greedy winner (ADR-371).
6. `RenameChange` carries the two-sided fields + `similarity`; the serializer
   reconstructs the patch text byte-equal to `git diff -M`.
7. **Copy detection (`-C`)**: an `add` pairs against a **retained** source (the
   source is NOT consumed) → a new `copy` change, byte-faithful to `git diff -C`.
   `--find-copies-harder` widens the source set to all preimage paths.
8. **Break detection (`-B`)**: a sufficiently-dissimilar `modify` is split into a
   delete+add break pair **before** rename/copy detection; halves re-pair; an
   unrepaired break surfaces with its dissimilarity datum.
9. **Configurable threshold**: `-M<n>`/`-C<n>`/`-B<n>[/<m>]` are structured
   options; git's accepted forms (`-M50%`, `-M50`, `-M0.5`) parse faithfully;
   defaults match git.
10. Every existing detection consumer keeps working; R100 output is byte-unchanged.
11. The full matrix is pinned by `*-interop` tests (twin real-`git` vs tsgit).

## 3. Design — inexact renames (the sound core, retained)

### 3.1 Git's algorithm (pinned, not recalled)

git pairs renames in `diffcore-rename.c` over `diffcore-delta.c`:

- **Two passes.** `find_exact_renames` first (identical blob oid → R100), **not**
  gated by the rename limit. Then the **inexact** pass: build a `(src, dst)` score
  matrix, greedily pick best matches.
- **Score basis = spanhash fingerprint, not lines.** `diffcore_count_changes`
  chunks each blob into variable-length hashed spans, counts `src_copied` and
  `literal_added`; `score = src_copied·MAX_SCORE/max(src_size, dst_size)`,
  `MAX_SCORE = 60000`. Reported integer = `(int)(score·100/MAX_SCORE)` —
  **truncation** (1-of-10-line edit → 87%; 900/1000 bytes → 89%).
- **Threshold.** default 50% → `minimum_score = 30000`. Test is
  `score >= minimum_score` (a 39% pair does NOT pair at `-M40%`).
- **Size prefilter.** early-reject pairs whose size delta alone cannot reach the
  threshold — cost-only, changes no decision.
- **Rename limit.** `num_create · num_src > limit` ⇒ skip the inexact pass
  entirely; exact renames still emit. `limit = 0` ⇒ unlimited (git hard cap 32767).
- **Greedy matrix (NOT optimal).** score every pair, sort score-descending,
  greedily record the best still-available match (`record_if_better`), each src
  consumed by at most one dst (ADR-371).

### 3.2 Layering — pure scorer + primitive orchestrator (ADR-366)

- **Domain (pure, no I/O):** `estimateSimilarity(src: Uint8Array, dst: Uint8Array): number`
  in `src/domain/diff/similarity.ts` — the spanhash counter + `score = src_copied·MAX_SCORE/max_size`,
  returning the raw `0..MAX_SCORE` score. Exports `MAX_SCORE`,
  `DEFAULT_RENAME_THRESHOLD` (`30000` = 50%), `DEFAULT_BREAK_SCORE`
  (`30000` = 50%, the `<n>` break-attempt gate), `DEFAULT_MERGE_SCORE`
  (`36000` = 60%, the `<m>` keep-broken gate — both pinned in §5.1), and
  `toSimilarityPercent(score) = (score·100/MAX_SCORE) | 0`.
- **Primitive (I/O orchestrator):** `detectSimilarityRenames(ctx, diff, options)`
  in `src/application/primitives/detect-similarity-renames.ts`. It runs the pure
  `detectRenames` (exact pass) first, then on the leftover unpaired adds/deletes
  hydrates blobs (bounded pool, mirroring `materialisePatchFiles`), builds the
  score matrix, runs git's greedy selection, and emits `rename`/`copy` winners.
  The break pass (3.6) runs **before** this orchestrator inside the same
  primitive so its halves feed the matrix.

```
diffTrees primitive (ctx)
  │
  ├─ break pass (when -B)        ← split dissimilar modifies into D/A before pairing
  ├─ detectRenames(rawDiff)      ← pure domain, exact R100 (unchanged)
  └─ detectSimilarityRenames(ctx, …)  ← hydrate leftovers
        ├─ rename-limit guard (skip inexact when over)
        ├─ readBlob(candidate adds/deletes + copy sources)  bounded pool
        ├─ estimateSimilarity(srcBytes, dstBytes)  ← pure domain scorer
        └─ greedy best-match matrix → rename + copy winners ≥ threshold
```

`diffTrees` swaps the lone `detectRenames(...)` call for
`await detectSimilarityRenames(ctx, rawDiff, options.renameOptions)`. Every
existing consumer threads through `diffTrees`, so none changes its call.

**Faithfulness correction (latent bug).** The current `detectRenames` quadratic
guard (`rename-detect.ts:75`) bails the **entire** pass — exact included — over the
limit. git never limits exact pairing (matrix #6). The redesign moves the limit
onto the inexact matrix only; exact pairing always runs (ADR-370).

### 3.3 Pinned faithfulness matrix — renames

Real `git version 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, signing off,
isolated `HOME`, throwaway `mktemp -d` repo. `git diff --no-ext-diff -M`.

| # | Scenario | `git` result | Load-bearing fact |
|---|---|---|---|
| 1 | 1 of 10 lines changed, file renamed | `R087` + `similarity index 87%`, `rename from`/`to`, `index …100644`, hunk | spanhash, truncated — not 90% line ratio |
| 2 | ~40% similar | `D`+`A` at `-M40%`; `R040` at ≤`-M40` | `score >= minimum_score`; `R040` pairs at `-M40`, NOT at `-M41` |
| 3 | dst identical to src1, both deleted | `R100 src1→dst` + `D src2` | exact pass wins src1 first |
| 4 | mode change + rename | `old mode`/`new mode` **before** `similarity index 71%`; `index …` **no trailing mode** | mode preamble precedes similarity; index line omits mode when modes differ |
| 5 | pure rename (`git mv`) | `similarity index 100%`, `rename from`/`to`, **no** `index`, **no** hunk | R100 byte-identical to today |
| 6 | inexact 5×5, `renameLimit=2` | all `A`/`D`, no pairs; exact untouched | inexact skipped past limit (ADR-370) |
| 7 | 5×5 near-equal | 4 pair `R083`, 1 stays `A`/`D` | greedy, not optimal (ADR-371) |
| 8 | 5×5 each clear best | all 5 pair `R089` | unambiguous best-match |
| 9 | empty-file rename | `R100` | size-0 via exact pass |
| 10 | `modify` alongside add/delete | `M kept.txt` + `R075 moved→target` | `modify` is never an inexact rename source |

## 4. Design — copy detection (`-C`)

### 4.1 Git's copy semantics (pinned)

A copy pairs an `add` (the destination) against a **source that is NOT deleted**,
and **does not consume** that source — the source keeps its own change entry. git
scores copies with the same `estimate_similarity`, against the source's
**preimage** blob. The source set differs by flag:

- **`-C` (plain):** copy sources = files that are themselves **modified in the
  diff** (`rename_src` already populated by the rename pass — git reuses changed
  files as copy sources). An **unchanged** file is NOT a copy source under plain
  `-C` (pinned #C1b).
- **`-C --find-copies-harder` (`-C -C`):** copy sources = **ALL** paths in the
  preimage tree, including unchanged ones (pinned #C2). This is enormously more
  expensive — every unchanged blob enters the source set.

`--name-status` shows `C<score>` `src` `dst`; patch shows `copy from <src>` /
`copy to <dst>`. Copy-vs-rename precedence: when a deleted source (rename) and a
retained source (copy) both match a dst, git prefers the **rename** (pinned #C3).

### 4.2 Pinned faithfulness matrix — copies

`git diff --no-ext-diff -C` / `-C --find-copies-harder` / `-C -M`.

| # | Scenario | `git` result | Load-bearing fact |
|---|---|---|---|
| C1 | dst copies a **modified** source `src.txt` (`src` edited too); 72% similar to src's preimage | `C072 src.txt dst.txt` + `M src.txt`; patch: `diff --git a/src.txt b/dst.txt` / `similarity index 72%` / `copy from src.txt` / `copy to dst.txt` / `index 92dfa21..1d6226c 100644` / hunk | source **retained** (still `M`); dst scored vs source **preimage** oid; `<100%` ⇒ index+hunk |
| C1b | same dst but source **unchanged**, plain `-C` | `A dst.txt` (NO copy) | plain `-C` does not scan unchanged sources |
| C2 | dst 84% copy of an **unchanged** `orig.txt`, `--find-copies-harder` | `C084 orig.txt copy.txt` | `--find-copies-harder` adds all preimage paths to the source set |
| C3 | deleted `del-src` (rename) AND unchanged `keep-src` (copy) both match `new.txt`, `-C --find-copies-harder` | `R081 del-src.txt new.txt` (rename wins, no copy) | rename precedence over copy for a shared dst |
| C4 | `=== MAX_SCORE` exact copy (dst byte-identical to a retained source) | `C100` + `copy from`/`copy to`, **no** `index`, **no** hunk | copy mirrors R100 patch shape (header stops after `copy to`) |

### 4.3 `CopyChange` shape (ADR-367 convention)

```ts
export interface CopyChange {
  readonly type: 'copy';
  readonly oldPath: FilePath;   // the retained source path
  readonly newPath: FilePath;   // the copy destination path
  readonly oldId: ObjectId;     // source PREIMAGE blob (scored side, index left side)
  readonly newId: ObjectId;     // destination blob
  readonly oldMode: FileMode;
  readonly newMode: FileMode;
  readonly similarity: SimilarityScore;  // identical shape to RenameChange (ADR-368)
}
```

Added to `DiffChange` and `DiffChangeType` (`'copy'`). The **only** structural
difference from `RenameChange` is the discriminant: a copy does **not** consume
its source from the diff, so the source's own `add`/`modify`/unchanged status is
preserved alongside the `copy`. The serializer branches on `type === 'copy'` to
emit `copy from`/`copy to` instead of `rename from`/`rename to`; everything else
(similarity index, mode preamble, index line, hunk) is shared with the rename
renderer.

### 4.4 Feeding sources into the matrix

`detectSimilarityRenames` builds the candidate-source list per flag:

- **rename sources** = leftover unpaired **deletes** (consumed on match).
- **copy sources** (`copies !== 'off'`) = the **preimage** blobs of:
  - `copies: 'on'`: paths changed in the diff (modifies + the deletes already in
    the rename source set) — git's plain-`-C` source set;
  - `copies: 'harder'`: **all** preimage paths (every blob in tree A), unchanged
    included — git's `--find-copies-harder` set.

A copy source's scored bytes are its **preimage** content (read via its `oldId`).
The greedy matrix (3.1) holds rename and copy candidates together; rename
candidates sort ahead of copy candidates at equal score (matrix #C3), and a copy
winner emits a `copy` without removing its source from the result set.

**Limit interaction (ADR-370).** The rename limit counts `num_create · num_src`
where `num_src` includes copy sources. Under `--find-copies-harder` `num_src`
balloons to the whole preimage, so the limit is reached far sooner — pinned by an
interop case that crosses the limit only under `harder`. Decision D5 governs
whether copy sources count toward the limit (recommend: yes, matching git).

## 5. Design — break detection (`-B`)

### 5.1 Git's break semantics (pinned)

`-B[<n>][/<m>]` operates in `diffcore-break.c` **before** rename/copy detection.
Two independent gates, both pinned (§5.2):

- **Break-attempt gate `<n>` (default 50% = `30000`).** A `modify` whose
  **dissimilarity** (`MAX_SCORE - similarity`, scored as `literal_added +
  literal_deleted` over the larger size) is **≥ `<n>`** is *split* into a delete
  (preimage) + add (postimage) pair, making it eligible to feed rename/copy
  detection — the delete-half a rename **source**, the add-half a rename/copy
  **destination**.
- **Keep-broken gate `<m>` (default 60% = `36000`).** After detection, a break
  that no half was consumed by is **re-merged** back into a single `modify`
  **unless** its dissimilarity is **≥ `<m>`**. A passed `<m> = 0` means "unset →
  use the 60% default" (pinned — `-B/0` re-merges a 55% break exactly like
  default `-B`). So `-B` ≡ `-B50%/60%`, and the keep-broken boundary is
  `dissimilarity >= <m>` (inclusive).
- A break that **stays broken** surfaces in patch as `dissimilarity index <p>%`
  (replacing `similarity index`) and in `--name-status` as `M<p>`, `p` = truncated
  dissimilarity percent. It stays a **single `modify`** at one path — NOT split
  into separate `D`+`A` entries — unless a half was consumed by a rename/copy
  (in which case the resulting `rename`/`copy` expresses the outcome).

### 5.2 Pinned faithfulness matrix — breaks

`git diff --no-ext-diff -B` / `-B/<m>`. (`M<n>` ⇒ broken & kept; `M` ⇒ re-merged.)

| # | Scenario | `git` result | Load-bearing fact |
|---|---|---|---|
| B1 | fully-disjoint rewrite (0 shared spans), default `-B` | patch `dissimilarity index 100%` + `index …` + full D/A hunk; `--name-status M100` | break stays broken; a **single `modify`** carrying dissimilarity 100% |
| B2 | 66% dissimilar single-file rewrite, default `-B` | `M066` (66 ≥ 60 ⇒ kept) | default keep-broken gate `<m>` = 60% |
| B3 | 50% dissimilar, default `-B` | `M` (50 < 60 ⇒ re-merged) | break attempted (≥ 50% `<n>`) but re-merged (< 60% `<m>`) |
| B4 | 55% dissimilar: `-B/54%`→`M055`, `-B/55%`→`M055`, `-B/56%`→`M` | keep-broken iff `dissimilarity ≥ <m>` (inclusive) | the `<m>` boundary is inclusive and overridable |
| B4b | 55% dissimilar, `-B/0` | `M` (re-merged, identical to default) | `<m> = 0` ⇒ "unset → default 60%", not literal 0 |
| B5 | boundary sweep K/100 replaced, default `-B` | first `M<n>` at **K=60** (`M060`); `M` for K ≤ 59 | keep-broken boundary = the `<m>` gate (60%), not `<n>` (50%) |
| B6 | break feeding a rename: heavily-rewritten path + a sibling matching its preimage, `-B -M` | order pinned: break (split) → rename → copy → re-merge | a fired break makes the delete-half a rename source; the positive trigger is subtle (a surviving same-path add reclaims the path) — **pinned in interop by iterating the fixture, not asserted from a single design probe** |

Note on B6: a break produces a rename only when the delete-half is a *better*
rename source than leaving the modify intact AND no same-path add reclaims the
path. The design implements git's fixed order (break → rename → copy → re-merge);
the interop test pins the positive case empirically — a single design probe did
**not** trigger it, which is itself the load-bearing caution (do not assert a
break-then-rename from memory; pin it).

### 5.3 Break-result representation (Decision D3)

A break that stays broken surfaces as a `modify` carrying a **dissimilarity**
datum, mirroring the similarity shape:

```ts
export interface ModifyChange {
  readonly type: 'modify';
  // …existing oldId/newId/oldMode/newMode/path…
  readonly broken?: SimilarityScore;  // DISSIMILARITY datum (score = MAX_SCORE − similarity);
                                      // present iff -B kept this modify broken
}
```

`broken.score` holds the **dissimilarity** raw value (`MAX_SCORE − similarity`), so
the same `toSimilarityPercent` projection yields git's `M<p>` / `dissimilarity
index <p>%` integer. The serializer emits `dissimilarity index
<toSimilarityPercent(broken.score)>%` (and `--name-status M<p>`) when `broken` is
present, else the normal modify body.
This keeps one `modify` variant (no split into `D`+`A`) faithful to git's
on-disk `M<n>` representation — see D3 for the rejected D/A-pair alternative.

When a broken half is **consumed by a rename/copy**, the outcome is already
expressed by the resulting `rename`/`copy` + the surviving `add`/`modify`; no
`broken` flag is needed on those.

## 6. Patch serializer reconstruction (ADR-249)

`renderRenameBlock` (`patch-serializer.ts:498`) and a new `renderCopyBlock`
reconstruct git's text from the structured fields, byte-pinned by the matrices:

1. `diff --git a/<old> b/<new>`
2. mode preamble when `oldMode !== newMode`: `old mode <oldMode>` / `new mode <newMode>`
3. `similarity index <toSimilarityPercent(score)>%`
4. `rename from`/`to` **or** `copy from`/`to` (the only line that differs)
5. when `score < MAX_SCORE`: `index <shortOid(oldId)>..<shortOid(newId)>[ <mode>]`
   (mode suffix only when `oldMode === newMode`, matrix #4) **and** the hunk body
   over the hydrated source/dst bytes
6. when `score === MAX_SCORE`: stop after step 4 (matrix #5 / #C4)

For a **broken modify**, `renderModifyOrTypeChangeBlock` emits
`dissimilarity index <p>%` in place of the `index` line's predecessor when
`change.broken` is present (matrix #B1).

`materialiseOne` (`materialise-patch-files.ts:43`):
- `rename`: load both sides when `score < MAX_SCORE`, neither when `=== MAX_SCORE`.
- `copy`: **always load both sides** when `score < MAX_SCORE` (source preimage via
  `oldId`, dst via `newId`); neither when `=== MAX_SCORE` (matrix #C4).
- `modify` with `broken`: unchanged (already loads both sides).

The `R<n>`/`C<n>`/`M<n>` (`--name-status`) and the `similarity index`/`copy
from`/`dissimilarity index` (patch) renderings are the **same**
`toSimilarityPercent` projection — confirmed by matrices #1 (`R087`⇔87%), #C1
(`C072`⇔72%), #B2 (`M066`⇔66%).

## 7. Option API surface

### 7.1 Structured options (Decision D2)

`RenameDetectOptions` (`src/domain/diff/rename-detect.ts:6`) grows:

```ts
export interface RenameDetectOptions {
  readonly limit?: number;            // inexact matrix cap; 0 = unlimited (ADR-370)
  readonly maxSameIdDeletes?: number; // unchanged
  readonly threshold?: number;        // rename minimum_score, 0..MAX_SCORE; default 30000
  readonly copies?: 'off' | 'on' | 'harder';     // -C / -C --find-copies-harder; default 'off'
  readonly copyThreshold?: number;    // -C<n>; default = threshold
  readonly breakRewrites?: { readonly score: number; readonly merge: number } | false;
                                      // -B<n>/<m>; default false (off).
                                      // score = <n> break-attempt gate (default 30000 = 50%)
                                      // merge = <m> keep-broken gate (default 36000 = 60%)
                                      // a merge of 0 maps to the 36000 default (pinned #B4b)
}
```

Threading: `DiffTreesOptions.renameOptions` (`primitives/types.ts:189`) already
carries `RenameDetectOptions` — no new key. `DiffOptions`
(`commands/diff.ts:8`) and `RepositoryConfig` (`ports/context.ts:84`) currently
expose only the boolean `detectRenames`; they gain a `renameOptions?:
RenameDetectOptions` pass-through so the facade can configure threshold/copies/
breaks. Defaults preserve today's behaviour: detection off unless requested;
when on, threshold 50%, copies off, breaks off.

### 7.2 Threshold parsing (faithful, pinned)

git's `-M<n>`/`-C<n>`/`-B<n>` number → `minimum_score` (pinned #T1–#T3):

| Input form | Meaning | `minimum_score` |
|---|---|---|
| `-M50%` | literal percent | `50·MAX_SCORE/100 = 30000` |
| `-M5%` | literal percent | `5·MAX_SCORE/100 = 3000` |
| `-M50` | bare int = fractional part after implicit `.` (`-M50` ≡ `-M0.50` ≡ 50%) | `30000` |
| `-M5` | `-M5` ≡ `-M0.5` ≡ 50% | `30000` |
| `-M4` ≡ `-M40` | `0.4` ≡ 40% | `24000` |
| `-M0.40` ≡ `-M.4` | fraction | `24000` |

Pinned boundary: a pair scoring `R040` pairs at `-M40`/`-M4`/`-M0.40`/`-M40%` but
**not** at `-M41`/`-M5`/`-M50` — the test is `score >= minimum_score` (inclusive).
The library accepts a **numeric `threshold` in `0..MAX_SCORE`** directly (callers
do the form→score parse, or a thin helper mirrors git's `%`/`.`/bare rules); the
data layer never sees the textual form (ADR-249).

### 7.3 Threshold-sweep faithfulness matrix

| # | Scenario | `git` result | tsgit equivalent |
|---|---|---|---|
| T1 | `R040` pair at `-M40` / `-M4` / `-M0.40` / `-M40%` | pairs | `threshold: 24000` ⇒ pairs |
| T2 | same pair at `-M41` / `-M5` / `-M50` | `A`/`D` | `threshold: 24600` / `30000` ⇒ no pair |
| T3 | `-C<n>` copy threshold below/above a 72% copy | pairs/doesn't | `copyThreshold` boundary |
| T4 | `-B<n>/<m>` two-number sweep (#B2–#B5): vary `<n>` (break-attempt) and `<m>` (keep-broken) | `M<n>` (kept) vs `M` (re-merged) | `breakRewrites: { score, merge }`; `merge: 0` ⇒ 36000 |

## 8. Edge-case table

| Case | Behaviour | Source |
|---|---|---|
| identical blob ids | exact pass, R100, no scoring | matrix #3/#5 |
| similarity ≥ threshold | rename, truncated percent | #1 |
| similarity < threshold | no pair | #2 |
| near-equal scores | greedy (not optimal); may orphan | #7/#8 (ADR-371) |
| mode change + rename | `old/new mode` preamble; `index` omits mode suffix | #4 |
| copy from modified source (plain `-C`) | `copy`, source retained, scored vs preimage | #C1 |
| copy from unchanged source | only under `--find-copies-harder` | #C1b/#C2 |
| copy ≡ MAX_SCORE | `C100`, no index/hunk | #C4 |
| copy-vs-rename for shared dst | rename wins | #C3 |
| `--find-copies-harder` over limit | inexact skipped earlier (more sources) | #C2 + ADR-370 |
| dissimilarity ≥ `<n>` (50%) AND ≥ `<m>` (60%) | stays broken; `modify.broken` set; `dissimilarity index`/`M<n>` | #B1/#B2/#B5 |
| dissimilarity ≥ `<n>` but < `<m>` | re-merged to plain `modify` | #B3 |
| `-B/0` passed | `<m>` = 0 ⇒ 60% default (not literal 0) | #B4b |
| break enables rename | delete-half pairs; order break→rename→copy→re-merge | #B6 |
| empty source/target | size-0 ⇒ exact pass if id-equal; else score 0 | #9 |
| binary blobs | byte-spanhash is content-agnostic; **pin empirically before relying** | `isBinary` path |
| `modify` present, no `-B` | never an inexact rename source | #10 |
| matrix over rename limit | inexact (renames+copies) skipped; exact unaffected | #6 (ADR-370) |

## 9. Decision candidates (NEW — ADR-369 expansion only)

ADRs 366–371 fix the layering, the `rename` shape, the score unit, the scope, the
limit semantics, and the selection algorithm. The decisions below are the
**new** load-bearing choices the `-C`/`-B`/threshold expansion introduces and
that the ADRs did NOT decide. ≤3 options each, with a recommendation; the user
ratifies.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | `CopyChange` exact shape | (a) two-sided `oldPath/newPath/oldId/newId/oldMode/newMode + similarity`, source **retained** — mirrors `RenameChange` 1:1, discriminant `'copy'`; (b) reuse `RenameChange` with an added `consumesSource: boolean`; (c) `CopyChange` carrying only `{ fromPath, toPath, similarity }` and resolving ids/modes from the source's own change | **(a)** | ADR-367 says a `copy` follows the two-sided + `similarity` convention; (a) lets the serializer share the rename renderer (only `from`/`to` keyword differs) and the matrix sort treats both uniformly; (b) overloads one variant with a behavioural flag (consumers must branch on data, not type); (c) under-specifies — the index line needs the source **preimage** oid, which isn't derivable when the source is unchanged |
| D2 | Option API naming / shape | (a) extend `RenameDetectOptions` with `threshold` + `copies: 'off'\|'on'\|'harder'` + `copyThreshold` + `breakRewrites: {score,merge}\|false`; (b) split into separate `findRenames` / `findCopies` / `breakRewrites` option objects on `DiffTreesOptions`; (c) a flat `diffcoreOptions` bag with git-name keys (`M`, `C`, `B`, `findCopiesHarder`) | **(a)** | one cohesive options object already threaded through `diffTrees` (no new `DiffTreesOptions` key); names read as intent not as git flags (ADR-249 spirit); `breakRewrites` as `{score,merge}\|false` captures the two-number `-B<n>/<m>` natively; (b) fragments a single diffcore concern across three knobs; (c) leaks git's terse flag letters into the public type |
| D3 | `-B` broken-result representation | (a) keep one `modify` variant + optional `broken?: SimilarityScore` (dissimilarity datum), faithful to git's `M<n>` single-path on-disk shape; (b) split a kept-broken modify into a `delete`+`add` pair; (c) a new `break` change type | **(a)** | git surfaces a kept-broken break as a **single** `M<n>` at one path with a `dissimilarity index` line (pinned #B1) — NOT two entries; (a) reconstructs that byte-for-byte and adds no union member; (b) diverges from git's `--name-status` (`M100` ≠ `D`+`A`) and would mis-drive consumers; (c) is churn for a state git models as a modify |
| D4 | `--find-copies-harder` representation | (a) third enum value `copies: 'harder'` on the existing knob; (b) a separate boolean `findCopiesHarder` alongside `copies: boolean`; (c) repeated `copies` count (`1` = `-C`, `2` = `-C -C`) mirroring git's `-C -C` | **(a)** | the three states (off / changed-sources / all-sources) are mutually exclusive and ordered, so one enum is the precise model; (b) admits the nonsensical `{copies:false, findCopiesHarder:true}`; (c) couples the API to git's flag-repetition quirk |
| D5 | Does the rename limit count copy sources? | (a) yes — `num_src` includes copy sources (so `--find-copies-harder` hits the limit far sooner), matching git; (b) no — copies are limited by a separate cap; (c) copies ignore the limit entirely | **(a)** | git's `diffcore-rename` counts copy sources in the same `num_src · num_create` product that gates the whole inexact pass (the cost `--find-copies-harder` pays); (a) reproduces the pinned over-limit behaviour under `harder`; (b)/(c) invent a non-git cap and would diverge on a large preimage |
| D6 | Copy source set under plain `-C` | (a) faithful: sources = files **modified in the diff** (git's `rename_src` reuse), unchanged files excluded — pinned #C1b; (b) treat all preimage paths as sources for plain `-C` too (simpler, one code path) | **(a)** | pinned #C1b proves plain `-C` does **not** copy from an unchanged source; (b) would emit copies git never reports (a faithfulness regression) and erase the `-C` vs `--find-copies-harder` cost/semantics distinction the brief requires pinning |

## 10. Test strategy

**Unit — `src/domain/diff/similarity.test.ts`** (pure scorer): identical → `MAX_SCORE`;
disjoint → 0; one-of-ten edit → pinned `R087` score; empty vs empty; size-asymmetric
bounded by `max_size`; **dissimilarity** projection for `-B`. Isolated guard tests
for the threshold comparison and the size prefilter (assert exact scores).

**Unit — `similarity.properties.test.ts`** (`fast-check`, lens 2 + 4): identity
`estimateSimilarity(x,x) === MAX_SCORE`; symmetric `max_size` bound; `toSimilarityPercent`
monotone non-decreasing + floor; dissimilarity = `MAX_SCORE − score`. `numRuns` 100.
Examples stay (literal git scores); the property proves the grammar.

**Unit — `detect-similarity-renames.test.ts`** (mocked `readBlob`): exact pass
consumes id-equal pairs first; a ≥threshold leftover folds with the right two-sided
fields; a copy folds **without** consuming its source; copy source sets per
`copies` enum (`on` = changed only, `harder` = all preimage); copy-vs-rename
precedence (#C3); break splits a dissimilar modify before pairing and re-merges
under `<m>`; over-limit ⇒ no inexact folding (counting copy sources, D5); greedy
winner = git's sort (#7/#8).

**Unit — `patch-serializer.test.ts`**: `renderRenameBlock`/`renderCopyBlock` for
`score < MAX_SCORE` (similarity/copy index + hunk), mode-change preamble + omitted
index mode suffix, `score === MAX_SCORE` byte-identical to today; `dissimilarity
index` for a broken modify. `materialise-patch-files.test.ts`: copy loads both
sides; `<100%` rename loads both, `100%` neither.

**Unit — consumer regressions**: `blame.test.ts` reads `oldId`; `change-path`
`copy` case; `range-diff/patch-text` `copy` header; `diff-change` exhaustiveness
compiles with `copy`.

**Interop — `test/integration/rename-similarity-interop.test.ts`** (new, twin
real-`git` vs tsgit, double-pinned against a frozen golden like
`diff-recursive-interop`): the full matrix across all four surfaces — renames
(#1,#2,#4,#5,#6,#7,#8,#10), **copies (#C1 clean copy, #C2 find-copies-harder from
an unchanged source, #C3 copy-vs-rename precedence, #C4 C100)**, **breaks (#B1
stays broken / dissimilarity index, #B2/#B5 merge-gate boundary, #B3 re-merge,
#B6 break-then-rename ordering)**, **threshold sweeps (#T1/#T2 `-M40` boundary,
#T3 `-C` threshold, #T4 `-B` two-number)**. Assert tsgit's reconstructed
`git diff -M -C -B` bytes (via the serializer) and `--name-status`
`R<n>`/`C<n>`/`M<n>` equal live `git` + the golden. Skips when `git` is absent.

## 11. Out of scope

- The stderr rename-limit warning text — rendering (ADR-249); tsgit surfaces the
  faithful *data* outcome (unpaired), not a printed warning (ADR-370).
- `--rename-empty` / whitespace-insensitive scoring (`-w`) — non-default git knobs.
- `diff.renames` / `diff.copies` config-file driven defaults — the facade may map
  config to `renameOptions` later; this change ships the option surface, not the
  config-file plumbing.
- Copy detection across history (`-C` over a `log` walk's combined diff) — the
  per-pair primitive is reused, but multi-commit copy provenance is a `log`
  concern, not this diffcore pass.
