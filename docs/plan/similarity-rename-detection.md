# Plan — similarity rename / copy / break detection

> Source: design doc `docs/design/similarity-rename-detection.md` · ADRs `366, 367, 368, 369, 370, 371, 372, 373, 374, 375, 376, 377`
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices for FEATURE code: coverage/interop/property
  tests fold into the implementation slice whose code they exercise. EXCEPTION:
  test-infra-only and docs-only slices (tooling config, test helpers, fixtures,
  mutation/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation slice to fold into.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

## Orientation — facts every slice shares (read once)

- **Tests live under `test/unit/**` and `test/integration/**`, NOT alongside `src/`.**
  The design doc cites paths like `src/domain/diff/similarity.test.ts`; the REAL path is
  `test/unit/domain/diff/similarity.test.ts`. vitest `include` globs are
  `test/unit/**/*.test.ts` and `test/integration/**/*.test.ts` (`vitest.config.ts`).
- **Coverage scope** (`vitest.config.ts` `coverage.include`): `src/domain/**`, `src/ports/**`,
  `src/adapters/node|memory/**`, `src/operators/**` — gated at **100%** line/branch/function/statement.
  `src/application/primitives/**` and `src/application/commands/**` are NOT in coverage scope
  (mutation-tested against unit tests only). Practical consequence: every branch added to a
  `src/domain/diff/*.ts` file MUST be exercised by a unit test in-slice or coverage fails;
  primitive/command code needs mutation-resistant tests, not coverage.
- **Brands & helpers** (`src/domain/objects/index.ts`): `type FilePath`, `type ObjectId`,
  `type FileMode`, and the `FILE_MODE` constant (`REGULAR` = `100644`, `EXECUTABLE` = `100755`,
  `SYMLINK`, `GITLINK`) are all exported there. Test helpers cast string literals to the brands
  (`'abc' as FilePath`, `oid('a')`).
- **Public-surface propagation:** `src/domain/diff/index.ts` re-exports the diff TYPES; the
  package barrel reaches them transitively — `src/application/commands/index.ts` re-exports the
  named diff types AND `src/public-types.ts` does `export type * from './domain/diff/index.js'`,
  re-exported from `src/index.ts` via `export * from './public-types.js'`. So a NEW exported
  **type** in `diff-change.ts` becomes public automatically once `diff/index.ts` re-exports it;
  a NEW exported **value** (`MAX_SCORE`, `toSimilarityPercent`, …) must be added to the
  `diff/index.ts` value-export block AND (if it is to be public) propagated the same way.
- **api.json prepush gate** (`.claude/workflow/surface-gates.md` §"api.json"): any new PUBLIC
  export makes `reports/api.json` stale; `check:doc-typedoc` (`git diff --exit-code -- reports/api.json`)
  rejects at **prepush**, NOT at `validate`. The slice that adds a public export MUST run
  `npm run docs:json` and commit the regenerated `reports/api.json` (the large typedoc-id diff is normal).
- **No `--name-status` renderer exists** in tsgit (structured-data-only, ADR-249). Interop tests
  reconstruct git's `R<n>`/`C<n>`/`M<n>` from the structured fields via `toSimilarityPercent`, and
  reconstruct `git diff` patch bytes via `reconstructPatch` (`test/integration/diff-reconstruct.ts`,
  which calls `renderPatch(await materialisePatchFiles(ctx, treeDiff.changes))`).
- **`DiffChange` exhaustiveness switches** (the full set that must grow when `'copy'` joins the
  union or `RenameChange`/`ModifyChange` change shape — verified by grep, no central
  `exhaustiveness.ts` file exists):
  1. `src/domain/diff/change-path.ts` `primaryPath` — `switch (change.type)` over all members.
  2. `src/domain/diff/patch-serializer.ts` `renderFile` (`:525`) + `assertSafePaths` (`:53`)
     + `renderRenameBlock` (`:498`).
  3. `src/application/primitives/materialise-patch-files.ts` `materialiseOne` (`:43`).
  4. `src/domain/range-diff/patch-text.ts` `fileHeader` (`:65`) + `displayName` (`:75`).
  5. `src/application/commands/blame.ts` `renamedSource` (`:327`, reads `change.id` today).
  (`src/application/commands/mv.ts` uses `'rename'` as a LOCAL `mode.kind` union — NOT `DiffChange`;
  it does not change.)
- **Slice gate** (manifest `gates.slice`, placeholders resolved per slice):
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`.
  Phase-boundary gate is `npm run validate`. Never commit on red; never `--no-verify`; no
  suppression directives; no phase/ADR/backlog refs in source or test.
- **Interop discipline** (`test/integration/interop-helpers.ts`): `GIT_AVAILABLE`, `makePeerPair(slug)`,
  `runGit(args, {env})`, `runGitEnv()` (scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`),
  `git(dir, ...args)`. Goldens live in `test/integration/fixtures/diff-patch/*.golden.patch`. Suites
  guard with `describe.skipIf(!GIT_AVAILABLE)`. Compute goldens with signing OFF; pin peer to
  `-c merge.conflictStyle=merge` only where conflict markers matter (not here). The interop test
  file `test/integration/rename-similarity-interop.test.ts` accretes cases across slices 3–8.
- **Property tests** (CLAUDE.md): `*.properties.test.ts` sibling next to the example test; shared
  generators in the directory's `arbitraries.ts` (`test/unit/domain/diff/arbitraries.ts` already
  exists — extend it, don't fork). Tiered `numRuns` (200 round-trip / 100 default / 50 filter-heavy).
  Never delete an example test in the same slice that adds a property.

---

## Slice 1 — pure similarity scorer (domain)

### Context

Create `src/domain/diff/similarity.ts` — the pure, I/O-free spanhash scorer plus the score
constants and projections. This is the sound core every later slice depends on (ADR-366, ADR-368).

**New file `src/domain/diff/similarity.ts` — exact exported surface (ADR-368, design §3.2):**
- `export const MAX_SCORE = 60000;`
- `export const DEFAULT_RENAME_THRESHOLD = 30000;` (50%)
- `export const DEFAULT_BREAK_SCORE = 30000;` (50%, the `-B<n>` break-attempt gate)
- `export const DEFAULT_MERGE_SCORE = 36000;` (60%, the `-B/<m>` keep-broken gate)
- `export interface SimilarityScore { readonly score: number; readonly maxScore: number; }`
  (ADR-368 — `score` in `0..60000`, `maxScore` always `MAX_SCORE`). This is the shared shape
  `RenameChange.similarity`, `CopyChange.similarity`, and `ModifyChange.broken` all use.
- `export function estimateSimilarity(src: Uint8Array, dst: Uint8Array): number;` — returns the
  raw `0..MAX_SCORE` score = `src_copied · MAX_SCORE / max(src_size, dst_size)`, via git's
  spanhash fingerprint (`diffcore-delta.c`): chunk each blob into variable-length hashed spans,
  count `src_copied` bytes that appear in both. Design §3.1 is the pinned algorithm — port git's
  `diffcore_count_changes` span logic, do NOT count lines. Identical inputs ⇒ `MAX_SCORE`; disjoint
  ⇒ `0`; both empty ⇒ `MAX_SCORE` (size-0 handled by exact pass upstream, but the function must be
  total — guard `max_size === 0` to avoid div-by-zero, returning `MAX_SCORE`).
