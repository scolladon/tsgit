# Plan — rename detection git parity: hydration, basename, non-regular, copies, -B

> Source: design doc `docs/design/rename-detection-git-parity.md` · ADRs 899, 900, 901, 902, 903, 904, 905, 906
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a path in code format:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Conventions every part follows

- Tests: `describe('Given …')` > `describe('When …')` > `it('Then …')` (or the 2-level
  `Given …, When …` shortcut for one expectation), AAA section comments, the system
  under test bound to `sut`. Error assertions check the error's data (code, reason),
  never the class alone. Guard clauses get one isolated test per condition.
- Test titles and row labels describe the scenario in words. They never carry a design
  row id (`C19`, `N7f`, `B3t`), a part number or an ADR number (no provenance refs in
  src or tests). Row ids appear in this plan only, to map rows to the design matrix.
- New interop rows compare tsgit against **live git** only. Never copy the existing
  `try { expect(golden) } catch { saveGolden }` pattern.
- No suppression directives. Every existing `Stryker disable` comment in code a part
  rewrites is re-triaged: delete it when the restructure removed the mutant, keep it
  (with a still-true reason) only when the mutant is still provably equivalent.
- Never touch the untracked `vitest.narrow.ts` / `stryker.narrow.config.mjs`.
- Commits: one line, conventional, no body, no AI trailers. Commit only on a green part
  gate. Every commit must also keep `npm run validate` green.
- Bundle growth (ADR-904): every part with a `src/` delta runs
  `rm -rf dist .wireit && npm run check:size`. When a limit in `.size-limit.json` is
  crossed, raise THAT limit to the measured gzip size + 0.25 kB in the same commit and
  write the measured size into the part's handoff report. Limits today: Browser bundle
  209.25 kB (~50 B headroom), Chunks: domain 78 kB, Chunks: primitives 71.25 kB
  (~168 B headroom). The first growing part will cross the browser limit.
- Before any benchmark: quiet-machine check (`uptime` load below the core count, no
  foreign `stryker` process, no other session running a bench).

## Landing order (decided) and why

