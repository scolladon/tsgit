# Plan — whitespace-diff-options

> Source: design doc `docs/design/whitespace-diff-options.md` · ADRs 378, 379, 380, 381, 382
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

These facts are verified against the worktree HEAD (Serena symbol reads, not recall).
They are the shared substrate; each slice repeats only the deltas it needs.

- **Slice gate (every slice):**
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`
- **Phase-boundary gate (after the last slice):** `npm run validate`.
- **Repo conventions (all slices):** Given/When/Then describe/it tree (`describe('Given …')` >
  `describe('When …')` > `it('Then …')`, 2-level shortcut allowed when one expectation);
  AAA body with `// Arrange` / `// Act` / `// Assert` comments; `sut` names the
  function/object under test (NOT the result — the result is `result`). Error assertions
  assert `.data` (code/reason/value), never bare `toThrow(Class)`. Each guard clause gets
  an isolated per-branch test (mutation-resistant). No provenance refs (phase/ADR/backlog
  numbers) in source or test. No suppression directives. Files kebab-case, functions
  <20 lines, immutable, early returns.
- **Encoding helper:** `bytesEqual(a, b)` in `src/domain/objects/encoding.ts` is the
  current line-equality primitive. `LF` = `0x0a`, the line terminator; tab = `0x09`,
  space = `0x20`, CR = `0x0d`.
- **`splitLines(bytes)` (`src/domain/diff/line-diff.ts`)** keeps the trailing `\n` inside
  each returned line `Uint8Array`; the LAST line is unterminated when the blob has no
  final LF. Every normalizer in this feature operates on the content up to (and excluding)
  the terminator, preserving the `\n` (when present) in the key.
- **The faithfulness matrix is `docs/design/whitespace-diff-options.md` §3.4.** Every
  behavioural assertion cites a matrix row id (W1, B-none, CR1, M1, D1, BL1, …). Pin
  against real git only in the interop slice; unit slices assert the matrix's stated
  outcome directly.
- **Public-surface decision (made up front):**
  - The three FLAT option fields (`ignoreWhitespace?: 'all'|'change'|'at-eol'`,
    `ignoreCrAtEol?: boolean`, `ignoreBlankLines?: boolean`) are **public** — they land on
    the already-exported `DiffOptions` / `DiffTreesOptions` / `RepositoryConfig`
    interfaces. Adding fields to an *already-exported* interface needs NO barrel edit; it
    only regenerates `reports/api.json`.
  - `WhitespaceMode` + `LineKey` (types) are **public-by-re-export**: they must be exported
    from `src/domain/diff/index.ts`, which `src/public-types.ts:32`
    (`export type * from './domain/diff/index.js'`) re-emits — so they appear in
    `reports/api.json`. Decided public in Slice 1, the slice that creates them.
  - `linesEqualUnder` / `normalizeLine` / `resolveLineKey` (the resolver) are **internal**
    values. `export type *` drops values, so even if barrelled they never reach the public
    type surface; barrel them only because sibling `src/domain/diff` + primitive modules
    import them.
  - **api.json gate:** `reports/api.json` staleness is a *prepush* gate
    (`check:doc-typedoc`), not a `validate` gate. Any new public export (the whitespace
    types in Slice 1; the new option/config fields) makes it stale. **Pre-pay it in
    Slice 6** (the last `src/` slice, after every public field exists) by running
    `npm run docs:json` and committing the regenerated `reports/api.json` (the large
    typedoc-id diff is normal). No README count change (no new Tier-1 command). No new
    error code / union member. No new facade method (these are options on the existing
    `diff` command + `RepositoryConfig` keys), so NO `repository.test.ts` surface-snapshot
    edit, NO `docs/use/commands/*` page, NO browser-scenario edit.
- **`diffLines` call-site census (verified):** eight callers, only two get the mode.
  | Caller | File:line | Threads lineKey? |
  |---|---|---|
  | `buildEdits` | `patch-serializer.ts:195` | YES |
  | `computeStatFields` | `stat-fields.ts:35` | YES |
  | `mergeFromDiffs` | `merge/three-way-content.ts:86,87` | NO (byte-exact) |
  | `splitAgainstParent` (blame) | `blame.ts:159,249` | NO (byte-exact) |
  | range-diff | `range-diff/interleave.ts:65` + `range-diff/diff-size.ts` via `computeHunks` | NO (byte-exact) |
  The default (no options) MUST stay byte-identical so the three NO callers are provably
  unchanged (Requirement 7 / ADR-381).
- **Patch reconstruction chain (load-bearing — see Slice 4 judgment note):** the `diff`
  command returns structured data only; the interop test reconstructs `git diff <mode>`
  patch bytes via `reconstructPatch` (`test/integration/diff-reconstruct.ts`) →
  `renderPatch(materialisePatchFiles(...))` → `computeHunks` → `buildEdits` → `diffLines`.
  So the lineKey + blank-suppression must reach `buildEdits` THROUGH the public
  `renderPatch` / `computeHunks` signatures (via `PatchOptions`), not only through an
  internal `buildEdits` arg. `renderPatch`/`computeHunks` are ALSO consumed by `patch-id`,
  `rebase`, and `range-diff` — those pass no mode and stay byte-exact.

---

## Slice 1 — whitespace normalizer (domain) + truth-table + property tests

### Context

Create the new pure module and its tests; nothing downstream yet.

- **New file:** `src/domain/diff/whitespace.ts`. Pure, zero platform deps (domain tier).
- **Public types to declare and export (decided public — Orientation):**
  ```ts
  export type WhitespaceMode = 'all' | 'change' | 'at-eol' | 'none';
  export interface LineKey { readonly mode: WhitespaceMode; readonly ignoreCrAtEol: boolean; }
  ```
  `ignoreBlankLines` is NOT in `LineKey` (it is the emission suppressor of Slice 3/4, a
  separate channel — design §3.1, ADR-379).