- `export function toSimilarityPercent(score: number): number;` =
  `(score * 100 / MAX_SCORE) | 0` — **truncating** integer (design §3.1: 900/1000 bytes ⇒ 89, not 90).

**Pinned scores to reproduce (design §3.3 / §10):** a "1 of 10 lines changed" blob pair must
score such that `toSimilarityPercent` yields **87** (matrix #1: `R087`, the truncated spanhash
result — NOT the 90% line ratio). Disjoint rewrite ⇒ score `0`. Identical ⇒ `MAX_SCORE` ⇒ 100.

**Dissimilarity** (used by `-B` later): there is no separate function — dissimilarity is
`MAX_SCORE − estimateSimilarity(...)`, projected by the same `toSimilarityPercent`. The scorer
only needs to make this exact; callers compute the subtraction.

**Tests — `test/unit/domain/diff/similarity.test.ts`** (NEW; GWT describe/it tree, AAA body,
`sut`). Coverage is gated at 100% for this domain file, so cover every branch:
identical→`MAX_SCORE`; disjoint→0; the pinned one-of-ten edit→score whose percent is 87;
empty vs empty→`MAX_SCORE`; empty vs non-empty→0; size-asymmetric pair bounded by `max_size`
(assert the exact score, not a range); `toSimilarityPercent` truncation at a boundary
(e.g. score 59999 ⇒ 99, score 60000 ⇒ 100); the `max_size === 0` guard. Error/guard assertions
must be specific (assert exact integer scores, never a loose range — StringLiteral/arithmetic
mutants survive loose checks).

**Property test — `test/unit/domain/diff/similarity.properties.test.ts`** (NEW, `fast-check`,
lenses 2+4, `numRuns: 100`). Extend `test/unit/domain/diff/arbitraries.ts` with a byte-blob
arbitrary (e.g. `arbBlobBytes(): fc.Arbitrary<Uint8Array>` over a small alphabet). Properties:
- identity: `estimateSimilarity(x, x) === MAX_SCORE` for any `x`;
- bounded: `0 <= estimateSimilarity(a, b) <= MAX_SCORE`;
- `toSimilarityPercent` monotone non-decreasing in score AND floored (`toSimilarityPercent(s) <= 100`);
- dissimilarity identity: `MAX_SCORE − estimateSimilarity(x, x) === 0`.
`Given` reads "Given an arbitrary blob". Keep example tests (literal git scores) — additive.

**Barrel** — add to `src/domain/diff/index.ts` a `// Similarity scoring` block:
`export type { SimilarityScore } from './similarity.js';` and
`export { DEFAULT_BREAK_SCORE, DEFAULT_MERGE_SCORE, DEFAULT_RENAME_THRESHOLD, estimateSimilarity, MAX_SCORE, toSimilarityPercent } from './similarity.js';`.