The design's §8 numbering (Parts 0–7) is not the landing order: four design parts exceed
the sizing ceiling and split, two new scope items (ADR-903's last consequence bullet)
join, and the "cross-cutting pins" design Part 7 dissolves into the parts whose change
puts each ✓ row at risk.

| Part | Lands | Design source |
|---|---|---|
| 1 | `copyThreshold` removed | design Part 0 |
| 2 | shared interop row-table harness (test infra) | new — makes ~70 new rows affordable |
| 3 | rename benchmarks (test infra) | design §7 |
| 4 | header-claim size read + bounded hydration + bench A/B | design Part 1 |
| 5 | `rename-pairing` domain module (exact, copy-aware) | design Part 2 |
| 6 | `name_score` tie-break in the matrix | design Part 3 (slice) |
| 7 | registry, exact copy pass, use-count labels, limit counts | design Part 3 (slice) |
| 8 | one matrix, two-pass selection | design Part 3 (slice) |
| 9 | `-B` write back (S2) and rejoin uses | design Part 3 (slice) |
| 10 | non-regular files leave scoring | design Part 4 |
| 11 | `should_break` guards (D10) | design Part 5 (first commit) |
| 12 | `-B` breaks symlink↔regular type changes; `TypeChangeChange.broken` | design Part 5 |
| 13 | `-B` without rename detection | ADR-903 consequence (new) |
| 14 | kept-broken modify numstat = complete rewrite | ADR-903 consequence (new) |
| 15 | basename pass | design Part 6 |
| 16 | blame pin for the basename pass (test only, see D-E) | design Part 6 (blame slice) |
| 17 | user docs | design Parts 0, 5 docs bullets |

Ordering constraints, re-verified against the code (each also holds for the new parts):

| Constraint | Why | Forces |
|---|---|---|
| `copyThreshold` removal first | Parts 4, 7, 8 build one-threshold gates directly | 1 < 4, 7, 8 |
| harness before any new row | rows are one table entry each | 2 < 6 |
| bench scenarios exist before the hydration commit | `bench:ab` only compares scenarios both refs share | 3 < 4 |
| exact copy pairing before non-regular exclusion | N4s (`C100` symlink→symlink, `-C`) is ✓ today only because the inexact pass scores symlinks | 7 < 10 |
| use-count write back before type-change breaking | without S2 + rejoin uses, a broken type change emits bare halves | 9 < 12 |
| non-regular exclusion before type-change breaking | a symlink half would otherwise inexact-pair (N7n → `R100 a/d→a/p`) | 10 < 12 |
| type-change breaking before the basename pass | B3t is ✓ today only because tsgit has no basename pass | 12 < 15 |
| `-B`-only route before the numstat part | the numstat rows pin `--no-renames -B` peers | 13 < 14 |

Interim states that are deliberately git-divergent but never regress a ✓ row:

- Parts 7–8: a broken delete half is still written back by today's presence rule
  ("absent when any pair used it"); Part 9 replaces it with S2. K3, B3bb, N6 and every
  existing `-B` interop row stay ✓ (checked: none of them pairs a broken half).
- Part 7: the matrix still runs today's kind-typed triples, fed from the new registry.
  C19/C20 stay ✗ until Part 8; every row Part 7 claims is fixed by the exact pass and
  the labels alone (C6 and C10 were traced through the adapter: see Part 7).

## Probe facts verified for this plan

Probed on git 2.55.0 (every `GIT_*` unset, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`, isolated `HOME`, signing off, `mktemp -d` repos). Porcelain
`git diff` turns rename detection on by default (`diff.renames`), so "-B without -M" peers
MUST pass `--no-renames -B` (or use `diff-tree -r -B`); a bare `git diff -B` pairs.

`-B` without rename detection (`git diff --no-renames -B HEAD~1 HEAD`):

| Shape | name-status / raw | numstat |
|---|---|---|
| `m` 40 lines fully rewritten, add `q` = old `m`, `z`→`y` identical move | `M100 m ; A q ; A y ; D z` (no pairing at all, not even exact) | `40 40 m ; 40 0 q ; 40 0 y ; 0 40 z` |
| `m` 40 lines, first 25 replaced (dissimilarity 61%) | `M061 m` | `40 40 m` |
| same, `-B50%/70%` (61 < 70: re-merged) | `M m` | `25 25 m` |
| same, `-B/61%` / `-B/62%` | kept / re-merged | `40 40` / `25 25` |
| symlink→regular type change `p` (20 lines) | `T100 p` (`:120000 100644 … T100`) | `20 1 p` |
| empty `e` grows to 40 lines; 3-line `s` rewritten | `M e ; M s` (guards) | — |

Kept-broken modify numstat (`-M -B` and `--no-renames -B` agree), git's `complete_rewrite`
path in `builtin_diffstat`:

| Shape | `--numstat -B` | `--numstat` (no `-B`) |
|---|---|---|
| 40 lines → 30 new lines, no final LF | `30 40` (an incomplete last line counts) | `30 40` |
| every line's whitespace changed (M100) | `40 40`; with `-w` still `40 40` (not dropped) | `-w`: the file is dropped |
| 2000 random bytes rewritten (M100) | `- -` (binary wins) | — |
| 40 lines → empty (M100) | `0 40` | — |
| K1 shape with `-M -B` | `40 40 m ; 0 0 m => q` | — |

`--stat` is rendered from the same two counts (` m | 80 +++…---`), so pinning numstat pins
it. `git diff -B -w -p` keeps the full rewrite patch and `git diff -w --name-status`
(no `-B`) omits a whitespace-only file: the whitespace drop pass never drops a kept-broken
modify.

Rename-limit counting of non-regular sources (`git diff -M -l1`, one regular delete
`a/foo.c` + one extra non-regular delete, one regular add `b/foo2.c` at 89%):

| Extra delete | git | tsgit today |
|---|---|---|
| gitlink `a/sub` (row **L4**) | `D a/foo.c ; D a/sub ; A b/foo2.c` (2 > 1: skipped); `-l2` → `D a/sub ; R089` | `R089` ✗ (gitlinks are not counted) |
| symlink `a/lnk` (row **L5**) | `D ; D ; A` | ✓ (symlinks are counted; must stay ✓ through Part 10) |

Code facts found while planning (not in the design):

- **ADR-863 conflict.** `readObjectMetadata` is pinned content-derived by ADR-863 (DC-A2:
  "`readObjectMetadata` stays content-derived") and by the unit test
  "Given a loose blob whose header size claim disagrees with its body length" (read-object-metadata.test.ts `:98`,
  expects 12, not the claim 5). ADR-902 puts the header-only route inside
  `readObjectMetadata`, which would return the claim. See decision candidate **D-A**;
  the plan applies (a): a separate internal header-claim size read.
- `readObjectMetadata`'s only production caller is ref-store tag peeling (type only);
  `deltify` uses `readObjectMetadataWithContent`, which no part touches.
- `diffTrees` (`diff-trees.ts:83-107`) runs detection only when `detectRenames === true`;
  `renameOptions.breakRewrites` is ignored otherwise. See **D-B**.
- `applyStatPass` (`diff-trees.ts:189`) and both whitespace drop paths
  (`changeShouldDrop` `:341`, `dropVerdict` `:367`) ignore `ModifyChange.broken`.
- `plan-lint` counts any code span that resolves to a file or looks like a path
  (contains `/`, or ends in `.js .md .json …`). Context blocks below therefore put
  only edited files in code spans; row paths such as a/p are written plain.

## Decision candidates

Load-bearing choices the design and ADRs 899–906 do not pre-decide. The plan is written
with the recommendation applied; the orchestrator confirms or redirects before
implementation.

- **D-A — where the header-only loose size lives (ADR-902 vs ADR-863).**
  (a) *recommended, applied*: a new internal `readDeclaredObjectSize(ctx, id)` in
  read-object.ts (packed: entry-header / delta-target size; loose: header claim through a
  prefix read; fallback: full inflate + `parseHeader`). `readObjectMetadata` and its
  ADR-863 pin stay as they are; ADR-902's decision is amended on location only (its
  Option 2 shape, but kept in read-object.ts). The claim is what git's own
  `check_size_only` gate reads, so the gate stays git-faithful even for a size-lying
  object. (b) `readObjectMetadata` goes header-only: supersede ADR-863's DC-A2 for
  `readObjectMetadata` (the `WithContent` variant keeps content sizes for deltify),
  flip the `:98` test. (c) keep the full inflate for loose sizes (ADR-902 Option 3:
  hostile 118 ms / 305 MB instead of 36 ms / 122 MB).
  Either (a) or (b) needs an ADR touch (amend 902, or supersede part of 863) before
  Part 4.
- **D-B — API shape of `-B` without `-M`.**
  (a) *recommended, applied*: `diffTrees`/`diff` honour `renameOptions.breakRewrites`
  when `detectRenames` is not `true`: break, then rejoin every record, no pairing
  (`git diff --no-renames -B`). No new public member; the "only used when
  `detectRenames` is true" doc sentence changes. (b) Move `breakRewrites` to a top-level
  `DiffOptions`/`DiffTreesOptions` member and remove it from `RenameDetectOptions`
  (breaking, big test churn: every `-B` unit and interop row). (c) Add a top-level member
  and keep the `renameOptions` one (two knobs for one git flag).
- **D-C — `SIZE_GATE_MIN_IDS` value (ADR-901 fixes the shape, not the number).**
  (a) *recommended, applied*: 16 unique regular candidate ids. The measured common case
  (F1) has 6 ids, `wide` has 600; below 16 the unconditional fingerprint-and-drop reads
  at most 16 blobs. (b) 64. (c) `2 × limitFor(ctx, 'ioBound')` (machine-dependent,
  harder to pin in a test). Part 4's bench A/B validates the chosen value; a `common`
  regression beyond noise sends it back here.
- **D-D — interop row structure inside the ADR-905 suites.**
  (a) *recommended, applied*: extract rename-exact-interop's row-table harness
  (`buildRow`, `writeFiles`, name-status reconstruction) into a shared
  `test/integration/rename-interop-rows.ts`, generalised (scored R/C, `M%03d`, gitlink
  files, `--no-renames` peers); both suites declare rows as table entries. (b) Hand-write
  one describe per row in rename-similarity-interop's existing memory-context style
  (~70 lines per row × ~60 rows, and the second copy of the builder trips
  `check:duplicates`). (c) A new suite (contradicts ADR-905).
- **D-E — the blame pin for the basename pass lands as its own test-only part.**
  (a) *recommended, applied*: Part 16, test-only. The basename part already declares 6
  files (the plan-lint ceiling); the blame pin is a separate command surface.
  (b) Fold it into Part 15 and run plan-lint with `--file-ceiling 7`. (c) Drop the blame
  unit row and keep only the blame-interop row, still a 7th file.
- **D-F — user docs consolidated into a final docs-only part.**
  (a) *recommended, applied*: Part 17 rewrites docs/use/commands/diff.md and
  docs/use/primitives/diff-trees.md once, for every behaviour change. The ceiling cannot
  hold the docs in Parts 1, 12 and 13 (each already at 5–6 files). No doc-coverage gate
  moves (no new command). Cost: the docs lag the code between Part 1 and Part 17 inside
  this branch. (b) Docs in-part, each of those parts splits in two. (c) Docs left to the
  craft documentation phase (same as (a) but outside the plan).
- **D-G — scope found by probing, beyond the design matrix.** A kept-broken modify is
  never dropped by the whitespace pass (`git diff -B -w` keeps it; its numstat is the
  complete-rewrite count). (a) *recommended, applied*: in Part 14, under ADR-903's
  "every `-B` row follows git". (b) Defer and pin only the plain numstat rows.

Settled here, flagged for review (not decisions):

- The design's `patch-serializer.test.ts` row ("a broken type change renders identical")
  is replaced by the N7b `-p` interop pin in Part 12: `renderTypeChangeBlock` never reads
  `broken`, and the live-git pin proves the same bytes end to end.
- `diff-type-change-interop.test.ts` gets no `T%03d` arm: it runs no `-B` row, and ADR-905
  places every N7 row in the rename suites.
- `computeRewriteStatFields` (Part 14) gets no property sibling: a counting property
  would re-implement the line count as its own oracle (property-testing.md "NOT
  appropriate", tautology case).

## Part 1 — one threshold gates renames and copies; `copyThreshold` removed

### Context

Edits:
- `src/domain/diff/rename-detect.ts`
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/application/primitives/detect-similarity-renames.test.ts`
- `test/integration/rename-similarity-interop.test.ts`
- `reports/api.json` (regenerated by `npm run docs:json`, never hand-edited)

Production change (ADR-906):
- `RenameDetectOptions` (rename-detect.ts `:9-23`): delete `copyThreshold?` (`:13-14`)
  and its doc comment. Add a doc comment on `threshold`: "similarity gate
  (0..MAX_SCORE) for both renames and copies — git's `-M<n>` / `-C<n>`; default 50%".
- detect-similarity-renames.ts, every `copyThreshold` goes; `threshold` replaces it
  where a value is still needed:
  - `buildCopyTriples(…, copyThreshold)` `:234-254` (parameter + the
    `scoreAndRecord(…, copyThreshold, …)` call at `:249`);
  - `InexactPassOptions.copyThreshold` `:372`;
  - `buildAllTriples` signature `:427-435` and its call `:446`;
  - `runInexactPass` destructuring `:457` and argument `:469`;
  - `DetectOptions.copyThreshold` `:780` and `resolveDetectOptions`'s `?? threshold`
    default `:791`;
  - `detectSimilarityRenames` destructuring `:824` and the `runInexactPass` object `:859`.
- Public surface: a removed public member (breaking). Surface gates: `reports/api.json`
  regenerated in this commit (entries at `:110636` and `:190295` disappear). No barrel,
  facade, doc-coverage or README-count change. The changelog entry comes from the `!`
  commit — never hand-edit CHANGELOG.md. User docs: Part 17 (D-F).

Tests that move:
- Unit `:515-556` "Given copies: \"on\" and a copy pair whose score is below
  copyThreshold": becomes "below threshold". Set `threshold` to the copy's measured
  score + 1 (compute it in the test from `estimateSimilarity` over the two fixture
  blobs, or read it from the passing sibling row), NOT `MAX_SCORE`: `MAX_SCORE` exits
  before the matrix (design §6) and would not exercise the copy-pass gate.
- Interop `:2010-2100` (T3): `renameOptions: { copies: 'on', threshold: 24000 | 24600 }`
  against the unchanged `git -C40%` / `-C41%` peers; the describe title drops
  `copyThreshold`. The row has no delete, so the rename pass is inert.
- `grep -rn copyThreshold src test examples README.md` must be empty after the part
  (docs/use is Part 17).

### TDD steps

1. RED — delete `copyThreshold` from `RenameDetectOptions`: `tsc` fails at every use
   listed above, at the `:515` unit row (`copyThreshold: MAX_SCORE`, `:542`) and at the
   T3 interop row. (Behaviour alone gives no RED: with `copyThreshold` absent the copy
   pass already falls back to `threshold`.)
2. GREEN — remove every use; thread `threshold`; rewrite T3 with `threshold`; rewrite
   the `:515` row with `threshold` = measured copy score + 1 (copy dropped) and add its
   sibling at `threshold` = measured score (copy emitted), so the copy-pass gate is
   pinned on both sides of the boundary.
3. REFACTOR — none beyond the doc comment.
4. `npm run docs:json`, stage `reports/api.json`.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/domain/diff/rename-detect.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/rename-detect.ts src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/domain/diff/rename-detect.ts src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
git add -A reports/api.json && npm run docs:json && git diff --exit-code reports/api.json
rm -rf dist .wireit && npm run check:size
```

### Commit

`feat(diff)!: gate copies with the rename threshold and remove copyThreshold`

## Part 2 — shared row-table harness for the rename interop suites

### Context

Test infra only, no `src/` delta (template exception). Edits:
- `test/integration/rename-interop-rows.ts` (new, not a test file: no `@proves` header)
- `test/integration/rename-exact-interop.test.ts`

Extract from rename-exact-interop.test.ts (lines `:28-140`, runner `:315-359`) into the
new module, then import it back:
- `FileSpec { path; content; kind?: 'exec' | 'symlink' | 'gitlink' }` — add `'gitlink'`:
  `content` is a 40-hex oid; `writeFiles` skips it on disk and `buildRenameRow` adds it
  after `git add -A` with `git update-index --add --cacheinfo 160000,<oid>,<path>`
  (before AND after commits; the after side is a full replace, `git rm -r -q .` removes
  gitlinks too).
- `RenameRow { label; before; after; gitFlags?; renameOptions?; recursive?;
  gitCommand?: 'diff' | 'diff-tree'; detectRenames?: boolean }` — `detectRenames`
  defaults to `true` (peer gets `-M`); `false` makes the peer pass `--no-renames`
  instead of `-M` and the tsgit call omit `detectRenames` (Part 13 uses it).
- `buildRenameRow(row, tmpPrefix): Promise<{ dir }>` (was `buildRow`; the per-suite
  `mkdtemp` prefix and the epoch counter move with it), `gitPeerNameStatus(dir, row)`.
- `nameStatusFrom(treeDiff)`, generalised: R/C print `R%03d` / `C%03d` of
  `toSimilarityPercent(similarity.score)` (src/domain/diff/similarity.js), `modify`
  prints `M%03d` of `broken.score` when `broken` is set, else `M`; `type-change` stays
  `T` (Part 12 adds the `T%03d` arm once the field exists). Exact rows still print
  `R100`/`C100`, so the exact suite's expectations are unchanged.
- `runRenameRow(row)`: builds `createNodeContext({ workDir: dir })`, calls `diff(ctx, {
  from: 'HEAD~1', to: 'HEAD', recursive: row.recursive ?? true, detectRenames when not
  false, renameOptions when set })`, returns `{ ours, peer }`. Each suite keeps its own
  `describe.skipIf(!GIT_AVAILABLE)` + `beforeAll`/`afterAll` + `it.each(ROWS)` block
  (3A comments, `expect(ours).toBe(peer)`), so the harness holds no test registration.
- Read-only references: test/integration/interop-helpers.ts (`GIT_AVAILABLE`, `git`,
  `runGit`, `runGitEnv`), src/adapters/node/index.ts, src/application/commands/diff.ts.

Two new rows, both ✓ today, so the new branches are exercised in this commit:
- same-oid gitlink delete a/sub + add b/sub → `R100` (ADR-405 exact gitlink pair);
- `detectRenames: false`, identical delete + add → `A ; D` (peer `--no-renames`).

### TDD steps

1. Move the harness verbatim into the new module; the exact suite imports it. Suite
   green, unchanged row count.
2. Generalise `nameStatusFrom` (scored arms); suite still green (all its rows are 100%).
3. RED — add the gitlink row: fails (`FileSpec.kind` has no `'gitlink'`, type error).
   GREEN — gitlink support in `writeFiles` / `buildRenameRow`.
4. RED — add the `detectRenames: false` row: fails (peer always gets `-M`, tsgit always
   detects). GREEN — the flag.
5. `npm run check:duplicates` must not report the moved code.

### Gate

```
npx vitest run --project integration test/integration/rename-exact-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check test/integration/rename-interop-rows.ts test/integration/rename-exact-interop.test.ts
npx cspell --no-progress test/integration/rename-interop-rows.ts test/integration/rename-exact-interop.test.ts
npm run check:test-pyramid
npm run check:duplicates
```

### Commit

`test(diff): share a row-table harness across the rename interop suites`

## Part 3 — rename-detection benchmarks

### Context

Test infra only, no `src/` delta. It lands before Part 4 because `npm run bench:ab`
compares only the scenarios both refs share (tooling/bench-ab.ts `listBenchFiles` +
shared-entry filter): the base ref of Part 4's A/B must already carry them.

Edits:
- `test/bench/diff-renames.bench.ts` (new)
- `test/bench/support/fixture-generator.ts`
- `tooling/bench-memory.ts`

Fixture builder (fixture-generator.ts): a cached builder
`ensureRenameFixture(shape: 'common' | 'wide' | 'hostile', storage: 'loose' | 'packed'):
Promise<{ readonly cwd: string }>`, built with the `git` CLI in a temp dir under
`cacheRoot()` (`:248`) and renamed into place, following `ensureScaledFixture` (`:956`)
and `leftoverDirName` (`:625`). Key the cache dir by shape + storage +
`FIXTURE_GENERATOR_VERSION` (`:25`, bump it only if the existing key scheme requires).
`packed` = the loose build + `git gc --aggressive=false -q` (or `repack -adq`). Shapes
(design §3.1/§7, deterministic content, no randomness without a fixed seed):
- `common`: 50 files, 3 of them renamed and edited (F1);
- `wide`: 300 moved and edited 4 KiB files (F2);
- `hostile`: 300 distinct 1 MiB blobs deleted + one 6-byte add (d300); use a seeded
  PRNG (e.g. a small xorshift) so the blobs are distinct and incompressible but
  reproducible.

Bench file: six `benchScenario`s (test/bench/support/bench-dsl.ts) — each opens
`openRepository({ cwd })` (src/index.node.js), `sut` = `repo.diff({ from: 'HEAD~1', to:
'HEAD', recursive: true, detectRenames: true })`, teardown `repo.dispose()`. Titles
follow the existing `Given … / When …, Then measure tsgit` shape (see
test/bench/diff-whitespace.bench.ts). Do NOT add the file to docs/perf/hot-paths.json.

bench-memory.ts: a `rename-hydration` workload on `hostile`/`loose` reusing the file's
`toReport(workload, before, peak, after)` helper (`:125`) — it records peak RSS of one
`repo.diff(…detectRenames: true)` over the built `dist` (the script runs after
`npm run build`).

### TDD steps

1. Builder + bench file; run the bench once to build and cache the fixtures:
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/diff-renames.bench.ts`.
   Record today's medians (common/wide/hostile × loose/packed) in the handoff report — they
   are the Part 4 baseline.
2. `rename-hydration` workload; run `npm run bench:memory` once and record the hostile
   peak RSS (design: ~665–790 MB today).

### Gate

```
npx vitest bench --run --config vitest.bench.config.ts test/bench/diff-renames.bench.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check test/bench/diff-renames.bench.ts test/bench/support/fixture-generator.ts tooling/bench-memory.ts
npx cspell --no-progress test/bench/diff-renames.bench.ts test/bench/support/fixture-generator.ts tooling/bench-memory.ts
npm run check:test-pyramid
```

### Commit

`test(bench): benchmark rename detection on common, wide and hostile diffs`

## Part 4 — size-gated, fingerprint-and-drop hydration

### Context

Edits:
- `src/application/primitives/read-object.ts`
- `test/unit/application/primitives/read-object-metadata.test.ts`
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/application/primitives/internal/detect-similarity-renames.test.ts`
- `test/unit/application/primitives/detect-similarity-renames.properties.test.ts` (new)

Surface: every new symbol is **internal** (read-object.ts and detect-similarity-renames.ts
are not re-exported by src/application/primitives/index.ts, which exports only
`readObject` from read-object). No api.json change.

Header-claim size read (ADR-902 as amended by D-A (a)), read-object.ts:
- New `export async function readDeclaredObjectSize(ctx: Context, id: ObjectId):
  Promise<number>` next to `readObjectMetadata` (`:281`), wrapped like it:
  `registry = peekPackRegistry(ctx) ?? await getPackRegistry(ctx)`, then
  `withLazyFetchRetry(ctx, id, registry, () => resolveDeclaredSize(ctx, registry, id))`.
- `resolveDeclaredSize`: `hit = await registry.lookup(id)`; packed →
  `(await readPackedMetadata(ctx, registry, hit, id)).uncompressedSize` (`:319`, already
  header-only); loose → `readLooseDeclaredSize`; neither → `throw objectNotFound(id)`
  (src/domain/objects/error.js) so the lazy-fetch retry fires.
- `readLooseDeclaredSize(ctx, id): Promise<number | undefined>`: `probeLooseOid(ctx, id)`
  (src/application/primitives/internal/loose-oid-cache.js) false → `undefined`; path =
  `looseObjectPath(commonGitDir(ctx), id)` (path-layout.ts `:51`, `:41`); prefix =
  `ctx.fs.readSlice(path, 0, LOOSE_HEADER_PROBE_BYTES)` with `LOOSE_HEADER_PROBE_BYTES =
  1024`; a `FILE_NOT_FOUND` `TsgitError` → `forgetLooseOidPrefix(ctx, id)` + `undefined`
  (mirror `readLooseCompressed`, object-resolver.ts `:326-338`); any other error
  rethrows. Stream the prefix through `ctx.compressor.createInflateStream()` (see
  `inflateOneShot`, internal/blob-source.ts `:415`) and accumulate output until the NUL
  (see `readLooseHeader` `:455`); on NUL, `parseHeader(buf).size`
  (src/domain/objects/header.ts) and cancel the iterator (`returnIterator` pattern
  `:487`, or the reader's `cancel`).
- Fallback, exact by construction: when the prefix ends (or the inflate of the
  truncated prefix rejects) before a NUL AND `prefix.length === LOOSE_HEADER_PROBE_BYTES`
  (the file is longer than the probe), inflate the whole file
  (`looseCompressedBytes`, object-resolver.ts `:345`, then `ctx.compressor.inflate`) and
  return `parseHeader(inflated).size`. When the prefix IS the whole file, never catch:
  an inflate error propagates (`DECOMPRESS_FAILED`), and output that ends without a
  NUL throws `invalidObjectHeader` with the reason `no NUL terminator found in inflated
  object <id>`
  (src/domain/objects/error.js, the reason `readLooseHeader` already uses). The catch that routes to the fallback must be narrowed to that
  "truncated probe" case, so nothing is swallowed.
- The value is the header CLAIM (git's `check_size_only`): for a size-lying loose blob it
  differs from `readObjectMetadata`, which stays content-derived (ADR-863, the `:98` test
  stays as is).

Hydration (ADR-901, D-C (a)), detect-similarity-renames.ts:
- Remove `hydrateIds` (`:37-45`), `BlobEntry` (`:32`), `buildFingerprintMap`
  (`:157-170`, and its Stryker comment `:163`), `FingerprintPair` (`:385`) and
  `hydrateAndFingerprint` (`:402-424`, and its Stryker comments `:409`, `:411`).
- New `@internal` exports (the internal test and the property test import them):
  - `SIZE_GATE_MIN_IDS = 16`;
  - `sizeCompatibleIds(sizes: ReadonlyMap<ObjectId, number>, srcIds, dstIds,
    threshold): ReadonlySet<ObjectId>` — an id is needed when at least one partner on the
    other side passes `!isSizeRejected`. Per side, sort the partner sizes once; for a
    size s, binary-search the first partner d with `d >= s || !isSizeRejected(s, d, t)`
    (monotone in d), then accept iff that d exists and `!isSizeRejected(s, d, t)`. No
    float bounds. Symmetric for dst ids.
  - `hydrateFingerprints(ctx, ids: ReadonlyArray<ObjectId>, known:
    ReadonlyMap<ObjectId, BlobFingerprint>): Promise<ReadonlyMap<ObjectId,
    BlobFingerprint>>` — dedupes, skips ids already in `known`, one
    `boundedMapFor(ctx, 'ioBound', missing, async (id) => { const { content } = await
    readBlob(ctx, id); return [id, { chunkMap: buildChunkMap(content), size:
    content.length }] })`, returns a NEW map (`known` + new). Only the fingerprint
    escapes the worker, so each blob's bytes die with it. ONE shared pool for src and
    dst (carry over the doc comment's concurrency proof). Parts 7 and 15 call it again
    with the accumulated map (phased hydration).
  - private `selectHydrationIds(ctx, srcIds, dstIds, threshold)`: unique ids; when
    `unique.length <= SIZE_GATE_MIN_IDS` return them all (no size read); else read
    `readDeclaredObjectSize` per unique id through `boundedMapFor(ctx, 'ioBound', …)` and
    return `sizeCompatibleIds(…)` over src and dst.
- `runInexactPass` (`:453`): `allSrcIds` + add ids → `selectHydrationIds` →
  `hydrateFingerprints(ctx, needed, new Map())` → the existing matrix builders, which
  already skip an id with no fingerprint (`buildRenameTriples` `:215`/`:219`,
  `buildCopyTriples` `:243`/`:247`). `buildRenameTriples`/`buildCopyTriples`/
  `buildAllTriples` take one `ReadonlyMap<ObjectId, BlobFingerprint>` instead of the
  src/dst pair (a blob shared by both sides fingerprints once).
- Gate threshold: `threshold` (Part 1 removed the second one). Pool scope at this commit:
  every id the matrix scores — symlinks are still sized and fingerprinted (Part 10 narrows
  to regular files); gitlinks are already out (`partitionLeftovers`, ADR-405).
- `scoreModifies` (`:533-568`): per-modify `boundedMapFor(ctx, 'ioBound', modifies, …)`
  reading old and new inside the worker and returning `computeBreakScores(old, new)` +
  the modify; the bytes never outlive the worker. Output unchanged (git's
  `should_break` reads both blobs fully: no size gate here).
- Re-triage the `scoreAndRecord` Stryker comment (`:192`): the gate's rejections are now
  observable through a `readBlob` spy (a rejected id is never read).

Tests:
- internal/detect-similarity-renames.test.ts: the existing concurrency-ceiling row
  (`:25-72`) moves to `hydrateFingerprints` (same `vi.spyOn(readBlobMod, 'readBlob')`
  in-flight counter, `maxInFlight === ioBound`). New rows use `detectSimilarityRenames`
  through a `readBlob` spy recording ids, plus a
  `vi.spyOn(readObjectMod, 'readDeclaredObjectSize')` counter:
  - above `SIZE_GATE_MIN_IDS` unique ids, a delete whose size no add can reach is never
    passed to `readBlob`;
  - at exactly `SIZE_GATE_MIN_IDS` unique ids the size read is never called; at
    `SIZE_GATE_MIN_IDS + 1` it is called once per unique id.
  Fixtures: `buildSeededContext` (test/unit/application/primitives/fixtures.ts),
  `writeObject` blobs as in the existing file.
- read-object-metadata.test.ts, new `describe('readDeclaredObjectSize')` block:
  - a 64 KiB loose blob: returns 65536, reads through `readSlice` (spy `ctx.fs.readSlice`,
    `ctx.fs.read` never called);
  - a size-lying loose blob (`writeLooseWithDeclaredSize(ctx, id, 'blob', 5, content)`,
    fixtures.ts `:325`): returns 5 (while `readObjectMetadata` keeps returning 12);
  - a loose object whose header decodes only after more than 1024 compressed bytes:
    build the file by hand — zlib header `0x78 0x01`, ~300 empty stored blocks
    (`0x00 0x00 0x00 0xff 0xff` each, byte-aligned, no output), then
    `deflateRawSync(serializedObject)` from node:zlib, then the big-endian adler32 of the
    serialized object — write it with `ctx.fs.write` at the loose path; returns the true
    size through the fallback (verify the seeded context's compressor accepts empty
    stored blocks; if it does not, construct the prefix-exhausting case another way and
    say so in the handoff report);
  - a loose file whose entire content has no NUL after inflate: rejects with
    `INVALID_OBJECT_HEADER` (assert `error.data.code` and the reason text);
  - a packed base entry and an OFS_DELTA entry (reuse the `buildSyntheticPack` /
    `writeSyntheticPack` fixtures already used in this file): equals
    `readObjectMetadata(...).uncompressedSize`;
  - an id neither loose nor packed: rejects `OBJECT_NOT_FOUND` with the id.
- detect-similarity-renames.properties.test.ts (new; lens 2 — `sizeCompatibleIds` as an
  aggregator): over small arrays of sizes (0..4096) and thresholds (0..MAX_SCORE), the
  returned set equals the brute force `ids.filter(id => partners.some(p =>
  !isSizeRejected(size(id), size(p), t)))` for both sides. The brute force is the O(S·D)
  scan, not the binary search, and `isSizeRejected` is independently example-tested
  (`detect-similarity-renames.test.ts` `:1831`, `:3776`). `numRuns: 100`.

Benchmark acceptance (after the commit — the bench compares two committed refs):
- `npm run bench:ab -- <Part 3 commit sha> HEAD 3`, run TWICE (quiet machine both
  times; each run takes a while, run it in the background). Accept when, in both runs,
  the six diff-renames scenarios show `common` loose and packed medians within the
  bench-check noise threshold of the base, and `hostile` at least 10× faster than the
  base. Every other shared scenario must show no regression beyond noise.
- `npm run bench:memory`: `rename-hydration` peak RSS within 64 MB of the process
  baseline the report prints (design target; today ~665+ MB).
- A `common` regression beyond noise is a blocker (`{ unit: Part 4, reason, options:
  raise SIZE_GATE_MIN_IDS / accept / revisit D-C }`), not a silent retune.

### TDD steps

1. RED — `readDeclaredObjectSize` rows (large loose, size-lying claim, not found): fail,
   the function does not exist. GREEN — packed + loose-prefix route.
2. RED — the prefix-exhausting fixture and the no-NUL whole-file row: fail (no
   fallback / wrong error). GREEN — the narrowed fallback.
3. RED — property file for `sizeCompatibleIds`: fails, not exported. GREEN — the binary
   search.
4. RED — "a size-rejected delete is never read" (above the gate) and the
   `SIZE_GATE_MIN_IDS` / `+1` size-read counters: fail (every id is read today).
   GREEN — `selectHydrationIds` + `hydrateFingerprints`; move the concurrency row.
5. REFACTOR — `scoreModifies` streams per modify; remove the dead helpers and their
   Stryker comments; full detect-similarity-renames + diff-trees + blame unit suites and
   both rename interop suites green (output equal by construction).
6. Size check (ADR-904: likely crosses the browser limit — bump to measured + 0.25 kB).
7. Commit, then the benchmark acceptance above; record medians and RSS in the handoff report.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts test/unit/application/primitives/detect-similarity-renames.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/diff-trees.test.ts test/unit/application/commands/blame.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/read-object.ts src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts test/unit/application/primitives/detect-similarity-renames.properties.test.ts
npx cspell --no-progress src/application/primitives/read-object.ts src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts test/unit/application/primitives/detect-similarity-renames.properties.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size
```

### Commit

`perf(diff): size-gate inexact rename candidates and drop each blob after fingerprinting`

## Part 5 — `rename-pairing`: git's copy-aware exact pass as a pure domain module

### Context

Edits:
- `src/domain/diff/rename-pairing.ts` (new)
- `src/domain/diff/rename-detect.ts`
- `test/unit/domain/diff/rename-pairing.test.ts` (new)
- `test/unit/domain/diff/rename-pairing.properties.test.ts` (new)
- `test/unit/domain/diff/arbitraries.ts`

Surface: **internal**. Nothing goes through src/public-types.ts or
src/domain/diff/index.ts (the primitive imports modules by path, as it does
rename-detect.js today). `detectRenames` (public) keeps its signature and output.

New module (ADR-900, design §4.1/§4.5):

    export type SourceOrigin = 'deleted' | 'broken-delete' | 'modified' | 'unchanged';
    export interface RenameSource {
      readonly path: FilePath; readonly id: ObjectId; readonly mode: FileMode;
      readonly origin: SourceOrigin;
      readonly seedUses: 0 | 1;          // git's initial rename_used
    }
    export interface SourcePair { readonly source: number; readonly destination: AddChange; readonly score: number }
    export interface ExactPairing {
      readonly pairs: ReadonlyArray<SourcePair>;      // score === MAX_SCORE
      readonly unpaired: ReadonlyArray<AddChange>;    // destinations, input order
      readonly uses: ReadonlyArray<number>;           // per source index: seedUses + pairs
    }
    export function pairIdenticalFiles(
      sources: ReadonlyArray<RenameSource>, destinations: ReadonlyArray<AddChange>,
      mode: 'rename' | 'copy',
    ): ExactPairing;

- Moves here from rename-detect.ts: `EXACT_CANDIDATE_CAP` (`:26`), `exactKey` (`:46`),
  `hasSameBasename` (`:70`; module-private here — Part 6 exports it for its first outside
  consumer), and the
  group-building/consume logic (`buildExactSources` `:54`, `pickExactSource` `:78`,
  `consumeExactSource` `:90`), generalised from `DeleteChange` to source indexes.
- git's `find_identical_files` per destination, in input order: candidates = sources with
  the destination's `exactKey`, in source order; scan at most `EXACT_CANDIDATE_CAP`;
  `score = (uses === 0 ? 1 : 0) + (hasSameBasename ? 1 : 0)`, strict `>`, stop at 2.
  - `'rename'`: a source with `uses > 0` is skipped WITHOUT counting toward the cap.
    Keep today's last-first spliced groups so one-shot consumption stays O(cap) (the
    `af00d39e` perf fix): a consumed source leaves its group.
  - `'copy'`: used sources are scored AND counted; nothing is spliced.
  - Every recorded pair increments `uses[source]`. Working state is local and mutable
    (a `number[]` copy of the seeds); inputs and the returned object are immutable.
- `detectRenames(diff)` (rename-detect.ts `:112`) becomes a thin wrapper: partition →
  deletes become `{ origin: 'deleted', seedUses: 0 }` sources in their existing order →
  `pairIdenticalFiles(…, 'rename')` → emit `toExactRename` for each pair, the unpaired
  adds, the deletes whose `uses` is 0, and `other`, sorted by `primaryPath` as today.
- Row facts (git 2.55.0, design §3.4, all exact, 100%):
  C1 `-C`: 1 delete a/Foo.meta → identical b/Bar.meta, b/Baz.meta: both pair to
  source 0, `uses[0] === 2`. C3: 3 identical adds, `uses === 3`. C9: deletes Foo, Qux →
  adds A, B, C: A←Foo (first), B←Qux (unused beats used: 1+0 > 0+0), C←Foo (both used,
  first). C14: modified a/Bar (seed 1) before deleted z/Aaa (seed 0), destination
  c/Bar: a/Bar scores 0+1, z/Aaa 1+0, strict `>` keeps a/Bar. C15: same with an
  `unchanged` a/Bar. G1: modified gitlink source, identical gitlink destination pairs
  (mode class `160000`).
- Read-only references: test/unit/domain/diff/rename-detect.test.ts and
  rename-detect.properties.test.ts (must stay green, untouched — ADR-136);
  `arbExactRenameDiff` (arbitraries.ts `:116`) and `arbNonDirMode` (`:45`).

### TDD steps

1. RED — rename-pairing.test.ts, `'rename'` mode: a seeded-used source is skipped and
   does not count toward the cap (101 used sources ahead of a fresh one: the fresh one
   still pairs). Fails: module missing. GREEN — module with the rename mode moved from
   rename-detect.ts; `detectRenames` wraps it; rename-detect.test.ts green untouched.
2. RED — `'copy'` fan-out: C1 and C3 pairs + `uses`. GREEN — copy mode (no splice).
3. RED — C9 (unused beats used) and C14/C15 (used-with-basename ties unused-without;
   first in source order wins). GREEN if not already; otherwise fix the scoring.
4. RED — copy-mode cap counting: 100 used same-key sources ahead of an unused
   basename-matching one → the cap hides it, the destination pairs with the first used
   source. GREEN.
5. RED — properties (lens 4), new `arbSourcesAndDestinations()` in arbitraries.ts
   (small id/path pools, `arbNonDirMode`, origins with their seeds):
   - under `'copy'`, every destination with at least one same-key source is paired;
   - under `'rename'`, no source's `uses` exceeds `seedUses + 1`, and a destination
     pairs iff some same-key source had `uses === 0` when it was visited
     (restate the rule, do not reuse the loop);
   - `uses[i] - seedUses[i]` equals the number of pairs naming `i`.
   GREEN.

### Gate

```
npx vitest run --project unit test/unit/domain/diff/rename-pairing.test.ts test/unit/domain/diff/rename-pairing.properties.test.ts test/unit/domain/diff/rename-detect.test.ts test/unit/domain/diff/rename-detect.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts
npx vitest run --project integration test/integration/rename-exact-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/rename-pairing.ts src/domain/diff/rename-detect.ts test/unit/domain/diff/rename-pairing.test.ts test/unit/domain/diff/rename-pairing.properties.test.ts test/unit/domain/diff/arbitraries.ts
npx cspell --no-progress src/domain/diff/rename-pairing.ts src/domain/diff/rename-detect.ts test/unit/domain/diff/rename-pairing.test.ts test/unit/domain/diff/rename-pairing.properties.test.ts test/unit/domain/diff/arbitraries.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size
```

### Commit

`feat(diff): transcribe git's copy-aware exact pairing in a pure rename-pairing module`

## Part 6 — equal scores break ties on a matching basename (`name_score`)

### Context

Edits:
- `src/domain/diff/rename-pairing.ts`
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/domain/diff/rename-pairing.test.ts`
- `test/unit/application/primitives/detect-similarity-renames.test.ts`
- `test/integration/rename-similarity-interop.test.ts`

Surface: internal.

- rename-pairing.ts: `export interface RankedCandidate { readonly score: number; readonly
  nameScore: 0 | 1 }` and `export function compareCandidates(a, b): number` — git's
  `score_compare`: `a.score === b.score ? b.nameScore - a.nameScore : b.score - a.score`
  (negative = `a` ranks first).
- detect-similarity-renames.ts:
  - `ScoredTriple` (`:96-108`): both arms gain `readonly nameScore: 0 | 1`, computed at
    record time as `hasSameBasename(src path, add.newPath) ? 1 : 0` (delete arm:
    `del.oldPath`; copy arm: `src.oldPath`).
  - `recordIfBetter` (`:125-144`) becomes git's `record_if_better`: `worst` = index 0,
    then `i` from 1 while `compareCandidates(slots[i], slots[worst]) > 0` → `worst = i`
    (ties keep the lowest index); replace iff `compareCandidates(slots[worst],
    candidate) > 0`. Unfilled slots are still pushed first (git's `dst < 0` sink).
    Update its doc comment and `NUM_CANDIDATE_PER_DST`'s (`:110-118`); re-triage the
    Stryker comment at `:133`.
  - `sortTriples` (`:260-270`): `compareCandidates` first, then today's kind tie-break
    (removed in Part 8). `Array.prototype.sort` is stable (git's `STABLE_QSORT`), and the
    triples are built destination-major in slot order, which is git's layout.
- Unit fixtures: `renameTriple(score)` helper (test `:3691`) gains a `nameScore`
  argument; the `recordIfBetter` describes at `:3709`, `:3745`, `:3764` gain nameScore
  arms.
- Interop rows (row table in rename-similarity-interop via the Part 2 harness,
  `-M` unless noted; content per design §3 "Content"):
  B1 (issue #300: a/Aaa.cls-meta.xml and a/Foo.cls-meta.xml share a blob → b/Foo.cls-meta.xml
  = body + 1 line → `D Aaa ; R097 a/Foo→b/Foo`), B1c (`-C`), B2 (two distinct equal-score
  sources, `R052 Foo→Foo`), B8 (A..E.c all 61% → b/E.c: `R061 E.c→E.c`), B8c (`-C`),
  B9 (A.c, B.c both 61% → b/B.c: `R061 B.c→B.c`). Must-stay ✓: B1m (3 identical meta
  sources → 3 edited same-named dests).

### TDD steps

1. RED — rename-pairing.test.ts: `compareCandidates` orders by score, then nameScore;
   equal on both → 0. GREEN.
2. RED — unit B8: 5 equal-score sources, the 5th basename-matching; the 5th must take a
   top-4 slot (today it never displaces). GREEN — `recordIfBetter` rewrite.
3. RED — unit B9/B2: equal score, the second source's basename matches → it wins
   (today path order). GREEN — `sortTriples` uses `compareCandidates`.
4. RED — interop rows B1, B1c, B2, B8, B8c, B9 (+ B1m ✓). GREEN (already, from steps
   2–3); run both rename interop suites in full.
5. REFACTOR — doc comments; Stryker re-triage.

### Gate

```
npx vitest run --project unit test/unit/domain/diff/rename-pairing.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/rename-pairing.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/rename-pairing.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/domain/diff/rename-pairing.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/rename-pairing.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
rm -rf dist .wireit && npm run check:size
```

### Commit

`fix(diff): break equal rename scores on a matching basename like git`

## Part 7 — one source registry, exact copies, use-count labels, faithful limit counts

### Context

Edits:
- `src/domain/diff/rename-pairing.ts`
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/domain/diff/rename-pairing.test.ts`
- `test/unit/application/primitives/detect-similarity-renames.test.ts`
- `test/integration/rename-exact-interop.test.ts`
- `test/integration/rename-similarity-interop.test.ts`

Surface: internal.

rename-pairing.ts — `labelRenameCopy`:

    export interface LabelledPair { readonly pair: SourcePair; readonly kind: 'rename' | 'copy' }
    export function labelRenameCopy(
      pairs: ReadonlyArray<SourcePair>, sources: ReadonlyArray<RenameSource>, uses: ReadonlyArray<number>,
    ): ReadonlyArray<LabelledPair>;

Output (queue) order = destination path order (`sortByPath` over
`pair.destination.newPath`, the comparator `primaryPath` sorts by). Walk it with a copy
of `uses`: `--u[source] > 0 ? 'copy' : 'rename'` (git `diff.c:6699`). A deleted source
used k times → k−1 copies then one rename, the rename last in path order, whichever pass
produced it; a retained (`modified`/`unchanged`, seed 1) source → only copies.

detect-similarity-renames.ts:
- New `registerCandidates(workingDiff, broken, copies, preimage, mergeScore)` replaces
  `partitionLeftovers` (`:347`), `resolveCopySources` (`:699`),
  `buildCopySourcesForOn`/`ForHarder` (`:60`, `:84`) and `CopySource` (`:47`). Returns
  `{ sources: RenameSource[] (sortByPath over path — all origins interleaved), destinations:
  AddChange[] (all adds, path order), other: DiffChange[] }`:
  - `delete` → `deleted`, seed 0; a delete that IS a broken record's `del` (object
    identity, the halves `patchDiffWithBroken` inserted) → `broken-delete`, seed
    `record.dissimilarity < mergeScore ? 1 : 0`;
  - `copies !== 'off'`: each `modify`/`type-change` preimage (path, oldId, oldMode) →
    `modified`, seed 1 — gitlinks INCLUDED now (G1);
  - `copies === 'harder'` with a preimage map (diff-trees.ts `buildPreimage` `:389`):
    every preimage path the diff does not touch → `unchanged`, seed 1 (gitlinks
    included, G2). A path the diff touches is registered once, by its change.
  - every mode is registered (exact pairing and counts need them).
