# Plan — whitespace drop-pass fast path

> Source: design doc `docs/design/whitespace-drop-fast-path.md` · ADRs 548–564
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the part schema — the plan phase cannot close without it.

## How to read this plan

- **14 parts**, one branch, ordered commits, one PR. The design proposed 16; §Sizing
  records the five merges/moves and why.
- Every part carries the whole context it needs. Do **not** re-derive from the design
  doc unless a part block sends you there by section number.
- Serena is already activated on this worktree — use `find_symbol` /
  `find_referencing_symbols` / `replace_symbol_body` / `insert_after_symbol` as the
  default for TypeScript navigation and editing. Do **not** call `activate_project`.
- **No provenance refs in code**: never write `ADR-5xx`, `§D1`, `P1a`, `C4`, a backlog
  id or a phase number into `src/` or `test/`. Describe the *mechanism* instead. The
  commit is the join point.
- **No suppression directives** of any flavour. A `Stryker disable` line is not a
  suppression directive in that sense — it is an equivalence proof — but it may only be
  written when the mutant is provably equivalent, and it must sit **immediately above
  the mutant's expression line** (a multi-line proof comment between directive and
  expression silently unbinds it).
- **Escalate, never improvise**: if a part cannot be expressed as the testable increment
  described, stop and report `{ part, reason, ≤3 options }`.

### Public surface — decided up front

Verified against `src/domain/diff/index.ts` and `src/public-types.ts` at plan time:

| new/changed symbol | public? | consequence |
|---|---|---|
| `createLineDigestFold`, `LineDigestFold` (`src/domain/diff/whitespace.ts`) | **internal** | must NOT be added to `src/domain/diff/index.ts` |
| `src/domain/diff/line-digest-scanner.ts` (whole module) | **internal** | must NOT be added to `src/domain/diff/index.ts` |
| `hasNulInWindow` (`src/domain/diff/line-diff.ts`) | **internal** (module-private → module-exported) | must NOT be added to `src/domain/diff/index.ts` |
| `openBlobSource`, `BlobSource`, `MAX_BUFFERED_BLOB_BYTES` (`src/application/primitives/internal/blob-source.ts`) | **internal** | `internal/` is not barrelled anywhere |
| `digestNormalizedLine`, `digestsEqual`, `digestIsBlank`, `LineDigest`, `isBlankLine`, `NONE_KEY` | already **internal** (absent from both barrels) | free to restructure |
| `normalizeLine`, `linesEqualUnder`, `isBinary`, `MAX_LINE_BYTES`, `MAX_LINES`, `MAX_DIFF_LINES`, `MAX_DIFF_EDIT_DISTANCE`, `MAX_DIFF_ITERATION_FACTOR`, `BINARY_DETECTION_BYTES` | **public, unchanged signatures/values** | behaviour changes only (Parts 8, 12, 13); no rename, no re-value, no removal |

**Therefore `reports/api.json` must not move.** Two traps that would move it anyway, both
owned by Part 12:

1. `reports/api.json` records each constant's **literal value as its type**
   (`{"name":"MAX_DIFF_LINES","type":{"type":"literal","value":50000},"defaultValue":"50_000"}`).
   Re-valuing one is a public type change. No part re-values one.
2. Those constants and `isBinary` currently carry **no TSDoc**. typedoc's default
   `commentStyle` is `jsdoc`, so a `//` comment is invisible to it but a `/** … */`
   block adds a `comment` node to `api.json`. Part 12 rewrites the caps' documentation:
   **use `//` line comments**. If a part deliberately adds a `/** … */` block to a
   public export, it must run `npm run docs:json` and commit `reports/api.json` in the
   same commit — `check:doc-typedoc` is a **prepush** gate, not a `validate` gate, so a
   green local `validate` will still be rejected at push.

No part adds a Tier-1 command, an error code, a union member or a barrel entry, so none
of the other surface gates (`check:doc-coverage`, `audit-browser-surface`, the
`repository.test.ts` key snapshot, the README command count) apply.

### Waves, dependencies and what is parallelisable

`⇢` = strictly depends on. Parts on the same wave carry no dependency on one another.

| wave | part | depends on | parallel-safe? |
|---|---|---|---|
| 1 | **1** benches + baseline | — | yes — touches only `test/bench/**` and the design doc |
| 1 | **2** incremental fold | — | yes — `src/domain/diff/whitespace.ts` + its two test files |
| 1 | **3** `openBlobSource` seam | — | yes — `src/application/primitives/{internal/blob-source.ts,stream-blob.ts}` |
| 1 | **4** adapter buffered inflate | — | yes — `src/adapters/{browser,memory}/*-compressor.ts` + a new bench |
| 2 | **5** line-digest scanner | ⇢ 2 | single |
| 3 | **6** predicate's two arms | ⇢ 5, ⇢ 3 | single |
| 4 | **7** divergence ledger + parity | ⇢ 6 | single |
| 5 | **8** C4 terminator fix | ⇢ 7 | single |
| 6 | **9** C6 incomplete-line CR fix | ⇢ 8 | see note |
| 7 | **10** C5 caps leave the drop verdict | ⇢ 8 | see note |
| 8 | **11** C5/C7 stat arm | ⇢ 10 | single |
| 9 | **12** C8 caps leave `isBinary` | ⇢ 11 | single |
| 10 | **13** C8 bound the edit distance | ⇢ 12 | single |
| 11 | **14** measurement + results | ⇢ 13, ⇢ 1 | single |

**Wave 1 is genuinely parallel** — Parts 1–4 share no file. If the orchestrator runs
them in isolated worktrees, collect them in the order 1, 2, 3, 4 (Part 1 must be the
first commit on the branch so its baseline numbers are measured on an unmodified `src/`
tree; see §Sizing note (d)).

**Parts 9 and 10 are dependency-independent** (different `src/` sites, same predecessor)
but both delete rows from the same ledger file
(`test/integration/diff-whitespace-modes-interop.test.ts`). Run them **sequentially** in
the order shown unless you are prepared to resolve one ledger conflict; ADR-559 says
swapping them costs only rebase noise.

**Parts 12 and 13 must not be reordered or separated.** If the PR is ever cut short, the
cut goes before Part 12, never between 12 and 13.

### Sizing — where this plan diverges from the design's §Part sequence

The design's 16-part table is the starting point. Five corrections, all reported to the
orchestrator:

- **(a) P1m folded away.** The design's standalone fold micro-measurement part has no
  `src/` delta and no artifact to commit. Its bench is authored in Part 1 (with every
  other bench) and run in Part 14 (with every other measurement). A fold regression is
  therefore discovered at Part 14 rather than at Part 2 — acceptable, because ADR-558's
  fold is a faithfulness and memory decision, not a perf decision, and the design's own
  remedy for a regression (an `indexOf`-assisted fast path for the inactive-key case) is
  a tuning change *inside* the fold, not a redesign.
- **(b) P4a + P4b merged into Part 4.** ADR-555 is a conditional; a bench-only part
  produces a number, not a commit, and the craft contract makes the commit the handoff.
  One part benches and then takes the branch the bench dictates — both outcomes land a
  commit.
- **(c) P5b + P1m + §Measurement-2b merged into Part 14**, which lands its numbers as a
  **Results** section appended to the design doc (a measurement part must produce an
  artifact). It measures the branch tip against `main`, which also covers the
  `diffLines` before/after ADR-563 owes.
- **(d) P5a moved to first.** The design left wave-1 ordering free; in a shared working
  tree, running the bench part after Part 2 or Part 3 would poison the `main` baseline.
- **(e) The interop "threshold-forced second pass (gate set to 0)" is not
  implementable.** An integration test drives `repo.diff(…)`; the gate is internal and
  §Requirements 4 forbids a public/config knob for it (`core.bigFileThreshold` is
  explicitly out of scope), and ADR-556 deleted the module spy that would otherwise
  reach it. Corrected: **the interop arm split is pinned with the naturally-straddling
  fixtures §Pin E-2 already supplies** (`tail-ws`, 345 B on disk → buffered arm;
  `rand-1line`, 80 045 B on disk → streaming arm), and the "same fixtures on both arms"
  second pass moves to the **unit** predicate suite via DC-18's mechanism below.
- **(f) The §Pin F consumer sweep splits by fixture, not by consumer.** §Pin F's last
  column shows `longline` is correct on all six surfaces after Part 12 while `manylines`
  is correct on only one until Part 13. So Part 12 adds the **`longline`** consumer
  cases and *updates* the `manylines` ledger rows (binary → degraded); Part 13 adds the
  **`manylines`** consumer cases and *deletes* those rows. Without this split, Part 12's
  own gate would be red.

Two splits the design flags as non-optional are honoured: Part 2 / Part 5 (the fold and
the scanner — the bit-identity claim must be reviewable outside a file of new code), and
Parts 12 / 13 (never separated). Parts 10 and 11 stay split because Part 10's diff *is*
the statement "the caps stopped deciding" (ADR-564) while Part 11 is surgery on
`applyStatPass` under a different ADR.

**The five files two parts each touch, and why they are not merged** (`plan-lint`'s
cognitive-locality warnings — every one is deliberate and ADR-mandated):

| file | parts | why split |
|---|---|---|
| `src/domain/diff/whitespace.ts` | 2, 8 | ADR-554: the perf restructure must move **zero** verdicts; the terminator fix moves one family. Merging them destroys the property that makes the perf diff cheap to review. |
| `src/application/primitives/internal/whitespace-drop-predicate.ts` | 6, 10 | same ADR-554 ordering, from the other side: Part 6 *adds* the caps scaffold so no verdict moves, Part 10 *deletes* it so the C5 family does. ADR-564 makes that deletion the visible statement of the change. |
| `test/integration/diff-whitespace-modes-interop.test.ts` | 7, 10 (and 8, 9, 11, 12, 13) | the ledger is the shared oracle by construction — it must exist before any fix can delete rows from it, and §Requirements 10 makes "each commit deletes exactly its own rows" the reviewable artefact. |
| `src/domain/diff/line-diff.ts` | 12, 13 | two settled decisions with two ADRs (561 / 563) and two different blast radii; §D9.1 explicitly needs "wide but shallow" (Part 12) separable from "one constant, deep" (Part 13). They ship together and are never reordered. |
| `docs/design/whitespace-drop-fast-path.md` | 1, 14 | before-numbers must be taken on an unmodified `src/` tree and after-numbers on the branch tip; one part cannot hold both moments. |

### Decision candidates

Seventeen decisions are settled (ADR-548 … ADR-564) and are **not** re-opened here.
Planning surfaced **one** genuinely new load-bearing choice.

**DC-18 — how both predicate arms get exercised once the 64 KiB gate is internal and
not configurable.**

| option | shape | cost |
|---|---|---|
| **A (recommended)** | `isWhitespaceOnlyModify` gains an optional trailing parameter `maxBufferedBytes: number = MAX_BUFFERED_BLOB_BYTES`. `diff-trees.ts`'s call site passes four arguments and inherits the default. The unit suite re-runs its whole verdict table twice — once at the default (buffered) and once at `0` (streamed) — which is literally §Test-strategy's "vary only the threshold constant". Interop pins the arms with the naturally-straddling fixtures instead. | one internal default-valued parameter that only tests pass; zero public surface, zero config surface |
| **B** | no parameter; export `compareBuffered` / `compareStreamed` from the predicate module and drive them directly from the unit test with `openBlobSource(ctx, id, 0)` / `(ctx, id, MAX_BUFFERED_BLOB_BYTES)`. | the predicate's own arm-selection branch is then only covered end-to-end at the real gate; two more module exports whose only consumer is a test (a `check:dead-code` hazard) |
| **C** | a `Context`- or env-level gate override. | rejected shape — it is a config/public surface change (§Requirements 4) and re-opens the `core.bigFileThreshold` question ADR-385 and §Out-of-scope both close |

**Recommendation: A.** It is the only option that keeps "the whole of today's predicate
suite re-run once per arm" true, costs no public or config surface, and leaves arm
selection observable without timing. Part 6 is written against A; if the user picks B,
Part 6's context changes and nothing else does.

## Part 1 — whitespace drop-pass bench fixture and the `main` baseline

### Context

**Why this is first.** `test/bench/diff-whitespace.bench.ts` does not reach the code this
PR changes (§Pin D-3): `MEDIUM_FIXTURE` uses the `multi` strategy, so every commit writes
4 **new** paths and `HEAD~1..HEAD --recursive` yields 4 **add** changes;
`changeShouldDrop` returns at `change.type !== 'modify'` before `isWhitespaceOnlyModify`
is ever called. This part builds the bench that *does* reach it and records the
`main` numbers, on a tree whose `src/` is still unmodified.

**Files**
- `test/bench/diff-whitespace.bench.ts` (39 lines) — read it whole. It currently calls
  `resolveScaledContext(MEDIUM_FIXTURE)` then one `scaledScenario(...)`. Its module
  docstring claims it measures the whitespace path; that claim is false and must be
  relabelled (not deleted — the add-shaped scenario stays as a non-regression watch,
  retitled so it no longer implies it reaches the predicate).
- `test/bench/support/write-scratch.ts` — the pattern to follow: `mkdtemp` →
  `openRepository` → `repo.init()` → `writeFile` → `repo.add` → `repo.commit` with the
  pinned `SCRATCH_AUTHOR` (`name: 'bench'`, `timestamp: 1_700_000_000`,
  `timezoneOffset: '+0000'`), plus a `dispose()` that disposes the repo and `rm -rf`s the
  dir. Add the new builder **here**, exported, in the same style.
- `test/bench/support/bench-dsl.ts` — `benchScenario(given, whenThen, build, opts)`;
  `build` returns `{ sut, baseline? }`; the two `bench()` names must stay exactly
  `tsgit` / `isomorphic-git` (the summary script and CI job key on them). Run
  tsgit-only here (no isomorphic-git `ignoreWhitespace` analog).
- `test/bench/support/scaled-bench.ts` — `resolveScaledContext` / `scaledScenario`; note
  it short-circuits under `STRYKER_MUTANT_ID` and skips cleanly when a fixture cannot be
  built. The new scenario must skip just as cleanly when `git` is unavailable.
- `docs/design/whitespace-drop-fast-path.md` — append a `## Results (measured)` section
  at the end with the **before (`main`)** column filled and the after column left as
  `TBD — Part 14`.