**Public-surface decision (DECIDED — public):** `SimilarityScore`, `MAX_SCORE`,
`toSimilarityPercent` are PUBLIC (ADR-368 mandates exporting `MAX_SCORE` + `toSimilarityPercent`;
`SimilarityScore` is reachable through `RenameChange.similarity` from slice 2). `estimateSimilarity`,
`DEFAULT_*` constants are public-via-barrel (consumers may want git's defaults). Because these reach
the package barrel transitively (orientation note), **this slice MUST regenerate `reports/api.json`**:
run `npm run docs:json` and commit it (prepush gate `check:doc-typedoc`). The barrel re-export through
`diff/index.ts` → `public-types.ts` is the only wiring; no exhaustiveness switch touches a scorer.

### TDD steps

1. RED — write `similarity.test.ts` (example cases above) + `similarity.properties.test.ts`.
   Failure reason: `Cannot find module './similarity.js'` (file does not exist).
2. GREEN — create `src/domain/diff/similarity.ts` with the constants, `SimilarityScore`,
   `estimateSimilarity` (spanhash port), `toSimilarityPercent`. Add the `arbBlobBytes` arbitrary
   to `arbitraries.ts`. Wire the `diff/index.ts` barrel block. Run `npm run docs:json`, commit
   `reports/api.json`.
3. REFACTOR — extract the span-chunking into a small named helper if `estimateSimilarity` exceeds
   ~20 lines; ensure early returns for the empty/size-0 guards; no magic numbers beyond the named
   constants. Re-run unit + property tests; confirm 100% coverage on `similarity.ts`.

### Gate

`npx vitest run test/unit/domain/diff/similarity.test.ts test/unit/domain/diff/similarity.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/similarity.ts src/domain/diff/index.ts test/unit/domain/diff/similarity.test.ts test/unit/domain/diff/similarity.properties.test.ts test/unit/domain/diff/arbitraries.ts`

### Commit

`feat(diff): add pure spanhash similarity scorer`

---

## Slice 2 — two-sided `RenameChange` shape + consumer migration (R100 byte-identical)

### Context

Reshape `RenameChange` to the two-sided ADR-367 form and migrate every consumer, WITHOUT changing
any observable bytes: R100 patch text and `--name-status` reconstruction stay identical. This slice
introduces no new detection — it only changes the data shape exact pairing emits and the serializer
reads, holding output constant. Detection of `< 100%` renames lands in slice 3.

**`src/domain/diff/diff-change.ts` — replace `RenameChange` (`:28`):**
```ts
export interface RenameChange {
  readonly type: 'rename';
  readonly oldPath: FilePath;
  readonly newPath: FilePath;
  readonly oldId: ObjectId;     // was: id
  readonly newId: ObjectId;
  readonly oldMode: FileMode;   // was: mode
  readonly newMode: FileMode;
  readonly similarity: SimilarityScore;   // import from './similarity.js'
}
```
Add `import type { SimilarityScore } from './similarity.js';`. For R100 the exact pass sets
`oldId === newId`, `oldMode === newMode`, `similarity: { score: MAX_SCORE, maxScore: MAX_SCORE }`
(R100 ⇔ `similarity.score === MAX_SCORE`, ADR-367).

**`src/domain/diff/rename-detect.ts` `tryFoldAdd` (`:51`):** the exact-pass `rename` literal (`:58`)
currently emits `{ id: add.newId, mode: add.newMode }`. Change to
`{ oldId: del.oldId, newId: add.newId, oldMode: del.oldMode, newMode: add.newMode, similarity: { score: MAX_SCORE, maxScore: MAX_SCORE } }`
(import `MAX_SCORE` from `./similarity.js`). Because exact pairing requires `add.newId === del.oldId`
and modes are not consulted today, `oldId === newId` holds; modes come from each side (for a pure
`git mv` they are equal — matrix #5). Keep the `matches.length !== 1` guard.

**Consumer migrations (the exhaustiveness set from Orientation):**
- `src/application/commands/blame.ts` `renamedSource` (`:338`): `change.id` → `change.oldId`
  (the source blob). Behaviour unchanged.
- `src/domain/diff/patch-serializer.ts` `renderRenameBlock` (`:498`): must now reconstruct the
  R100 shape from the new fields. For `similarity.score === MAX_SCORE` emit EXACTLY today's four
  lines: `diff --git`, `similarity index 100%`, `rename from <oldPath>`, `rename to <newPath>`
  (use `toSimilarityPercent(change.similarity.score)` for the `100`). `< 100%` rendering (index
  line, hunk, mode preamble) is slice 4 — for now a `< MAX_SCORE` rename can render the header-only
  form too (slice 3 will not yet emit `< 100%` renames into this serializer path for diff output;
  keep this slice's render limited to what slice 1+2 produce — R100). To avoid dead branches that
  trip mutation later, render with `toSimilarityPercent` so the `100%` is computed, not literal.
- `src/domain/range-diff/patch-text.ts` `fileHeader`/`displayName` (`:65`/`:75`): the `rename` case
  is path-only (`change.oldPath => change.newPath` / `change.newPath`) — already correct, no field
  read changes. Verify it still compiles against the new shape.
- `src/domain/diff/change-path.ts` `primaryPath` (`:11`): `rename` returns `change.newPath` —
  no field change, verify compiles.
- `src/application/primitives/materialise-patch-files.ts` `materialiseOne` (`:52`): the `rename`
  branch returns `{ change }` (loads nothing). For R100 that stays correct (no content needed).
  Slice 4 makes it load both sides when `score < MAX_SCORE`. No change this slice.

**Tests to update/extend (the migration must keep them green by adapting to the new shape):**
- `test/unit/domain/diff/rename-detect.test.ts` — every `rename` expectation now carries
  `oldId/newId/oldMode/newMode/similarity` instead of `id/mode`. Update the expected objects;
  add an assertion that an exact pair yields `similarity.score === MAX_SCORE` and `oldId === newId`.
- `test/unit/domain/diff/patch-serializer.test.ts` — the R100 rename render assertion must produce
  byte-identical output to today (same four lines). This is the load-bearing faithfulness pin for
  the reshape.
- `test/unit/application/commands/blame.test.ts` — `renamedSource` reads `oldId`; the returned
  `blobId` must equal the source blob. Update any literal that referenced `id`.
- `test/unit/domain/diff/change-path.test.ts` — `rename` primary-path case still `newPath`;
  update the fixture `RenameChange` to the new shape.

**Surface gate:** `RenameChange` is already public (re-exported). Its SHAPE changes but the export
NAME set does not. Still, the shape change alters the typedoc model ⇒ **regenerate and commit
`reports/api.json`** (`npm run docs:json`) in this slice.

### TDD steps

1. RED — update `rename-detect.test.ts`, `patch-serializer.test.ts`, `blame.test.ts`,
   `change-path.test.ts` to expect the two-sided shape (R100 patch bytes unchanged).
   Failure reason: tests reference `oldId/newId/...` fields the current `RenameChange` lacks ⇒
   type errors / assertion mismatches against the old `id/mode` emitter.
2. GREEN — reshape `RenameChange`; update `tryFoldAdd`, `renderRenameBlock`, `blame.renamedSource`;
   verify `primaryPath`/`patch-text`/`materialiseOne` compile. Run `npm run docs:json`, commit
   `reports/api.json`.
3. REFACTOR — keep `renderRenameBlock` ≤ 20 lines; extract a shared similarity-line helper only if
   it reads cleaner (slice 4 will widen it). Run `get_diagnostics_for_file` after each edit.

### Gate

`npx vitest run test/unit/domain/diff/rename-detect.test.ts test/unit/domain/diff/patch-serializer.test.ts test/unit/application/commands/blame.test.ts test/unit/domain/diff/change-path.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/diff-change.ts src/domain/diff/rename-detect.ts src/domain/diff/patch-serializer.ts src/application/commands/blame.ts src/domain/diff/change-path.ts src/domain/range-diff/patch-text.ts`

### Commit

`refactor(diff): two-sided RenameChange shape with similarity datum`

---

## Slice 3 — `detectSimilarityRenames` primitive (inexact renames) + diffTrees wiring + rename interop

### Context

Add the I/O orchestrator that hydrates leftover unpaired adds/deletes, scores them with
`estimateSimilarity`, runs git's score-sorted greedy `record_if_better` selection (ADR-371), and
emits `< 100%` `rename` winners ≥ threshold. Wire `diffTrees` to call it. Pin renames against real
git (matrices #1, #2, #6, #7, #8, #10). No copies/breaks yet (slices 5–7).

**New file `src/application/primitives/detect-similarity-renames.ts`:**
```ts
export async function detectSimilarityRenames(
  ctx: Context,
  diff: TreeDiff,
  options?: RenameDetectOptions,
): Promise<TreeDiff>
```
Algorithm (design §3.1–§3.2, ADR-370, ADR-371):
1. Run the existing pure `detectRenames(diff, options)` FIRST (exact R100 pass — unchanged,
   never limited). This consumes id-equal pairs.
2. Partition the result's leftovers into unpaired `adds` (destinations) and unpaired `deletes`
   (rename sources). `modify`/`type-change`/`rename` from the exact pass pass through untouched
   (matrix #10: a `modify` is never an inexact rename source).
3. **Rename-limit guard (ADR-370):** `limit = options.limit ?? DEFAULT_LIMIT` (`1000`, from
   `rename-detect.ts`); `0` ⇒ unlimited. If `num_create * num_src > limit` (where `num_src` =
   deletes count this slice; copy sources added in slice 6), SKIP the inexact pass — emit the
   exact-pass result unchanged (matrix #6). **This corrects the latent bug** where the old
   `detectRenames` bailed the whole pass (exact included) over the limit; here exact already ran.
4. Hydrate candidate blob bytes via `readBlob` through a bounded pool — mirror
   `materialise-patch-files.ts` `MAX_CONCURRENT_BLOB_LOADS = 32` worker pattern (cursor + N workers
   + `Promise.all`). Read each add's `newId` content and each delete's `oldId` content once.
5. Build the score matrix: for every `(delete, add)` pair compute `estimateSimilarity(srcBytes, dstBytes)`.
   Apply git's size prefilter (early-reject pairs whose size delta alone cannot reach `threshold` —
   cost-only, changes no decision; design §3.1).
6. **Greedy selection (ADR-371):** sort all `(src, dst, score)` triples score-DESCENDING; walk in
   order, recording a match when both src and dst are still available AND `score >= threshold`
   (`threshold = options.threshold ?? DEFAULT_RENAME_THRESHOLD` = `30000`); mark both consumed.
   Test is `score >= minimum_score` INCLUSIVE (matrix #2: a 39% pair does not pair at `-M40%`).
   Greedy, NOT optimal (matrix #7: 5×5 near-equal → 4 pair, 1 orphans).
7. Emit a `rename` per winner with the two-sided fields + `similarity: { score, maxScore: MAX_SCORE }`;
   unconsumed adds stay `add`, unconsumed deletes stay `delete`. Re-merge with pass-through `other`
   and `sortByPath(merged, primaryPath)` (same finalisation as `detectRenames`).

**`RenameDetectOptions` (`src/domain/diff/rename-detect.ts:6`)** gains `readonly threshold?: number;`
this slice (the `0..MAX_SCORE` rename `minimum_score`, default `DEFAULT_RENAME_THRESHOLD`). `copies`,
`copyThreshold`, `breakRewrites` are added by their respective slices (5/6/7/8) to keep each diff small;
DO NOT add them here.

**`src/application/primitives/diff-trees.ts` (`:42`):** swap
`detectRenames(rawDiff, options.renameOptions)` for
`await detectSimilarityRenames(ctx, rawDiff, options.renameOptions)`. The function is already `async`
and holds `ctx`. Import from `./detect-similarity-renames.js`. Every existing consumer threads through
`diffTrees`, so none of their call sites change.

**Tests — `test/unit/application/primitives/detect-similarity-renames.test.ts`** (NEW; mock `readBlob`
by constructing a memory context with the blobs, OR follow `diff-trees.test.ts`'s existing setup — read
it first for the established mocking style). Primitive is NOT in coverage scope ⇒ aim for
mutation-resistance: exact pass consumes id-equal pairs first; a ≥threshold leftover folds with the
right two-sided fields and `similarity.score`; a < threshold leftover does NOT fold (separate isolated
test per guard side — `score === threshold` pairs, `score === threshold - 1` does not); over-limit ⇒
no inexact folding, exact still emitted; greedy winner matches git's score-descending sort (#7/#8 shape);
`modify` never becomes a source (#10).

**Tests — extend `test/unit/application/primitives/diff-trees.test.ts`:** assert
`diffTrees(..., { detectRenames: true, renameOptions: { threshold } })` now surfaces a `< 100%` rename
for an edited-then-moved file (was an A/D pair before). Keep existing R100 / no-detect cases green.

**Interop — `test/integration/rename-similarity-interop.test.ts`** (NEW; twin real-git vs tsgit,
double-pinned vs frozen goldens under `test/integration/fixtures/diff-patch/`, `describe.skipIf(!GIT_AVAILABLE)`).
Model on `diff-recursive-interop.test.ts` (same imports, `makePeerPair`, `runGit`, deterministic env,
`reconstructPatch`). This slice covers RENAME cases only — #1 (R087 one-of-ten edit), #2 (`-M40`
boundary pair/no-pair via `threshold`), #6 (`renameLimit=2` skips inexact, exact untouched), #7 (5×5
near-equal greedy), #8 (5×5 clear best), #10 (`modify` alongside rename). For each: build the fixture
in a real git peer and in a tsgit memory repo, run `git diff --no-ext-diff -M[<n>]` in the peer,
reconstruct tsgit's patch via `reconstructPatch`, assert byte-equality to BOTH live git and a committed
golden. ALSO reconstruct `--name-status` `R<n>` from `toSimilarityPercent(change.similarity.score)` and
assert it equals `git diff --no-ext-diff -M --name-status`. Generate goldens with signing OFF.
Copies/breaks/threshold-`-C`/`-B` cases are added to THIS file by slices 5–8.

### TDD steps

1. RED — write `detect-similarity-renames.test.ts`, extend `diff-trees.test.ts`, write the
   rename-only `rename-similarity-interop.test.ts`. Failure reason:
   `Cannot find module './detect-similarity-renames.js'` (primitive absent) and `diffTrees` still
   calls the pure `detectRenames`, so no `< 100%` rename is produced (A/D pair surfaces instead).
2. GREEN — add `threshold` to `RenameDetectOptions`; implement `detectSimilarityRenames` (exact-first,
   limit guard, bounded hydrate, score matrix, greedy ≥threshold, two-sided emit); swap the
   `diffTrees` call. Build + commit the interop goldens.
3. REFACTOR — extract the bounded-pool hydrate and the greedy selector into named helpers (each
   ≤ 20 lines, early returns, no mutable shared state beyond the local consumed-sets). Confirm
   `materialise-patch-files`'s pool pattern is mirrored, not duplicated divergently.

### Gate

`npx vitest run test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/diff-trees.test.ts test/integration/rename-similarity-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/detect-similarity-renames.ts src/application/primitives/diff-trees.ts src/domain/diff/rename-detect.ts`

### Commit

`feat(diff): detect inexact renames by content similarity`

---

## Slice 4 — patch serializer for `< 100%` renames + materialise both sides + serializer/interop

### Context

Make the patch serializer reconstruct git's `git diff -M` text byte-for-byte for `< 100%` renames:
mode preamble, `similarity index <n>%`, `rename from/to`, `index <o>..<n>[ <mode>]`, and the hunk
body. Hydrate both sides for `< 100%` renames. Pin matrices #1, #4, #5.

**`src/domain/diff/patch-serializer.ts` `renderRenameBlock` (`:498`):** widen to (design §6, matrix
order is load-bearing):
1. `diff --git a/<oldPath> b/<newPath>`.
2. when `oldMode !== newMode`: `old mode <oldMode>` / `new mode <newMode>` (mode preamble PRECEDES
   the similarity line — matrix #4).
3. `similarity index <toSimilarityPercent(change.similarity.score)>%`.
4. `rename from <oldPath>` / `rename to <newPath>`.
5. when `change.similarity.score < MAX_SCORE`: `index <shortOid(oldId)>..<shortOid(newId)>[ <newMode>]`
   — the ` <mode>` suffix is present ONLY when `oldMode === newMode` (matrix #4: when modes differ the
   index line omits the trailing mode); THEN the hunk body over the hydrated source/dst bytes
   (reuse `computeHunks` + `renderHunkBody`, with `--- a/<oldPath>` / `+++ b/<newPath>` labels — pin
   the exact label paths against git in interop). Handle binary via `isBinary` like the modify path.
6. when `change.similarity.score === MAX_SCORE`: STOP after step 4 (matrix #5 — byte-identical to today).

`renderRenameBlock` now needs the blob bytes ⇒ change its signature to accept the hydrated
`PatchFile` (`oldContent`/`newContent`) like `renderModifyOrTypeChangeBlock`, and update the
`renderFile` (`:537`) call site to pass `file` through. Keep `assertSafePaths` rename branch as-is.

**`src/application/primitives/materialise-patch-files.ts` `materialiseOne` (`:52`):** the `rename`
branch currently returns `{ change }`. Change to: when `change.similarity.score < MAX_SCORE`, load
BOTH sides (`oldId` → `oldContent`, `newId` → `newContent`, via the same `Promise.all` pattern as
the modify branch); when `=== MAX_SCORE`, load neither (`{ change }`). This feeds the hunk body.

**Tests — extend `test/unit/domain/diff/patch-serializer.test.ts`:** `renderRenameBlock` for
`score < MAX_SCORE` (similarity index + index line + hunk); mode-change rename (preamble present,
index line omits the mode suffix — matrix #4); `score === MAX_SCORE` byte-identical to today
(regression-pin from slice 2 stays green); a binary-content rename renders `Binary files ... differ`.
Assert exact bytes, line-by-line.

**Tests — extend `test/unit/application/primitives/materialise-patch-files.test.ts`:** a `< 100%`
rename loads both sides; a `100%` rename loads neither. (Mirror the existing modify/type-change
assertions in that file.)

**Interop — extend `test/integration/rename-similarity-interop.test.ts`:** add matrix #4 (mode
change + rename: mode preamble before `similarity index 71%`, index line without trailing mode) and
#5 (pure `git mv` R100, no index/hunk). #1 already lands the `< 100%` patch body — assert its FULL
reconstructed patch (not just name-status) equals `git diff -M` + golden now that the serializer
emits the hunk.

### TDD steps

1. RED — extend `patch-serializer.test.ts` (mode-change `< 100%` rename, index line, hunk),
   `materialise-patch-files.test.ts` (both-sides load), and the interop #4/#5/#1-full-body cases.
   Failure reason: `renderRenameBlock` emits only the header-only R100 form, so `< 100%` patches lack
   the index line + hunk; `materialiseOne` loads nothing for renames, so `oldContent`/`newContent`
   are undefined.
2. GREEN — widen `renderRenameBlock` (signature + body); update `renderFile` call site; widen
   `materialiseOne` rename branch.
3. REFACTOR — factor the shared "similarity index + from/to + optional index+hunk" into a helper if
   it overlaps `renderCopyBlock`'s future needs (slice 5 will share it); keep functions ≤ 20 lines.

### Gate

`npx vitest run test/unit/domain/diff/patch-serializer.test.ts test/unit/application/primitives/materialise-patch-files.test.ts test/integration/rename-similarity-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/patch-serializer.ts src/application/primitives/materialise-patch-files.ts`

### Commit

`feat(diff): render sub-100% rename patches byte-faithfully`

---

## Slice 5 — `CopyChange` + copy detection (`copies: 'on'`) + `renderCopyBlock` + copy interop

### Context

Introduce the `copy` union member and plain `-C` copy detection (ADR-372, ADR-376). A copy pairs an
`add` against a RETAINED source modified in the diff (not consumed); the source keeps its own change
entry. Pin matrices #C1, #C1b, #C4. `--find-copies-harder` is slice 6.

**`src/domain/diff/diff-change.ts` — add `CopyChange` (ADR-372, design §4.3) + union/type member:**
```ts
export interface CopyChange {
  readonly type: 'copy';
  readonly oldPath: FilePath;   // retained source path
  readonly newPath: FilePath;   // copy destination
  readonly oldId: ObjectId;     // source PREIMAGE blob (scored side, index left)
  readonly newId: ObjectId;     // destination blob
  readonly oldMode: FileMode;
  readonly newMode: FileMode;
  readonly similarity: SimilarityScore;
}
```
- `export type DiffChangeType = 'add' | 'delete' | 'modify' | 'rename' | 'type-change' | 'copy';`
- `export type DiffChange = ... | CopyChange;`

**Wire EVERY exhaustiveness switch over the union IN THIS SLICE (Orientation set — the compiler flags
these once you build, but pre-pay them so no fix surfaces at the phase-boundary validate):**
- `src/domain/diff/change-path.ts` `primaryPath`: add `case 'copy': return change.newPath;` (design §1.2).
- `src/domain/diff/patch-serializer.ts`: `assertSafePaths` — add a `change.type === 'copy'` branch
  rejecting `oldPath`+`newPath` (mirror the `rename` branch); `renderFile` — route `copy` to a new
  `renderCopyBlock`.
- `src/application/primitives/materialise-patch-files.ts` `materialiseOne`: add a `copy` branch —
  ALWAYS load both sides when `score < MAX_SCORE` (source preimage via `oldId`, dst via `newId`);
  neither when `=== MAX_SCORE` (matrix #C4).
- `src/domain/range-diff/patch-text.ts`: `fileHeader` — add `if (change.type === 'copy') return
  \`${change.oldPath} => ${change.newPath}\`;` (path-only, like rename); `displayName` — add `copy`
  to the `change.newPath` branch.
- `src/application/commands/blame.ts` `renamedSource`: the `for` loop's `change.type === 'rename'`
  guard already excludes `copy` — confirm a `copy` change does not satisfy it (no edit needed, but
  verify the type-narrowing still compiles with the wider union).

**`renderCopyBlock`** (new, `patch-serializer.ts`): identical to the widened `renderRenameBlock`
(slice 4) EXCEPT `copy from`/`copy to` replace `rename from`/`rename to` (design §4.3 — the only
differing line). Share the slice-4 helper; branch only the keyword. `score === MAX_SCORE` ⇒ header
stops after `copy to` (matrix #C4, mirrors R100).

**`src/application/primitives/detect-similarity-renames.ts` — copy pass (ADR-376, design §4.4):**
add `readonly copies?: 'off' | 'on' | 'harder';` to `RenameDetectOptions` (`rename-detect.ts:6`),
default `'off'`. When `copies !== 'off'`:
- **copy sources for `'on'`** = the PREIMAGE blobs of files MODIFIED in the diff (git's `rename_src`
  reuse): the `oldId`/`oldMode`/`oldPath` of `modify` and `type-change` changes, PLUS the unpaired
  deletes already in the rename source set. An UNCHANGED file is NOT a copy source under plain `-C`
  (matrix #C1b — pinned). (`'harder'` widens to all preimage paths — slice 6.)
- copy candidates enter the SAME greedy matrix as renames. A copy source's scored bytes are its
  PREIMAGE content (read via `oldId`). At equal score, rename candidates sort AHEAD of copy
  candidates (matrix #C3 — copy-vs-rename precedence; this slice has no rename-vs-copy clash fixture
  but the sort tiebreak must be in place — slice 6's #C3 pins it). A copy winner emits a `copy`
  WITHOUT removing its source from the result set (the source's own `modify`/`delete` survives).
  Threshold for copies = `options.copyThreshold ?? options.threshold ?? DEFAULT_RENAME_THRESHOLD`
  (the `copyThreshold` knob is added formally in slice 8; reading it now keeps the param optional).

**Tests — extend `test/unit/application/primitives/detect-similarity-renames.test.ts`:** a copy folds
WITHOUT consuming its source (source `modify` survives alongside the `copy`); copy source set under
`'on'` = changed files only (an unchanged file produces NO copy — #C1b); a copy below `copyThreshold`
does not fold.

**Tests — extend `test/unit/domain/diff/patch-serializer.test.ts`** (`renderCopyBlock`: `< 100%`
copy = `copy from`/`copy to` + similarity index + index + hunk; `=== MAX_SCORE` copy = header stops
after `copy to`, matrix #C4) **and `change-path.test.ts`** (`copy` primary path = `newPath`) **and
`materialise-patch-files.test.ts`** (`copy` loads both sides `< 100%`, neither `100%`) **and a small
`patch-text` assertion** (the `copy` `fileHeader`/`displayName`).

**Interop — extend `test/integration/rename-similarity-interop.test.ts`:** #C1 (clean copy from a
modified source: `C072`, `copy from`/`copy to`, source still `M`), #C1b (same dst but unchanged
source under plain `-C` ⇒ `A dst`, no copy), #C4 (`C100` exact copy, no index/hunk). Run
`git diff --no-ext-diff -C`; reconstruct tsgit patch + name-status (`C<n> src dst` from
`toSimilarityPercent`); assert vs live git + golden.

**Surface gate — `CopyChange` is PUBLIC (ADR-372):** add
`CopyChange` to the `diff/index.ts` type-export block AND to the `src/application/commands/index.ts`
named diff-type re-export list (alphabetical). `DiffChange`/`DiffChangeType` grow transitively. The
`public-types.ts` `export type *` carries it. No barrel-surface test asserts the `DiffChange` member
SET (verified: `public-types.test.ts` / `snapshot-barrel-surface.test.ts` do not enumerate it), so no
test update is required there — but **regenerate and commit `reports/api.json`** (`npm run docs:json`).

### TDD steps

1. RED — extend the primitive, serializer, change-path, materialise, patch-text unit tests for `copy`,
   and the #C1/#C1b/#C4 interop cases. Failure reason: `'copy'` is not a `DiffChangeType` (type
   errors across the switches) and no copy pass exists (no `copy` change emitted).
2. GREEN — add `CopyChange`/`'copy'`; wire all exhaustiveness switches; add `renderCopyBlock`; add
   `copies` to options + the plain-`-C` copy pass in the primitive; barrel-export `CopyChange`;
   run `npm run docs:json`, commit `reports/api.json`. Build interop goldens.
3. REFACTOR — collapse `renderRenameBlock`/`renderCopyBlock` onto the shared helper (keyword param);
   ensure the copy-source-set builder is a named helper; no duplicated greedy logic.

### Gate

`npx vitest run test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/domain/diff/patch-serializer.test.ts test/unit/domain/diff/change-path.test.ts test/unit/application/primitives/materialise-patch-files.test.ts test/unit/domain/range-diff/patch-text.test.ts test/integration/rename-similarity-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/diff-change.ts src/domain/diff/index.ts src/application/commands/index.ts src/domain/diff/change-path.ts src/domain/diff/patch-serializer.ts src/application/primitives/materialise-patch-files.ts src/domain/range-diff/patch-text.ts src/application/primitives/detect-similarity-renames.ts src/domain/diff/rename-detect.ts`

### Commit

`feat(diff): detect copies from modified sources (-C)`

---

## Slice 6 — `--find-copies-harder` source set (`copies: 'harder'`) + precedence + interop

### Context

Extend the copy pass so `copies: 'harder'` widens the source set to ALL preimage paths (unchanged
included), and pin copy-vs-rename precedence and the limit interaction (ADR-375, ADR-377; matrices
#C2, #C3). No new union member or serializer change — only the source-set builder and the limit count.

**`src/application/primitives/detect-similarity-renames.ts`:**
- **copy sources for `'harder'`** = ALL paths in the PREIMAGE tree (tree A), unchanged included
  (matrix #C2 — `--find-copies-harder` adds every preimage blob to the source set). The primitive
  receives a flat `TreeDiff` (no whole-tree handle), so the FULL preimage path/oid/mode set must be
  threaded in. Decide the threading in-slice: the cleanest faithful route is to have `diffTrees`
  (which holds both resolved trees) pass the flattened preimage entries (path→{oid,mode}) into
  `detectSimilarityRenames` as an extra argument used ONLY when `copies === 'harder'`. Reuse
  `blobProjection`/`flattenTree` already in `diff-trees.ts` for the flat preimage. For `'on'`/`'off'`
  this extra arg is ignored (sources stay the changed-files set from slice 5). Verify with Serena
  that `diff-trees.ts` can produce the flat preimage without a second tree read (it already resolves
  `treeA`).
- **Limit counts copy sources (ADR-377, D5, design §4.4):** `num_src` in the rename-limit guard now
  INCLUDES the copy-source count. Under `'harder'`, `num_src` balloons to the whole preimage, so the
  limit is reached far sooner — pinned by an interop case that crosses the limit ONLY under `'harder'`.
- **Copy-vs-rename precedence (matrix #C3):** when a deleted source (rename) and a retained source
  (copy) both match a dst, the RENAME wins (the greedy sort tiebreak from slice 5 — rename ahead of
  copy at equal score — must produce this; if scores differ, the higher score wins as usual). Pin the
  empirically-true case: `del-src` (deleted) + `keep-src` (unchanged) both match `new.txt` under
  `-C --find-copies-harder` ⇒ `R081 del-src new.txt` (rename), NO copy.

**Tests — extend `test/unit/application/primitives/detect-similarity-renames.test.ts`:** `'harder'`
adds an unchanged file as a copy source (a dst copying an unchanged file folds to a `copy` under
`'harder'` but NOT under `'on'`); the limit guard counts copy sources (an over-limit-only-under-harder
case skips the inexact pass); copy-vs-rename precedence picks the rename (#C3 shape, mocked).

**Tests — extend `test/unit/application/primitives/diff-trees.test.ts`:** `diffTrees(..., {
detectRenames: true, renameOptions: { copies: 'harder' } })` surfaces a copy from an unchanged source
(the preimage threading works end-to-end).

**Interop — extend `test/integration/rename-similarity-interop.test.ts`:** #C2 (`C084` copy of an
unchanged `orig.txt` under `--find-copies-harder`; assert plain `-C` does NOT report it), #C3
(`R081 del-src new.txt`, rename wins, no copy under `-C --find-copies-harder`), and an over-limit-only-
under-`harder` case (a fixture whose `num_create * num_src` stays under the limit for `-C` but crosses
it for `--find-copies-harder`, so the inexact pass is skipped only under `harder`). Run
`git diff --no-ext-diff -C --find-copies-harder` (git's `-C -C`); reconstruct + assert vs live git + golden.

### TDD steps

1. RED — extend the primitive + diff-trees unit tests and the #C2/#C3/over-limit interop cases.
   Failure reason: `'harder'` resolves the same changed-files source set as `'on'` (unchanged sources
   absent), so the unchanged-source copy never folds; the limit count omits copy sources.
2. GREEN — thread the flat preimage from `diff-trees.ts`; build the `'harder'` all-preimage source set;
   include copy sources in `num_src`; confirm the rename-ahead sort yields #C3. Build interop goldens.
3. REFACTOR — keep the source-set builder one named function switching on the `copies` enum; ensure the
   preimage flattening reuses `blobProjection`/`flattenTree` rather than re-walking the tree.

### Gate

`npx vitest run test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/diff-trees.test.ts test/integration/rename-similarity-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/detect-similarity-renames.ts src/application/primitives/diff-trees.ts src/domain/diff/rename-detect.ts`

### Commit

`feat(diff): widen copy sources for find-copies-harder (-C -C)`

---

## Slice 7 — break detection (`ModifyChange.broken` + break pass + dissimilarity serializer) + break interop

### Context

Add `-B` break detection (ADR-374, design §5). A sufficiently-dissimilar `modify` is split into a
delete+add break pair BEFORE rename/copy detection so its halves can re-pair; an unrepaired break
re-merges to a single `modify` unless its dissimilarity ≥ the keep-broken gate, in which case it
surfaces as a `modify` carrying a `broken` dissimilarity datum. Pin matrices #B1, #B2, #B3, #B4, #B4b,
#B5, #B6.

**`src/domain/diff/diff-change.ts` — `ModifyChange` (`:19`) gains** (ADR-374, design §5.3):
`readonly broken?: SimilarityScore;` — a DISSIMILARITY datum (`broken.score = MAX_SCORE − similarity`),
present iff `-B` kept this modify broken. `import` already has `SimilarityScore` (slice 2). One
`modify` variant, NOT a split into `D`+`A` (D3 — git's on-disk `M<n>` is a single path). The `materialise-patch-files`
`modify` branch already loads both sides — `broken` needs no hydrate change.

**`src/application/primitives/detect-similarity-renames.ts` — break pass (design §5.1, runs BEFORE
the exact/inexact passes, inside the same primitive so halves feed the matrix):**
add `readonly breakRewrites?: { readonly score: number; readonly merge: number } | false;` to
`RenameDetectOptions`, default `false` (off). `score` = `<n>` break-attempt gate
(`DEFAULT_BREAK_SCORE` = `30000`), `merge` = `<m>` keep-broken gate (`DEFAULT_MERGE_SCORE` = `36000`);
a passed `merge` of `0` MAPS to `DEFAULT_MERGE_SCORE` (matrix #B4b — `-B/0` ≡ default 60%; pin this
mapping explicitly).
Algorithm (fixed order — design §5.1, matrix #B6):
1. **Break-attempt:** for each `modify`, compute `dissimilarity = MAX_SCORE − estimateSimilarity(oldBytes, newBytes)`
   (hydrate the modify's both sides via the bounded pool). If `dissimilarity >= score`, SPLIT it into a
   synthetic `delete` (preimage: `oldPath/oldId/oldMode`) + `add` (postimage: `path/newId/newMode`),
   tagging the pair so it can be re-merged if neither half is consumed. Track the original `modify` +
   its dissimilarity.
2. Run rename detection (exact + inexact), then copy detection — the break halves are now ordinary
   sources/destinations (delete-half = rename source, add-half = rename/copy destination).
3. **Keep-broken / re-merge:** after detection, for each broken pair whose NEITHER half was consumed:
   if `dissimilarity >= merge` ⇒ keep broken — emit a SINGLE `modify` at the original path with
   `broken: { score: dissimilarity, maxScore: MAX_SCORE }` (matrix #B1/#B2/#B5); else re-merge ⇒ emit
   the original plain `modify` (no `broken`) (matrix #B3). A half CONSUMED by a rename/copy is already
   expressed by that `rename`/`copy` + the surviving counterpart — no `broken` flag there (design §5.3).
The boundary tests are INCLUSIVE: `dissimilarity >= score` attempts, `dissimilarity >= merge` keeps
(matrix #B4: `-B/54%`→kept, `-B/55%`→kept, `-B/56%`→re-merged for a 55% break; #B5: first `M<n>` at K=60).

**`src/domain/diff/patch-serializer.ts` `renderModifyOrTypeChangeBlock`/`renderSameKindBlock`:** when
`change.type === 'modify' && change.broken !== undefined`, emit `dissimilarity index
<toSimilarityPercent(change.broken.score)>%` in place of the normal `index`-line predecessor, then the
`index <o>..<n> <mode>` line + the full D/A hunk (matrix #B1: `dissimilarity index 100%` + index +
full-rewrite hunk). `changeToCommon` only sees `ModifyChange | TypeChangeChange`; thread the optional
`broken` into the render path (a `type-change` never has `broken`). Keep the non-broken modify body
byte-identical to today.

**Tests — extend `test/unit/application/primitives/detect-similarity-renames.test.ts`:** a break splits
a dissimilar modify before pairing (a delete-half + add-half feed the matrix); an unrepaired break with
`dissimilarity >= merge` keeps broken (`modify.broken` set); with `dissimilarity < merge` re-merges to a
plain `modify` (isolated tests per gate side: `dissimilarity === merge` keeps, `=== merge - 1` re-merges;
`dissimilarity === score` attempts, `=== score - 1` does not); `merge: 0` maps to `DEFAULT_MERGE_SCORE`
(#B4b). Assert the exact `broken.score`.

**Tests — extend `test/unit/domain/diff/patch-serializer.test.ts`:** a broken modify renders
`dissimilarity index <p>%` + index + hunk (#B1); a non-broken modify is byte-identical to today
(regression pin).

**Interop — extend `test/integration/rename-similarity-interop.test.ts`:** #B1 (fully-disjoint rewrite,
default `-B` ⇒ `dissimilarity index 100%` patch + `M100` name-status — a single modify), #B2 (`M066`
kept), #B3 (`M` re-merged at 50% default), #B5 (boundary sweep: first `M<n>` at K=60), and #B6
(break-then-rename ordering — **pin empirically by iterating the fixture**, per design §5.2 note: a
single probe did NOT trigger it; build a fixture where a heavily-rewritten path plus a sibling matching
its preimage yields git's break→rename outcome, and assert tsgit matches whatever live git produces).
Run `git diff --no-ext-diff -B` / `-B/<m>`; reconstruct patch + name-status; assert vs live git + golden.

### TDD steps

1. RED — extend the primitive + serializer unit tests and the #B1/#B2/#B3/#B5/#B6 interop cases.
   Failure reason: `ModifyChange` has no `broken` field (type errors), no break pass exists (dissimilar
   modifies are never split/kept-broken), and the serializer emits `index`/`similarity` lines, never
   `dissimilarity index`.
2. GREEN — add `broken?` to `ModifyChange`; add `breakRewrites` to options + the break pass
   (attempt → detect → keep/re-merge, fixed order, inclusive gates, `merge: 0` ⇒ default); widen the
   modify serializer for `dissimilarity index`. Build interop goldens.
3. REFACTOR — extract the break attempt/keep-broken into named helpers (≤ 20 lines each); ensure the
   dissimilarity computation reuses `estimateSimilarity` + the `MAX_SCORE −` subtraction (no second
   scorer); keep the fixed order (break → rename → copy → re-merge) explicit and commented WHY.

### Gate

`npx vitest run test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/domain/diff/patch-serializer.test.ts test/integration/rename-similarity-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/diff-change.ts src/application/primitives/detect-similarity-renames.ts src/domain/diff/patch-serializer.ts src/domain/diff/rename-detect.ts`

### Commit

`feat(diff): detect broken rewrites (-B) with dissimilarity datum`

---

## Slice 8 — configurable threshold options + facade pass-through + threshold interop

### Context

Finalise the option surface (ADR-373) and thread it through the public facade so callers can configure
rename/copy/break thresholds. The structured `RenameDetectOptions` already grew `threshold` (slice 3),
`copies` (slice 5), `breakRewrites` (slice 7) — this slice adds `copyThreshold`, pins the threshold-sweep
matrices (#T1–#T4), and wires the `DiffOptions` → `diffTrees` pass-through. No new detection logic.

**`src/domain/diff/rename-detect.ts` `RenameDetectOptions`** — confirm the FINAL shape matches design §7.1:
```ts
export interface RenameDetectOptions {
  readonly limit?: number;
  readonly maxSameIdDeletes?: number;
  readonly threshold?: number;        // slice 3
  readonly copies?: 'off' | 'on' | 'harder';   // slice 5
  readonly copyThreshold?: number;    // THIS slice; default = threshold
  readonly breakRewrites?: { readonly score: number; readonly merge: number } | false;   // slice 7
}
```
Add `copyThreshold` here and have the copy pass read `options.copyThreshold ?? options.threshold ??
DEFAULT_RENAME_THRESHOLD` (slice 5 already reads `copyThreshold` defensively; make it a real field now).

**Facade pass-through (design §7.1):**
- `src/application/commands/diff.ts` `DiffOptions` (`:8`) gains `readonly renameOptions?:
  RenameDetectOptions;` (import the type from `../../domain/diff/index.js`). In the `diff` body
  (`:36`), thread it into `treeOptions`: `...(opts.renameOptions !== undefined ? { renameOptions:
  opts.renameOptions } : {})`. Defaults preserve today's behaviour (detection off unless `detectRenames`,
  threshold 50%, copies off, breaks off).
- `src/application/primitives/types.ts` `DiffTreesOptions` (`:187`) already carries `renameOptions?:
  RenameDetectOptions` — no change; just confirm `diff.ts` threads `opts.renameOptions` into it and
  `diffTrees` forwards it to `detectSimilarityRenames`.
- **DO NOT touch `RepositoryConfig` (`src/ports/context.ts:84`).** VERIFIED at plan time: its existing
  `detectRenames?: boolean` field is declared-but-UNCONSUMED — no code reads `config.detectRenames` to
  drive `diffTrees` (the only live `detectRenames` paths are `DiffOptions` and `DiffTreesOptions`).
  Adding `RepositoryConfig.renameOptions` would create a SECOND dead field, and wiring config→diffTrees
  is net-new facade plumbing the design lists OUT OF SCOPE (§11: "`diff.renames` / `diff.copies`
  config-file driven defaults … this change ships the option surface, not the config-file plumbing").
  The faithful, consumed pass-through is `DiffOptions.renameOptions` only. (Design §7.1 mentions a
  `RepositoryConfig` `renameOptions` pass-through, but with no consumer it would be dead code — defer
  with the config-file plumbing it depends on. If the user wants it wired now, escalate — see the
  final blocker note.)

**Threshold semantics (design §7.2 — the LIBRARY takes a numeric `threshold` in `0..MAX_SCORE`
directly; callers do the `-M50%`/`-M50`/`-M0.5` form→score parse, ADR-249).** This slice does NOT add a
text parser to the data layer. The interop test does the form→score mapping itself (e.g. `-M40` ⇒
`threshold: 24000`) to pin git's `score >= minimum_score` inclusivity.

**Tests — extend `test/unit/application/commands/diff.test.ts`** (find it under
`test/unit/application/commands/`): `diff({ detectRenames: true, renameOptions: { threshold, copies,
copyThreshold, breakRewrites } })` threads each knob into `diffTrees` (assert via the surfaced changes,
or spy per the file's established style). **Extend the primitive test** for `copyThreshold` boundary
(a copy at `copyThreshold` folds, at `copyThreshold - 1` does not).

**Tests — extend `test/unit/application/primitives/detect-similarity-renames.test.ts`** for the
`copyThreshold` default-to-`threshold` fallback.

**Interop — extend `test/integration/rename-similarity-interop.test.ts`:** #T1 (`R040` pair at
`threshold: 24000` ⇔ git `-M40`/`-M4`/`-M0.40`/`-M40%`), #T2 (same pair at `threshold: 24600`/`30000`
⇔ `-M41`/`-M5`/`-M50` ⇒ A/D), #T3 (`-C<n>` copy threshold below/above a 72% copy ⇒ `copyThreshold`
boundary), #T4 (`-B<n>/<m>` two-number sweep ⇒ `breakRewrites: { score, merge }`, `merge: 0` ⇒ 36000).
For each, run the matching `git diff --no-ext-diff -M<n>` / `-C<n>` / `-B<n>/<m>` and assert tsgit with
the mapped numeric threshold reproduces the pair/no-pair + name-status + patch bytes vs live git + golden.

**Surface gate:** `RenameDetectOptions` is already public (re-exported via `diff/index.ts`). Its shape
grows (`copyThreshold`) ⇒ **regenerate and commit `reports/api.json`** (`npm run docs:json`).
`DiffOptions` gaining `renameOptions` is a public facade type ⇒ the same api.json regen covers it.

### TDD steps

1. RED — extend `diff.test.ts` (facade threads `renameOptions` into `diffTrees`), the primitive test
   (`copyThreshold`), and the #T1–#T4 interop cases. Failure reason: `DiffOptions` has no
   `renameOptions` field (type errors); the copy pass has no real `copyThreshold` field.
2. GREEN — add `copyThreshold` to `RenameDetectOptions`; thread `renameOptions` through `DiffOptions`
   → `treeOptions` → `diffTrees`; run `npm run docs:json`, commit `reports/api.json`. Build interop
   goldens. (Do NOT touch `RepositoryConfig` — see Context.)
3. REFACTOR — ensure the facade threading is a single spread, no duplicated default logic; the
   `copyThreshold ?? threshold ?? DEFAULT` fallback lives in ONE place in the primitive.

### Gate

`npx vitest run test/unit/application/commands/diff.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/rename-detect.ts src/application/commands/diff.ts src/application/primitives/detect-similarity-renames.ts`

### Commit

`feat(diff): configurable rename/copy/break thresholds via facade`

---

## Slice 9 — diff-options documentation + final api.json reconciliation (docs-only, standalone)

### Context

Docs-only slice (no `src/` delta) — legitimately standalone per the sizing rule (it has no
implementation slice to fold into). Updates the two concrete public diff doc pages to document the new
detection surface, then runs the consolidated `reports/api.json` reconciliation so the prepush
`check:doc-typedoc` gate is green before propose.

**Doc pages to update (VERIFIED to exist; current content is point-in-time — read before editing):**
- `docs/use/commands/diff.md`:
  - `:13` — the `DiffOptions` code block currently shows only `detectRenames?: boolean;`. Add
    `renameOptions?: RenameDetectOptions;` and a short prose line describing the knobs
    (`threshold`, `copies: 'off'|'on'|'harder'`, `copyThreshold`, `breakRewrites: {score,merge}|false`),
    sourcing wording from design §7.1. Note thresholds are numeric `0..MAX_SCORE` (caller maps git's
    `-M50%`/`-M50`/`-M0.5` forms — design §7.2), copies/breaks default off.
  - `:58` — the line "The `DiffChange` union covers add, delete, modify, rename, and type-change."
    must become "… add, delete, modify, rename, **copy**, and type-change." Add a sentence that a
    `rename`/`copy` carries `oldId/newId/oldMode/newMode` + a `similarity` score, and a `modify` may
    carry a `broken` dissimilarity datum under `-B` (design §4.3 / §5.3).
  - Around `:39` — add a one-liner example: `repo.diff({ detectRenames: true, renameOptions: { copies: 'on' } })`.
- `docs/use/primitives/diff-trees.md`:
  - `:11` — the inline `options?: { detectRenames?: boolean; recursive?: boolean }` shape should
    reference `renameOptions?: RenameDetectOptions` and note the threshold/copies/break knobs thread
    through unchanged (the primitive already carries `renameOptions` — slice 3 wired it).

This feature is NOT a Tier-1 command (no new `Repository` method — detection is an OPTION on the
existing `diff`/`diffTrees`), so the Tier-1 command-doc gates (`docs/use/commands/<kebab>.md` for a
NEW command, README command-count bump, browser parity scenario) do NOT apply. Confirm by checking no
new entry was added to `src/application/commands/index.ts`'s command (value) exports.

**`reports/api.json`:** run `npm run docs:json` and commit if it drifts. It should already be current
from the in-slice regens (slices 1/2/5/8), so this is the belt-and-braces final check that the PR's
prepush `check:doc-typedoc` (`git diff --exit-code -- reports/api.json`) is green. The full landed
public surface to expect in the report: `SimilarityScore`, `CopyChange`, `MAX_SCORE`,
`toSimilarityPercent`, `estimateSimilarity`, `DEFAULT_RENAME_THRESHOLD`, `DEFAULT_BREAK_SCORE`,
`DEFAULT_MERGE_SCORE`, the reshaped `RenameChange`, `ModifyChange.broken`, the grown
`RenameDetectOptions` + `DiffOptions.renameOptions`, and `'copy'` in `DiffChangeType`.

**`docs/BACKLOG.md`:** do NOT tick here — the backlog checkbox flip is the craft docs phase's job, not
the plan/implement phase.

### TDD steps

1. RED — none (docs-only, no behaviour). Read both doc pages; run `git diff --exit-code -- reports/api.json`
   to confirm whether the report drifted since slice 8.
2. GREEN — edit `docs/use/commands/diff.md` + `docs/use/primitives/diff-trees.md` per Context; run
   `npm run docs:json` and commit `reports/api.json` if drifted.
3. REFACTOR — n/a (prose). Confirm the spelling gate is happy (`npm run check:spelling` runs in
   `validate`; British `-ising`/`-ised` forms can flake the commit hook — see MEMORY).

### Gate

`npm run check:doc-typedoc` — the only mechanical gate for this docs-only slice. (Biome's
`files.includes` is `src/**`, `test/**`, `*.ts`, `*.json` only — it does NOT lint `docs/**` markdown,
so no `biome check` step applies; `check:types` is a no-op with zero TS delta. Markdown prose is
validated by `npm run check:spelling` at the phase-boundary `validate`.)

### Commit

`docs(diff): document copy/break/threshold detection options`
