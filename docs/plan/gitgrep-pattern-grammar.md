# Plan — gitgrep-pattern-grammar

> Source: design doc `docs/design/gitgrep-pattern-grammar.md` · ADRs 395, 396, 397
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

## Orientation — read once, applies to every slice

These facts are verified against the worktree HEAD (Serena/grep symbol reads, not recall).
They are the shared substrate; each slice repeats only the deltas it needs.

- **Slice gate (every slice):**
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`
- **Phase-boundary gate (after the last slice):** `npm run validate`. Never commit on a
  red gate; the full `validate` runs ONCE at the phase boundary, not per intra-round commit.
- **Repo conventions (all slices):** Given/When/Then describe/it tree (`describe('Given …')` >
  `describe('When …')` > `it('Then …')`, 2-level shortcut allowed when one expectation);
  AAA body with `// Arrange` / `// Act` / `// Assert` comments; `sut` names the
  function/object under test (NOT the result — the result is `result`). Error assertions
  assert `.data` (code/reason/value), never bare `toThrow(Class)`. Each guard clause gets
  an isolated per-branch test (mutation-resistant). No provenance refs (phase/ADR/backlog
  numbers) in source or test — the commit is the join point. No suppression directives
  (`@ts-ignore` / `v8 ignore` / `stryker-disable` / `biome-ignore`). Files kebab-case,
  functions <20 lines, immutable, early returns, branded types across boundaries.