- **Internal values to declare and export (internal — values, dropped by `export type *`):**
  - `linesEqualUnder(a: Uint8Array, b: Uint8Array, key: LineKey): boolean` — the hot-path
    comparator. Lazily normalizes during compare; allocates no per-compare normalized copy
    where avoidable. This is what `advanceSnake` will call in Slice 2.
  - `normalizeLine(line: Uint8Array, key: LineKey): Uint8Array` — returns the normalized
    comparison key (used by tests + by the blank-line "is this line empty after the active
    LineKey" check in Slice 3/4). `linesEqualUnder(a,b,key) ≡ bytesEqual(normalizeLine(a,key), normalizeLine(b,key))`
    must hold (state it as a property).
  - `resolveLineKey(fields): LineKey` — resolve the three FLAT public fields into the
    internal descriptor. Input shape (the subset of `DiffTreesOptions` it reads):
    `{ ignoreWhitespace?: 'all'|'change'|'at-eol'; ignoreCrAtEol?: boolean }`. Mapping:
    `ignoreWhitespace: 'all' → mode 'all'`; `'change' → 'change'`; `'at-eol' → 'at-eol'`;
    absent → `mode 'none'`. `ignoreCrAtEol: true → ignoreCrAtEol true` else `false`.
    `ignoreBlankLines` is deliberately NOT read here.
  - Optionally a `lineKeyIsActive(key: LineKey): boolean` predicate
    (`key.mode !== 'none' || key.ignoreCrAtEol`) — Slice 5's drop-pass gate. Keep it here
    so the gate logic has one home.
- **Per-mode normalization semantics (PINNED — design §3.3, matrix §3.4). "Whitespace" =
  space (0x20) and tab (0x09).** Operate on content excluding the terminating `\n`:
  - `mode 'all'` (`-w`): drop ALL space/tab bytes from the key. `a b` ≡ `ab` ≡ `\tab`
    (W1, B-none-under-w, B-zero-under-w).
  - `mode 'change'` (`-b`): collapse each run of space/tab to a single space; drop the
    trailing run; leading-run AMOUNT ignored. KEY DISTINCTION (B-none, B-zero): presence
    change (some↔none) IS a change; amount change (some→different-some) is hidden. So
    `a b`→`a    b` equal (B-run), `a b`→`ab` NOT equal (B-zero), `x`→`  x` NOT equal
    (B-none), `\tx`→`    x` equal (B-amt), `a\tb`→`a b` equal (B-tab).
  - `mode 'at-eol'` (`--ignore-space-at-eol`): drop only the trailing whitespace run
    before the terminator. Leading + internal significant (W3 differs, B-amt2 differs,
    EOL1 equal).
  - `ignoreCrAtEol: true` (`--ignore-cr-at-eol`): drop a single trailing CR (0x0d)
    immediately before the terminator. `a\r\n` ≡ `a\n` (CR1). NARROW: a mid-line CR is
    significant (CR-narrow: `a\rb` ≠ `ab`).
  - **CR cross-mode rule (CR1, design §3.3 #CR1):** a trailing-CR-before-terminator is
    ALSO droppable under `mode 'all'`, `mode 'change'`, and `mode 'at-eol'` (CR is
    EOL whitespace for them). `ignoreCrAtEol` is the only knob that drops the trailing CR
    WITHOUT also dropping trailing space/tab. The normalizer must classify a trailing CR
    as droppable under all four of those, and under nothing else.
- **New test file:** `src/domain/diff/whitespace.test.ts` — per-mode truth tables straight
  from §3.4. Mirror the existing domain-diff test style (`test/unit/domain/diff/stat-fields.test.ts`
  is the closest small example: `const enc = (s) => new TextEncoder().encode(s)`).
  Isolated guard tests per boundary: presence-vs-amount for `'change'` (separate tests for
  B-none and B-zero and B-run), mid-line CR vs trailing CR (CR-narrow vs CR1) — these are
  the StringLiteral/ConditionalExpression mutation hot spots; assert the exact boolean
  verdict, never a generic truthy.
- **New property file:** `test/unit/domain/diff/whitespace.properties.test.ts` (`fast-check`).
  There is NO `line-diff.properties` sibling today; the normalizer fits property lenses 2
  (compositional matcher) + 4 (idempotence). Model the existing
  `test/unit/domain/diff/similarity.properties.test.ts` /
  `test/unit/domain/diff/patch-serializer.properties.test.ts` for layout and `numRuns`
  tiers. (Verified: ALL property + example tests live under `test/unit/...`, never under
  `src/`.) Properties (per design §7):
  - **idempotence** (`numRuns` 200): `normalizeLine(normalizeLine(x, k), k) ≡ normalizeLine(x, k)` for every mode.
  - **dominance** (`numRuns` 100): `linesEqualUnder(a,b,{mode:'all',…})` is true whenever `linesEqualUnder(a,b,{mode:'change',…})` is.
  - **reflexivity** (`numRuns` 100): `linesEqualUnder(x,x,k)` always true.
  - **whitespace-only equivalence under `'all'`** (`numRuns` 100): for arbitrary `x` and an
    arbitrary space/tab re-sprinkling `x'`, `linesEqualUnder(x,x',{mode:'all',ignoreCrAtEol:false})` holds.
  - **normalize/equal consistency** (`numRuns` 100): `linesEqualUnder(a,b,k) ≡ bytesEqual(normalizeLine(a,k), normalizeLine(b,k))`.
  Generators: use a `fc.string` mapped through `TextEncoder`, plus a dedicated arbitrary
  that interleaves spaces/tabs into a base string for the re-sprinkling property. Per-family
  generators may live inline (the file is small) or in the existing
  `test/unit/domain/diff/arbitraries.ts` — prefer inline to avoid coupling.
- **Barrel:** add to `src/domain/diff/index.ts` (in the existing `// Line diff` block or a
  new `// Whitespace` block):
  `export type { LineKey, WhitespaceMode } from './whitespace.js';`
  `export { linesEqualUnder, normalizeLine, resolveLineKey } from './whitespace.js';`
  (and `lineKeyIsActive` if created). The types now ride `public-types.ts:32` → api.json
  (regenerated in Slice 6, not here — validate is green without it; only prepush needs it).

### TDD steps

- RED: write `whitespace.test.ts` truth tables (per-mode equal/not-equal rows from §3.4)
  and `whitespace.properties.test.ts`. They fail to import `whitespace.js` (module absent)
  → expected failure: `Cannot find module './whitespace.js'`.
- GREEN: implement `whitespace.ts` — `normalizeLine` (the four transforms + CR rule),
  `linesEqualUnder` (delegate to `normalizeLine` + `bytesEqual`, or a fused fast path),
  `resolveLineKey`, `lineKeyIsActive`, and the exported types. Add the barrel lines.
- REFACTOR: extract the per-mode key-derivation into small helpers (`dropAllSpace`,
  `collapseRuns`, `dropTrailingWs`, `dropTrailingCr`) so each is <20 lines and the CR
  cross-mode rule is expressed once. Confirm idempotence holds by construction.

### Gate
`npx vitest run test/unit/domain/diff/whitespace.test.ts test/unit/domain/diff/whitespace.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/whitespace.ts src/domain/diff/index.ts test/unit/domain/diff/whitespace.test.ts test/unit/domain/diff/whitespace.properties.test.ts`

### Commit
`feat(diff): whitespace line-key normalizer and resolver`

## Slice 2 — thread an optional line-key into `diffLines`

### Context

Give `diffLines` an optional trailing options arg defaulting to today's exact compare, and
route the Myers equality through `linesEqualUnder`. This is the SINGLE equality choke point.

- **File:** `src/domain/diff/line-diff.ts`.
- **Current signatures (verified):**
  - `export function diffLines(ours: Uint8Array, theirs: Uint8Array): LineDiff` (line 254).
  - `function advanceSnake(oursLines, theirsLines, v, offset, d, k)` (line 91) — the ONLY
    place `bytesEqual(oursLines[x]!, theirsLines[y]!)` is called (line 105).
  - `function computeMyersTrace(oursLines, theirsLines)` (line 113) calls `advanceSnake`.
  - `reconstructEdits` (line 157) walks the trace GEOMETRICALLY (no byte compare) — it does
    NOT need the key. `buildHunks` (line 195) too. So only `advanceSnake` +
    `computeMyersTrace` + `diffLines` need a key parameter; `M===0 && N===0` and the
    `wholeFileFallback` paths don't compare lines.
- **New public option type (export from line-diff.ts AND the barrel):**
  ```ts
  export interface LineDiffOptions { readonly lineKey?: LineKey; }
  export function diffLines(ours, theirs, options?: LineDiffOptions): LineDiff;
  ```
  Import `LineKey` + `linesEqualUnder` from `./whitespace.js`. Resolve the comparator ONCE
  at the top of `diffLines`: `const eq = options?.lineKey ? (a, b) => linesEqualUnder(a, b, options.lineKey!) : bytesEqual;`
  then thread `eq` (a `(a: Uint8Array, b: Uint8Array) => boolean`) down through
  `computeMyersTrace` → `advanceSnake`, replacing the hardcoded `bytesEqual` call at
  line 105. Default (no options / no lineKey) ⇒ `eq === bytesEqual` ⇒ byte-identical to
  today (this is the Requirement-7 safety contract).
- **Barrel:** add `LineDiffOptions` to the `// Line diff` type exports in
  `src/domain/diff/index.ts`.
- **Test file to extend:** the example test for `diffLines` — locate it
  (`test/unit/domain/diff/line-diff.test.ts`, ~22 KB; `enc = (s) => new TextEncoder().encode(s)`
  already defined). Add a `describe('Given a lineKey option')` block.
- **Pinned behaviour (matrix §3.4):**
  - **#M1**: file with a ws-only line (`  ws`→`    ws`) AND a real line (`real`→`REAL`).
    Under `{ lineKey: { mode: 'all', ignoreCrAtEol: false } }` the ws-only line becomes a
    `common` hunk (the emitted line keeps the ORIGINAL/new bytes — `diffLines` returns the
    raw `oursLines`/`theirsLines`, unchanged; only equality is normalized), and the real
    line stays an `ours-only`/`theirs-only` pair. Assert hunk kinds + that
    `theirsLines`/`oursLines` carry the original bytes (Requirement 3).
  - **Default regression guard (Requirement 7):** `diffLines(old, new)` ≡
    `diffLines(old, new, {})` ≡ `diffLines(old, new, { lineKey: { mode: 'none', ignoreCrAtEol: false } })`
    for a fixture with whitespace differences — all three produce IDENTICAL hunks (this is
    the byte-exactness contract that protects merge/blame/range-diff). Assert deep-equal
    hunks across the three call forms.

### TDD steps

- RED: add the lineKey-option tests + the three-way default-equivalence guard. They fail —
  `diffLines` rejects a third argument (arity) / no normalization happens.
- GREEN: add `LineDiffOptions`, the `eq` resolution in `diffLines`, thread `eq` through
  `computeMyersTrace`/`advanceSnake`, barrel `LineDiffOptions`.
- REFACTOR: keep the `eq` parameter name consistent; ensure the `bytesEqual` import stays
  (default path). Confirm the existing line-diff tests (no options) still pass unchanged —
  they exercise the `eq === bytesEqual` default.

### Gate
`npx vitest run test/unit/domain/diff/line-diff.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/line-diff.ts src/domain/diff/index.ts test/unit/domain/diff/line-diff.test.ts`

### Commit
`feat(diff): thread optional line-key through diffLines equality`

## Slice 3 — stat-fields: line-key counts + blank-line suppression

### Context

`computeStatFields` is the numstat counter. Give it the lineKey AND blank-line suppression
so `git diff -w --numstat` / `git diff --ignore-blank-lines --numstat` counts are faithful.

- **File:** `src/domain/diff/stat-fields.ts`.
- **Current signature (verified):**
  `export const computeStatFields = (old: Uint8Array, next: Uint8Array): StatFields`
  (line 31). Binary short-circuit at line 32 (`isBinary(old) || isBinary(next)`); else
  `const diff = diffLines(old, next)` then counts `theirs-only` → added, `ours-only` →
  deleted (lines 35-42).
- **New signature:** add a trailing options arg:
  ```ts
  export interface StatFieldsOptions {
    readonly lineKey?: LineKey;
    readonly ignoreBlankLines?: boolean;
  }
  export const computeStatFields = (old, next, options?: StatFieldsOptions): StatFields;
  ```
  Export `StatFieldsOptions` from the `// Per-file stat counts` block of
  `src/domain/diff/index.ts`. Thread `{ lineKey }` into `diffLines(old, next, { lineKey })`
  (use the Slice-2 arg). Binary short-circuit UNCHANGED (binary ignores whitespace flags;
  matrix — binary never line-diffs).
- **Blank-line suppression (design §3.3a, ADR-379):** when `ignoreBlankLines === true`, a
  change GROUP consisting SOLELY of blank lines is dropped from the `added`/`deleted`
  counts BEFORE summing. "Blank" = empty AFTER the active line-key normalization (read the
  active `LineKey`). Mechanism: walk the line-diff hunks; an `ours-only` hunk contributes
  to `deleted` only if at least one of its lines is non-blank under the key; a
  `theirs-only` hunk contributes to `added` only if at least one line is non-blank. A line
  is blank iff `normalizeLine(line, lineKeyOrNone)` (minus the terminator) has length 0 —
  reuse `normalizeLine` from whitespace.js with the active key (or `{mode:'none',ignoreCrAtEol:false}`
  when no line-key mode is set, so a spaces-only line is NOT blank under
  `--ignore-blank-lines` ALONE — #BL-spaces). Access the raw lines via the returned
  `diff.oursLines` / `diff.theirsLines` indexed by the hunk's `oursStart..oursEnd` /
  `theirsStart..theirsEnd`.
  - **Design-faithful caveat (judgment note for the implementer):** git's blank
    suppression is per *change group* (a contiguous add/delete pair), and #BL2 shows a
    real change adjacent to a blank insertion still emits. At the numstat-count level the
    rule reduces to "count a hunk's lines only if the hunk has ≥1 non-blank line"; mixed
    groups (some blank, some real lines in one hunk) count ALL their lines per git (the
    group is not blank-only). Pin #BL2 (`2 1`) and #BL-spaces (`1 0`) to lock this.
- **Test file to extend:** `test/unit/domain/diff/stat-fields.test.ts` (style shown above:
  `enc`, `withNul`, GWT tree). Add:
  - line-key counts: under `{ lineKey: {mode:'all',…} }` a ws-only single-line change is
    `0 0` (no real change) — W1/D1 at the count level; under `{ lineKey: {mode:'change',…} }`
    the B-* rows' counts.
  - blank suppression: `ignoreBlankLines: true` on a blank-only insert → `0 0` (#BL1);
    blank insert + a real `c`→`C` → `2 1` (#BL2); a spaces-only insert with
    `ignoreBlankLines: true` and NO line-key mode → `1 0` (#BL-spaces, spaces-only NOT
    blank alone); the same spaces-only insert with `{ lineKey:{mode:'all',…}, ignoreBlankLines:true }`
    → `0 0` (#BL-combo: `-w` makes the inserted line blank).
  - binary short-circuit unaffected by either option (isolated guard test).
  - default (no options) byte-identical to today's counts (regression guard).
  Isolated guard tests: blank suppression fires ONLY on blank-only hunks; the blank
  definition reads the active `LineKey` (separate test for `{mode:'none'}` vs `{mode:'all'}`).

### TDD steps

- RED: add the lineKey + blank-suppression count tests. They fail — `computeStatFields`
  rejects the third arg / no suppression.
- GREEN: add `StatFieldsOptions`, thread `{ lineKey }` into `diffLines`, implement the
  per-hunk blank-aware contribution, barrel `StatFieldsOptions`.
- REFACTOR: extract an `isBlankLine(line, key)` helper (delegates to `normalizeLine`) and a
  `hunkHasNonBlank(diff, hunk, key)` helper; keep `computeStatFields` <20 lines.

### Gate
`npx vitest run test/unit/domain/diff/stat-fields.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/stat-fields.ts src/domain/diff/index.ts test/unit/domain/diff/stat-fields.test.ts`

### Commit
`feat(diff): line-key and blank-line aware numstat counts`

## Slice 4 — patch-serializer: line-key + blank suppression through renderPatch/computeHunks

### Context

Thread the mode through the patch-emission chain so reconstructed `git diff <mode>` patch
bytes are faithful. **This is the slice with the design's most important under-specified
call-chain — see the judgment note.**

- **File:** `src/domain/diff/patch-serializer.ts`.
- **Current signatures (verified):**
  - `buildEdits(oldLines, newLines, oldBytes, newBytes)` (line 189) — `const ld = diffLines(oldBytes, newBytes)` (line 195), flattens hunks → edits.
  - `computeHunks(oldBytes, newBytes, contextLines)` (line 436, **exported**) — calls
    `buildEdits` then `groupHunks`. Consumed by: `renderTextBody` (line 459),
    `renderTwoPathBody` (line 569), AND externally by `range-diff/patch-text.ts:132`,
    `range-diff/diff-size.ts:15` (range-diff — must stay byte-exact).
  - `renderPatch(files, opts?: PatchOptions)` (line 680, **exported**) —
    `PatchOptions = { contextLines?; pathPrefix? }` (line 25). Consumed by `patch-id.ts:60`,
    `rebase.ts:304`, `range-diff` reconstruct, and the interop reconstruct helpers
    (`test/integration/diff-reconstruct.ts`, `test/integration/show-render/reconstruct.ts`)
    — all must stay byte-exact when no mode is passed.
- **JUDGMENT CALL (implementer must follow — design §5 says "thread lineKey in
  buildEdits" but the real reconstruct path is `renderPatch → computeHunks → buildEdits`):**
  The lineKey + `ignoreBlankLines` must be plumbed as OPTIONAL fields through the PUBLIC
  signatures so the interop test (which calls `renderPatch`, not `buildEdits`) can pass the
  active mode:
  - extend `PatchOptions`: add `readonly lineKey?: LineKey;` and
    `readonly ignoreBlankLines?: boolean;`.
  - extend `computeHunks` to a 4th optional param OR an options object:
    `computeHunks(oldBytes, newBytes, contextLines, options?: { lineKey?: LineKey; ignoreBlankLines?: boolean })`.
    Prefer an options object so range-diff's 3-arg calls compile unchanged and stay
    byte-exact.
  - extend `buildEdits` to forward `{ lineKey }` into `diffLines` and to apply blank-line
    suppression on the produced edits when `ignoreBlankLines` is set.
  - `renderPatch` forwards `opts?.lineKey` / `opts?.ignoreBlankLines` into each
    `renderFile → renderTextBody/renderTwoPathBody → computeHunks` call. Plumb a small
    `EmitOptions` through `renderFile`/`renderSameKindBlock`/`renderBrokenModifyBlock`/
    `renderTwoPathBlock`/`renderTextBody`/`renderTwoPathBody` (they currently pass
    `contextLines` positionally — add the options alongside).
  - **Default (no lineKey / no ignoreBlankLines) ⇒ byte-identical to today.** patch-id,
    rebase, range-diff, and show-render reconstruct pass nothing and are provably unchanged.
- **Blank-line suppression at emission (design §3.3a, matrix #BL1/#BL2):** a change group
  consisting solely of blank lines (blank = empty after the active line-key) produces NO
  emitted hunk. #BL1: a blank-only `--ignore-blank-lines` change yields an EMPTY patch body
  — and per the matrix git emits NO `diff --git` header at all for a file whose entire
  patch body is suppressed. **JUDGMENT CALL:** at the serializer level, `renderSameKindBlock`
  currently always emits the `diff --git` + index preamble even with zero hunks. For #BL1
  faithfulness the reconstructed patch must have an empty body AND no header. Decide the
  faithful boundary here: the cleanest reproduction is that the FILE is still in
  `TreeDiff.changes` (membership preserved — the drop pass in Slice 5 does NOT remove it),
  but its reconstructed patch contributes zero bytes. Implement: when `ignoreBlankLines`
  suppresses ALL hunks of a modify/type-change/rename body AND it is not a mode/binary
  change, `renderFile` returns `[]` for that file (no header). Pin against the matrix #BL1
  ("empty body, no `diff --git` header") in the interop slice; add a unit test here that
  `renderPatch([blankOnlyModifyFile], { ignoreBlankLines: true })` returns `''` (or the
  trailing-newline-only empty document the existing `renderPatch` returns for an empty
  file list — verify which: `renderPatch([])` returns `''`, but a non-empty `files` always
  pushes a final `''` then joins; confirm the exact empty-body bytes against git in
  interop).
- **Test file to extend:** `test/unit/domain/diff/patch-serializer.test.ts` (53 KB, GWT
  tree). Add a `describe('Given a lineKey patch option')` and
  `describe('Given ignoreBlankLines')`:
  - #M1 via `renderPatch`/`computeHunks` with `{ lineKey: {mode:'all',…} }`: the ws-only
    line renders as CONTEXT with the NEW whitespace bytes (` ` prefix + `    ws`), the real
    line as `-real`/`+REAL`.
  - default (no options) byte-identical to existing fixtures (regression guard — reuse an
    existing patch fixture, assert the no-options output unchanged).
  - blank suppression: a blank-only modify under `{ ignoreBlankLines: true }` → empty body
    / no header (#BL1); blank + real change under `{ ignoreBlankLines: true }` keeps the
    real hunk (#BL2).
  - range-diff/patch-id byte-exactness: assert a 3-arg `computeHunks` call is unchanged
    (the existing tests cover this; ensure they still pass).
- The existing `patch-serializer.properties.test.ts` need not change unless its round-trip
  property now needs a default-arg path; verify it stays green (no new property required —
  the normalizer's properties live in Slice 1).

### TDD steps

- RED: add the lineKey + blank-suppression render tests (via `renderPatch`/`computeHunks`).
  They fail — `PatchOptions`/`computeHunks` reject the new fields / no normalization.
- GREEN: extend `PatchOptions`, `computeHunks`, `buildEdits`, and the `renderFile` →
  body-renderer plumbing; implement blank-group suppression + the empty-body/no-header
  #BL1 case; import `LineKey`/`normalizeLine` from `./whitespace.js`.
- REFACTOR: introduce one `EmitOptions { lineKey?; ignoreBlankLines? }` carried alongside
  `contextLines` through the render helpers; extract a `suppressBlankGroups(edits, key)`
  helper shared in spirit with Slice 3's count suppression (keep them separate functions —
  one over edits, one over hunks — but mirror the `isBlankLine` predicate from whitespace.js).

### Gate
`npx vitest run test/unit/domain/diff/patch-serializer.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/patch-serializer.ts src/domain/diff/index.ts test/unit/domain/diff/patch-serializer.test.ts`

### Commit
`feat(diff): line-key and blank-line aware patch emission`

## Slice 5 — primitive drop pass + thread mode through `diffTrees`

### Context

Wire the resolved mode into the `diffTrees` primitive: the file-drop pass (line-key
mode only, after rename detection, before stat) and the threading into `attachStats`.

- **File:** `src/application/primitives/diff-trees.ts`.
- **Current flow (verified):** `diffTrees(ctx, a, b, options?)` →
  `resolveInput` both sides → `rawDiff` (recursive or `domainDiffTrees`) →
  `detectRenames === true ? detectSimilarityRenames(...) : rawDiff` (line 44) →
  `withStat === true ? attachStats(ctx, diff) : diff` (line 53). `attachStats` (line 80)
  uses `materialisePatchFiles` then `withStatFields` → `computeStatFields(old, next)`.
- **`DiffTreesOptions` (in `src/application/primitives/types.ts:187`)** today carries
  `detectRenames?`, `renameOptions?`, `recursive?`, `withStat?`. **Add the three FLAT
  fields** in Slice 6's command-wiring? — NO: add them HERE (the primitive consumes them).
  Add to `DiffTreesOptions` in `types.ts`:
  ```ts
  readonly ignoreWhitespace?: 'all' | 'change' | 'at-eol';
  readonly ignoreCrAtEol?: boolean;
  readonly ignoreBlankLines?: boolean;
  ```
  (These ride `export type * from './types.js'` in `src/application/primitives/index.js:70`
  → public via `public-types.ts:10` — no barrel edit.)
- **Resolve the descriptor once** at the top of `diffTrees`:
  `const lineKey = resolveLineKey(options ?? {});` (from `domain/diff` barrel),
  `const ignoreBlankLines = options?.ignoreBlankLines === true;`,
  `const lineKeyActive = lineKeyIsActive(lineKey);`.
- **Drop pass (design §3.2, ADR-380):** runs AFTER rename detection (so `diff` is the
  post-rename change-set), BEFORE `attachStats`. ONLY when `lineKeyActive` (gated on the
  line-key mode, NEVER on `ignoreBlankLines` alone — #BL1 keeps the file). For each
  `modify` change (NOT add/delete/rename/copy/type-change), hydrate both blob sides and run
  `diffLines(old, new, { lineKey })`; apply blank-line suppression if `ignoreBlankLines`;
  if zero `ours-only`/`theirs-only` hunks remain → DROP the change. Binary files and
  type-changes NEVER drop (a `modify` whose blob trips `isBinary` is kept — binary ignores
  whitespace; type-change is a different `type`, already excluded by targeting only
  `modify`).
  - **Reuse the ONE `diffLines` per file (design §3.2 / ADR-380 "one line diff per
    file"):** the drop pass reads blobs via the SAME bounded pool as `attachStats`
    (`materialisePatchFiles`, `MAX_CONCURRENT_BLOB_LOADS = 32`). Structure so that when
    both the drop and `withStat` run, the per-file blob load + line diff happens once. A
    clean shape: hydrate via `materialisePatchFiles(ctx, diff.changes)` ONCE when
    `lineKeyActive || withStat`, compute each file's `diffLines(old,new,{lineKey})` once,
    use it for BOTH the drop decision and (when `withStat`) the counts. When neither is
    active, keep the OID-only fast path (NO blob reads — Requirement / ADR-381 zero new
    cost for default diff).
  - **`modify` with `oldId === newId`** cannot occur here (a modify has differing OIDs by
    construction in `domainDiffTrees`), but `materialiseOne` handles the equal-id case
    defensively; the drop's line diff over identical bytes yields zero hunks — harmless
    (such a change wouldn't be classified as modify anyway). Note it; don't add a guard.
- **`attachStats` change:** thread `{ lineKey, ignoreBlankLines }` into `computeStatFields`
  (Slice 3's options). If the file's `diffLines` was already computed for the drop, reuse
  it; otherwise `computeStatFields` recomputes — acceptable but the design wants one diff
  per file, so prefer passing the precomputed result. **JUDGMENT CALL:** the simplest
  correct first cut is to (a) materialise once, (b) run the drop using
  `computeStatFields(old,new,{lineKey,ignoreBlankLines})` whose `added===0 && deleted===0`
  is the drop predicate for a `modify` (since a modify with zero added AND zero deleted
  under the mode == no changed hunks), and (c) reuse those same StatFields for `withStat`.
  This collapses "drop predicate" and "stat counts" into ONE `computeStatFields` call per
  modify — exactly ADR-380's "the drop, the patch, and the counts are mutually consistent".
  Caveat: a modify that is blank-only under `ignoreBlankLines` ALONE (no line-key) has
  `added===0 && deleted===0` too — but `lineKeyActive` is false so the drop pass does NOT
  run, so it is NOT dropped (#BL1 preserved). The predicate is `lineKeyActive && isModify && added===0 && deleted===0 && !binary`.
- **Test file to extend:** `test/unit/application/primitives/diff-trees.test.ts` (23 KB,
  GWT tree, builds trees via memory adapter — read its existing helpers for tree
  construction). Add:
  - drop: a ws-only `modify` is removed under `{ ignoreWhitespace: 'all' }` (#D1) and KEPT
    with no mode; a mixed two-file diff (ws-only `f` + real `g`) drops only `f` (#D1).
  - `ignoreBlankLines` ALONE does NOT drop a blank-only modify — it stays in `changes`
    (#BL1, #BL-two: both files stay); `{ ignoreWhitespace:'all', ignoreBlankLines:true }`
    DOES drop the spaces-only insert (#BL-combo via the line-key).
  - binary modify never dropped under `{ ignoreWhitespace:'all' }` (isolated guard); a
    `type-change` never dropped (isolated guard).
  - composition: the mode composes with `recursive: true` and `detectRenames: true`; a
    whitespace-only rename still pairs (§4) and is NOT dropped (the drop targets `modify`).
  - `withStat: true` + a mode reflects the mode's counts (#W2) and the dropped file is
    absent from `changes` entirely (not a `0 0` row).
  - no-mode fast path: assert the default diff does NOT read blobs (e.g. spy/instrument
    `readBlob`, or assert behaviour parity with current default — match how the existing
    test asserts the OID-only path; if no such hook exists, assert the change-set is
    byte-identical to the no-options call).
  Isolated per-branch guard tests, one per gate (line-key active vs `ignoreBlankLines`-only
  vs binary vs type-change vs rename) — mutation-resistant.

### TDD steps

- RED: add the drop + threading + composition tests. They fail — `DiffTreesOptions` rejects
  the new fields / no drop happens.
- GREEN: add the three fields to `DiffTreesOptions`; resolve `lineKey`/`ignoreBlankLines`/
  `lineKeyActive`; implement the single-materialise + drop pass after rename detection and
  before stat; thread the options into `attachStats`/`computeStatFields`; keep the OID-only
  fast path when neither line-key nor `withStat` is active.
- REFACTOR: extract `dropWhitespaceOnlyModifies(ctx, diff, lineKey, ignoreBlankLines)`
  returning `{ changes, statByPath? }` so the stat reuse is explicit and `diffTrees`
  stays a readable pipeline; keep each function <20 lines.

### Gate
`npx vitest run test/unit/application/primitives/diff-trees.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/diff-trees.ts src/application/primitives/types.ts test/unit/application/primitives/diff-trees.test.ts`

### Commit
`feat(diff): primitive whitespace drop pass and mode threading`

## Slice 6 — command + config wiring + public-surface (api.json)

### Context

Surface the three flat fields on the public `DiffOptions`, wire config precedence in the
`diff` command (whitespace + the retired-dead `detectRenames`), add the config keys to
`RepositoryConfig`, and pre-pay the api.json prepush gate.

- **File:** `src/application/commands/diff.ts`.
- **Current `DiffOptions` (line 8, verified):** `from?`, `to?`, `detectRenames?`,
  `renameOptions?`, `recursive?`, `withStat?`. **Add the three FLAT fields** with doc
  comments framing them as DATA modes (not rendering knobs — ADR-249 §1.1):
  ```ts
  readonly ignoreWhitespace?: 'all' | 'change' | 'at-eol';
  readonly ignoreCrAtEol?: boolean;
  readonly ignoreBlankLines?: boolean;
  ```
  `DiffOptions` is exported from the commands barrel (`src/application/commands/index.ts:97`)
  and rides `public-types.ts:7` — no barrel edit; api.json regenerates.
- **Current `diff()` body (lines 34-45, verified):** resolves `from`/`to`, builds
  `treeOptions: DiffTreesOptions` from `opts.*` conditionally, calls `diffTrees`. It reads
  ONLY `opts.*`, NEVER `ctx.config`.
- **Config precedence wiring (design §5.1, ADR-382):** resolve each field as
  `opts.X ?? ctx.config?.X ?? default` BEFORE building `treeOptions`. Apply to FOUR fields:
  - `detectRenames`: `opts.detectRenames ?? ctx.config?.detectRenames` (default: omit →
    false). This RETIRES the dead `RepositoryConfig.detectRenames` (was declared-but-
    unconsumed — design §5.1 audit found ZERO call sites set it, so the wiring is
    behaviorally inert today).
  - `ignoreWhitespace`: `opts.ignoreWhitespace ?? ctx.config?.ignoreWhitespace` (default: omit).
  - `ignoreCrAtEol`: `opts.ignoreCrAtEol ?? ctx.config?.ignoreCrAtEol` (default: omit).
  - `ignoreBlankLines`: `opts.ignoreBlankLines ?? ctx.config?.ignoreBlankLines` (default: omit).
  - `renameOptions` is NOT added to config (per-call only — ADR-382); keep
    `opts.renameOptions` as-is. `recursive`/`withStat` stay per-call only (not config).
  Build `treeOptions` from the RESOLVED values (only set a key when the resolved value is
  defined/true, matching the existing conditional-spread style so the OID-only fast path is
  preserved when nothing is set).
- **File:** `src/ports/context.ts`. **Add to `RepositoryConfig` (line 64, after
  `detectRenames?` at line 84)** the three flat keys with a doc comment that they are
  PROGRAMMATIC facade defaults, NOT git's `.git/config`, and explicitly NOT
  `core.whitespace` (ADR-382 / design §5.1):
  ```ts
  readonly ignoreWhitespace?: 'all' | 'change' | 'at-eol';
  readonly ignoreCrAtEol?: boolean;
  readonly ignoreBlankLines?: boolean;
  ```
  `RepositoryConfig` rides `public-types.ts:47` (`export type * from './ports/index.js'`) —
  no barrel edit; api.json regenerates.
- **No `validate-options.ts` change:** verified `validateOptions`
  (`src/repository/validate-options.ts`) validates only numeric/function config values;
  `detectRenames` (boolean) is NOT validated, and the new fields are type-constrained
  (enum + booleans) needing no runtime check. Do NOT add validation (matches `detectRenames`
  precedent). State this so the implementer doesn't over-engineer.
- **Test file to extend:** `test/unit/application/commands/diff.test.ts` (19 KB, GWT,
  memory-adapter trees). Add:
  - the three flat fields thread `DiffOptions` → primitive (assert the mode's effect on the
    returned `TreeDiff`/`StatTreeDiff`: a ws-only file dropped under `{ ignoreWhitespace:'all' }`;
    `withStat:true` + mode reflects mode counts; default options unchanged).
  - **config precedence guards (design §5.1 — these are GUARDS, not remediations):**
    - `ctx.config.detectRenames: true` + no per-call option → `diff` NOW performs rename
      detection (proves the dead field is consumed).
    - per-call `detectRenames: false` OVERRIDES `config.detectRenames: true` (precedence).
    - `config.ignoreWhitespace: 'all'` applies as the standing default (drops a ws-only
      file); a per-call `ignoreWhitespace` overrides it; absent both → exact compare
      (file present).
    - symmetric for `ignoreCrAtEol` / `ignoreBlankLines` (per-call overrides config).
  - Isolated guard tests per field and per precedence rung (per-call present / config
    present / both absent) — mutation-resistant. To set `ctx.config`, construct the memory
    context then pass config (check how `diff.test.ts` / `createMemoryContext` accept config
    — `createContext`/`createMemoryContext` take a `config` part; if the existing test has
    no config-injection helper, add a minimal one inline).
- **api.json (prepush gate — pre-pay HERE, the last `src/` slice):** after all public
  fields exist (whitespace types from Slice 1; `LineDiffOptions`/`StatFieldsOptions`/
  `PatchOptions` fields; `DiffOptions`/`DiffTreesOptions`/`RepositoryConfig` fields), run
  `npm run docs:json` and commit the regenerated `reports/api.json` in THIS slice's commit.
  The typedoc-id churn is large and normal. (Validate is green without it; only the prepush
  hook rejects a stale api.json — so this MUST land before the PR push, which is why it's
  folded into the final source slice rather than left to a phase boundary.)

### TDD steps

- RED: add the threading + config-precedence guard tests. They fail — `DiffOptions` rejects
  the fields / `diff` ignores `ctx.config`.
- GREEN: add the three fields to `DiffOptions` + `RepositoryConfig`; rewrite `diff()`'s
  option resolution to `opts.X ?? ctx.config?.X` for the four fields; build `treeOptions`
  from the resolved values.
- REFACTOR: extract a small `resolveDiffOptions(opts, ctx.config)` returning the resolved
  `DiffTreesOptions` so `diff()` stays a thin facade; keep the conditional-spread so unset
  fields don't force blob reads. Then run `npm run docs:json` and stage `reports/api.json`.

### Gate
`npx vitest run test/unit/application/commands/diff.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/diff.ts src/ports/context.ts test/unit/application/commands/diff.test.ts`
<!-- reports/api.json is regenerated and committed in this slice but is not lint-checked here; it is the prepush gate's concern. The phase-boundary `npm run validate` plus the prepush `check:doc-typedoc` verify it. -->

### Commit
`feat(diff): wire whitespace and rename config precedence into diff`

## Slice 7 — whitespace interop test (twin real-git vs tsgit + frozen golden)

### Context

Standalone test-infra slice (no `src/` delta) — it pins the full §3.4 matrix against real
`git`, mirroring `test/integration/diff-recursive-interop.test.ts`. This is the
faithfulness capstone; all behaviour is already landed by Slices 1-6.

- **New file:** `test/integration/diff-whitespace-interop.test.ts`. Model EXACTLY on
  `test/integration/diff-recursive-interop.test.ts` (read it — the harness, env scrubbing,
  golden-load pattern are reused verbatim):
  - imports: `createMemoryContext`, `add`, `commit`, `init`, `diff` from src; `reconstructPatch`
    from `./diff-reconstruct.js`; `GIT_AVAILABLE, git, makePeerPair, runGit, runGitEnv` from
    `./interop-helpers.js`.
  - `describe.skipIf(!GIT_AVAILABLE)(...)`; ONE shared `beforeAll` repo + 60s timeout (per
    the interop load→validate flake note — heavy git-spawning interop times out hooks under
    validate's concurrency).
  - faithfulness procedure (design §3.4 / §7): scrub `GIT_*` (via `runGitEnv()`), isolate
    `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off, throwaway repo. The conflict-style pin is
    N/A here (no merge markers).
- **`reconstructPatch` extension (judgment note):** the existing
  `test/integration/diff-reconstruct.ts` helper renders via
  `renderPatch(materialisePatchFiles(...))` with NO options. For the interop test to
  reconstruct `git diff <mode>` patch bytes it must pass the active `{ lineKey, ignoreBlankLines }`
  into `renderPatch` (Slice 4 made `PatchOptions` carry them). EITHER extend
  `reconstructPatch` to accept an optional `PatchOptions`-shaped arg and forward it, OR add
  a local reconstruct helper in the interop file. Prefer extending `diff-reconstruct.ts`
  with an optional trailing arg (default = today's no-options behaviour, so the recursive
  interop test stays unchanged). Resolve the `lineKey` for reconstruction via
  `resolveLineKey` from the `domain/diff` barrel (same resolver the primitive uses), so the
  reconstruction mode matches the diff mode.
- **Assertions per mode + combination (design §7):** for each §3.4 fixture, assert tsgit's
  STRUCTURED result reconstructs ALL of live git's per-mode output:
  - **`--name-status`-equivalent change-set** from `TreeDiff.changes` membership — including
    the #D1 line-key file-drop (ws-only file ABSENT) AND the #BL1/#BL-two blank-only files
    that STAY present (`M` shown). Compare the set of changed paths to
    `git diff --name-status <mode>` parsed paths.
  - **`--numstat`-equivalent rows** by applying the §3.3a DERIVED omit rule to the
    `StatTreeDiff` (`diff(ctx, { ..., withStat: true, <mode> })`): omit a row iff
    `added===0 && deleted===0 && !binary && oldMode===newMode`. Pin that a blank-only
    `--ignore-blank-lines` file is name-status-PRESENT yet numstat-OMITTED (git's mode
    inconsistency, #BL1), and #BL-two yields name-status `g,h` but numstat `h` only.
    Compare to `git diff --numstat <mode>`.
  - **`--quiet`-equivalent exit:** `changes` non-empty ⇒ nonzero, for the blank-only case
    (#BL1 exits 1 though numstat/patch are empty). Compare to `git diff --quiet <mode>; echo $?`.
  - **reconstructed `git diff <mode>` patch bytes** equal live `git diff --no-ext-diff
    --no-color <mode>` AND a frozen golden under `test/integration/fixtures/diff-patch/`
    (empty body for the #BL1 blank-only file; #M1 ws-line-as-context-with-new-bytes).
- **Matrix coverage (cite the row id in each `it` title's Then or a comment):** W1, W3
  (`-w` vs `--ignore-space-at-eol` divergence), B-none/B-zero/B-amt/B-run/B-tab
  (`-b` amount-vs-presence), EOL1, CR1 (all four EOL-touching modes drop trailing CR) +
  CR-narrow, M1, D1, D2 (drop holds with no terminating LF), BL1, BL-two, BL2, BL-spaces,
  BL-combo, C1 (`-w -b` order-independence), C2.
- **Similarity invariant (§4, ADR-381) — REGRESSION GUARD:** build a rename whose dst
  differs from src only by leading whitespace; assert `diff(ctx, { detectRenames: true, ignoreWhitespace: 'all' })`
  yields the SAME rename pairing + similarity score as `diff(ctx, { detectRenames: true })`,
  and that both match `git diff -M -w --name-status` ≡ `git diff -M --name-status`
  (identical `R<nnn>` line). This pins that whitespace does NOT reach the similarity pipeline.
- **Frozen goldens:** create `test/integration/fixtures/diff-patch/whitespace-*.golden.patch`
  for each patch-byte assertion (generate from live git during first authoring, commit
  them). Follow the naming used by the recursive interop goldens.

### TDD steps

- RED: write the interop test (and extend `diff-reconstruct.ts` with the optional
  `PatchOptions` arg). With `git` present it fails until the goldens exist / the
  reconstruct mode is wired; capture live git output, write the goldens, re-run.
- GREEN: add the goldens; ensure `reconstructPatch` forwards the resolved mode. All matrix
  rows + the similarity invariant pass against live git AND the goldens.
- REFACTOR: factor a `assertModeParity(ctx, peer, mode, fixtureName)` helper inside the
  test for the repeated name-status/numstat/quiet/patch quadruple so each `it` is small.

### Gate
`npx vitest run test/integration/diff-whitespace-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/diff-whitespace-interop.test.ts test/integration/diff-reconstruct.ts`

### Commit
`test(diff): pin whitespace diff family against real git`

---

## Phase-boundary gate (after Slice 7)

`npm run validate` — must be green. (Then the prepush `check:doc-typedoc` verifies the
`reports/api.json` committed in Slice 6.)
