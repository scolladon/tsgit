# Plan — diff core parity hardening: lying loose sizes, xdiff line diff, fingerprint scoring

> Source: design doc `docs/design/diff-core-parity-hardening.md` · ADRs 907, 908, 909, 910, 911, 912
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
  plain text. A regenerated artifact (reports/api.json from `npm run docs:json`) is
  written in plain text: it is committed but never authored.

## Conventions every part follows

- Tests: `describe('Given …')` > `describe('When …')` > `it('Then …')` (or the 2-level
  `Given …, When …` shortcut for one expectation), AAA section comments, the system
  under test bound to `sut`. Error assertions check the error's data (code, reason),
  never the class alone. Guard clauses get one isolated test per condition.
- Test titles, row labels and comments describe the scenario in words. They never carry
  a design row id (`L4`, `S1`, `A2`), a part number or an ADR number (no provenance refs
  in src or tests). Row ids appear in this plan only.
- New interop rows compare tsgit against **live git** (scrubbed env through the
  interop-helpers `runGit`/`runGitEnv`, signing off). Never copy the
  `try { expect(golden) } catch { saveGolden }` pattern; never hard-code git's answer
  where the row can run git.
- Git source for every transcription is tag `v2.55.0`. Fetch read-only into a
  `mktemp -d` dir, never into the worktree:
  `curl -sfL https://raw.githubusercontent.com/git/git/v2.55.0/xdiff/<file>` for
  xprepare.c, xdiffi.c, xutils.c, xmerge.c, xdiff.h, xtypes.h, and
  `…/v2.55.0/diffcore-delta.c`, `…/v2.55.0/object-file.c`.
- No suppression directives. Every existing `Stryker disable` comment in code a part
  rewrites is re-triaged: delete it when the restructure removed the mutant, keep it
  (with a still-true reason) only when the mutant is still provably equivalent.
- Never touch the untracked `vitest.narrow.ts` / `stryker.narrow.config.mjs`.
- Commits: one line, conventional, no body, no AI trailers. Commit only on a green part
  gate. Every commit must also keep `npm run validate` green and must never turn a row
  that matches git at the previous commit into a mismatch. An existing row whose
  expectation moves is re-derived from live git in the same commit, never edited to fit;
  a row that matched git and stops matching is a blocker (`{ unit, reason, ≤3 options }`).
- Figures (bench deltas, bundle sizes, L1 wall/RSS) go in the part's handoff report —
  commit messages carry no body.
- Bundle (ADR-904): every part with a `src/` delta runs
  `rm -rf dist .wireit && npm run check:size && npm run check:tarball`. A crossed limit
  in `.size-limit.json` rises to the measured gzip size + 0.25 kB in the same commit —
  **only for git-mandated growth** (Parts 2–13 and 16; Part 8's classification is the
  first slice of the ADR-909 transcription). Parts 14 and 15 (typed fingerprints, break
  reuse) must be size-neutral on every entry (ADR-912, D-I); if they are not after
  trimming, stop and escalate with the measured delta.
- Benchmarks: quiet-machine check first (`uptime` load below the core count, no foreign
  `stryker` process, no other session benching). `npm run bench:ab -- <base> <head>`
  compares COMMITTED refs and runs every bench file both refs share: run it after the
  part's commit, then read back only the rows of the bench files the part names.
- Public surface (surface-gates.md): the only new PUBLIC member in this plan is the
  `Compressor` port's `inflateHead` and `inflate`'s optional cap (Part 2). Every other
  new export is INTERNAL: never add it to a barrel (src/domain/diff/index.ts,
  src/domain/objects/index.ts, src/ports/index.ts, src/application/primitives/index.ts,
  src/public-types.ts). Public doc-comment edits regenerate reports/api.json
  (`npm run docs:json`) in the same commit — it is a prepush gate, not a validate gate.

## Landing order (decided) and why

| Part | Lands | Design source | Independent of |
|---|---|---|---|
| 1 | bench infra: line-diff micro-bench + `rewrite` rename shape (test infra) | §7, C0 | — (must precede 8–15) |
| 2 | `Compressor` port: capped `inflate` + truncating `inflateHead` | A1 | 7–16 |
| 3 | loose buffered read refuses an overrun past the header window | A2 (slice) | 7–16 |
| 4 | loose buffered read truncates an overrun inside the window | A2 (slice) | 7–16 |
| 5 | `diff -w` drop predicate reads loose blobs through the buffered tier | new (D-C) | 7–16 |
| 6 | `fsck` reports size-lying loose objects like git | ADR-907 decision | 7–16 |
| 7 | merge: touching change regions conflict like `xdl_merge` | new (D-A) | 2–6, 12–16 |
| 8 | xdiff line classification (integer class ids) | B2 → B1 (moved) | 2–6, 12–16 |
| 9 | xdiff change compaction + indent heuristic | B1 | 2–6, 12–16 |
| 10 | xdiff divide-and-conquer split replaces the bounded Myers | B2 (slice) | 2–6, 12–16 |
| 11 | xdiff record cleanup (trim + multi-match discard) | B2 (slice) | 2–6, 12–16 |
| 12 | spanhash bucket sum wraps to 32 bits | C1 | 2–11, 16 |
| 13 | spanhash skips the CR of CRLF in text | C2 | 2–11, 16 |
| 14 | typed fingerprints + merge scan | C3 | 2–11, 16 |
| 15 | `-B` fingerprints reused by the rename matrix | C3 (§4.3.6 slice) | 2–11, 16 |
| 16 | `withStat` recurses before rename detection (directory rename) | new (surfaced gap) | **every other part** |
| 17 | user docs | A2, B2, docs bullets | runs last |

Part 16 is fully independent: it touches only src/application/primitives/diff-trees.ts,
two public doc comments and their tests, and may be executed out of order (for example by
a separate review batch) at any point before Part 17. Parts 2–6 (item 1), 7–11 (item 2)
and 12–15 (item 3) are three independent chains; within a chain the order is binding.

