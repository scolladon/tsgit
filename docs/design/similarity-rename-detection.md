# Design — similarity rename detection

> Brief: pair an `add` with a `delete` when their blob CONTENTS are ≥ git's
> default 50% similarity (not just on identical blob ids), reproducing git's
> pairing decisions and reported similarity score byte-for-byte.
> Status: draft → self-reviewed ×3 → accepted

## Context

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
candidates now surface as flat full-path adds/deletes
(`docs/design/diff-recursive-tree-diff.md`), so similarity pairing operates over a
flat candidate list regardless of directory nesting.

`RenameChange` (`src/domain/diff/diff-change.ts`) carries a **single** `id`/`mode`,
baked on the R100 assumption `oldId === newId` and `oldMode === newMode`. A
similarity rename violates both. The shape and every consumer must grow.

Constraining decisions already made:
- **ADR-226 / CLAUDE.md (git-faithfulness prime directive):** replicate git's
  observable pairing + reported score byte-for-byte; pin against real `git`.
- **ADR-249 (structured data only):** the similarity score is a structured
  **field**; the `R<n>` / `similarity index n%` *text* is reconstructed by the
  caller-facing patch serializer, never returned pre-rendered.

Consumers of `RenameChange` (full audit):

| Consumer | File:line | Uses today | Impact |
|---|---|---|---|
| patch render | `patch-serializer.ts:498` `renderRenameBlock` | hardcodes `similarity index 100%`, emits no `index`/hunk | must render real `index N%`, mode preamble, `index <o>..<n> <mode>`, hunk body |
| blame | `blame.ts:338` `renamedSource` | `change.id` (source blob) | needs `oldId` |
| range-diff text | `range-diff/patch-text.ts:68,77` | `oldPath`/`newPath` only | none (path-only) |
| sort key | `change-path.ts:11` `primaryPath` | `newPath` | none |
| hydrate | `materialise-patch-files.ts:52` | returns `{ change }`, loads nothing | must load both sides for a <100% rename |

Pass-`detectRenames: true` sites (all must keep working):
`commands/diff.ts`, `blame.ts:335`, `range-diff.ts:72`, `internal/commit-diff.ts:23`
(→ `show` / `log -p`); facade options `ports/context.ts:84`,
`primitives/types.ts:188`.

## Requirements

1. An `add` and a `delete` whose contents are **≥ 50%** similar (git's default)
   pair into a `rename`; a pair **< 50%** does not — matching git's decision.
2. The reported similarity equals git's: integer percent `(int)(score·100/MAX_SCORE)`
   computed over git's spanhash-counted copied bytes, **truncated** (pinned:
   `R087` for a one-of-ten-line change, `R089` for 900/1000 shared bytes — never a
   naive line ratio).
