# Plan — reverse-index (`.rev`) + pack bitmap read support

> Source: design doc `docs/design/rev-index-bitmap-read-support.md` · ADRs 603 … 622
> (plus the amended 586, 613, 615, 616)
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the part schema — the plan phase cannot close without it.

## Sizing

**Sixteen parts.** Eleven carry a `src/` delta with their own unit and property tests folded
in; five are test-infra-only (one cross-tool interop part for `fsck`, two for the closure,
and **two benches**) and are standalone by the template's own exception — they have no
implementation part to fold into and each covers behaviour spanning several code parts.

Parts are **sequential in one working tree**; each builds on the last. Files declared by
more than one part — `src/domain/storage/error.ts` and `src/domain/storage/index.ts`
(Parts 1–3), `src/application/primitives/pack-registry.ts` (Parts 4, 5, 7, 12, 13),
`src/application/primitives/internal/pack-artefact-source.ts` (Parts 4, 7, 12, 13),
`src/application/commands/internal/fsck/types.ts` (Parts 4, 7),
`src/application/primitives/internal/closure-engine.ts` (Parts 9, 10, 12, 13),
`src/application/commands/rev-list.ts` (Parts 9, 10, 12),
`test/unit/domain/storage/arbitraries.ts` (Parts 1–3),
`test/unit/application/primitives/pack-registry.test.ts` (Parts 4, 5, 7, 12, 13),
`test/unit/application/commands/fsck.test.ts` (Parts 4, 7),
`test/integration/rev-bitmap-closure-interop.test.ts` (Parts 11, 15),
and the bench surfaces `test/bench/fixtures.ts`, `tooling/gen-bench-fixture.ts`,
`tooling/bench-summarize.ts`, `tooling/bench-check.ts` and `vitest.bench.config.ts`
(Parts 6, 16) — so `plan-lint`'s
cognitive-locality warning is expected and is not a defect. The reason each pair stays
separate is written out below.

**Why the split falls where it does.**

- **Part 1 fuses the two reverse indexes because they are one grammar.** Pin F: the midx
  reverse-index chunk is "the same shape and the same semantics as a `.rev` body, with
  midx positions substituted for index positions", and on the single-pack fixture its
  values are *byte-identical* to the pack's own `.rev` body. One commit, one `check`
  union to reason about, one `reports/api.json` regeneration.
- **Parts 2 and 3 are two grammars, not one file.** The compressed-stream decoder is a
  self-contained word-level format with its own contract for defusing the decompression
  bomb (ADR-611, threat row T-3) and
  its own totality property; the container is a header + four streams + XOR-chained
  entries. Splitting keeps both files under the 400-line rule the design's §D3 already
  anticipates, and lets the decoder's bounded-work property land before anything can
  depend on it.
- **Part 4 lands the source module with its first consumer, not before it.** `knip`
  (`check:dead-code`, in `validate`) reports an `internal/` module whose exports nothing
  imports. `src/application/primitives/internal/pack-artefact-source.ts` is not
  barrel-exported, so it cannot ship one part ahead of a caller.
- **Part 5 (the accelerator) is not folded into Part 4** even though both consume the
  source module: Part 4's observable behaviour is a **verdict** (findings + exit bit 64)
  and Part 5's is a **read-path result** (`sortedOffsets`, unchanged by construction).
  ADR-604 and ADR-607 were ratified separately; a regression in one must not be
  indistinguishable from the other at bisect.
- **Part 6 measures Part 5, immediately.** The accelerator's whole justification is a
  performance claim, and ten further parts are built on the assumption that the claim holds.
  A bench that runs last discovers a regression after everything downstream has been written
  against it, when the honest fixes are still edits to Part 5's two-arm conditional. Moving
  the measurement to the part after its subject keeps that feedback loop one part long. It
  measures **only** the `.rev` accelerator; the closure and `pack-objects` benches stay in
  Part 16, where their subject exists — a bench part must run after the code it prices, and
  those two subjects are not built until Parts 12–14.
- **Part 7 (the bitmap `fsck` pass) deliberately follows Parts 2–3 but must not import
  them.** ADR-605's separation is the load-bearing structural rule of the whole entry, so
  Part 7 lands the mechanical guard: a new `depcruise` forbidden rule that makes the
  import a red `check:architecture`, not a code-review opinion (S-14).
- **Part 8 pins both `fsck` arms against real git before any consumption code exists**, so
  a later parser cannot quietly change an `fsck` verdict.
- **Parts 9 and 10 split `rev-list` at the reachability core / walk-shaping seam.** Part 9
  is the closure engine plus the command's surface tax (barrel, facade, snapshot, page,
  scenario, README count, api.json) — a large mechanical block whose correctness claim is
  "the walk closure is right". Part 10 adds `all` / `maxCount` / `firstParent` / `noWalk`,
  whose correctness claim is "each option shapes the walk as git shapes it". Merging them
  would fuse a surface-tax diff with an option matrix.
- **Part 11 pins the walk tier against real git before the bitmap tier is built on it.**
  This is the single most valuable ordering choice in the plan: ADR-615 makes the walk the
  **oracle** for the bitmap tier, and an unpinned oracle is not an oracle. It is also why
  Parts 9–10 assert the have-bearing *relation* rather than exact counts (S-12).