**The new fixture, exactly (§Measurement protocol 1 + §Pin B's shape).**
`buildWhitespacePairsScratch(fileCount = 2_500)` in `write-scratch.ts`:
- N files of `package a;\npublic class C<i> {\n  int f<i> = <i>;\n}\n` (**~56 bytes**),
  spread over `N / 50` directories, committed once;
- then rewritten **whitespace-only** (e.g. double every single space inside the class
  body) and committed again;
- built through the library's own API, **never** by mutating the shared
  `~/.cache/tsgit-bench` fixture — `buildWideModifyTreeId`'s deterministic-write trick
  would add 20 000 loose objects to a cache every other bench shares;
- built **once at module scope** and reused across iterations (the 2 500-file build takes
  a few seconds); torn down in `afterAll`.
- **Two variants**: `loose` (as committed) and `packed` (`git repack -ad` in the scratch
  dir after the second commit). Pin B shows they exercise different resolution arms and
  the packed one is the realistic megarepo. Spawn `git` for the repack with a scrubbed
  env — reuse the `runGitEnv()` pattern (strip every `GIT_*`, isolate `HOME`, set
  `GIT_CONFIG_NOSYSTEM=1`) rather than inheriting the runner's env.
- The measured `sut` is
  `repo.diff({ from: 'HEAD~1', to: 'HEAD', recursive: true, ignoreWhitespace: 'all' })`.

**The fold micro-bench (§Measurement protocol 2a), same part, new file**
`test/bench/whitespace-digest.bench.ts`: `digestNormalizedLine` over
{4 modes} × {many short lines, one 70 000-byte line}, tsgit-only, no fixture, no git.
This is the go/no-go for ADR-558's "one JS pass replaces `indexOf` + a JS fold" claim.

**Reference numbers to reproduce (this host, §Pin B):** loose `diff -w` 258 / 271 ms warm,
packed 165 / 176 ms warm. Targets for Part 14: loose ≤ 130 ms, packed ≤ 100 ms cold.

**Measurement hygiene.** ≥2 runs per number, same host, record the spread. These are
**local go/no-go** numbers, not published figures — the published authority is the
nightly `bench.yml` artifact (say so in the Results section).

### TDD steps

Bench code is not test code; there is no RED/GREEN cycle for a measurement. The
executable obligations are:

1. **RED-equivalent** — before writing the new scenario, run
   `npx vitest bench --run test/bench/diff-whitespace.bench.ts` and confirm the existing
   scenario executes; then confirm by inspection (or a one-off `console.count` you do
   **not** commit) that `isWhitespaceOnlyModify` is never entered on `MEDIUM_FIXTURE`.
   Record that as the justification for the relabel.
2. **GREEN** — add `buildWhitespacePairsScratch` to `write-scratch.ts`; add the loose and
   packed scenarios to `diff-whitespace.bench.ts`; add
   `test/bench/whitespace-digest.bench.ts`; relabel the existing add-shaped scenario.
3. **Measure** — run each new scenario ≥2×; fill the `## Results (measured)` section's
   before column in the design doc.
4. **REFACTOR** — keep the scratch builder in `write-scratch.ts` (not inline in the
   bench) so Part 14 can reuse it from a cloned `main` checkout.

### Gate

```
npx vitest bench --run --config vitest.bench.config.ts test/bench/diff-whitespace.bench.ts test/bench/whitespace-digest.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/diff-whitespace.bench.ts test/bench/whitespace-digest.bench.ts test/bench/support/write-scratch.ts
```

Benches need `--config vitest.bench.config.ts` (that is what `npm run test:bench` passes);
without it vitest loads the unit/integration config and finds no benchmarks. Never hand
biome a `.md` path — it processes none and exits **1**.

### Commit

```
test(bench): add a many-small-modified-pairs whitespace drop-pass bench
```

## Part 2 — the incremental O(1) digest fold in `whitespace.ts`

### Context

ADR-558 + ADR-562. **This part is a provable no-op on every digest**: it restructures how
a line's `LineDigest` is computed, and must reproduce today's value bit-for-bit —
`length`, `terminated` **and** `hash`. No verdict moves. Nothing outside
`src/domain/diff/whitespace.ts` and its two test files changes.

**File: `src/domain/diff/whitespace.ts`** (303 lines — read it whole before editing).

Deleted (their only consumer is `digestNormalizedLine`):
`digestContentEnd` (line 173, **and its unannotated equivalent-mutant NOTE dies with
it**), `digestVerbatim` (181), `digestDropAllWs` (189), `digestCollapseRuns` (204),
`commitRun` (231), `digestDropTrailingWs` (249).

Added — the fold, per §D1.1–D1.3:

```ts
export interface LineDigestFold {
  /** Fold one raw byte of the line. Returns true when the byte was the line's
   *  LF terminator — the caller must then call `endLine()` before folding more. */
  push(byte: number): boolean;
  /** Emit the finished line's digest and reset the per-line state. */
  endLine(): LineDigest;
  /** False when nothing has been folded since the last `endLine()` — lets a
   *  caller tell EOF from an empty unterminated final line. */
  readonly lineHasBytes: boolean;
}
export function createLineDigestFold(key: LineKey): LineDigestFold;
```

`digestNormalizedLine(bytes, key)` keeps its exported signature and becomes the thin
whole-line driver: `const fold = createLineDigestFold(key); for (let i = 0; i <
bytes.length; i++) fold.push(bytes[i]!); return fold.endLine();`.

**Documented precondition** (true today, verified at plan time — no test literal and no
existing generator violates it): a "line" is what `splitLines` emits — **at most one LF,
always the last byte**. State it in the fold's doc comment. A mid-line LF is outside the
contract; do **not** try to reproduce `lfIndex`'s "only the last byte counts" rule inside
an incremental fold, and do **not** let the property generators emit an interior LF.
If you find an existing row or generator that does, **escalate** — it would falsify the
bit-identity claim rather than being a bug to code around.

**State (all scalars, reset per line):** `committedHash`, `committedLength`, `tentHash`,
`tentLength`, `pendingWs`, `pendingCr`, `sawLf`, `lineHasBytes`.

**Classifier for this part (today's rules — the pre-fix forms):**
- soft-WS iff `isWs(b) && key.mode !== 'none'`;
- soft-CR iff `b === CR && (key.ignoreCrAtEol || key.mode !== 'none')` — this is today's
  `digestContentEnd`/`applyCrRule` condition, **unconditional on termination**. Part 9
  is what makes it conditional; do not anticipate it here.
- every other content byte is **hard**.

**Transitions (verbatim from §D1.3 — each was hand-checked against the four §D1.2 tail
cases at plan time):**

```
onHard(b):    if (pendingWs) tent = closeRun(tent)
              pendingWs = pendingCr = false
              tent = fold(tent, b);  committed = tent

onSoftWs(b):  if (pendingCr) { committed = tent; pendingCr = false }
              if (mode === 'at-eol') tent = fold(tent, b)
              pendingWs = true

onSoftCr():   if (pendingCr)      committed = tent
              else if (pendingWs) tent = closeRun(tent)
              pendingWs = false
              tent = fold(tent, CR);  pendingCr = true
```

`fold(pair, b)` is one `fnvMix` plus `length++`. `closeRun(pair)` is mode-specific:
`'all'` → nothing; `'change'` → fold **one `SPACE`** (this is `digestCollapseRuns`'
`pendingSpace`); `'at-eol'` → nothing (the run's bytes were already folded verbatim into
`tentative`, mirroring `commitRun`); `'none'` → unreachable, whitespace is hard there.

**Emit step for this part (today's terminator and CR rules):**

```
pair       = committed                       // Part 9 adds the tentative choice here
terminated = sawLf                           // Part 8 narrows this to an inactive key
hash       = terminated ? fnvMix(pair.hash, LF) : pair.hash
digest     = { length: pair.length, terminated, hash }
```

`length` is always the chosen pair's length — the LF folds into the **hash**, never into
the **length**, exactly as `digestVerbatim` does today.

**Untouched, deliberately:** `lfIndex`, `dropAllWs`, `collapseRuns`, `dropTrailingWs`,
`dropTrailingCr`, `applyCrRule`, `normalizeLine`, `linesEqualUnder`, `isBlankLine`,
`resolveLineKey`, `NONE_KEY`, `lineKeyIsActive`, `digestsEqual`, `digestIsBlank`,
`LineDigest`, `fnvMix`, `FNV_OFFSET_BASIS`, `FNV_PRIME`. The **seven** existing
`Stryker disable` / NOTE proofs on `lfIndex`, `collapseRuns`, `dropTrailingWs` (×3) and
`dropTrailingCr` (×2) belong to `normalizeLine`'s allocating helpers, which this part
does not touch — they survive **unexamined-but-unaffected**, and saying so is part of
ADR-552's discipline. Do not edit their text.

**Tests: `test/unit/domain/diff/whitespace.test.ts`** (936 lines).
- The `expectedDigest` helper at lines 40–45 (with `fnvFold`, `FNV_OFFSET_BASIS`,
  `FNV_PRIME` at 29–38) is the **independent oracle**: it calls `normalizeLine`, then
  FNV-folds its output and derives `terminated` from whether that output ends in LF. It is
  a genuinely separate implementation, not a copy of the fold — that is precisely why
  ADR-562 chose the fold's home. **Do not change what it computes.**
- **The property file needs the same oracle**, and duplicating it would turn the
  bit-identity property into a comparison against a second copy. Lift `expectedDigest` +
  `fnvFold` + the two constants into a new sibling helper
  `test/unit/domain/diff/digest-oracle.ts` (kebab-case, next to the existing
  `arbitraries.ts`, which establishes that non-`.test.ts` helpers live here), export
  `expectedDigest`, and import it from **both** `whitespace.test.ts` and
  `whitespace.properties.test.ts`. That move is a pure extraction: the ~40 existing rows
  must still pass with no edit to their expectations.
- All ~40 existing `digestNormalizedLine` rows (the `describe`s at lines 578, 613, 653,
  668, 683, 698 and the branch-exhaustive cross-check at 712) **must pass unchanged**.
  They are the regression net for this rewrite. If one goes red, the fold is wrong — not
  the row.
- **Add** the tail-grammar rows §D1.2 derives, which today's rows do not cover
  exhaustively: for each of the 8 `LineKey` shapes × {terminated, unterminated}, the four
  worked cases `a  \r`, `a \r `, `a\r\r`, `a  \r  `; plus the leading-run cases `"  a"` /
  `"\ta"` (which `change` renders as one SPACE and `at-eol` keeps verbatim); plus the
  all-tail cases `"   "`, `"\r"`, `""`, `"\n"`. Every one asserted against
  `expectedDigest(input, key)`, **never** against a hand-written hash.
- Also add the blind-spot-5 shapes the design asks a reviewer to attack:
  `"a\r \r"`, `"  \r  \r"`, `"\r"` alone, and a CR as the very first content byte, under
  all four modes × `ignoreCrAtEol`.

**Tests: `test/unit/domain/diff/whitespace.properties.test.ts`** (218 lines — **extend,
do not replace**; its seven existing properties stay). Its generators are currently
file-local (`arbPrintableBytes`, `arbLineWithWhitespace`, `arbResprinkle`, `arbLineKey`);
`test/unit/domain/diff/arbitraries.ts` exists but holds tree/blob generators and is not
imported by this file. Move the four line generators into `arbitraries.ts` **only if**
Part 5 will reuse them; otherwise leave them file-local and say why in the commit. Note
`arbLineWithWhitespace` already emits LF only as an optional trailing byte — keep that
invariant.

Four new properties (§Test strategy, and CLAUDE.md's four-lens rule — state the lens in
the describe or a comment, never a phase ref):
1. **bit-identity vs the allocating reference**, `numRuns: 200` — lens 2 (compositional
   aggregator). For an arbitrary line (arbitrary bytes over `{a, b, SP, TAB, CR}` plus an
   optional trailing LF) and an arbitrary `LineKey`, the fold's `LineDigest` equals
   `expectedDigest(line, key)` **field by field** (`length`, `terminated`, `hash`) — not
   merely `digestsEqual`. **This is the property the whole design rests on.** The oracle
   is `normalizeLine` + a plain FNV over its output: an independently-tested sibling that
   allocates the normalized array, not a re-implementation of the subject.
2. **totality**, `numRuns: 100` — lens 3. Over the safe subset (arbitrary bytes, no NUL,
   no interior LF) the fold never throws and always terminates. There are no caps to stay
   under any more, and that is itself the finding.
3. **`closeRun` invariants**, `numRuns: 100` — lens 2. Empty input ⇒ the identity digest
   (`{length: 0, terminated: false, hash: FNV_OFFSET_BASIS}`); appending a hard byte
   always advances the committed pair's `length`; appending a tail-only suffix
   (`WS* CR?` under a key that makes both soft) never changes the emitted digest.
4. **agreement with `linesEqualUnder`**, `numRuns: 100` — the existing property at line
   175 already covers this shape; extend its generator to include CR-bearing lines rather
   than adding a fourth block.

Lens 1 (round-trip) does **not** fit — a digest has no inverse. Say so in a comment; the
four-lens discipline includes recording the misses. Never commit a fast-check seed.

**Coverage:** `src/domain/diff/**` is gated at **100 % statements/branches/functions/
lines** (`vitest.config.ts`). Every branch of the three transitions and of `closeRun`
must be reached by an example row — the design claims **zero** new equivalence arguments
in the fold, so a `Stryker disable` here means the plan was wrong; kill the mutant with a
fixture instead.

### TDD steps

1. **RED** — add the §D1.2 tail-grammar rows and the new property 1 (bit-identity)
   *first*, against a `createLineDigestFold` that does not exist yet. Expected failure:
   `TS2305 / "createLineDigestFold is not exported"` at import, then (once a stub exists)
   property 1 failing on the very first CR- or WS-tail case because the stub emits the
   identity digest.
2. **RED** — add property 3's invariants. Expected failure: the same stub.
3. **GREEN** — implement `createLineDigestFold` with the state, classifier, transitions
   and emit step above; re-express `digestNormalizedLine` over it; delete the six
   now-unused folders and `digestContentEnd`.
4. **VERIFY (the load-bearing step)** — run the *whole* existing
   `whitespace.test.ts` and confirm **every pre-existing digest row still passes,
   untouched**. A single edited expectation in this part is a plan violation: it would
   mean the fold is not bit-identical. If one cannot be made to pass, **escalate** —
   §Requirements 1a calls a failure here a blocker, not a bug to design around.
5. **REFACTOR** — keep the fold under 20 lines per function, early returns, no nesting
   beyond 2. `closeRun` and the mode switch belong in named helpers, not in `push`.

### Gate

```
npx vitest run test/unit/domain/diff/whitespace.test.ts test/unit/domain/diff/whitespace.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/whitespace.ts test/unit/domain/diff/whitespace.test.ts test/unit/domain/diff/whitespace.properties.test.ts
```

### Commit

```
refactor(diff): fold line digests incrementally without buffering the line
```

## Part 3 — the `openBlobSource` seam below `streamBlob`

### Context

ADR-548 + ADR-549. **`streamBlob`'s observable contract must not move by one byte** —
`test/unit/application/primitives/stream-blob.test.ts` (954 lines, 40+ cases) **must pass
unmodified**. That is the executable statement of this part.

**New file: `src/application/primitives/internal/blob-source.ts`.**

```ts
export const MAX_BUFFERED_BLOB_BYTES = 65_536; // 64 KiB of compressed/on-disk bytes

export type BlobSource =
  | { readonly kind: 'bytes';  readonly type: ObjectType; readonly content: Uint8Array }
  | { readonly kind: 'stream'; readonly type: ObjectType | undefined;
      readonly stream: AsyncIterable<Uint8Array>; readonly materialised: boolean };

export async function openBlobSource(
  ctx: Context, id: ObjectId, maxBufferedBytes: number, options?: StreamBlobOptions,
): Promise<BlobSource>;
```

`type` on the **stream** arm is `undefined` **only** on the loose streamed arm — that is
the one place today's refusal is lazy (inside `stripHeader`, on first drain). This shape
is forced by three settled constraints together (the seam reports `type`; the
blob-specific refusal stays with callers; refusal *timing* is preserved per arm) — it is
a derivation, not a new decision.

**Resolution order (§D2), and why each gate costs no I/O:**

0. `ctx.deltaCache.get(id)` — **consulted only when `maxBufferedBytes > 0`**. This is
   load-bearing for ADR-548: `streamBlob` passes `0`, so it keeps today's exact
   loose-first-then-pack precedence and never turns a cache hit into a
   `materialised: true` stream where it reports `false` today. A cache hit **above** the
   threshold is still returned as `bytes` (the buffer is already resident). Split with
   `splitObject` (`src/domain/objects/git-object.ts`).
1. **loose** — `looseCompressedBytes(ctx, id)` (`object-resolver.ts:219`) returns the raw
   compressed file or `undefined`; ADR-388 makes this read mandatory for both designs, so
   `compressed.length` is free. If `compressed.length <= maxBufferedBytes`:
   `ctx.compressor.inflate(compressed)` → `splitObject` → `bytes`. Else: today's
   `inflateOneShot` + `yieldAndVerifyChunks` pipeline → `stream` with
   `type: undefined`, `materialised: false`.
2. **pack base** — `getPackRegistry(ctx)` → `registry.lookup(id)` (throw `objectNotFound`
   on miss) → `hit.pack.offsetTable()` → `nextOffsetForEntry(table, hit.offset)` →
   `readEntryHeaderWithChunk(ctx, hit, nextOffset)` giving `{ header, chunk,
   headerEndInChunk }`. The compressed payload is `chunk.subarray(headerEndInChunk)`;
   **gate on its length** (`chunk.length - headerEndInChunk`) — the exact analogue of the
   loose arm's `compressed.length`, and free because the header is parsed for both
   designs. Below the gate: `ctx.compressor.inflate(payload)` → `bytes` with
   `content` = the raw inflated output (pack base entries carry **no** loose-format
   header) and `type` = `packTypeName(header.type)`. Above: today's
   `yieldAndVerifyPackedBaseChunks` pipeline → `stream` with the same `type`.
3. **pack delta** — `resolvePackChain(ctx, registry, hit, id, undefined)` → always
   `bytes` (ADR-386 already reconstructs in full; the gate is a no-op here). Split with
   `splitObject`. This also populates `ctx.deltaCache` exactly as today.

**Hash verification, per arm.** `verifyHash` defaults to `true`
(`options?.verifyHash ?? true`) — the buffered arm must verify with the same default and
raise the same `objectHashMismatch(id, actual)`; a buffered read that skips verification
"because it's small" is a supply-chain hole (blind-spot 2).
- cache / loose / pack-delta buffered arms: `ctx.hash.hashHex(<whole loose-format
  buffer>)`, exactly like `verifyAndReturn` (`object-resolver.ts:226`).
- pack-base buffered arm: hash the **synthetic canonical header** plus the content —
  `new TextEncoder().encode('blob ' + header.size + '\0')` then the inflated bytes,
  mirroring `yieldAndVerifyPackedBaseChunks` (`stream-blob.ts:239`). A wrong declared
  size is still caught, exactly as today.

**Abort.** `ctx.signal?.aborted === true` → `throw operationAborted()` at the same points
`streamBlob` and `resolveObjectBytes` check today (entry, after the loose read, before
the pack lookup, before the pack resolve).

**Two deliberate non-adoptions — both are review hooks, state them in code comments:**
- **No virtual empty-tree short-circuit.** `resolveObjectBytes` answers the empty-tree oid
  from `EMPTY_TREE_BYTES` without touching disk (`object-resolver.ts:57`);
  `streamBlob` today misses loose, misses the pack and raises `OBJECT_NOT_FOUND`.
  Adopting the short-circuit would silently turn that into `UNEXPECTED_OBJECT_TYPE`.
- **No promisor lazy-fetch retry.** `readRawObject`/`readObject` carry one; `streamBlob`
  does not. Acquiring one here would make lazy-fetch asymmetric between small and large
  blobs, which is worse than either.

`MAX_BUFFERED_BLOB_BYTES` has **no `src/` consumer until Part 6** (the seam takes the gate
as a parameter and `streamBlob` passes a literal `0`). `npm run check:dead-code` (knip)
would report it as an unused export if run between this part and Part 6; the part gate
does not run knip and the phase-boundary `validate` runs after Part 6. **Do not add a fake
consumer** to quiet it, and do not inline the constant into the predicate later — the seam
is where the gate's unit (compressed/on-disk bytes) is defined.

**File: `src/application/primitives/stream-blob.ts`** (269 lines) — re-expressed as
`openBlobSource(ctx, id, 0, options)` plus a wrap tail:
- `bytes` arm ⇒ wrap as a one-chunk `AsyncIterable` with `materialised: true`. With the
  cache probe gated off at `0`, the only `bytes` arm reachable is the **pack-delta** one,
  which is exactly where `streamBlob` reports `materialised: true` today.
- `stream` arm ⇒ return as-is with `materialised: false`.
- The blob refusal stays here: `if (source.type !== undefined && source.type !== 'blob')
  throw unexpectedObjectType('blob', source.type, id)` — which reproduces the eager pack
  refusal; the loose streamed arm keeps refusing lazily inside `stripHeader`.
- Move `packTypeName` (local, `stream-blob.ts:70`) into the seam and import it back, or
  export it — do not duplicate it.
- `streamBlob` stays `async` and its arms use `return await` where they tail into an
  inner async call — a bare `return <promise>` inside an `async` function is this
  repository's recurring workerd unhandled-rejection class, and
  `test:parity:workers` is **not** in `npm run validate` (blind-spot 8).

**New test file: `test/unit/application/primitives/internal/blob-source.test.ts`.**
Model it on `test/unit/application/primitives/stream-blob.test.ts`'s fixtures (memory
context, loose writes, a hand-built pack). Cases (§Test strategy, P2 seam):
delta-cache hit **with the gate open and with it at `0`** (the probe must be skipped at
`0` — this is the property that keeps `streamBlob` unchanged); loose under/over the gate;
pack base under/over the gate; pack delta (always `bytes`); missing oid
(`OBJECT_NOT_FOUND`); non-blob oid on each arm; the **empty-tree oid** (must still be
`OBJECT_NOT_FOUND`, never `UNEXPECTED_OBJECT_TYPE`); `verifyHash` on/off; corrupted loose
object (`OBJECT_HASH_MISMATCH`); aborted signal (`OPERATION_ABORTED`). Header framing per
arm: the pack-base `bytes` arm carries **raw content** with the synthetic
`blob <size>\0` used only for hashing; the other three split with `splitObject`.
Assert error **data** via try/catch on `.data` (`code`, and the ids/types it carries) —
never a bare `toThrow(Class)`; a StringLiteral mutant survives a type-only check.
Test the gate comparison at the boundary: `compressed.length === maxBufferedBytes` ⇒
buffered, `=== maxBufferedBytes + 1` ⇒ streamed (the `<=` vs `<` mutant is dense here).

### TDD steps

1. **RED** — write `blob-source.test.ts` against a module that does not exist. Expected
   failure: unresolved import, then per-case failures once a stub returns a fixed
   `stream` arm (the buffered cases fail on `kind`, the gate-boundary cases fail on which
   arm, the empty-tree case fails on the error code).
2. **RED** — add the delta-cache-at-`0` case explicitly, isolated from the
   delta-cache-at-64 KiB case, so each guard operand is proved alone (mutation-resistant
   convention: one test per operand of a compound guard).
3. **GREEN** — implement `openBlobSource`; re-express `streamBlob` over it.
4. **VERIFY** — run `test/unit/application/primitives/stream-blob.test.ts` **unmodified**.
   Any edit to that file is a plan violation: it is the executable statement of ADR-548's
   "contract unchanged". If a case cannot pass without editing it, **escalate**.
5. **REFACTOR** — one small function per storage arm; no arm longer than 20 lines; the
   gate comparison written once, not per arm.

### Gate

```
npx vitest run test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/stream-blob.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/blob-source.ts src/application/primitives/stream-blob.ts test/unit/application/primitives/internal/blob-source.test.ts
```

### Commit

```
refactor(primitives): resolve blob sources through a shared gated seam
```

## Part 4 — adapter buffered inflate, gated on a bench

### Context

ADR-555, settled as a **conditional**: reimplement only if the bench is clearly better on
large inputs; otherwise accept a Node-only win. This part runs the bench **and** takes the
branch, so the decision and its evidence land in one commit.

**Why this part exists (§Pin D-5).** `NodeCompressor.inflate` is already `inflateSync` —
a pre-resolved Promise, no thread-pool hop, no `Zlib` churn — so Part 6's buffered arm is
strictly cheaper on Node. On the other two adapters it is at best a wash:
- `src/adapters/browser/browser-compressor.ts` → `inflate` builds
  `Blob → DecompressionStream → Response` (note the deliberate `pipeTo` + no-op rejection
  handler: on workerd, closing a `DecompressionStream` with incomplete data rejects the
  writable side as an uncaught rejection that crashes the worker — **preserve that
  behaviour or its equivalent**);
- `src/adapters/memory/memory-compressor.ts` → `inflate` builds a `DecompressionStream`
  per call via `runTransform`.

Both already ship a synchronous zero-dependency whole-member decoder:
`inflateZlibMember(bytes, offset, maxOutputBytes = MAX_INFLATED_OUTPUT_BYTES)` in
`src/adapters/inflate.ts:833`, returning `{ output, bytesConsumed }` and already mapping
every failure to `decompressFailed`. It already powers both adapters' `streamInflate`.

**New bench: `test/bench/adapter-inflate.bench.ts`** — `inflateZlibMember` vs native
`DecompressionStream`, **on large inputs** (ADR-555 is explicit: "the risk is a decoder
that wins on 56 bytes and loses on multi-megabyte objects"). Suggested ladder: 64 KiB,
1 MiB, 8 MiB of (a) highly compressible and (b) incompressible bytes, deflated with
`CompressionStream('deflate')` so both decoders see the same member.

**The branch rule — decide from the bench, then act:**
- **Clearly better** (the decoder wins at every size ≥ 1 MiB, with no size where it loses
  by more than measurement noise) ⇒ reimplement `BrowserCompressor.inflate` and
  `MemoryCompressor.inflate` over `inflateZlibMember`, keeping their `Promise` return type
  (`async` method returning the sync result: `return inflateZlibMember(data, 0).output`).
  **Drop the `try/catch` re-wrap** — `inflateZlibMember` already raises
  `decompressFailed` itself, which is exactly why `streamInflate` has no `try/catch`;
  wrapping it again would change the error's `.data`. Mind that every other `inflate`
  caller on those adapters (`tryLoose`, `collectDeltaChain`) inherits the change: this is
  a **wider blast radius than the rest of this PR**.
- **Not clearly better** ⇒ change no adapter; commit the bench plus a short note in the
  design doc's Results section recording the numbers and the branch taken.

**If the adapters change**, `npm run validate` does **not** cover them: run
`npm run test:parity:workers`, `npm run test:parity:deno` and `npm run test:parity:bun`
**explicitly** and report their results. This is where the `return <promise>`-without-
`await` class bites (blind-spot 8).

**Existing adapter tests to keep green:** `test/unit/adapters/**` (memory + browser
compressor suites) and `test/unit/adapters/inflate*.test.ts`. Add cases only for the
newly-routed `inflate` behaviour (error mapping on a truncated member, adler32 mismatch,
an oversized member hitting `MAX_INFLATED_OUTPUT_BYTES`).

### TDD steps

1. **Measure first** — write and run `test/bench/adapter-inflate.bench.ts` ≥2×. Record
   the numbers; they are the decision's evidence.
2. **RED (branch A only — decoder wins)** — add adapter unit cases asserting the new
   route's error identity: a truncated zlib member and a corrupted adler32 both raise
   `DECOMPRESS_FAILED` with the same `.data` as today, asserted via try/catch on `.data`.
   Expected failure: today's `DecompressionStream` path produces a different message
   shape.
3. **GREEN (branch A)** — reimplement both `inflate` methods over `inflateZlibMember`.
   Run the three parity suites explicitly.
4. **Branch B** — no `src/` change; commit the bench and record the numbers.
5. **REFACTOR** — if both adapters end up with the same three-line body, keep them
   separate anyway (they are distinct adapters with distinct error mapping); do not
   invent a shared helper across the adapter boundary.

### Gate

Branch A:
```
npx vitest run test/unit/adapters && npm run check:types && ./node_modules/.bin/biome check src/adapters/browser/browser-compressor.ts src/adapters/memory/memory-compressor.ts test/bench/adapter-inflate.bench.ts
```
Branch B:
```
npx vitest bench --run --config vitest.bench.config.ts test/bench/adapter-inflate.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/adapter-inflate.bench.ts
```

### Commit

Branch A: `perf(adapters): inflate buffered zlib members with the bundled decoder`
Branch B: `test(bench): compare adapter buffered inflate against DecompressionStream`

## Part 5 — the synchronous chunk-fed line-digest scanner

### Context

ADR-551 (as refined by ADR-558) + ADR-556 + ADR-564. **New file:
`src/domain/diff/line-digest-scanner.ts`** — pure domain, zero platform dependency, home
beside `line-diff.ts` (whose `hasNulInWindow`/`splitLines` it mirrors) and `whitespace.ts`
(whose fold it drives). **It must not be added to `src/domain/diff/index.ts`.**

**No caller yet** — Part 6 wires it. `npm run check:dead-code` (knip) would report the
module as unused if run between this part and Part 6; the part gate does not run knip and
the phase-boundary `validate` runs after Part 6. **Do not add a fake caller** to quiet it.

**API (§D1.6):**

```ts
export interface LineDigestScanner {
  /** Feed the next chunk. Legal before the first `next()` or after a `needs-input`
   *  step — at most one chunk is ever in flight. Runs the NUL-window scan, then
   *  re-seats the fold cursor. The scanner holds a *reference* to `chunk` until it
   *  is consumed; it never copies, concatenates or accumulates. */
  push(chunk: Uint8Array): void;
  /** No more chunks will arrive. */
  end(): void;
  /** Next significant digest, or why not. Never throws. */
  next(): ScanStep;
  /** NUL in the first BINARY_DETECTION_BYTES — the ONLY binary rule. Once set,
   *  `next()` answers `exhausted`. */
  readonly binary: boolean;
  /** Temporary: today's line-length/line-count rule, applied by the CALLER, so the
   *  performance commit reproduces today's verdicts exactly. Deliberately does NOT
   *  stop `next()`. Deleted in Part 10 together with its two counters. */
  readonly capsExceeded: boolean;
}

type ScanStep =
  | { readonly kind: 'digest'; readonly digest: LineDigest }
  | { readonly kind: 'needs-input' }   // only reachable before end()
  | { readonly kind: 'exhausted' };    // EOF *or* binary — the caller reads `.binary`

export function createLineDigestScanner(
  key: LineKey, ignoreBlankLines: boolean,
): LineDigestScanner;
```

There is **no `overflow` step** and no escalation path — ADR-558 deleted both, unbuilt.

**Behaviour.** `next()` advances the fold from the cursor until it consumes an LF (⇒
`digest`, terminated), exhausts the chunk (⇒ `needs-input`, or after `end()` a final
unterminated `digest` when the fold's `lineHasBytes`), or finds nothing left (⇒
`exhausted`). Blank skipping (`digestIsBlank`, unchanged) loops **inside** `next()`
exactly as `nextSignificantDigest` does today.

**Source of every behaviour — `src/application/primitives/internal/whitespace-drop-predicate.ts`
(197 lines, read it whole).** Field-by-field disposition of today's `LineSourceState`
(lines 33–55):

| field | fate |
|---|---|
| `iterator` | **gone** — the scanner is push-fed, not pull-fed |
| `buffer` | **gone** — replaced by `chunk: Uint8Array` + `cursor: number`; nothing is ever accumulated |
| `exhausted` | **stays**, set by `end()` |
| `nulScanOffset` | **stays** — NUL detection is unchanged and is now the *whole* binary rule |
| `lfScanFrom` | **gone** — the fold visits every byte exactly once, so the O(n²) it defended against cannot arise; `buffer.indexOf(LF, …)` goes with it |
| `currentLineBytes` | **scaffold only** — feeds `capsExceeded`, deleted in Part 10 |
| `lineCount` | **scaffold only** — same |
| `binary` | **stays**, set by `scanForNul` alone |

Functions: `scanForNul` (line 73) moves **verbatim**, now invoked from `push` rather than
lazily from `nextLine` — once per chunk either way. `concatBytes` (57), `takeLine` (112),
`nextLine` (121) and `nextSignificantDigest` (154) are **never written** in the new file.
`trackLineCaps` (95) survives only as the scaffold's two counters.

**The `capsExceeded` scaffold (ADR-564, §D1.7) — six lines, one commit's lifetime.** The
scanner carries `currentLineBytes` and `lineCount` and derives
`capsExceeded = currentLineBytes >= MAX_LINE_BYTES || lineCount >= MAX_LINES` using
today's exact rule, counting the **raw** line bytes including the LF, resetting
`currentLineBytes` on a terminated line. `binary` therefore means "NUL in the window" from
day one and never changes meaning. The scaffold fires at **line emit** rather than at
today's pending-bytes short-circuit; §D1.7 proves that is unobservable, and the proof was
checked against all six §Pin E-2 shapes. Import `MAX_LINE_BYTES`, `MAX_LINES` and
`BINARY_DETECTION_BYTES` from `./line-diff.js`.

**Equivalent-mutant dispositions landing here (§D4 — re-derived, never re-read):**
- **M1 `concatBytes` empty-guard — DELETED with its construct.** The fold never joins two
  byte ranges; the function has no caller and is not written. No mutant remains.
- **M2 `scanForNul`'s `nulScanOffset < BINARY_DETECTION_BYTES` — SURVIVES, re-derived.**
  Moving the call from lazy (`nextLine`) to eager (`push`) does not touch the premise,
  which never mentioned *when* it is called: `nulScanOffset += chunk.length` is unchanged,
  so `end = min(chunk.length, ≤ 0) ≤ 0` still skips the loop under both original and
  mutant. Keep the note **unannotated** — the opposite-direction variants (`false`, `>=`)
  are real killed mutants on the same line and a `next-line` disable binds by
  `(mutator, line)`. Copy the existing NOTE across **verbatim** — checked at plan time, no
  sentence in it names `nextLine` or any call site, which is exactly why the move does not
  falsify it — but **re-derive the argument yourself against the eager `push` call site
  before committing**: the adversarial input is "a chunk arriving after 8 000 bytes have
  been seen and containing a NUL", and under both original and mutant
  `end = min(chunk.length, ≤ 0) ≤ 0` still skips the loop. Re-reading the old argument
  instead of re-deriving it is the failure mode ADR-552 exists to prevent.
- **M3 `trackLineCaps`' reset guard — its old proof is DEAD.** In the scaffold the premise
  is **false**: the counter resets on *every* terminated line and is read again on the
  next one, so `true`-forcing it lets short lines accumulate. Write **no** proof and
  **no** directive; kill it with a many-short-lines fixture.
- **M4 `nextLine`'s pending-bytes `Stryker disable` — DELETED with its construct.** There
  is no buffer, so no short-circuit and no directive. ADR-552's executable obligation
  survives in a different form: the **memory test** below.
- **M5 `nextLine`'s exhausted-branch `terminated: false` `Stryker disable` — DELETED, and
  the mutant becomes LIVE.** `terminated` is now the fold's `sawLf`, which decides whether
  the LF is folded into the hash under an inactive key. **This part must ship kill test
  (i)**: construct the scanner with `NONE_KEY` — the API accepts any `LineKey` even
  though the drop pass only ever passes active ones — over `"a\nb"` vs `"a\nb\n"`; the
  unterminated final line must digest **differently** from the terminated one. Kill test
  (ii) lands in Part 9. Neither alone suffices: under an active key Part 8 pins
  `terminated` to `false` regardless, and before Part 9 the CR shape drops the CR on both
  sides. **Say so in this commit** and in Part 9's.

**New test file: `test/unit/domain/diff/line-digest-scanner.test.ts`.** Every case
today's `whitespace-drop-predicate.test.ts` drives through `chunkedStream` +
`vi.spyOn(streamBlobMod, 'streamBlob')` moves here and becomes **synchronous**
(ADR-556) — read that file (195 lines) and port its five scenarios:
- NUL in the chunk immediately after the window closes (first chunk exactly
  `BINARY_DETECTION_BYTES` of `'x'`, second chunk `[NUL, LF]`) ⇒ not binary;
- NUL one position past the window on a partially-consumed budget ⇒ not binary;
- a line landing exactly on `MAX_LINE_BYTES` ⇒ `capsExceeded`;
- exactly `MAX_LINES` blank lines ⇒ `capsExceeded`;
- many short terminated lines summing past `MAX_LINE_BYTES` ⇒ **not** `capsExceeded`.

Plus the chunk-boundary cases §D1.3 identifies as the only positions where a boundary
could have mattered: **inside a whitespace run**, **between a CR and its LF**, and
**between the last content byte and the LF**; a line split across three pushes; NUL at
byte 7 999 vs 8 000 vs straddling a push boundary; unterminated final line; empty blob;
a blob that is a single LF; `ignoreBlankLines` skipping a spaces-only line under a
whitespace mode but **not** under `'none'`; `push` after `end()` and `next()` after
`exhausted` (the API legality contract).

Guard clauses keep **isolated per-operand tests** (`currentLineBytes >= MAX_LINE_BYTES`
and `lineCount >= MAX_LINES` separately) — one test triggering both proves neither.

**Two blocks with deliberately different lifetimes — label them in prose, not with a
phase ref:**
- the **`capsExceeded` scaffold block** (the three cap cases above) — **deleted wholesale
  in Part 10**;
- the **memory block** — **does not move in Part 10**. This is ADR-552's M4 obligation in
  the form that survives ADR-558, and it is the executable form of blind-spot 12. Shape:
  build a single line far over `MAX_LINE_BYTES` (e.g. 200 chunks × 8 KiB of `'x'`, no LF);
  after each `push(chunk)` call `next()` (which returns `needs-input`, having folded the
  chunk to its end) and then **overwrite that chunk in place** with `0xff` before pushing
  the next one; at the end call `end()` and assert the emitted digest equals the digest of
  the **original** bytes. If the scanner had retained any chunk reference, the mutation
  would corrupt the result. A reviewer who can construct a retained-chunk path has found
  a real bug.

**Coverage:** this file is under `src/domain/**` ⇒ **100 %** statements/branches/
functions/lines, scaffold included.

### TDD steps

1. **RED** — port the five predicate scenarios plus the three boundary positions to the
   new synchronous test file, against a scanner that does not exist. Expected failure:
   unresolved import, then per-case failures once a stub returns `exhausted` immediately.
2. **RED** — add M5 kill test (i) (`NONE_KEY`, `"a\nb"` vs `"a\nb\n"`). Expected failure:
   the stub emits identical digests.
3. **RED** — add the memory block. Expected failure: a stub that concatenates chunks
   returns the mutated (`0xff`-filled) digest.
4. **GREEN** — implement `createLineDigestScanner` over `createLineDigestFold`, with
   `scanForNul` moved verbatim into `push` and the six-line `capsExceeded` scaffold.
5. **VERIFY** — `test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts`
   still passes untouched (the predicate is unchanged in this part). Do not delete it
   here — Part 6 owns that.
6. **REFACTOR** — `next()` must stay under 20 lines with early returns; the blank-skip
   loop and the emit path are separate named helpers.

### Gate

```
npx vitest run test/unit/domain/diff/line-digest-scanner.test.ts test/unit/domain/diff/whitespace.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/line-digest-scanner.ts test/unit/domain/diff/line-digest-scanner.test.ts
```

### Commit

```
refactor(diff): drive line digests from a synchronous chunk-fed scanner
```

## Part 6 — the predicate's two arms

### Context

ADR-550 + ADR-553 + ADR-556 + ADR-564 + DC-18→A. **This is the commit whose diff must
show ZERO verdict movement** (ADR-554, blind-spot 9). Every §Pin C / §Pin E / §Pin F
divergence — C4, C5, C6, C7, C8 — is reproduced exactly as it is on `main`.

**File: `src/application/primitives/internal/whitespace-drop-predicate.ts`** (197 lines).
Everything above `isWhitespaceOnlyModify` is **deleted** — `LineSourceState`,
`createLineSourceState`, `concatBytes`, `scanForNul`, `trackLineCaps`, `takeLine`,
`nextLine`, `nextSignificantDigest`, and the `MAX_LINE_BYTES` / `MAX_LINES` /
`BINARY_DETECTION_BYTES` imports with them.

New shape (§D3):

```ts
export async function isWhitespaceOnlyModify(
  ctx: Context,
  change: ModifyChange,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
  maxBufferedBytes: number = MAX_BUFFERED_BLOB_BYTES,   // DC-18→A
): Promise<boolean> {
  const [oldSrc, newSrc] = await Promise.all([
    openBlobSource(ctx, change.oldId, maxBufferedBytes),
    openBlobSource(ctx, change.newId, maxBufferedBytes),
  ]);
  // blob refusal stays with this caller (the seam only reports `type`)
  if (bothAreBytes) return compareBuffered(oldSrc.content, newSrc.content, lineKey, ignoreBlankLines);
  return await compareStreamed(oldSrc, newSrc, lineKey, ignoreBlankLines);
}
```

- `compareBuffered` is **fully synchronous**: one `push` of each content slice, `end()`,
  then the verdict ladder. Zero promises, zero microtasks, zero stream objects — this is
  what removes Pin A's 16.4 % web-streams + 6.2 % zlib + 4.4 % `NodeError` + 3.7 %
  `runMicrotasks`.
- `compareStreamed` keeps today's structure **and its concurrency**: both sides still
  advance under one `Promise.all` per step, so a two-large-blob diff keeps overlapping
  its I/O. What changes is that advancing a side consults the synchronous scanner first
  and only awaits when it answers `needs-input`.
- **The mixed pair (one `bytes` side, one `stream` side) is the case to get right.** Do
  **not** wrap the `bytes` side in a one-chunk `AsyncIterable` to make it uniform — that
  reintroduces exactly the resolved-promise-per-line the design removes. Push the `bytes`
  side's content into its scanner once, call `end()` on it, and give it no iterator; only
  a side that actually has one ever gets awaited. That is what "stops allocating and
  awaiting a resolved promise for the buffered side on every line" means concretely.
- **Never `return <promise>`** from an `async` function: the buffered arm returns a plain
  boolean, the streamed arm uses `return await`. This is the workerd
  unhandled-rejection class and `test:parity:workers` is not in `validate`.
- **Early-exit hygiene** (Pin D-2 — worth **0 ms**, landed as resource hygiene, *not* as
  the fix): `compareStreamed` calls `iterator.return?.()` on both sides before returning
  early. `readableStreamToAsyncIterable` implements `return` as `reader.cancel()`, so
  this releases the reader and lets the `createInflate` instance be collected instead of
  leaking until GC.

**The verdict ladder, unchanged in order, with the two scaffold reads added** (this is the
entire mechanism by which a capless scanner honours ADR-554 — ADR-564):

```ts
// Deleted in Part 10, together with the scanner's two counters.
if (old.binary || old.capsExceeded || next.binary || next.capsExceeded) return false;
if (oldDigest === undefined && newDigest === undefined) return true;
if (oldDigest === undefined || newDigest === undefined) return false;
if (!digestsEqual(oldDigest, newDigest)) return false;
```

The binary/caps check **precedes** the digest comparison — that ordering is one of the
four premises of §D1.7's verdict-identity proof; do not reorder it.

**Blob-type refusal.** The seam reports `type` and leaves the refusal here. Reproduce
today's `UNEXPECTED_OBJECT_TYPE` for a non-blob oid on both arms, with the same `.data`.

**Caller: `src/application/primitives/diff-trees.ts:326`** —
`return isWhitespaceOnlyModify(ctx, change, lineKey, ignoreBlankLines)` passes four
arguments and inherits the default gate. No other change to `diff-trees.ts` in this
part; the drop pass is **already** `boundedMap(diff.changes, MAX_CONCURRENT_OBJECT_LOADS
= 32, …)` at line 244 (ADR-553: concurrency unchanged).

**Test file: `test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts`**
— rewritten. The module spy (`vi.spyOn(streamBlobMod, 'streamBlob')`, lines 52–58) and
`chunkedStream` (33–50) are **deleted** (ADR-556); their five scenarios already moved to
the scanner in Part 5. What this file keeps and gains, driven by real
`createMemoryContext()` blobs:
- **Arm selection, observed without timing** — wrap `ctx.compressor` in a counting proxy
  and assert `createInflateStream` call counts: **zero** for a sub-threshold pair
  (buffered), **one per streamed side** for an over-threshold side, and the streamed arm
  for a mixed pair. Never assert by measuring elapsed time.
- **Verdict identity across both arms** — run the whole verdict table twice via the
  `maxBufferedBytes` parameter: once at the default and once at `0`. A sub-threshold blob
  forced onto the streaming arm must return the **identical** boolean. This is
  §Test-strategy's "vary only the threshold constant".
- **Content edges on both arms**: one side empty; both sides empty; a side that is a
  single LF; a side with no trailing LF; a real content difference confined to the final
  unterminated line (ported from today's line 161 case).
- **Error identity on both arms** (§Requirements 2): missing oid, tree oid, the
  **empty-tree oid**, corrupted loose object, aborted signal — same structured error,
  same `.data`, asserted via try/catch.
- **The scaffold's two operands, isolated**: one over-`MAX_LINE_BYTES` line ⇒ kept; one
  over-`MAX_LINES` file ⇒ kept; a binary (NUL) side ⇒ kept. Each in its own `it`.

**One existing assertion to re-word, not to flip:**
`test/unit/application/primitives/diff-trees.test.ts:1728-1749` — *"Given a single
unterminated line longer than the line cap, whitespace-only change … Then the file is
kept"* — still passes (the scaffold reproduces the verdict), but its comment claims the
predicate "flags binary from the PENDING bytes and bails early", which is no longer the
mechanism. Rewrite the comment to describe the scaffold (the cap is applied when the line
is emitted). **Do not touch the assertion** — Part 10 inverts it.

### TDD steps

1. **RED** — rewrite the predicate test file: arm-selection cases first (counting proxy),
   against the current streaming-only implementation. Expected failure: the buffered case
   sees one `createInflateStream` call per side where it expects zero.
2. **RED** — add the dual-arm verdict table parameterised on `maxBufferedBytes`. Expected
   failure: `isWhitespaceOnlyModify` takes four parameters, so the fifth argument is a
   TS error.
3. **RED** — add the both-arms error-identity cases. Note that eager-vs-lazy refusal
   timing is **deliberately unobservable** from here (the predicate awaits the verdict
   either way), so do not try to assert it; assert instead that a sub-threshold non-blob
   oid raises `UNEXPECTED_OBJECT_TYPE` with the same `.data` **while the counting proxy
   saw zero `createInflateStream` calls** — i.e. it was refused on the buffered arm.
   Expected failure: today every side streams, so the count is one per side.
4. **GREEN** — delete the state machine, implement the two arms over the Part-5 scanner
   and the Part-3 seam, add the two scaffold reads.
5. **VERIFY** — the full `diff-trees.test.ts` and both whitespace interop suites
   (`test/integration/diff-whitespace-interop.test.ts`,
   `test/integration/diff-whitespace-modes-interop.test.ts`) pass **unmodified**. Any
   flip there is a verdict movement and a plan violation — **escalate**.
6. **REFACTOR** — `compareBuffered` and `compareStreamed` share the verdict ladder
   through one small helper taking two `ScanStep`s; no duplicated ladder.

### Gate

```
npx vitest run test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts test/unit/application/primitives/diff-trees.test.ts test/unit/domain/diff/line-digest-scanner.test.ts test/integration/diff-whitespace-interop.test.ts test/integration/diff-whitespace-modes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/whitespace-drop-predicate.ts test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts test/unit/application/primitives/diff-trees.test.ts
```

The two interop suites are in this part's gate on purpose — this is the
zero-verdict-movement commit, and they are the only cross-tool oracle that exists before
Part 7 builds the ledger.

### Commit

```
perf(diff): compare small whitespace-mode blob pairs without streaming
```

## Part 7 — the divergence ledger, both arms pinned, and the parity scenario

### Context

Test-infra only — **no `src/` delta**. This part builds the executable oracle every fix
commit from Part 8 on deletes rows from. **The ledger must exist before any part can
delete from it**, and it is seeded at **today's verdicts**, so this suite is green on the
post-Part-6 tree.

**File: `test/integration/diff-whitespace-modes-interop.test.ts`** (279 lines — read it
whole). It is scenario-driven: `SCENARIOS` (5 rows, one per flag) × one `mode-only.txt`
+ one `real.txt`, asserting `survivorPaths(predicateResult) === survivorPaths(statResult)
=== live-git survivors`. Its `beforeAll` builds one repo with a commit pair per scenario
and already carries an explicit `beforeAll(fn, 60_000)` plus `describe(..., { timeout:
60_000 })`. The five existing scenarios and the `.gitattributes` block at line 187 **stay
exactly as they are**.

**Add a third `describe` block in the same file: the divergence ledger.** Guard it with
`describe.skipIf(!GIT_AVAILABLE)(…, { timeout: 120_000 }, …)` exactly like the two blocks
above it. Its own repo, its own
`beforeAll(fn, 120_000)` (the 100 000-line and 80 KB fixtures make setup much
heavier than the existing one; git-spawning setup hooks on this repo have timed out
under `validate`'s concurrency before — the default 10 s vitest hook timeout is not
survivable here and 60 s is now a thin margin).

Repo setup, mirroring §Pin C/E's pinning method: `git init -q -b main`, `user.name`/
`user.email` set locally, `core.autocrlf=false`, a committed `.gitattributes` of
`* -text` (this leaves the `diff` attribute unspecified, so `hasDiffAttribute` is false
and the predicate path still runs — verified against `changeShouldDrop`), and every git
call through `runGitAsync` with `{ ...runGitEnv(), ...IDENTITY }`. `runGitEnv()` already
strips every `GIT_*`, points `HOME` at a non-existent dir, sets `GIT_CONFIG_NOSYSTEM=1`
and `XDG_CONFIG_HOME` — but pass `-c merge.conflictStyle=merge` explicitly on any later
merge comparison anyway.

**Ledger shape** — the mechanism §Requirements 10 names:

```ts
interface LedgerRow {
  readonly fixture: string;                  // file name in the ledger repo
  readonly gitFlag: string | undefined;      // undefined ⇒ plain diff
  readonly diffOpts: ScenarioDiffOpts;
  /** What tsgit is KNOWN to answer where it differs from git today. Absent ⇒ tsgit
   *  must agree with git. Each fix commit deletes exactly its own entries. */
  readonly tsgitDivergence?: {
    readonly predicateSurvives?: boolean;
    readonly statSurvives?: boolean;
    readonly numstat?: readonly [number | '-', number | '-'];
    readonly patchIsBinary?: boolean;
  };
}
```

The assertion helper computes git's live verdict for the row (survivors via
`git diff-tree --no-ext-diff -r <flag> --name-only`, counts via `--numstat`, patch via
`-p`) and tsgit's predicate and stat verdicts, then asserts each field against
`tsgitDivergence?.<field> ?? <git's value>`. Deleting a `tsgitDivergence` field is
therefore the visible statement of what a fix commit changed.

**Fixtures — all from §Pin C / §Pin E / §Pin F, all with git's verdict already pinned.**
Build one commit pair per fixture (or per family where the flags share a pair):

*C4 family (Part 8 deletes these):* `lf-gain` (`x y` → `x y\n`), `lf-loss`
(`x y\n` → `x y`), `lf-gain-multi` (`a\nb\nc` → `a\nb\nc\n`), `sp-no-eol`
(`' '` → `'\n'`), `tab-no-eol` (`a\t` → `a\n`) — each across `-w`, `-b`,
`--ignore-space-at-eol` and `--ignore-cr-at-eol`; git **drops**, tsgit **keeps**
(`predicateSurvives: true, statSurvives: true`), except `sp-no-eol` under
`--ignore-space-at-eol` (both drop) and under `--ignore-cr-at-eol` (both keep), and
`tab-no-eol` under `--ignore-cr-at-eol` (both keep) — copy §Pin E-1's matrix row by row,
do not re-derive it. `lf-gain-plus-ws` (`x y` → `x  y\n`) belongs here too but is
divergent **only** under `-w` and `-b`; its `--ignore-space-at-eol` and
`--ignore-cr-at-eol` rows are controls where both tools keep.
**Controls that must NOT move:** `lf-gain-plus-txt` (`x y` → `x z\n`, kept everywhere),
`lf-gain-empty` (`''` → `'\n'`, kept under every single flag and dropped by **both** under
`-w --ignore-blank-lines`), `cr-then-lf` (`x y\r\n` → `x y\n`, dropped by both under all
four).
Plus `ctx-gain` (`a\nb` → `A\nb\n`) and `ctx-loss` (`a\nb\n` → `A\nb`) with
`numstat: ['2','2']` as tsgit's known answer where git says `1 1` under `-w`, and a
patch-bytes pin: git emits **no** `\ No newline at end of file` for `ctx-gain` and **one**
for `ctx-loss` (context rendered from the postimage).

*C6 (Part 9 deletes these):* `cr-no-eol` (`x y\r` → `x y`) under `--ignore-cr-at-eol` —
git **keeps**, tsgit **drops**. Its `-w`/`-b`/`--ignore-space-at-eol` rows are
**controls that must not move** (both drop).

*C5 family (Part 10 deletes the predicate-arm entries, Part 11 the rest):* `tail-ws`
(one 70 000-byte line, trailing-ws change; **345 B on disk ⇒ buffered arm**),
`rand-1line` (one 80 003-byte incompressible line, internal ws change; **80 045 B on
disk ⇒ streaming arm**), `len-65536` (one line 65 536 B → 65 537 B), `lines-100000`
(100 000 lines) — all under `-w`; git **drops**, tsgit **keeps** on both arms.
**These two disk sizes are the corrected mechanism for pinning both arms** (§Sizing (e)):
`tail-ws` exercises the buffered arm and `rand-1line` the streaming arm through the real
gate, with no threshold override anywhere. **Control that must not move:**
`long-line-txt` (70 000-byte line, **real content** change) — kept by both tools.

*C7 (Part 11 deletes this):* `lines-99999` (99 999 lines) under `-w` — the one row whose
divergence is **arm-specific**: tsgit's predicate **drops** (agreeing with git) and its
stat arm **keeps** (`predicateSurvives: false, statSurvives: true`). This row is what
makes §Requirements 9 executable.

*C8 (Part 12 updates, Part 13 deletes):* `longline` (one 70 000-`a` line + LF) and
`manylines` (100 001 lines) on the **plain** path — no whitespace flag — asserting
`numstat: ['-','-']` and `patchIsBinary: true` where git reports real counts and full
text hunks. Plus the **NUL-boundary pair** (a blob with NUL at offset 7 999 ⇒ binary, one
with NUL at offset 8 000 ⇒ text) as a **permanent control** that git's own rule is matched
exactly — it has never had an interop witness before, and §Pin F pinned git's window as
`[0, 8 000)` byte-for-byte.

**Cost control.** Keep the big fixtures (`lines-*`, `manylines`, `rand-1line`) to the
minimum rows that need them — `-w` only for the C5 line-count rows, plain only for C8.
Build every fixture's content programmatically, not as a literal.

**Parity scenario (§Requirements 8).** `test/parity/scenarios/diff-pipeline.scenario.ts`
(64 lines) — no `test/parity` scenario touches `ignoreWhitespace` today. Extend it:
after the existing second commit, write a **whitespace-only** rewrite of `a.txt`
(`'hello a\n'` → `'hello  a\n'`) plus a **real** change to `b.txt`, commit a third time,
then `repo.diff({ from: second.id, to: third.id, ignoreWhitespace: 'all' })` and record
the surviving paths in a new `DiffPipelineResult` field. Add the matching `expected`
entry. The existing `firstCommitId` / `secondCommitId` / `mergeBaseId` /
`flattenTreePaths` goldens are computed **before** the new commit and must not change —
if one moves, the new commit was inserted in the wrong place. This is the suite that
catches an adapter whose `Compressor.inflate` behaves differently (`test/parity/node.test.ts`
and `memory.test.ts` both assert against the same golden, and
`test/browser/parity.spec.ts` runs it through Playwright). `check:parity-fixtures` lints
the scenario for non-determinism — no `Date.now()`, no randomness.

**Do not** touch `test/integration/diff-whitespace-interop.test.ts` (1 159 lines, the full
W/B/EOL/CR/BL/M/D/C matrix vs live git and frozen goldens) in this part; it already covers
the fast path automatically — its blobs are far under the gate, so where it exercised the
streaming arm before Part 6 it exercises the buffered arm after.

### TDD steps

1. **RED** — add the ledger `describe`, its repo builder and the C4-family rows with
   `tsgitDivergence` **omitted**. Expected failure: 20-odd rows fail because tsgit keeps
   what git drops — that failure list is exactly §Pin E-1's ✗ column and is the proof the
   ledger measures the right thing.
2. **GREEN** — fill in each failing row's `tsgitDivergence` from the *observed* verdict,
   then **cross-check every one against §Pin C / §Pin E / §Pin F's tsgit column**. A row
   whose observed verdict differs from the pinned column means Part 6 moved a verdict
   after all: **escalate immediately** — this is the strongest available form of
   blind-spot 9's mechanical check.
3. **RED** — repeat for the C5, C6, C7 and C8 rows, including the numstat and patch-byte
   fields.
4. **RED** — extend the parity scenario; expected failure: the new `expected` field is
   missing/wrong until the third commit is wired.
5. **GREEN** — parity scenario passes on the Node and Memory drivers.
6. **REFACTOR** — one table-driven `it.each` over the ledger (row field named `label`,
   **not** `then` — biome's `noThenProperty`); the git-side and tsgit-side verdict
   computations as two small helpers; no per-row copy-paste.

### Gate

```
npx vitest run test/integration/diff-whitespace-modes-interop.test.ts test/integration/diff-whitespace-interop.test.ts && npx vitest run --project parity && npm run check:types && ./node_modules/.bin/biome check test/integration/diff-whitespace-modes-interop.test.ts test/parity/scenarios/diff-pipeline.scenario.ts
```

### Commit

```
test(diff): pin both drop-pass arms and the known git divergences against git
```

## Part 8 — a final-terminator difference is whitespace when the key is active

### Context

ADR-557 (C4). **The rule:** git ignores a difference in the **final line's terminator**
under every flag that makes it compare content — `-w`, `-b`, `--ignore-space-at-eol`
**and** `--ignore-cr-at-eol` — symmetrically (LF gained and LF lost behave identically).
It never does so under plain diff or under `--ignore-blank-lines` alone. That set is
exactly `lineKeyIsActive(key)` (`mode !== 'none' || ignoreCrAtEol`), which is also the
condition that gates the drop pass into existence (`diff-trees.ts:96`). So:

> **A line's trailing LF is part of its identity iff the line key is inactive.**

The rule can only ever bite the **last** line pair — `splitLines` emits a terminated line
for every non-final line by construction, and so does the scanner (`sawLf` is false only
on the step that also sees `end()`), so `terminated` can differ on no other index. That
bounds the blast radius to the final line of a file and is the argument that no mid-file
alignment moves.

**Three sites, one commit.**

1. **`src/domain/diff/whitespace.ts` → `normalizeLine`** (line 107, the allocating form,
   the `withStat` twin). Today each mode branch re-appends the LF (`if (end <
   bytes.length) out.push(LF)` in `dropAllWs`/`collapseRuns`, and the equivalent in
   `dropTrailingWs`/`dropTrailingCr`). Apply **one terminator strip to the switch's
   result** rather than threading a guard into four helpers — smaller and provably
   uniform, and it leaves the four helpers' **six** existing equivalent-mutant proofs
   untouched and still true:
   ```ts
   export function normalizeLine(bytes: Uint8Array, key: LineKey): Uint8Array {
     const normalized = normalizeUnderMode(applyCrRule(bytes, key), key);   // today's body
     return lineKeyIsActive(key) ? stripTerminator(normalized) : normalized;
   }
   ```
   This is what makes the **stat arm** correct: `internOne` (`line-diff.ts:289`) interns
   `binaryStringOf(normalizeLine(line, key))`, so the last-line pair now interns to one
   id and Myers marks it *common*. For a terminator-only difference `computeStatFields`
   then returns `added = deleted = 0` and `shouldDrop` fires — the stat arm reaches the
   predicate arm's verdict **through its own code path**, which is what ADR-513 requires
   (blind-spot 11). For `ctx-gain`/`ctx-loss` the counts fall from `2 2` to `1 1`.
2. **`src/domain/diff/whitespace.ts` → the fold's emit step** (Part 2's
   `createLineDigestFold`). The terminator must be suppressed **at construction**, not at
   comparison: the fold mixes the LF into the FNV hash, so leaving `terminated` in place
   and ignoring it in `digestsEqual` would still yield different hashes (`sp-no-eol` is
   the fixture that proves this — both sides normalize to zero content bytes and only the
   folded LF distinguishes them). The emit step's guard becomes:
   ```
   terminated = sawLf && !lineKeyIsActive(key)
   hash       = terminated ? fnvMix(pair.hash, LF) : pair.hash
   ```
   Under an active key the LF is neither folded nor reported — cheaper than today, not
   merely equivalent. Compute `lineKeyIsActive(key)` **once** when the fold is created.
   `digestsEqual` is **unchanged, deliberately**: `whitespace.test.ts:851`'s hand-built
   digest case ("terminated differs, length and hash match ⇒ false") is what keeps the
   `a.terminated === b.terminated` conjunct a killable mutant once the predicate can no
   longer produce a `terminated: true` digest. **That case is load-bearing — never delete
   it**; say so in a comment next to it.
3. **`src/domain/diff/patch-serializer.ts` → `trailingNoNewline`** (line 327). Once the
   last pair can be *common* with differing termination, the `context` branch's
   `(isLastOld && !ctx.oldHasTrailingNewline) || (isLastNew && !ctx.newHasTrailingNewline)`
   (line 341) emits a `\ No newline at end of file` marker git does not. git's rule is
   **postimage only** — context text already comes from `newLines`
   (`commonEditsFrom`, line 171), and the marker must too:
   ```ts
   if (edit.kind === 'context') return isLastNew && !ctx.newHasTrailingNewline;
   ```
   **The two `Stryker disable` directives at lines 338 and 340 are falsified by this
   commit and must be DELETED, not re-anchored.** Both rest on the premise *"a
   byte-identical context match forces equal trailing-newline state"*, which is exactly
   what this fix destroys; after the change the OR is gone, so there is nothing left to
   prove equivalent. A directive re-anchored onto the new line would suppress a live
   mutant. This is the same structure-falsifies-a-carried-proof failure this repository
   has already shipped once (blind-spot 10). The two directives on `isLastOld` (line 329)
   and `isLastNew` (line 334) are about *which branch reads the value* and are
   **unaffected** — leave them.

**What else consumes the pair — verified across `src/` at plan time:**
- `LineDigest.terminated` has **no** reader outside `digestsEqual`; `digestNormalizedLine`
  / `digestIsBlank` / `digestsEqual` have no consumer outside the drop predicate.
- `normalizeLine` has exactly three internal consumers — `linesEqualUnder` (`whitespace.ts:121`),
  `isBlankLine` (144), `internOne` (`line-diff.ts:289`) — plus its public export.
  `linesEqualUnder` **inherits the rule** and thereby starts agreeing with git's
  `xdl_recmatch` under an active key; it has zero internal callers, so this is a public
  behaviour change with no internal blast radius. `isBlankLine` is **provably
  unaffected**: a blank terminated line normalizes to empty under both old and new rules
  (`lfIndex('') === 0`) and a non-blank line's content length is unchanged — verified
  against both call sites (`stat-fields.ts:39/44`, `patch-serializer.ts:225`).

**Which assertions this commit flips — and which must NOT move:**
- `test/unit/domain/diff/whitespace.test.ts`: the `normalizeLine` rows whose `expected`
  ends in `\n` — 8 of the 25 rows in that section, all under an active key. The
  `{ mode: 'none', ignoreCrAtEol: false }` blocks at lines **264** and **459** are
  **inactive and must not move**; the `{ mode: 'none', ignoreCrAtEol: true }` block at
  line **290 is active and does** move. The digest case at line **683**
  (`{ mode: 'none', ignoreCrAtEol: false }`, terminated vs unterminated) **must not
  flip** — it is the regression net for the gating, and it is also M5 kill test (i)'s
  twin. The `digestsEqual` hand-built case at line **851** must not flip.
- The `expectedDigest` oracle (lines 40–45): **check, do not assume.** It derives
  `terminated` and the hash from `normalizeLine`'s **own output**, so once `normalizeLine`
  strips the terminator under an active key the oracle should follow automatically. If it
  does, **add no guard** — a guard would make the oracle encode the rule twice and stop it
  being independent. Only if oracle and fold disagree is there work here, and then decide
  which of the two is wrong before editing either.
- `test/unit/domain/diff/patch-serializer.test.ts`: the context-edit no-newline cases.
- `test/integration/diff-whitespace-modes-interop.test.ts`: **delete the C4-family
  `tsgitDivergence` entries** (`lf-gain`, `lf-loss`, `lf-gain-multi`, `sp-no-eol`,
  `tab-no-eol`, `lf-gain-plus-ws`, and the `ctx-gain`/`ctx-loss` numstat entries). The controls
  (`lf-gain-plus-txt`, `lf-gain-empty`, `cr-then-lf`) must not move, and `cr-no-eol` stays
  divergent (Part 9 owns it).
- **No `diff-trees.test.ts` case flips.** If one does, the blast radius is wider than the
  final line and the design's bounding argument is wrong — **escalate**.
- `line-diff.test.ts` and `stat-fields.test.ts` are in the gate because `internOne` now
  interns a terminated and an unterminated last line to the **same** id under an active
  key. A flip there is *within* the rule only if it is a **final-line** case — check that
  before accepting it. A mid-file flip contradicts the bounding argument above and must be
  escalated, not absorbed.

**Unit coverage to add** (§Test strategy): `normalizeLine` + the fold over the four active
key shapes × {terminated, unterminated} × {blank, non-blank}, with the **inactive** key
asserted unchanged (that gate is the whole fix); `trailingNoNewline` context edits for a
gained and a lost terminator; `linesEqualUnder` and `isBlankLine` regression cases.

**Size:** ~15 lines of `src` across three files, two deleted Stryker directives, ~12 test
rows. Larger than "flip an assertion", but a single coherent commit.

### TDD steps

1. **RED** — flip the 8 active-key `normalizeLine` rows and add the four-shape matrix.
   Expected failure: `normalizeLine` still appends the LF, so `expected` (now without it)
   mismatches.
2. **RED** — add the digest half: for each active key, `"x y"` and `"x y\n"` must digest
   **equal**; for the inactive key they must digest **different**. Expected failure: the
   fold still folds the LF and reports `terminated: true`.
3. **RED** — `patch-serializer.test.ts`: a context edit at the file's end where the
   preimage is unterminated and the postimage is terminated must emit **no** marker.
   Expected failure: the OR's left operand fires.
4. **GREEN** — the three sites; delete the two falsified directives.
5. **VERIFY** — delete the C4 ledger entries and run the interop suite; the C4 rows must
   now agree with git on **both** arms. `survivorPaths(predicateResult) ===
   survivorPaths(statResult)` on those rows is the executable check that the write-path
   twin landed in the same commit (blind-spot 11) — a read-path-only fix turns it red
   rather than passing quietly.
6. **REFACTOR** — `stripTerminator` as one named helper; do not inline the strip into the
   four mode helpers.

### Gate

```
npx vitest run test/unit/domain/diff/whitespace.test.ts test/unit/domain/diff/whitespace.properties.test.ts test/unit/domain/diff/patch-serializer.test.ts test/unit/domain/diff/patch-serializer.properties.test.ts test/unit/domain/diff/line-diff.test.ts test/unit/domain/diff/stat-fields.test.ts test/integration/diff-whitespace-modes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/whitespace.ts src/domain/diff/patch-serializer.ts test/unit/domain/diff/whitespace.test.ts test/unit/domain/diff/patch-serializer.test.ts test/integration/diff-whitespace-modes-interop.test.ts
```

### Commit

```
fix(diff): treat a final-line terminator difference as whitespace under an active key
```

## Part 9 — a CR ending an incomplete final line is content under ignore-cr-at-eol

### Context

ADR-559 (C6). git's `--ignore-cr-at-eol` ignores a CR **only immediately before a real
newline**; a CR ending an *incomplete* final line is significant. Under `-w`, `-b` and
`--ignore-space-at-eol` the same CR *is* dropped by both tools, because there it is
ordinary trailing whitespace. tsgit strips a trailing CR regardless of termination —
stricter than git under the three whitespace modes (no observable difference) and
**looser** under `--ignore-cr-at-eol` alone (an observable wrong drop).

**One condition, both sides of the rule:**

```ts
const crApplies = key.mode !== 'none' || (key.ignoreCrAtEol && terminated);
```

1. **`src/domain/diff/whitespace.ts` → `applyCrRule`** (line 100). It currently does not
   know `terminated`; the value is `lfIndex(bytes) < bytes.length`, already computed by
   `lfIndex` inside `dropTrailingCr`. Thread it in — either by computing `lfIndex` in
   `applyCrRule` or by passing termination down. Keep `dropTrailingCr`'s **two** existing
   equivalent-mutant proofs valid: they are about `crPos < 0` and the out-of-bounds write,
   neither of which this change touches. If threading termination changes the lines those
   directives sit on, **re-anchor them onto the expression lines they still describe** and
   re-read each proof against the new text — do not move a directive blindly.
2. **`src/domain/diff/whitespace.ts` → the fold's emit step** (Part 2 + Part 8). §D1.4
   already showed where it goes — a single boolean read at the line's emit step, no second
   pass, no lookahead:
   ```
   useTentative = pendingCr && key.mode === 'none' && !sawLf   // an incomplete line's CR is content
   pair         = useTentative ? tentative : committed
   ```
   The CR is still classified **soft on sight** (unchanged); only the *choice of which
   pair to emit* becomes conditional. The two rules are independent and cannot both fire:
   `useTentative` requires `!sawLf`, the LF fold requires `sawLf`. Under `mode !== 'none'`
   the CR is droppable unconditionally (§Pin E-1 `cr-no-eol` under `-w`/`-b`/`at-eol`:
   both tools drop), so `committed` always wins there; under
   `mode: 'none' + !ignoreCrAtEol` the key is inactive, `pendingCr` is never set and the
   branch is dead.

**This commit is where M5's killed proof pays off (§D4, Part 5).** The `sawLf` bit that
this rule makes load-bearing is exactly what the deleted
`Stryker disable next-line BooleanLiteral` used to claim was unobservable. **Ship kill
test (ii) here**: `{ mode: 'none', ignoreCrAtEol: true }` over `"x y\r"` vs `"x y\r\n"` —
the digests must differ. This kills the mutant on the **active-key path the predicate
actually uses**; kill test (i) in Part 5 covers the inactive path. Say so in this commit.

**Which assertions flip, and which must not:**
- `test/unit/domain/diff/whitespace.test.ts`: the unterminated-CR rows at lines
  **312–325** ("When the CR guard is evaluated near unterminated or CR-free content")
  flip. Line **698** ("Given ignoreCrAtEol true with mode none, When digesting a
  CR-terminated line") **stays green** — that line *is* terminated.
- `test/integration/diff-whitespace-modes-interop.test.ts`: delete `cr-no-eol`'s
  `--ignore-cr-at-eol` `tsgitDivergence` entry. Its `-w`/`-b`/`--ignore-space-at-eol`
  rows are controls and must not move.
- Add unit coverage for the CR rule × {terminated, unterminated} × the four key shapes.

**Size:** ~4 lines of `src`. It carries **no** dependency on the cap work and could be
swapped with Part 10 at the cost of rebase noise only; it is sequenced here because it
touches the two functions Part 8 just changed and rebases cheapest immediately after.

### TDD steps

1. **RED** — kill test (ii): `"x y\r"` vs `"x y\r\n"` under `{ mode: 'none',
   ignoreCrAtEol: true }` must digest **differently**. Expected failure: today's
   unconditional CR drop makes both sides digest identically.
2. **RED** — the `normalizeLine` twin: `normalizeLine(enc('x y\r'), { mode: 'none',
   ignoreCrAtEol: true })` must keep the CR. Expected failure: `applyCrRule` strips it.
3. **RED** — flip the whitespace.test.ts rows at 312–325.
4. **GREEN** — the `crApplies` condition in `applyCrRule` and the `useTentative` choice in
   the fold's emit step.
5. **VERIFY** — delete the `cr-no-eol` ledger entry; the interop row must now agree with
   git on both arms, and its three control rows must be untouched.
6. **REFACTOR** — the condition appears **twice** (allocating twin and fold). Express it
   once as a small exported-internal predicate if that reads better than duplicating it,
   but do not create a third rule.

### Gate

```
npx vitest run test/unit/domain/diff/whitespace.test.ts test/unit/domain/diff/whitespace.properties.test.ts test/unit/domain/diff/line-digest-scanner.test.ts test/integration/diff-whitespace-modes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/whitespace.ts test/unit/domain/diff/whitespace.test.ts test/integration/diff-whitespace-modes-interop.test.ts
```

### Commit

```
fix(diff): keep a CR that ends an incomplete final line under ignore-cr-at-eol
```

## Part 10 — the line caps stop deciding the drop verdict

### Context

ADR-558 + ADR-564 (C5, predicate arm). **This part is a deletion.** Its diff is the
clearest possible statement of the change: *the caps stopped deciding*.

**The threat argument, settled.** Under the incremental fold there is nothing left for
the caps to protect: `MAX_LINES` never bounded an allocation (it was a counter), and
`MAX_LINE_BYTES` bounded `state.buffer`, which no longer exists. Peak per side is
`sizeof(FoldState)` plus a **borrowed** chunk reference. A 500 MB single-line minified
bundle costs the streaming arm one chunk, whatever the transport hands over. So this is
not "delete the caps and accept a risk" and not "keep a bound where it still buys
something" — there is no replacement bound because there is nothing left to bound.

**Delete, in `src/domain/diff/line-digest-scanner.ts`:** the `currentLineBytes` and
`lineCount` counters, the `capsExceeded` getter, its doc comment, and the `MAX_LINE_BYTES`
/ `MAX_LINES` imports.

**Delete, in `src/application/primitives/internal/whitespace-drop-predicate.ts`:** the two
`|| old.capsExceeded` / `|| next.capsExceeded` operands in the verdict ladder's first
line, leaving `if (old.binary || next.binary) return false;`.

**Delete, in `test/unit/domain/diff/line-digest-scanner.test.ts`:** the `capsExceeded`
scaffold block wholesale (the `MAX_LINE_BYTES`-on-one-line case, the `MAX_LINES`
blank-lines case, and the many-short-lines case). **The memory block does NOT move** —
it is the load-bearing claim now, and blind-spot 12's executable form.

**Delete, in `test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts`:**
the two scaffold-operand cases (over-`MAX_LINE_BYTES` line kept, over-`MAX_LINES` file
kept). The NUL-side case **stays** — `binary` still means NUL-in-window.

**Invert, in `test/unit/application/primitives/diff-trees.test.ts:1728-1749`:** *"Given a
single unterminated line longer than the line cap, whitespace-only change … Then the file
is kept"* becomes **dropped**, and the test's remaining comment about the cap mechanism is
**deleted rather than rewritten** — there is no bail and no cap left to describe. Retitle
the `describe`/`it` so it reads as "a whitespace-only change on a very long line is
dropped, like git".

**Ledger, `test/integration/diff-whitespace-modes-interop.test.ts`:** delete the
**predicate-arm** `tsgitDivergence` fields for `tail-ws`, `rand-1line`, `len-65536` and
`lines-100000` (`predicateSurvives`), leaving their `statSurvives` entries for Part 11.
`long-line-txt` is the control and must keep surviving on both tools. Both arms stay
mandatory in the suite: under ADR-558 they are **one code path**, so `tail-ws` (buffered)
and `rand-1line` (streaming) are the executable witness to that claim rather than coverage
of a second route.

**`MAX_LINE_BYTES` and `MAX_LINES` are NOT touched here.** They keep their values and
their exports; only the scanner and the predicate stop reading them. After this part
`MAX_LINE_BYTES`'s live consumers in `src/` are `line-diff.ts::exceedsLineCaps` and
`grep.ts:143-148`'s binary-presence-probe bound; `MAX_LINES`'s is `exceedsLineCaps` alone.
Parts 12/13 finish that story.

### TDD steps

1. **RED** — invert the `diff-trees.test.ts` long-line case to expect `changes` length
   **0**. Expected failure: the scaffold still flags the side and the file is kept.
2. **RED** — delete `tail-ws`'s and `rand-1line`'s `predicateSurvives` entries from the
   ledger. Expected failure: tsgit's predicate still keeps them where git drops.
3. **GREEN** — delete the two counters, the derived boolean and the two predicate
   operands.
4. **VERIFY** — the scanner's memory block still passes untouched; `grep.test.ts`,
   `stat-fields.test.ts`, `line-diff.test.ts` and `patch-serializer.test.ts` are all
   untouched (they build binary fixtures out of **NUL bytes**, never out of length —
   checked across all five files at plan time).
5. **REFACTOR** — none expected; if the scanner's `next()` simplifies once the counters
   are gone, take it.

### Gate

```
npx vitest run test/unit/domain/diff/line-digest-scanner.test.ts test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts test/unit/application/primitives/diff-trees.test.ts test/integration/diff-whitespace-modes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/line-digest-scanner.ts src/application/primitives/internal/whitespace-drop-predicate.ts test/unit/domain/diff/line-digest-scanner.test.ts test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts test/unit/application/primitives/diff-trees.test.ts test/integration/diff-whitespace-modes-interop.test.ts
```

### Commit

```
fix(diff): stop the line caps deciding the whitespace drop verdict
```

## Part 11 — the stat arm takes its drop verdict from the shared scanner

### Context

ADR-560 (C5 stat arm + C7). tsgit's two arms **already disagree on `main` today**: a
whitespace-only change to a file whose two sides total more than 50 000 lines is
**dropped by the predicate arm** (agreeing with git) and **kept by the stat arm**. The
cause is not the caps — at 99 999 lines `isBinary` is false — but `diffLines` refusing
`M + N > MAX_DIFF_LINES = 50 000` and returning `wholeFileFallback` with
`added = deleted = 99 999`, so `shouldDrop`'s `added === 0` test fails. That is a live
violation of ADR-513's consistency clause and of the invariant
`diff-whitespace-modes-interop.test.ts` exists to assert; the suite is green today only
because its fixtures are two lines long.

**File: `src/application/primitives/diff-trees.ts`** (read lines 129–290).
- `applyStatPass` (line 177) currently computes `stats = computeStatFields(...)` once and
  uses it for **both** the counts and the verdict (`if (lineKeyActive && shouldDrop(
  file.change, stats)) continue;`, line 194). `stats` **keeps being computed exactly as
  today and keeps populating the `withStat` surface**; only the keep/drop decision moves:

  ```
  dropVerdict(file, lineKey, ignoreBlankLines) =
    file.numstatBinaryOverride === 'binary' ? false
    : hasNulInWindow(old) || hasNulInWindow(next) ? false
    : scanEqual(old, next, lineKey, ignoreBlankLines)   // the shared scanner, one push per side
  ```
- `materialisedShouldDrop` (line 268) — the attribute-steered twin — moves onto the same
  `dropVerdict`, so the two paths cannot drift.
- **`dropVerdict` must keep `shouldDrop`'s first conjunct**: `change.type === 'modify'`.
  `applyStatPass`'s loop runs over **every** file, adds and deletes included, and only
  modifies are ever droppable (type-changes, renames, copies, adds and deletes are never
  dropped). Losing that guard would silently delete added files from a `-w` diff. Check it
  **before** touching content, and keep the outer `lineKeyActive &&` guard too — with no
  active key nothing is ever dropped, `withStat` or not.
- `shouldDrop` (line 335) is called from exactly two places — `applyStatPass:194` and
  `materialisedShouldDrop:284` — both of which move onto `dropVerdict` here, so it becomes
  dead and must be **deleted**, not left behind. Confirm with
  `find_referencing_symbols` before deleting.
- **`applyStatPass`'s doc comment (lines 170–176) stops being true** — "The stat and drop
  predicate share one `computeStatFields` call per modify so drop and counts are mutually
  consistent" is no longer the mechanism. Rewrite it to describe the new one: consistency
  is held **by construction**, because both arms run the same scanner.
- `statOptionsFor` (line 132) and its **two** inline `equivalent-mutant:` notes (lines 139
  and 141) are **untouched by this part** — do not edit them.

**File: `src/domain/diff/line-diff.ts`** — `hasNulInWindow` (line 49) is currently
module-private and must be **exported** for the `dropVerdict` call site. It must **not** be
added to `src/domain/diff/index.ts`; no public surface moves.

**`scanEqual`** is a small helper — where it lives is yours to choose, but it belongs
next to the scanner (domain) rather than in `diff-trees.ts`: create both scanners with
`createLineDigestScanner(key, ignoreBlankLines)`, `push` the whole buffer into each,
`end()`, then run the same verdict ladder Part 6's `compareBuffered` uses. **Do not write
a second ladder** — extract Part 6's and share it, or the two arms can drift again, which
is the exact failure this part exists to end.

**`.gitattributes` overrides keep their meaning** — `-diff` ⇒ forced binary ⇒ never
dropped. The `numstatBinaryOverride === 'binary'` branch is checked **first**, and
`diff-whitespace-modes-interop.test.ts`'s attribute suite (line 187) already pins it.

**Blind-spot 14 — check it, do not assume it:** a change *dropped* by the new
`dropVerdict` can never surface counts (it is filtered out before `surviving.push`), and a
change that survives carries **exactly today's counts**. The fix moves the verdict, not
the numbers. Add an assertion for both halves.

**Ledger:** delete the remaining C5 `statSurvives` entries (`tail-ws`, `rand-1line`,
`len-65536`, `lines-100000`) **and** the C7 entry (`lines-99999`, the one row whose
divergence is arm-specific). After this part every `-w` row in the ledger asserts
`predicateSurvivors === statSurvivors === git survivors` with no override — that is
§Requirements 9 made executable over inputs that actually reach the disagreeing code.

**Unit coverage to add:** the stat arm's `dropVerdict` for a NUL side, a `-diff`-override
side, and an over-`MAX_DIFF_LINES` pair (in `diff-trees.test.ts`).

**Size:** ~35 lines of `src` plus one export.

### TDD steps

1. **RED** — in `diff-trees.test.ts`, a `withStat: true` whitespace-only diff of a pair
   totalling more than 50 000 lines must return **zero** surviving changes. Expected
   failure: `diffLines` degrades, `added === 99 999`, `shouldDrop` is false, the file
   survives.
2. **RED** — a NUL-bearing side under `withStat: true` must **survive** (binary is never
   dropped), and a `-diff`-attributed side must survive. Expected failure: none yet —
   write these as the guard rails that must stay green through the change, and confirm
   they are green *before* touching `src/`.
3. **RED** — delete the C7 ledger entry. Expected failure: `survivorPaths(statResult)`
   still keeps `lines-99999` where git and the predicate drop it.
4. **GREEN** — export `hasNulInWindow`; route `applyStatPass` and
   `materialisedShouldDrop` through `dropVerdict`; rewrite `applyStatPass`'s comment.
5. **VERIFY** — a surviving change's `added`/`deleted` are byte-identical to today's for
   every existing `withStat` case in `diff-trees.test.ts` (blind-spot 14).
6. **REFACTOR** — the verdict ladder exists **once**, shared by `compareBuffered`,
   `compareStreamed` and `scanEqual`.

### Gate

```
npx vitest run test/unit/application/primitives/diff-trees.test.ts test/unit/domain/diff/line-diff.test.ts test/unit/domain/diff/stat-fields.test.ts test/unit/domain/diff/line-digest-scanner.test.ts test/integration/diff-whitespace-modes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/diff-trees.ts src/domain/diff/line-diff.ts src/domain/diff/line-digest-scanner.ts test/unit/application/primitives/diff-trees.test.ts test/integration/diff-whitespace-modes-interop.test.ts
```

### Commit

```
fix(diff): take the stat path's drop verdict from the shared line scanner
```

## Part 12 — binary detection is the NUL window alone

### Context

ADR-561 (C8, the caps). **`isBinary` becomes NUL-only** — exactly git's rule, whose window
§Pin F pinned as `[0, 8 000)` byte-for-byte (NUL at offset 7 999 ⇒ binary, at 8 000 and
8 001 ⇒ text). `hasNulInWindow` already implements precisely that, so **the surviving rule
needs no change at all**; only the disjunct beside it goes.

**File: `src/domain/diff/line-diff.ts`:**

```ts
export function isBinary(bytes: Uint8Array): boolean {
  return hasNulInWindow(bytes);
}
```

- `exceedsLineCaps` (line 57) is **deleted** — it has no other caller, and its mutants go
  with it.
- `MAX_LINE_BYTES` and `MAX_LINES` stay **exported at today's values** (65 536 / 100 000)
  with their documentation rewritten to say what they are and are not.
  **Write those docs as `//` line comments, never `/** … */`** — typedoc's `jsdoc` comment
  style would add a `comment` node to `reports/api.json`, and `check:doc-typedoc` is a
  **prepush** gate that a green local `validate` will not catch. If you decide TSDoc is
  worth it, run `npm run docs:json` and commit `reports/api.json` in this same commit.
- After this part `MAX_LINE_BYTES` keeps exactly one live consumer in `src/` —
  `grep.ts:143-148`'s binary-presence-probe bound — and `MAX_LINES` keeps **none**. Both
  are re-exported from `src/public-types.ts`, which is a knip entry point, so
  `check:dead-code` treats them as public API; confirm that **before** the commit, not
  after.

**Why the caps go, measured (§Pin G):** a 70 000-byte line through `diffLines` costs
**0.2 ms** and no measurable heap, because it is *two lines*. Line **length** never drove
`diffLines`' cost; line **count** does, and that is `MAX_DIFF_LINES`'s business (Part 13).
`splitLines` already produces `subarray` views, not copies, so a long line costs one view.

**Six consumers, zero code edits — but PROVE it, do not assume it (blind-spot 16).**
Every one inherits `isBinary`; §D9.3 asserts not one is edited. Check each call site for a
**second, independent cap assumption** (an array pre-size, a `slice`, a loop bound) that
the caps were quietly making safe:
- `src/domain/diff/stat-fields.ts:85` (`computeStatFields` → `--numstat`)
- `src/domain/diff/patch-serializer.ts:54` (`sideIsBinary`) and
  `src/application/primitives/materialise-patch-files.ts` — **six** `isBinary` call sites
  (lines 187, 210, 235, 251, 279, 313); check all six, not the two the design names
- `src/application/commands/grep.ts:139`
- `src/domain/merge/three-way-content.ts:114`
- `src/application/primitives/patch-id.ts:55`
- `src/domain/range-diff/patch-text.ts:128`

**What completes here and what does not (§Pin F's last column — this is why the interop
cases split by fixture):**
- **`longline` (70 000-byte line, 2 lines total) is correct on all six surfaces after this
  part** — `1 1` numstat, full text hunks, text grep hits, a textual `<<<<<<<` merge
  conflict (never `conflictType: 'binary'`), a real patch-id, full range-diff hunks.
- **`manylines` (100 001 lines) is correct only on `grep`**, which never touches
  `diffLines`. On the other five it converts "wrongly binary" into "wrongly degraded", and
  on merge that is arguably **worse** than today (git auto-merges the pair **cleanly**;
  tsgit today refuses it as binary and keeps ours; after this part alone it would emit a
  **whole-file conflict region**). **This part alone is not shippable; Part 13 is not
  optional.**

**Interop cases to add — `longline` only, each in the suite that already owns the
consumer, each pinned against live git in the same run (never against a frozen constant):**
- `test/integration/grep-interop.test.ts` — text hits with real line numbers on
  `longline`; control: a NUL blob still yields `Binary file … matches`.
- `test/integration/merge-conflict-interop.test.ts` — two edits on the single
  70 000-byte line produce a **textual** conflict with real `<<<<<<< HEAD` /
  `>>>>>>> theirs` markers, **not** `conflictType: 'binary'`. Pin the peer with
  `-c merge.conflictStyle=merge`.
- `test/integration/range-diff-interop.test.ts` — full hunks inside the `## file ##`
  block, **zero** `Binary files` lines; pin the peer with `--creation-factor=999` so the
  pair actually matches (at the default factor a 70 000-byte patch is simply *unpaired* —
  a similarity heuristic, not a binary decision).
- `test/integration/diff-whitespace-interop.test.ts` — a plain-path numstat row for
  `longline` (`1 1`) and the **NUL-boundary control pair** (offset 7 999 ⇒ `- -`, offset
  8 000 ⇒ real counts) against live git.
- `test/integration/diff-attr-binary-interop.test.ts` — the `-diff`/`diff` overrides keep
  **exact** priority over the content sniff: the control that must **not** move.
- `patch-id` has no interop suite; add one unit case in its existing suite asserting an
  over-cap NUL-free file **no longer lands in the `binaryKey` oid list**
  (`patch-id.ts:55`).

**Ledger:** the `manylines` C8 rows are **updated, not deleted** — from
`numstat: ['-','-'] , patchIsBinary: true` to `numstat: [100001, 100001], patchIsBinary:
false` (still divergent from git's `1 1`-style real hunks, now for a different reason).
The `longline` C8 rows are **deleted**. Say in the commit that the `manylines` family
moves from "wrongly binary" to "wrongly degraded" and that Part 13 finishes it.

**Unit assertions that flip — `test/unit/domain/diff/line-diff.test.ts:148-176`:** four
`isBinary` rows invert `true` → `false`: `MAX_LINE_BYTES` bytes on one line; `MAX_LINES`
lines; `MAX_LINES` via a trailing incomplete line; and the two `-1` rows stay `false`
**for a different reason** (they were never binary) — their titles must stop implying the
cap. The NUL rows and the `BINARY_DETECTION_BYTES` boundary pair (7 999 ⇒ `true`,
8 000 ⇒ `false`) are the **controls that must not move**, and they now gain an interop
witness for the first time.

**Verified not to flip** (checked across all five files at plan time):
`stat-fields.test.ts`, `patch-serializer.test.ts`, `patch-serializer.properties.test.ts`,
`materialise-patch-files.test.ts` and `grep.test.ts:400` build every binary fixture out of
**NUL bytes**, never out of length — `grep.test.ts:400` sets `blob[0] = 0x00` explicitly,
so its `MAX_LINE_BYTES` probe-bound assertion is unaffected.

**Blind-spot 15, to raise in review rather than fix here:** after this part a 500 MB
single-line minified blob is **text**, so a caller's `RegExp` runs against a 500 MB latin1
line on `grep`'s *text* branch, which has no bound (the `MAX_LINE_BYTES` probe bound is on
the **binary** branch only, and `grep.ts:143-148` names the hazard explicitly). §Pin F-3
shows this is git's own posture and the prime directive binds it — but it is the single
most attackable claim in this PR. Do **not** silently add a guard; surface it.

### TDD steps

1. **RED** — invert the four `isBinary` rows in `line-diff.test.ts:148-176` and retitle
   the two `-1` rows. Expected failure: `exceedsLineCaps` still returns true.
2. **RED** — add the `longline` consumer interop cases (grep, merge conflict, range-diff,
   plain numstat, patch-id unit). Expected failure: each currently reports binary.
3. **GREEN** — `isBinary` becomes `hasNulInWindow`; delete `exceedsLineCaps`; rewrite the
   two constants' `//` docs.
4. **VERIFY** — walk all six consumers (all six `materialise-patch-files.ts` sites
   included) for a second cap assumption; run the full unit + integration suites and
   confirm nothing outside the four inverted rows moved.
5. **UPDATE** — the `manylines` ledger rows to their new (degraded) verdicts; delete the
   `longline` rows.
6. **REFACTOR** — none; the diff is two lines of `isBinary` plus a deleted helper.

### Gate

```
npx vitest run test/unit/domain/diff/line-diff.test.ts test/unit/domain/diff/stat-fields.test.ts test/unit/domain/diff/patch-serializer.test.ts test/unit/application/primitives/patch-id.test.ts test/unit/application/commands/grep.test.ts test/unit/domain/merge && npx vitest run test/integration/grep-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/range-diff-interop.test.ts test/integration/diff-attr-binary-interop.test.ts test/integration/diff-whitespace-interop.test.ts test/integration/diff-whitespace-modes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/line-diff.ts test/unit/domain/diff/line-diff.test.ts test/integration/grep-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/range-diff-interop.test.ts test/integration/diff-whitespace-interop.test.ts test/integration/diff-whitespace-modes-interop.test.ts
```

### Commit

```
fix(diff): detect binary content by NUL window alone
```

## Part 13 — bound the edit distance, not the input size

### Context

ADR-563 (DC-16→B). **Not optional, and never separated from Part 12** — Part 12 alone
leaves five of six surfaces wrongly degraded and merge output arguably worse than today.

**File: `src/domain/diff/line-diff.ts`:**

1. **Delete the input-size pre-check** in `diffLines` (lines 351–355):
   ```ts
   // Interning every line is O(M+N) work — skip it entirely when the trace
   // computation would refuse the input anyway.
   if (M + N > MAX_DIFF_LINES) return wholeFileFallback(oursLines, theirsLines);
   ```
   §Pin G-3/G-4: a 50 000-line pair with a **one-line edit** costs **3.6 ms / 7.8 MB**,
   and two lines larger it refuses outright. The cliff protects nothing for the shape that
   matters.
2. **Activate the already-exported, currently-inert `MAX_DIFF_EDIT_DISTANCE = 10 000`**
   as a live **edit-distance** bail in `computeMyersTrace` (line 120): bail at the top of
   each `d` iteration —
   ```ts
   for (let d = 0; ; d++) {
     if (d > MAX_DIFF_EDIT_DISTANCE) return undefined;
     …
   }
   ```
   and **delete** the `iterations` counter and the
   `iterationBudget = maxD * MAX_DIFF_ITERATION_FACTOR` expression (lines 135–136, 153–154)
   with it. **Why the counter goes rather than being re-based on
   `MAX_DIFF_EDIT_DISTANCE × MAX_DIFF_ITERATION_FACTOR`:** that product is 10⁷ iterations,
   and reaching `d` costs ≈ `d²/2`, so it would bail at `d ≈ 4 472` — a *tightened*
   ceiling, i.e. more pairs degrading than today, which ADR-563 explicitly declined
   ("at the constant's **existing** value rather than a tightened one"). A direct `d` bail
   at 10 000 reproduces today's measured ceiling **exactly** (§Pin G-5: 958 ms / 769 MB at
   `d ≈ 10 000`) while removing its dependence on input size. `MAX_DIFF_ITERATION_FACTOR`
   therefore joins `MAX_DIFF_LINES` as **export-only** — both stay exported at today's
   values, neither is re-valued or removed, so `reports/api.json` must not move.
   Both are re-exported from `src/public-types.ts`, a knip entry point, so
   `check:dead-code` treats them as public API rather than dead exports — confirm that
   before the commit, exactly as Part 12 does for `MAX_LINES`. If either constant's
   documentation is rewritten, use `//` comments, not `/** … */` (the `api.json` /
   prepush trap in §Public surface).
3. **Rewrite two stale comments** that assert the deleted pre-check: `computeMyersTrace`'s
   header comment (lines 126–129, "M+N is already bounded by diffLines's MAX_DIFF_LINES
   pre-check … so no size guard is repeated here") and the iteration-budget comment
   (137–140, "Together they subsume the design's MAX_DIFF_EDIT_DISTANCE constant, which
   remains exported for documentation") — that last sentence is now false in both
   directions.

**What is inherited, deliberately, with the number known.** The 958 ms / 769 MB worst case
is **reachable today under the cap** and is inherited, not introduced. `internLines` (a
`Map` with one entry per distinct normalized line) and `new Array(2(M+N)+1)` are now paid
on arbitrarily large inputs — both O(M+N), the same order `splitLines` already pays,
measured at 0.3 ms / ~3 MB for a 200 002-line pair (§Pin G-7).

**Blind-spot 17, raise it in review rather than fixing it here:** the shape §Pin G does
**not** measure is a 20 M-line input, where `internLines` and the `2(M+N)+1` `v` array are
paid before the edit-distance bail can fire. Whether an input-size **guard** (a memory
guard with its own number, not a resurrection of the cliff) is still wanted is a reviewer's
call. Do not add one silently.

**Four consumers inherit with no change of their own** — `computeStatFields`,
`patch-serializer`, `three-way-content`, `range-diff/patch-text`. Not one needs a code
edit. `wholeFileFallback` / `degraded: true` stays as the refusal mechanism: no new
failure mode, no new error, no new option.

**Assertions that move — `test/unit/domain/diff/line-diff.test.ts:380-420`:** the three
`MAX_DIFF_LINES` describes move from input-size fixtures to edit-distance fixtures.
- "exactly `MAX_DIFF_LINES` total lines ⇒ not degraded" — still true, now for a different
  reason (edit distance 0). Retitle.
- "inputs exceeding `MAX_DIFF_LINES` total ⇒ degraded immediately (line cap)" — the
  25 001-vs-25 001 fully-different pair still degrades, but via the **distance** bail.
  Retitle and re-justify.
- "equal-sized identical inputs whose combined length exceeds `MAX_DIFF_LINES` ⇒ degraded
  via the sum cap" — **this one inverts**: identical content is edit distance 0, so it now
  completes with a single common hunk and `degraded: false`. This is the assertion that
  visibly states what the commit changed.

**New assertions, in cost order — the cheap ones are mandatory, the boundary pair is
conditional:**
- **(mandatory, cheap)** a 200 002-line pair (100 001 per side) with a **one-line edit**
  ⇒ `degraded: false` and the correct hunks. Today this returns `degraded: true` with
  `added = deleted = 100 001`. This is the shape §Pin G-3/G-4 shows is the one that
  matters, and it is what makes `manylines` faithful.
- **(mandatory, cheap)** a NUL-free 70 000-byte-line pair ⇒ `degraded: false`, 0.2 ms
  (§Pin G-6).
- **(conditional)** the exact boundary: `d = MAX_DIFF_EDIT_DISTANCE` ⇒ completes,
  `d = MAX_DIFF_EDIT_DISTANCE + 1` ⇒ `degraded: true`, as two isolated `it`s.
  **Measure before committing them**: reaching `d ≈ 10 000` inherently costs ≈ 5 × 10⁷
  iterations and a trace of ≈ (d+1)² ≈ 10⁸ numbers — roughly **800 MB and ~1 s each**.
  Give them `{ timeout: 60_000 }`. If the measured peak exceeds ~1 GB or the pair pushes
  the unit suite past an acceptable budget, **do not commit a memory bomb**: keep the two
  cheap pins, record the measured boundary numbers for Part 14's Results section, and
  **escalate** `{ part, reason, ≤3 options }` rather than deciding alone.

**Interop cases to add — `manylines` (§Pin F, the five surfaces Part 12 could not
complete):**
- `test/integration/diff-whitespace-interop.test.ts` — plain-path numstat for `manylines`.
  §Pin F's fixture carries a **one-line** edit, so git reports `1 1`; tsgit reports
  `100001 100001` after Part 12 (`wholeFileFallback`) and must report git's value after
  this part. Take git's number **live in the same run**; never freeze a constant.
- patch body: full text hunks (`@@ -3,7 +3,7 @@` for §Pin F's fixture), **zero**
  `Binary files` lines anywhere in the diff.
- `test/integration/merge-interop.test.ts` — the 100 001-line pair with **non-overlapping**
  edits **auto-merges cleanly**: `Auto-merging`, `1 insertion(+), 1 deletion(-)`, **zero
  conflict markers**. This is the surface Part 12 alone would have made worse.
- `test/integration/range-diff-interop.test.ts` — full hunks for `manylines` too.
- `patch-id` — a real id over the full text hunks (unit suite's equality relations).

**Ledger:** delete the remaining C8 `manylines` entries. After this part the ledger's
`tsgitDivergence` field should have **no** remaining entries — if any survive, name them
in the commit and explain why (a surviving entry is a documented divergence with an owner,
not a leftover).

### TDD steps

1. **RED** — the 200 002-line/one-line-edit case ⇒ `degraded: false`. Expected failure:
   the `M + N > MAX_DIFF_LINES` pre-check returns `wholeFileFallback`.
2. **RED** — invert the "equal-sized identical inputs" case to `degraded: false` with a
   single common hunk. Expected failure: same pre-check.
3. **RED** — the `manylines` interop cases (numstat, patch body, clean auto-merge,
   range-diff). Expected failure: whole-file replace hunks / a whole-file conflict region.
4. **GREEN** — delete the pre-check; add the `d > MAX_DIFF_EDIT_DISTANCE` bail; delete the
   iteration counter and budget; rewrite the two stale comments.
5. **MEASURE, then decide** — the boundary pair per the conditional rule above.
6. **VERIFY** — delete the remaining `manylines` ledger entries; the whole ledger now
   asserts git parity with no overrides.
7. **REFACTOR** — none expected. Keep `wholeFileFallback` as the single refusal mechanism.

### Gate

```
npx vitest run test/unit/domain/diff/line-diff.test.ts test/unit/domain/diff/stat-fields.test.ts test/unit/domain/diff/patch-serializer.test.ts test/unit/domain/merge test/unit/application/primitives/patch-id.test.ts && npx vitest run test/integration/merge-interop.test.ts test/integration/range-diff-interop.test.ts test/integration/diff-whitespace-interop.test.ts test/integration/diff-whitespace-modes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/line-diff.ts test/unit/domain/diff/line-diff.test.ts test/integration/merge-interop.test.ts test/integration/range-diff-interop.test.ts test/integration/diff-whitespace-interop.test.ts test/integration/diff-whitespace-modes-interop.test.ts
```

### Commit

```
fix(diff): bound the diff by edit distance instead of input size
```

## Part 14 — the measured before/after, recorded

### Context

§Requirements 7 ("measured, not asserted") + §Measurement protocol 2, 2a, 2b and 3.
Docs-only: this part changes no `src/` and no test, and lands the numbers as the
`## Results (measured)` section Part 1 opened in
`docs/design/whitespace-drop-fast-path.md`.

**What to measure, all on one host, ≥2 runs each, absolute wall-clock:**

| # | measurement | before | target / expectation |
|---|---|---|---|
| 1 | `diff-whitespace.bench.ts` many-small-modified-pairs, **loose** | 258 / 271 ms warm (§Pin B) | **≤ 130 ms** |
| 2 | same, **packed** | 165 / 176 ms warm | **≤ 100 ms cold** |
| 3 | `whitespace-digest.bench.ts` — `digestNormalizedLine`, 4 modes × {short lines, one long line} | Part 1's baseline | a win expected, **not asserted**; a regression is a design signal (the fold would want an `indexOf`-assisted fast path for the inactive-key case), not a tuning task — record it either way |
| 4 | `diffLines` §Pin G-3, G-5, G-6 and the 100 001-line/one-line-edit pair | 3.6 ms/7.8 MB · **958 ms/769 MB** · 0.2 ms · `degraded: true` | G-5 **must not grow**; the 100 001-line case must become **finite and fast** |
| 5 | non-regression watch: `diff.bench.ts`, `diff-recursive.bench.ts`, `pack-read.bench.ts`, `loose-read.bench.ts` | — | no regression |
| 6 | `npm run profile` re-run | Pin A's 16.4 % web-streams + 6.2 % zlib + 4.4 % `NodeError` | those frames should leave the digest **entirely** for this workload |

**How to take the "before" number without touching repo git state.** You may **not**
check out, switch, reset, stash or otherwise move the shared working tree. Instead clone:

```
HERE=/Users/scolladon/workspace/perso/node/tsgit-whitespace-drop-fast-path
TMP=$(mktemp -d)
git clone --local --branch main "$HERE" "$TMP/tsgit-main"
ln -s "$HERE/node_modules" "$TMP/tsgit-main/node_modules"
cp "$HERE/test/bench/diff-whitespace.bench.ts" "$HERE/test/bench/whitespace-digest.bench.ts" "$TMP/tsgit-main/test/bench/"
cp "$HERE/test/bench/support/write-scratch.ts" "$TMP/tsgit-main/test/bench/support/"
```

`git clone` reads the repository; it does not touch the shared worktree, the index or any
branch. The two bench files and the scratch builder do not exist on `main`, so they are
copied in and **both sides run byte-identical measurement code**. Then run
`npx vitest bench --run --config vitest.bench.config.ts <files>` in both trees, back to
back, and use that pair. Remove `$TMP` when done. If it differs materially from
Part 1's recorded baseline, prefer the fresh pair and say so — session load biases
syscall-heavy paths, which is precisely why Part 1's number is a cross-check and not the
authority. Remove `$TMP` when done.

**Say this in the Results section, verbatim in substance:** these are **local go/no-go**
numbers taken under session load; the **published** authority is the nightly `bench.yml`
CI artifact, never a loaded local session.

**Non-goal, state it:** beating native git. On the packed variant native is 77 ms and the
projection is ~91 ms cold; the residual is the loose/pack read itself plus the
containment gate (`realpath` + `isContainedInAnyRoot`, ~4.9 % of Pin A), which is out of
scope.

**If measurement 1 or 2 misses its target**, that is a go/no-go failure, not a rounding
error: report `{ part, reason, ≤3 options }` — do not quietly record a miss as a pass.

### TDD steps

A measurement part has no RED/GREEN cycle; its executable obligations are:

1. **Run** each of the six measurements above ≥2×, before and after, recording the spread
   not just the mean.
2. **Record** them in the design doc's `## Results (measured)` section: a table per
   measurement with before, after, delta, and the host/Node/git versions.
3. **Check** each against its target and state pass/fail explicitly per row.
4. **Re-profile** with `npm run profile` and record which Pin A frames disappeared.
5. **VERIFY** — `npm run validate` is the orchestrator's gate, not this part's; but do
   confirm the design doc still passes `cspell` and `check:doc-links` (both run over the
   whole diff, not per part), and remember `check:doc-typedoc` runs only at **prepush**.

### Gate

```
npx vitest bench --run --config vitest.bench.config.ts test/bench/diff-whitespace.bench.ts test/bench/whitespace-digest.bench.ts && npm run check:types && ./node_modules/.bin/biome check .
```

This part touches only markdown, and biome exits **1** on a `.md` path ("No files were
processed"), so the biome step runs over the repo (`biome check .`, exactly what
`npm run check` does) rather than over the touched file.

### Commit

```
docs(design): record the measured before and after numbers
```