- Exact pass: `pairIdenticalFiles(sources, destinations, copies === 'off' ? 'rename' :
  'copy')`, never limited (ADR-370). Replaces the `detectRenames(workingDiff)` call
  (`:831`).
- Matrix sources after the exact pass: `copies !== 'off'` → every source (used ones
  stay); otherwise the sources with `uses === 0` (git's `-M` cull). Scoring/hydration
  pools additionally drop gitlinks (`isGitlink`, ADR-405; Part 10 widens this to every
  non-regular mode).
- Limit gate (replaces `:835-852`, design §4.6): `num_dst` = unpaired destinations,
  `num_src` = matrix sources (every mode, each once). `limit !== 0 && num_dst × num_src >
  limit²` → skip the matrix. Under `'harder'`: when over, retry with the sources whose
  origin is not `unchanged` (git's `skip_unmodified`); fits → run the matrix without the
  `unchanged` sources; else skip. The exact pass above already saw every source (C18).
- Interim matrix adapter (replaced in Part 8): feed today's triple builders from the
  registry — rename-kind triples from matrix sources with origin `deleted` /
  `broken-delete` and `uses === 0`; copy-kind triples (copies on) from every matrix
  source; `greedySelect` (`:313`) unchanged. Each inexact match increments `uses`.
- Emission (replaces `assemblePostPass` `:799` and `InexactPassResult` `:378`):
  `labelRenameCopy(exact + inexact pairs)` → `RenameChange`/`CopyChange` (existing
  `buildRenameChange`/`buildCopyChange` `:287`/`:300`, generalised to a `RenameSource`);
  unpaired destinations as adds; a `deleted` source's delete iff its final `uses` is 0;
  `modified`/`unchanged` sources emit nothing (their change is in `other`).
- Broken halves, interim (Part 9 replaces): a `broken-delete` half is "present" iff
  `uses === seedUses`; the add half is present iff unpaired; `findPresentHalves` /
  `remergeOrKeepBroken` (`:632`, `:659`) keep their four cases on those predicates.
- Traced through the adapter: C6 (`-C`, 1 delete; Bar 95%, Baz 85%) → rename triple
  Foo→Bar wins Bar, Baz gets the copy triple Foo→Baz, uses 2 → labels `C095 Bar ;
  R085 Baz` ✓. C10 (`-C`, Baz identical, Bar 90%) → exact Foo→Baz, Foo used, copy triple
  Foo→Bar → `C090 Bar ; R100 Baz` ✓.

Tests that move (re-derive each against git; the rows below encode today's divergence
or a removed helper): unit `:481`, `:597` (only if its pairing changes), `:658-890`
(harder rows; `:755` becomes the `skip_unmodified` shape), `:1650` (limit count, each
source once), `:2649-2832` (`resolveCopySources` guard rows — the function is gone; keep
the observable pins, re-title them), `:2833` (1 delete → 2 adds under `-C`: now C then
R), `:2895`, `:3112-3300` (work guards + limit), `:3526` (gitlink modify under `-C`:
G1), `:3593` (unchanged gitlink under harder: G2).

Interop rows (exact → rename-exact-interop; inexact → rename-similarity-interop):
- fixed: C1 (#9), C2 (#10, `-C -C`), C3, C9, C14, C15, C16 (`-C -l1`), C18
  (`-C -C -l1`), G1, G2 (exact); C6, C10, L1 (`-C -l1`: 1 delete → 1 add at 90% →
  `R090`), L4 (gitlink counted, probe above) (similarity).
- must stay ✓ (at risk here): C4, C5, C5q, C5m, C8, L3, K3, N4s, N8, L5, L1m.

### TDD steps

1. RED — rename-pairing.test.ts `labelRenameCopy`: C1 (C then R), C3 (C, C, R), C10
   (exact + inexact from one delete: R is last in path order), a retained source (only
   C). GREEN.
2. RED — primitive C1/C3 fan-out under `-C`: fails (today R + A). GREEN — registry +
   copy-mode exact pass + labels + delete-by-uses emission, interim adapter.
3. RED — C14/C15 (interleaved retained source wins) and G1/G2 (gitlink exact copies).
   GREEN.
4. RED — limit counts: L1 (each source once), L4 (a gitlink delete counted), C16/C18
   (exact fan-out unlimited, exact sees the full preimage), the harder
   `skip_unmodified` shape. GREEN.
5. RED — C6/C10 through the adapter; the moved unit rows re-derived. GREEN.
6. Interop rows (fixed + must-stay) in both suites; both suites in full.
7. REFACTOR — delete dead helpers; Stryker re-triage for `:444`, `:458`, `:834-838`.

### Gate

```
npx vitest run --project unit test/unit/domain/diff/rename-pairing.test.ts test/unit/domain/diff/rename-pairing.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts test/unit/application/primitives/diff-trees.test.ts test/unit/application/commands/blame.test.ts
npx vitest run --project integration test/integration/rename-exact-interop.test.ts test/integration/rename-similarity-interop.test.ts test/integration/blame-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/rename-pairing.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/rename-pairing.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-exact-interop.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/domain/diff/rename-pairing.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/rename-pairing.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-exact-interop.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size
```

### Commit

`fix(diff): pair exact copies and label renames by source use count like git`

## Part 8 — one candidate matrix, a rename pass then a copy pass

### Context

Edits:
- `src/domain/diff/rename-pairing.ts`
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/domain/diff/rename-pairing.test.ts`
- `test/unit/domain/diff/rename-pairing.properties.test.ts`
- `test/unit/application/primitives/detect-similarity-renames.test.ts`
- `test/integration/rename-similarity-interop.test.ts`

Surface: internal.

- rename-pairing.ts: `export function selectPairs(sorted: ReadonlyArray<MatrixCandidate>,
  uses: ReadonlyArray<number>, options: { readonly copies: boolean; readonly threshold:
  number }): { pairs: ReadonlyArray<SourcePair>; uses: ReadonlyArray<number> }` where
  `MatrixCandidate = RankedCandidate & { source: number; destination: AddChange }`.
  Pass 1: skip a paired destination, skip a source with `uses > 0`, stop at the first
  `score < threshold` (the primitive's matrix only records candidates at or above
  `threshold`, so this stop guards the domain contract; the domain unit rows kill it). Pass 2 (only when `copies`): skip a paired destination, any
  source, same stop. Each recorded pair increments `uses`. One threshold for both
  passes (ADR-906). The object-identity "paired destination" set is local.
- detect-similarity-renames.ts:
  - `ScoredTriple` loses `kind` and becomes `MatrixCandidate` (`source` index into the
    registry). `buildMatrix(sources, destinations, fingerprints, threshold)` replaces
    `buildRenameTriples` (`:206`), `buildCopyTriples` (`:234`) and `buildAllTriples`
    (`:427`): destination-major, one `NUM_CANDIDATE_PER_DST` slot array per
    destination over ALL matrix sources, `scoreAndRecord` unchanged.
  - `sortTriples` (`:260`) keeps only `compareCandidates` (stable sort); the kind
    tie-break and its two Stryker comments (`:264`, `:266`) go.
  - `greedySelect` (`:313`), `RenameMatch`/`CopyMatch`/`GreedyMatch` (`:272-285`) and the
    Part 7 interim adapter go; `selectPairs` replaces them.
  - Cull rule (design §4.5 step 4): matrix sources keep the used ones when
    `copies !== 'off' || broken.length > 0` (git's `remove_unneeded_paths_from_src`
    returns early), else only `uses === 0`. They occupy top-4 slots even though pass 1
    skips them.
- Row facts: C19 (`-C`: modified a/M 90% vs deleted a/D 70% → b/N): pass 1 pairs only the
  deleted source → `M a/M ; R070 a/D→b/N`. C20 (`-C`: b/N1 = old M exactly, b/N2: D 80%
  vs M 85%) → `C100 M→N1 ; R080 D→N2`.
- Tests that move: unit `:597`, `:1892-2118` (the sortTriples kind rows — rewrite as
  score/nameScore/stable-order rows or delete where the branch is gone), `:2119`,
  `:2162` (null guard of the removed pass), `:3691` `renameTriple` helper.

### TDD steps

1. RED — rename-pairing.test.ts `selectPairs`: pass 1 skips a used source even when it
   scores higher; pass 2 only with copies; the stop at `score < threshold` in each pass;
   a destination paired in pass 1 is skipped in pass 2 — one isolated row per guard.
   GREEN.
2. RED — primitive C19 and C20: fail (today `C090` / `C085`). GREEN — `buildMatrix` +
   `selectPairs`, remove the triple kinds and `greedySelect`.
3. RED — cull rule: under `-C`, an exact-used source occupies a top-4 slot and
   displaces a fifth, lower-scoring source that pass 2 would otherwise pick (unit row
   built on the NUM_CANDIDATE_PER_DST fixture style at `:1439`). GREEN.
4. RED — properties (lens 4) in rename-pairing.properties.test.ts over generated
   pair lists and seeds: per `deleted` source with k ≥ 1 pairs, `labelRenameCopy` yields
   k−1 copies and one rename, and the rename is last in destination-path order; every
   retained source yields only copies; `selectPairs` never pairs a destination twice.
   GREEN.
5. Interop C19, C20; must-stay ✓: C7, C11, C12, C13, C15n, C17 (inexact, at risk from
   the two-pass change). Both suites in full.

### Gate

```
npx vitest run --project unit test/unit/domain/diff/rename-pairing.test.ts test/unit/domain/diff/rename-pairing.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts test/unit/application/commands/blame.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts test/integration/blame-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/rename-pairing.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/rename-pairing.test.ts test/unit/domain/diff/rename-pairing.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/domain/diff/rename-pairing.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/rename-pairing.test.ts test/unit/domain/diff/rename-pairing.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size
```

### Commit

`fix(diff): select renames before copies over one candidate matrix like git`

## Part 9 — `-B` write back: a broken delete goes when its add half pairs; rejoin counts a use

### Context

Edits:
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/application/primitives/detect-similarity-renames.test.ts`
- `test/integration/rename-similarity-interop.test.ts`

Surface: internal.

- Replace `findPresentHalves` (`:632-649`), `emitMergedModify` (`:652`) and
  `remergeOrKeepBroken` (`:659-689`, with its Stryker comments `:664`, `:674`, `:685`) by
  one write back step that runs BEFORE `labelRenameCopy` (design §4.5, git
  `diffcore-rename.c:1669` + `diffcore-break.c:239-272`):
  - per broken record: add half paired → drop the delete half, whatever its `uses`
    (S2); the pairing stands in for the broken change;
  - add half unpaired → rejoin: emit `rejoinBroken(record, mergeScore)` (today's
    `emitMergedModify` body: `broken` datum iff `dissimilarity >= mergeScore`) and
    `uses[delete-half source]++` — the rejoined pair is one more user (K1, K2);
  - a `broken-delete` source never surfaces as a bare delete of its own path.
- `finalizeWithBroken` (`:753`) keeps the final `sortByPath(…, primaryPath)`; its
  Stryker comment (`:758`) is re-triaged.
- Row facts (`-M -B`, design §3.4/§3.5): K1 (m rewritten 40 lines; add q = old m) →
  `M100 m ; C100 m→q`; K2 (q = old m + 1 line) → `M100 m ; C099 m→q`; S2 (20-line a/s fully
  rewritten to a deleted 40-line a/d's content) → `R100 a/d→a/s`; K3 (q = a deleted z) →
  `M100 m ; R100 z→q` (must stay ✓).
- Tests that move (they encode the divergence): `:1334` "delete-half consumed by a
  rename → add-half remains" becomes K1's shape (rejoined modify with `broken` + a
  copy); `:2426` "add-half consumed, delete-half stays" becomes S2 (no delete, only the
  rename); `:2545` both consumed → the add half paired, so the delete is dropped;
  `:2604` both unconsumed → rejoin. Write every new or rewritten `-B` fixture at ≥ 500
  bytes so Part 11's guards leave it broken (e.g. `'aaaa\nbbbb\ncccc\ndddd\n'.repeat(25)`
  instead of `.repeat(5)`).

### TDD steps

1. RED — S2 unit row (a delete + a rewritten modify whose new content equals the
   delete): today `D a/s ; R100`. GREEN — the S2 rule.
2. RED — K1 and K2 unit rows: today `A m ; R100`. GREEN — rejoin + use increment
   before labels.
3. RED — rewrite `:1334`, `:2426`, `:2545`, `:2604` to git's shapes (each fails on the
   old code). GREEN.
4. Interop K1, K2, S2 + must-stay K3, B3bb, N6 and every existing `-B` row in the
   suite.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size
```

### Commit

`fix(diff): drop a broken delete whose new half pairs and count rejoined halves as a source use`

## Part 10 — non-regular files leave similarity scoring (ADR-899)

### Context

Edits:
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/application/primitives/detect-similarity-renames.test.ts`
- `test/integration/rename-similarity-interop.test.ts`

Surface: internal.

- The rule (design §4.4): a non-regular side (symlink, gitlink, tree) is never scored
  and never hydrated; it stays in the registry, the exact pass, the limit counts and
  (Part 15) the basename uniqueness indexes.
- Replace the scoring/hydration filter `isGitlink` (Part 7) with
  `isRegularFile(mode) = kindOf(mode) === 'file'` (src/domain/diff/mode-kind.ts,
  `kindOf`) — a private helper in the primitive. Applies to the matrix sources, the
  matrix destinations and Part 4's size/fingerprint pool. Counts (Part 7) do not change.
- `attemptBreaks` (`:599-615`) is untouched here (symlink modifies still break, gitlinks
  do not; Part 12 widens it).
- The primitive's `isGitlink` import (`:12`) goes if unused; `isGitlink` stays public
  (src/public-types.ts, other callers).
- Row facts (design §3.3): N1 (symlink a/link→`target` deleted; regular b/file =
  `target`) → `D ; A`; N1c (`-C`) → `D ; A`; N2 (symlink→symlink, 280-byte target + 1
  char) → `D ; A`; N3 (regular → symlink, similar) → `D ; A`; N4 (`-C`: modified symlink,
  regular add = old target) → `M ; A`; N5 / N5r (`-C -C`, unchanged symlink/regular vs an
  add of the other kind) → `A ; M k`; N6b (`-M -B`, 540-byte symlink fully retargeted,
  regular b/file = old target) → `M100 a/link ; A b/file`. Must stay ✓: N3r, N4s, N6,
  L5 (symlink still counted by the limit), G3.

### TDD steps

1. RED — N1/N2/N3 unit rows plus "a symlink blob is never read" (`vi.spyOn(readBlobMod,
   'readBlob')`: never called with the symlink's id): fail (paired today). GREEN — the
   regular-only scoring/hydration filter.
2. RED — N4, N5, N5r (copy sources exact-only). GREEN (same filter, confirm).
3. RED — N6b (a broken symlink's halves pair exactly only). GREEN (same filter,
   confirm); L5 unit row keeps the symlink in the count.
4. Interop fixed rows + must-stay rows; the gitlink describes (search `160000`,
   `:3301-3708`) stay green.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size
```

### Commit

`fix(diff): keep symlinks and gitlinks out of similarity scoring like git`

## Part 11 — `-B` never breaks an empty source or a pair under 400 bytes

### Context

Edits:
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/application/primitives/detect-similarity-renames.test.ts`
- `test/integration/rename-similarity-interop.test.ts`

Surface: internal. (D10 (a), ratified under ADR-903's consequence bullet.)

- git `should_break` (diffcore-break.c `:13`), order after the type-change and same-oid
  checks: `max(srcSize, dstSize) < MINIMUM_BREAK_SIZE` (400) → no break; then
  `srcSize === 0` → no break. Name the constant `MINIMUM_BREAK_SIZE = 400` (git's name)
  in the primitive.
- Apply both in `scoreModifies` before `computeBreakScores` (`:519-530`), from the
  sizes of the bytes the worker already read (no new read).
- With `srcSize > 0` guaranteed, `computeBreakScores`' `srcSize > 0 ? … : 0` ternary
  (`:528`) and its Stryker comment (`:527`) become dead: remove them. `maxSize > 0`
  (`:526`) is likewise always true: remove that ternary.
- Existing rows that move: `:2194` (both blobs empty) and `:2234` (empty source,
  non-empty destination) re-derive to "not broken". Every `breakRewrites` unit fixture
  under 400 bytes grows: the `'aaaa\nbbbb\ncccc\ndddd\n'.repeat(5 | 10)` blocks
  (`:891-1400`, `:2276`, `:2347`, `:2385`, `:2986`), `sharedContent` (`:1339` area, 150
  bytes) and any `tenLines` fixture passed with `breakRewrites`. Boundary rows
  ("exactly at / one below the break-attempt gate" `:963`, `:998`; "keep-broken gate"
  `:1033`, `:1069`; the B2 fixture `:1232`) must be re-derived so they still sit
  exactly on their gates after growing — recompute the dissimilarity for the new
  content, do not just scale.
- Row facts (design §3.5): S0 (empty regular a/e grows to 40 lines = deleted a/d) →
  `D a/d ; M a/e`; S1 (3-line a/s fully rewritten to deleted a/d's content) →
  `D a/d ; M a/s`.

### TDD steps

1. RED — S1 guard isolated: both sides 399 bytes, fully dissimilar → not broken
   (plain `modify`); sibling at max = 400 → broken. GREEN — the size guard.
2. RED — S0 guard isolated: empty source, 500-byte destination → not broken (the size
   guard alone does not fire). GREEN — the empty guard.
3. REFACTOR — remove the dead ternaries; grow and re-derive the moved fixtures.
4. Interop S0, S1 (fixed); every existing `-B` interop row stays ✓.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
rm -rf dist .wireit && npm run check:size
```

### Commit

`fix(diff): never break empty or sub-400-byte files under -B`

## Part 12 — `-B` breaks symlink-to-regular type changes and reports them broken

### Context

Edits:
- `src/domain/diff/diff-change.ts`
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/application/primitives/detect-similarity-renames.test.ts`
- `test/integration/rename-interop-rows.ts`
- `test/integration/rename-similarity-interop.test.ts`
- `reports/api.json` (regenerated)

Surface: **public** — `TypeChangeChange` (diff-change.ts `:42-49`) gains

      /** Dissimilarity datum when -B broke this type change and its halves rejoined.
       *  git breaks every symlink↔regular type change at MAX_SCORE, so score === MAX_SCORE. */
      readonly broken?: SimilarityScore;

Additive, optional; the interface is already public through src/public-types.ts (no
barrel edit). Gates: `npm run docs:json` → commit `reports/api.json`. No exhaustive
union switch changes (a field, not a union member). Consumers checked (design §4.8):
`renderTypeChangeBlock` (patch-serializer.ts `:621`) and the stat pass ignore the field;
`withPrefix` (diff-trees.ts `:604`) spreads it; show/log/whatchanged/status/blame/merge
never pass `breakRewrites`. User doc bullet: Part 17.

detect-similarity-renames.ts:
- `BrokenRecord.original` (`:485`): `ModifyChange | TypeChangeChange`.
- `attemptBreaks` (`:599`): candidates are (a) a `modify` whose kind is breakable —
  `isBreakableKind(mode) = kindOf(mode) === 'file' || kindOf(mode) === 'symlink'`
  (git's `OBJ_BLOB`), replacing `!isGitlink` (`:605`); a directory-mode modify (a
  non-recursive diff) is no longer scored; (b) a `type-change` whose two kinds are both
  breakable, i.e. file↔symlink: a record with `dissimilarity: MAX_SCORE`, built without
  entering `scoreModifies` (no blob read). gitlink↔file, gitlink↔symlink and
  directory↔anything stay plain `T` (G3).
- `patchDiffWithBroken` (`:571`): replaces `type-change` records too (key on the
  record's path, not on `change.type === 'modify'`).
- `attemptBreaks`' early return on an empty candidate list (`:608`) and its Stryker
  comment (`:607`) now count type-change candidates too; re-triage both early-return
  comments (`:607`, `:611`).
- `rejoinBroken` (Part 9) spreads either kind; a type change's `MAX_SCORE` always passes
  `dissimilarity >= mergeScore`.
- Under `-C` a broken type change registers once, as its `broken-delete` half (seed 0,
  since `MAX_SCORE >= mergeScore`), never also as a `modified` source (N7c) — true by
  construction when registration walks the patched diff; pin it.
- A broken type change counts in `broken.length` (Part 15's basename gate).

rename-interop-rows.ts: `nameStatusFrom` gains the `type-change` arm `T%03d` of
`broken.score` when set, else `T`.

Row facts (`-M -B` unless noted; design §3.3, §3.5):
N7b (symlink→regular a/p) → `T100 a/p`, plus — in one dedicated `it` that builds the
row with `buildRenameRow` and calls `diff` itself — `-p` via `reconstructPatch`
(test/integration/diff-reconstruct.ts) byte-equal to `git diff --no-ext-diff -p -M -B`
and `withStat` numstat `20 1`; N7s (same blob on both sides) → `T100`; N7d (regular→symlink a/p; add b/q
= old content) → `T100 a/p ; C100 a/p→b/q`; N7c (N7d with `-C -B`) → same; N7e (b/q = old
+ 1 line) → `T100 ; C098`; N7m (two identical adds, `-M`) → `T100 ; C100 a/p→b/q ; A
b/r`; N7f (symlink→regular a/p; deleted a/old = new a/p content) → `R100 a/old→a/p`;
N7j (a/old = new + 1 line) → `R097 a/old→a/p`; N7g (regular→symlink a/p → `T`; deleted
symlink a/s → `T`) → `R100 a/s→a/p`; N7h (N7g + b/q = old a/p) → `R100 a/s→a/p ; R100
a/p→b/q`; N7k (swap) → `R100 a/r→a/p ; R100 a/p→a/r`; N7n (deleted regular a/d = the
symlink target) → `D a/d ; T100 a/p`; G3 (gitlink→regular) → `T a/sub`; B3t (B3 + a
symlink→regular `t`) → `D foo.c ; R095 bar.c→foo.c ; T100 t`. Must stay ✓: N7, N7dn,
N7fn, N7kn (`-M` only), N8 (`-C`).

### TDD steps

1. RED — N7b and N7s unit rows: `broken: { score: MAX_SCORE, maxScore: MAX_SCORE }` on
   the `type-change`, and a `readBlob` spy proves neither side is read. Fails: no field
   (type error), no break. GREEN — the field, the type-change record, patch + rejoin.
2. RED — kind filter, one isolated row per pair: file↔symlink breaks both ways;
   file↔gitlink, symlink↔gitlink, directory↔file do not; a directory-mode modify is not
   scored (non-recursive diff). GREEN — `isBreakableKind`.
3. RED — rejoin as a use: N7d, N7e, N7m (copies). GREEN (Parts 7–9 machinery; fix if
   not).
4. RED — add half paired: N7f, N7j, N7g, N7h, N7k (no `T`). GREEN (S2 rule; confirm).
5. RED — N7n (symlink half never inexact) and N7c (registered once under `-C`). GREEN.
6. Harness `T%03d` arm; interop rows (fixed + must-stay), including N7b `-p` and
   numstat; `npm run docs:json`.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/domain/diff/patch-serializer.test.ts test/unit/application/primitives/diff-trees.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts test/integration/diff-type-change-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/diff-change.ts src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-interop-rows.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/domain/diff/diff-change.ts src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-interop-rows.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
git add -A reports/api.json && npm run docs:json && git diff --exit-code reports/api.json
rm -rf dist .wireit && npm run check:size
```

### Commit

`feat(diff): break symlink-to-regular type changes under -B and report them broken`

## Part 13 — `-B` applies without rename detection

### Context

Edits:
- `src/application/primitives/detect-similarity-renames.ts`
- `src/application/primitives/diff-trees.ts`
- `src/application/commands/diff.ts`
- `test/unit/application/primitives/diff-trees.test.ts`
- `test/integration/rename-similarity-interop.test.ts`
- `reports/api.json` (regenerated — a public doc comment changes)

Surface (D-B (a)): no new public symbol. `detectBreakRewrites` is **internal** (not in
src/application/primitives/index.ts). The public `DiffOptions.renameOptions` doc
comment (diff.ts `:14`, "Only used when `detectRenames` is true") becomes: "Fine-tune
detection. `breakRewrites` also applies when `detectRenames` is off (git's
`--no-renames -B`); the other members only apply when it is on." → api.json.

- detect-similarity-renames.ts: `export async function detectBreakRewrites(ctx: Context,
  diff: TreeDiff, breakRewrites: { readonly score: number; readonly merge: number }):
  Promise<TreeDiff>` — git's `diffcore_break` then `diffcore_merge_broken` with no
  rename step: `attemptBreaks` (the Part 11/12 filter and guards), then each broken
  change is replaced IN PLACE by `rejoinBroken(record, mergeScore)`; every other change
  and the order are untouched (no halves ever surface). Reuse `resolveBreakGates` /
  the `runBreakPass` score default (`breakRewrites.score !== 0 ? … :
  DEFAULT_BREAK_SCORE`, `:773`) and the merge `0 → DEFAULT_MERGE_SCORE` mapping.
- diff-trees.ts `diffTrees` (`:83-107`): replace the ternary with a small private
  `detectChanges(ctx, rawDiff, a, options)`: `detectRenames === true` →
  `detectSimilarityRenames` (unchanged); else a `breakRewrites` object in
  `renameOptions` → `detectBreakRewrites`; else `rawDiff`. `withStat`/whitespace passes
  run after it as today.
- Row facts (probe above, peers `git diff --no-renames -B`, harness row
  `detectRenames: false`, `renameOptions: { breakRewrites: { score: 30000, merge: 36000 } }`):
  K1+moves → `M100 m ; A q ; A y ; D z`; partial rewrite → `M061 m`; same with
  `merge: 42000` (`-B50%/70%`, score 30000) → `M m`; N7b → `T100 p`; S0/S1 → `M e ; M s`;
  identical delete + add → `D ; A` (no pairing).

### TDD steps

1. RED — diff-trees.test.ts: `detectRenames` absent + `breakRewrites` on a fully
   rewritten ≥ 500-byte modify → `modify` with `broken.score === MAX_SCORE`; today plain.
   GREEN — `detectBreakRewrites` + routing.
2. RED — a re-merged pair (dissimilarity below `merge`) stays a plain `modify` without
   `broken`, and an add + delete with identical content stay unpaired. GREEN.
3. RED — a symlink→regular type change → `broken` datum, no blob read. GREEN (Part 12
   filter; confirm).
4. RED — isolated routing guards: `breakRewrites: false` and `renameOptions` absent
   both return the raw diff untouched (object identity of every change). GREEN.
5. Interop rows above; doc comment; `npm run docs:json`.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/diff-trees.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/commands/diff.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/detect-similarity-renames.ts src/application/primitives/diff-trees.ts src/application/commands/diff.ts test/unit/application/primitives/diff-trees.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/application/primitives/detect-similarity-renames.ts src/application/primitives/diff-trees.ts src/application/commands/diff.ts test/unit/application/primitives/diff-trees.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
git add -A reports/api.json && npm run docs:json && git diff --exit-code reports/api.json
rm -rf dist .wireit && npm run check:size
```

### Commit

`feat(diff): apply -B break detection without rename detection`

## Part 14 — a kept-broken modify counts as a complete rewrite

### Context

Edits:
- `src/domain/diff/stat-fields.ts`
- `src/application/primitives/diff-trees.ts`
- `test/unit/domain/diff/stat-fields.test.ts`
- `test/unit/application/primitives/diff-trees.test.ts`
- `test/integration/rename-similarity-interop.test.ts`

Surface: `computeRewriteStatFields` is **internal**: diff-trees.ts imports it from
the stat-fields module path, NOT from src/domain/diff/index.ts (whose `computeStatFields`
is public through src/public-types.ts). No api.json change. User doc bullet: Part 17.

- stat-fields.ts: `export const computeRewriteStatFields = (old: Uint8Array, next:
  Uint8Array, override?: BinaryOverride): StatFields` — `pairIsBinary(old, next,
  override)` → `{ 0, 0, binary: true }` (git: binary wins); else `{ added:
  countLines(next), deleted: countLines(old), binary: false }` with private
  `countLines(bytes)` = number of LF bytes + 1 when the content is non-empty and its last
  byte is not LF (git's `count_lines`). Line-key and blank options do not apply (git's
  `complete_rewrite` skips xdiff).
- diff-trees.ts:
  - private `isKeptBroken(change): boolean` = `change.type === 'modify' &&
    change.broken !== undefined`;
  - `applyStatPass` (`:189-222`): a kept-broken modify gets
    `computeRewriteStatFields(oldContent, newContent, file.numstatBinaryOverride)`;
    every other change keeps `computeStatFields(…)`;
  - the whitespace drop never drops a kept-broken modify (D-G (a)): `dropVerdict`
    (`:367`) and `changeShouldDrop` (`:341`) return `false` for it before any I/O.
- Row facts (probe above; peers `git diff --no-renames -B --numstat`). The harness's
  `runRenameRow` has no `withStat`: write one `it.each` block in the suite that builds
  each row with `buildRenameRow`, calls `diff(ctx, { …, withStat: true,
  renameOptions })` itself and reconstructs numstat locally as
  `${binary ? '-' : added}\t${binary ? '-' : deleted}\t${path}`): partial rewrite M061
  → `40 40`; re-merged (`merge: 42000`) → `25 25`; 40 lines → 30 without final LF →
  `30 40`; whitespace-only full rewrite → `40 40`, and with `ignoreWhitespace: 'all'`
  still `40 40` (peer `--numstat -B -w`); random 2000-byte rewrite → `- -`; 40 lines →
  empty → `0 40`; K1 with `-M -B` (`detectRenames: true`) → `40 40 m ; 0 0 m => q`.

### TDD steps

1. RED — stat-fields.test.ts: `computeRewriteStatFields` over text with and without a
   final LF, empty old / empty new, and a binary side. Fails: missing. GREEN.
2. RED — diff-trees.test.ts: `withStat` on a kept-broken modify returns full-rewrite
   counts (today the line-diff counts); a re-merged modify keeps line-diff counts.
   GREEN — the `applyStatPass` routing.
3. RED — `ignoreWhitespace: 'all'` on a kept-broken whitespace-only rewrite: kept, with
   and without `withStat` (two isolated rows, one per drop path). Today dropped.
   GREEN — the drop exemptions.
4. Interop numstat rows above.

### Gate

```
npx vitest run --project unit test/unit/domain/diff/stat-fields.test.ts test/unit/application/primitives/diff-trees.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/diff-whitespace-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/stat-fields.ts src/application/primitives/diff-trees.ts test/unit/domain/diff/stat-fields.test.ts test/unit/application/primitives/diff-trees.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/domain/diff/stat-fields.ts src/application/primitives/diff-trees.ts test/unit/domain/diff/stat-fields.test.ts test/unit/application/primitives/diff-trees.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size
```

### Commit

`fix(diff): count a kept-broken modify as a complete rewrite and keep it under whitespace modes`

## Part 15 — basename pass (issue #300 B)

### Context

Edits:
- `src/domain/diff/rename-pairing.ts`
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/domain/diff/rename-pairing.test.ts`
- `test/unit/domain/diff/rename-pairing.properties.test.ts`
- `test/unit/application/primitives/detect-similarity-renames.test.ts`
- `test/integration/rename-similarity-interop.test.ts`

Surface: internal.

- rename-pairing.ts: `export function uniqueBasenamePairs(sources:
  ReadonlyArray<RenameSource>, destinations: ReadonlyArray<AddChange>):
  ReadonlyArray<{ readonly source: number; readonly destination: number }>` — basename
  indexes over ALL given sources and destinations, every mode (a symlink sharing the
  basename makes it non-unique: N9, N9d); returns, in source order, the pairs whose
  basename occurs exactly once on each side. Byte-free (ADR-366).
- detect-similarity-renames.ts: `runBasenamePass` between the exact pass and the cull +
  limit gate (design §2.1 step 4, §4.3):
  - runs iff `copies === 'off' && broken.length === 0 && threshold < MAX_SCORE`
    (`broken` includes type-change records, B3t);
  - sources = registry sources with `uses === 0` after the exact pass; destinations =
    unpaired ones;
  - `minBasename = threshold + Math.trunc((MAX_SCORE - threshold) / 2)`;
  - for each candidate pair, in order: skip when either side is not a regular file;
    hydrate through `hydrateFingerprints(ctx, ids, fingerprints)` (Part 4 — the
    returned map is reused by the matrix); skip when `isSizeRejected(sf.size, df.size,
    minBasename)`; `score = estimateSimilarityFromMaps(…)`; `score >= minBasename` →
    record the pair (`uses[source]++`, destination paired);
  - NOT limited (B3l); the limit gate then counts the leftovers (L2); the matrix
    phase hydrates only the ids still missing from the map.
- blame reaches it unchanged (single-follow diff, one destination) — Part 16 pins it.
- Row facts (`-M`, design §3.2): B3 (a/foo.c edit 4 = 80%, a/bar.c edit 1 = 95% → b/foo.c =
  body) → `D bar.c ; R080 foo.c→foo.c`; B3l (`-l1`) → `R080` (unlimited); B3b (`-M -B`,
  nothing breakable) → `R080`; B3bb (B3 + a rewritten 40-line m.txt, `-M -B`) → `R095
  bar.c→foo.c ; M100 m.txt` (must stay ✓); B3bn (B3bb repo, `-M`) → `R080 ; M m.txt`;
  B3t (`-M -B`, Part 12, must stay ✓) → `D foo.c ; R095 bar.c→foo.c ; T100 t`;
  B3tn (B3t repo, `-M`) → `D bar.c ; R080 foo.c→foo.c ; T t`; B4 (foo.c 60% <
  75%) → `R095 bar.c` (✓); B5, B6, B7 (✓); B10 (B3 + b/zed.c tail edit 1) → `R080
  foo.c→foo.c ; R090 bar.c→zed.c`; L2 (`-l1`, basename pairs one, 1×1 leftover fits) →
  `R090 foo.c ; R099 x.c→y.c`; N9, N9d (✓, symlink breaks uniqueness).

### TDD steps

1. RED — rename-pairing.test.ts `uniqueBasenamePairs`: unique both sides → pair;
   duplicate on the source side → none; duplicate on the destination side → none; a
   non-regular entry still counts for uniqueness. GREEN.
2. RED — property (lens 2): the result never names a basename that occurs twice on
   either side, and every returned pair shares its basename. GREEN.
3. RED — primitive B3, B3l, B10, L2 unit rows: fail (matrix picks bar.c). GREEN —
   `runBasenamePass`.
4. RED — isolated gate rows on the B3 fixture, one condition flipped each: `copies: 'on'`
   → matrix result; a broken modify present → matrix result; a broken type change
   present → matrix result; `threshold: MAX_SCORE` → exact only. Plus the `minBasename`
   boundary: score === minBasename pairs, minBasename − 1 falls to the matrix. GREEN.
5. Interop rows (fixed + must-stay), both suites in full.

### Gate

```
npx vitest run --project unit test/unit/domain/diff/rename-pairing.test.ts test/unit/domain/diff/rename-pairing.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts test/unit/application/commands/blame.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts test/integration/blame-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/rename-pairing.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/rename-pairing.test.ts test/unit/domain/diff/rename-pairing.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/domain/diff/rename-pairing.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/rename-pairing.test.ts test/unit/domain/diff/rename-pairing.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size
```

### Commit

`fix(diff): pair same-basename renames first like git's basename pass`

## Part 16 — blame follows the basename-pass source

### Context

Test only (D-E (a)): the behaviour lands in Part 15; this part pins it on the blame
surface, which Part 15 cannot hold within the file ceiling. Edits:
- `test/unit/application/commands/blame.test.ts`
- `test/integration/blame-interop.test.ts`

- blame's `renamedSource` (src/application/commands/blame.ts `:519`, `:548`) calls
  `detectSimilarityRenames(ctx, singleFollowDiff(diff, path))`: one destination, every
  delete a source, so the basename pass runs (design §2.3, BL1).
- blame-interop.test.ts: add a fixture in the `beforeAll` (model: the
  `inexactCompetition` block `:264-283`, `makeRepo`/`commitContent`/`datedEnv`): commit 1
  a/foo.c = body (20 lines `body line i`) edited on its first 4 lines, a/bar.c = body
  edited on its first line; commit 2 removes both and adds b/foo.c = body. Add a
  `BLAME_PORCELAIN_MATRIX` row (`:388-414` style) for b/foo.c. git blames lines 5–20 to
  a/foo.c; today tsgit follows a/bar.c.
- blame.test.ts: the same shape through the memory context, "Given a deleted source
  whose basename matches the blamed path competing with a more similar one" → the
  followed source path is the basename match.

### TDD steps

1. Add the blame-interop row (live git porcelain vs reconstructed tsgit porcelain) and
   the blame unit row. Both pass on Part 15's code. Prove they are real pins: comment
   out the `runBasenamePass` call locally, run both, observe them fail (tsgit follows
   a/bar.c), restore the call. Never commit the edit; never check out another commit.

### Gate

```
npx vitest run --project unit test/unit/application/commands/blame.test.ts
npx vitest run --project integration test/integration/blame-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check test/unit/application/commands/blame.test.ts test/integration/blame-interop.test.ts
npx cspell --no-progress test/unit/application/commands/blame.test.ts test/integration/blame-interop.test.ts
npm run check:test-pyramid
```

### Commit

`test(blame): pin the rename source blame follows against git's basename pass`

## Part 17 — user docs for rename-detection parity

### Context

Docs only (D-F (a)). Edits:
- `docs/use/commands/diff.md`
- `docs/use/primitives/diff-trees.md`

diff.md:
- `RenameDetectOptions` knobs block (`:22-30`): drop the `copyThreshold?` line;
  `threshold?` reads "rename and copy similarity gate (git's `-M<n>` / `-C<n>`)";
  `breakRewrites?` adds "applies with or without `detectRenames` (git's `-B` alone
  breaks and rejoins, it never pairs)".
- Signature comment for `renameOptions` (`:14`): match the Part 13 doc comment.
- Data guarantees (`:95-115`), after the `modify … broken` bullet:
  - "A `type-change` may carry `broken` when `-B` broke a symlink↔regular type change
    and its halves rejoined; `score` is always `MAX_SCORE` (git prints `T100`). A broken
    type change whose new side pairs elsewhere is replaced by that rename/copy, as in
    git."
  - "Under `copies`, a deleted source paired k times yields k−1 `copy` changes and one
    `rename`, the rename being the last in path order; a source the diff keeps (modified
    or unchanged) only yields copies. Renames are chosen before copies over one
    candidate list, as in git."
  - "Symlinks, gitlinks and trees pair only exactly (identical content and mode); they
    are never similarity-scored, but still count toward `limit`."
  - "With `withStat`, a kept-broken `modify` counts every old line deleted and every
    new line added (git's complete-rewrite numstat), and `ignoreWhitespace` never drops
    it."
  - basename: "Under plain `-M`, a delete and an add sharing a unique file name pair
    first when their similarity reaches the midpoint between `threshold` and 100%."
diff-trees.md `:13`, `:28`: drop `copyThreshold`.

### TDD steps

1. Edit the two pages; `grep -rn copyThreshold docs/use` is empty.

### Gate

```
npx cspell --no-progress docs/use/commands/diff.md docs/use/primitives/diff-trees.md
npm run check:doc-coverage
npm run check:doc-links
```

### Commit

`docs(diff): document rename-detection parity data guarantees`

## Shared files across parts

Parts 4–15 edit detect-similarity-renames.ts and its unit suite, and Parts 5–8 and 15 edit
rename-pairing.ts, in sequence: each part rewrites the previous one's intermediate shape
in the same tree. They stay separate because each part is at or near the ~5-cycle /
6-file ceiling and each lands a distinct git-parity fix with its own interop rows; merging
any two would exceed the ceiling. The interop suites are shared infrastructure (ADR-905).

## Phase gate

`npm run validate` (after Part 17), then `check:doc-typedoc` via prepush.