Shared files across parts (plan-lint's cognitive-locality warnings, answered): the
parts that share src/domain/diff/line-diff.ts (8–11), object-resolver.ts (3–4),
similarity.ts and detect-similarity-renames.ts (12–15), loose-header-size-interop (3–6),
line-diff-xdiff-interop (9–11), rename-similarity-interop (12–13) and
three-way-content.test.ts (7, 10) are sequential slices of one chain on one working
tree. Each slice is a separately verifiable git-parity step with its own interop rows;
merging any two exceeds the 6-file ceiling or the ~5-cycle budget, and several must land
in this order for no matching row to regress (table below).

Ordering constraints, re-verified against the code:

| Constraint | Why | Forces |
|---|---|---|
| bench scenarios exist before the parts they measure | `bench:ab` compares only scenarios both refs share | 1 < 8–15 |
| port before the resolver uses it | the resolver calls `inflateHead` and the capped `inflate` | 2 < 3 |
| overrun refusal before window truncation | the buffered helper and its routing land first | 3 < 4 |
| buffered helper before the predicate and fsck use it | Parts 5 and 6 import it | 3 < 5, 6 |
| merge adjacency before the engine switch | after Part 10 the `degraded` whole-file conflict is gone; a whole-file rewrite touching a theirs-append would merge clean (git: conflict) unless touching regions already conflict | 7 < 10 |
| classification before compaction | `recs_match` compares class ids | 8 < 9 |
| compaction before the engine switch | switching the engine without compaction would move today's matching patch rows | 9 < 10 |
| split before cleanup | cleanup first would flip the `degraded` tests twice (see D-G) | 10 < 11 |
| hash + CRLF fixes before the typed rewrite | the rewrite's oracle is the corrected `Map` scorer (ADR-911) | 12, 13 < 14 |
| typed fingerprints before break reuse | the reused value is the typed fingerprint | 14 < 15 |

Interim states that are deliberately git-divergent but never regress a matching row:

- Part 3: a size liar whose whole object fits git's 32-byte window is still served in
  full (git truncates) until Part 4.
- Part 10: the split runs without record cleanup; the numstat of very large or
  multi-match-heavy inputs differs from git until Part 11 (it differed before too).
- Parts 12–13: the fingerprint is still a `Map`; only its values change.

## Probe facts verified for this plan

git 2.55.0, every `GIT_*` unset, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
isolated `HOME`, `mktemp -d` repos. The tsgit column is a scratch esbuild bundle of
`git archive HEAD src` at the planning HEAD.

**Directory rename (Part 16).** `oldname/{inner.txt, sub/deep.txt}` moved to `newname/`:

| Command | git output |
|---|---|
| `diff-tree -M` (raw, no `-r`) | `:040000 040000 <t> <t> R100 oldname newname` (one directory row) |
| `diff-tree -M --name-status` | `R100 oldname newname` |
| `diff-tree -M --numstat` and `diff-tree -M -r --numstat` | `0 0 {oldname => newname}/inner.txt ; 0 0 {oldname => newname}/sub/deep.txt` (recursed, paired per leaf) |
| `diff-tree -M -p` | two leaf `similarity index 100%` renames |
| `diff-tree --numstat` (no `-M`) | leaf adds/deletes `1 0 ; 2 0 ; 0 1 ; 0 2` |
| `diff --numstat`, `diff -M --name-status` | leaf renames (porcelain `diff` recurses) |
| dir moved AND `inner.txt` edited, `diff-tree -M` raw | `D newname ; A renamed2` (trees differ: no directory pairing) |
| same, `diff-tree -M --numstat` | `1 0 {newname => renamed2}/inner.txt ; 0 0 {newname => renamed2}/sub/deep.txt` (similarity pairing on leaves) |

So a content-reading output format (`--numstat`, `--stat`, `-p`) makes git recurse
**before** rename detection (diff.c sets `flags.recursive` for any format beyond
raw/name/name-status); pairing then runs on leaves. tsgit's `withStat` is that format.

**Size-lying loose blob, fsck (Part 6)** (`blob <claim>\0` + digits, stored at the
SHA-1 of the stored bytes):

| claim / body | `git fsck` stderr | hash git reports |
|---|---|---|
| 6 / 10, 6 / 25 (fits 32 bytes) | `<sha>: hash-path mismatch, found at: …` | SHA-1(`blob 6\0` + first 6 body bytes) — truncated |
| 6 / 26, 6 / 40 (past 32 bytes) | `corrupt loose object '<oid>'`, `unable to unpack contents of …`, `<oid>: object corrupt or missing: …` | — |
| 20 / 10 (under-run) | `<sha>: hash-path mismatch …` | SHA-1(`blob 20\0` + 10 body bytes + 10 NUL bytes) — zero-padded |

Exit status carries bit 1 in every row; pin the exact exit code from the live run.

**Line-diff consumers on the design's L4 / L5 inputs.** L4: `a` = `f f f f`,
`b` = `u1 u2 u3 u4 f u5 u6 u7`. L5: `a` = `a b c d e`, `b` = `a b c X d c d e`.

| Row | git | tsgit today |
|---|---|---|
| blame L5 (`git blame -s`, parent `a`, child `b`) | lines 4–6 (`X d c`) new, line 7 `d` old | lines 4, 6, 7 new, line 5 old ✗ |
| blame L4 | all 8 lines new (the `f` is discarded) | line 5 `f` old ✗ |
| merge-file base `a b c d e`, ours L5 `b`, theirs `a b c d E` | clean `a b c X d c d E` | conflict ✗ |
| same, theirs `a b c Y d e` | conflict `X d c` / `Y`, then `d e` | conflict `X` / `Y`, then `d c d e` ✗ |
| merge-file base `f f f f`, ours L4 `b`, theirs `f f f f g` | conflict, whole file | clean `u1…u7 g` ✗ |

**Merge adjacency (Part 7)** — `git merge-file -p` against tsgit `mergeContent`, base
`a b c`:

| ours / theirs | git | tsgit today |
|---|---|---|
| `a b X` / `a b c d` (change last line vs append) | conflict `X` / `c d` | clean `a b X d` ✗ |
| `a X c` / `a b Y` (adjacent lines) | conflict `X c` / `b Y` | clean `a X Y` ✗ |
| `X b c` / `Y a b c` (change first vs prepend) | conflict `X` / `Y a` | conflict ✓ |

git's `xdl_do_merge` (xmerge.c:548, :563) separates two changes only when
`i1 + chg1 < other.i1`: a change ending exactly where the other starts **overlaps**.
tsgit's `rangesOverlap` (src/domain/merge/region-merge.ts:75) uses half-open ranges, so
touching changes merge clean.

**xdiff source facts that correct the design text:**

- `xdl_cleanup_records` runs even with `XDF_NEED_MINIMAL`; `need_min` only sets
  `mlim` to infinity (xprepare.c:291-299), so no-match lines are always discarded.
- `mlim` is computed per side from that side's own record count
  (`bogosqrt(xdf1->nrec)`, `bogosqrt(xdf2->nrec)`), capped at 1024; the match count of a
  line in file 1 is its class's `len2` (occurrences in file 2), and vice versa.
- `xdl_clean_mmatch` (xprepare.c:194): window 100 each side; returns false when the run
  before OR after holds no `DISCARD`; else `rpdis * 4 < rpdis + rdis` over both runs,
  with `rpdis` starting at 1 on each side.
- `xdl_do_diff` (xdiffi.c:314): `ndiags = nreff1 + nreff2 + 3`, one K-vector buffer of
  `2 * ndiags + 2`, `mxcost = max(bogosqrt(ndiags), 256)`, `snake_cnt = 20`,
  `heur_min = 256`; `xdl_recs_cmp` (xdiffi.c:265) shrinks the box by matching ids at
  both ends, marks the rest changed when one side empties, else `xdl_split` and recurse.
- Classification (xprepare.c:97) assigns class ids in first-appearance order across file
  1 then file 2 and counts `len1`/`len2` per class; the hash only picks a bucket, the
  byte comparison decides equality, and a record includes its trailing LF (a last line
  without LF is a different record).
- Compaction runs once per side (xdiffi.c:1098-1099): `xdl_change_compact(xdf1, xdf2)`
  then `(xdf2, xdf1)`; the functions sit at xdiffi.c:386-973 (`recs_match` :386,
  `get_indent` :404, `measure_split` :481, penalty constants :534-576, `score_add_split`
  :588, `score_cmp` :666, groups :690-790, `xdl_change_compact` :793).

## Decision candidates

Load-bearing choices ADRs 907–912 do not pre-decide. The plan is written with the
recommendation applied; the orchestrator confirms or redirects before implementation.

- **D-A — merge adjacency (surfaced gap).** tsgit merges touching change regions clean;
  git conflicts. Without a fix, Part 10 regresses a merge that matches git today only
  through the `degraded` guard (three-way-content.test.ts "ours diff degrades while
  theirs only appends one line": git conflicts, post-switch tsgit would merge clean).
  (a) *recommended, applied*: Part 7 transcribes `xdl_do_merge`'s separation test
  (touching overlaps) before the engine switch, pinned by merge-conflict-interop rows.
  (b) Defer to its own design; Part 10 escalates the regressed row and the user accepts
  the interim divergence. (c) Keep a whole-file conflict when either diff "would have
  degraded" (re-creates the ADR-563 bail inside merge; contradicts ADR-909).
- **D-B — memory/browser capped `inflate` and `inflateHead`.** Today both adapters'
  `inflate` run native `DecompressionStream` with **no** cap (the design's "already call
  `inflateZlibMember(…, cap)`" holds for `streamInflate` only). (a) *recommended,
  applied*: a cap given → the zero-dependency `inflateZlibMember` (already the
  `streamInflate` path); no cap → native stream as today; `inflateHead` → a truncating
  mode of the same decoder. One decoder for every bounded read, no stream-teardown
  hazard on workerd; cost: capped loose reads in the browser use the JS decoder.
  (b) Native `DecompressionStream` with a counting reader that cancels past the cap for
  both members (native speed; cancelling mid-stream is the workerd hazard the adapters
  already guard `pumped` against). (c) Hybrid: head via the JS decoder, capped full
  inflate via the counting native reader.
- **D-C — the `diff -w` drop predicate (no `withStat`).** It reads blobs through
  `openBlobSource` (the streamBlob machinery), so a size liar is served in full there —
  git's diff reads it through the buffered tier, and the unbounded inflate stays
  reachable through `diff -w`. (a) *recommended, applied*: Part 5 gives `openBlobSource`
  a `LooseReadMode` and the predicate asks for `'buffered'`. (b) Record as residual.
  (c) Make every `openBlobSource` bytes-arm read buffered (breaks `streamBlob`'s
  streaming-tier contract).
- **D-D — `readObjectMetadata` / `readObjectMetadataWithContent` (tag peeling, deltify).**
  Their loose fallback goes through `readRawObject`, which becomes buffered by default.
  (a) *recommended, applied*: they read `'streamed'` — ADR-863's DC-A2
  ("readObjectMetadata stays content-derived", pinned by read-object-metadata.test.ts
  "Given a loose blob whose header size claim disagrees with its body length") carries
  forward; `gc`/`repack` of an overrun blob keeps packing its real bytes (git's
  pack-objects dies) — residual R2. (b) Buffered: flips the pinned test, `repack`
  refuses like git, tag peeling of an overrun blob refuses where git's header-tier type
  read succeeds. (c) Header-claim size + buffered content (two reads).
- **D-E — fsck representation of a size liar.** (a) *recommended, applied*: past the
  window → the existing undecodable finding (`bad-object`, `objectType: 'unknown'`,
  `msgId: 'unterminatedHeader'`, `EXIT_CORRUPT` — git prints the same "object corrupt or
  missing" line it prints for a zlib-corrupt file); inside the window or under-run →
  `hash-mismatch` whose `actual` is git's truncated / zero-padded hash; an under-run
  whose claim exceeds the inflate ceiling (2 GiB) → the undecodable finding, never
  hashing gigabytes of padding. (b) A new `msgId` for "content exceeds declared size".
  (c) Zero-pad any claim (hostile claims hash up to 2^53 bytes of zeros).
- **D-F — where the xdiff consumer rows live.** (a) *recommended, applied*: one new live-git
  suite `test/integration/line-diff-xdiff-interop.test.ts` holding numstat, patch,
  blame, merge and patch-id rows for the L-shaped inputs (Parts 9–11 each add rows).
  Spreading them over diff-patch-git-parity, blame-interop and merge-interop puts every
  engine part at 7–9 files. (b) Rows in the per-command suites; each engine part splits
  again. (c) Pin only numstat/patch at interop level and blame/merge in unit tests
  (loses the live-git proof ADR-909 demands for blame and merge).
- **D-G — engine landing order.** (a) *recommended, applied*: the split (Part 10) before
  the cleanup (Part 11). The split's heuristics fire only above 256 edit cost; no pinned
  row is that large. (b) Cleanup first: disjoint-line inputs stop degrading, so every
  `degraded` test (line-diff, three-way-content) must be rebuilt to still degrade, then
  deleted one part later. (c) One engine part at 9 files (breaks the ceiling).
- **D-H — the size gate's header-claim read** (`readDeclaredObjectSize`, a
  `createInflateStream` probe measured at ~55 µs against ~2 µs for `inflateHead`).
  (a) *recommended, applied*: follow-up F5, out of this plan. (b) Fold into Part 3.
- **D-I — size rule for the break-reuse part.** ADR-912's size neutrality names the typed
  rewrite; break reuse (design §4.3.6) is the same non-git-mandated perf growth.
  (a) *recommended, applied*: Part 15 must be size-neutral too, else escalate.
  (b) Only Part 14 is bound; Part 15 bumps under ADR-904.

Settled here, flagged for review (not decisions):

- The design's `LOOSE_HEADER_WINDOW` branch is simplified: after the 33-byte head, ONE
  capped inflate at `max(32, headerLen + claim)` covers every case. The whole object
  fitting 32 bytes never hits the cap; an overrun past 32 always does; an under-run
  returns short. A truncated or corrupt stream still throws from that capped call, so a
  small truncated loose file keeps refusing exactly as today (the design's "one
  `inflateHead` call only" variant would have served it).
- A cap hit is remapped to `INVALID_OBJECT_HEADER` (`content exceeds declared size
  <claim>`) only when `headerLen + claim` is below the port's inflate ceiling
  (`MAX_INFLATE_OUTPUT_BYTES`, 2 GiB, Part 2); above it the adapter's own cap fired, so
  `DECOMPRESS_FAILED` propagates unchanged (today's behaviour for a >2 GiB object).
- Hunks from the new engine list, per change group, the `ours-only` hunk before the
  `theirs-only` hunk (git prints `-` before `+`). Today's greedy trace can emit an
  insertion run before a deletion run inside one replacement.
- The empty-versus-empty quirk (`diffLines` of two empty inputs returns one zero-length
  `common` hunk) is preserved; three consumers rely on a non-empty hunk list.
- `degraded` stays on the public `LineDiff` (always `false`) and
  `MAX_DIFF_EDIT_DISTANCE` stays exported with a DEPRECATED comment, like its three
  siblings, so no public symbol disappears.
- Residuals recorded (not in this plan): R1 under-run blobs are served, not zero-padded
  (ADR-863 residual); R2 D-D (b); R3 `verifyStoredObject` (ref-target hash check) keeps
  its streamed read; R4 xmerge's zealous conflict refinement (xmerge.c:392,
  `xdl_refine_conflicts`) versus tsgit's `trimCommonEdges`; F3 the `diff`/`binary`
  attribute for the CRLF text decision (checked in Part 13); F4
  `diff.indentHeuristic`/`--minimal`/algorithm options (ADR-910); F5 D-H.

## Part 1 — bench infra: line-diff micro-bench and the full-rewrite rename shape

### Context

Test infra only, no src delta (template exception). It lands first because
`npm run bench:ab` compares only scenarios both refs share: the base ref of every
xdiff part (8–11) and every fingerprint part (12–15) must already carry them.

Edits:
- `test/bench/line-diff.bench.ts` (new)
- `test/bench/support/fixture-generator.ts`
- `test/bench/diff-renames.bench.ts`
- `tooling/bench-memory.ts`

Line-diff micro-bench (pure domain, no fixture): `benchScenario(given, whenThen, build)`
from test/bench/support/bench-dsl.ts; `build` returns `{ sut }` (no teardown needed).
Inputs are built once at module load from a seeded xorshift — export the existing
`makeXorshift32` (fixture-generator.ts `:340`, module-private today) and reuse it — and
encoded to `Uint8Array`:
- small: 200 lines, 3 lines edited — `diffLines(a, b)` (src/domain/diff/line-diff.ts);
- medium: 5 000 lines, 20 scattered edits — `diffLines`;
- patch: the medium pair through `computeHunks(a, b, 3)` (src/domain/diff/patch-serializer.ts);
- blame hop: the medium pair pre-split through `diffPresplitLines`;
- merge: 300-line base, ours and theirs each editing disjoint regions — `mergeContent`
  (src/domain/merge/three-way-content.ts);
- large: 50 000 lines, 1 % of lines rewritten — `diffLines` (the cost-cap watch).
Titles: `Given …` / `When diffLines compares …, Then measure tsgit`. Do not add the file
to docs/perf/hot-paths.json.

Rename shape `rewrite` (fixture-generator.ts `:986` `RenameFixtureShape`, builders
`:1017-1146`, `RENAME_FIXTURE_STREAMS` `:1143`): 100 paths `rewrite/f%03d.bin`, each a
distinct 256 KiB seeded-random blob (`blobContent` or a new seeded helper), then every
path rewritten in full in `HEAD` with fresh random bytes (a different seed). Add
`'rewrite'` to the union and a `streamRewriteRenameFastImport` builder beside
`streamHostileRenameFastImport`. The cache key already includes the shape
(`renameFixtureCacheDir`); do not bump `FIXTURE_GENERATOR_VERSION`.

diff-renames.bench.ts: `SHAPE_GIVEN.rewrite = 'Given a rewrite repo (100 × 256 KiB files
rewritten in full)'`; the rewrite scenarios call `repo.diff({ from: 'HEAD~1', to: 'HEAD',
recursive: true, detectRenames: true, renameOptions: { breakRewrites: { score: 30000,
merge: 36000 } } })` with a `WHEN_THEN` naming `-M -B`; the three existing shapes keep
their call unchanged. Update the header comment's shape list.

bench-memory.ts: a `rename-break-rewrite` workload beside `runRenameHydrationWorkload`
(`:343-370`), same polling shape, over `ensureRenameFixture('rewrite', 'loose')` with the
`-M -B` call above; register it next to the rename-hydration workload and add the line to
the header usage comment.

### TDD steps

1. Add the line-diff bench; run it once:
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/line-diff.bench.ts`.
   Record the medians — they are the xdiff baseline.
2. Add the `rewrite` shape + scenarios; run
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/diff-renames.bench.ts`
   (builds and caches the fixture). Record the `rewrite` loose/packed medians.
3. Add the memory workload; `npm run bench:memory`; record the `rename-break-rewrite`
   peak RSS (fingerprint-memory baseline for Parts 14–15).

### Gate

```
npx vitest bench --run --config vitest.bench.config.ts test/bench/line-diff.bench.ts test/bench/diff-renames.bench.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check test/bench/line-diff.bench.ts test/bench/support/fixture-generator.ts test/bench/diff-renames.bench.ts tooling/bench-memory.ts
npx cspell --no-progress test/bench/line-diff.bench.ts test/bench/support/fixture-generator.ts test/bench/diff-renames.bench.ts tooling/bench-memory.ts
npm run check:test-pyramid
npm run check:dead-code
```

### Commit

`chore(bench): add line-diff micro-benchmarks and a full-rewrite -M -B rename shape`

## Part 2 — `Compressor` port: capped `inflate` and truncating `inflateHead`

### Context

ADR-908. Public surface change (port members; users implement adapters): BREAKING for
third-party `Compressor` implementations → `!`. Surface gates: src/ports/index.ts
re-exports `type { Compressor }` only — no barrel edit; regenerate reports/api.json
(`npm run docs:json`); no command, facade, doc-coverage or README-count change.

Edits:
- `src/ports/compressor.ts`
- `src/adapters/node/node-compressor.ts`
- `src/adapters/memory/memory-compressor.ts`
- `src/adapters/browser/browser-compressor.ts`
- `src/adapters/inflate.ts`
- `test/unit/ports/compressor.contract.ts`

Port (compressor.ts, interface at `:8-55`):
- `inflate: (data: Uint8Array, maxOutputBytes?: number) => Promise<Uint8Array>` —
  document the cap with the same contract paragraph as `streamInflate` (`:30-41`): a
  caller can narrow, never widen, the adapter cap; the abort is incremental; a cap hit
  throws `DECOMPRESS_FAILED` with reason `INFLATE_CAP_EXCEEDED_REASON`.
- `inflateHead: (data: Uint8Array, maxOutputBytes: number) => Promise<Uint8Array>` — at
  most `maxOutputBytes` leading output bytes; **never throws at the cap** (truncates);
  throws `DECOMPRESS_FAILED` only on input corrupt within the bytes it decodes; a
  complete short stream returns its whole output.
- New value exports (INTERNAL — do not add to src/ports/index.ts):
  `INFLATE_CAP_EXCEEDED_REASON = 'inflated output exceeds safety cap'` and
  `MAX_INFLATE_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024`. REFACTOR: node-compressor.ts
  (`MAX_INFLATED_OBJECT_BYTES` `:26`, the literal reasons `:211`, `:285`) and inflate.ts
  (`MAX_INFLATED_OUTPUT_BYTES` `:55`, the literal `:381`) import them instead of
  restating them. pack-byte-source.ts keeps its own copy until Part 3.

Node (node-compressor.ts, class `NodeCompressor` `:120`):
- `inflate` (`:184-190`): `maxOutputLength: this.effectiveCap(maxOutputBytes)` (the
  private clamp at `:129`); map node's `RangeError` with `code === 'ERR_BUFFER_TOO_LARGE'`
  to `decompressFailed(INFLATE_CAP_EXCEEDED_REASON)`; every other error keeps
  `describeError` (`:18`). node rejects `maxOutputLength < 1`: the resolver never asks
  for less than 32, and the contract's exact-bound case uses non-empty data.
- `inflateHead`: named constant `HEAD_PROBE_INPUT_BYTES = 32`; loop
  `n = HEAD_PROBE_INPUT_BYTES, ×4` while `n < data.length`:
  `inflateSync(data.subarray(0, n), { finishFlush: constants.Z_SYNC_FLUSH })`, stop once
  the output reaches `maxOutputBytes` or the input is exhausted (last pass with the whole
  `data`); return `toResultView(out).subarray(0, maxOutputBytes)`. A zlib header needs
  2 bytes and a dynamic block header can exceed 30, hence the growth loop. Map errors to
  `decompressFailed(describeError(err))`.

Memory and browser (D-B (a)):
- `inflate(data, maxOutputBytes?)`: `maxOutputBytes === undefined` → today's native
  `DecompressionStream` path unchanged; otherwise
  `inflateZlibMember(data, 0, boundedInflateCap(maxOutputBytes)).output`.
- `inflateHead(data, max)`: `inflateZlibHead(data, 0, max)` (below).
- The browser class uses method syntax (`async inflate(…)`), the memory class arrow
  properties — keep each file's style.

inflate.ts (`inflateZlibMember` `:888`, `GrowableBuffer` `:309`,
`ensureCapacity` `:379`):
- New export `inflateZlibHead(bytes, offset, maxOutputBytes): Uint8Array`. The
  `GrowableBuffer` constructor takes an overflow policy object
  `{ readonly onOverflow: 'refuse' | 'truncate' }` (no boolean): `'refuse'` is today's
  throw; `'truncate'` appends up to `maxBytes`, then throws a module-private
  `HeadComplete` sentinel. `inflateZlibHead` catches exactly that sentinel (identity
  check, anything else rethrows) and returns the first `maxOutputBytes` bytes without a
  trailer check. A stream that ends before the cap verifies its adler32 trailer as today
  and returns its whole output. No per-symbol check is added to the decode loop (hot
  path).

Contract (compressor.contract.ts `compressorContractTests`, run by
test/unit/adapters/node/node-compressor.test.ts and
test/unit/adapters/memory/memory-compressor.test.ts — no edit there). New cases, each
asserting the error's `code` and `reason`:
- `inflate(deflate(64 KiB), 1024)` rejects `DECOMPRESS_FAILED` / cap reason;
- `inflate(deflate(x), x.length)` returns `x` (bound exactly at the size);
- `inflateHead(deflate(x), 33)` on a 20-byte `x` returns `x` whole;
- `inflateHead` on a 1 MiB highly compressible and a 1 MiB incompressible `x` returns
  exactly the first 33 bytes;
- `inflateHead` of garbage rejects `DECOMPRESS_FAILED`;
- property (fast-check, `numRuns` 50): for arbitrary bytes `d` and `k` in `[1, 256]`,
  `inflateHead(deflate(d), k)` equals `d.subarray(0, k)` — the port law, checked on every
  adapter.
BrowserCompressor is excluded from unit coverage (vitest.config.ts coverage include);
its members are exercised by the browser e2e suite (test/browser) — no unit file added.

Bench: none in-part (the loose read paths that consume this land in Part 3).

### TDD steps

1. RED — contract cap case: fails on node (`inflate` ignores the second argument) and
   on memory (native stream, no cap).
2. GREEN — node `inflate` cap + error mapping; memory/browser `inflate` routing.
3. RED — `inflateHead` contract cases: `tsc` fails (member missing on the port).
4. GREEN — port member; `inflateZlibHead` + truncate policy; node prefix loop; memory
   and browser delegate.
5. RED/GREEN — the head property; fix any adapter the property exposes.
6. REFACTOR — the shared ceiling/reason constants; `npm run docs:json`, stage
   reports/api.json.

### Gate

```
npx vitest run --project unit test/unit/adapters test/unit/ports
npx vitest run --project integration test/integration/memory-large-compressed-pack-interop.test.ts test/integration/loose-object-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/ports/compressor.ts src/adapters/node/node-compressor.ts src/adapters/memory/memory-compressor.ts src/adapters/browser/browser-compressor.ts src/adapters/inflate.ts test/unit/ports/compressor.contract.ts
npx cspell --no-progress src/ports/compressor.ts src/adapters/node/node-compressor.ts src/adapters/memory/memory-compressor.ts src/adapters/browser/browser-compressor.ts src/adapters/inflate.ts test/unit/ports/compressor.contract.ts
npm run check:test-pyramid
npm run check:dead-code
npm run docs:json
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`feat(ports)!: bound one-shot inflate and add a truncating head inflate`

## Part 3 — loose buffered read refuses a body that overruns its header claim

### Context

ADR-907 (supersedes ADR-863 for whole-object reads). The loose arm gains git's two read
tiers. This part lands the overrun refusal; the 32-byte window truncation is Part 4.

Edits:
- `src/application/primitives/object-resolver.ts`
- `src/application/primitives/read-object.ts`
- `src/application/commands/show.ts`
- `src/application/primitives/internal/pack-byte-source.ts`
- `test/unit/application/primitives/object-resolver.test.ts`
- `test/integration/loose-header-size-interop.test.ts`

object-resolver.ts (all new exports INTERNAL):
- `export type LooseReadMode = 'buffered' | 'streamed'`.
- `export const LOOSE_HEADER_WINDOW = 32` (git's `MAX_HEADER_LEN`); head probe length
  `LOOSE_HEADER_WINDOW + 1`.
- `export interface LooseBufferedRead { readonly bytes: Uint8Array; readonly split:
  LooseObjectSplit }` (`bytes` = the inflated stored bytes, header included — fsck hashes
  them in Part 6; `LooseObjectSplit` from src/domain/objects/git-object.ts `:27`) and
  `export async function inflateLooseBuffered(ctx, compressed): Promise<LooseBufferedRead>`:
  `head = await ctx.compressor.inflateHead(compressed, LOOSE_HEADER_WINDOW + 1)` →
  `{ type, size, contentOffset } = parseHeader(head)` (src/domain/objects/header.ts;
  its refusals unchanged) → `cap = Math.max(LOOSE_HEADER_WINDOW, contentOffset + size)`
  → `full = await ctx.compressor.inflate(compressed, cap)`; on
  `isInflateCapExceeded(err) && cap < MAX_INFLATE_OUTPUT_BYTES` throw
  `invalidObjectHeader(\`content exceeds declared size ${size}\`)` (src/domain/objects/error.ts;
  reason text as a named function, not an inline literal); anything else rethrows.
  Returns `{ bytes: full, split: splitLooseObject(full) }`. A header whose NUL falls
  past byte 32 now refuses
  (parseHeader sees only 33 bytes) — git refuses too (`header too long`); if an existing
  row pins acceptance of such a header, re-derive it against git.
- `tryLoose` (`:314-318`) takes `mode`: `'streamed'` → today's
  `ctx.compressor.inflate(compressed)` + `splitLooseObject`; `'buffered'` →
  `inflateLooseBuffered`. Return the split, not raw bytes.
- `resolveLooseArm` (`:173-197`) takes `mode`; `assertLooseSizeConsistent` (commit, tree,
  tag refusal) and the "cache only when claim == length" rule (`:187`) stay;
  `enforceLooseCap` (`:264`) keeps measuring bytes actually produced.
- Thread `mode: LooseReadMode = 'buffered'` as the trailing parameter of
  `tryResolveViaRegistry` (`:142`), `resolveObjectContentWithDepth` (`:76`),
  `resolveObjectWithSize` (`:238`) and `resolveObject` (`:217`). REF_DELTA base lookups
  keep the default (git reads bases buffered).

pack-byte-source.ts: its local `INFLATE_CAP_EXCEEDED_REASON` (`:38`) imports the port's
constant (the "cannot import across the port boundary" note `:31-36` is now false —
rewrite it); `isCapExceeded` (`:147`) becomes the exported
`isInflateCapExceeded(err: unknown): boolean` (INTERNAL), reused by the resolver.

Read routes (git's streaming tier stays `'streamed'`, every other route defaults to
`'buffered'`):
- read-object.ts: `readObjectWithSize` (`:227`, catFile / `--batch`) passes
  `'streamed'`; new INTERNAL `readObjectStreamed(ctx, id, options?)` — `readObject`
  with `'streamed'` (not added to src/application/primitives/index.ts);
  `readObjectMetadataWithContent`'s loose fallback (`resolveObjectMetadataWithContent`
  `:459-472`) stops calling the public `readRawObject` and calls
  `resolveObjectContentWithDepth(ctx, registry, id, false, undefined, 0, 'streamed')`
  directly (D-D (a); the outer `withLazyFetchRetry` in `readObjectMetadataWithContent`
  already covers the retry). Public `readObject`/`readBlob`/`readRawObject` signatures
  do not change.
- show.ts: `buildForRev` (`:125`) and `buildTag` (`:163`) call `readObjectStreamed`
  (git's `show <blob>` streams; commit/tree/tag refuse identically in both modes).
- streamBlob / checkout (blob-source.ts `openBlobSource`) are untouched.

Unit (object-resolver.test.ts; helpers already there: `writeLooseWithDeclaredSize`,
`buildSeededContext`, `createPackRegistry`, `writeRawObjectBytes`):
- a blob whose body overruns its claim past 32 bytes: `resolveObject` rejects
  `INVALID_OBJECT_HEADER` with `reason: 'content exceeds declared size <claim>'`, and a
  spy compressor records `inflate` called with `maxOutputBytes === headerLen + claim`
  (the bound, never a full inflate);
- the same blob through `mode 'streamed'` serves its real bytes;
- honest blob: bytes unchanged, cached; under-run blob: served, not cached;
- a claim whose `headerLen + claim` reaches `MAX_INFLATE_OUTPUT_BYTES` → the cap error
  propagates as `DECOMPRESS_FAILED` (use a stub compressor that throws the cap error);
- fakes that override only `inflate` on a loose path (the abort test `:1589-1600`) now
  also see `inflateHead` first — adjust them to keep testing what their title says.

Interop (loose-header-size-interop.test.ts; `forgeLoose` `:66`, `caseDir` `:129`,
shared base with `small.txt` 12 B and `medium.txt` 1880 B):
- Rows that MOVE (tsgit `readObject` is git's buffered tier, not `cat-file -p`):
  "medium … claim 500" (`:177-197`): `readObject` now rejects; peer the rejection with
  `git archive HEAD medium.txt` (exit 128, stderr `corrupt loose object`). Claim 4000
  (under-run) keeps serving 1880 bytes (residual R1).
- New rows (medium claim 500, i.e. past the window), each against live git:
  `git diff --numstat` of a second commit replacing `medium.txt` → git exit 128
  `corrupt loose object`, tsgit `diff({ withStat: true })` rejects
  `INVALID_OBJECT_HEADER`; `git diff -B --name-status` of the same commit
  (`should_break` reads both blobs in full, no size gate) → git exit 128, tsgit
  `diff({ detectRenames: true, renameOptions: { breakRewrites: { score: 30000, merge:
  36000 } } })` rejects; `git archive` → refusal pair (tsgit `archive`). A `-M` row with
  `medium.txt` deleted and a near-copy added is NOT a refusal row: git's size prefilter
  reads only the claim (500 against ~1880) and never opens the liar, and tsgit's
  ADR-902 gate agrees — pin it as an agreeing `D` + `A` row.
- Reason text that MOVES: rows asserting `size mismatch: header says …` for an overrun
  past the window (commit `:454-488`, tree `:527-563` claim-smaller, and the unit hits in
  object-resolver.test.ts and read-object.test.ts) now carry `content exceeds declared
  size <claim>` — the actual length is never inflated. git's side (`corrupt loose
  object`, exit 128) is unchanged; under-run rows keep the old reason.
- Rows that must stay green unchanged: catFile size/content (`:138-176`, `:223-275`),
  checkout (`:200-221`, `:276-298`), status (`:299-317`), commit/tree/tag rows.
- New ✓-keeping row: `show` of the medium lying blob serves the real 1880 bytes like
  `git show <blob>`.

Bench (after the commit): `npm run bench:ab -- <Part 2 sha> <Part 3 sha>`; read back
test/bench/loose-read.bench.ts, test/bench/cat-file.bench.ts and the `common` rows of
test/bench/diff-renames.bench.ts — no regression beyond noise (design: ~+1.3 µs per loose
read on node).

### TDD steps

1. RED — resolver overrun unit row: today the blob is served (no refusal).
2. GREEN — `inflateLooseBuffered`, `mode` threading, `isInflateCapExceeded`.
3. RED — interop refusal rows (diff numstat, diff -B, archive): tsgit serves today; the agreeing `-M` row is green from the start.
4. GREEN — route defaults; `readObjectWithSize`/metadata/show to `'streamed'`; the
   moved medium row re-derived from `git archive`.
5. RED/GREEN — the `show` streamed row (fails if show was left buffered).
6. REFACTOR — rename-free cleanup of `tryLoose`; re-triage Stryker comments in touched
   resolver code.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/fetch-pack.test.ts test/unit/application/commands/show.test.ts test/unit/application/commands/cat-file.test.ts
npx vitest run --project integration test/integration/loose-header-size-interop.test.ts test/integration/loose-object-interop.test.ts test/integration/loose-corrupt-precedence-interop.test.ts test/integration/loose-read-store-gate-interop.test.ts test/integration/show-interop.test.ts test/integration/archive-interop.test.ts test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/primitives/read-object.ts src/application/commands/show.ts src/application/primitives/internal/pack-byte-source.ts test/unit/application/primitives/object-resolver.test.ts test/integration/loose-header-size-interop.test.ts
npx cspell --no-progress src/application/primitives/object-resolver.ts src/application/primitives/read-object.ts src/application/commands/show.ts src/application/primitives/internal/pack-byte-source.ts test/unit/application/primitives/object-resolver.test.ts test/integration/loose-header-size-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```


### Commit

`fix(objects)!: refuse loose objects whose body overruns the header claim like git's buffered read`

## Part 4 — loose buffered read truncates an overrun inside git's 32-byte window

### Context

git's `unpack_loose_rest`: when the whole object fits the 32-byte header window the
stream has already ended, so the body is silently truncated to the claim (design §2.1
step 5; boundary pinned: claim 6 with body 24 or 25 → `1 1`, body 26 → corrupt).

Edits:
- `src/domain/objects/git-object.ts`
- `test/unit/domain/objects/git-object.test.ts`
- `src/application/primitives/object-resolver.ts`
- `test/unit/application/primitives/object-resolver.test.ts`
- `test/integration/loose-header-size-interop.test.ts`

git-object.ts (INTERNAL, not added to src/domain/objects/index.ts):
- `export type LooseBodyVerdict = 'honest' | 'truncate' | 'underrun' | 'refuse'`;
- `export function classifyLooseBody(split: LooseObjectSplit): LooseBodyVerdict` —
  equal → `'honest'`; commit/tree/tag with any mismatch → `'refuse'`; blob with body
  longer than the claim → `'truncate'` (only reachable inside the window: Part 3's cap
  refuses every longer one); blob shorter → `'underrun'`. `assertLooseSizeConsistent`
  (`:38`) stays for the streamed routes (blob-source.ts `toCachedBytesSource` `:245`).

object-resolver.ts: new INTERNAL `export function applyLooseVerdict(split:
LooseObjectSplit): { readonly content: Uint8Array; readonly cacheable: boolean }` (throws
the refusal) — reused by blob-source.ts in Part 5. `resolveLooseArm` (buffered mode only)
calls it: `'refuse'` → the existing `sizeMismatch` refusal (git-object.ts `:21`, exported
for this); `'truncate'` → serve `content.subarray(0, declaredSize)`, never
cache; `'underrun'` → serve, never cache; `'honest'` → today's path. `verifyObjectContent`
(`:366`) hashes header(claim) + served content — for a truncated blob that is git's
hash, so `verifyHash` still refuses `OBJECT_HASH_MISMATCH` with `actual` = git's value.
Streamed mode is untouched.

Unit: `classifyLooseBody` rows — blob 6 claimed / 24, 25 bytes (truncate), blob equal
(honest), blob short (underrun), commit short and long (refuse), tree long (refuse).
Resolver: small blob `claim 5` with the 12-byte body → `'hello'` (5 bytes), not cached
(`ctx.deltaCache.get(id)` undefined), `streamed` still 12 bytes.

Interop (small blob, `claim 5`: `blob 5\0` + 12 = 19 ≤ 32):
- Row that MOVES: "small blob … claim 5" (`:138-176`): `readObject` now returns
  `hello`; its buffered peer is `git archive HEAD small.txt` (tar entry body `hello`).
  `catFile` content and `streamBlob` keep the 12 real bytes (`git cat-file -p`).
- New rows: `git diff --numstat` of a second commit replacing `small.txt` → git `1 1`
  (truncated `hello`, no LF, against `other\n`); tsgit `diff({ withStat: true })`
  added/deleted from structured fields; `git archive` byte equality.
- The verify row (`:408-452`) stays green: its `actual` now equals SHA-1 of
  `blob 5\0hello` — assert it against a value computed in the test with node:crypto.

### TDD steps

1. RED — `classifyLooseBody` unit rows (function missing).
2. GREEN — the classifier.
3. RED — resolver window truncation row (serves 12 bytes today).
4. GREEN — `applyLooseVerdict` routing in `resolveLooseArm`.
5. RED/GREEN — interop numstat / archive rows; move the claim-5 `readObject`
   expectation to its archive peer.

### Gate

```
npx vitest run --project unit test/unit/domain/objects/git-object.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/internal/blob-source.test.ts
npx vitest run --project integration test/integration/loose-header-size-interop.test.ts test/integration/loose-object-interop.test.ts test/integration/loose-corrupt-precedence-interop.test.ts test/integration/archive-interop.test.ts test/integration/rename-similarity-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/objects/git-object.ts test/unit/domain/objects/git-object.test.ts src/application/primitives/object-resolver.ts test/unit/application/primitives/object-resolver.test.ts test/integration/loose-header-size-interop.test.ts
npx cspell --no-progress src/domain/objects/git-object.ts test/unit/domain/objects/git-object.test.ts src/application/primitives/object-resolver.ts test/unit/application/primitives/object-resolver.test.ts test/integration/loose-header-size-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`fix(objects): truncate a loose blob to its claim inside git's header window`

## Part 5 — the `diff -w` drop predicate reads loose blobs through the buffered tier

### Context

D-C (a). `isWhitespaceOnlyModify` (whitespace-drop-predicate.ts `:277`) opens both sides
with `openBlobSource(ctx, id, maxBufferedBytes)` (`:114-115`) — the streamBlob machinery,
which serves a size liar's real bytes; git's `diff -w` reads through the buffered tier.

Edits:
- `src/application/primitives/internal/blob-source.ts`
- `src/application/primitives/internal/whitespace-drop-predicate.ts`
- `test/unit/application/primitives/internal/blob-source.test.ts`
- `test/integration/loose-header-size-interop.test.ts`

blob-source.ts:
- `openBlobSource(ctx, id, maxBufferedBytes, options?)` (`:81`): an INTERNAL option
  `looseMode?: LooseReadMode` (type from object-resolver.ts) inside a separate internal
  options type — `StreamBlobOptions` (public, src/application/primitives/types.ts) is
  not widened. Default `'streamed'` (streamBlob, `verifyStoredObject`, checkout
  unchanged).
- `resolveLoose` (`:280`) bytes arm, `'buffered'`: `inflateLooseBuffered` +
  `applyLooseVerdict` (both from object-resolver.ts; blob-source never re-implements
  the routing), then `toCachedBytesSource`'s non-blob caching rule on `cacheable`.
- stream arm, `'buffered'` (a compressed file larger than `maxBufferedBytes`): after
  `readHeaderOrRelease` yields the claim, wrap the body stream so it throws
  `invalidObjectHeader('content exceeds declared size <claim>')` as soon as the body
  exceeds the claim (the whole object is > 32 bytes here, so truncation cannot apply).
whitespace-drop-predicate.ts: both `openBlobSource` calls pass `looseMode: 'buffered'`.

Unit (blob-source.test.ts): buffered bytes arm refuses an overrun past 32 bytes and
truncates inside the window; buffered stream arm (small `maxBufferedBytes`) throws after
the claim; streamed default serves the real bytes (existing rows green).

Interop: `git diff -w --name-status` (no numstat) of a commit replacing the medium lying
blob (claim 500) → git exit 128 `corrupt loose object`; tsgit
`diff({ ignoreWhitespace: 'all' })` rejects `INVALID_OBJECT_HEADER`.

### TDD steps

1. RED — blob-source buffered bytes-arm refusal row.
2. GREEN — `looseMode` option + bytes-arm routing.
3. RED — buffered stream-arm row. GREEN — the claim-bounded body wrapper.
4. RED — interop `-w` row. GREEN — the predicate passes `'buffered'`.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts test/unit/application/primitives/stream-blob.test.ts
npx vitest run --project integration test/integration/loose-header-size-interop.test.ts test/integration/diff-whitespace-interop.test.ts test/integration/diff-whitespace-modes-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/internal/blob-source.ts src/application/primitives/internal/whitespace-drop-predicate.ts test/unit/application/primitives/internal/blob-source.test.ts test/integration/loose-header-size-interop.test.ts
npx cspell --no-progress src/application/primitives/internal/blob-source.ts src/application/primitives/internal/whitespace-drop-predicate.ts test/unit/application/primitives/internal/blob-source.test.ts test/integration/loose-header-size-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`fix(diff): read whitespace-drop blobs through git's buffered loose tier`

## Part 6 — `fsck` reports size-lying loose objects like git

### Context

ADR-907 decision: "`fsck` reports a size-lying blob as git does". git's
`read_loose_object` takes the buffered tier and re-hashes the buffer at the claimed size
(probe table above). tsgit's loose arm (content-validation.ts `looseRawObjectBody`
`:87-91`) inflates in full (unbounded) and hashes the stored bytes, so a liar stored at
its own hash reports nothing.

Edits:
- `src/application/commands/internal/fsck/content-validation.ts`
- `test/unit/application/commands/internal/fsck/content-validation.test.ts`
- `test/unit/application/commands/fsck.test.ts`
- `test/integration/loose-header-size-interop.test.ts`

content-validation.ts (D-E (a)):
- `looseRawObjectBody(ctx, compressed)`: `inflateLooseBuffered` (object-resolver.ts,
  Part 3) replaces `inflateOrUndefined` + `parsedLooseObject`; keep the existing failure
  mapping — a head/zlib failure → `{ ok: false, msgId: 'unterminatedHeader' }`, a header
  parse failure → `looseHeaderFailure` (`:39`); a cap hit (overrun past the window) →
  `{ ok: false, msgId: 'unterminatedHeader' }` (same undecodable finding git reports as
  "object corrupt or missing"). Rethrow anything that is not a `TsgitError` (no swallow).
- honest objects: `computeHash` keeps hashing the stored bytes as written (malformed but
  consistent headers keep their current findings).
- mismatch (`classifyLooseBody` from Part 4): `rawBody` and the hash use git's buffer —
  `'truncate'` → body sliced to the claim; `'underrun'` → body followed by
  `claim − body.length` zero bytes fed to the hasher in fixed-size chunks (never one
  claim-sized allocation); an under-run whose claim exceeds `MAX_INFLATE_OUTPUT_BYTES` →
  the undecodable finding. The hash input is the stored header bytes + that body.
  Commit/tree/tag mismatches go through the same path (git does).
- `inflateOrUndefined` (`:61`) is deleted if nothing else uses it (knip, no dead code).

Unit: fsck.test.ts fakes overriding `inflate` for loose paths (around `:4877`, `:4934`,
`:5194`, `:5254`, `:5523`, `:5561`) now meet `inflateHead` first — update them to keep
testing what their titles say. New rows go in the module's own suite
(content-validation.test.ts): window liar → `hash-mismatch` with
`actual` = SHA-1(`blob 6\0` + first 6 bytes) (compute with node:crypto in the test);
overrun → `bad-object` / `'unknown'` / `'unterminatedHeader'` / error severity; under-run
→ `hash-mismatch` with the zero-padded SHA-1; huge under-run claim → `bad-object`.

Interop (loose-header-size-interop.test.ts; this suite already runs `git fsck --full`
at `:408-452`): three rows writing a blob at the SHA-1 of its own stored bytes (a
`forgeOwnHash(dir, claim, body)` helper beside `forgeLoose`): claim 6 / body 10, claim 6 /
body 40, claim 20 / body 10. Each compares `git fsck --full` (stderr line and the
reported sha; exit bit 1 from the live run) with `fsck(ctx)` findings reconstructed into
git's line (`<actual>: hash-path mismatch` or `object corrupt or missing: <oid>`).

### TDD steps

1. RED — window-liar unit row: no finding today.
2. GREEN — buffered read + truncate hash.
3. RED/GREEN — under-run zero-pad row, then the huge-claim bound row.
4. RED/GREEN — overrun row (today inflated in full, hashed clean).
5. RED/GREEN — the three interop rows.

### Gate

```
npx vitest run --project unit test/unit/application/commands/fsck.test.ts test/unit/application/commands/internal/fsck/content-validation.test.ts
npx vitest run --project integration test/integration/loose-header-size-interop.test.ts test/integration/fsck-interop.test.ts test/integration/midx-fsck-interop.test.ts test/integration/rev-bitmap-fsck-interop.test.ts test/integration/fsck-pack-accessibility-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/commands/internal/fsck/content-validation.ts test/unit/application/commands/internal/fsck/content-validation.test.ts test/unit/application/commands/fsck.test.ts test/integration/loose-header-size-interop.test.ts
npx cspell --no-progress src/application/commands/internal/fsck/content-validation.ts test/unit/application/commands/internal/fsck/content-validation.test.ts test/unit/application/commands/fsck.test.ts test/integration/loose-header-size-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`fix(fsck): report size-lying loose objects with git's truncated or zero-padded hash`

## Part 7 — merge: touching change regions conflict like git's `xdl_merge`

### Context

D-A (a). Probe rows above. xmerge.c `xdl_do_merge` `:545-577`: ours and theirs changes
are separate only when `i1 + chg1 < other.i1`; `xdl_append_merge` also folds a region
that starts where the previous one ends. tsgit groups by half-open overlap.

Edits:
- `src/domain/merge/region-merge.ts`
- `test/unit/domain/merge/region-merge.test.ts`
- `test/unit/domain/merge/region-merge.properties.test.ts`
- `test/unit/domain/merge/three-way-content.test.ts`
- `test/integration/merge-conflict-interop.test.ts`

region-merge.ts: `rangesOverlap(a, b)` (`:75-88`, exported, INTERNAL) becomes git's
closed test — two changes overlap unless `a.baseEnd < b.baseStart || b.baseEnd <
a.baseStart` (base ranges `[baseStart, baseEnd)`; an insertion has
`baseStart === baseEnd`). `groupByOverlap` (`:185`) keeps its running `current.end`, so a
chain of touching changes becomes one group (git's `xdl_append_merge`).
`coalesce` / `MAX_CONFLICT_COALESCE_GAP` and `trimCommonEdges` are unchanged (R4).
Same-side changes never touch (a common line separates two hunks), so a group is
never formed from one side alone by this change.

Tests that move: region-merge.test.ts `rangesOverlap` table (`:429-500`: "a zero-length
insert at the exclusive end of a range does not overlap" and any touching pair) and
three-way-content.test.ts "Given adjacent non-overlapping ranges [0,1) vs [1,2)"
(~`:390`) plus any other row asserting a clean merge of touching changes — re-derive each from
`git merge-file -p -L ours -L base -L theirs` on the same bytes; region-merge.properties
arbitraries that treat touching changes as disjoint follow git's rule. Also run
test/unit/application/commands/merge.properties.test.ts in the gate.

Interop (merge-conflict-interop.test.ts, its real `git merge` peer with
`-c merge.conflictStyle=merge`, `:119`): rows "one side changes the last line while the
other appends" and "the two sides change adjacent lines" (both conflict in git, clean in
tsgit today); "one side changes the first line while the other prepends" (✓ today,
pins the insertion-at-start edge); a control where the edits are separated by one
unchanged line (clean in both). Compare conflict status, working-tree bytes with markers
and index stages.

### TDD steps

1. RED — interop adjacent-lines row: tsgit merges clean.
2. GREEN — `rangesOverlap` closed test.
3. RED/GREEN — last-line-vs-append row and the control row.
4. Re-derive every moved unit row from `git merge-file`; property arbitraries follow.

### Gate

```
npx vitest run --project unit test/unit/domain/merge test/unit/application/commands/merge.test.ts test/unit/application/commands/merge.properties.test.ts
npx vitest run --project integration test/integration/merge-conflict-interop.test.ts test/integration/merge-interop.test.ts test/integration/merge-driver-interop.test.ts test/integration/cherry-pick-interop.test.ts test/integration/rebase-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/merge/region-merge.ts test/unit/domain/merge/region-merge.test.ts test/unit/domain/merge/region-merge.properties.test.ts test/unit/domain/merge/three-way-content.test.ts test/integration/merge-conflict-interop.test.ts
npx cspell --no-progress src/domain/merge/region-merge.ts test/unit/domain/merge/region-merge.test.ts test/unit/domain/merge/region-merge.properties.test.ts test/unit/domain/merge/three-way-content.test.ts test/integration/merge-conflict-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`fix(merge): conflict when the two sides' changes touch like git's xdl_merge`

## Part 8 — xdiff line classification into integer class ids

### Context

ADR-909. Behaviour-neutral: the line equality today is a lazy `bytesEqual` (no
`lineKey`) or a `Map<string, number>` intern over `binaryStringOf` (with `lineKey`)
(line-diff.ts `:271-338`). Compaction (Part 9) and the split (Part 10) compare class
ids, so classification lands first. Directory src/domain/diff/xdiff/ is new (kebab-case
files, domain-pure: imports only from src/domain).

Edits:
- `src/domain/diff/xdiff/xdl-classify.ts` (new)
- `test/unit/domain/diff/xdiff/xdl-classify.test.ts` (new)
- `test/unit/domain/diff/xdiff/xdl-classify.properties.test.ts` (new)
- `src/domain/diff/line-diff.ts`

xdl-classify.ts (INTERNAL; not added to src/domain/diff/index.ts):
- `export interface LineClasses { readonly ours: Int32Array; readonly theirs: Int32Array;
  readonly classCount: number }`.
- `export function classifyLines(ours: ReadonlyArray<Uint8Array>, theirs:
  ReadonlyArray<Uint8Array>, lineKey?: LineKey): LineClasses` — git's
  `xdl_classify_record` semantics: ids in first-appearance order over ours then theirs;
  equality is exact bytes of the (normalized, when `lineKey` is set — `normalizeLine`
  from src/domain/diff/whitespace.ts, computed once per line) record, LF included. The
  table is an open-addressing `Int32Array` (power-of-two size ≥ 2 × (M + N), linear
  probe) keyed by a 32-bit line hash (git's djb2-xor `xdl_hash_record_verbatim`,
  xutils.c:307, folded with `Math.imul`/`>>> 0`); a hash hit is confirmed with
  `bytesEqual` (src/domain/objects/encoding.ts), so collisions never merge lines.
  Functions under 20 lines; the in-place typed-array fill is the hot-path exception to
  immutability — say why in one comment.

line-diff.ts: `buildLineEquality`, `internLines`, `internOne`, `binaryStringOf`,
`BINARY_STRING_CHUNK` (`:271-338`) are deleted; the Myers core's `eq` becomes
`(i, j) => classes.ours[i] === classes.theirs[j]` on both paths. Their Stryker comments
go with them. Existing line-diff.test.ts rows (`:793-955`, lineKey interning and chunk
boundaries) stay green unchanged — they now exercise the classifier through `diffLines`.

Tests: classify unit rows — equal lines share an id; LF-terminated vs unterminated last
line differ; `lineKey` all-whitespace mode merges `a b` and `ab`; a forced hash
collision (two lines crafted to share the 32-bit hash, or a test-only small table seam
if the module exposes its table size as a parameter) never merges. Property sibling
(matcher, property-testing.md): for arbitrary line arrays,
`ours[i] === theirs[j]` iff the (normalized) bytes are equal; ids are dense in
`[0, classCount)`.

Bench (after the commit): `npm run bench:ab -- <Part 1 sha> <Part 8 sha>`; read back
test/bench/line-diff.bench.ts (small/medium/patch/blame-hop/merge — no regression beyond
noise), test/bench/blame.bench.ts, test/bench/diff-whitespace.bench.ts.

### TDD steps

1. RED — classify unit rows (module missing).
2. GREEN — `classifyLines`.
3. RED — property sibling; GREEN.
4. REFACTOR — `line-diff.ts` switches to class ids; delete the interning code; every
   line-diff consumer suite stays green.

### Gate

```
npx vitest run --project unit test/unit/domain/diff test/unit/domain/blame test/unit/domain/merge test/unit/domain/range-diff test/unit/application/primitives/patch-id.test.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/range-diff.test.ts
npx vitest run --project integration test/integration/diff-patch-git-parity.test.ts test/integration/diff-patch.test.ts test/integration/diff-whitespace-interop.test.ts test/integration/diff-whitespace-modes-interop.test.ts test/integration/blame-interop.test.ts test/integration/merge-interop.test.ts test/integration/range-diff-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/xdiff/xdl-classify.ts test/unit/domain/diff/xdiff/xdl-classify.test.ts test/unit/domain/diff/xdiff/xdl-classify.properties.test.ts src/domain/diff/line-diff.ts
npx cspell --no-progress src/domain/diff/xdiff/xdl-classify.ts test/unit/domain/diff/xdiff/xdl-classify.test.ts test/unit/domain/diff/xdiff/xdl-classify.properties.test.ts src/domain/diff/line-diff.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`perf(diff): classify lines into integer ids like git's xdiff before comparing them`

## Part 9 — xdiff change compaction with the indent heuristic

### Context

ADR-909 + ADR-910 (heuristic always on). Compaction over today's Myers script fixes L5
without moving counts (numstat is independent of compaction). Also fixes blame L5, the
two L5 merge rows and the L5 patch-id (probe tables above).

Edits:
- `src/domain/diff/xdiff/xdl-compact.ts` (new)
- `test/unit/domain/diff/xdiff/xdl-compact.test.ts` (new)
- `test/unit/domain/diff/xdiff/xdl-compact.properties.test.ts` (new)
- `src/domain/diff/line-diff.ts`
- `test/integration/line-diff-xdiff-interop.test.ts` (new, D-F)

xdl-compact.ts (INTERNAL): transcribe xdiffi.c `:386-973` — `recs_match` (class-id
equality), `get_indent` (`:404`: tab to next multiple of 8, `MAX_INDENT 200`,
whitespace-only → −1), `MAX_BLANKS 20`, `measure_split` (`:481`), the penalty constants
(`:534-576`, `INDENT_HEURISTIC_MAX_SLIDING 100`), `score_add_split` (`:588`), `score_cmp`
(`:666`), the group walkers (`:690-790`) and `xdl_change_compact` (`:793`).
Entry: `export function compactChanges(changed: Uint8Array, otherChanged: Uint8Array,
ids: Int32Array, lines: ReadonlyArray<Uint8Array>): void` — mutates `changed` in place
(git's own representation; hot path — one *why* comment); `get_indent` reads the RAW
line bytes, `recs_match` the class ids (so whitespace modes slide on normalized
equality, as git's `recs_match` does with the flags). Every function under 20 lines,
nesting ≤ 2; the C `goto`-free loop structure is fine to restructure as long as the
behaviour is identical.

line-diff.ts: `reconstructEdits` output → two `Uint8Array` changed maps (M, N);
`compactChanges(oursChanged, theirsChanged, …)` then
`compactChanges(theirsChanged, oursChanged, …)` (git's order, xdiffi.c:1098-1099);
`buildHunks` rebuilt from the two maps: walk both in lockstep emitting `common`,
then per change group `ours-only` before `theirs-only` (settled note above), same
`LineHunk` shape and the empty-empty quirk preserved.

Unit (xdl-compact.test.ts, each expectation taken from live git at authoring time via
`git diff --no-index` on the same bytes): L5 (`+X +d +c` then `d`); the C-function block
(`int b() {…}` inserted between `a()` and `c()`); a blank-line-preferring slide; the
end-of-file penalty; one example per penalty weight so every constant is killable.
Property sibling: compaction preserves added/deleted counts and the multiset of changed
lines per side, and the result still reconstructs `theirs` from `ours`.

Interop (new suite; header `@proves` with `surface: diff.lineDiff`, `bucket:
cross-tool-interop`, a `unique:` line, `interopSurface: diff`; `describe.skipIf(
!GIT_AVAILABLE)`; repos via `mkdtemp` + interop-helpers `runGit`/`runGitEnv`):
- patch L5 and L5' — `git diff -p` versus hunks reconstructed from `diff({ withStat })` +
  `computeHunks`, or `renderPatch` through test/integration/diff-reconstruct.ts;
- blame L5 — `git blame --porcelain` line→commit mapping versus `repo.blame` (follow
  blame-interop.test.ts `:136` for the porcelain parse);
- merge L5 (theirs `a b c d E`, clean) and L5 (theirs `a b c Y d e`, conflict) —
  `git merge-file -p -L ours -L base -L theirs` versus `mergeContent` bytes and status;
- patch-id L5 — `git patch-id --stable` over `git show <c>` versus `computePatchId`
  (src/application/primitives/patch-id.ts) on the same commit.
Before landing, run blame-interop, merge-interop, merge-conflict-interop,
range-diff-interop, cherry-pick-interop and rebase-interop: any row that stops matching
git is a blocker (ADR-909: escalate).

Contingent edits (re-derive from git, never edit to fit): unit rows in
test/unit/domain/diff/patch-serializer.test.ts, test/unit/domain/blame/split-blame.test.ts,
test/unit/domain/merge/three-way-content.test.ts, test/unit/domain/range-diff/*.test.ts
whose expectations encoded today's hunk placement. If more than two of those files move,
stop and hand back with the list (the part would exceed its budget).

Bench (after the commit): `npm run bench:ab -- <Part 8 sha> <Part 9 sha>`; read back
test/bench/line-diff.bench.ts and test/bench/blame.bench.ts — small/medium no regression
beyond noise.

### TDD steps

1. RED — interop patch L5 row: tsgit's hunk is `+X`, context `d`, `+c +d`.
2. GREEN — `compactChanges` group slide without the indent heuristic; RED again on the
   C-function-block unit row.
3. GREEN — indent heuristic (`measure_split`, `score_add_split`, `score_cmp`).
4. RED/GREEN — penalty examples, one per constant.
5. RED/GREEN — blame L5, merge L5 ×2, patch-id L5 interop rows.
6. REFACTOR — property sibling; hunk builder from changed maps.

### Gate

```
npx vitest run --project unit test/unit/domain/diff test/unit/domain/blame test/unit/domain/merge test/unit/domain/range-diff test/unit/application/primitives/patch-id.test.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/range-diff.test.ts
npx vitest run --project integration test/integration/line-diff-xdiff-interop.test.ts test/integration/diff-patch-git-parity.test.ts test/integration/diff-patch.test.ts test/integration/diff-whitespace-interop.test.ts test/integration/diff-whitespace-modes-interop.test.ts test/integration/diff-attr-binary-interop.test.ts test/integration/diff-textconv-interop.test.ts test/integration/blame-interop.test.ts test/integration/merge-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/merge-driver-interop.test.ts test/integration/range-diff-interop.test.ts test/integration/cherry-pick-interop.test.ts test/integration/rebase-interop.test.ts test/integration/show-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/xdiff/xdl-compact.ts test/unit/domain/diff/xdiff/xdl-compact.test.ts test/unit/domain/diff/xdiff/xdl-compact.properties.test.ts src/domain/diff/line-diff.ts test/integration/line-diff-xdiff-interop.test.ts
npx cspell --no-progress src/domain/diff/xdiff/xdl-compact.ts test/unit/domain/diff/xdiff/xdl-compact.test.ts test/unit/domain/diff/xdiff/xdl-compact.properties.test.ts src/domain/diff/line-diff.ts test/integration/line-diff-xdiff-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`fix(diff): slide change groups like git's xdl_change_compact with the indent heuristic`

## Part 10 — xdiff divide-and-conquer split replaces the bounded Myers

### Context

ADR-909 (supersedes ADR-563's bail). `computeMyersTrace` (line-diff.ts `:124`) stops at
`d > MAX_DIFF_EDIT_DISTANCE` and returns `wholeFileFallback` (`:243`), so every line
counts as changed. git's `xdl_recs_cmp`/`xdl_split` never bail; the cost cap and snake
heuristic return a valid non-minimal script in linear space. Record cleanup is Part 11
(D-G): here every line is kept (`reference_index` = identity).

Edits:
- `src/domain/diff/xdiff/xdl-split.ts` (new)
- `src/domain/diff/line-diff.ts`
- `test/unit/domain/diff/line-diff.test.ts`
- `src/domain/merge/three-way-content.ts`
- `test/unit/domain/merge/three-way-content.test.ts`
- `test/integration/line-diff-xdiff-interop.test.ts`

xdl-split.ts (INTERNAL): transcribe xdiffi.c `:30-34` (constants `XDL_MAX_COST_MIN 256`,
`XDL_HEUR_MIN_COST 256`, `XDL_SNAKE_CNT 20`, `XDL_K_HEUR 4`), `xdl_split` (`:50-263`),
`xdl_recs_cmp` (`:265-312`) and the `xdl_do_diff` setup (`:314-366`: `ndiags = n1 + n2 +
3`, ONE `Int32Array(2 * ndiags + 2)` for `kvdf`/`kvdb` with the `+ n2 + 1` offsets,
`mxcost = max(bogosqrt(ndiags), 256)`). `bogosqrt` (xutils.c:26) lives here until Part 11
moves it next to its second user. Entry: `export function markChanges(classes:
LineClasses, oursChanged: Uint8Array, theirsChanged: Uint8Array): void` — recursion
depth follows the split tree, which the heuristics can unbalance (worst case near the
edit count): run `xdl_recs_cmp` over an explicit work stack instead of JS recursion so a
4 M-line input cannot overflow the call stack. The
`need_min` flag is NOT added here (Part 11).

line-diff.ts:
- delete `computeMyersTrace`, `chooseDown`, `advanceSnake`, `reconstructEdits`,
  `MyersResult`, `Edit`, `wholeFileFallback`, `diffLinesWithBound` (`:356`),
  `diffPresplitLinesWithBound` (`:383`) and the seam comments;
- `diffPresplitLines` / `diffLines`: classify → `markChanges` → compaction (Part 9) →
  hunks; `degraded: false` always;
- `MAX_DIFF_EDIT_DISTANCE` (`:37`) comment becomes the DEPRECATED / "no consumer, NOT a
  bound" form of its siblings (`:29-47`); the `LineDiff.degraded` field gets a doc
  comment "always `false`; kept so existing readers compile". Both are public doc
  comments → `npm run docs:json` (reports/api.json regenerated, plain-text artifact).
three-way-content.ts `mergeFromDiffs` (`:70-88`): delete the `degraded` branch and the
"degraded diff falls back to a single whole-file region" sentence of `mergeContent`'s doc
(`:91-97`).

Tests that move:
- line-diff.test.ts: delete every `diffLinesWithBound` / `diffPresplitLinesWithBound` /
  bound / `degraded: true` block (`:331-417`, `:647-717`, `:767-792` and any other hit of
  `grep -n "WithBound\|MAX_DIFF_EDIT_DISTANCE\|degraded" test/unit/domain/diff/line-diff.test.ts`);
  keep the `degraded false` property (`:534`). New example rows whose counts come from
  live git (`git diff --no-index --numstat`, recorded as literals):
  L2 (5001 unique + `common` per side → `5001 / 5001`), L2' (10001 unique + `common`
  against `common` → `0 / 10001`), L2'' (`5000 / 5000`), and two cost-cap rows on
  permutation inputs (every line exactly one match on the other side, so record cleanup
  cannot change git's answer): a seeded shuffle of 2 000 distinct lines, and a
  block-move of 600 lines — both push edit cost past 256 and exercise the snake
  heuristic and the `mxcost` cut.
- three-way-content.test.ts rows "one side forces degraded diff" (`:333`), "only theirs
  diff is degraded" (`:445`), "ours diff degrades while theirs only appends" (`:715`) and
  the fast-path rows citing the degraded slow path (`:738`, `:761`): re-derive each from
  `git merge-file -p` on the same bytes (with Part 7 in place, the append row conflicts
  in both). Titles lose the word "degraded".
- Contingent (re-derive from git): test/unit/domain/blame/split-blame.test.ts,
  test/unit/domain/diff/patch-serializer.test.ts, test/unit/domain/diff/stat-fields.test.ts.

Interop rows (new suite): numstat L2 and L2' (`git diff --no-index --numstat` versus
`computeStatFields` on the same bytes, or a two-commit repo through `diff({ withStat })`),
and the permutation cost-cap row. L1 / L3 / L4 wait for Part 11.

Bench (after the commit): `npm run bench:ab -- <Part 9 sha> <Part 10 sha>`; read back
test/bench/line-diff.bench.ts (the `large` row now runs the cost-capped split instead of
bailing — report it) and test/bench/blame.bench.ts.

### TDD steps

1. RED — the L2 unit row: tsgit bails (`5002 / 5002`, `degraded: true`).
2. GREEN — `markChanges` (split + recs_cmp, no heuristics yet) wired into line-diff.
3. RED — the permutation cost-cap rows (expected counts from git); GREEN — snake
   heuristic and `mxcost` cut.
4. Delete the seam/bound blocks and the old Myers code; three-way-content `degraded`
   branch and its rows re-derived from `git merge-file`.
5. RED/GREEN — interop L2 / L2' / permutation rows; `npm run docs:json`.

### Gate

```
npx vitest run --project unit test/unit/domain/diff test/unit/domain/blame test/unit/domain/merge test/unit/domain/range-diff test/unit/application/primitives/patch-id.test.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/range-diff.test.ts
npx vitest run --project integration test/integration/line-diff-xdiff-interop.test.ts test/integration/diff-patch-git-parity.test.ts test/integration/diff-patch.test.ts test/integration/diff-whitespace-interop.test.ts test/integration/diff-whitespace-modes-interop.test.ts test/integration/diff-attr-binary-interop.test.ts test/integration/diff-textconv-interop.test.ts test/integration/blame-interop.test.ts test/integration/merge-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/merge-driver-interop.test.ts test/integration/range-diff-interop.test.ts test/integration/cherry-pick-interop.test.ts test/integration/rebase-interop.test.ts test/integration/show-interop.test.ts test/integration/log-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/xdiff/xdl-split.ts src/domain/diff/line-diff.ts test/unit/domain/diff/line-diff.test.ts src/domain/merge/three-way-content.ts test/unit/domain/merge/three-way-content.test.ts test/integration/line-diff-xdiff-interop.test.ts
npx cspell --no-progress src/domain/diff/xdiff/xdl-split.ts src/domain/diff/line-diff.ts test/unit/domain/diff/line-diff.test.ts src/domain/merge/three-way-content.ts test/unit/domain/merge/three-way-content.test.ts test/integration/line-diff-xdiff-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
npm run docs:json
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`fix(diff)!: diff lines with git's xdiff split instead of bailing at edit distance 10000`

## Part 11 — xdiff record cleanup: trim ends and discard multi-match lines

### Context

ADR-909. `xdl_trim_ends` + `xdl_cleanup_records` (xprepare.c `:265-423`, facts above)
make tsgit's counts match git on L4 (`8 / 4`, tsgit `7 / 3`) and on the large rows.
`need_min` enters here (internal, test-only `true`): the property oracle needs it.

Edits:
- `src/domain/diff/xdiff/xdl-prepare.ts` (new)
- `test/unit/domain/diff/xdiff/xdl-prepare.test.ts` (new)
- `src/domain/diff/xdiff/xdl-split.ts`
- `src/domain/diff/line-diff.ts`
- `test/unit/domain/diff/xdiff/xdiff.properties.test.ts` (new)
- `test/integration/line-diff-xdiff-interop.test.ts`

xdl-prepare.ts (INTERNAL): `bogosqrt` (moved from xdl-split.ts), `XDL_KPDIS_RUN 4`,
`XDL_MAX_EQLIMIT 1024`, `XDL_SIMSCAN_WINDOW 100`, `DISCARD`, `KEEP`, `INVESTIGATE` as a
`const` object (no enum), `trimEnds` (dstart/dend on class ids), `cleanMmatch`
(xprepare.c:194), `cleanupRecords` (xprepare.c:265). Per-class occurrence counts per
side are computed here from the class-id arrays (`Int32Array(classCount)` each) — no
change to xdl-classify.ts. Output: `changed` pre-marked with discards and a
`referenceIndex: Int32Array` per side (kept lines, in order) that `markChanges` searches
over; `markChanges` maps kept-space indices back through `referenceIndex` when marking.
Search mode as a string union, not a boolean:
`export type SearchMode = 'git-default' | 'minimal'` — `'minimal'` sets `mlim` to
infinity here and skips the heuristics in xdl-split.ts; production always passes
`'git-default'`.

xdl-split.ts: `markChanges(classes, prepared, mode)` — takes the kept-space view and
`mode`; the snake heuristic and cost cut are skipped under `'minimal'`.

line-diff.ts: classify → prepare → split → compact → hunks.

Unit (xdl-prepare.test.ts): `bogosqrt` rows (0, 1, 3, 4, 15, 16, 20006 → 256); `mlim`
boundary (a line with `mlim − 1` versus `mlim` matches); `cleanMmatch` window edges
(runs of exactly 100 and 101); the `rpdis * 4 < rpdis + rdis` boundary; no discard run
on one side → kept; L4's `f` discarded, three `f`s (below `mlim`) kept, six discards
around it kept.
Property (xdiff.properties.test.ts, the whole pipeline through an internal entry,
`numRuns` per property-testing.md): for arbitrary line arrays over a small alphabet
(≤ 12 lines per side): applying the hunks to `ours` yields `theirs`; under `'minimal'`
the changed count equals `M + N − 2·LCS` from a DP oracle in the test; under
`'git-default'` it is ≥ that; compaction preserves counts.

Interop rows (new suite, live git): numstat L4 (`8 / 4`), blame L4 (all 8 lines new),
merge L4 (base `f f f f`, theirs `f f f f g` → whole-file conflict — requires Part 7),
numstat L3 at n = 8000 (lines `j*7` against `j*13+1`; the design measured git at 7384 —
pin git's live value), and L1 shrunk to 2 files of ~1 MiB text (50 000 seeded-random
~20-char lines each; the second commit replaces every line independently with
probability 0.5) — `git diff --numstat` (no `-B`: a kept-broken modify counts the whole
rewrite, which would hide the line diff) against `diff({ withStat: true })`. Today tsgit
bails on these (edit distance far past 10 000).

L1 calibration (handoff report only, never in a test): 4 × 32 MiB text rewrites from
the design's generator in a `mktemp -d` repo; wall time and peak RSS of
`diff({ withStat: true })` versus `git diff --numstat` — target ≤ 3× git's wall time,
RSS below 1.8 GB. Over target → escalate with the figures.

Bench (after the commit): `npm run bench:ab -- <Part 10 sha> <Part 11 sha>`; read back
test/bench/line-diff.bench.ts and test/bench/blame.bench.ts, then
`npm run bench:ab -- <Part 1 sha> <Part 11 sha>` for the chain total on the small/medium
rows (no regression beyond noise).

### TDD steps

1. RED — interop numstat L4: tsgit `7 / 3`.
2. GREEN — `trimEnds` + `cleanupRecords` + kept-space mapping.
3. RED/GREEN — `cleanMmatch` window and ratio unit rows, `mlim` boundary rows.
4. RED/GREEN — `SearchMode` + the pipeline property (minimal oracle).
5. RED/GREEN — blame L4, merge L4, L3 n = 8000, L1-shrunk interop rows.
6. L1 calibration, then the bench runs after the commit.

### Gate

```
npx vitest run --project unit test/unit/domain/diff test/unit/domain/blame test/unit/domain/merge test/unit/domain/range-diff test/unit/application/primitives/patch-id.test.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/range-diff.test.ts
npx vitest run --project integration test/integration/line-diff-xdiff-interop.test.ts test/integration/diff-patch-git-parity.test.ts test/integration/diff-patch.test.ts test/integration/diff-whitespace-interop.test.ts test/integration/diff-whitespace-modes-interop.test.ts test/integration/diff-attr-binary-interop.test.ts test/integration/diff-textconv-interop.test.ts test/integration/blame-interop.test.ts test/integration/merge-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/merge-driver-interop.test.ts test/integration/range-diff-interop.test.ts test/integration/cherry-pick-interop.test.ts test/integration/rebase-interop.test.ts test/integration/show-interop.test.ts test/integration/log-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/xdiff/xdl-prepare.ts test/unit/domain/diff/xdiff/xdl-prepare.test.ts src/domain/diff/xdiff/xdl-split.ts src/domain/diff/line-diff.ts test/unit/domain/diff/xdiff/xdiff.properties.test.ts test/integration/line-diff-xdiff-interop.test.ts
npx cspell --no-progress src/domain/diff/xdiff/xdl-prepare.ts test/unit/domain/diff/xdiff/xdl-prepare.test.ts src/domain/diff/xdiff/xdl-split.ts src/domain/diff/line-diff.ts test/unit/domain/diff/xdiff/xdiff.properties.test.ts test/integration/line-diff-xdiff-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`fix(diff): discard multi-match lines before the line search like git's xdl_cleanup_records`

## Part 12 — the spanhash bucket sum wraps to 32 bits

### Context

ADR-911. `buildChunkMap` (similarity.ts `:48-76`) computes
`(accum1 + Math.imul(accum2, 0x61)) % HASHBASE` at `:63` and `:71`: `Math.imul` is signed
and the `+` does not wrap, so a bucket can differ from git's `unsigned int` sum.

Edits:
- `src/domain/diff/similarity.ts`
- `test/unit/domain/diff/similarity.test.ts`
- `test/unit/domain/diff/similarity.properties.test.ts`
- `test/integration/rename-similarity-interop.test.ts`

similarity.ts: named `function bucketOf(accum1: number, accum2: number): number` =
`((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE`, used at both sites. No export
change (`estimateSimilarity` is public through src/public-types.ts; its signature and
doc stay).

Unit: find once (scratch script, not committed) a short byte string with no LF whose
old bucket differs from `bucketOf` (a negative `Math.imul` or a sum ≥ 2^32), pin it as a
literal, and assert its chunk-map key through `buildChunkMap`. Property: every key of
`buildChunkMap` over arbitrary bytes is an integer in `[0, 107927)`.

Interop (rename-similarity-interop.test.ts, row harness
test/integration/rename-interop-rows.ts: `RenameRow` with `renameOptions`/`gitFlags`,
`FileSpec.content` is a string): two ASCII blobs with no LF (64-byte chunks make large
accumulators), ~4 KiB, generated from a seeded PRNG with ~50 % shared prefix. In a
scratch script compute the old and fixed raw scores; choose a pair where they straddle
a threshold `T` (fixed ≥ T > old). Row: `renameOptions: { threshold: T }` against git
`-M<digits>` where `<digits>/10^len × 60000 = T` (e.g. `-M47250` → 28350). git pairs
(`R0xx`), tsgit today reports `D` + `A`.

### TDD steps

1. RED — the literal bucket row; the interop threshold row.
2. GREEN — `bucketOf`.
3. RED/GREEN — the bucket-range property.

### Gate

```
npx vitest run --project unit test/unit/domain/diff/similarity.test.ts test/unit/domain/diff/similarity.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts test/integration/diff-type-change-interop.test.ts test/integration/blame-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/similarity.ts test/unit/domain/diff/similarity.test.ts test/unit/domain/diff/similarity.properties.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/domain/diff/similarity.ts test/unit/domain/diff/similarity.test.ts test/unit/domain/diff/similarity.properties.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`fix(diff): wrap the spanhash bucket sum to 32 bits like git`

## Part 13 — the spanhash skips the CR of a CRLF pair in text

### Context

ADR-911. diffcore-delta.c `hash_chars`: `if (is_text && c == '\r' && sz && *buf == '\n')
continue;` — in a text blob (`!diff_filespec_is_binary`: NUL in the first 8000 bytes,
tsgit `isBinary`, line-diff.ts `:76`) the CR before an LF is neither hashed nor counted;
a lone CR and a trailing CR are hashed. Both rename scoring (`estimate_similarity`) and
`-B` (`should_break` → `diffcore_count_changes`) use it.

Edits:
- `src/domain/diff/similarity.ts`
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/domain/diff/similarity.test.ts`
- `test/integration/rename-similarity-interop.test.ts`

similarity.ts (INTERNAL additions): `export type ContentKind = 'text' | 'binary'`;
`export function contentKindOf(bytes: Uint8Array): ContentKind` (`isBinary` import from
line-diff.ts, domain to domain); `buildChunkMap(data, kind)` skips the CR when
`kind === 'text' && c === 0x0d && i + 1 < size && data[i + 1] === 0x0a` (no accumulate,
no `n++`). `countSpanhashChanges` (`:114`) and `estimateSimilarity` (`:137`) derive each
side's kind with `contentKindOf` (public signature unchanged).

detect-similarity-renames.ts: `hydrateFingerprints` (`:441-460`) passes
`contentKindOf(content)` at `:453`. `computeBreakScores` (`:601`) already goes through
`countSpanhashChanges` — no edit there.

Check in-part (F3): does the rename/break pass see the `diff`/`binary` attribute today
(docs/design/diff-attr-binary-override.md; `buildAttributeProvider` is only consulted by
the stat pass in diff-trees.ts)? If not, record F3 in the handoff and keep the content
sniff; do not plumb attributes here.

Unit: CR before LF skipped in text; lone CR hashed; trailing CR hashed; CRLF inside a
binary blob (a NUL in the first 8000 bytes) hashed; `contentKindOf` at the 8000-byte NUL
boundary.

Interop: S2 — `old.txt` 20 CRLF lines, `new.txt` the same with 6 lines edited, `-M`:
git `R065`, tsgit `R071` today (build with the harness; confirm git's percent live, and
adjust the edit count if a local git differs so the row still separates the fix). Plus
one `-B` row: a CRLF file rewritten so the kept-broken `M%03d` (`git diff --no-renames -B
--name-status`) differs between the CR-counting and CR-skipping score.

### TDD steps

1. RED — CR-skip unit rows; the S2 interop row.
2. GREEN — `ContentKind`, `contentKindOf`, `buildChunkMap(data, kind)`, hydration passes
   the kind.
3. RED/GREEN — lone/trailing CR and binary rows; the `-B` CRLF row.

### Gate

```
npx vitest run --project unit test/unit/domain/diff/similarity.test.ts test/unit/domain/diff/similarity.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts test/integration/diff-type-change-interop.test.ts test/integration/blame-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/similarity.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/similarity.test.ts test/integration/rename-similarity-interop.test.ts
npx cspell --no-progress src/domain/diff/similarity.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/similarity.test.ts test/integration/rename-similarity-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`fix(diff): skip the CR of CRLF when fingerprinting text like git`

## Part 14 — typed fingerprints and a merge scan

### Context

ADR-912 (hybrid build) under the size-neutral rule. Fingerprints are
`Map<number, number>` (`BlobFingerprint`, detect-similarity-renames.ts `:79-83`) and
scoring does one `Map.get` per source bucket (`countSrcCopied`, similarity.ts `:83`).

Edits:
- `src/domain/diff/similarity.ts`
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/domain/diff/similarity.test.ts`
- `test/unit/domain/diff/similarity.properties.test.ts`
- `test/unit/domain/diff/support/spanhash-map-oracle.ts` (new, test helper)
- `test/unit/application/primitives/internal/detect-similarity-renames.test.ts`

similarity.ts (all INTERNAL; src/domain/diff/index.ts `:70-77` stays as is):
- `export interface SpanFingerprint { readonly hashes: Uint32Array; readonly counts:
  Uint32Array }` — `hashes` ascending, distinct, each < `HASHBASE`.
- `export function buildFingerprint(data: Uint8Array, kind: ContentKind):
  SpanFingerprint` dispatching on `data.length < HASHBASE` to `packFingerprint` (each
  chunk packed as `bucket * 128 + n` into a `Uint32Array(chunkCount)` — bucket < 2^17,
  n ≤ 64 < 2^7 — native numeric `sort()`, then run-length fold) or `denseFingerprint`
  (`Uint32Array(HASHBASE)` accumulator + touched-bucket list, sorted once); share the
  chunk walk (the `hash_chars` loop with `bucketOf` and the CR skip) and the fold between
  the two so the code stays size-neutral; each function under 20 lines. Export
  `packFingerprint` and `denseFingerprint` (INTERNAL, consumed by the pack ≡ dense
  property).
- `export function countCopied(src, dst): number` — two-pointer merge summing
  `min(count)` over equal hashes (git's `diffcore_count_changes` without `la`).
- `export function estimateSimilarityFromFingerprints(src, srcSize, dst, dstSize)` —
  `estimateSimilarityFromMaps`' guards (`:171-183`) over `countCopied`.
- `countSpanhashChanges` and `estimateSimilarity` build fingerprints internally.
- delete `buildChunkMap`, `countSrcCopied`, `estimateSimilarityFromMaps` and the
  `export { buildChunkMap }` alias (`:190`); their Stryker comments are re-triaged.
detect-similarity-renames.ts: `BlobFingerprint` becomes `{ readonly fingerprint:
SpanFingerprint; readonly size: number }`; `estimatePairSimilarity` (`:103`),
`hydrateFingerprints` (`:453`) and `scoreBasenameCandidates` (`:1166`) switch over.
internal/detect-similarity-renames.test.ts `:110`, `:118` build the new shape.

Oracle: spanhash-map-oracle.ts holds the Part 13 `Map` implementation verbatim
(`buildChunkMap` with `bucketOf` + CR skip, `countSrcCopied`) as a test helper (no
`@proves` header). Properties (similarity.properties.test.ts): for arbitrary byte pairs —
including CRLF-heavy text, 64-byte runs without LF, and sizes straddling 107 927 — the
typed `countCopied` equals the oracle's `countSrcCopied`, and `packFingerprint ≡
denseFingerprint` on the same input (both called directly). Every
test/unit/application/primitives/detect-similarity-renames.test.ts row stays green
unchanged.

Size (H7/ADR-912): before the first edit record `rm -rf dist .wireit && npm run
check:size` per entry (the tree is the Part 13 commit); after GREEN every entry must be
≤ that figure. Over → trim (share the fold loop, inline single-use helpers); still over →
blocker with the measured per-entry delta. Never bump a limit in this part.

Bench (after the commit): `npm run bench:ab -- <Part 13 sha> <Part 14 sha>`; read back
test/bench/diff-renames.bench.ts `common`/`wide`/`hostile`/`rewrite` — `common` no
regression beyond noise; `npm run bench:memory` for `rename-break-rewrite` against the
Part 1 figure.

### TDD steps

1. RED — the oracle property (module lacks `countCopied`/`buildFingerprint`).
2. GREEN — `packFingerprint`, fold, `countCopied`.
3. RED/GREEN — `denseFingerprint` + the pack ≡ dense property.
4. REFACTOR — switch the detector, delete the `Map` code, size check.

### Gate

```
npx vitest run --project unit test/unit/domain/diff/similarity.test.ts test/unit/domain/diff/similarity.properties.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts test/unit/application/primitives/diff-trees.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts test/integration/diff-type-change-interop.test.ts test/integration/blame-interop.test.ts test/integration/diff-patch-git-parity.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/diff/similarity.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/similarity.test.ts test/unit/domain/diff/similarity.properties.test.ts test/unit/domain/diff/support/spanhash-map-oracle.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts
npx cspell --no-progress src/domain/diff/similarity.ts src/application/primitives/detect-similarity-renames.ts test/unit/domain/diff/similarity.test.ts test/unit/domain/diff/similarity.properties.test.ts test/unit/domain/diff/support/spanhash-map-oracle.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`perf(diff): fingerprint blobs into sorted typed arrays and merge-scan them like git`

## Part 15 — `-B` fingerprints are reused by the rename matrix

### Context

Design §4.3.6. `scoreOneModify` (detect-similarity-renames.ts `:632`) reads both blobs
of every modify and `computeBreakScores` (`:601`) fingerprints them, then drops the
result; a broken half then enters the registry and `hydrateFingerprints` reads and
hashes the same blob again. Output is identical (the hash is a pure function of the
bytes); only reads and hashing drop.

Edits:
- `src/application/primitives/detect-similarity-renames.ts`
- `test/unit/application/primitives/detect-similarity-renames.test.ts`

Change:
- `computeBreakScores(src, dst)` takes the two `SpanFingerprint`s + sizes (built once in
  `scoreOneModify` with `contentKindOf`) and uses `countCopied`.
- `scoreModifies` (`:678`) returns, besides `records`/`paths`, a
  `ReadonlyMap<ObjectId, BlobFingerprint>` holding ONLY the halves of modifies that
  broke (never every scored modify: memory stays bounded by the broken set).
- `attemptBreaks` (`:742`) → `runBreakPass` (`:910`) carry it out;
  `detectSimilarityRenames` (`:1291`) passes it as the `known` map of the inexact phase:
  the basename pass is ineligible whenever something broke (`isBasenamePassEligible`
  `:1226`), so seed `runInexactPhase`'s `knownFingerprints` with the union of the break
  map and `basename.fingerprints`. `detectBreakRewrites` (`:1375`) ignores the map.

Unit: a `-M -B` diff with one broken modify whose halves then pair — a counting context
(wrap `ctx.fs.read` or the compressor's `inflate`, as
test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts
`countingCompressor` does) proves each of the two blobs is inflated exactly once
(twice today); the existing break/rename rows stay green unchanged.

Size: same rule as Part 14 (D-I (a)) — size-neutral against the Part 14 commit.

Bench (after the commit): `npm run bench:ab -- <Part 14 sha> <Part 15 sha>` and
`-- <Part 13 sha> <Part 15 sha>` for the item-3 total; read back
test/bench/diff-renames.bench.ts `rewrite`; `npm run bench:memory` for
`rename-break-rewrite`. Also record, in a `mktemp -d` scratch repo, the design's S0
shape (300 × 1 MiB random modifies, `-M -B` defaults) — tsgit wall time and peak RSS
against `git diff -M -B --name-status` (target ≤ 1.5× git).

### TDD steps

1. RED — the read-count unit row (each blob read twice today).
2. GREEN — fingerprints built once in `scoreOneModify`, returned for broken halves,
   seeded into the inexact phase.
3. REFACTOR — size check; bench after the commit.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/primitives/internal/detect-similarity-renames.test.ts test/unit/application/primitives/diff-trees.test.ts
npx vitest run --project integration test/integration/rename-similarity-interop.test.ts test/integration/rename-exact-interop.test.ts test/integration/diff-type-change-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts
npx cspell --no-progress src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts
npm run check:test-pyramid
npm run check:dead-code
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`perf(diff): reuse break-pass fingerprints in the rename matrix`

## Part 16 — `withStat` recurses before rename detection, like git's numstat

### Context

Independent of every other part (may run out of order, before Part 17). Surfaced gap:
a non-recursive `diff({ detectRenames: true, withStat: true })` of an exactly-renamed
directory reports one directory-level rename entry, because rename detection runs on
the top-level entries and `expandDirectoryChanges` (diff-trees.ts `:265`) /
`expandLevelChange` (`:636`) only expand add/delete/modify. git recurses **before**
detection for any content-reading format (probe table above): the numstat of an exact
directory rename is one `0 0` rename per leaf, and a moved-and-edited directory pairs
its leaves by similarity (`1 0 {newname => renamed2}/inner.txt`).

Edits:
- `src/application/primitives/diff-trees.ts`
- `src/application/primitives/types.ts`
- `src/application/commands/diff.ts`
- `test/unit/application/primitives/diff-trees.test.ts`
- `test/integration/diff-tree-oid-modify-interop.test.ts`

diff-trees.ts: at the top of `diffTrees` (`:92-108`) derive
`const effective = options?.withStat === true ? { ...options, recursive: true } : options`
and pass `effective` to `resolveAndDiff` (`:138-153`, reads `options?.recursive`) and
`detectChanges` (`:117-133`, `buildPreimage`'s recursive argument). With every `withStat` diff now
recursive, `applyStatPass` (`:218`) never meets a directory-mode entry:
`expandDirectoryChanges` (`:265-280`) becomes dead — delete it and any helper only it
used (`ROOT_CURSOR` stays if `diffRecursive` uses it); `expandLevelChange` stays (the
recursive walk uses it). The `-w` drop path without `withStat` (`applyDropPredicate`,
`isDirectoryModeChange` `:352`) is unchanged — git's raw `-w` output does not recurse
(pinned by the row at diff-tree-oid-modify-interop.test.ts `:247`).

Public doc comments (surface: no new symbol; api.json regenerated):
`DiffTreesOptions.recursive` / `withStat` (types.ts `:297-309`) and
`DiffOptions.recursive` / `withStat` (diff.ts `:19-28`): "`withStat` implies a recursive
diff (git's `--numstat` recurses before rename detection)".

Unit (diff-trees.test.ts, near the withStat blocks `:1105-1200`): non-recursive
`withStat` + `detectRenames` over an exactly-renamed sub-tree returns two leaf `rename`
changes with `added 0 / deleted 0`; the same without `detectRenames` returns leaf
add/delete (unchanged); a non-recursive diff WITHOUT `withStat` still returns the
directory-level rename (unchanged).

Interop (diff-tree-oid-modify-interop.test.ts; reuse the rename block `:204-277` repo and
add a moved-and-edited commit): peer `git diff-tree -M --numstat -z <from> <to>` (no
`-r`; `-z` prints a rename as `added\tdeleted\t\0old\0new\0`, avoiding the display-only
`{a => b}` path) versus `diffTrees`/`repo.diff({ detectRenames: true, withStat: true })`
rows `(added, deleted, oldPath, newPath)`; extend `parseNumstat` (`:51`) with the `-z`
record form. Rows: exact directory rename; moved-and-edited directory; the same pair
with `--no-renames` (leaf add/delete, ✓ today).

### TDD steps

1. RED — interop exact-directory-rename numstat row (tsgit: one directory entry).
2. GREEN — `withStat` forces recursion.
3. RED/GREEN — moved-and-edited row (leaf similarity pairing).
4. REFACTOR — delete `expandDirectoryChanges`; doc comments; `npm run docs:json`.

### Gate

```
npx vitest run --project unit test/unit/application/primitives/diff-trees.test.ts test/unit/application/commands/diff.test.ts test/unit/application/commands/show.test.ts
npx vitest run --project integration test/integration/diff-tree-oid-modify-interop.test.ts test/integration/diff-recursive-interop.test.ts test/integration/rename-exact-interop.test.ts test/integration/rename-similarity-interop.test.ts test/integration/empty-tree-diff-interop.test.ts test/integration/show-interop.test.ts test/integration/diff-patch-git-parity.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/diff-trees.ts src/application/primitives/types.ts src/application/commands/diff.ts test/unit/application/primitives/diff-trees.test.ts test/integration/diff-tree-oid-modify-interop.test.ts
npx cspell --no-progress src/application/primitives/diff-trees.ts src/application/primitives/types.ts src/application/commands/diff.ts test/unit/application/primitives/diff-trees.test.ts test/integration/diff-tree-oid-modify-interop.test.ts
npm run check:test-pyramid
npm run check:dead-code
npm run docs:json
rm -rf dist .wireit && npm run check:size && npm run check:tarball
```

### Commit

`fix(diff): recurse before rename detection when withStat is set like git's numstat`

## Part 17 — user docs

### Context

Docs only, no src delta. Runs after every other part (including Part 16). No
doc-coverage gate moves (no new command). Never hand-edit CHANGELOG.md.

Edits:
- `docs/use/errors.md`
- `docs/use/primitives/read-object.md`
- `docs/use/commands/fsck.md`
- `docs/use/commands/diff.md`
- `docs/use/primitives/diff-trees.md`
- `docs/use/commands/merge.md`

Content:
- errors.md `INVALID_OBJECT_HEADER` row (`:62`): whole-object reads (`readObject`,
  `readBlob`, `diff`/`withStat`, rename and break scoring, `archive`, `grep`, `blame`,
  `merge`, `diff -w`) refuse a loose blob whose body runs past its claim
  (`content exceeds declared size <claim>`) and truncate one whose whole object fits
  git's 32-byte header window; `catFile` content, `show` of a blob, `streamBlob` and
  checkout serve the real bytes (git's streaming tier); a short body is served.
- read-object.md `:18`, `:41`: the same two-tier rule; the ADR-863 sentence becomes the
  ADR-907 one.
- fsck.md: size-lying loose objects reported like git (hash-path mismatch with git's
  truncated or zero-padded hash; corrupt object past the window).
- diff.md: `withStat` recurses before rename detection (`:81` "non-recursive" bullet);
  the line counts and hunks follow git's default xdiff (record cleanup, cost-capped
  split, indent-heuristic compaction) with no edit-distance bail; similarity scoring
  skips the CR of CRLF in text.
- diff-trees.md: the `withStat` recursion rule.
- merge.md: changes on touching lines conflict, as in git; conflict regions follow git's
  compacted diff.
Run `npx cspell` and the markdown link checks the repo's validate runs on docs.

### TDD steps

1. Edit each page; no behaviour claim without the part that landed it.
2. `npm run validate` green.

### Gate

```
npx cspell --no-progress docs/use/errors.md docs/use/primitives/read-object.md docs/use/commands/fsck.md docs/use/commands/diff.md docs/use/primitives/diff-trees.md docs/use/commands/merge.md
npm run validate
```

### Commit

`docs: describe git's loose read tiers, xdiff line counts and withStat recursion`