- **Parts 12 and 13 split at ADR-617.** Part 12 is the pack-bitmap tier (position mapping
  through the `.rev` or the computed pack-position map, XOR-chain reconstruction, extended
  positions, the `useBitmapIndex` control). Part 13 is the midx-bitmap tier (the
  reverse-index chunk consumed, pseudo-pack positions, Pin AG's preference order). ADR-617
  is its own ratified decision with its own fallback matrix; folding it into Part 12 would
  make "the bitmap tier is wrong" and "the wrong bitmap was chosen" one failure.
- **Part 14 (`pack-objects`) is last of the code parts** because it is the only one that
  writes, and it consumes the finished engine at its own default tier (ADR-618).
- **Parts 11 and 15 are two parts over one interop file** for the reason above: Part 11's
  rows must be green *before* Part 12 exists, because Part 12's rows compare against them.

**No test assertion written by an earlier part is flipped by a later one.** That constraint
drove the ordering and is enforced through the **shapes**, not through timing:

- `RevListEntry.path` is declared **optional from Part 9** (ADR-619's shape) even though
  the walk tier always fills it, so Part 12 changes no field's type.
- `rev-list`'s default tier is the **walk** (ADR-618, Pin AJ1), so every Part 9/10 row that
  calls `revList` with no tier option keeps its exact expected value after Part 12.
- Part 9/10's have-bearing rows assert requirement 16's **relation** (superset, every extra
  reachable from a `not` tip), never a literal count; the literal counts arrive in Part 11
  against real git and in Part 15 against both tiers.
- Part 4's `.rev` `fsck` rows use fixtures with **no bitmap**; Part 7's bitmap rows use
  fixtures with a healthy `.rev`. The composition rows (`192 = 64|128`) live in Part 8.

## Shared conventions (bind every part)

- **Serena is ALREADY ACTIVATED** on this worktree. Do NOT call `activate_project`. Use
  `find_symbol` / `find_referencing_symbols` / `replace_symbol_body` /
  `insert_after_symbol` / `replace_content` as the default for every TypeScript
  read/navigate/edit (test files too); `get_diagnostics_for_file` after each source edit.
  `Read`/`Grep` only for markdown/JSON/generated artefacts. Diagnostics are advisory —
  ground truth is `npm run check:types`. `replace_symbol_body` on a TS `export const`
  arrow can double the `export const` prefix (TS1389): omit the prefix in the new body,
  then diagnose.
- **Test conventions**: `describe('Given <context>')` > `describe('When <action>')` >
  `it('Then <expected>')`; the 2-level `describe('Given …, When …')` shortcut is allowed
  when only one expectation lives under the When. Body is AAA with `// Arrange` /
  `// Act` / `// Assert` comments (a compound `// Arrange + Act` marker trips
  `emptyAaaSection` — keep the sections separate). The system under test is named `sut` —
  the *function or object under test*, never the result (`result` holds the result).
  The `sutBindsResult` allowlist in `test-pyramid-budgets.json` already carries
  `buildSeededContext`, `createPackRegistry`, `getPackRegistry`, `createNodeContext`,
  `createMemoryContext`, `withHandleLedger`, `trackedNodeContext`, `createPromiseMemo`.
  **Any NEW fixture factory bound to `const sut` must be added to that allowlist** or
  `check:test-pyramid` fails — prefer not to bind a new factory to `sut` at all.
- **Error assertions**: never `toThrow(TsgitError)` and never `toThrow(ErrorClass)` — the
  pyramid gate's `bareClassToThrow` heuristic (`\.toThrow(?:Error)?\s*\(\s*([A-Z]\w*)\s*\)`)
  is gating. Copy `expectRefusal` from `test/unit/domain/storage/midx.test.ts:170-189`
  verbatim in shape: capture `caught` **outside** the `try`, assert `data.code`, then
  `data.check`, then `data.reason`. A `check` assertion is not optional.
- **Isolated-guard rule**: for `if (A || B)`, write one `it` per operand with an
  arrangement that triggers that operand alone. Every matrix row below marked **own `it`**
  is there for this reason; merging two of them returns a mutant to surviving.
- **No provenance refs in code**: never write `ADR-6xx`, `§D3`, `Pin AJ`, `28.3`, `Phase …`
  or a backlog id inside `src/` or `test/`. Comments explain *why* in prose ("git prints
  bare object ids when a bitmap answers, so this field cannot be filled from one"). The
  commit message is the join point.
- **No suppression directives** of any flavour (`@ts-ignore`, `v8 ignore`,
  `stryker-disable`, `biome-ignore`). Pre-existing `// Stryker disable` comments in
  `pack-registry.ts` (`:318` on `nextOffsetForEntry`, `:416` on `trackClose`, `:505` on
  `refresh`'s rejected-scan arm), in `pack-index.ts` (`:124`, `:165`) and in
  `enumerate-push-objects.ts` (`:69`) are **structure-specific proofs**: any one a part
  edits around must be **re-proved by hand against the new structure** or deleted. Adding
  a *new* suppression is not an available action.
- **Errors classify structurally on `data.code`, never `instanceof`** across module
  graphs. The precedent is `errorDataCode` in
  `src/application/primitives/internal/midx-source.ts:101-105`. `isSkippableIdxFault` /
  `isSkippablePackFault` (`src/application/primitives/internal/pack-shared.ts:25-41`) use
  `instanceof` because they run inside one graph — do not copy that into new code that a
  test or a dist bundle can reach from another graph.
- **Degradation arms are positive allow-lists** over `TsgitErrorData['code']` — an explicit
  list of codes that degrade, everything else rethrown. Never `if (isFatal) throw`.
- **Coverage and mutation**: `vitest.config.ts` gates **100 % line/branch/function/
  statement** on `src/domain/**`, `src/ports/**`, `src/adapters/{node,memory}/**`,
  `src/operators/**` (`src/**/index.ts` excluded). Parts 1–3 land inside that set and every
  branch must be reached by a unit row. `src/application/**` is outside the coverage
  `include` but Stryker mutates all of `src`, break thresholds **99 for `src/domain/**`**
  and **95 for `src/application/**`** (`mutation-budgets.json`).
- **`check:duplicates` (jscpd, `minLines: 5`, `minTokens: 50`, threshold 5 %).** Three
  clone hazards in this entry, each named in its part: the `.rev` body reader against
  `midxReverseIndexAt`, the bitmap `fsck` hash-and-compare against `verifyMidxTrailer`,
  and `pack-objects`' `.idx` writing against `fetch-pack.ts`'s `buildIdx`. The third is
  resolved by **extraction**, not by tolerance (S-16).
- **`check:spelling` (cspell)**: words live inline in `cspell.json`'s `"words"` array
  (opens line 5, closes 1161) — there is no separate dictionary file. `EWAH`, `midx`,
  `PNAM`, `OIDF`, `OIDL`, `OOFF`, `LOFF`, `fanout`, `packfile` are already present. The
  midx reverse-index chunk's four-byte id is **not**; Part 1 adds it. Re-run
  `npm run check:spelling` fresh before pushing — it cache-skips after later-phase edits.
- **`reports/api.json` is a PREPUSH gate** (`check:doc-typedoc` = `git diff --exit-code --
  reports/api.json`, after `docs:json`), not a `validate` gate: local validate can be green
  and the push hook still rejects. **Every part ends by running `npm run docs:json` and
  staging `reports/api.json` if `git diff --exit-code -- reports/api.json` is non-empty** —
  the parts flagged below are the ones expected to move it, but the check is cheap and
  guessing is not. The huge typedoc-id diff is normal. `README.md` is a `docs:json` input,
  so a count bump alone makes the report stale.
- **Interop rules**: `describe.skipIf(!GIT_AVAILABLE)`, one shared `beforeAll(fn, 60_000)`
  per fixture, helpers from `test/integration/interop-helpers.ts` (`git`, `runGit`,
  `runGitEnv`, `tryRunGitWithExit`, `GIT_AVAILABLE`) — the scrubbed-`GIT_*` /
  isolated-`HOME` / `GIT_CONFIG_NOSYSTEM` env is built there once. **Build a fresh
  `Context` after every `git` subprocess** and dispose it (`trackedNodeContext` +
  `afterEach` → `disposePackRegistry`, the pattern at
  `fsck-pack-accessibility-interop.test.ts:48-59`). Every interop file carries an
  `@proves` header block (`surface`, `bucket: cross-tool-interop`, `unique` 12–200 chars,
  `interopSurface`).
- **Never commit on a red gate. Never `--no-verify`.**
- Blockers escalate as `{ part, reason, ≤3 options }` — never spin, never silently drop a
  row.

## Decision candidates

**None.** All twenty candidates are ratified as ADRs 603 … 622, and ADRs 586, 613, 615 and
616 carry amendments that supersede part of their original text — **ADR-622 is the newest
and it narrows ADR-615's "trust"**: a bitmap's reachability semantics are trusted, its
integers are range-validated, and a violation declines the whole artefact (Pin AK). That
obligation is threaded through Parts 3, 12, 13 and 15 below and is a **faithfulness
requirement, not optional hardening**. The design's §D1 … §D19 fix every mechanism this plan
schedules. The shapes below are *derived* from the design
and its ADRs, not chosen by this plan — each is listed with the line that determines it,
so a reviewer can check the derivation rather than re-litigate it.

## Derived shapes (not decisions)

| # | shape | value | derived from |
|---|---|---|---|
| S-1 | `RevIndexCheck` members | exactly **four**: `'size'` · `'signature'` · `'version'` · `'hash-id'` | §D2's five ordered parse steps collapse onto four gates — steps 1 and 5 are both `'size'`, distinguished by **reason**, because ADR-610 says "the size arm's two outcomes are distinguished by reason within `check: 'size'`". Adding a fifth member later is a public-surface change. |
| S-2 | the two `.rev` size reasons | `REASON_REV_INDEX_TOO_SMALL` and `REASON_REV_INDEX_CORRUPT`, exported `as const` from `src/domain/storage/rev-index.ts` | Pin H rows R7d (51 bytes → *is too small*) and R7c (52 bytes → *is corrupt*) are one byte apart and are git's own data. Exported so the application-layer pre-read bound (S-8) raises the identical reason rather than inventing a third, and so tests reference them by identity (killing StringLiteral mutants), the `validators.ts` convention. |
| S-3 | `BitmapCheck` members | exactly **six**: `'size'` · `'signature'` · `'version'` · `'options'` · `'stream'` · `'entry'` | §D3's refusal list, verbatim. `'options'` is the missing full-DAG bit (Pin E / row B19, where git aborts and a library declines). |
| S-4 | domain file split | `src/domain/storage/ewah.ts` (stream descriptor + fold) and `src/domain/storage/bitmap.ts` (container). **Both barrel-exported.** No re-export chain: `foldEwahStream` is exported from `ewah.ts` only, and the closure engine imports it from `src/domain/storage/index.js`. | §D3's "File budget" clause pre-authorises the split; the barrel is what keeps `knip` quiet in Part 2, since `src/domain/index.ts` is a knip entry point and `src/domain/index.ts` does `export * from './storage/index.js'`. |
| S-5 | midx chunk constant | named `CHUNK_ID_` + the chunk's own four ASCII bytes `{'R','I','D','X'}`, a module-private `const … = '<those four bytes>'` exactly like `CHUNK_ID_PNAM` (`midx.ts:11`). The same part adds that four-letter token to `cspell.json`'s `words`. | `midx.ts:11-15`'s style. The design's §D4 sketch names it `CHUNK_ID_REVERSE_INDEX`; the sibling style wins because five constants in one file must read alike. |
| S-6 | midx reverse-index chunk validation | present ⇒ length **exactly** `objectCount * 4`, else `check: 'chunk-length'` via the existing `requireChunkSize` (`midx.ts:229-237`). **Absence is not a fault** and adds no `check` member. | Pin AG9 (`6484 = 4 × 1621`) and Pin AG7 (a midx written without a bitmap has no such chunk — the common case). |
| S-7 | the `.rev` `fsck` pass file | a **new** `src/application/commands/internal/fsck/rev-index-health.ts` exporting `runRevIndexHealthPass(ctx, _opts)`, mirroring `runMidxHealthPass` (`midx-health.ts:38-41`) including the underscore-prefixed ignored `opts`. `pack-health.ts` is **not** extended. | Different universe: `runPackHealthPass` consumes `registry.indexFaults()` / `registry.health().unusable` (`pack-health.ts:36`), the new pass consumes `registry.all()` (§D11). Keeping them apart is also what makes Pin H C1 ≡ C2 true **for free** — a pack whose `.idx` failed to load is never in `all()`, so no second finding can be emitted for it. The design's test strategy says "extend `pack-health.test.ts`"; that file **does not exist** (the only file in `internal/fsck/` is `content-validation.test.ts`), so the pass gets its own new unit file. |
| S-8 | `ArtefactLoad<T>` | a four-arm discriminated union — `{ kind: 'usable'; value: T; bytes: Uint8Array }` · `{ kind: 'absent' }` · `{ kind: 'unreadable' }` · `{ kind: 'refused'; data: TsgitErrorData }`, all members `readonly` (spelled out in Part 4's context block). The loader **never rejects** and **never logs**. | §D5's four-way classification. Never-rejecting sidesteps the "a rejection is never memoised" rule entirely. Never-logging is required: the `fsck` pass maps `refused` to a finding and the accelerator maps it to a `ctx.logger?.warn?.` — a log inside the loader would double-report (requirement 25). |
| S-9 | `.rev` pre-read bound | the source module `stat`s and refuses **without reading** when `stat.size !== 12 + 4·objectCount + 2·digestLength`, raising `invalidPackRevIndex('size', …)` with `REASON_REV_INDEX_TOO_SMALL` below `12 + 2·digestLength` and `REASON_REV_INDEX_CORRUPT` at or above it; then reads and re-checks `bytes.length` (TOCTOU), then parses. | ADR-611: "that single test is simultaneously the allocation bound and git's own size check". The double stat/read check mirrors `readBoundedIdx` (`pack-registry.ts:181-194`). The parser's own steps 1 and 5 stay in place and are covered by unit rows — they are the domain's contract, not dead code. |
| S-10 | bitmap bound | in `validators.ts` beside `MAX_MIDX_BYTES`: `BITMAP_HEADROOM_BYTES_PER_OBJECT = 64`, `BITMAP_FLOOR_BYTES = 64 * 1024`, `maxBitmapBytes(objectCount)`, `exceedsMaxBitmapBytes(size, objectCount)`, `REASON_BITMAP_EXCEEDS_MAX`. The doc-comment carries the arithmetic **and** the measurement: 16268 B / 1606 objects ≈ 10.1 B per object (pack bitmap), 16176 / 1621 ≈ 10.0 (midx bitmap); 64 is ~6× measured density and bounds a 2 M-object repository at ~128 MiB. | ADR-611 + §D3's "The bound" paragraph, and `validators.ts:135-157`'s existing shape (a `REASON_*` `as const` plus an `exceedsMaxXxx` predicate, each tested with a just-under / at / just-over triple). |
| S-11 | `packPositionMap` | pure helper `packPositionMap(index: PackIndex): ReadonlyArray<number>` in a new `src/application/primitives/internal/pack-positions.ts` — the index positions `[0, N)` ordered by `entryOffsets(index)[i]`. Consumed by the `fsck` body cross-check (Part 4) and by the bitmap tier's `.rev`-free fallback (Part 12). | §D11: "`expected` is the index positions ordered by offset, i.e. exactly the pack-position map §D4 already needs. This is the one derivation shared between the accelerator layer and the `fsck` layer, and sharing it is what keeps the two from drifting." Note it is **not** `buildOffsetTable`'s fallback, which sorts *offsets* (ADR-604 keeps that sort verbatim). |
| S-12 | have-bearing assertions before Part 11 | Parts 9–10 assert only requirement 16's **relation** for have-bearing queries (result is a superset of the exact difference; every extra object is reachable from a `not` tip). Literal counts appear first in Part 11, against real git. | §D6's walk-tier paragraph is prose about `mark_edges_uninteresting`-shaped behaviour; Pin AJ1/AJ6 (156 vs 150, six extras all blobs) and Pin AB1 (204 vs 200) are the measurements. Pinning a literal count from prose would encode a guess. **If Part 11 finds the walk tier's count disagrees with real git, the fix is which uninteresting commits' trees are marked — escalate with the three candidates: (a) the `not` tips only, (b) the boundary commits, (c) the full have closure — never silently switch.** |
| S-13 | `ClosureRequest.tier` arrives in Part 12 | Part 9's `ClosureRequest` has **no** `tier` field and the engine walks; Part 12 adds `tier: ClosureTier` as a required input with no engine-side default (ADR-618) and `rev-list` supplies `useBitmapIndex ? 'bitmap' : 'walk'`. | A `ClosureTier` union with one implemented member would be dead code by the project's own guardrail. ADR-618 makes the walk `rev-list`'s default, so every Part 9/10 expectation survives Part 12 untouched. |
| S-14 | the parse-free guard | a new `forbidden` rule in `.dependency-cruiser.cjs`, landed in **Part 7**: `from: { path: '^src/application/commands/internal/fsck/bitmap-health\\.ts$' }`, `to: { path: '^src/domain/storage/(bitmap\|ewah)\\.ts$' }`, `severity: 'error'`, comment stating that git's entire bitmap obligation is the trailing checksum so a structural parse here would make tsgit stricter than git. | ADR-605 + §D12 ("the RESTAMPED interop rows are the mechanical guard") — an interop suite catches the *symptom*; this catches the *edge*. The rule is inert until Part 3's files exist, which is fine: `depcruise` matches by path. |
| S-15 | `RegisteredPack` additions | `readonly hasRevIndex: boolean`, `readonly hasBitmap: boolean` (Part 4 / Part 7), `readonly revIndex: () => Promise<ArtefactLoad<PackRevIndex>>` (Part 4), `readonly bitmapBytes: () => Promise<ArtefactLoad<Uint8Array>>` (Part 7), `readonly packPositions: () => Promise<ReadonlyArray<number>>` (Part 12) — each a `createPromiseMemo(...).get`. `PackGeneration` retains `fileNames` and gains `midxBitmap: PromiseMemo<MidxBitmapLoad \| undefined>` (Part 7). | §D5 (presence off the scan's existing listing, at no extra syscall — `scanPacks` already builds `fileNames` at `pack-registry.ts:490` and currently discards it) and §D15 (per-pack memos beside `indexMemo`/`headerMemo`/`offsetTable`; the midx bitmap memoised per **generation** because its identity depends on the midx layer in use). **`grep -c '"PackRegistry"' reports/api.json` is `0`** — the registry is not in `src/application/primitives/index.ts`, so none of these shape changes touches api.json. |
| S-16 | `pack-objects`' `.idx` writing | extract `buildIdx` (`fetch-pack.ts:477-499`) and `writePackArtifacts` (`fetch-pack.ts:507-528`) into a new `src/application/primitives/internal/write-pack-artifacts.ts`; `fetch-pack.ts` and `pack-objects.ts` both call it. `buildPack`'s `BuildPackResult` gains `readonly entries: ReadonlyArray<PackEntryMeta>` (already returned by `serializePackfile`, `pack-writer.ts:44-62`, and currently discarded). | Reimplementing the `.idx` **double trailer** (`serializePackIndex` writes the pack checksum, then the caller appends the digest over the body — `fetch-pack.ts:489-497`) would be a jscpd clone of ~20 lines *and* a second source of truth for a quirk that already surprised one reader. The `BuildPackResult` widening is additive; `push.ts` and `bundle-create.ts` are unaffected. |
| S-17 | `pack-objects` writes no new artefact kind | no `@writes` annotation, no `tooling/audit-write-surfaces.allowlist.json` entry. The existing annotation lives on `src/domain/storage/pack-writer.ts:8` (`surface: packfile`) and the extraction of S-16 must not move or duplicate it. | ADR-614. `check:write-surfaces` runs non-blocking, so an orphan-coverage entry from a new interop suite is reported and the gate still exits 0 — confirm the exit code in the part gate rather than deleting the `interopSurface` key. |
| S-18 | Tier-1 counts | `README.md:47` `43 Tier-1 commands` → **44** in Part 9 → **45** in Part 14. `docs/use/commands/README.md:3` `43 entries` → **44** → **45**. `test/unit/repository/repository.test.ts:238-286` grows from 47 keys to 48 then 49. | `README.md` has exactly one occurrence of the count (`grep -n "Tier-1" README.md`). Both files are `docs:json` inputs or gate inputs, so each bump forces its own api.json regeneration. |
| S-19 | parity-scenario receiver | the scenario body must call `repo.revList(…)` / `repo.packObjects(…)` with the receiver identifier **literally named `repo`** — `tooling/audit-browser-surface.ts:36-40` matches `/\brepo\.([a-zA-Z][\w]*)\s*\(/g`. Register each scenario in `test/parity/scenarios/index.ts` (named import + an entry appended to `SCENARIOS`). `check:parity-fixtures` forbids nondeterminism, so golden oids must come from `test/parity/fixtures.ts`'s fixed `AUTHOR` (`timestamp: 1_700_000_000`). | `tooling/audit-browser-surface.ts`; `tooling/audit-parity-fixtures.ts`; `test/parity/scenarios/show.scenario.ts` as the smallest exemplar. Also note `tooling/check-doc-coverage.ts:175` reads its allowlist from `scripts/` while the file lives in `tooling/` — **the doc-coverage allowlist is inert**, so a missing page cannot be allowlisted around. |
| S-20 | `unsupportedRuntimes` | if a new scenario needs a runtime gate, the declaration is `unsupportedRuntimes: ['workers', …]` on the `Scenario` object (`test/parity/scenarios/types.ts:9-16`), and it is honoured by **five dist-bundle drivers plus the browser spec**, each filtering `SCENARIOS` against its own runtime constant: `test/runtime-parity/workers/parity-memory.test.ts:30`, `test/runtime-parity/deno/parity-node.test.ts:33`, `test/runtime-parity/deno/parity-memory.test.ts:34`, `test/runtime-parity/bun/parity-node.test.ts:28`, `test/runtime-parity/bun/parity-memory.test.ts:28`, `test/browser/parity.spec.ts:67`. `test/parity/scenarios/midx-read.scenario.ts:228` is the live four-runtime example. | None of `test:parity:{deno,bun,workers}` is in the `validate` chain, so a missed driver is a CI-only red. `test/browser/parity.spec.ts:48-62` additionally asserts the browser bundle's scenario registry matches `SCENARIOS` exactly. |

## Part 1 — the reverse index, in both forms git stores it

### Context

**Goal.** §D2 + §D4's midx paragraph + ADR-610/611/617 + requirements 3, 4, 10, 11, 28: a
context-free, hash-generic parser over `.rev` bytes, a refusal carrying a closed `check`
discriminant, and the midx's reverse-index chunk read through the existing optional-chunk
pattern. No application code consumes either yet — both are barrel-exported public API,
which is what keeps `knip` green.

**New file:** `src/domain/storage/rev-index.ts`. Mirror `src/domain/storage/pack-index.ts`
(220 lines) and `src/domain/storage/midx.ts` (427 lines) in shape so all three read as
siblings.

**Current shapes you are extending** (line numbers are point-in-time — verify):

- `src/domain/storage/error.ts` (54 lines) — `MidxCheck` at `:8-19`, `StorageError` at
  `:21-35` (six members), one `export const <factory> = (…): TsgitError => new TsgitError({…})`
  per member at `:37-53`.
- `src/domain/storage/index.ts` (60 lines) — a grouped, comment-headed barrel; blocks are
  in file order and exports inside a block are alphabetical. The `// Multi-pack index`
  block is at `:26-28`; a new `// Pack reverse index` block goes between `// Pack index`
  (`:50-52`) and `// Pack writer` (`:54`). Types first (`export type { … }`), then values.
- `src/domain/error.ts` (551 lines) — `TsgitErrorData` unions `StorageError` at `:68`;
  `extractDetail`'s reason-carrying `case` group is `:183-198` (it already lists
  `INVALID_PACK_INDEX` at `:188` and `INVALID_MULTI_PACK_INDEX` at `:191`), falling through
  to `return data.reason;` at `:198`; the `never` default is `:546-549`.
- `src/domain/storage/midx.ts` — `MultiPackIndex` at `:23-40`; chunk-id constants at
  `:11-15`; `requireChunk` `:221-227`; `requireChunkSize` `:229-237`; the optional-`LOFF`
  read at `:121-123` (`const loffRange = chunkRanges.get(CHUNK_ID_LOFF); const
  largeOffsetsOffset = loffRange?.start;`) — **this is the pattern to copy**; `midxOidAt`
  `:410-418` is the model for the new index-addressed reader.
- `test/unit/domain/exhaustiveness.ts` (209 lines) — `assertExhaustiveSwitch(data)` at
  `:13`, one `case` per code, `never` default at `:205-206`. `INVALID_PACK_INDEX` at `:23`,
  `INVALID_MULTI_PACK_INDEX` at `:26`.
- `test/unit/domain/storage/error.test.ts` (139 lines) — one
  `describe('Given <factory>(…)') > describe('When checking error.data…') > it('Then …')`
  group per factory asserting `result.data` with `toEqual`, plus a trailing
  `assertExhaustiveSwitch` block at `:134`.
- `test/unit/domain/storage/arbitraries.ts` (347 lines) — `buildTestIndex` `:16-99`,
  `buildDelta` `:101`, `MidxEntrySpec`/`MidxSpec` `:189-202`, `buildMidx` `:204-289`,
  `arbMidxSpec` `:297`. Local constants `MIDX_HEADER_SIZE`/`MIDX_CHUNK_TABLE_ROW_SIZE`/
  `MIDX_FANOUT_SIZE` at `:185-187` are deliberately re-declared rather than imported from
  `src` — keep that discipline.
- `test/unit/domain/storage/midx.test.ts` (1448 lines) — `oid()` `:16-18`, `baseSpec()`
  `:20-38`, the byte-poking mutators `:40-168` (each `bytes.slice()` → poke → return),
  `expectRefusal` `:170-189`, `assertExhaustiveMidxCheck` `:191-210` (exercised at
  `:1426-1443`). `midx.properties.test.ts` is 139 lines.

**The shapes to land** (§D2, with S-1 and S-2 applied):

```ts
// src/domain/storage/rev-index.ts
export interface PackRevIndex {
  readonly version: 1;
  readonly hashId: 1 | 2;
  readonly digestLength: number;
  readonly objectCount: number;
  /** The embedded copy of the pack checksum. Retained, never compared. */
  readonly packChecksum: Uint8Array;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

export const REV_HEADER_SIZE = 12;
export const REASON_REV_INDEX_TOO_SMALL = 'reverse index is too small' as const;
export const REASON_REV_INDEX_CORRUPT = 'reverse index is corrupt' as const;

/** `objectCount` comes from the pack's own `.idx` — the file carries no count,
 *  only a length that implies one, so deriving it would make the size check
 *  tautological and an appended-bytes corruption undetectable. */
export function parsePackRevIndex(
  bytes: Uint8Array,
  digestLength: number,
  objectCount: number,
): PackRevIndex;

/** Index position of the object at pack position `p`. `p` is bounds-checked;
 *  the stored VALUE is not — an out-of-range value is a verification verdict,
 *  not a parse refusal, because git compares it like any other value. */
export function revIndexPositionAt(rev: PackRevIndex, p: number): number;
```

```ts
// src/domain/storage/error.ts — added to StorageError
export type RevIndexCheck = 'size' | 'signature' | 'version' | 'hash-id';
// …
| { readonly code: 'INVALID_PACK_REV_INDEX'; readonly reason: string; readonly check: RevIndexCheck }
export const invalidPackRevIndex = (check: RevIndexCheck, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACK_REV_INDEX', check, reason });
```

```ts
// src/domain/storage/midx.ts — additions
readonly reverseIndexOffset: number | undefined;   // on MultiPackIndex
/** The midx position of the object at pseudo-pack position `p`. */
export function midxReverseIndexAt(midx: MultiPackIndex, position: number): number;
```

**Parse order — each step gated on the previous. This ordering *is* requirement 11**
(no `DataView` read at an offset not already proved in-bounds; a `RangeError` escaping the
parser is a defect, not an error path):

1. `bytes.length >= REV_HEADER_SIZE + 2 * digestLength` → else `check: 'size'`, reason
   `REASON_REV_INDEX_TOO_SMALL` (Pin H rows R6/R7/R8/**R7d**).
2. magic — the four ASCII bytes `{'R','I','D','X'}` as a `u32BE` named constant → else
   `check: 'signature'` (R1).
3. `version === 1` → else `check: 'version'` (R2/R3). **Not `{1,2}`** — the one place a
   reader arriving from the midx over-generalises. There is no v2.
4. `hashId ∈ {1, 2}` → else `check: 'hash-id'` (R5). **No comparison against
   `digestLength`** — R16 pins that git accepts `hashId: 2` in a SHA-1 repository. Recorded
   as a field, never a gate. This is the **opposite** of the midx's `hash-version` rule
   (`midx.ts:93-99`), and the difference is measured, not stylistic.
5. `bytes.length === REV_HEADER_SIZE + 4 * objectCount + 2 * digestLength` → else
   `check: 'size'`, reason `REASON_REV_INDEX_CORRUPT` (R7c/R7b/R17). Distinct reason from
   step 1's because git's two messages are distinct and R7d ↔ R7c pins the boundary one
   byte apart.

`packChecksum` is `bytes.subarray(REV_HEADER_SIZE + 4 * objectCount, … + digestLength)`.
Step 5 doubles as the allocation bound: the exact-size test is simultaneously git's own
size check and the proof that every subsequent `getUint32` is in range. `N` is transitively
bounded because it comes from an `.idx` already capped at `MAX_PACK_IDX_BYTES`.

**The midx chunk** (§D4, S-5, S-6). In `parseMultiPackIndex`, after the `LOFF` block
(`midx.ts:121-123`), read the reverse-index chunk the same way: `chunkRanges.get(<the new
constant>)`, `reverseIndexOffset = range?.start`, and **when present** call the existing
`requireChunkSize(range, objectCount * 4, <the constant>)`. Absence is not a fault.
`midxReverseIndexAt(midx, position)` is `midx._view.getUint32(midx.reverseIndexOffset! +
position * 4)` behind a `position < objectCount` bound and a `reverseIndexOffset !==
undefined` bound — **both guards get their own isolated unit row**.

**jscpd hazard.** `revIndexPositionAt` and `midxReverseIndexAt` are the same three lines
over different bases. Write each against its own struct; do not extract a shared helper
that would force `PackRevIndex` and `MultiPackIndex` to share a shape. Check the jscpd
console output in the part gate.

**Surface gates this part pre-pays** (`src/domain/index.ts` does
`export * from './storage/index.js'` and is a typedoc entry point, so every new barrel
export is public API):

1. `src/domain/storage/index.ts` — a new `// Pack reverse index` block exporting
   `PackRevIndex`, `parsePackRevIndex`, `revIndexPositionAt`, `REV_HEADER_SIZE` and the two
   reason constants; `RevIndexCheck` and `invalidPackRevIndex` join the existing `// Errors`
   block; `midxReverseIndexAt` joins the `// Multi-pack index` block (alphabetically after
   `midxOidAt`).
2. `src/domain/error.ts` — add `INVALID_PACK_REV_INDEX` to `extractDetail`'s
   `return data.reason` case group at `:183-198`.
3. `test/unit/domain/exhaustiveness.ts` — add the `case`; without it `check:types` fails at
   the `never` default (**this is a legitimate RED**).
4. `test/unit/domain/storage/error.test.ts` — a factory group asserting
   `{ code, check, reason }` with `toEqual`.
5. `cspell.json` — add the chunk's four-letter token to `"words"` (S-5).
6. `npm run docs:json` + commit `reports/api.json` **in this commit** (prepush gate).

**Mutation traps** (`domain` bucket, break 99): the step-1 / step-5 size comparisons are
adjacent boundary arithmetic — the R7d/R7c pair one byte apart is what kills the
`EqualityOperator` and `ArithmeticOperator` mutants on both. Do **not** carry any
equivalence comment forward from `pack-index.ts` or `midx.ts`: those proofs are
structure-specific to their own strides.

### TDD steps

RED first. The gate runs `npm run check:types`, so a test importing a symbol that does not
exist is a compile error — that **is** the RED.

1. **RED** — extend `test/unit/domain/storage/arbitraries.ts` with
   `buildRevIndex(spec: RevIndexSpec): Uint8Array` emitting Pin B's layout (magic,
   `u32BE` version, `u32BE` hashId, `objectCount × u32BE` body, `digestLength` bytes of
   pack checksum, `digestLength` bytes of trailer) plus `arbRevIndexSpec`. Model it on
   `buildMidx` (`:204-289`). **The parser never reads the trailer, so this writer never
   hashes it** — say so in its doc-comment or a later reader will "fix" it. Also extend
   `buildMidx` with an optional reverse-index chunk (`revBody?: ReadonlyArray<number>`),
   inserted between `OOFF` and `LOFF` with the chunk-table row and every downstream offset
   shifted, the way `appendUnknownChunk` (`midx.test.ts:129-168`) already reallocates.
   Then write `test/unit/domain/storage/rev-index.test.ts`. Expected first failure:
   `TS2307` on `../../../../src/domain/storage/rev-index.js`.

   | group | rows | Then |
   |---|---|---|
   | accept | 0 objects; 1 object; 12 objects (the Pin B fixture, asserting the decoded body equals `[1, 9, 11, …]`); `hashId: 2` with `digestLength: 32` (size 124 for 12 objects); **`hashId: 2` with `digestLength: 20`** — written as an *accept* deliberately, the reason in the title, so a later "hardening" pass cannot silently turn it into a refusal | parsed fields equal the spec's; `packChecksum` is the spec's bytes |
   | size refusals — **own `it` each** | zero-length; 11 bytes; `12 + 2·dl − 1`; `12 + 2·dl` **exactly** with `objectCount > 0`; one byte short of exact; one byte long of exact; four bytes long of exact | first four → `check: 'size'` + `REASON_REV_INDEX_TOO_SMALL` where below the boundary, the rest → `check: 'size'` + `REASON_REV_INDEX_CORRUPT`. The `12 + 2·dl − 1` / `12 + 2·dl` pair is the boundary itself and must be two rows |
   | header refusals — **own `it` each** | bad magic (4th byte flipped); version 0; version 2; version 255; `hashId` 0; `hashId` 3 | `.data.check` **and** `.data.reason` asserted via `expectRefusal` |
   | `revIndexPositionAt` | `p = 0`; `p = N−1`; `p = N` → bounds refusal; an **out-of-range stored value** (999 in a 12-object file) asserting it is **returned**, not refused | the returned value, and the refusal's `check` |
   | order independence | a body that is not a permutation (`body[0] === body[1]`) | **parses**; the values come back as stored |

2. **RED** — `test/unit/domain/storage/rev-index.properties.test.ts`:
   - round-trip (lens 1): `parsePackRevIndex(buildRevIndex(spec), dl, n)` reproduces every
     header field and `revIndexPositionAt` reproduces every body word, over
     `objectCount ∈ [0, 500]`, `digestLength ∈ {20, 32}`, and **arbitrary body words
     including non-permutations and out-of-range values** — the parser must not care.
     `{ numRuns: 200 }`.
   - totality (lens 3): any byte string up to 4 KiB either parses or throws
     `INVALID_PACK_REV_INDEX` with a `check` from the closed union — **never** a
     `RangeError`. `{ numRuns: 100 }`.
   Generators live in `arbitraries.ts`, not in the test file.

3. **RED** — extend `test/unit/domain/storage/midx.test.ts`: accept a midx **with** the
   reverse-index chunk (values readable through `midxReverseIndexAt` at `0`, `N−1`);
   accept a midx **without** it (`reverseIndexOffset` is `undefined`, and
   `midxReverseIndexAt` refuses — **own `it`**); refuse a chunk whose length is
   `objectCount * 4 ± 4` → `check: 'chunk-length'` (**own `it` each direction**); refuse
   `position === objectCount` (**own `it`**). Extend `midx.properties.test.ts`'s round-trip
   so a spec carrying a reverse-index body round-trips. `assertExhaustiveMidxCheck` needs
   no new member (S-6).

4. **RED** — add the `case` to `test/unit/domain/exhaustiveness.ts` and the factory group
   to `error.test.ts`. Expected failure before the union widens:
   `TS2678: Type '"INVALID_PACK_REV_INDEX"' is not comparable to type …`.

5. **GREEN** — land `rev-index.ts`, the error member + factory, the midx chunk read and its
   accessor, the barrel blocks, the `extractDetail` case, the cspell word.

6. **REFACTOR** — re-read `parsePackRevIndex` against the five ordered steps and confirm no
   `getUint32` precedes its bounds proof; confirm `npm run test:coverage` is 100 % on both
   domain files (an unreached guard fails the build); check the jscpd console output for a
   clone against `midx.ts`; run `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/storage/rev-index.test.ts test/unit/domain/storage/rev-index.properties.test.ts test/unit/domain/storage/midx.test.ts test/unit/domain/storage/midx.properties.test.ts test/unit/domain/storage/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/rev-index.ts src/domain/storage/midx.ts src/domain/storage/error.ts src/domain/storage/index.ts src/domain/error.ts test/unit/domain/storage/rev-index.test.ts test/unit/domain/storage/rev-index.properties.test.ts test/unit/domain/storage/midx.test.ts test/unit/domain/storage/midx.properties.test.ts test/unit/domain/storage/arbitraries.ts test/unit/domain/storage/error.test.ts test/unit/domain/exhaustiveness.ts
```

Plus, in this part: `npm run test:coverage` (100 % on the new domain file),
`npm run check:spelling` (the new cspell word), `npm run check:dead-code` (the
barrel-exported functions have no `src/` consumer until Parts 4, 12 and 13; they are
reachable from the `src/domain/index.ts` entry point and must not be reported), and
`npm run docs:json` with `reports/api.json` staged in the same commit.

### Commit

`feat(storage): read the pack reverse index and the midx reverse-index chunk`

## Part 2 — the compressed bitmap stream decoder

### Context

**Goal.** §D3's EWAH paragraphs + ADR-611's binding mitigations + threat rows T-2/T-3/T-4 +
requirements 10, 11, 28: a lazy, bounds-proved reader for one compressed bit stream, with
the decompression bomb defused **by the destination**, not by trusting a declared length.
This is the highest-severity item in the design's threat model and the part exists so that
its bounded-work property lands before anything can depend on it.

**New file:** `src/domain/storage/ewah.ts`.

**The on-disk grammar** (Pin D, measured): a stream is
`u32BE bitSize · u32BE wordCount · wordCount × u64BE · u32BE runLengthWordPosition`.
Each 64-bit word is either a **run-length word** (bit 0 = the run's value, bits 1–32 = the
count of clean words, bits 33–63 = the count of literal words that follow) or a **literal**
consumed by the preceding run-length word's literal count. The empty stream on disk is
`bitSize = 0, wordCount = 1, word = 0, runLengthWordPosition = 0` — **20 bytes, not 12**.
A decoder that special-cases "empty means zero words" mis-parses git's own output.

**The shapes to land:**

```ts
// src/domain/storage/ewah.ts
export interface EwahStream {
  readonly bitSize: number;
  readonly wordCount: number;
  /** Byte offset of the first 64-bit word. */
  readonly wordsOffset: number;
  /** Byte offset one past the stream's trailing position word. */
  readonly endOffset: number;
}

/** Reads and bounds-proves one stream descriptor at `at`. Every declared
 *  length is validated against the REMAINING BUFFER before it is used for
 *  anything — git's own end-of-data check, where the mapped file length is
 *  the bound. Refuses with `check: 'stream'`. */
export function readEwahStream(bytes: Uint8Array, view: DataView, at: number): EwahStream;

/** Folds one stream into a CALLER-OWNED destination with the given operation.
 *  Never allocates, never materialises a run. Fills are clamped at the
 *  destination's end, so a run declaring 2^32 clean words costs a bounded
 *  number of writes and then stops. */
export function foldEwahStream(
  bytes: Uint8Array,
  view: DataView,
  stream: EwahStream,
  into: Uint32Array,
  op: 'or' | 'xor',
): void;
```

`into` is a `Uint32Array` of 32-bit lanes; a 64-bit EWAH word maps to two lanes, high word
first or low word first per the format's bit order — **decode the Pin C fixture in the unit
test and let the measured bits settle the endianness**, do not reason it out. The Pin C
values are the oracle: commits `bitSize=2`, one literal word `0x3` → bits 0, 1; trees
`bitSize=11`, word `0x700` → bits 8, 9, 10; blobs `bitSize=12`, word `0x8fc` → bits 2–7
and 11.

**The contract that defuses the decompression bomb, stated as invariants the tests assert
directly:**

- `into.length` is unchanged by every fold (it is caller-owned).
- no lane at or beyond `into.length` is ever written.
- a run-length word declaring `0xffffffff` clean words **returns** after filling the
  destination, in bounded time.
- `wordCount` is bounds-checked against `bytes.length` **before** any word is read.
- a `RangeError` escaping either function is a defect, not an error path.

**Error code.** `invalidPackBitmap('stream', …)` — the code and its `check` union land here
(S-3), together with the barrel block, `extractDetail`, the exhaustiveness case and the
`error.test.ts` group, because Part 2 is the first raiser. Part 3 adds no new member.

**Current shapes you are extending:** the same five sites Part 1 touched
(`src/domain/storage/error.ts`, `src/domain/storage/index.ts`, `src/domain/error.ts:183-198`,
`test/unit/domain/exhaustiveness.ts`, `test/unit/domain/storage/error.test.ts`), plus
`test/unit/domain/storage/arbitraries.ts` for the writer.

**Writer to add to `arbitraries.ts`:** `encodeEwah(bits: ReadonlyArray<number>, bitSize: number): Uint8Array`
producing a stream with **both** run-length and literal words (a writer that only ever
emits literals makes the round-trip property vacuous — assert in a unit row that a sparse
input produces at least one clean run). Plus `arbBitSet` over `[0, 5000)` with a sparse and
a dense generator.

**Surface gates:** `src/domain/storage/index.ts` gains a `// Pack bitmap` block (types then
values, alphabetical) exporting `EwahStream`, `readEwahStream`, `foldEwahStream`;
`BitmapCheck` and `invalidPackBitmap` join `// Errors`. `npm run docs:json` +
`reports/api.json` committed here.

**Mutation traps** (`domain`, break 99): the clamp comparisons (`min(runEnd, into.length)`)
and the run/literal split (`word & 1`, the two bit-field widths) are where
`EqualityOperator` / `ArithmeticOperator` mutants live. Each needs a row whose expected
output changes if the boundary moves by one — a run that exactly fills the destination and
a run that overruns it by one lane are two rows, not one.

### TDD steps

1. **RED** — `encodeEwah` + generators in `arbitraries.ts`; then
   `test/unit/domain/storage/ewah.test.ts`. Expected first failure: `TS2307` on
   `../../../../src/domain/storage/ewah.js`.

   | group | rows | Then |
   |---|---|---|
   | descriptor | the Pin C commits stream; the **empty** stream `bitSize=0, wordCount=1` with a title saying *20 bytes, not 12*; a stream at a non-zero `at` | `bitSize`, `wordCount`, `wordsOffset`, `endOffset` |
   | descriptor refusals — **own `it` each** | `at + 8 > bytes.length`; `wordCount` overruns the remaining buffer by one word; `wordCount = 0x7fffffff`; the trailing position word past the end | `check: 'stream'`, reason asserted |
   | fold — accept | Pin C's three type streams decoded to bits `{0,1}` / `{8,9,10}` / `{2..7, 11}`; a literal-only stream; a run-of-zeros stream; a clean run of ones exactly filling the destination; **a clean run one lane longer than the destination** | the destination's lanes, and `into.length` unchanged |
   | fold — the bomb, **as an explicit row** | a run-length word declaring `0xffffffff` clean words of value 1 | the call **returns**, the destination is full, nothing past `into.length` was written, and the row completes well inside the default test timeout |
   | fold — operations | the same stream folded with `'or'` into a pre-set destination (bits added, existing kept); folded with `'xor'` twice (returns to the original) | lane-by-lane equality |

2. **RED** — `test/unit/domain/storage/ewah.properties.test.ts`:
   - round-trip (lens 1): `foldEwahStream(readEwahStream(encodeEwah(bits)))` into a
     zeroed destination reproduces `bits` exactly, for sparse and dense sets over
     `[0, 5000)`. `{ numRuns: 200 }`.
   - totality + bounded work (lens 3, **the strongest fit in this entry**): for any byte
     string in the declared safe subset, `readEwahStream` returns or throws
     `INVALID_PACK_BITMAP` with a closed `check`; and for any stream it returns,
     `foldEwahStream` leaves `into.length` unchanged and sets no bit at or beyond it,
     whatever the stream declares. `{ numRuns: 100 }`.

3. **RED** — the error member, factory, `extractDetail` case, exhaustiveness case,
   `error.test.ts` group, **and an `assertExhaustiveBitmapCheck` helper** in
   `test/unit/domain/storage/ewah.test.ts` mirroring `assertExhaustiveMidxCheck`
   (`midx.test.ts:191-210`), exercised by one row per member — **six**. Five of the six
   members are not raised until Part 3; the helper is what makes their arrival a test
   change rather than a silent widening.

4. **GREEN** — land `ewah.ts`, the error member and the barrel block.

5. **REFACTOR** — confirm no `getUint32`/`getBigUint64` precedes its bounds proof; confirm
   100 % coverage; confirm the file is under 400 lines and every function under 20;
   `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/storage/ewah.test.ts test/unit/domain/storage/ewah.properties.test.ts test/unit/domain/storage/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/ewah.ts src/domain/storage/error.ts src/domain/storage/index.ts src/domain/error.ts test/unit/domain/storage/ewah.test.ts test/unit/domain/storage/ewah.properties.test.ts test/unit/domain/storage/arbitraries.ts test/unit/domain/storage/error.test.ts test/unit/domain/exhaustiveness.ts
```

Plus `npm run test:coverage`, `npm run check:dead-code`, and `npm run docs:json` with
`reports/api.json` staged in the same commit.

### Commit

`feat(storage): decode compressed bitmap streams by lazy run iteration`

## Part 3 — the pack bitmap container

### Context

**Goal.** §D3's container paragraphs + Pins D, E, AD, AH + ADR-605/621 + requirements 10,
11, 28: the header, the flag word, the four type streams, the XOR-chained per-commit entry
headers — and nothing after the last entry. **The parser's accept-set is git's accept-set**
(ADR-621): it declines where git declines and shrugs where git shrugs, because a decline
now reaches the walk tier and changes a have-bearing answer.

**New file:** `src/domain/storage/bitmap.ts`. It imports `readEwahStream` from `./ewah.js`
(sibling module, direct import — not through the barrel).

**On-disk layout** (Pin D, 12-object fixture, total 272 bytes):

| offset | field |
|---|---|
| 0 | magic — the four ASCII bytes `{'B','I','T','M'}` |
| 4 | **u16BE** version = `1` |
| 6 | **u16BE** option flags — `0x0005` by default |
| 8 | u32BE entry count |
| 12 | `digestLength` bytes: the pack checksum (for a midx bitmap, the midx checksum) |
| `12 + digestLength` | four streams, in order: **commits, trees, blobs, tags** |
| … | `entryCount` × { u32BE position, u8 XOR offset, u8 flags, stream } |
| … | flag-selected trailing extensions — **never read** |
| `len − digestLength` | the file's own digest — **never verified here** |

`12 + digestLength` is the **only** width-dependent offset in the format.

**The shapes to land:**

```ts
export interface PackBitmap {
  readonly version: 1;
  readonly optionFlags: number;
  readonly entryCount: number;
  readonly digestLength: number;
  /** The embedded pack (or midx) checksum. Retained, never compared. */
  readonly checksum: Uint8Array;
  /** The four type streams, in order: commits, trees, blobs, tags. */
  readonly typeStreams: readonly [EwahStream, EwahStream, EwahStream, EwahStream];
  /** Byte offset of the first per-commit entry header. */
  readonly entriesOffset: number;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

export interface BitmapEntryHeader {
  /** Index position (pack bitmap) or midx position (midx bitmap) of the commit. */
  readonly position: number;
  readonly xorOffset: number;
  readonly flags: number;
  readonly stream: EwahStream;
}

export function parsePackBitmap(bytes: Uint8Array, digestLength: number): PackBitmap;
export function bitmapEntryHeaders(bitmap: PackBitmap): ReadonlyArray<BitmapEntryHeader>;
```

**Parse order** (§D3):

1. `bytes.length >= 12 + digestLength` → else `check: 'size'`.
2. magic → `check: 'signature'`.
3. u16BE version `=== 1` → `check: 'version'`.
4. u16BE flags: **bit `0x1` (full-DAG) must be set** → else `check: 'options'`. git
   *aborts* here (exit 134); a library cannot abort, so tsgit declines and the caller falls
   back. **No other bit is interpreted** — every flag-selected extension is trailing
   (Pin AH: the per-commit entries sit at the same offset under flag words `0x0001`,
   `0x0005` and `0x0015`), so the flag word is never length-determining for anything read
   here.
5. u32BE entry count; `digestLength` bytes of embedded checksum, retained, never compared.
6. four streams, each skipped by `readEwahStream`'s `endOffset`. `entriesOffset` is the
   fourth stream's `endOffset`.

`bitmapEntryHeaders` walks `entryCount` headers from `entriesOffset`, each
`{ u32 position, u8 xorOffset, u8 flags }` followed by a stream. It refuses with
`check: 'entry'` when the fixed 6 bytes would leave the buffer, when a stream refuses, or
when **`xorOffset > i`** — the base must precede, so chains are acyclic by construction and
`i − xorOffset < 0` is a refusal rather than a cycle check (Pin AD rule 2). A non-zero
`xorOffset` on entry 0 is the same guard and gets its **own** row.

**Everything after the last entry is ignored.** The hash cache, the lookup table and the
pseudo-merge table are trailing and none is consumed.

**A too-large declared `bitSize` is not a refusal** (Pin J B22, where git shrugs too). The
container performs **no** cross-check of `bitSize` against any object count — it has none
to check against, and the consumer's destination bound is what makes the value harmless.

**Positions leave this parser unvalidated, deliberately — and that is ADR-622's design, not
a gap in it.** An entry header's `position` and every bit a stream sets are integers this
module cannot judge: ADR-622 validates them against the **object count of the pack (or the
midx pseudo-pack) the artefact indexes**, and that count is `.idx` / midx data the domain
container never sees. So `bitmapEntryHeaders` returns `position` exactly as stored, and the
**consumer** range-validates before resolving anything — Part 12 for a pack bitmap, Part 13
for a midx one. Do **not** add a range check here and do **not** clamp: a container that
refused would refuse files git parses, and a container that clamped would hide the fault the
consumer is obliged to report. One accept row (below) pins an entry header naming position
`999999` as **parsing**, with a title saying the range check belongs to the consumer, so a
later hardening pass has to delete a sentence to move it.

**cspell:** `bitmap` is an ordinary dictionary word; no new token is needed for this part.

**Surface gates:** the `// Pack bitmap` block in `src/domain/storage/index.ts` gains
`PackBitmap`, `BitmapEntryHeader`, `parsePackBitmap`, `bitmapEntryHeaders`.
`npm run docs:json` + `reports/api.json` committed here. No new `BitmapCheck` member (all
six landed in Part 2), so `error.ts`, `extractDetail` and `exhaustiveness.ts` are untouched.

**Mutation traps**: the flag-word test (`(flags & 0x1) === 0`) is a single-bit check —
rows for `0x0000`, `0x0004` (a non-full-DAG flag set alone) and `0x0001` kill the
`ArithmeticOperator`/`EqualityOperator` mutants; the `xorOffset > i` guard needs
`xorOffset === i` (accept) and `xorOffset === i + 1` (refuse) as two rows.

### TDD steps

1. **RED** — extend `test/unit/domain/storage/arbitraries.ts` with
   `buildBitmap(spec: BitmapSpec): Uint8Array` emitting the layout above (reusing Part 2's
   `encodeEwah`), and `arbBitmapSpec`. The trailer is `digestLength` zero bytes — **the
   parser never reads it**, say so in the doc-comment. Then write
   `test/unit/domain/storage/bitmap.test.ts`. Expected first failure: `TS2307`.

   | group | rows | Then |
   |---|---|---|
   | accept | the Pin D 12-object shape, asserting all four `typeStreams` and `entriesOffset`; the empty **tags** stream as `bitSize=0, wordCount=1` with a title saying *20 bytes, not 12*; `digestLength: 32` (the only width-dependent offset moves) | fields equal the spec's |
   | accept — flag words | `0x0001`, `0x0005`, `0x0015`, `0x0025` — **own `it` each**, plus one row asserting `entriesOffset` is **the same** under all four | all four accepted identically |
   | header refusals — **own `it` each** | `11 + digestLength` bytes; bad magic; version 0; version 2; flags `0x0000`; flags `0x0004` (a set bit that is not full-DAG) | `check` and reason via `expectRefusal` |
   | stream refusals — **own `it` each** | the commits stream's `wordCount` overruns the buffer; the tags stream's descriptor starts past the end | `check: 'stream'` |
   | entry refusals — **own `it` each** | an entry's 6 fixed bytes leave the buffer; an entry's stream overruns; `xorOffset > i`; a non-zero `xorOffset` on entry 0 | `check: 'entry'` |
   | entry accept | `xorOffset === i` (the first entry is the base); an `entryCount` of 0; a 3-entry file with offsets `{0, 1, 1}` | `bitmapEntryHeaders` returns the spec's positions, offsets, flags and stream bounds |
   | position is not judged here — **own `it`** | an entry header naming position `999999` in a 12-object shape | **parses**, and `position` comes back as `999999`; the title says the range check is the consumer's (Parts 12 and 13), not the container's |
   | ignored tail | the same entries with 6424 trailing bytes appended | parses identically; `entriesOffset` unchanged |

2. **RED** — `test/unit/domain/storage/bitmap.properties.test.ts`:
   - round-trip (lens 1): `parsePackBitmap(buildBitmap(spec), dl)` recovers every header
     field, and `bitmapEntryHeaders` recovers every entry, over 0–8 entries and
     `digestLength ∈ {20, 32}`. `{ numRuns: 200 }`.
   - totality (lens 3): for any byte string up to 8 KiB, `parsePackBitmap` returns a
     `PackBitmap` or throws `INVALID_PACK_BITMAP` with a `check` from the closed union —
     never a `RangeError`; and for any value it returns, every `typeStreams` bound and
     `entriesOffset` lies inside the buffer. `{ numRuns: 100 }`.

3. **GREEN** — land `bitmap.ts` and the barrel additions.

4. **REFACTOR** — confirm the file is under 400 lines (if not, the split point is the entry
   walk, not the header); confirm no read precedes its bounds proof; 100 % coverage; jscpd
   against `midx.ts`'s chunk walk; `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/storage/bitmap.test.ts test/unit/domain/storage/bitmap.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/bitmap.ts src/domain/storage/index.ts test/unit/domain/storage/bitmap.test.ts test/unit/domain/storage/bitmap.properties.test.ts test/unit/domain/storage/arbitraries.ts
```

Plus `npm run test:coverage`, `npm run check:dead-code`, `npm run check:duplicates`, and
`npm run docs:json` with `reports/api.json` staged in the same commit.

### Commit

`feat(storage): parse the pack bitmap container`

## Part 4 — artefact discovery and the `fsck` reverse-index pass

### Context

**Goal.** §D5 + §D11 + ADR-607/608/609/610/611 + requirements 1–7, 12, 26, 27: one loader
that discovers, bounds and classifies a pack's sibling artefacts, and the `fsck` pass that
turns a broken `.rev` into git's exit bit 64 with git's own finding cardinality.

**New file 1:** `src/application/primitives/internal/pack-artefact-source.ts` (S-8, S-9).
It owns discovery, the bounded read and fault classification for **all three** artefacts;
this part lands the `.rev` arm only, Part 7 adds the bitmap arms.

**New file 2:** `src/application/primitives/internal/pack-positions.ts` (S-11) —
`packPositionMap(index: PackIndex): ReadonlyArray<number>`, the index positions `[0, N)`
ordered by `entryOffsets(index)[i]`.

**New file 3:** `src/application/commands/internal/fsck/rev-index-health.ts` (S-7) —
`runRevIndexHealthPass(ctx, _opts)`, shaped exactly like `runMidxHealthPass`
(`midx-health.ts:38-41`), underscore-prefixed ignored `opts` included.

**Current shapes you are changing** (line numbers point-in-time — verify):

- `src/application/primitives/pack-registry.ts` (745 lines).
  - `isCandidate` (`:177-179`) — `entry.isFile && entry.name.endsWith('.idx') && isSafePackName(entry.name)`. **Unchanged**: artefacts are never candidates.
  - `readBoundedIdx` (`:181-194`) — the `stat` → bound → `read` → re-bound pattern to copy.
  - `loadPack` (`:204-303`) — `indexMemo` (`:207`), `headerMemo` (`:211`),
    `buildOffsetTable` (`:219-233`), `handleMemo` (`:241`), the returned literal
    (`:294-303`). The new per-pack memo goes beside these.
  - `interface RegisteredPack` (`:62-101`) — gains `hasRevIndex` and `revIndex()` (S-15).
  - `scanPacks` (`:466-507`) — builds `const fileNames = new Set(entries.filter(e => e.isFile).map(e => e.name))` at `:490` and **discards it after `loadCandidatePack` / `bindMidx`**. Retain it on `PackGeneration` and thread it into `loadCandidatePack` → `loadPack` so each pack knows its own siblings. **No extra syscall, no `stat`, no second `readdir`** — and `entry.isFile` is what excludes a symlinked artefact by construction (threat row T-9).
  - `PackGeneration` (`:370-393`) — gains `readonly fileNames: ReadonlySet<string>`.
  - `packBaseName` lives in `internal/pack-shared.ts:69`; `isSafePackName` at `:58-65`; `faultReason` at `:50-51`, re-exported from `pack-registry.ts:41`.
- `src/application/commands/internal/fsck/types.ts` (152 lines) — `FsckFinding` is a
  16-member union at `:8-109`; `pack-rev-index-unusable` at `:78-83`;
  `midx-checksum-mismatch` at `:91-96` (the no-`reason` shape); `FsckOptions` `:124-137`;
  `FsckResult` `:143-152` with the `exitCode` doc-comment at `:145-150`.
  **There is no exhaustiveness switch over `FsckFinding` anywhere in the repo** — adding a
  variant breaks nothing at compile time, which is exactly why the unit rows below must be
  written. Three places narrow the union by hand and **fail open** on a new variant; each
  must be inspected and, where it should include the new variants, updated in this part
  (Part 7 repeats the exercise for its own variant):
  `test/unit/application/commands/fsck-finding-ids.ts:10-18` (`findingIds`, narrowing on
  `'id' in finding` and friends — the two new variants carry no `ObjectId`, so it needs no
  change, but say so rather than assume it);
  `test/unit/application/commands/fsck.properties.test.ts` (575 lines — check whether it
  enumerates finding types); and
  `test/integration/fsck-pack-accessibility-interop.test.ts:132-136`, a hand-maintained
  `PACK_FINDING_TYPES` set feeding a `nonPackFindings` computation at `:138-140` — a new
  pack-shaped variant silently lands in the "non-pack" bucket unless it is added there.
- `src/application/commands/internal/fsck/exit-codes.ts` (24 lines) — `EXIT_PACK_REV_INDEX = 64`
  at `:24` with a doc-comment at `:18-23` that says *"tsgit has no reverse-index (`.rev`)
  reader … The name is a promise the code does not yet keep."* **ADR-607 requires that
  comment rewritten in this change.**
- `src/application/commands/fsck.ts` (140 lines) — pass order content (`:91`) → refs (`:97`)
  → pack (`:100`) → midx (`:106`) → connectivity; findings spread at `:120-129`; `exitCode`
  OR-chain at `:132-137`. The new pass is invoked **after** `runPackHealthPass` and its
  findings/exitBit fold into both lists. Passes take `ctx`, not `auditCtx`.
- `test/unit/application/commands/fsck.test.ts` (5503 lines) — helpers imported at `:1-43`
  (`buildSeededContext`, `instrumentedContext` from `../primitives/fixtures.ts`;
  `buildSyntheticPack`, `writeSyntheticPack`, `restampPackHeader`, `EntrySpec` from
  `../primitives/pack-fixture.ts`; `findingIds` from `./fsck-finding-ids.ts`;
  `refreshPackRegistry`/`disposePackRegistry`; `packsDir`/`looseObjectPath` from
  `path-layout.js`). Local builders `makeBlob` `:47`, `makeTree` `:53`, `makeCommit` `:58`,
  `makeTag` `:82`, `initBareCtx` `:99-104`. The pack-health cluster is `:2565-2860`;
  `:2824` is *"Given a pack with a corrupt .idx"* asserting `pack-rev-index-unusable`,
  bit 64 set and bit 4 absent — **that row must stay green unchanged** (Pin H C1 ≡ C2).
- `test/unit/application/primitives/pack-fixture.ts` (286 lines) — `writeSyntheticPack`,
  `buildSyntheticPack`, `EntrySpec`; it already pads the `.idx` to the two-trailer shape at
  `:150-155`. Add a `writeSyntheticRevIndex(ctx, packName, body, opts)` beside them.
- `test/unit/application/primitives/pack-registry.test.ts` (4879 lines) — the allow-list
  audit precedent is `:3559-3583`: an `it.each<MidxCheck>([...11 members])` asserting
  `isSkippableIdxFault(err) === false` **and** `isSkippablePackFault(err) === false`.

**The shapes to land:**

```ts
// src/application/primitives/internal/pack-artefact-source.ts
export type ArtefactLoad<T> =
  | { readonly kind: 'usable'; readonly value: T; readonly bytes: Uint8Array }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'refused'; readonly data: TsgitErrorData };

/** Never rejects and never logs: every fault is a value, and the CALLER decides
 *  whether it becomes a finding or a warning. A log here would double-report. */
export async function loadPackRevIndex(
  ctx: Context,
  revPath: string,
  present: boolean,
  digestLength: number,
  objectCount: number,
): Promise<ArtefactLoad<PackRevIndex>>;
```

Its body, in order: `present === false` ⇒ `{ kind: 'absent' }`; `stat` — a
`FILE_NOT_FOUND` ⇒ `absent`, a `PERMISSION_DENIED` ⇒ `unreadable` (**silent**, because git
is: Pin H R12); `stat.size !== 12 + 4·objectCount + 2·digestLength` ⇒ `refused` with
`invalidPackRevIndex('size', …)` and the S-2 reason chosen by the `12 + 2·digestLength`
boundary; `read`; re-check `bytes.length` (TOCTOU); `parsePackRevIndex` — any
`INVALID_PACK_REV_INDEX` ⇒ `refused` carrying `err.data`. Classification is a **positive
allow-list** over `data.code` (`FILE_NOT_FOUND`, `PERMISSION_DENIED`,
`INVALID_PACK_REV_INDEX`, `UNSUPPORTED_OPERATION`); anything else rethrows.

```ts
// src/application/commands/internal/fsck/types.ts — two new variants
| { readonly type: 'pack-rev-index-invalid'; readonly pack: string; readonly reason: string }
| { readonly type: 'pack-rev-index-position-mismatch';
    readonly pack: string; readonly position: number;
    readonly expected: number; readonly stored: number }
```

`pack` carries the pack base name and reuses `pack-inaccessible`'s doc-comment contract
(`types.ts:61-68`): vetted by the scan against separators / `..` / control characters, but
**not shell-safe**.

**The pass** (§D11), over **`registry.all()`** — packs the scan admitted (`.idx` present,
parseable, sibling `.pack` present), **not** `health().accessible`, and **not narrowed by
`packAccessibilityReported`**:

```
for each pack in registry.all() where pack.hasRevIndex:
  load = await pack.revIndex()
  absent | unreadable            -> nothing, silently
  refused                        -> one `pack-rev-index-invalid` { pack, reason: faultReason(data) }, bit 64, next pack
  usable ->
    2. digest: hash(bytes[0 .. len-dl)) === bytes[len-dl ..]?
       false -> one `pack-rev-index-invalid` { pack, reason: 'invalid checksum' }, bit 64
    3. body:  expected = packPositionMap(await pack.index())
       for q in [0, N): stored = revIndexPositionAt(rev, q)
         stored !== expected[q] -> one `pack-rev-index-position-mismatch`
                                   { pack, position: q, expected: expected[q], stored }, bit 64
```

Four things this shape settles, each against a pinned row:

- **Steps 2 and 3 both run even when 2 fails** (Pin H N2 emits `invalid checksum` *then*
  the position lines). A step-1 refusal **skips** 2 and 3 — git cannot verify a file it
  could not load.
- The digest uses `ctx.hash.hash(...)` with the algorithm from `ctx.hashConfig` — the
  **repository's**, never the artefact's `hashId` (Pin H R16 restamps a `hashId: 2` `.rev`
  with SHA-1 and git accepts it). This is the **opposite** of the midx rule; say so in a
  comment. Same call shape as `verifyMidxTrailer` (`midx-binding.ts:298-303`) — **jscpd
  hazard: three lines, do not extract a shared helper across the two, they select their
  algorithm on different grounds.**
- `packChecksum` is **never compared** (R10b) — its non-use is asserted by a unit row and
  by an interop row, not left to inspection.
- The findings array is built by **loop-drain** (`for … findings.push(one)`), never
  `push(...spread)`: a spread over a repo-sized array overflows the call stack near 125k
  elements (ADR-608).

**Exit-code doc-comment rewrite** (`exit-codes.ts:18-24`): replace the four lines with a
statement of the two causes it now has — a pack index that could not be loaded (so no
reverse index can be derived from it) **and** a reverse-index file that exists, is readable
and is itself wrong — and drop the "promise the code does not yet keep" sentence entirely.
Update the banner comment at `:8` in the same edit.

**Documentation.** `docs/use/commands/fsck.md` gains two rows in the finding table
(`:108-121`, after the `pack-rev-index-unusable` row) and its exit-integer table
(`:160-172`) keeps bit 64's row but must stop implying a single cause. `check:doc-coverage`
does not gate page *content*, but leaving the page wrong here is a knowledge loss the docs
phase cannot recover.

**Surface gates this part pre-pays:** `FsckFinding` is re-exported from
`src/application/commands/fsck.ts:26` and thence from the commands barrel (a knip entry
point), so both variants are public — `npm run docs:json` + `reports/api.json` committed
here. `grep -c '"FsckFinding"' reports/api.json` is currently `9`. No `docs/use` page is
*added*, no README count moves, no `@writes` annotation is owed.

**Mutation traps** (`application`, break 95): the `stored !== expected[q]` comparison and
the loop bound are the two live mutants — a fixture with **two** wrong positions (Pin H N1)
and one with a wrong **last** position are the rows that kill them. `hasRevIndex` gating
needs an absent-artefact row and a present-artefact row.

### TDD steps

1. **RED** — `test/unit/application/primitives/pack-fixture.ts` gains
   `writeSyntheticRevIndex`. Then
   `test/unit/application/commands/internal/fsck/rev-index-health.test.ts` (new file;
   `const sut = runRevIndexHealthPass;`, memory adapter, the `content-validation.test.ts`
   shape at `:1-8`). Expected first failure: `TS2307` on `rev-index-health.js`.

   | group | rows | Then |
   |---|---|---|
   | clean | healthy `.rev`; **no** `.rev` on disk; `.rev` present for a pack with no `.idx` fault | `findings` empty, `exitBit` 0 |
   | load family — **own `it` each** | bad magic; version 2; version 0; `hashId` 0; truncated to 8 bytes; zero-length; `12 + 2·dl − 1`; `12 + 2·dl` exactly; four bytes appended | exactly one `pack-rev-index-invalid` for that pack, `reason` asserted, `exitBit === 64`, **no** `pack-rev-index-position-mismatch` |
   | accepted-by-git rows — **own `it` each** | `hashId: 2` in a SHA-1 repo, trailer restamped; the embedded pack checksum flipped, trailer restamped | **no finding, `exitBit` 0** — the titles say why |
   | digest | trailer flipped | one `pack-rev-index-invalid` with reason `invalid checksum`, bit 64 |
   | body | `body[0]` out of range, restamped; `body[0] === body[1]`, restamped; **two** positions wrong, restamped; the **last** position wrong, restamped | one `pack-rev-index-position-mismatch` per wrong position (2 findings in the two-position row), each carrying `{ pack, position, expected, stored }`, bit 64 set **once** |
   | composition | trailer flipped **and** body wrong | the invalid finding **and** the mismatch findings, bit 64 once |
   | universe | a pack whose `.idx` is corrupt, with a broken `.rev` beside it | **no** `pack-rev-index-invalid` and no mismatch — the existing `pack-rev-index-unusable` from `runPackHealthPass` is the only bit-64 finding |
   | modes — **own `it` each** | each of the load / digest / body families under `{}`, `{ connectivityOnly: true }`, `{ full: false }`, `{ strict: true }` | the same findings and the same bit in every mode |
   | two packs | both with a corrupt `.rev` | two findings, bit 64 once |

2. **RED** — `test/unit/application/primitives/pack-registry.test.ts`: `hasRevIndex` is
   `true` only when the sibling file is in the scan listing; a symlinked `.rev` is **not**
   present; `pack.revIndex()` is single-flighted (two concurrent calls, one read — assert
   with `instrumentedContext`); `refresh()` re-reads. Plus the **allow-list audit**, copying
   `:3559-3583`'s shape: `it.each<RevIndexCheck>(['size','signature','version','hash-id'])`
   asserting `isSkippableIdxFault` and `isSkippablePackFault` both return `false`.

3. **RED** — `test/unit/application/commands/fsck.test.ts`: `fsck()` folds the new pass's
   findings and bit; bit 64 composes with bits 2/4/8 by OR; the pre-existing `:2824` row
   stays green.

4. **GREEN** — land `pack-artefact-source.ts`, `pack-positions.ts`, `rev-index-health.ts`,
   the two `FsckFinding` variants, the registry additions, the `fsck.ts` wiring, the
   exit-code doc rewrite, the two `fsck.md` rows.

5. **REFACTOR** — confirm every function is under 20 lines and `rev-index-health.ts` under
   400; confirm the classification allow-list is positive; confirm the loader neither logs
   nor rejects; run `npm run check:duplicates` (the digest three-liner against
   `verifyMidxTrailer`); `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/commands/internal/fsck/rev-index-health.test.ts test/unit/application/commands/fsck.test.ts test/unit/application/primitives/pack-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/pack-artefact-source.ts src/application/primitives/internal/pack-positions.ts src/application/primitives/pack-registry.ts src/application/commands/internal/fsck/rev-index-health.ts src/application/commands/internal/fsck/types.ts src/application/commands/internal/fsck/exit-codes.ts src/application/commands/fsck.ts test/unit/application/commands/internal/fsck/rev-index-health.test.ts test/unit/application/commands/fsck.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/pack-fixture.ts
```

Plus `npm run check:architecture`, `npm run check:duplicates`, `npm run check:dead-code`,
and `npm run docs:json` with `reports/api.json` staged in the same commit.

### Commit

`fix(fsck): report a broken pack reverse index like git`

## Part 5 — the reverse-index accelerator in `buildOffsetTable`

### Context

**Goal.** §D10 + ADR-604/606 + requirements 13, 14, 24: `buildOffsetTable` gathers in O(n)
from a usable `.rev` instead of sorting, with the body **trusted** exactly as git trusts
it, and the existing sort as the fallback on every other artefact state.

**File to change:** `src/application/primitives/pack-registry.ts`, `buildOffsetTable`
(`:219-233`), verbatim today:

```ts
  const buildOffsetTable = async (): Promise<PackOffsetTable> => {
    const index = await indexMemo.get();
    const stat = await ctx.fs.stat(packPath);
    const packFileSize = stat.size;
    const raw = entryOffsets(index);
    const sortedOffsets = [...raw].sort((a, b) => a - b);
    // The pack file trailer is a single pack-checksum digest (SHA-1: 20 bytes,
    // SHA-256: 32 bytes). The last entry's data ends exactly at trailerStart.
    const trailerStart = packFileSize - ctx.hashConfig.digestLength;
    if (trailerStart < 0) {
      throw invalidPackIndex('pack file too small to contain a trailer');
    }
    return { sortedOffsets, packFileSize, trailerStart };
  };
```

**The change**, and nothing more:

```ts
    const raw = entryOffsets(index);
    const load = await revIndexMemo.get();      // the Part 4 memo, never rejects
    const sortedOffsets =
      load.kind === 'usable'
        ? gatherByRevIndex(load.value, raw)     // O(n): raw[revIndexPositionAt(rev, p)]
        : [...raw].sort((a, b) => a - b);
```

`gatherByRevIndex` is a small local helper (or a named export of `pack-positions.ts`) that
preallocates `new Array<number>(n)` and fills it. **Pin AI is the correctness statement**:
`entryOffsets(index)[revBody[p]]` is strictly increasing over all 1606 positions of the
400-commit fixture, and over the 12-object fixture, and over the 30-commit one.

**The body is trusted** (ADR-606). No pre-use digest verification exists on this path and
none may be added: the artefact's own digest is checked in `fsck` and nowhere else. A
`revIndexPositionAt` value at or beyond `n` yields `undefined` from `raw[...]` — the gather
must **not** silently coerce it. Two honest options and the rule: this part takes the
first, because ADR-606's trust is about *values*, not about *types*.

1. the gather asserts `p < raw.length` per position and, on violation, **falls back to the
   sort for that pack** (one `ctx.logger?.warn?.` with the artefact name, then the correct
   answer) — bounded, silent about strategy, loud about the fault, and it keeps
   `sortedOffsets` a `number[]` with no holes;
2. (rejected) trust the index blindly and let `undefined` reach `nextOffsetForEntry`, which
   would turn a bad body into a confusing `invalidPackIndex` thrown from a *read*.

**Faults reach the logger with the artefact name, except where git is silent**
(requirement 25): `refused` warns; `unreadable` and `absent` do not (Pin H R12 —
git `stat`s, opens, falls back, and says nothing).

**The fallback is the correct answer**, so no result ever depends on the artefact's
presence — that is the whole of requirement 13 and it is what the tests assert.

**Threat row T-6 is accepted, not mitigated** (ADR-606): a well-formed `.rev` with a wrong
body redirects `nextOffsetForEntry`'s slice bounds. A security review that flags this
closes it against ADR-606 rather than re-arguing it. **Do not add verification here.**

**Do not touch** `nextOffsetForEntry` (`:320-331`) or its `// Stryker disable` comment at
`:318` — the offset table's *shape* is unchanged, only how it is built.

**Surface gates:** none. `grep -c '"PackRegistry"' reports/api.json` is `0`, so this part
changes no public API and needs no `docs:json` run.

**Mutation traps** (`application`, break 95): the `load.kind === 'usable'` branch is a
two-arm conditional whose arms must produce the **same** array — a mutant flipping it is
killed only by a row that asserts a *different observable*, so pair the equality row with
an instrumented read-count row (`.rev` present ⇒ the pack directory read count includes the
`.rev`; `.rev` absent ⇒ it does not).

### TDD steps

1. **RED** — `test/unit/application/primitives/pack-registry.test.ts`:

   | group | rows | Then |
   |---|---|---|
   | identity | a synthetic pack with a **healthy** `.rev`, and the same pack with the `.rev` deleted | `offsetTable().sortedOffsets` is **element-wise identical** across the two |
   | identity at scale | a 200-entry pack, offsets deliberately out of index order | identical, and strictly increasing |
   | fallback — **own `it` each** | `.rev` absent; `.rev` unreadable; `.rev` refused (bad magic); `.rev` refused (wrong size) | `sortedOffsets` equals the sort's; the read still resolves objects |
   | logging — **own `it` each** | refused ⇒ `ctx.logger.warn` called once with the artefact name; unreadable ⇒ **not** called; absent ⇒ **not** called | the spy's calls |
   | trust | a `.rev` whose body is a valid permutation but in the wrong order, trailer restamped | `sortedOffsets` is what that body implies — **not** the sort's — and no error is raised |
   | out-of-range body | a `.rev` whose `body[0]` is `999` in a 12-object pack, restamped | falls back to the sort, one warn, and every object still reads |
   | read count | instrumented context, `.rev` present vs absent | the `.rev` is read **once** per pack per `Context`, and not at all when absent |
   | single-flight | two concurrent `offsetTable()` calls | one `.rev` read |

2. **GREEN** — the `buildOffsetTable` change plus `gatherByRevIndex`.

3. **REFACTOR** — re-read the two arms for a shared post-condition; confirm the existing
   `// Stryker disable` comments in the file that this diff touched are still true against
   the new structure (`:318`, `:416`, `:505` — if untouched, leave them); confirm every
   existing `pack-registry.test.ts` row is green.

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/read-object.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts src/application/primitives/internal/pack-positions.ts test/unit/application/primitives/pack-registry.test.ts
```

Plus `npm run check:architecture`.

### Commit

`perf(pack): build the pack offset table from the reverse index`

## Part 6 — the accelerator bench

### Context

**Goal.** ADR-604's measured claim and requirement 15, for **one subject and one only: the
`.rev` accelerator in `buildOffsetTable`** that Part 5 just landed. Test-infra only: **no
`src/` delta.** The bitmap closure and `pack-objects` are **not** measured here — their
subject does not exist until Parts 12–14, and Part 16 prices them there.

**Why the measurement runs here.** Part 5's justification is a performance claim, and ten
further parts are built on the assumption that it holds. A bench that runs at the end
discovers a regression only after everything downstream has been written against it, and the
honest fixes are edits to Part 5's two-arm conditional. Measuring in the very next part keeps
the loop one part long.

**The measurement rules, which are ADR-604's and not this part's, and which are carried here
verbatim:** absolute wall-clock, **main versus branch**, sourced from the **CI nightly
artefact** — **never a local run**, and **never a self-share delta** (a self-share number is
Amdahl-fragile and has misled this repository before). A local run is a smoke test that the
cases execute; its numbers are not evidence and must not be quoted anywhere.

**The consequence, which the ADR fixes and this part may not renegotiate: a measured
regression is a defect to fix in this PR.** It is **not** a reason to drop the accelerator
and it is **not** a follow-up. The honest fixes, both edits to Part 5, are a size threshold
below which the `.rev` is not read, or reading the artefact only when the offset table is
actually forced. Escalate as `{ part: 5, reason, ≤3 options }` rather than choosing silently
— and never by weakening the bench.

**New/extended files:** `test/bench/pack-offset-table.bench.ts` (new) plus the existing
suite's shared `test/bench/fixtures.ts` (2.4 KB) and `support/`. The neighbours to model are
`pack-read.bench.ts` (4.0 KB) and `midx-lookup.bench.ts` (5.1 KB).
`vitest.bench.config.ts` includes `test/bench/**/*.bench.ts` with a 120 s timeout and writes
`reports/benchmarks/raw.json`.

**Two scenarios, both `buildOffsetTable`, and the second is the one that matters:**

1. `buildOffsetTable` over a **many-object** repository — the shape the O(n) gather wins on,
   and the only one anybody expects to be green;
2. `buildOffsetTable` over a **many-small-packs** repository — the shape where one extra
   `open` + `read` per pack can outweigh sorting a few hundred numbers. **This is the
   scenario that can turn the accelerator into a regression, so it is not optional and must
   not be trimmed for runtime.**

Each case runs **with the `.rev` present and with it deleted**, so the pair is comparable
within one run as well as across branches. That in-run pair is a shape check only — the
branch-versus-main comparison from the nightly artefact is the verdict.

**Fixtures** go through `test/bench/fixtures.ts` and `tooling/gen-bench-fixture.ts`; keep them
deterministic and reuse the existing generation helpers rather than adding a new fixture
pipeline. Benches must **not** spawn `git` — build the `.rev` with the same in-test writer the
unit suites use (`writeSyntheticRevIndex`, landed in Part 4), or generate it once into the
bench fixture directory.

**Reporting.** `npm run bench:summary` / `tooling/bench-summarize.ts` and
`tooling/bench-check.ts` already exist; add both cases to whatever manifest they read so the
nightly artefact carries them. Do **not** wire a new blocking threshold — the
benchmark-comparison job is non-blocking by design because it measures runner noise.

### TDD steps

1. **RED** — add the two bench cases; they "fail" only by not existing. Run
   `npm run test:bench` locally **once** to confirm they execute and produce numbers.
2. **GREEN** — the cases run and are picked up by `bench:summary`.
3. **REFACTOR** — confirm the fixtures are deterministic; confirm no bench spawns `git`;
   confirm the many-small-packs case really does build many small packs (assert the pack
   count **inside the fixture builder**, not in prose); confirm the `.rev`-present and
   `.rev`-absent variants of each case are registered under distinct names so the nightly
   artefact can tell them apart.

**Reporting obligation for the PR body, not for this file:** once CI's nightly bench has run
on both `main` and the branch, quote the two absolute wall-clock numbers per scenario. If
scenario 2 regresses, fix it in this PR under the escalation above.

### Gate

```
npx vitest bench --run --config vitest.bench.config.ts test/bench/pack-offset-table.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/pack-offset-table.bench.ts test/bench/fixtures.ts
```

Plus `npm run check:test-pyramid` (the bench tier's budget).

### Commit

`test(bench): measure the reverse-index accelerator`

## Part 7 — the `fsck` bitmap pass and exit bit 128

### Context

**Goal.** §D12 + Pins J/K/L + ADR-605/611/612 + requirements 1, 2, 8, 9, 10: a new `fsck`
pass whose **entire** obligation is `hash(file[0 .. len − digestLength)) ==
file[len − digestLength ..]`, for pack bitmaps and for the in-use midx's bitmap, scoring a
new exit bit 128. **It does not parse, and a mechanical rule now enforces that** (S-14).

**New file:** `src/application/commands/internal/fsck/bitmap-health.ts` —
`runBitmapHealthPass(ctx, _opts)`, same shape as `runMidxHealthPass`. It is the smallest
pass in the codebase.

**Its whole body, in order, over the same `registry.all()` universe Part 4 argues for:**

1. For each pack in `registry.all()` with `<base>.bitmap` **present and readable**: hash
   `[0, len − digestLength)` and compare with the trailing `digestLength` bytes. Mismatch ⇒
   `{ type: 'bitmap-checksum-mismatch', artefact: '<base>.bitmap' }` and `exitBit |= 128`.
   **`len < digestLength` is a mismatch, not an arithmetic edge** — a zero-length file and
   a 10-byte file both score 128 under git (Pin J B11, B25), so the length guard comes
   **first** and produces the finding, never a negative `subarray` bound. This is the one
   place the "hash and compare" one-liner is wrong.
2. If a usable midx exists, compose `multi-pack-index-<hex>.bitmap` from the in-use layer's
   **stored** trailer bytes and do the same. **Not present ⇒ nothing** — which is how
   Pin K X7 (a renamed bitmap) and X10 (a midx whose own trailer is wrong: exit **32**, and
   never `32|128`) come out right with **no special case**: a wrong stored trailer simply
   names a file that is not there.
3. Unreadable ⇒ nothing, silently (Pin J B12, Pin K X6).

**No header parse, no version gate, no flag gate, no stream walk** — even though the parser
now exists three files away. Pin J rows B14–B19 are the licence: every restamped structural
corruption exits **0** under git, so a structural check here would make tsgit *stricter*
than git, which is itself a divergence.

**Step 2 is unconditional** — ADR-612 declines git's `core.multiPackIndex` gate, as a named
deliberate divergence. Both bitmap arms run in every mode.

**Ordering** matters for exactly one thing and it is not correctness: step 2 needs the
in-use midx layer's identity already settled, which `fsck.ts`'s existing sequence
guarantees — `runMidxHealthPass` is invoked at `:106`, so the new pass goes **after** it.

**Current shapes you are changing:**

- `src/application/primitives/internal/midx-binding.ts` — `LoadedMidx` at `:33-53`;
  `verifyMidxTrailer` at `:298-303` shows how the in-use layer is reached:
  `midx.set.layers[midx.set.layers.length - 1]!` and `head._bytes` / `head.digestLength`.
  The bitmap's filename is `bytesToHex(head._bytes.subarray(head._bytes.length - head.digestLength))`
  — **the stored bytes, never a recomputed digest** (Pin K rule 3, ADR-617). The trailer
  bytes come from `LoadedMidx`, **not** from `MidxHealth` (which exposes a name and a
  boolean, not the layer's `_bytes`).
- `src/application/primitives/pack-registry.ts` — `RegisteredPack` gains `hasBitmap` and
  `bitmapBytes()`; `PackGeneration` gains a `midxBitmap` memo (per **generation**, not per
  pack, because its identity depends on the midx layer in use — a `refresh()` that changes
  the midx changes the artefact name). The registry exposes
  `midxBitmap(): Promise<({ readonly artefact: string } & ArtefactLoad<Uint8Array>) | undefined>`.
- `src/application/primitives/internal/pack-artefact-source.ts` — gains
  `loadBitmapBytes(ctx, path, present, objectCount)` (bounded by S-10's
  `exceedsMaxBitmapBytes`, `stat` then re-check after read) and
  `midxBitmapName(head: MultiPackIndex): string`.
- `src/application/primitives/validators.ts` (223 lines) — the new bound joins the
  `multi-pack-index` block (`:135-157`), same shape: a `REASON_*` `as const` plus an
  `exceedsMax…` predicate, each tested with a just-under / at / just-over triple (S-10).
- `src/application/commands/internal/fsck/exit-codes.ts` — `EXIT_BITMAP = 128` plus a
  banner line; `types.ts` gains
  `| { readonly type: 'bitmap-checksum-mismatch'; readonly artefact: string }` — **no
  `reason`**, the exact shape of `midx-checksum-mismatch` (`types.ts:91-96`), for the same
  two situations: a midx bitmap has no pack to name, and there is precisely one way to fail
  a checksum (Pin J rule 2). `FsckResult.exitCode`'s doc-comment (`types.ts:145-150`) gains
  bit 128.
- `.dependency-cruiser.cjs` — the `forbidden` array (9 rules today, first at `:5`) gains
  S-14's rule. Copy the shape of `domain-cannot-import-outward` (`:5-13`).

**Documentation.** `docs/use/commands/fsck.md`: one new finding row and one new exit-integer
row (`128`, and `192` for the composition), plus the bit-128 clause in the `exitCode`
narrative.

**Surface gates:** the new variant and `EXIT_BITMAP` are public through
`src/application/commands/fsck.ts:26` and the commands barrel — `npm run docs:json` +
`reports/api.json` committed here. No page is added, no README count moves.

**jscpd hazard:** the hash-and-compare is three lines and now exists twice
(`verifyMidxTrailer` and this pass) plus once more in Part 4. Three near-identical
three-liners across three files with different algorithm-selection rationales stay
separate; confirm the jscpd console output rather than extracting.

**Mutation traps**: the `len < digestLength` guard needs its **own** row (a 10-byte file)
distinct from the zero-length row and from the ordinary mismatch row; `hasBitmap` gating
needs present/absent rows; the midx arm needs a present-name row and a
name-does-not-exist row.

### TDD steps

1. **RED** — `test/unit/application/primitives/validators.test.ts`: the just-under / at /
   just-over triple for `exceedsMaxBitmapBytes` and the `REASON_*` identity.

2. **RED** — `test/unit/application/commands/internal/fsck/bitmap-health.test.ts` (new;
   `const sut = runBitmapHealthPass;`, memory adapter, `writeSyntheticPack` plus a new
   `writeSyntheticBitmap` helper in `pack-fixture.ts` that writes arbitrary bytes with a
   correct or incorrect trailing digest).

   | group | rows | Then |
   |---|---|---|
   | clean | healthy pack bitmap; **no** bitmap; unreadable bitmap; a bitmap beside a pack with no `.pack` (never registered) | no finding, `exitBit` 0 |
   | mismatch — **own `it` each** | trailer flipped; magic flipped (trailer left stale); version 2 (stale); `entryCount` 99 (stale); truncated to `digestLength` bytes; **truncated to `digestLength − 10` bytes**; zero-length; embedded pack checksum flipped (stale) | one `bitmap-checksum-mismatch` with `artefact` = `<base>.bitmap`, `exitBit === 128` |
   | restamped structural corruption — **own `it` each** | magic flipped **restamped**; version 2 restamped; `entryCount` 99 restamped; truncated restamped; flag word 0 restamped; a stream `wordCount` of `0x7fffffff` restamped; embedded checksum flipped restamped | **no finding, `exitBit` 0** — each title says the pass hashes and does not parse |
   | midx arm — **own `it` each** | midx bitmap trailer flipped; midx bitmap magic flipped restamped; midx bitmap deleted; midx bitmap renamed to a different hash; a midx whose own stored trailer is wrong **with** a corrupt bitmap beside it | 128 / 0 / 0 / 0 / **0 from this pass** (the midx pass supplies 32) |
   | modes | each of the above families under `{}`, `{ connectivityOnly: true }`, `{ full: false }`, `{ strict: true }` | the same finding and the same bit in every mode |

3. **RED** — `test/unit/application/primitives/pack-registry.test.ts`: the **allow-list
   audit for the bitmap code**, the twin of Part 4's — `it.each<BitmapCheck>(['size',
   'signature', 'version', 'options', 'stream', 'entry'])` asserting `isSkippableIdxFault`
   and `isSkippablePackFault` both return `false`. Requirement 12 is satisfied only when
   **both** new codes are audited at **every** `check` value; reusing `INVALID_PACK_INDEX`
   would have been laundered into "skip this pack" and could remove a healthy pack from the
   generation, so this is closed by assertion, not by inspection.

4. **RED** — `test/unit/application/commands/fsck.test.ts`: bit 128 composes by OR
   (`192 = 64|128` with a broken `.rev` and a broken bitmap on the same pack; `142` and
   `138` with a header-refused `.pack`); and a row asserting **no** bitmap bit when the
   `.pack` is absent (an orphaned `.idx` is excluded at scan time, so the pack is never in
   `all()`).

5. **RED** — the depcruise rule (S-14). To see it RED, temporarily add an
   `import type { PackBitmap } from '../../../../domain/storage/index.js'` to
   `bitmap-health.ts`, run `npm run check:architecture`, confirm the rule fires, then
   remove the import. **Do not commit the temporary import.**

6. **GREEN** — land `bitmap-health.ts`, `EXIT_BITMAP`, the variant, the bound, the source
   module's bitmap arms, the registry additions, the `fsck.ts` wiring, the depcruise rule,
   the `fsck.md` rows.

7. **REFACTOR** — confirm the pass imports **nothing** from `src/domain/storage/bitmap.js`
   or `ewah.js`; confirm the length guard precedes the `subarray`; jscpd; `npm run docs:json`
   and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/commands/internal/fsck/bitmap-health.test.ts test/unit/application/commands/fsck.test.ts test/unit/application/primitives/validators.test.ts test/unit/application/primitives/pack-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/fsck/bitmap-health.ts src/application/commands/internal/fsck/types.ts src/application/commands/internal/fsck/exit-codes.ts src/application/commands/fsck.ts src/application/primitives/internal/pack-artefact-source.ts src/application/primitives/pack-registry.ts src/application/primitives/validators.ts test/unit/application/commands/internal/fsck/bitmap-health.test.ts test/unit/application/commands/fsck.test.ts test/unit/application/primitives/validators.test.ts test/unit/application/primitives/pack-fixture.ts
```

Plus `npm run check:architecture` (the new rule must be green **and** must fire on the
temporary import of step 4), `npm run check:duplicates`, and `npm run docs:json` with
`reports/api.json` staged in the same commit.

### Commit

`fix(fsck): report a corrupt pack or multi-pack-index bitmap like git`

## Part 8 — cross-tool `fsck` interop for both artefacts

### Context

**Goal.** The design's *Integration / interop* section, requirements 1–9, and blind spots 4
and 6. Test-infra only: **no `src/` delta.** This part pins both `fsck` arms against real
git 2.55.0 before any consumption code exists, so a later parser cannot quietly change an
`fsck` verdict.

**New file 1:** `test/integration/rev-bitmap-fixture-helpers.ts` — the byte recipes, lifted
out so the interop suites cannot drift on them. Model:
`test/integration/midx-fixture-helpers.ts` (418 lines), including its opening comment about
why it is not under `test/_helpers/`, its `DIGEST_LENGTH = 20`, `sha1()`,
`restampMidxTrailer()`, and `mutateMidxOrThrow` (chmod writable first, throw on a failed
write — **pack files land mode `0444`, and a mutation that silently no-ops makes the whole
row read as a false `0`**).

Exports to provide:

- `packArtefactPaths(dir)` → `{ pack, idx, rev, bitmap }` for the sole pack;
- `restampRevIndex(bytes)` / `restampBitmap(bytes)` — recompute the trailing digest over
  `[0, len − 20)`; **a control row must prove the restamp algorithm is git's own**:
  restamp-with-no-other-change leaves `git fsck` at exit 0. Without that control every row
  reads as "checksum failure" and the matrix is uninterpretable;
- `mutateOrThrow(path, fn)` — chmod, read, mutate, write, throw on failure;
- `buildBaseFixture()` — 2 commits / 6 blobs / 3 trees → 12 objects in one pack via
  `git repack -adq` (which writes `.rev` **by default**);
- `buildBitmapFixture()` — the same plus `--write-bitmap-index`;
- `buildMidxBitmapFixture()` — two packs, `git multi-pack-index write --bitmap`.

**New file 2:** `test/integration/rev-bitmap-fsck-interop.test.ts`. Header block:

```
 * @proves
 *   surface:        fsck.packArtefacts
 *   bucket:         cross-tool-interop
 *   unique:         reverse-index and bitmap fsck verdicts match canonical git
 *   interopSurface: pack-artefacts
```

`check:write-surfaces` will record that `interopSurface` as **orphan coverage** (a test
claims a surface no `@writes` annotation declares). The audit runs without `--blocking`, so
the gate still exits **0** — confirm the exit code, do not remove the key.

**Structure.** `describe.skipIf(!GIT_AVAILABLE)`, one shared
`beforeAll(async () => { … }, 60_000)` per fixture family building a base repo in a
`mkdtemp`, then **one fresh copy per row** (never a shared, progressively-mutated repo).
Per row: run real `git fsck` via `tryRunGitWithExit`, run `tsgit.fsck()` on a **fresh
`Context` built after the last `git` subprocess**, and assert:

1. `exitCode` **equality** with git's;
2. the tsgit findings reconstruct git's stderr line *shapes* — reconstruction lives in the
   test, never in the library.

**Assert bit-wise against a per-mode control, never against literals** (blind spot 6):
`--no-full` adds a constant `2` on an all-packed fixture, so the control row's exit is the
baseline every `--no-full` row is compared against.

`<expected>` in git's `invalid rev-index position at N: <expected> != <stored>` is
**fixture-dependent** — it changes with every freshly-built repository. **Only the message
shape and the finding cardinality are data**; an assertion pinning the literal integer pair
will flake.

**Rows** (design's list, in this order):

- `.rev`: R0, R1, R2, R5, R6, R8, R9b, **R10b**, R11, R12, R13, R14, R15, N1, **R16**, R17,
  C1, **C2**, plus multi-pack composition (two packs each with a corrupt `.rev` → exit 64,
  two findings).
- `.rev` modes (Pin I): M0, M1, M2, M3, M4, M5, M7, M8 across default /
  `--connectivity-only` / `--no-full` / `--strict`, plus X9 (a corrupt `.rev` on a
  midx-named pack).
- `.bitmap`: B0, B1, B2, B9, B12, B23, **B14**, **B16**, **B18**, B24.
- midx bitmap: X0, X1, **X2**, X4, X5, **X7**, X8, **X10**.
- composition (Pin L): Y1, Y2, Y3, **Y4**, Y5, **Y6**.

**The bolded rows assert an exit code with *no* artefact bit where a naive implementation
would score one.** They are the majority of the design's `fsck` risk and must not be
trimmed. X10 (a midx whose trailer is wrong hiding its own bitmap: **32**, never `32|128`)
is the row most likely to look like a test bug when it fails — its title must say why it is
32.

**Traps carried forward from prior runs:**

- pack files land mode `0444`; `chmod u+w` before every mutation.
- `chmod 000` rows must be skipped or guarded when the suite runs as root; follow whatever
  `fsck-pack-accessibility-interop.test.ts` already does for its permission rows.
- a git-spawning interop suite that also runs an in-process server needs `gitAsync`; this
  one does not spawn a server, so synchronous `git` is fine.
- one shared `beforeAll` per fixture and a 60 s timeout, or the suite flakes on a cold
  object cache.

### TDD steps

1. **RED** — write `rev-bitmap-fixture-helpers.ts` and the **control rows only** (R0, B0,
   X0, Y0, plus the restamp-is-git's control). Expected first failure: the fixture builders
   do not exist / the control asserts a mismatch until the restamp is right. Getting the
   control green **before** any mutation row is the point of this step.
2. **RED** — the `.rev` rows, family by family (load, digest, body, accepted-by-git,
   universe, modes, multi-pack). Each row its own `it`.
3. **RED** — the `.bitmap` rows, then the midx-bitmap rows, then the composition rows.
4. **GREEN** — no `src/` change is expected. **If a row is red, the defect is in Parts 4, 5 or 7
   and the fix lands here as a `src/` edit with its unit row added in the same commit** —
   escalate as `{ part, reason, ≤3 options }` if the fix would change a shape this plan
   fixed.
5. **REFACTOR** — confirm every row builds its `Context` after the last subprocess and
   disposes it; confirm no row asserts a fixture-dependent integer; confirm the suite's
   runtime is acceptable and the `@proves` header parses.

### Gate

```
npx vitest run test/integration/rev-bitmap-fsck-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/rev-bitmap-fsck-interop.test.ts test/integration/rev-bitmap-fixture-helpers.ts
```

Plus `npm run check:test-pyramid` (the `@proves` header and the integration-tier budget)
and `npm run check:write-surfaces` (must exit **0** with the orphan-coverage entry
recorded).

### Commit

`test(fsck): pin reverse-index and bitmap verdicts against real git`

## Part 9 — the closure engine's walk tier and `rev-list`'s reachability core

### Context

**Goal.** §D6's walk-tier paragraphs + §D7 + ADR-613/618/619/249 + requirements 20, 22, 23:
one engine that computes a reachability closure by walking, and the first of two commands
over it. **The engine holds no tier default** — but it also has no tier yet (S-13): this
part ships the walk, and ADR-618 makes the walk `rev-list`'s default, so nothing here is
provisional.

**New file 1:** `src/application/primitives/internal/closure-engine.ts`.

```ts
export interface ClosureRequest {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly not: ReadonlyArray<ObjectId>;
  /** Include trees and blobs, not just commits and tags. */
  readonly objects: boolean;
}
export interface ClosureObject {
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  /** Populated by the walk. A reachability artefact encodes types and bits,
   *  never names, so a future non-walking producer cannot fill this. */
  readonly path?: FilePath;
}
export interface ClosureResult {
  readonly objects: ReadonlyArray<ClosureObject>;
}
export async function computeClosure(ctx: Context, request: ClosureRequest): Promise<ClosureResult>;
```

`path` is **optional from this part** (S-13) even though the walk always fills it under
`objects` — the field's type must not change in Part 12.

**The walk tier is git's walk, not the exact set difference.** It marks the `not` tips
uninteresting along with their trees, **recursing through those trees to mark their
contents**, then walks the interesting commits and emits every object it reaches that
carries no mark. It therefore emits a **superset** of the exact difference: an object
reachable from an *ancestor* of a `not` tip but absent from that tip's own trees is never
marked, so it is emitted again. The recursion through the marked trees is **not optional**
and the measurements say so — marking only the root tree *object* would re-emit that tip's
entire tree, which is far more than the six extra objects git actually reports.

**Computing the exact difference here would be the divergence, not the fix.** S-12 governs
what this part may assert about it, and names the escalation if Part 11 disagrees with real
git.

**Building blocks that already exist — reuse, do not re-derive:**

- `walkCommits` (`src/application/primitives/walk-commits.ts`, 6.1 KB) —
  `{ from, until, order: 'topo' | 'first-parent', ignoreMissing, shallow, verifyHash }`.
- `walkTree` (`walk-tree.ts:33-50`) — `AsyncIterable<WalkTreeEntry>` of
  `{ path: FilePath, id, mode }`, `recursive` defaulting to `true`, with cycle, depth and
  entry-count guards already in place. **This is where `path` comes from.**
- `internal/object-emit.ts` — `EmitState { emitted: Set<ObjectId>, cap: number }`,
  `tryEmit(state, id)` (throws `PACK_TOO_LARGE` **before** inserting, so the Set's
  invariant survives the failure path), `resolveTagChain(ctx, id, recordTag)` (follows
  tag → tag → commit, capped at 16, yielding each tag oid).
- `MAX_PUSH_OBJECTS = 1_000_000` (`primitives/types.ts:169`) — the cap to reuse, not
  reinvent.
- `isGitlink(entry.mode)` (`validators.ts`) — gitlinks are never emitted.
- `enumerate-bundle-objects.ts:77-134` shows the marked-tree recursion and the shared
  `seenTrees` pruning (`O(commits × shared-subtrees)` → `O(unique-trees)`), and
  `enumerate-push-objects.ts:56-75` shows the interesting-side walk. **Read both, then
  write the engine's own** — §D9 forbids refactoring either onto the engine, because for
  push it would provably shrink the pushed pack and for bundle a closure cannot supply the
  `boundary` set. What the engine **may** share verbatim is `object-emit.ts`'s helpers and
  the `MAX_TREE_DEPTH` bound.

**Edges, each with its rule** (§D6):

- **Wants are peeled before anything else.** `resolveTagChain` peels an annotated tag; the
  tag oids join the result and the peeled commit is what the walk seeds from.
- **A want that resolves to a tree or a blob** has no parents: it contributes itself, plus
  its own subtree under `objects`, and nothing else.
- **Empty `wants`** yields an empty result — not an error, and not "everything".
- **`wants` fully covered by `not`** yields an empty result.
- **A revision that does not resolve refuses**, on either side. Revision resolution is a
  caller error and is **never** a degradation arm.
- **An unborn `HEAD` / empty repository** supplies no tips ⇒ empty result.

**New file 2:** `src/application/commands/rev-list.ts` (§D7, the core only in this part):

```ts
export interface RevListOptions {
  readonly wants?: ReadonlyArray<string>;
  readonly not?: ReadonlyArray<string>;
  readonly objects?: boolean;
  readonly count?: boolean;
}
export interface RevListEntry {
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  readonly path?: FilePath;
}
export interface RevListResult {
  readonly entries: ReadonlyArray<RevListEntry>;
  /** `entries.length`. With `objects` it counts objects; without it, commits and tags. */
  readonly count: number;
}
export const revList = async (ctx: Context, opts?: RevListOptions): Promise<RevListResult>;
```

`count: true` does not change *what* is computed, only what the caller reads — `entries` is
populated either way and there is no separate count-only fast path. Revisions resolve
through `resolveCommit` / `revParse` (`src/application/commands/internal/resolve-rev.ts`);
`assertOperationalRepository` (`internal/repo-state.ts`) opens the command, as `log.ts:51`
does.

**No `--pretty`, `--format`, `--date`, `--abbrev`, `--header`, `-z`, `--object-names`** —
every one is presentation and barred independently of ADR-613.

**Ordering** is deterministic and is **not** git's, because git's own two paths order
differently; the doc-comment says it is unspecified, and every equality test asserts a
**set**.

**The full Tier-1 surface tax, pre-paid in this part** (`.claude/workflow/surface-gates.md`):

1. **Barrel** — `src/application/commands/index.ts`, a new
   `export { type RevListEntry, type RevListOptions, type RevListResult, revList } from './rev-list.js';`
   between `./reset.js` (`:268`) and `./rev-parse.js` (`:269`). Within-statement order is
   Biome-enforced (types first, then the value); run `npx biome check --write` on the file.
2. **Facade** — `src/repository.ts` (753 lines): the interface line
   `readonly revList: BindCtx<typeof commands.revList>;` between `revert` (`:237`) and
   `revParse` (`:238`) — **exactly two leading spaces**, because
   `tooling/check-doc-coverage.ts` and `tooling/audit-browser-surface.ts` regex-parse
   `/^ {2}readonly (\w+):\s*BindCtx</gm`; and the guarded binding between `revert` (`:615`)
   and `revParse` (`:616`):
   ```ts
       revList: ((opts) => {
         guard();
         return commands.revList(ctx, opts);
       }) as Repository['revList'],
   ```
3. **Surface snapshot** — `test/unit/repository/repository.test.ts`, the array at
   `:238-286` (47 entries today) gains `'revList'`; both sides are `.sort()`ed but keep the
   literal alphabetical.
4. **Doc page** — `docs/use/commands/rev-list.md`, following the six-section shape pinned at
   `docs/use/commands/README.md:51-61`: `## Signature` (a ts fence with the `repo.revList`
   line plus the option/entry/result interfaces) → `## Options`
   (`| Field | Type | Default | Meaning |`, `(none)` shown explicitly) → `## Behaviour`
   (the walk's superset behaviour with haves, stated plainly, and that ordering is
   unspecified) → `## Examples` (2–4 minimal snippets) → `## Throws` → `## See also`.
   Model: `docs/use/commands/init.md` (45 lines) or `rev-parse.md` (44 lines).
5. **Index row** — `docs/use/commands/README.md`, `` | [`revList`](rev-list.md) | … | ``
   between the `revParse` row (`:38`) and the `revert` row (`:39`); the checker asserts the
   **literal substring** `` [`revList`](rev-list.md) `` anywhere in the file. Bump `43
   entries` → `44` at `:3`.
6. **Parity scenario** — `test/parity/scenarios/rev-list.scenario.ts` (model:
   `show.scenario.ts`, reproduced in full in the exploration notes), calling
   **`repo.revList(…)`** with the receiver literally named `repo`; register it in
   `test/parity/scenarios/index.ts` (named import + an entry appended to `SCENARIOS`).
   Golden values come from `test/parity/fixtures.ts`'s fixed `AUTHOR`; nondeterminism is a
   `check:parity-fixtures` failure. **No `unsupportedRuntimes` is expected here** — a walk
   closure over a seeded repo runs everywhere.
7. **README count** — `README.md:47`, `43 Tier-1 commands` → `44` (the file's only
   occurrence).
8. **api.json** — `npm run docs:json`, commit `reports/api.json` in this commit. The count
   bump alone makes it stale (`README.md` is a `docs:json` input).

**Mutation traps** (`application`, break 95): the mark-then-emit predicate and the
`objects` gate are the two live conditionals; the `count`/`entries` relation is a trivial
mutant unless a row asserts both on the same call.

### TDD steps

1. **RED** — `test/unit/application/primitives/internal/closure-engine.test.ts`
   (`const sut = computeClosure;`, `buildSeededContext` from
   `test/unit/application/primitives/fixtures.ts`).

   | group | rows | Then |
   |---|---|---|
   | commits only | a 3-commit chain, `objects: false` | the three commit ids, no trees or blobs |
   | objects | the same chain, `objects: true` | commits + trees + blobs, each with the right `type`, each tree/blob carrying a `path` |
   | tags | a want that is an annotated tag; a tag-of-tag chain | the tag oids **and** the peeled commit's closure |
   | non-commit wants — **own `it` each** | a want that is a tree; a want that is a blob | itself plus its subtree under `objects`; itself alone without |
   | gitlinks | a tree with a gitlink entry | the gitlink oid is **not** emitted |
   | empty — **own `it` each** | `wants: []`; `wants` fully covered by `not`; an unborn `HEAD` | `entries` empty, no throw |
   | haves — the **relation**, never a count | a fixture repeating blob content across the have boundary | the result is a **superset** of the independently computed exact difference, and **every** object in the difference is reachable from a `not` tip (asserted by a second closure from the `not` tip, not by inspection) |
   | haves — non-triviality | the same fixture | the difference set is asserted **non-empty**, which is what turns a vacuous superset check into a real one |
   | refusal | a want that does not resolve; a `not` that does not resolve — **own `it` each** | the refusal's `data.code`, asserted via `try`/`catch` |
   | cap | `MAX_PUSH_OBJECTS` lowered via the request or the fixture | `PACK_TOO_LARGE` with `objectCount` and `limit` |
   | dedupe | a blob referenced from two commits | emitted once |

2. **RED** — `test/unit/application/commands/rev-list.test.ts`: the option surface
   (`wants` defaulting to `HEAD`, `not`, `objects`, `count`), `count === entries.length`
   asserted on the same call, `count` moving with `objects`, revision grammar
   (`HEAD~2`, an oid prefix, a tag name) resolving through `revParse`, and a
   not-a-repository refusal.

3. **RED** — `test/unit/repository/repository.test.ts`'s snapshot row (add `'revList'`);
   expected failure is the array-equality diff.

4. **GREEN** — land the engine, the command, the barrel, the facade, the page, the index
   row, the scenario, the README count.

5. **REFACTOR** — confirm both new files are under 400 lines and every function under 20;
   confirm nothing in `enumerate-push-objects.ts` / `enumerate-bundle-objects.ts` changed;
   run `npm run check:doc-coverage`, `npm run check:browser-surface`,
   `npm run check:parity-fixtures`, `npm run check:architecture`,
   `npm run check:duplicates`; `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/primitives/internal/closure-engine.test.ts test/unit/application/commands/rev-list.test.ts test/unit/repository/repository.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/closure-engine.ts src/application/commands/rev-list.ts src/application/commands/index.ts src/repository.ts test/unit/application/primitives/internal/closure-engine.test.ts test/unit/application/commands/rev-list.test.ts test/unit/repository/repository.test.ts test/parity/scenarios/rev-list.scenario.ts test/parity/scenarios/index.ts
```

Plus `npm run check:doc-coverage`, `npm run check:browser-surface`,
`npm run check:parity-fixtures`, `npm run test:parity`, `npm run check:architecture`, and
`npm run docs:json` with `reports/api.json` staged in the same commit.

### Commit

`feat(commands): add rev-list over a shared closure engine`

## Part 10 — `rev-list`'s walk-shaping options

### Context

**Goal.** ADR-613's option set completed: `all`, `maxCount`, `firstParent`, `noWalk`. Each
shapes the **walk**; none is presentation; each is git's default answer, because under
ADR-618 `rev-list`'s default tier is the walk (Pin AJ1). No tier control exists yet, so
this part has no bitmap interaction to reason about — which is precisely why it is its own
part.

**Files to change:** `src/application/commands/rev-list.ts` (the options and their
plumbing), `src/application/primitives/internal/closure-engine.ts` (the request fields the
walk honours), `docs/use/commands/rev-list.md`, `test/unit/application/commands/rev-list.test.ts`.

**Options and their exact semantics:**

| option | semantics | building block |
|---|---|---|
| `all?: boolean` | tips from **every** ref — branches, tags, remotes, `HEAD` — unioned with explicit `wants`, exactly as `git rev-list --all <rev>` composes | `enumerateRefs(ctx)` (`primitives/enumerate-refs.ts:16`) returns every `RefName` including `HEAD`, deduplicated across the worktree's own `refs/` and the common dir's; resolve each through the same peel path as a `want`, and **skip a ref that does not peel to an object** rather than refusing (a symbolic `HEAD` on an unborn branch is the live case) |
| `maxCount?: number` | at most N **commits** emitted (under `objects`, N commits and everything they reach) | applied to the commit walk, not to the object stream. **`maxCount: 0` yields an empty result**, not an unbounded one — own row |
| `firstParent?: boolean` | follow only the first parent | `walkCommits(ctx, { …, order: 'first-parent' })` — the order already exists (`walk-commits.ts:26`, `type Order = 'topo' \| 'first-parent'`) |
| `noWalk?: boolean` | emit the resolved tips themselves and stop — no parent traversal (under `objects`, each tip's own trees still count) | a walk with no parent enqueue |

**Interactions to pin, each its own row:** `all` + explicit `wants` (union, no duplicates);
`maxCount` + `firstParent`; `noWalk` + `objects`; `maxCount` + `not`.

**`count` still equals `entries.length`** under every combination.

**Documentation.** `docs/use/commands/rev-list.md`'s `## Options` table gains four rows with
their defaults; `## Behaviour` gains a sentence per option. The page's tier paragraph
arrives in Part 12.

**Surface gates:** the four new option fields are public — `npm run docs:json` +
`reports/api.json` committed here. No count moves, no page is added.

**Mutation traps**: `maxCount` is a boundary (`>=` vs `>`), so rows at `N−1`, `N` and `N+1`
commits are three rows, not one; `maxCount: 0` is its own row; `noWalk` and `firstParent`
each need a fixture where the option **changes** the answer (a merge commit for
`firstParent`, a multi-commit chain for `noWalk`) — a linear fixture makes both mutants
equivalent and the tests vacuous.

### TDD steps

1. **RED** — `test/unit/application/commands/rev-list.test.ts`:

   | group | rows | Then |
   |---|---|---|
   | `all` — **own `it` each** | two branches + a lightweight tag + an annotated tag; `all` with explicit `wants` (union, deduplicated); `all` on an unborn `HEAD` | the tip set, and no duplicate ids |
   | `maxCount` — **own `it` each** | `N−1`, `N`, `N+1` on an N-commit chain; `0`; with `objects` | `entries.length` and `count` |
   | `firstParent` — **own `it` each** | a fixture with a **real merge**, with and without the option; the same with `objects` | the commit set differs; the object set differs |
   | `noWalk` — **own `it` each** | a 5-commit chain with and without; with `objects`; with two tips | only the tips (and their own trees under `objects`) |
   | combinations | `maxCount` + `firstParent`; `noWalk` + `objects`; `maxCount` + `not` | the expected sets |

2. **GREEN** — the option plumbing in the command and the engine.

3. **REFACTOR** — confirm `rev-list.ts` is still under 400 lines and every function under
   20 (extract an options-normalising helper if the command body grows past it); confirm no
   option leaked into the engine that the engine does not honour; `npm run docs:json` and
   stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/commands/rev-list.test.ts test/unit/application/primitives/internal/closure-engine.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/rev-list.ts src/application/primitives/internal/closure-engine.ts test/unit/application/commands/rev-list.test.ts test/unit/application/primitives/internal/closure-engine.test.ts
```

Plus `npm run docs:json` with `reports/api.json` staged in the same commit.

### Commit

`feat(rev-list): add the walk-shaping options`

## Part 11 — cross-tool interop: the walk closure against real git

### Context

**Goal.** Pin the walk tier — which ADR-615 makes the **oracle** for everything Parts 12–14
build — against real `git rev-list`. Test-infra only: **no `src/` delta.**

This part exists *here*, before the bitmap tier, for one reason: an unpinned oracle is not
an oracle. It is also where S-12's deferred question is answered — if the walk tier's counts
disagree with git's, the defect is in Part 9's marking rule and the escalation names its
three candidates.

**New file 1:** `test/integration/rev-bitmap-closure-fixtures.ts` — the closure fixtures,
built once each in a `beforeAll(fn, 60_000)`:

- **F2** — 400 commits, built by `git fast-import` for speed, one branch, one annotated
  tag, `git repack -adq --write-bitmap-index`; **1606** objects, **108** bitmap entries.
  **Each commit writes a unique file *and* rewrites a shared file with one of five
  recurring contents, so blob content repeats across any have boundary.** This property is
  load-bearing and is the whole reason the fixture is built this way.
- **F4** — 76 commits including one **real merge**, `git repack -adq --write-bitmap-index`.
- **F5** — a history that repeats blob content across the have boundary,
  `git repack -adq --write-bitmap-index`; **367** objects reachable from `HEAD`, small
  enough to enumerate by hand.

**Any closure fixture used for have-bearing queries must repeat blob content across the
have boundary**, or the disagreement the whole tier story exists to resolve goes unmeasured
and the superset invariant degenerates into an equality that passes for the wrong reason.
A linear fixture shows **no** disagreement — that is measured, not hypothetical.

**New file 2:** `test/integration/rev-bitmap-closure-interop.test.ts`. Header block:

```
 * @proves
 *   surface:        revList
 *   bucket:         cross-tool-interop
 *   unique:         rev-list closures match canonical git on both tiers
 *   interopSurface: closure
```

**Helpers to write here (Part 15 extends them, so shape them for two callers):**

- `gitObjectSet(dir, ...args)` → parse `git rev-list --objects …` stdout into
  `{ ids: Set<string>, named: number }` — `named` is the count of lines carrying a name,
  which is the *tier detector* (a bitmap answer carries none);
- `tsgitObjectSet(result)` → `{ ids: Set<string>, named: number }` from a `RevListResult`,
  counting entries whose `path` is present;
- `assertSameSet(a, b)` — set equality on **ids only**, with a readable diff.

**Rows in this part (walk tier only, `revList` with no tier option):**

| obligation | rows |
|---|---|
| set equality, no haves | F2 `--objects HEAD` (1605); F2 `--objects --all` (1606); F5 `--objects HEAD` (367) |
| commits only, no haves | F2 `HEAD` (400) |
| `count` moves with `objects` | F2: 1605 with, 400 without |
| **have-bearing, against plain `git rev-list`** | F2 `HEAD --not HEAD~50` (**204**); F5 (**156**); F4 `HEAD --not topic` (122) |
| the difference is real | on F2 and F5, `walkSet \ exactDifference` is asserted **non-empty**, and every member is asserted reachable from the `not` tip by an independent `git rev-list --objects <not-tip>` |
| **`path` presence** | F5 walk tier: the count of path-carrying entries equals git's name-carrying line count (**127**) |
| option composition, all against git's **default** (which is the walk) | `--max-count`; `--first-parent` on F4 (183 objects / 61 commits); `--no-walk` on F4 (7 objects / 2 commits); `--all` |
| loose objects | F2 plus a loose commit on top (3 loose objects): 1608, matching git |

**`--first-parent` and `--no-walk` must be measured on F4**, the merge fixture: on a linear
fixture `--first-parent` looks correct whatever the implementation does.

**Order is never asserted** — neither against git nor across runs. Every comparison is a
**set** comparison on ids (and, where stated, a count of path-carrying entries).

**Traps:** one shared `beforeAll` per fixture with a 60 s timeout; a fresh `Context` after
every `git` subprocess; F2 is built by `git fast-import` because 400 real commits are too
slow — write the stream to a temp file and pipe it, and keep the author/committer dates
fixed so the fixture is reproducible.

### TDD steps

1. **RED** — the fixture builders and the three helpers, plus the **control rows** (F2
   `--objects --all` set equality, and the `named` detector returning 805 for git's walk on
   F2). Getting the fixture and the parser right before any comparison row is the point.
2. **RED** — the no-haves rows, then the have-bearing rows, then the option-composition
   rows, then the loose-object row.
3. **GREEN** — no `src/` change is expected. **If a have-bearing count disagrees, the
   defect is Part 9's marking rule.** Escalate as
   `{ part: 9, reason, options: [tips-only, boundary-commits, full-have-closure] }` and fix
   in `closure-engine.ts` with the corresponding unit rows updated in the same commit —
   never adjust the interop expectation to match the implementation.
4. **REFACTOR** — confirm every row disposes its `Context`; confirm no row asserts order;
   confirm the suite's runtime and that `check:test-pyramid`'s integration budget still
   holds.

### Gate

```
npx vitest run test/integration/rev-bitmap-closure-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/rev-bitmap-closure-interop.test.ts test/integration/rev-bitmap-closure-fixtures.ts
```

Plus `npm run check:test-pyramid` and `npm run check:write-surfaces` (exit **0**).

### Commit

`test(rev-list): pin the walk closure against real git`

## Part 12 — the pack-bitmap closure tier and `rev-list`'s tier control

### Context

**Goal.** §D3's consumption paragraphs + §D4's pack-bitmap mapping + §D6's bitmap algorithm
+ ADR-615 (as narrowed by **ADR-622**)/616/618/619/620/621 + Pin AK + requirements 16, 17,
18, 20: the engine gains a `tier` input it holds no default for, a pack bitmap answers
`W AND NOT N` **with every position it decodes range-validated first**, and `rev-list` grows
the one option that selects between git's two disagreeing answers.

**New file:** `src/application/primitives/internal/bitmap-binding.ts` — the application-layer
binding between a parsed `PackBitmap` and a pack's objects. Model:
`internal/midx-binding.ts` (376 lines), including its **type-only import** of the registry
(`midx-binding.ts:21-24`) that keeps the `no-circular` depcruise rule happy and structurally
forbids reaching a runtime value out of the registry it is bound into.

**Position mapping (§D4) — get this right or nothing else matters:**

- **A bit is a pack position.** `oid = allObjectIds(index)[ revIndexPositionAt(rev, p) ]`
  when a `.rev` is usable, else `oid = allObjectIds(index)[ packPositionMap(index)[p] ]`
  (S-11, computed in O(n log n) when the file is absent). **A bitmap without a `.rev` is
  fully usable** — git builds the reverse index in memory, and the measurement confirms the
  answer is identical.
- **An entry header's `position` is an *index* position**, not a pack position. Finding
  "the entry for commit `c`" is `lookupPackIndex(index, c)` then a lookup in a prebuilt
  `Map<indexPosition, entryIndex>` over `bitmapEntryHeaders(bitmap)`.

`allObjectIds` is **not** barrel-exported; import it from
`src/domain/storage/pack-index.js` directly, exactly as
`src/application/primitives/enumerate-objects.ts:2` already does.

**Range validation, before any oid is resolved (ADR-622, Pin AK). This is a faithfulness
requirement, not optional hardening, and it is measured.** On a fixture whose bitmap
**checksum is valid** but whose first per-commit entry header names position `999999`, git
prints `error: corrupt ewah bitmap: commit index 999999 out of range`, **declines the whole
artefact** and answers from the walk: `fsck` **0**, `rev-list --use-bitmap-index` **0** with
the walk's answer, `--test-bitmap` **128**, `pack-objects` **0** with the walk's answer. The
binding therefore:

1. **range-validates every position it decodes from the artefact** against the object count
   of the pack it indexes — per-commit **entry headers** (`bitmapEntryHeaders`) *and* every
   **set bit** a reconstructed stream yields, both required `< objectCount`. Both spaces,
   not just the headers: a bit is as much a decoded position as a header is, and checking
   only the headers leaves the far wider space unchecked. Positions at or above
   `objectCount` in the engine's own bit space are the **extended** positions (Pin AH) — the
   engine appends those itself, they are never decoded from the artefact, and they are
   bounded by the allocation rather than by this check;
2. **declines the whole artefact** on the first violation, never just the offending entry —
   git loses the bitmap entirely, and a per-entry skip would answer from a half-artefact git
   never uses;
3. **reports the fault through `ctx.logger?.warn?.` with the artefact name.** This is the
   **opposite** of the absent / unreadable rows, where git is silent and tsgit matches that
   silence: here git prints an `error:` line, so tsgit is **not** silent either;
4. **falls back to the walk**, whose answer is returned with **no failure surfaced to the
   caller** — a correct result and no error, exactly as git exits 0;
5. runs **before any oid is resolved**. That ordering is the whole point of the rule — it is
   what makes "silently wrong pack" unreachable — so a test must pin the **ordering**, not
   merely the outcome: instrument the oid-resolution path (`allObjectIds` / `packPositions()`
   reads through an instrumented `Context`) and assert it was **never entered** for a
   declining artefact. A row that only asserts "the walk answered" passes even when
   validation runs after resolution, so it does not discharge this obligation.

**The `fsck` bitmap pass is unchanged by all of this** (ADR-605, Part 7): it still hashes and
never parses, so this same fixture yields `fsck` exit **0** while the consumption path
declines. **One test asserts both halves on the same fixture** — `runBitmapHealthPass` finds
nothing and the binding declines, in one `it` over one set of bytes. It is the sharpest
available proof that ADR-605's separation holds, and Part 15 carries its cross-tool twin
(Pin AK rows AK0–AK4).

**`RegisteredPack.bitmapBytes()` already exists** — Part 7 landed it (and its bound) for
the `fsck` pass, which only hashes. This part is the first caller to **parse** those bytes,
and that asymmetry is deliberate: the two paths share the loader and share nothing else.

**`RegisteredPack` gains** `packPositions(): Promise<ReadonlyArray<number>>` — a
`createPromiseMemo` returning the `.rev` body when usable and `packPositionMap(index)`
otherwise. **This is a second memo, distinct from `buildOffsetTable`'s** (which keeps its
plain-sort fallback verbatim, ADR-604); both call the same loader, so the `.rev` is read at
most once per pack per generation and classified once.

**XOR-chain reconstruction** (Pin AD): `resolved[i] = stored[i]` when `xorOffset === 0`,
else `stored[i] XOR resolved[i − xorOffset]`. Chains are **long and shallow-stepped** — on
a 400-commit fixture 104 of 108 entries have `xorOffset === 1`, so resolving the last entry
touches ~104 predecessors. **Reconstruction must be iterative**: walk the `xorOffset` links
backwards until an entry with `xorOffset === 0` or a cached reconstruction is reached, then
fold forward with `foldEwahStream(…, 'xor')` into a single reused `Uint32Array`. Recursion
is not an option.

**Caching** is a **bounded LRU** of reconstructed sets, sized by a named constant with its
arithmetic in the doc-comment, and **per closure call, not per `Context`**: a reconstructed
set is `ceil(bitCount / 32)` words and caching every entry of a large repository's bitmap is
`entryCount × objectCount / 8` bytes — the one place in this design where an
innocent-looking memo is a memory bomb. `src/domain/storage/lru-cache.ts` already exports
`createLruCache`.

**The bitmap algorithm** (§D6, pinned precisely enough to implement):

```
fill(tips) -> bit set B over [0, objectCount + extendedCount):
  pending = []
  for t in tips:
    e = entryFor(t)
    if e: B |= reconstruct(e)
    else: pending.push(t)
  if pending is non-empty:
    walk commits from pending:
      on a commit that HAS an entry:  B |= reconstruct(entry); do NOT traverse its parents
      otherwise:                      set the commit's bit; if `objects`, walk its tree and
                                      set a bit for every non-gitlink entry
  return B

closure(request):
  W = fill(request.wants);  N = fill(request.not)
  result bits = W AND NOT N
  for each set bit p: oid = the mapping above
                      type = the owning type stream, or the object header for an
                             extended position
                      path is NOT produced — the artefact has none
```

**Artefact selection is not conditional on the wants having entries.** Coverage is partial
by design (108 entries for 400 commits; a 30-commit repository gets full coverage), and git
uses a bitmap for wants it has never heard of. A design that assumes "the want has an entry"
is wrong on any real repository.

**Types come free from the four streams** (Pin AE): they are a total partition — on the
400-commit fixture the set bits sum to exactly the object count, and the stream owning a
position predicts its type correctly for every object. Type is free; **path is not
available at any price**.

**Extended positions** (Pin AH): objects the partial walk reaches that have no position in
the artefact — objects in other packs, and loose objects — are appended after `objectCount`
in the engine's own bit space, with a side table `extendedOids: ObjectId[]`, and their type
comes from the object header. The bit space grows in whole words; the cap is
`MAX_PUSH_OBJECTS`, reused. **A bitmap never truncates an answer.**

**Degradation** (§D13, ADR-616 as amended, ADR-621, ADR-622): every fault falls through
**silently** to the next tier — absent, unreadable, refused (bad magic, bad version, a
missing full-DAG flag, an overrunning stream) — **and an out-of-range position joins that
list, declining the artefact rather than the entry**. A **fault** in a present bitmap still
reaches `ctx.logger?.warn?.` with the artefact name; silence about the **strategy** is total.
Falling all the way through to the walk is result-preserving when `not` is empty and yields
the walk's superset otherwise — which is exactly what git returns when it cannot load a
bitmap. **Do not add strictness the parser does not already have** (ADR-621): declines are
no longer free, and an oversized declared bit size in particular must be tolerated, not
refused. Range validation is **not** added strictness — git declines there too (Pin AK), so
it is "declining where git declines", and it is the ADR-611 bounds gate rather than the
ADR-615 trust one.

**No pre-use digest verification** exists on this path and none may be added (ADR-615).
Threat row T-7 is **accepted, not mitigated**; under ADR-615's refinement the controls are
now two and ordered — ADR-622's range validation catches a decoder or artefact fault
**before any oid is resolved**, and the interop suite's tier invariant is the second line.
Trimming either is a security regression.

**Engine change** (S-13): `ClosureRequest` gains `readonly tier: ClosureTier` where
`export type ClosureTier = 'bitmap' | 'walk'` — a **required** input with no engine-side
default. `ClosureResult` gains `readonly tier: ClosureTier`, the tier that actually
answered (a `'bitmap'` request still answers `'walk'` after a silent fallback) — **internal,
neither command surfaces it**, because artefact choice selects between two computations of
the same answer.

**Command change** (§D7): `RevListOptions` gains

```ts
  /** Ask for the bitmap tier. **Defaults to `false`** — git's `rev-list` walks
   *  unless asked. The bitmap tier returns the exact set difference and **no
   *  `path`**; a caller that needs paths must leave this off. It also changes
   *  what `firstParent` and `noWalk` mean: the bitmap tier does not traverse,
   *  so it ignores them and returns the full closure, exactly as git does.
   *  `maxCount` still walks, because git itself abandons the bitmap for it. */
  readonly useBitmapIndex?: boolean;
```

`rev-list` passes `tier: useBitmapIndex === true ? 'bitmap' : 'walk'` and **nothing else
decides**. `maxCount` forces `'walk'` — that decline is reproduction, not policy (git
itself abandons the bitmap for it). `firstParent` and `noWalk` are **ignored** on the
bitmap tier and the option's doc-comment says so (ADR-620): the repair would be a silent
divergence, which the prime directive treats as worse than a documented surprise.

**Parity scenario.** A closure scenario that builds a small pack **and a bitmap** in memory
proves node / memory / browser agreement. tsgit cannot write a bitmap, so the scenario must
plant hand-crafted bytes — reuse the `buildBitmap` / `encodeEwah` writers from
`test/unit/domain/storage/arbitraries.ts` (import across test trees is fine) or inline a
minimal equivalent. **If the scenario cannot run on a given runtime, declare
`unsupportedRuntimes` and land the consequence in all six drivers** (S-20) — five
dist-bundle drivers plus `test/browser/parity.spec.ts`; none of the dist drivers is in the
`validate` chain, so a missed one is a CI-only red. `midx-read.scenario.ts:228` is the live
four-runtime example.

**Surface gates:** `useBitmapIndex` is public — `npm run docs:json` +
`reports/api.json` committed here. `docs/use/commands/rev-list.md` gains the tier
paragraph: which tier is the default, that the bitmap tier cannot populate `path` **and
why**, and that `firstParent`/`noWalk` have no effect on it. That paragraph is an ADR
obligation, not a nicety.

**Mutation traps** (`application`, break 95): the `W AND NOT N` word loop, the
`xorOffset === 0` chain terminator, the extended-position append, and the tier ternary in
the command. Each needs a row whose *answer* changes, not merely its path. The range check
is a **boundary** (`position < objectCount`), so `objectCount − 1` (accepted) and
`objectCount` (declines) are two rows, not one — and because the two spaces are validated
separately, an entry-header row does not kill the set-bit mutant or the reverse.

### TDD steps

1. **RED** — `test/unit/application/primitives/internal/bitmap-binding.test.ts`:

   | group | rows | Then |
   |---|---|---|
   | reconstruction | a hand-built chain `A(xor 0) ← B(xor 1) ← C(xor 1)`; **a chain longer than 64 links** | the intended sets, and the long chain proves the walk is iterative (no stack growth) |
   | reconstruction caching | the same entry reconstructed twice | equal sets, one fold pass the second time |
   | header interpretation | a pack bitmap whose entry header must resolve through the `.idx` | the named commit — and a row asserting the **wrong** reading (treating it as a pack position) would name a different object |
   | mapping — **own `it` each** | `.rev` usable; `.rev` absent (map computed); `.rev` refused | identical oid sets across all three |
   | types | every set bit's type against the owning stream | correct for every position |
   | extended positions | a want reachable only through a **loose** object | the object is emitted with the right type |
   | degradation — **own `it` each** | bitmap absent; unreadable; bad magic; version 2; flag word without full-DAG; an overrunning stream | the binding declines; a warn is emitted for the **refused** cases and **not** for absent/unreadable |
   | range validation — **own `it` each** | an entry header at `objectCount − 1`; an entry header at `objectCount`; an entry header at `999999`; a **set bit** at `objectCount − 1`; a **set bit** at `objectCount` | accepted / declines / declines / accepted / declines — the two accepted rows are what prove the boundary is not off by one, and the set-bit pair is not killed by the entry-header pair |
   | the decline is whole-artefact — **own `it`** | a two-entry bitmap whose **second** entry is out of range, the first healthy and covering the want | the binding declines **entirely**; the healthy entry is **not** used, and the answer is the walk's |
   | the fault is reported — **own `it`** | the out-of-range fixture | `ctx.logger.warn` called **once** with the artefact name (git prints an `error:` line here, so silence would be the divergence) |
   | the caller sees no failure — **own `it`** | the same fixture, through the engine | the walk's correct answer is returned and **nothing throws** |
   | **ordering: validation precedes resolution** — **own `it`** | the same fixture under an instrumented `Context` | the oid-resolution path (`allObjectIds` / `packPositions()`) was **never entered**; asserting only "the walk answered" does **not** discharge this row, and the title says so |
   | `fsck` and consumption disagree, correctly — **own `it`** | **one** fixture: a bitmap with an out-of-range entry header whose trailer is **restamped** | `runBitmapHealthPass` returns **no finding and `exitBit` 0**, and the binding **declines** — both asserted in the same `it`, which is the sharpest proof ADR-605's separation holds. The pass is imported **by the test only** (`depcruise` runs over `src/` alone, so S-14's rule is untouched — but the import must never migrate into `bitmap-binding.ts`) |

2. **RED** — `test/unit/application/primitives/internal/closure-engine.test.ts`:
   **the engine holds no tier default** — the same request answered with `tier: 'walk'` and
   `tier: 'bitmap'` returns the walk's and the bitmap's answers respectively, and neither
   command's default leaks into the engine; with **no** `not` the two tiers return exactly
   the same set; with `not` non-empty the walk is a superset and every extra is reachable
   from a `not` tip; a `'bitmap'` request over a repository with no bitmap answers
   `tier: 'walk'` and returns the walk's answer; every comparison is on **id and type only,
   never `path`**.

3. **RED** — `test/unit/application/commands/rev-list.test.ts`: `useBitmapIndex` defaults
   to `false`; with it set on a bitmap-bearing fixture, entries carry **no** `path`;
   `maxCount` + `useBitmapIndex` still walks (and the entries carry paths, which is the
   observable); `firstParent` + `useBitmapIndex` returns the **full** closure;
   `noWalk` + `useBitmapIndex` likewise. **Each its own `it`**, each with a title saying it
   reproduces git.

4. **RED** — the parity scenario and its registration.

5. **GREEN** — land `bitmap-binding.ts`, the registry's `packPositions` memo, the engine's
   `tier` input and bitmap tier, the command option, the doc paragraph, the scenario.

6. **REFACTOR** — confirm `bitmap-binding.ts` is under 400 lines (split the reconstruction
   cache out if not); confirm the LRU is per call; confirm the type-only registry import;
   confirm no digest verification crept in; **re-read the decline path and confirm every
   range check precedes every oid resolution in program order, not merely in test outcome,
   and that a violation declines the artefact rather than skipping an entry**; run
   `npm run check:architecture`,
   `npm run check:browser-surface`, `npm run check:parity-fixtures`, `npm run test:parity`;
   `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/primitives/internal/bitmap-binding.test.ts test/unit/application/primitives/internal/closure-engine.test.ts test/unit/application/commands/rev-list.test.ts test/unit/application/primitives/pack-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/bitmap-binding.ts src/application/primitives/internal/closure-engine.ts src/application/primitives/pack-registry.ts src/application/commands/rev-list.ts test/unit/application/primitives/internal/bitmap-binding.test.ts test/unit/application/primitives/internal/closure-engine.test.ts test/unit/application/commands/rev-list.test.ts test/parity/scenarios/index.ts
```

Plus `npm run check:architecture`, `npm run check:browser-surface`,
`npm run check:parity-fixtures`, `npm run test:parity`, and `npm run docs:json` with
`reports/api.json` staged in the same commit.

### Commit

`feat(rev-list): serve the closure from a pack bitmap on request`

## Part 13 — midx-bitmap preference and pseudo-pack position mapping

### Context

**Goal.** ADR-617 + ADR-612 + §D4's midx paragraph + Pin AG + requirement 19: consume the
multi-pack-index's own bitmap, mapping its bits through the reverse-index chunk Part 1 made
readable, and prefer it over a pack bitmap exactly as git does.

**Files to change:** `src/application/primitives/internal/bitmap-binding.ts` (a second
binding flavour), `src/application/primitives/pack-registry.ts` (the generation-level midx
bitmap memo already added in Part 7 is reused — this part *parses* what Part 7 only
hashed), `src/application/primitives/internal/closure-engine.ts` (the preference order).

**The mapping — this is the single most likely implementation bug in the entry:**

- **A midx bitmap's bits are pseudo-pack positions.**
  `oid = midxOidAt(midx, midxReverseIndexAt(midx, p))`. The chunk's semantics:
  `chunk[p]` is the **midx position** of the object at **pseudo-pack position `p`**, and
  the sequence is strictly increasing in `(packIndex, offset)`.
- **A midx bitmap's entry headers are midx positions**, so `midxOidAt(midx, header.position)`
  names the commit **directly — no reverse-index hop**. Measured: 108 of 108 entries match
  under the midx reading and **0 of 108** under the other. That 108/0 split is the
  assertion that catches the bug, and it must be written as such.

**Range validation applies to the pseudo-pack, with the same force (ADR-622, Pin AK).** Both
position spaces this part decodes are validated **against `MultiPackIndex.objectCount`, the
pseudo-pack's own count**, before `midxOidAt` / `midxReverseIndexAt` is called on either:
the **entry headers**, which are midx positions, and every **set bit**, which is a
pseudo-pack position. Same rule, same consequences as Part 12 — the **whole artefact** is
declined on the first violation, never the offending entry; the fault reaches
`ctx.logger?.warn?.` with the **midx bitmap's** artefact name (git prints an `error:` line
here, so tsgit is not silent); the answer comes from the next artefact in the preference
order below with **no failure surfaced to the caller**; and the check runs **before any oid
is resolved**, pinned by an ordering row and not merely by an outcome row. A midx bitmap
declined this way therefore lets the **pack** bitmap answer — a decline by artefact, which
is what the preference order already does, so no new machinery is owed, only the check that
triggers it.

**Preference order** (Pin AG), each falling through **silently** on any fault — including an
out-of-range position, which declines that artefact and nothing more:

1. a usable **midx** bitmap for the in-use midx generation, **if the midx carries a
   reverse-index chunk**;
2. a usable **pack** bitmap;
3. the walk.

Measured and exclusive: with a usable midx bitmap present git does not even open the pack
bitmap. Fallback is **by artefact, not by tier** — remove the midx bitmap, or break the
midx's discoverability, and the pack bitmap is used.

**A midx with no reverse-index chunk is not consumable** and the pack tier takes over. This
is free structural information: a midx written without a bitmap carries no such chunk, so a
midx bitmap found beside a chunk-less midx was never written by a tool that would have
produced one.

**Discovery is by the midx's *stored* trailer bytes** — the same
`multi-pack-index-<hex>.bitmap` composition Part 7 landed. A renamed bitmap is simply not
found; a midx whose stored trailer is wrong names a file that is not there and therefore
**hides its own bitmap**. That coupling is transitive and fragile: a midx bitmap's
*discoverability* now gates a read-path accelerator, not just an `fsck` bit. The interop row
for it is the one most likely to look like a test bug when it fails.

**`core.multiPackIndex` is not consulted** (ADR-612), a named deliberate divergence: with
the key set to `false`, git reads the *pack* bitmap where tsgit reads the *midx* one. Both
yield the same object set, so the divergence is in **which file is opened, never in an
answer** — say exactly that in a code comment, without naming the config key as something
tsgit supports.

**Fall-through between the two bitmap artefacts preserves the answer.** Both compute
`W AND NOT N`, so which one answers is unobservable. Only a fall-through to the **walk**
changes a have-bearing answer, and that is faithful.

**Memoisation**: the midx bitmap is memoised per **generation**, not per pack, because its
identity depends on the midx layer in use. A `refresh()` that changes the midx changes the
artefact name, so the memo must hang off the generation and not outlive it.

**`midxObjectCount` does not exist** — the object count is the plain `MultiPackIndex.objectCount`
field. Size the bit space from it.

**Surface gates:** no public type changes and no new page — only a sentence in
`docs/use/commands/rev-list.md`'s tier paragraph noting that the bitmap tier may be served
by a multi-pack-index bitmap (which changes no answer). `reports/api.json` is not expected
to move; run the shared-convention check (`npm run docs:json` then
`git diff --exit-code -- reports/api.json`) and stage the file **if it did**.

**Mutation traps**: the preference ternary (three arms) needs a row per arm where the
*artefact actually read* is observable — assert it through an instrumented context's read
paths, not through the answer, because the answer is deliberately identical. The midx range
check is its **own** boundary against `MultiPackIndex.objectCount` — Part 12's rows over a
pack's count do not kill it, so it needs its own `objectCount − 1` / `objectCount` pair in
both position spaces.

### TDD steps

1. **RED** — `test/unit/application/primitives/internal/bitmap-binding.test.ts`:

   | group | rows | Then |
   |---|---|---|
   | midx mapping | a crafted midx with a reverse-index chunk and a midx bitmap | bits resolve to the right oids through the chunk |
   | the 108/0 assertion | entry headers read as **midx** positions vs as pseudo-pack positions | the midx reading matches **every** entry and the other matches **none** — two rows, both explicit |
   | no chunk | a midx bitmap beside a midx with **no** reverse-index chunk | the midx tier declines; the pack tier answers |
   | discovery — **own `it` each** | midx bitmap renamed to a different hash; the midx's stored trailer wrong | not found; the pack tier answers |
   | types | the midx bitmap's four streams over the midx's object count | the set bits sum to the midx object count, and each stream predicts its objects' types |
   | range validation against the pseudo-pack — **own `it` each** | an entry header (a **midx** position) at `objectCount − 1`, then at `objectCount`; a **set bit** (a pseudo-pack position) at `objectCount − 1`, then at `objectCount`; an entry header at `999999`, trailer restamped | accepted / declines, in both spaces; the declines are **whole-artefact** and the **pack** bitmap answers with the same object set |
   | the fault is reported and the caller sees nothing — **own `it` each** | the restamped out-of-range midx bitmap | `ctx.logger.warn` called once with the **midx bitmap's** name; the returned set is correct and nothing throws |
   | **ordering: validation precedes resolution** — **own `it`** | the same fixture under an instrumented `Context` | `midxOidAt` / `midxReverseIndexAt` were never reached for the declining artefact — the ordering is the assertion, not the answer |

2. **RED** — `test/unit/application/primitives/internal/closure-engine.test.ts`: the
   preference order with each artefact refused in turn — midx bitmap ≻ pack bitmap ≻ walk —
   **one `it` per arm**, each asserting *which* artefact was read (instrumented context)
   **and** that the object set is unchanged between the two bitmap arms. Add a fourth arm:
   the midx bitmap declined for an **out-of-range position** (not a parse fault) falls
   through to the pack bitmap with the same object set — the arm ADR-622 adds.

3. **GREEN** — the midx binding flavour, the generation memo's parse step, the preference
   order.

4. **REFACTOR** — confirm the two binding flavours share their reconstruction and folding
   code and differ **only** in the two mapping functions (that is the whole point of one
   binding module); confirm `bitmap-binding.ts` is still under 400 lines;
   `npm run check:duplicates`; `npm run check:architecture`.

### Gate

```
npx vitest run test/unit/application/primitives/internal/bitmap-binding.test.ts test/unit/application/primitives/internal/closure-engine.test.ts test/unit/application/primitives/pack-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/bitmap-binding.ts src/application/primitives/internal/closure-engine.ts src/application/primitives/pack-registry.ts test/unit/application/primitives/internal/bitmap-binding.test.ts test/unit/application/primitives/internal/closure-engine.test.ts
```

Plus `npm run check:architecture` and `npm run check:duplicates`.

### Commit

`feat(pack): prefer the multi-pack-index bitmap for closures`

## Part 14 — `pack-objects`

### Context

**Goal.** §D8 + ADR-614/618 + requirements 17, 20, 21, 22: the second command over the
engine, at the **opposite** default tier, writing a `.pack` and an `.idx` and nothing else.

**New file:** `src/application/commands/pack-objects.ts`.

```ts
export interface PackObjectsOptions {
  readonly wants: ReadonlyArray<string>;
  readonly not?: ReadonlyArray<string>;
  /** Directory to write into; defaults to the repository's pack directory. */
  readonly outputDirectory?: string;
  /** Use the bitmap tier. **Defaults to `true`** — git's `pack-objects --revs`
   *  uses a usable bitmap unless told not to. Setting it `false` yields the
   *  walk's larger, equally valid pack. */
  readonly useBitmapIndex?: boolean;
}
export interface PackObjectsResult {
  readonly packId: ObjectId;          // the pack's own checksum
  readonly objectCount: number;
  readonly packBytes: number;
  readonly indexBytes: number;
}
```

It composes what exists: the closure engine → `buildPack` → `serializePackfile` /
`serializePackIndex`. **No progress line, no summary line.**

**The default tier is the bitmap**, the opposite of `rev-list`'s, and for the same reason:
it is git's. `pack-objects` carries none of the three options that defeat a bitmap, so
nothing narrows the default; the caller's only control is refusing it outright. With no
haves the two tiers agree exactly; with haves the bitmap pack holds fewer objects and both
packs are valid.

**Sending the smaller pack is safe**: every object the bitmap omits is reachable from a
`not` tip, so a peer that supplied those haves already has them. This is the one place in
the design where a *smaller* answer is the correct one, and it is git's own default
behaviour, not a tsgit optimisation.

**The extraction this part owes** (S-16):

- new `src/application/primitives/internal/write-pack-artifacts.ts` holding `buildIdx`
  (moved verbatim from `fetch-pack.ts:477-499`) and `writePackArtifacts` (moved verbatim
  from `fetch-pack.ts:507-528`, keeping its `promisor` parameter and its `.promisor`
  sentinel comment). `fetch-pack.ts` imports them; **its behaviour must not change** and
  its existing tests are the proof.
- `buildPack`'s `BuildPackResult` (`build-pack.ts:28-33`) gains
  `readonly entries: ReadonlyArray<PackEntryMeta>` — `serializePackfile` already returns
  them (`pack-writer.ts:44-62`) and `buildPack` currently discards them at `:41`. Additive;
  `push.ts` and `bundle-create.ts` are unaffected.
- `pack-objects` then maps `oids[i]` → `{ id: oids[i], crc32: entries[i].crc32, offset: entries[i].offset }`
  and calls the extracted `buildIdx`. **The `.idx`'s double trailer is the trap**:
  `serializePackIndex` writes the pack checksum as the file's first trailer and the caller
  appends the digest over the body — real git produces both, and a reader that stops after
  the first will not round-trip. That is exactly why the code is extracted rather than
  rewritten.

**`outputDirectory`** defaults to `packsDir(commonGitDir(ctx))`. When it is supplied, write
there and do **not** call `refreshPackRegistry` — the pack is not in this repository's
store. When it is not supplied, **do** refresh, the way `materializePack`
(`fetch-pack.ts:157-186`) does, so a follow-up read sees the new pack.

**Edges:**

- An **empty closure** writes a valid 0-object pack and its index rather than refusing —
  git writes a 32-byte pack of 0 objects and exits 0. A caller that wants "nothing to send"
  reads `objectCount === 0`.
- **`packId` is stable for a fixed tier and is *not* stable across tiers.** Object order
  inside the pack is the closure's order and that order differs between tiers, so the same
  closure written by different tiers yields packs with the same contents and **different
  names**. Assertions therefore read the object set back out of the written `.idx`, never
  `packId`. Naming this here because "content-addressed" invites the opposite assumption.
- Nothing in the pack writer wants a name, so the optional `path` costs `pack-objects`
  nothing at all — the command never reads the field.

**`.rev` and `.bitmap` writing and delta compression are excluded permanently.** Because
nothing is written beyond `.pack` and `.idx`, **no `@writes` annotation and no
write-surface allowlist entry is added** (S-17) and that gate stays green untouched. The
existing annotation on `src/domain/storage/pack-writer.ts:8` must not be moved or
duplicated by the extraction.

**A new pack must not invalidate a sibling midx**: a pack the midx does not name is simply
not in the midx's universe, which the registry already handles; `refresh()` is what makes
the new pack visible.

**The full Tier-1 surface tax, again** — every item of Part 9's list, with:

1. barrel entry between `./notes.js` (`:216`) and `./pull.js` (`:217`);
2. facade interface line between `notes` (`:225`) and `pull` (`:226`), binding between
   `notes` (`:588`) and `pull` (`:589`), **two leading spaces**;
3. `'packObjects'` into the snapshot array;
4. `docs/use/commands/pack-objects.md` (six-section shape), stating the **tier default**
   plainly;
5. an index row `` | [`packObjects`](pack-objects.md) | … | `` and `44 entries` → `45` at
   `docs/use/commands/README.md:3`;
6. `test/parity/scenarios/pack-objects.scenario.ts` calling **`repo.packObjects(…)`** and
   registered in `index.ts`; assert `objectCount` and read the written `.idx` back — never
   `packId`;
7. `README.md:47`, `44 Tier-1 commands` → **45**;
8. `npm run docs:json` + `reports/api.json` committed here.

**Mutation traps**: the tier ternary (opposite default from `rev-list` — a mutant flipping
the default is killed only by a row asserting the *object count* on a have-bearing
bitmap-bearing fixture); the `outputDirectory` default; the refresh decision.

### TDD steps

1. **RED** — `test/unit/application/primitives/build-pack.test.ts`: `BuildPackResult.entries`
   is returned and matches `serializePackfile`'s metas, order preserved.

2. **RED** — `test/unit/application/commands/pack-objects.test.ts`
   (`const sut = packObjects;`):

   | group | rows | Then |
   |---|---|---|
   | round trip | a seeded repo, `wants: ['HEAD']` | a `.pack` and an `.idx` land; `parsePackIndex` over the written `.idx` yields exactly the closure's oids; `objectCount`, `packBytes`, `indexBytes` agree with the files |
   | nothing else written | the same | the pack directory gained **exactly two** files — **own `it`**, and its title says no `.rev` and no bitmap are written |
   | empty closure | `wants` fully covered by `not` | `objectCount === 0`, a valid pack and index are still written, no throw |
   | tier default | a bitmap-bearing fixture with haves | the default run's `objectCount` is the bitmap tier's; `useBitmapIndex: false` yields the walk's larger count; the difference set is asserted reachable from a `not` tip |
   | tier agreement | the same fixture with **no** haves | the two tiers write the **same object set** (read back from the `.idx`), and the row does **not** assert `packId` equality |
   | `outputDirectory` — **own `it` each** | supplied; omitted | written where asked / in the pack directory; the registry refreshed only in the second case |
   | refusal | a want that does not resolve | the refusal's `data.code` |

3. **RED** — the snapshot row, the doc page, the index row, the scenario, the counts.

4. **GREEN** — the extraction, the `buildPack` widening, the command, the surface tax.

5. **REFACTOR** — confirm `fetch-pack.ts`'s own tests are green and its behaviour
   unchanged; confirm the `@writes` annotation did not move; `npm run check:duplicates`
   (the extraction is what makes this green); `npm run check:write-surfaces` exits 0;
   `npm run check:doc-coverage`, `npm run check:browser-surface`,
   `npm run check:parity-fixtures`; `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/commands/pack-objects.test.ts test/unit/application/primitives/build-pack.test.ts test/unit/application/primitives/fetch-pack.test.ts test/unit/repository/repository.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/pack-objects.ts src/application/primitives/internal/write-pack-artifacts.ts src/application/primitives/fetch-pack.ts src/application/primitives/build-pack.ts src/application/commands/index.ts src/repository.ts test/unit/application/commands/pack-objects.test.ts test/unit/repository/repository.test.ts test/parity/scenarios/pack-objects.scenario.ts test/parity/scenarios/index.ts
```

Plus `npm run check:doc-coverage`, `npm run check:browser-surface`,
`npm run check:parity-fixtures`, `npm run check:write-surfaces` (exit **0**),
`npm run check:duplicates`, `npm run test:parity`, and `npm run docs:json` with
`reports/api.json` staged in the same commit.

### Commit

`feat(commands): add pack-objects`

## Part 15 — cross-tool interop: the bitmap tier, its preference and its degradation

### Context

**Goal.** The design's closure interop table in full, requirements 16–19, **Pin AK's
range-validation family (ADR-622)**, and — under ADR-615 as narrowed by ADR-622 — a
**security control**, not hygiene: range validation is the first line, this suite the second,
and neither may be trimmed. Test-infra only: **no `src/` delta.** It
extends `test/integration/rev-bitmap-closure-interop.test.ts` and
`test/integration/rev-bitmap-closure-fixtures.ts` from Part 11.

**New fixture:** **F3** — F2 plus 5 more commits repacked incrementally into a second pack,
then `git multi-pack-index write --bitmap`; 2 packs, 1 pack bitmap, 1621 midx objects,
1 midx bitmap.

**New fixture:** **F6** (Pin AK) — 40 commits, **120** objects, one pack with a bitmap, whose
first per-commit **entry header** is rewritten to position `999999` and whose trailer is then
**RESTAMPED**.

**The cross-tier invariant, stated once and asserted everywhere.** Every closure row runs
on **both tiers** and asserts, on **object id and type only — never on `path`**:

1. `not` **empty** ⇒ the two tiers return **exactly** the same set;
2. `not` **non-empty** ⇒ `bitmapSet ⊂ walkSet`, **and** every object in
   `walkSet \ bitmapSet` is reachable from a `not` tip — asserted by an independent full
   `git rev-list --objects <not-tip>` closure, not by inspection;
3. neither direction is asserted on order, on `packId`, or on `path`.

Part 2 of that invariant is the one that would silently pass on a fixture without repeated
blob content, so it runs on **F2 and F5** and the difference set is asserted **non-empty** —
which is what turns a vacuous superset check into a real one.

**The double run is an obligation, not a convenience**: every closure row runs twice — once
on a fixture carrying a bitmap and once on the same repository with the bitmap removed —
under the invariant above. Together with the walk oracle these are the only thing standing
between a decoder bug and a wrong pack. **Name them as such in the test titles**, so a
future trimming pass has to delete a sentence that says why they exist.

**Rows:**

| obligation | rows |
|---|---|
| double run × walk oracle | **every** row below, ×2 |
| set equality, no haves | F2 `--objects HEAD` (1605, and the bitmap tier's name-carrying count is **0**); F2 with a want having **no** bitmap entry (425 objects, 0 names); F5 (367 = 367) |
| type correctness | every returned object's type against `git cat-file --batch-check=%(objecttype)` on F2 |
| have-bearing, **per-command referent** | `revList` with no tier option vs plain `git rev-list`; `revList` with the tier option vs `git rev-list --use-bitmap-index`; `packObjects` vs `git pack-objects --revs`; `packObjects` with the tier refused vs `--no-use-bitmap-index`. F2: 204 / 200. F5: 156 / 150. F4 `HEAD --not topic`: 122 / 122 (the divergence is **fixture-dependent** — this row proves the fixture, not the code) |
| `path` presence is tier-determined | F5: the walk tier's path-carrying count is **127**, the bitmap tier's is **0** |
| option composition on the bitmap tier | `--max-count` asserted **equal to git's default** (git declines the bitmap itself); `--first-parent` and `--no-walk` asserted equal to `git rev-list --use-bitmap-index` — on **F4**, where the merge makes the difference visible (227 vs 183 objects, 76 vs 61 commits; 227 vs 7 objects, 76 vs 2 commits) |
| artefact preference | F3 with both bitmaps healthy (the midx bitmap answers); midx bitmap deleted (the pack bitmap answers); the midx file deleted so its bitmap is orphaned (the pack bitmap answers) — each asserting the **answer is unchanged** |
| midx mapping | F3: the midx bitmap's answer equals the pack bitmap's, and equals real `git rev-list --objects` |
| `.rev`-free consumption | F2 with the `.rev` deleted (the bitmap still answers, same set); F3 with the second pack's `.rev` deleted |
| completeness beyond the artefact | F3 with the midx removed, a pack bitmap covering 1606 of 1621 objects across two packs (**1620 = the walk's 1620**); F2 plus a **loose** commit on top (**1608 = the walk's 1608**) |
| degradation | **every** restamped structural corruption of the bitmap — magic, version, entry count, truncation, an oversized declared stream word count — asserting the answer falls back to **the walk's**; plus the flag word cleared of full-DAG, asserting tsgit **answers** where git aborts |
| `pack-objects` | the written pack's object set on both tiers (read back from the `.idx`), and `git index-pack --verify` **accepting the pack tsgit wrote** |
| **range validation (Pin AK, ADR-622)** | AK0–AK4 on **F6**, below — the family that proves an out-of-range position declines the artefact rather than producing a wrong answer |

**Pin AK's rows, on F6.** They are not a variation on the degradation family above: every
row there corrupts a **structure** and the checksum still catches nothing; here the checksum
is **valid** and the fault is a **value**. That is what makes AK0 and AK1 disagree, correctly.

| # | probe | expectation |
|---|---|---|
| AK0 | `git fsck` **and** `tsgit.fsck()` over the same bytes | both exit **0**, and tsgit reports **no** bitmap finding — the checksum is valid, so the `fsck` pass has nothing to say |
| AK1 | `git rev-list --use-bitmap-index --objects HEAD` vs `revList({ useBitmapIndex: true })` | git exits **0**, printing `error: corrupt ewah bitmap: commit index 999999 out of range` and then the **walk's** answer; tsgit returns the **walk's set**, warns **once** with the artefact name, and surfaces **no** failure to the caller. F6 carries **no** `not`, so the two tiers agree on the set — the **warn** and git's stderr line are the discriminators here, never the count |
| AK2 | `git rev-list --test-bitmap HEAD` | **128** with `fatal: failed to load bitmap indexes`. tsgit exposes no `--test-bitmap` surface, so this row is **git-only** and exists to document why AK1's exit is 0 rather than non-zero |
| AK3 | `git pack-objects --revs` vs `packObjects({ wants: ['HEAD'] })` at its **default (bitmap) tier** | both write the **walk's** object set, read back from the `.idx` — never compared on `packId` |
| AK4 | AK1's count against a plain walk | **120 = 120** — the fallback answer is the correct one, not a truncated one |

**AK0 and AK1 asserted on the same fixture are the point of the family**: they are the
cross-tool twin of Part 12's single-`it` proof that ADR-605's separation holds — `fsck`
hashes and does not parse, the consumer parses and declines, and one file makes both true at
once.

**The fixture recipe, which is the family's whole difficulty.** The entry-header offset is
**computed, never hard-coded**: skip the **32-byte header** (`12 + digestLength`, with
`digestLength = 20`), then the **four type streams**, each `4 + 4 + 8·wordCount + 4` bytes
where `wordCount` is that stream's own `u32BE` at its second word. That lands on the first
per-commit entry header (offset **144** on Pin AK's own fixture — a value to *check* against,
not to hard-code). Rewrite its `u32BE` position to `999999`, then **RESTAMP the trailer**.
**Without the restamp the row proves nothing**: the checksum fault masks the position fault
and the whole family degenerates into Pin J's checksum matrix. Reuse `restampBitmap` from
`test/integration/rev-bitmap-fixture-helpers.ts` (Part 8) and its control row — restamping
alone must leave `git fsck` at exit 0.

**A detector you will need:** setting a bitmap's flag word to 0 and restamping makes git
abort (exit 134) if and only if it loaded that bitmap. That is the only clean way to prove
*which* artefact git opened, and the preference rows use it.

**Traps:** F3's incremental repack must leave the second pack genuinely uncovered by the
first bitmap; `git index-pack --verify` needs the `.pack` and `.idx` side by side under the
name it expects; every row builds a fresh `Context` after the last `git` subprocess; pack
files are `0444`; and F6's rewrite is a **two-step** mutation — poke the position, *then*
restamp — through `mutateOrThrow`, because a silently no-op write on a `0444` file makes AK1
read as a false pass.

### TDD steps

1. **RED** — the F3 fixture builder and the flag-word detector helper, plus the control
   rows (F3 healthy: both bitmaps present, the midx bitmap is the one git loads).
2. **RED** — the no-haves equality rows and the type-correctness row, on both tiers, doubled.
3. **RED** — the have-bearing rows, per-command referent, with the invariant's three clauses
   asserted explicitly and the difference set asserted non-empty on F2 and F5.
4. **RED** — the option-composition rows on F4; the `path`-presence rows on F5.
5. **RED** — the preference rows, the `.rev`-free rows, the completeness rows.
6. **RED** — the degradation rows and the full-DAG row.
7. **RED** — the F6 builder (computed offset, poke, restamp) and Pin AK's rows AK0–AK4, with
   AK0 and AK1 written as **one `it` per probe over the same fixture bytes** so the `fsck`
   0 / consumption-declines pair is visible in the file.
8. **RED** — the `pack-objects` rows, including `git index-pack --verify`.
9. **GREEN** — no `src/` change is expected. A red row here is a defect in Parts 12–14;
   fix it there, add the unit row that would have caught it, and land both in this commit.
   Escalate as `{ part, reason, ≤3 options }` if the fix would change a shape this plan
   fixed.
10. **REFACTOR** — confirm every row disposes its `Context`; confirm no row asserts order,
    `packId` or `path` where the invariant forbids it; confirm the AK family's control (the
    restamp alone leaves `git fsck` at 0) is present, or every AK row is uninterpretable;
    confirm the suite's runtime.

### Gate

```
npx vitest run test/integration/rev-bitmap-closure-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/rev-bitmap-closure-interop.test.ts test/integration/rev-bitmap-closure-fixtures.ts
```

Plus `npm run check:test-pyramid` and `npm run check:write-surfaces` (exit **0**).

### Commit

`test(closure): pin the bitmap tier and its degradation against real git`

## Part 16 — the closure and `fsck` benches

### Context

**Goal.** Requirement 15 for the **two subjects that did not exist when Part 6 ran**: the
**bitmap closure** (Parts 12–14) and threat row T-13's **added `fsck` hashing** (Parts 4 and
7). Test-infra only: **no `src/` delta.** The `.rev` accelerator is **not** measured here —
Part 6 measured it immediately after Part 5 landed it, which is where a regression is still
cheap.

**The measurement rules are the same ones Part 6 carries, and they bind here identically:**
absolute wall-clock, **main versus branch**, sourced from the **CI nightly artefact** — never
a local run, and never a self-share delta (a self-share number is Amdahl-fragile and has
misled this repository before). **A measured regression is a defect to fix in this PR**, not
a reason to drop the bitmap tier and not a follow-up.

**New/extended files:** `test/bench/closure.bench.ts` and `test/bench/fsck-artefacts.bench.ts`
(new), plus `test/bench/` (existing suite: `pack-read.bench.ts` 4.0 KB,
`midx-lookup.bench.ts` 5.1 KB, `delta-chain-read.bench.ts` 2.1 KB, shared `fixtures.ts`
2.4 KB and `support/`). `vitest.bench.config.ts` includes `test/bench/**/*.bench.ts` with a
120 s timeout and writes `reports/benchmarks/raw.json`.

**Two scenarios** (the design's list, minus the two Part 6 already owns):

1. closure **with** a bitmap versus closure **by walk**, at the 400-commit fixture's scale
   and larger — the price of the acceleration the two commands exist to deliver. Run it
   through **both** commands' defaults (`revList` walks, `packObjects` uses the bitmap), so
   the number reflects what a caller actually pays;
2. `fsck` over a repository carrying both a `.rev` and a `.bitmap`, to see the added
   hashing. git pays the same cost, so this is parity, not overhead — but `fsck`'s cost
   profile changes measurably and the bench should show it.

**Fixtures** go through `test/bench/fixtures.ts` and `tooling/gen-bench-fixture.ts` — the same
file Part 6 extended, so read what is already there before adding. Keep them
deterministic and reuse the existing generation helpers rather than adding a new
fixture pipeline. Benches must not spawn `git` — build the artefacts with the same in-test
writers the unit suites use (`buildBitmap` / `encodeEwah` from
`test/unit/domain/storage/arbitraries.ts`), or generate them once into the bench fixture
directory.

**Reporting.** `npm run bench:summary` / `tooling/bench-summarize.ts` and
`tooling/bench-check.ts` already exist; add the new cases to whatever manifest they read so
the nightly artefact carries them. Do **not** wire a new blocking threshold — the
benchmark-comparison job is non-blocking by design because it measures runner noise.

### TDD steps

1. **RED** — add the two bench cases; they "fail" only by not existing. Run
   `npm run test:bench` locally **once**, to confirm they execute and produce numbers — the
   numbers themselves are not evidence and must not be quoted anywhere.
2. **GREEN** — the cases run and are picked up by `bench:summary`.
3. **REFACTOR** — confirm the fixtures are deterministic, that no bench spawns `git`, that
   the closure case really is answered by the bitmap on the bitmap arm (a silent fall-through
   to the walk would make the two arms measure the same code), and that Part 6's two cases
   are still registered and unchanged.

**Reporting obligation for the PR body, not for this file:** once CI's nightly bench has
run on both `main` and the branch, quote the two absolute wall-clock numbers per scenario,
alongside Part 6's. If the closure case regresses, fix it in this PR and escalate as
`{ part, reason, ≤3 options }` rather than choosing silently.

### Gate

```
npx vitest bench --run --config vitest.bench.config.ts test/bench/closure.bench.ts test/bench/fsck-artefacts.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/closure.bench.ts test/bench/fsck-artefacts.bench.ts test/bench/fixtures.ts
```

Plus `npm run check:test-pyramid` (the bench tier's budget) and one full
`npm run validate` as the phase-boundary gate for the whole plan.

### Commit

`test(bench): measure the bitmap closure and the artefact hashing cost`