3. Exact (R100) pairing is unchanged and still runs **before** the similarity pass.
4. When the inexact candidate matrix exceeds the rename limit, the similarity pass
   is **skipped** (adds/deletes stay unpaired) — git's fallback; **exact pairing is
   unaffected by the limit** (corrects the current whole-pass bail, which is
   non-faithful per matrix #6).
5. When multiple deletes match one add, git's winner is selected (best score;
   git's tie-break order preserved).
6. `RenameChange` carries `oldId`/`newId`/`oldMode`/`newMode` + a structured
   similarity field; the patch serializer reconstructs `similarity index N%`,
   `rename from/to`, mode preamble, `index <old>..<new> <mode>`, and the hunk body
   from those fields, byte-equal to `git diff -M`.
7. Every existing `detectRenames: true` consumer keeps working; R100 patch/blame
   output is byte-unchanged.
8. The full matrix is pinned by a `*-interop` test (twin real-`git` vs tsgit).

## Design

### 3.1 Git's algorithm (pinned, not recalled)

git pairs renames in `diffcore-rename.c` over `diffcore-delta.c`. Reproduced facts:

- **Two passes.** `find_exact_renames` first (identical blob oid → R100), **not**
  gated by the rename limit. Then the **inexact** pass: build a rename matrix of
  `(src, dst)` scores, greedily pick best matches. tsgit already owns the exact
  pass; this feature adds the inexact pass.
- **Score basis = spanhash fingerprint, not lines.** `diffcore_count_changes`
  chunks each blob into variable-length spans (hashed running sum, boundary on a
  hash condition), counts `src_copied` (bytes of src whose span-hash survives into
  dst) and `literal_added`. `score = src_copied · MAX_SCORE / max(src_size, dst_size)`
  with `MAX_SCORE = 60000`. The reported integer is `(int)(score · 100 / MAX_SCORE)`
  — **truncation**. This is why a 1-of-10-line edit reports **87%**, and 900/1000
  shared bytes reports **89%**, not 90% (the edit straddles span boundaries).
- **Threshold.** default `50%` → `minimum_score = 30000` (`= 50·60000/100`). The
  test is `score >= minimum_score` (pinned: a 39% pair does NOT pair at `-M40%`).
- **Size prefilter.** before counting, git early-rejects a pair whose size delta
  alone cannot reach the threshold (`max_size · (MAX_SCORE-minimum_score)` bound) —
  a cheap reject that changes no decision, only cost.
- **Rename limit.** `diff.renameLimit` (default 1000) caps the inexact matrix. When
  `num_create · num_src` exceeds it, git **skips the inexact pass entirely** and
  warns on stderr (pinned text: `"warning: exhaustive rename detection was skipped
  due to too many files."` + `"you may want to set your diff.renameLimit variable
  to at least N and retry"`). Exact renames still emit. `renameLimit=0` means
  "unlimited" (internal hard cap 32767).
- **Best-match + greedy matrix (NOT optimal assignment).** git scores every
  `(src, dst)` pair, sorts candidates by score descending, and greedily records the
  best still-available match (`record_if_better`), each src consumed by at most one
  dst. This is **greedy, not a globally-optimal (Hungarian) matching**: when several
  srcs score near-equally against several dsts, the greedy order can leave a
  candidate orphaned that an optimal matcher would have paired (pinned: 5 srcs each
  near-equally similar to all 5 dsts → 4 pair R083, 1 stays A/D; but 1–4 candidates,
  or 5 candidates each with a *clearly* best src, all pair). Faithfulness requires
  reproducing git's greedy order and its score sort, not "improving" on it.

### 3.2 Pinned faithfulness matrix

Real `git version 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, signing off,
isolated `HOME`, throwaway `mktemp -d` repo. `git diff --no-ext-diff -M`.

| # | Scenario | `git` result | Load-bearing fact |
|---|---|---|---|
| 1 | 1 of 10 lines changed, file renamed | `R087` + `similarity index 87%`, `rename from`/`to`, `index 4083766..1539cbd 100644`, hunk body | score is byte-spanhash, truncated — not 90% line ratio |
| 2 | ~40% similar (6/10 lines replaced) | `D a.txt` + `A b.txt` (even at `-M40%`); `R039` only at `-M01%` | `score >= minimum_score`; 39 < 40 ⇒ no pair |
| 3 | dst identical to src1, src2 unrelated, both deleted | `R100 src1→dst` + `D src2` | exact pass wins src1 before inexact |
| 4 | mode change + rename | `old mode 100644`/`new mode 100755` **before** `similarity index 71%`; `index 5f2e898..4e821e4` (**no trailing mode**, modes differ); hunk body | mode preamble precedes similarity; index line omits mode when modes differ |
| 5 | pure rename (`git mv`, no edit) | `similarity index 100%`, `rename from`/`to`, **no** `index` line, **no** hunk body | R100 stays byte-identical to today |
| 6 | inexact 5×5, `renameLimit=2` | all `A`/`D`, no pairs + the two warning lines on stderr | inexact pass skipped past limit; exact untouched |
| 7 | inexact 5×5, every src near-equally similar to every dst | 4 pair `R083`, 1 stays `A`/`D` (1–4 candidates all pair) | git's selection is **greedy, not optimal** — orphans a pair an optimal matcher would keep |
| 8 | inexact 5×5, each dst keeps its src's unique line (clear best) | all 5 pair `R089` | unambiguous best-match pairs every dst |
| 9 | empty-file rename | `R100` | size-0 handled by exact pass |
| 10 | modify alongside add/delete | `M kept.txt` + `R075 moved→target` | `modify` is never a rename source (only adds/deletes feed the matrix) |

### 3.3 Layering — pure scorer + primitive orchestrator

The exact pass stays pure-domain (zero I/O). The inexact pass needs blob **bytes**,
so it lives in the **primitive** tier where `ctx` already exists. Two pieces:

- **Domain (pure, no I/O):** `estimateSimilarity(src: Uint8Array, dst: Uint8Array): number`
  in a new `src/domain/diff/similarity.ts` — the spanhash counter +
  `score = src_copied·MAX_SCORE/max_size`, returning the **0..MAX_SCORE** raw score.
  Pure, deterministic, unit- and property-testable (round-trip-free but
  invariant-rich: identical inputs → MAX_SCORE; disjoint → 0; symmetric size
  bound). Exports `MAX_SCORE`, `DEFAULT_RENAME_THRESHOLD` (30000), and the
  percent projection `toSimilarityPercent(score) = (score·100/MAX_SCORE) | 0`.
- **Primitive (I/O orchestrator):** `detectSimilarityRenames(ctx, diff, options)`
  in a new `src/application/primitives/detect-similarity-renames.ts`. It runs the
  existing pure `detectRenames` (exact pass) first, then on the **leftover**
  unpaired adds/deletes: applies the rename-limit guard, hydrates only those blobs
  (bounded pool, mirroring `materialisePatchFiles`), builds the score matrix via
  the domain `estimateSimilarity`, runs git's best-match greedy selection, and
  emits `rename` changes for winners ≥ threshold.

`diffTrees` (`primitives/diff-trees.ts:43`) swaps the lone `detectRenames(...)`
call for `await detectSimilarityRenames(ctx, rawDiff, options.renameOptions)`.
Every existing consumer threads through `diffTrees`, so none changes its call.

```
diffTrees primitive (ctx)
  │
  ├─ detectRenames(rawDiff)            ← pure domain, exact R100 (unchanged)
  └─ detectSimilarityRenames(ctx, …)   ← NEW primitive: hydrate leftovers
        ├─ rename-limit guard (skip + record warning when over)
        ├─ readBlob(leftover adds+deletes)  bounded pool
        ├─ estimateSimilarity(srcBytes, dstBytes)  ← pure domain scorer
        └─ greedy best-match matrix → rename winners ≥ threshold
```

The exact pass must run first and consume its pairs **before** the matrix is built
(requirement 3 + matrix #3): exact pairs are removed from the leftover pool, so the
inexact pass only scores genuinely-unpaired candidates. Concretely
`detectSimilarityRenames` calls the existing pure `detectRenames(rawDiff)` (which
preserves `maxSameIdDeletes`), then re-partitions **its result** — the surviving
unpaired adds/deletes — as the inexact candidate pool.

**Faithfulness correction (latent bug).** The current `detectRenames` quadratic
guard (`rename-detect.ts:75`, `adds·deletes > limit ⇒ return diff`) bails the
**entire** pass — exact pairing included — when the diff is large. git never limits
exact pairing (matrix #6: R100 renames still emit over the limit; only the inexact
pass is skipped). The exact pass is id-bucketed (O(adds+deletes) hash lookup), not
quadratic, so it needs no limit. The redesign moves the limit guard onto the
**inexact** matrix only: exact pairing always runs; the `adds·deletes > limit`
check gates only the similarity scoring of the **leftovers**. This is a behaviour
change that makes tsgit *more* faithful, pinned by matrix #6.

### 3.4 `RenameChange` shape

```ts
export interface SimilarityScore {
  readonly score: number;     // 0..MAX_SCORE raw (60000 = identical)
  readonly maxScore: number;  // MAX_SCORE constant, carried for caller projection
}

export interface RenameChange {
  readonly type: 'rename';
  readonly oldPath: FilePath;
  readonly newPath: FilePath;
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly oldMode: FileMode;
  readonly newMode: FileMode;
  readonly similarity: SimilarityScore;
}
```

Replaces the single `id`/`mode`. R100 is the special case `oldId === newId`,
`oldMode === newMode`, `similarity.score === MAX_SCORE` — the exact pass fills it.
This keeps one `rename` variant for both passes (no `exact-rename` vs
`similarity-rename` split), so consumers branch on data, not on a second tag.

### 3.5 Patch serializer reconstruction (ADR-249)

`renderRenameBlock` (`patch-serializer.ts:498`) grows to reconstruct git's text
from the structured fields, byte-pinned by matrix #1/#4/#5:

1. `diff --git a/<old> b/<new>`
2. mode preamble when `oldMode !== newMode`: `old mode <oldMode>` / `new mode <newMode>`
3. `similarity index <toSimilarityPercent(score)>%`
4. `rename from <oldPath>` / `rename to <newPath>`
5. when `score < MAX_SCORE`: `index <shortOid(oldId)>..<shortOid(newId)>[ <mode>]`
   (mode suffix present only when `oldMode === newMode`, per matrix #4) **and** the
   normal hunk body (text or binary), reusing the existing `renderTextBody` /
   `renderBinaryBody` over the hydrated old/new bytes.
6. when `score === MAX_SCORE`: stop after step 4 — no `index`, no body (matrix #5,
   byte-identical to today's R100).

`materialiseOne` (`materialise-patch-files.ts:52`) for a `rename` now loads **both**
sides when `score < MAX_SCORE` (and neither when `=== MAX_SCORE`), so the serializer
has the bytes for the hunk body.

The `R<n>` value for `--name-status` and the `n%` for the patch are the **same**
`toSimilarityPercent` projection — confirmed equal by matrix #1 (`R087` ⇔
`similarity index 87%`).

### 3.6 Rename-limit fallback as structured data

git's fallback warning is **stderr text**; per ADR-249 tsgit returns structured
data, not a printed warning. The skip itself is faithful (adds/deletes stay
unpaired); the *warning* is a rendering of "the inexact pass was skipped". Decision
candidate D5 governs whether/how that signal is surfaced (recommend: skip silently
in the data, exactly as the current quadratic guard already does — no new field).

### 3.7 Edge-case table

| Case | Behaviour | Source |
|---|---|---|
| identical blob ids | exact pass, R100, no scoring | requirement 3, matrix #3/#5 |
| similarity ≥ threshold | pair, report truncated percent | matrix #1 |
| similarity < threshold | no pair (`score >= minimum_score` only) | matrix #2 |
| near-equal scores, multiple dsts | greedy (not optimal) sort+match; may orphan a pair an optimal matcher keeps | matrix #7/#8 |
| mode change + rename | `old/new mode` preamble; `index` omits mode suffix | matrix #4 |
| empty source/target | size-0 ⇒ exact pass if id-equal; else 0-byte spanhash, score 0 | matrix #9 |
| binary blobs | the byte-level spanhash scorer is content-type agnostic, so binary pairs score naturally; hunk body uses `renderBinaryBody`. **Pin empirically in the interop test before relying on it** (git's binary rename scoring not yet pinned here) | `isBinary` path |
| `modify` present | never a rename source — only adds/deletes feed the matrix | matrix #10 |
| matrix over rename limit | inexact pass skipped, candidates stay add/delete; exact unaffected | matrix #6 |
| both sides absent | n/a — partition yields no adds/deletes | `partition` |

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Where the similarity pass lives | (a) pure-domain `estimateSimilarity` + primitive orchestrator `detectSimilarityRenames` that hydrates leftovers; (b) push the whole pass into the domain by pre-hydrating ALL add/delete bytes in the primitive and passing a `Map<ObjectId,bytes>` into an enriched `detectRenames`; (c) keep `detectRenames` pure for exact, add a separate command-tier similarity step | **(a)** | Keeps the domain pure (no I/O, no byte maps leaking through), reuses the existing `attachStats`/`materialisePatchFiles` hydration precedent at the tier that already holds `ctx`, scores lazily (only leftovers, only past the limit guard) |
| D2 | `RenameChange` shape | (a) one `rename` variant with `oldId/newId/oldMode/newMode` + `similarity`; (b) split into `exact-rename` (oldId===newId) and `similarity-rename` tags; (c) keep `id/mode`, add optional `oldId?/oldMode?/similarity?` | **(a)** | One variant means consumers branch on data not on a new tag (no `DiffChangeType` churn); avoids optional-field primitive obsession of (c); R100 is just `score===MAX_SCORE` |
| D3 | Similarity field unit/range | (a) raw `{ score: 0..60000, maxScore: 60000 }` + caller projects integer %; (b) bare `score: 0..60000` (drop the redundant per-change `maxScore`, expose `MAX_SCORE` as a domain constant only); (c) pre-projected integer `percent: 0..100` | **(a)** | ADR-249: ship git's internal datum, let the caller render. (a) is self-describing (caller projects without importing a constant) at the cost of a constant repeated per change; (b) is leaner but couples the caller to the domain constant; (c) discards git's `MAX_SCORE` precision and bakes the truncation into the data. (a)/(b) are both defensible — user picks the self-describing-vs-lean tradeoff |
| D4 | Scope of `-C` (copy) / `-B` (break) / `--find-renames=<n>` threshold config | (a) all OUT — 24.13 is rename similarity at the fixed 50% default only; (b) ship threshold config (`renameOptions.threshold`) now, `-C`/`-B` later; (c) ship all three now | **(a)** | 24.13 brief is rename similarity; `-C`/`-B` are separate diffcore passes with their own faithfulness matrices; threshold config has no consumer yet (YAGNI). `RenameDetectOptions` is extensible later |
| D5 | Rename-limit fallback semantics | (a) keep current behaviour — over-limit ⇒ skip the inexact pass silently, candidates stay add/delete, no warning datum (exact still runs); (b) add a structured `renameLimitExceeded: boolean` to `TreeDiff`; (c) raise an error | **(a)** | Matches git's faithful *data* outcome (matrix #6: adds/deletes unpaired) and the existing quadratic-guard behaviour; the stderr warning is rendering (ADR-249), no consumer needs the flag yet; (c) diverges from git which never errors |
| D6 | Inexact selection algorithm fidelity | (a) replicate git's score-sorted greedy `record_if_better` matrix (every pair scored, sorted score-descending, best still-available match recorded), pinned by matrix #7/#8; (b) simple per-dst argmax; (c) Hungarian/optimal assignment | **(a)** | Faithfulness is the prime directive — matrix #7 proves git's selection is **greedy not optimal**: it orphans a pair that (c) would keep and that (b)'s independent per-dst argmax could double-assign. Only git's exact sort+greedy reproduces the pinned decisions |

## Test strategy

**Unit — `src/domain/diff/similarity.test.ts`** (pure scorer): identical bytes →
`MAX_SCORE`; disjoint bytes → 0; one-line-of-ten edit → the pinned spanhash score
(reconstructs `R087`); empty vs empty → handled; size-asymmetric pair → score bounded
by `max_size`. Isolated guard tests for the threshold comparison and the size
prefilter (mutation-resistant: assert exact scores, not just `> 0`).

**Unit — `similarity.properties.test.ts`** (lens 2 + 4, `fast-check`): the scorer is
a compositional aggregator over byte spans. Properties: `estimateSimilarity(x,x) ===
MAX_SCORE` (identity); `estimateSimilarity(x,y) === estimateSimilarity` is symmetric
in `max_size` bound; `toSimilarityPercent` is monotone non-decreasing in `score` and
truncates (`floor`). `numRuns` 100 (invariant tier). Example tests stay (they pin the
literal git scores); the property proves the grammar. Per CLAUDE.md the scorer is a
new algebraic surface, so the sibling is warranted.

**Unit — `detect-similarity-renames.test.ts`** (primitive orchestrator, mocked
`readBlob`): exact pass consumes id-equal pairs before scoring; a ≥50% leftover pair
folds with the right `oldId/newId/oldMode/newMode/similarity`; a <50% pair stays
add/delete; multiple-candidate winner = highest score (matrix #7/#8 reproduced with
controlled bytes); over-limit ⇒ no inexact folding (isolated guard); mode-change
rename carries distinct `oldMode/newMode`.

**Unit — `patch-serializer.test.ts`**: `renderRenameBlock` for `score < MAX_SCORE`
emits `similarity index N%` + `index <o>..<n> <mode>` + hunk body; mode-change emits
the `old/new mode` preamble and **omits** the index mode suffix; `score === MAX_SCORE`
is byte-identical to today (no index, no body). `materialise-patch-files.test.ts`:
a <100% rename loads both sides, a 100% rename loads neither.

**Unit — consumer regressions**: `blame.test.ts` `renamedSource` reads `oldId` (not
`id`); `diff-change`/`change-path` exhaustiveness still compiles.

**Interop — `test/integration/rename-similarity-interop.test.ts`** (new, twin
real-`git` vs tsgit, double-pinned against a frozen golden like
`diff-recursive-interop`): the full pinned matrix — clean ≥50% rename (#1), just-below
boundary that must NOT pair (#2), modify-vs-rename boundary (#10), multiple candidates
picking git's winner (#7/#8), rename-limit fallback (#6), mode-change rename (#4),
pure R100 unchanged (#5). Assert tsgit's reconstructed `git diff -M` bytes (via the
patch serializer) and `--name-status` `R<n>` equal live `git` + the golden. Skips when
`git` is absent (house pattern).

## Out of scope

- **Copy detection (`-C`)** — a distinct diffcore pass (matches an add against
  *unchanged* sources); own faithfulness matrix. (D4)
- **Break detection (`-B`)** — splits a low-similarity modify into delete+add before
  rename detection; separate feature. (D4)
- **Configurable threshold / `--find-renames=<n>`** — fixed 50% default only; no
  consumer yet, `RenameDetectOptions` stays extensible. (D4)
- **The stderr rename-limit warning text** — rendering (ADR-249); tsgit surfaces the
  faithful *data* outcome (unpaired), not a printed warning. (D5)
- **`--rename-empty` / whitespace-insensitive scoring** — non-default git knobs.