- **Test LOCATION convention (verified — overrides the design's cited co-located paths):**
  ALL example, property, and command unit tests live under `test/unit/...`, NEVER co-located
  in `src/`. There are ZERO `src/**/*.test.ts` files. So the matcher's tests are
  `test/unit/domain/grep/matcher.test.ts` + `test/unit/domain/grep/matcher.properties.test.ts`
  (the design's `src/domain/grep/matcher.test.ts` reference is a path slip — correct it to
  `test/unit/domain/grep/`). The command test is
  `test/unit/application/commands/grep.test.ts`. Mirror domain-test style from
  `test/unit/domain/diff/similarity.properties.test.ts` (imports `fast-check` as `fc`, GWT
  tree, `describe('Given an arbitrary …')`).
- **Reused domain text primitives** (`src/domain/diff/index.ts`, re-exporting
  `src/domain/diff/line-diff.ts`):
  - `splitLines(bytes: Uint8Array): ReadonlyArray<Uint8Array>` (line-diff.ts:33) — splits on
    LF; **each returned line KEEPS its trailing `\n`**; a final unterminated run is included.
  - `isBinary(bytes: Uint8Array): boolean` (line-diff.ts:76) — caps `BINARY_DETECTION_BYTES`,
    `MAX_LINE_BYTES = 65_536`, `MAX_LINES = 100_000` (all re-exported from `domain/diff/index.ts`).
    These caps ARE the ReDoS ceiling (design "ReDoS is the caller's concern"): no grep-specific
    `MAX_PATTERN_BYTES`.
- **Reused error helper:** `invalidOption(option: string, reason: string): TsgitError`
  (`src/domain/commands/error.ts:381`) → `{ code: 'INVALID_OPTION', option, reason }`
  (union member declared at error.ts:75). The `u`-flag refusal and empty-`patterns` refusal
  both throw via this helper. `reason` is `sanitizeForDisplay`'d inside the helper.
- **Reused enumeration + read primitives** (all exported from
  `src/application/primitives/index.ts`):
  - `walkWorkingTree(ctx, options?): AsyncIterable<WalkWorkingTreeEntry>`
    (index.ts:91; entry `{ path: FilePath; stat: FileStat }`, types.ts:153) — ignore-aware
    working-tree enumeration (the default target).
  - `walkTree(ctx, treeIdOrObject, options?): AsyncIterable<WalkTreeEntry>`
    (index.ts:90; entry `{ path: FilePath; id: ObjectId; mode: FileMode }`, types.ts:141;
    pass `{ recursive: true }` via `WalkTreeOptions`) — the `<tree-ish>` target.
  - `readIndex(ctx): Promise<GitIndex>` (index.ts:49; `GitIndex.entries: ReadonlyArray<IndexEntry>`,
    each `IndexEntry` has `{ path: FilePath; id: ObjectId; flags }`, index-entry.ts:20/31/33) —
    the `--cached` target. Filter to stage-0 entries; map `{ path, id }`.
  - `readHeadTree(ctx): Promise<FlatTree | undefined>` (index.ts:48; `FlatTree.entries:
    ReadonlyMap<FilePath, { id; mode }>`, flat-tree.ts) — NOT needed for v1 grep (the
    `<tree-ish>` path uses `walkTree`; HEAD is just a tree-ish string the caller passes). Listed
    only because the design's reuse table names it; v1 grep does not call it.
  - `readBlob(ctx, id: ObjectId, options?): Promise<Blob>` (read-blob.ts:7;
    `Blob.content: Uint8Array`, blob.ts:3) — load contents.
  - `resolveTreeish(ctx, rev: string): Promise<ObjectId>`
    (`src/application/commands/internal/resolve-rev.ts:19`) — resolve a `<tree-ish>` string to
    a tree oid (peels commit→tree, follows tags). This is what `diff.ts:53` uses; the grep
    orchestrator uses it for the `{ treeish }` target before `walkTree`.
- **Bounded blob-read pool pattern (verified — copy the shape, do NOT import it):**
  `src/application/primitives/materialise-patch-files.ts:20-42` — a cursor + N workers
  (`MAX_CONCURRENT_BLOB_LOADS = 32`), `concurrency = Math.min(32, items.length)`,
  `Promise.all(workers)`, results written into a pre-sized array by index so **order is
  preserved**. The grep orchestrator replicates this to fan out `readBlob` over enumerated
  paths while keeping enumeration order (#M1).
- **Pathspec limiter (verified):** `resolvePathspec(patterns: ReadonlyArray<string>):
  ResolvedPathspec` (`src/application/commands/internal/resolve-pathspec.ts:38`) →
  `{ matcher: Pathspec; literalMustMatch; hasGlob }`. Match a path with
  `matchesPathspec(matcher, path)` (from `src/domain/pathspec/index.js`). Budget
  `MAX_PATHSPEC_PATTERN_BYTES = 256` (the PATH glob — linear, ADR-077; unaffected by the
  content grammar). Used only to SCOPE which enumerated paths are scanned.
- **Branded constructors:** `FilePath.from(string)` (object-id.ts:47); `ObjectId` is a branded
  string. Enumeration/index already yield `FilePath`/`ObjectId`, so the orchestrator rarely
  constructs them itself.
- **The faithful-half matrix is design §"Pinned target + binary + line-numbering matrix"**
  (rows T1–T4, L1, M1, B1). Pin against real git ONLY in the interop slice (Slice 4); unit
  slices assert the matrix's stated outcome directly with mocked enumeration. **Grammar is
  NEVER pinned against `git grep`** (ADR-395 — V8-vs-glibc proves nothing); grammar is proven
  by invariant + example unit tests against an independent oracle.

### Public-surface decision (made up front — every new exported symbol decided here)

This is a **NEW Tier-1 command** — it trips the full surface-gate set (design §"Tier-1
surface-gate checklist"). Every new exported symbol is decided **public** (a Tier-1 command's
options/result are its API):

| New symbol | Where declared | Public/internal | Reaches `reports/api.json` via |
|---|---|---|---|
| `grep` (fn) | `src/application/commands/grep.ts` | **public** | commands barrel value re-export → `index.ts` |
| `GrepOptions`, `GrepResult`, `GrepPathResult`, `GrepLineHit` (command-owned types) | `grep.ts` | **public** | commands barrel `export type { … }` re-export → `public-types.ts:7` |
| `MatchSpan`, `GrepPattern`, `GrepFixedPattern`, `LineVerdict`, `GrepMatcher`, `GrepMatcherOptions` (matcher types) | `src/domain/grep/matcher.ts` | **public-by-re-export** | `src/domain/grep/index.ts` → `public-types.ts` (new grep-barrel line, after `domain/diff` at line 32). NOT re-declared in `grep.ts`/commands barrel (TS2308 risk) |
| `buildGrepMatcher` (value) | `src/domain/grep/matcher.ts` | barrel value (not a public TYPE) | `domain/grep/index.ts` value export; dropped by `export type *`, barrelled only so `grep.ts` imports it |

Because `grep` is a new command, the **downstream surface gates the implementer must pre-pay
in-slice** (enumerated so a phase-boundary surprise is impossible):

1. **Commands barrel** `src/application/commands/index.ts` — add the `grep` value + its type
   re-exports (Slice 3). Insertion point: between line 104 (`} from './fetch-missing.js';`)
   and line 105 (`export { … init } from './init.js';`) — `grep` sorts after the `fetch*`
   block, before `init`.
2. **Facade interface** `src/repository.ts` — add `readonly grep: BindCtx<typeof commands.grep>;`
   between line 199 (`readonly fetchMissing`) and line 200 (`readonly init`) (Slice 3).
3. **Facade binding** `src/repository.ts` — add the `grep:` binding between line 502
   (`}) as Repository['fetchMissing'],`) and line 503 (`init: (…)`), mirroring the `rangeDiff`
   binding at line 532-535: `grep: ((grepOpts) => { guard(); return commands.grep(ctx, grepOpts); }) as Repository['grep'],` (Slice 3).
4. **Facade command-key snapshot** `test/unit/repository/repository.test.ts:215-216` — insert
   `'grep',` between `'fetchMissing'` (line 215) and `'init'` (line 216) in the sorted
   command-key-set assertion (Slice 3).
5. **README Tier-1 count** `README.md:46` — bump `38 Tier-1 commands` → `39` (Slice 3).
6. **`src/index.ts`** — already forwards `./application/commands/index.js` and the public-type
   barrels; the new exports ride automatically. **Confirm NO manual edit needed** (design §4 of
   the checklist).
7. **`reports/api.json`** — a PREPUSH gate (`check:doc-typedoc`), NOT a `validate` gate. It
   goes stale the moment any public export lands. **Regenerate at the pre-PR gate**
   (`npm run docs:json`, commit the regenerated file — large typedoc-id diff is normal). It is
   NOT a plan slice (design says so explicitly). The last `src/` slice is Slice 2; the
   surface-wiring Slice 3 adds the barrel/facade exports — api.json regen happens at the
   pre-PR/propose gate after Slice 3, per repo norm.
8. **`docs/use/commands/grep.*` doc page** — authored in the DOCS phase, NOT a plan slice
   (design §10 of the checklist).
9. **`.size-limit.json` / `check:size`** — the matcher is `regexp.exec` + a byte scan; bundle
   delta is tiny. If `check:size` fails at validate, `rm -rf dist .wireit && rebuild` before
   trusting it (stale-chunk inflation is a known false positive). No action expected.

---

## Slice 1 — pure grep matcher (domain) + byte-offset bridge + `-w`/`-v`/OR + property tests

### Context

Create the pure, I/O-free matcher and its types; nothing downstream yet. This slice carries
the single subtle correctness item (the latin1 byte-offset bridge) and the two load-bearing
refusals (`u`-flag, empty patterns is the COMMAND's guard — see judgment note), each with an
isolated RED test.

- **New file:** `src/domain/grep/matcher.ts`. Pure, zero platform deps (domain tier — must not
  import anything under `application/`/`adapters/`/`ports/`).
- **New barrel:** `src/domain/grep/index.ts` — `export * from './matcher.js';` (mirrors
  `src/domain/diff/index.ts`). Then add `export type * from './domain/grep/index.js';` to
  `src/public-types.ts` IMMEDIATELY AFTER line 32 (`export type * from './domain/diff/index.js';`)
  so the matcher types (`MatchSpan`, `LineVerdict`, `GrepMatcher`, `GrepPattern`,
  `GrepFixedPattern`, `GrepMatcherOptions`) reach `reports/api.json`. (`export type *` drops the
  `buildGrepMatcher` VALUE — that is barrelled from `domain/grep/index.ts` only so `grep.ts`
  imports it; it never needs to reach the public TYPE surface.)
- **Public types to declare and export** (decided public — Orientation):
  ```ts
  export interface GrepFixedPattern { readonly fixed: string; } // literal byte search (git -F)
  export type GrepPattern = RegExp | GrepFixedPattern;
  export interface MatchSpan { readonly start: number; readonly end: number; } // BYTE offsets, 0-based, end exclusive
  export interface LineVerdict {
    readonly returned: boolean;                  // keep the line as a hit?
    readonly spans: ReadonlyArray<MatchSpan>;    // EMPTY when invert returns the line
  }
  export interface GrepMatcher { matchLine(line: Uint8Array): LineVerdict; }
  export interface GrepMatcherOptions { readonly wholeWord?: boolean; readonly invert?: boolean; }
  export function buildGrepMatcher(
    patterns: ReadonlyArray<GrepPattern>,
    options?: GrepMatcherOptions,
  ): GrepMatcher;
  ```
  (`GrepOptions`/`GrepResult`/`GrepPathResult`/`GrepLineHit` are the COMMAND's types — declared
  in Slice 2's `grep.ts`. `MatchSpan`/`GrepLineHit` are conceptually shared; declare `MatchSpan`
  HERE in the matcher and have `grep.ts` import it, so there is one source of truth.)
- **Byte-offset bridge (PINNED — ADR-397, design §"Byte-offset bridge"):**
  - Decode each line **latin1**: `let s = ''; for (const b of line) s += String.fromCharCode(b);`
    (or a small `latin1Decode(line): string` helper). One UTF-16 code unit per input byte ⇒
    `RegExp` `.index` / `.index + match[0].length` ARE byte offsets by construction. No remap
    table.
  - The `line: Uint8Array` is NEVER mutated; latin1 is the matcher's INTERNAL view only.
  - **`u`-flag refusal:** a `u`-flagged `RegExp` asserts code-point semantics the byte view
    cannot honour. `buildGrepMatcher` MUST throw `invalidOption('pattern', '<reason about
    unicode flag unsupported over byte content>')` when any pattern is a `RegExp` whose
    `.flags` includes `'u'`. Import `invalidOption` from
    `src/domain/commands/error.js` (it is a domain helper — domain-legal). Isolated RED test.
  - **Internal `g`-flag clone (never mutate the caller's `RegExp`):** for each `RegExp`
    pattern, build an internal clone with `new RegExp(pattern.source, pattern.flags.replace('y','') + (pattern.flags.includes('g') ? '' : 'g'))`
    — force `g`, strip sticky `y` (sticky anchoring drops non-leftmost spans). Run
    `clone.exec` in a loop (or `matchAll`) over the latin1 string to collect ALL spans on the
    line. The caller's `RegExp` object and its `lastIndex` are NEVER read or written. Isolated
    test asserts the caller's `regexp.lastIndex` is unchanged AND a non-global caller regex
    still yields all spans.
- **Fixed form:** for a `GrepFixedPattern`, search the raw `line: Uint8Array` for the
  pattern's UTF-8 bytes (`new TextEncoder().encode(fixed)`) with an `indexOf`-style byte scan
  (find ALL non-overlapping occurrences). Metacharacters in `fixed` (`a+`, `x.y`, `star*lit`)
  match LITERALLY (no regex meaning). Spans are byte offsets directly.
- **Whole-word `-w` (matcher-level, BOTH forms — design §"Matcher-level"):** a candidate span
  `[start, end)` survives only if the byte BEFORE `start` is not a word byte AND the byte AT
  `end` is not a word byte. Word-byte class = git's `[A-Za-z0-9_]` over bytes
  (`0x30-0x39 | 0x41-0x5a | 0x61-0x7a | 0x5f`). Edge of line counts as a non-word boundary.
  Applied identically to regex-form and fixed-form spans. Isolated tests for the LEFT-boundary
  guard and the RIGHT-boundary guard INDEPENDENTLY (mutation-resistant — `if (leftIsWord ||
  rightIsWord) drop` needs each condition triggered alone).
- **Invert `-v` (per-line verdict flip — design §"Matcher-level"):** OR-combine all patterns'
  surviving spans FIRST. Non-invert ⇒ `returned = spans.length > 0`, `verdict.spans = spans`.
  Invert ⇒ `returned = spans.length === 0`, `verdict.spans = []` (a returned line under `-v` is
  by definition a non-match). Multi-pattern OR is computed BEFORE inversion (`-v` excludes
  lines matching ANY pattern).
- **Multi-pattern OR:** the matcher's span set for a line is the union of every pattern's
  surviving spans (after `-w` gating). Order/de-dup: collect spans, sort by `start` then `end`,
  drop exact duplicates. (Overlapping-but-distinct spans from different patterns are both
  kept — git reports a line as matched; spans serve `--color`/`-o` reconstruction.)
- **New test file:** `test/unit/domain/grep/matcher.test.ts`. Model layout on
  `test/unit/domain/diff/similarity.properties.test.ts` for imports/GWT, and any small
  domain example test for the `enc = (s) => new TextEncoder().encode(s)` helper. Cover (design
  §"Test strategy — Unit matcher.test.ts"):
  - regex form: single span, multiple spans on a line, no match — assert `verdict.returned`
    and exact `spans` (start/end byte offsets).
  - **byte-offset correctness over multi-byte UTF-8 (the D6/ADR-397 item — ISOLATED test):**
    a line where an earlier run is multi-byte UTF-8 (e.g. `é` = 0xC3 0xA9) followed by an ASCII
    match; assert `line.slice(span.start, span.end)` equals the matched bytes (a `Uint8Array`
    deep-equal), proving the offsets are BYTE offsets not code-unit offsets.
  - **`u`-flag refusal (ISOLATED):** `buildGrepMatcher([/x/u])` throws — assert `err.data.code
    === 'INVALID_OPTION'` and `err.data.option === 'pattern'` and the reason text, via
    try/catch + direct `.data` assertions (NOT bare `toThrow`).
  - **caller-`RegExp` immutability (ISOLATED):** a NON-global caller `RegExp` with two
    occurrences on a line yields BOTH spans, AND `caller.lastIndex === 0` after `matchLine`.
  - fixed form: `{ fixed: 'a+' }`, `{ fixed: 'x.y' }`, `{ fixed: 'star*lit' }` matched
    literally — assert no metachar meaning (e.g. `a+` does NOT match `aaa`).
  - `-w`: boundary gating for regex AND fixed form; SEPARATE isolated tests for left-boundary
    and right-boundary failure.
  - `-v`: a returned line carries empty `spans`; OR-then-invert order (a line matching ANY
    pattern is excluded under `-v`).
  - multi-pattern OR: union of single-pattern spans, deterministic order.
- **New property file:** `test/unit/domain/grep/matcher.properties.test.ts` (`fast-check`,
  ADR-134–136). Per-family generators may live inline (small) or in a new
  `test/unit/domain/grep/arbitraries.ts`. The matcher is a compositional matcher (lens 2) +
  the fixed form is a substring searcher with an independent oracle (lens 2). REQUIRED per the
  repo property-test rule (a matcher/decoder MUST ship a `.properties.test.ts` sibling).
  Properties (design §"Test strategy — matcher.properties.test.ts" — ALL non-tautological,
  none re-implements `regexp.exec` as oracle):
  - **fixed-mode substring invariant** (`numRuns` 200): `matchLine` returns a span iff the
    fixed pattern's bytes are a substring of the line — oracle is a hand-rolled
    `bytesIndexOf`/`Buffer.indexOf`, NOT the SUT.
  - **invert is the per-line set-complement** (`numRuns` 100): the set of lines returned under
    `invert` equals exactly the lines with no surviving span under non-invert (oracle = the
    non-inverted matcher).
  - **multi-pattern OR is the union** (`numRuns` 100): the span set for `[p, q]` equals the
    union of the span sets for `[p]` and `[q]` (oracle = two single-pattern matchers).
  - **`wholeWord` gating soundness** (`numRuns` 100): every span surviving `-w` has a non-word
    byte (or line edge) on both sides — verified directly against the line bytes, NOT the gate.
  - **byte-offset round-trip** (`numRuns` 100): for any returned span, `line.slice(start, end)`
    is re-found by the same pattern (the offsets index back into the line correctly — the
    ADR-397 invariant).
  Use `Given an arbitrary …` describe phrasing. Never commit a seed.

### TDD steps

- RED: write `matcher.test.ts` (example tables incl. the isolated byte-offset, `u`-flag, and
  immutability tests) and `matcher.properties.test.ts`. They fail to import `matcher.js`
  (module absent) → expected failure: `Cannot find module '../../../../src/domain/grep/matcher.js'`.
- GREEN: implement `matcher.ts` — `latin1Decode`, the `u`-flag guard + empty-pattern handling
  at the matcher level (the matcher itself need not enforce ≥1 pattern; an empty pattern list
  yields a matcher that returns `returned=false` for every line under non-invert — see judgment
  note; the ≥1 guard is the COMMAND's, Slice 2), the internal `g`-clone exec loop, the fixed
  byte scan, `-w` boundary gate, OR union, `-v` flip, `buildGrepMatcher`. Add
  `src/domain/grep/index.ts` and the `public-types.ts` line.
- REFACTOR: extract small helpers (`<20` lines each): `latin1Decode`, `regexSpans(line, clone)`,
  `fixedSpans(line, bytes)`, `applyWholeWord(spans, line)`, `isWordByte(b)`, `unionSpans(...)`.
  Express the `u`-flag guard and the `g`-clone once.

### Judgment note — empty `patterns` ownership
The DESIGN puts `patterns` empty → `invalidOption('patterns', 'at least one pattern required')`
at the COMMAND layer (design §"Invalid-input semantics"), because the OPTION named is
`'patterns'` (the command field), not `'pattern'` (the matcher's per-RegExp guard). So:
`buildGrepMatcher([])` does NOT throw — it returns a matcher matching nothing. The `≥1 pattern`
refusal lives in `grep.ts` (Slice 2). Keep that boundary; the matcher's only refusal is the
per-`RegExp` `u`-flag.

### Gate
`npx vitest run test/unit/domain/grep/matcher.test.ts test/unit/domain/grep/matcher.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/grep/matcher.ts src/domain/grep/index.ts src/public-types.ts test/unit/domain/grep/matcher.test.ts test/unit/domain/grep/matcher.properties.test.ts`

### Commit
`feat(grep): pure latin1 byte-offset matcher with whole-word, invert, and OR`

## Slice 2 — grep command orchestrator (targets, pathspec, bounded pool, binary, GrepResult)

### Context

Create the I/O orchestrator that resolves a target, scopes by pathspec, fans out `readBlob`
under a bounded pool, gates binary blobs, runs the Slice-1 matcher per line, and assembles the
structured `GrepResult`. Mocked-enumeration unit tests cover the faithful-half matrix cells
(T1–T4, L1, M1, B1) without real git (real git is Slice 4).

- **New file:** `src/application/commands/grep.ts`. Tier-1 command (I/O orchestrator).
- **Public types to declare and export from `grep.ts`** (decided public — Orientation):
  ```ts
  export interface GrepLineHit {
    readonly lineNumber: number;                 // 1-based (git -n), #L1
    readonly line: Uint8Array;                   // raw returned-line bytes (LF kept by splitLines)
    readonly spans: ReadonlyArray<MatchSpan>;    // EMPTY under invert
  }
  export interface GrepPathResult {
    readonly path: FilePath;
    readonly hits: ReadonlyArray<GrepLineHit>;
    readonly binaryMatch: boolean;               // binary blob that contained a match; hits empty (#B1)
  }
  export interface GrepResult { readonly paths: ReadonlyArray<GrepPathResult>; }
  export interface GrepOptions {
    readonly patterns: ReadonlyArray<GrepPattern>;          // ≥1 required; OR-combined
    readonly wholeWord?: boolean;                           // -w
    readonly invert?: boolean;                              // -v
    readonly target?: 'index' | { readonly treeish: string }; // absent ⇒ working tree
    readonly paths?: ReadonlyArray<string>;                 // pathspec limiter
  }
  export async function grep(ctx: Context, opts: GrepOptions): Promise<GrepResult>;
  ```
  Import `MatchSpan`, `GrepPattern`, `buildGrepMatcher` from `../../domain/grep/index.js`.
  `FilePath`/`ObjectId` from `../../domain/objects/object-id.js`. `Context` from
  `../../ports/context.js`. `splitLines`, `isBinary` from `../../domain/diff/index.js`.
  `invalidOption` from `../../domain/commands/error.js`. `readBlob`, `readIndex`,
  `walkWorkingTree`, `walkTree` from `../primitives/index.js`. `resolveTreeish` from
  `./internal/resolve-rev.js`. `resolvePathspec` from `./internal/resolve-pathspec.js` +
  `matchesPathspec` from `../../domain/pathspec/index.js`.
- **Orchestration flow (design §"Layering"):**
  1. **Guard `patterns`:** `if (opts.patterns.length === 0) throw invalidOption('patterns', 'at least one pattern required');` — ISOLATED guard, before any I/O.
  2. **Build the matcher once:** `const matcher = buildGrepMatcher(opts.patterns, { wholeWord: opts.wholeWord, invert: opts.invert });` — this is also where the `u`-flag refusal surfaces (it throws from `buildGrepMatcher`).
  3. **Resolve the pathspec limiter (if `opts.paths`):** `const pathspec = opts.paths ? resolvePathspec(opts.paths) : undefined;` — then a path is in-scope iff `!pathspec || matchesPathspec(pathspec.matcher, path)`.
  4. **Enumerate `{ path, id }` candidate blobs by target:**
     - **working tree (default, `target` absent):** `for await (const { path } of walkWorkingTree(ctx)) …` — BUT `walkWorkingTree` yields `{ path, stat }`, not a blob id. JUDGMENT CALL (below): read the working-tree FILE bytes via the filesystem port, not `readBlob`. See judgment note.
     - **`--cached` (`target === 'index'`):** `const index = await readIndex(ctx);` then map `index.entries` filtered to stage-0 (`entry.flags.stage === 0` — VERIFIED: `IndexEntryFlags.stage: 0|1|2|3`, index-entry.ts:5) to `{ path: entry.path, id: entry.id }`. Load bytes via `readBlob(ctx, id)`.
     - **`<tree-ish>` (`target` is `{ treeish }`):** `const treeId = await resolveTreeish(ctx, opts.target.treeish);` then `for await (const { path, id, mode } of walkTree(ctx, treeId, { recursive: true })) …`. **Skip gitlink/non-blob entries** — `walkTree` yields gitlinks (mode `160000`) as leaf entries (walk-tree.ts:69), and `readBlob` on a gitlink id would throw `unexpectedObjectType`. Guard: `if (mode === FileMode.GITLINK) continue;` (`FileMode.GITLINK = '160000'`, `src/domain/objects/file-mode.ts:8`); trees are not yielded as leaves under `recursive: true`, so a regular-file/exec-file mode is the only blob case. Load bytes via `readBlob(ctx, id)`.
  5. **Scope by pathspec** (skip out-of-scope paths before reading).
  6. **Bounded fan-out** (copy the `materialise-patch-files.ts:20-42` cursor+workers shape,
     `MAX_CONCURRENT_BLOB_LOADS = 32` as a local const): for each in-scope candidate, load bytes,
     then:
     - `if (isBinary(bytes))` → record `{ path, hits: [], binaryMatch: matcherFindsAnyMatch(bytes) }`.
       A binary blob is a `binaryMatch` ONLY if it contained a match — design §"#B1". Compute
       "contained a match" WITHOUT a line scan: run the matcher over the WHOLE blob as a single
       latin1 view, or reuse a cheap whole-buffer check. JUDGMENT CALL (below) — git reports
       `Binary file X matches` only when the pattern occurs in the binary blob. If `binaryMatch`
       is false, the path is OMITTED entirely.
     - else `splitLines(bytes)` → for each line at 1-based `lineNumber`, `const v = matcher.matchLine(line);` `if (v.returned) hits.push({ lineNumber, line, spans: v.spans });`. Record the path iff `hits.length > 0`.
  7. **Preserve enumeration order** (write results into a pre-sized array by enumeration index,
     like the pool pattern) so `paths` is in walk order (#M1). Drop paths with no hits and no
     `binaryMatch`. Return `{ paths }`.
- **JUDGMENT CALL — working-tree bytes source:** `walkWorkingTree` yields `{ path, stat }`, NOT
  a blob id, so `readBlob` is wrong for the default target (the unstaged content is on DISK, not
  an object — #T1 requires the unstaged change to be visible). Read the file via the filesystem
  port: `ctx.fs.read(joinPath(ctx.layout.workDir, path)): Promise<Uint8Array>` (VERIFIED:
  `FileSystem.read(path): Promise<Uint8Array>`, `src/ports/file-system.ts:52`; `joinPath` from
  `../primitives/internal/join-working-tree-path.js`, the same accessor `add.ts:359` uses for
  working-tree paths). Keep the binary/line-scan logic identical regardless of byte source. The `--cached` and
  `<tree-ish>` targets use `readBlob` (object content). Pin #T1 (working-tree unstaged visible),
  #T2/#T3 (`--cached` = index, no unstaged), #T4 (`<tree-ish>` = committed tree) in the unit
  tests AND the interop slice.
- **JUDGMENT CALL — binaryMatch detection:** "did a match occur in this binary blob" is a
  boolean, not a span collection. Cheapest faithful approach: `buildGrepMatcher` over the same
  patterns, run `matcher.matchLine(wholeBlobBytes)` and use `verdict.returned` under
  NON-invert. BUT note `-v` semantics interact: git's binary handling is "the pattern occurs in
  the file". Use a NON-inverted probe for `binaryMatch` (the binary datum reflects pattern
  presence, independent of `-v`'s line-inversion which is meaningless for a skipped binary).
  Confirm against real git in Slice 4 (#B1) and pin the chosen semantics there; the unit test
  asserts the chosen behaviour directly. State the decision in a code comment (why, not what).
- **New test file:** `test/unit/application/commands/grep.test.ts`. Build contexts via the
  memory adapter (read `test/unit/application/commands/blame.test.ts` or any recent command test
  for the `createMemoryContext` + seed-tree/seed-index helpers; mirror its enumeration mocking
  or real-memory-repo seeding). Cover (design §"Test strategy — grep.test.ts"):
  - **target selection:** working-tree default matches an unstaged change (#T1); `--cached`
    matches a staged-only change (#T2) and does NOT match an unstaged-only change (#T3);
    `{ treeish: 'HEAD' }` matches only committed content (#T4). Isolated per-target tests.
  - **binary:** a blob with a NUL byte that CONTAINS the pattern → `binaryMatch: true`, `hits`
    empty, no line scan (#B1, D4); a binary blob that does NOT contain the pattern → path omitted.
  - **pathspec limiter** scopes paths (a pattern present in two files, `paths: ['a/**']` →
    only the `a/`-rooted file appears).
  - **multi-pattern OR** at the command level (#F4) — a line matching either pattern is a hit.
  - **bounded-pool fan-out preserves enumeration order** (#M1) — seed ≥3 matching paths, assert
    `result.paths.map(p => p.path)` is in walk order.
  - **1-based line numbering** (#L1) — a match on the Nth line reports `lineNumber === N`.
  - **`≥1 pattern` guard (ISOLATED):** `grep(ctx, { patterns: [] })` throws — assert
    `err.data.code === 'INVALID_OPTION'`, `err.data.option === 'patterns'`, reason text, via
    try/catch + `.data`.
  - **`u`-flag refusal propagates** from the matcher (ISOLATED) — `grep(ctx, { patterns: [/x/u] })`
    throws `INVALID_OPTION` with `option: 'pattern'`.
  - `-w` / `-v` reach the matcher (one end-to-end test each, the deep boundary cases are Slice 1).
  Isolated per-branch guard tests (empty patterns / each target / binary-with-match vs
  binary-without / pathspec in vs out) — mutation-resistant.

### TDD steps

- RED: write `grep.test.ts` (per-target, binary, pathspec, OR, order, line-number, guard tests).
  They fail to import `grep.js` (module absent).
- GREEN: implement `grep.ts` — the `patterns` guard, matcher build, pathspec resolution, the
  three target enumerators, the bounded pool, binary gating, line scan, order-preserving
  `GrepResult` assembly, and the type exports.
- REFACTOR: extract small helpers (`<20` lines): `enumerateCandidates(ctx, opts)` (returns an
  ordered `ReadonlyArray<{ path; load: () => Promise<Uint8Array> }>` per target),
  `scanBlob(matcher, path, bytes)` (binary gate + line scan → `GrepPathResult | undefined`),
  and the bounded pool runner. Keep `grep` a thin pipeline.

### Gate
`npx vitest run test/unit/application/commands/grep.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/grep.ts test/unit/application/commands/grep.test.ts`

### Commit
`feat(grep): command orchestrator over working-tree, index, and tree-ish targets`

## Slice 3 — Tier-1 surface wiring (barrel, facade, command-key snapshot, README count)

### Context

Wire `grep` into the public Tier-1 surface. This is BEHAVIOUR (the facade binding makes
`repo.grep(...)` callable), not a test-only slice — it lands the barrel re-export, the facade
interface line + binding, the command-key snapshot row, and the README count bump. Every edit
is enumerated with exact insertion anchors in the Orientation public-surface table.

- **`src/application/commands/index.ts`** — insert between line 104 (`} from './fetch-missing.js';`)
  and line 105 (`export { … init } from './init.js';`), matching the alphabetical block style
  (the `range-diff` multi-export at lines 154-161 is the model for a command with many types):
  ```ts
  export {
    type GrepLineHit,
    type GrepOptions,
    type GrepPathResult,
    type GrepResult,
    grep,
  } from './grep.js';
  ```
  **`MatchSpan`, `GrepPattern`, `GrepFixedPattern` are declared in `domain/grep/matcher.ts`**
  (Slice 1) and already reach `reports/api.json` via the `public-types.ts` grep-barrel line —
  do NOT re-declare or re-export them from `grep.ts` or the commands barrel (that would risk a
  TS2308 duplicate-export). `grep.ts` IMPORTS `MatchSpan`/`GrepPattern` from
  `../../domain/grep/index.js` for its own signatures; the command barrel re-exports only the
  command-OWNED types (`GrepOptions`/`GrepResult`/`GrepPathResult`/`GrepLineHit`) + the `grep`
  value. (`buildGrepMatcher`/`GrepMatcher`/`LineVerdict` stay in the `domain/grep` barrel, not
  the commands barrel.)
- **`src/repository.ts` interface** — insert `readonly grep: BindCtx<typeof commands.grep>;`
  between line 199 (`readonly fetchMissing: …`) and line 200 (`readonly init: …`).
- **`src/repository.ts` binding** — insert between line 502 (`}) as Repository['fetchMissing'],`)
  and line 503 (`init: (…)`), mirroring the `rangeDiff` binding (lines 532-535):
  ```ts
  grep: ((grepOpts) => {
    guard();
    return commands.grep(ctx, grepOpts);
  }) as Repository['grep'],
  ```
- **`test/unit/repository/repository.test.ts`** — insert `'grep',` between `'fetchMissing'`
  (line 215) and `'init'` (line 216) in the sorted command-key-set assertion.
- **`README.md:46`** — change `38 Tier-1 commands` → `39 Tier-1 commands`.
- **Add a facade behaviour test** to `test/unit/repository/repository.test.ts` (mirror the
  `describe('When fetchMissing is invoked', …)` block at line 399): a `describe('When grep is
  invoked')` that asserts `sut.grep({ patterns: [...] })` delegates to the command and the
  pre-`open` guard fires (the binding calls `guard()` first — assert calling `grep` on a
  disposed/unopened repo throws the guard error, mirroring how the existing per-command tests
  assert the guard). This is the BEHAVIOUR that makes this slice non-test-only.
- **`src/index.ts`** — confirm NO edit needed (it forwards the commands barrel + public-type
  barrels). State this; do not touch it.

### TDD steps

- RED: add `'grep'` to the command-key-set assertion and add the `describe('When grep is
  invoked')` facade test. They fail — `repository.test.ts` snapshot mismatch (key absent) and
  `sut.grep` is not a function (binding absent).
- GREEN: add the commands-barrel re-export, the facade interface line, the facade binding, and
  the README count bump. The snapshot now includes `'grep'` and `sut.grep` delegates.
- REFACTOR: none expected — these are mechanical insertions. Verify alphabetical ordering in
  the barrel and the interface matches the existing convention.

### Gate
`npx vitest run test/unit/repository/repository.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/index.ts src/repository.ts README.md test/unit/repository/repository.test.ts`

### Commit
`feat(grep): expose grep on the Tier-1 command surface and facade`

## Slice 4 — grep interop test (faithful half: targets / binary / line-numbering vs real git)

### Context

Standalone test-infra slice (NO `src/` delta) — it pins the GIT-FAITHFUL HALF of the matrix
(T1–T4, L1, M1, B1) against real `git`, using a TRIVIAL LITERAL pattern for every cell (the
cells are grammar-independent). It does **NOT** pin any regex grammar against `git grep`
(ADR-395 — V8-vs-glibc proves nothing; this is stated in the test header). All behaviour is
already landed by Slices 1-3. Model EXACTLY on `test/integration/blame-interop.test.ts` (read
it — the env scrubbing, `beforeAll` repo, 60s timeout, `git()`/`runGitEnv()` helpers are reused
verbatim).

- **New file:** `test/integration/grep-interop.test.ts` (the design's renamed file —
  `grep-interop`, NOT `grep-grammar-interop`, because grammar is NOT pinned here).
  - **Header docblock** mirroring blame-interop's `@proves` block:
    ```
    @proves
      surface:        grep
      bucket:         cross-tool-interop
      unique:         tsgit's grep DATA reconstructs git grep's target/binary/line-numbering decisions
      interopSurface: grep
    ```
    PLUS an explicit prose line: "Grammar is NOT pinned against `git grep` (ADR-395); every cell
    uses a trivial literal pattern, and the faithful half is target/binary/line-numbering only."
  - imports: `createNodeContext` (or `createMemoryContext` if blame-interop uses memory —
    blame-interop uses `createNodeContext`; grep's working-tree target needs a real FS, so use
    `createNodeContext` over a `mkdtemp` dir); `grep` from `../../src/application/commands/grep.js`;
    `GIT_AVAILABLE, git, runGit, runGitEnv` from `./interop-helpers.js`; node `mkdtemp`/`rm`/
    `writeFile`. Decode result bytes with `new TextDecoder()`.
  - `describe.skipIf(!GIT_AVAILABLE)(...)`; ONE shared `beforeAll` repo per target family + 60s
    timeout (`SETUP_TIMEOUT = 60_000`) — per the interop load→validate flake note (heavy
    git-spawning times out hooks under validate's concurrency). Scrub `GIT_*` via `runGitEnv()`,
    isolate `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off, throwaway `mkdtemp` repo (the blame
    `makeRepo` helper is the template). The conflict-style pin is N/A (no merge markers).
- **Fixture (design §"Pinned … matrix"):** a working tree with a committed multi-line blob, a
  STAGED-but-uncommitted change `staged_only`, a working-tree-only UNSTAGED change
  `wt_only_unstaged`, ≥5 enumerated paths (3 of which contain the literal — #M1), a multi-line
  blob whose match is on line 12 (#L1), and a blob `b.bin` containing a NUL byte AND the literal
  (#B1).
- **Assertions per matrix cell** — reconstruct git's decision from tsgit's STRUCTURED result and
  compare to real `git grep` output:
  - **#T1** working-tree default on `wt_only_unstaged` → tsgit `grep(ctx, { patterns: [{ fixed: LIT }] })`
    includes the unstaged path; cross-check `git grep -F LIT` (default) lists it.
  - **#T2** `--cached` on `staged_only` → `grep(ctx, { patterns:[…], target: 'index' })` includes
    it; `git grep --cached -F LIT` lists it.
  - **#T3** `--cached` on `wt_only_unstaged` → tsgit OMITS it; `git grep --cached` omits it.
  - **#T4** `{ treeish: 'HEAD' }` on `staged_only` → tsgit OMITS it (committed tree only);
    `git grep -F LIT HEAD` omits it.
  - **#L1** 1-based line numbering — reconstruct `path:lineNumber` from
    `paths[].hits[].lineNumber` and compare to `git grep -n -F LIT` parsed `path:line`.
  - **#M1** multi-path enumeration + order — `paths.map(p => p.path)` (3 paths) matches the set
    `git grep -l -F LIT` reports (compare as sets; ordering is walk-order, assert membership).
  - **#B1** `binaryMatch` → reconstruct `Binary file b.bin matches` (exit 0) from
    `paths.find(p => p.path === 'b.bin').binaryMatch === true` and `hits` empty; compare to
    `git grep -F LIT` output line for the binary file.
  - **`-c` / `-l` derivation** — assert `hits.length` reconstructs `git grep -c -F LIT` per-file
    counts and `paths.map(p => p.path)` reconstructs `git grep -l -F LIT`, WITHOUT the library
    shipping a rendering mode (ADR-249 derivation pin).
- Skips cleanly when `git` is absent (`GIT_AVAILABLE` gate). Use `runGit`/`git` helpers for all
  git spawns; never inherit ambient `GIT_*`.

### TDD steps

- RED: write `grep-interop.test.ts`. With `git` present it fails until the fixture/assertions
  align with live git output — capture live git output during authoring, encode the expected
  derivations, re-run.
- GREEN: finalize the fixture seeding + the per-cell reconstruction assertions so every matrix
  cell passes against live `git grep` (no goldens needed — the comparison is live git vs tsgit;
  if a frozen golden is desired for a stable cell, add it under
  `test/integration/fixtures/` following the blame-interop convention, but live comparison is
  sufficient for the grammar-independent cells).
- REFACTOR: factor a `assertTargetParity(ctx, dir, target, lit)` helper for the repeated
  list/count/line-number quadruple so each `it` is small (mirror blame-interop's per-line
  helpers).

### Gate
`npx vitest run test/integration/grep-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/grep-interop.test.ts`

### Commit
`test(grep): pin target, binary, and line-numbering against real git`

## Slice 5 — grep parity scenario (cross-adapter: Node / memory / browser)

### Context

Standalone test-infra slice (NO `src/` delta) — a single regex-form search over a seeded blob
runs identically on Node, memory, and browser adapters. Parity proves CROSS-ADAPTER
consistency, NOT faithfulness (the interop slice pins the faithful half). All behaviour landed
by Slices 1-3. Model EXACTLY on `test/parity/scenarios/range-diff.scenario.ts`.

- **New file:** `test/parity/scenarios/grep.scenario.ts`. Shape mirrors
  `range-diff.scenario.ts` (`Scenario<GrepScenarioResult>` with `name`, `inputs`, `expected`,
  `run`). Header docblock states "Surfaces closed: commands: grep".
  - `import type { Scenario } from './types.ts';` + `import { AUTHOR } from '../fixtures.ts';`.
  - `interface GrepScenarioResult { readonly paths: ReadonlyArray<{ readonly path: string; readonly lineNumbers: ReadonlyArray<number>; readonly spanCounts: ReadonlyArray<number>; }>; }`
    (derive a stable, adapter-independent projection from `GrepResult` — paths in order, each
    with its hit line numbers and per-hit span counts; do NOT serialize raw `Uint8Array` line
    bytes in `expected` to keep the fixture readable).
  - `run`: `await repo.init();` seed a blob with a known regex match on a known line via
    `ctx.fs.writeUtf8(\`${ctx.layout.workDir}/seed.txt\`, …)` + `repo.add` + `repo.commit`
    (follow the range-diff scenario's `init/add/commit` + `ctx.fs.writeUtf8` pattern), then
    `const result = await repo.grep({ patterns: [/regexLit/] });` and project to
    `GrepScenarioResult`. Use the working-tree default target (works on all three adapters).
  - `expected`: the deterministic projection (e.g. one path, one line number, one span).
- **Register in `test/parity/scenarios/index.ts`:**
  - add `import { grepScenario } from './grep.scenario.ts';` (alphabetical among the imports,
    near the `diffPipelineScenario` import at line 6 / `describeScenario` at line 5 — place
    after `describeScenario`/before `diffPipelineScenario` per import sort, OR follow the file's
    actual ordering convention which is roughly alphabetical).
  - add `grepScenario,` to the `SCENARIOS` array (push at the end after `worktreeScenario`,
    line 59 — the array is execution order, not alphabetical; appending is the established
    pattern for new scenarios).

### TDD steps

- RED: write `grep.scenario.ts` and register it in `index.ts`. The parity harness runs the
  scenario across adapters; it fails if the projection or `expected` is wrong, OR (RED first)
  the import/registration is incomplete. The runners that consume `SCENARIOS` are
  `test/parity/node.test.ts` and `test/parity/memory.test.ts` (VERIFIED — there is no single
  `parity.test.ts`); the gate below runs the whole `test/parity` dir, exercising both.
- GREEN: finalize the `run` projection + `expected` so all three adapters produce the identical
  `GrepScenarioResult`.
- REFACTOR: none expected — keep the scenario minimal and deterministic.

### Gate
`npx vitest run test/parity && npm run check:types && ./node_modules/.bin/biome check test/parity/scenarios/grep.scenario.ts test/parity/scenarios/index.ts`

### Commit
`test(grep): cross-adapter parity scenario for grep`

---

## Phase-boundary gate (after Slice 5)

`npm run validate` — must be green. (Then, at the pre-PR/propose gate, `npm run docs:json`
regenerates `reports/api.json` for the new public `grep` surface, and the prepush
`check:doc-typedoc` verifies it; the `docs/use/commands/grep.*` page is authored in the docs
phase — neither is a plan slice.)

## Decision candidates

None open. ADR-395 (grammar diverges to JS `RegExp`), ADR-396 (v1 command surface), and
ADR-397 (latin1 byte-offset bridge + `u`-flag refusal + caller-`RegExp` immutability) are
ratified and committed; they close the design's D1–D7. The two judgment notes the plan flags
(working-tree bytes via the FS port not `readBlob`; `binaryMatch` as a non-inverted presence
probe) are IMPLEMENTATION mechanics resolved within the slices and pinned against real git in
Slice 4 — not new load-bearing design choices.
