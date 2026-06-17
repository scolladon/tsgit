# Plan — int-config-valueless-refusal

> Source: design doc `docs/design/int-config-valueless-refusal.md` · ADRs `353, 354`
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices: coverage/interop/property tests fold
  into the implementation slice whose code they exercise.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

## Shape note (decisions locked — 4 slices)

Decisions are locked in ADRs 353/354 (design "Decisions (resolved)": 1=A `core.loosecompression`,
2=a `CONFIG_BAD_NUMERIC_VALUE { key, source, value, reason }`, 3=b honour on NodeCompressor,
4=b complete int parser, 5=b two ADRs / one PR, 6=b two-finder line-compare). The four slices below
ship that set verbatim; no deviation from the design's slice shape. Slices are sequential — they share
one working tree and build on each other (Slice 2 consumes Slice 1's `parseGitInt` + error; Slice 3
consumes Slice 1's error + guard infra; Slice 4 consumes Slice 2's `ParsedConfig.core.looseCompression`).

**Public-surface decisions (made up front):**
- Slice 1's `CONFIG_BAD_NUMERIC_VALUE` is a **public** discriminated-union member of `CommandError`
  (`CommandError` is re-exported from `src/domain/commands/index.ts` and appears in `reports/api.json`).
  It trips: the compiler exhaustiveness `never`-check in `src/domain/error.ts` render switch (caught by
  `check:types`); the `extractDetail` formatting `cases` table in `test/unit/domain/commands/error.test.ts`
  (NOT compiler-enforced — must be extended in-slice or it stays uncovered); and `reports/api.json`
  (prepush `check:doc-typedoc`). `parseGitInt` is **internal** (consumed only inside `src/`, barrelled
  through `config-read.ts`'s existing export style; not re-exported from any package entry).
- Slice 2's `ParsedConfig.core.looseCompression` is **public** (`ParsedConfig` appears in `reports/api.json`,
  20 occurrences). It trips `reports/api.json` (prepush `check:doc-typedoc`). `ParsedConfig` is NOT
  re-exported from `src/index*.ts`, so no package-entry barrel change.
- Slice 4's `Compressor.deflate` signature widening (`level?`) is an **internal** port change (`Compressor`
  is not re-exported from package entries). No api.json/barrel impact beyond the type itself; verify with
  the slice's own `check:types`.

## Slice 1 — faithful git int parser + CONFIG_BAD_NUMERIC_VALUE error

### Context

**Goal:** add the complete faithful git int parser `parseGitInt` and the new `CONFIG_BAD_NUMERIC_VALUE`
error variant/factory/render that it throws. No consumer yet — this slice is green standalone.

**Files + symbol name-paths to touch:**

- `src/domain/commands/error.ts`
  - Add a new union member to `export type CommandError` (the union runs lines 6–205; existing
    `CONFIG_MISSING_VALUE` member is at lines 130–135). New member (decision 2=a, exact field set):
    ```ts
    | {
        readonly code: 'CONFIG_BAD_NUMERIC_VALUE';
        readonly key: string;
        readonly source: string;
        readonly value: string;
        readonly reason: 'invalid unit' | 'out of range';
      }
    ```
    Note the INT shape has NO `line` field (distinct from `CONFIG_MISSING_VALUE`, which has `line`).
    `reason` is exactly the two-member union (decision 4=b): `'invalid unit'` and `'out of range'`. Do
    NOT add `'bad zlib compression level'` — that consumer-specific reason is the deferred follow-up,
    explicitly out of scope.
  - Add the factory next to `configMissingValue` (currently lines 464–465:
    `configMissingValue = (key, source, line) => new TsgitError({ code: 'CONFIG_MISSING_VALUE', key, source, line })`):
    ```ts
    export const configBadNumericValue = (
      key: string,
      source: string,
      value: string,
      reason: 'invalid unit' | 'out of range',
    ): TsgitError =>
      new TsgitError({ code: 'CONFIG_BAD_NUMERIC_VALUE', key, source, value, reason });
    ```
    (`TsgitError` is already imported in this file — `configMissingValue` uses it.)
- `src/domain/error.ts` — render arm. The render switch ends with a compiler exhaustiveness guard at
  lines 468–470: `default: { const _exhaustive: never = data; return String(_exhaustive); }`. Adding the
  union member WITHOUT a render arm fails `check:types` there. Add the arm next to `CONFIG_MISSING_VALUE`
  (currently lines 393–394: `case 'CONFIG_MISSING_VALUE': return \`missing value for '${data.key}' in file '${data.source}' at line ${data.line}\`;`).
  New arm (design "Int-typed valueless death shape" — file token UNquoted, no `at line`):
  ```ts
  case 'CONFIG_BAD_NUMERIC_VALUE':
    return `bad numeric config value '${data.value}' for '${data.key}' in file ${data.source}: ${data.reason}`;
  ```
- `src/application/primitives/config-read.ts` — add `parseGitInt` as a sibling of `parseGitBoolean`
  (currently lines 1207–1208: `parseGitBoolean = (value: string | null): boolean => value === null || TRUE_VALUES.has(value.toLowerCase())`).
  Import `configBadNumericValue` from `../../domain/commands/error.js` (verify the existing import path
  style in config-read.ts — other domain imports use `../../domain/...`). **Signature is the LOCKED design
  signature — value-only:**
  ```ts
  export const parseGitInt = (value: string | null): number => { ... }
  ```
  (Design "Design shape (resolved)": `parseGitInt(value: string | null): number` — returns a number on
  success, THROWS `CONFIG_BAD_NUMERIC_VALUE` on failure.) The `value: string | null` mirrors
  `parseGitBoolean`; on `null` it throws `invalid unit` with `value: ''`. Keep it a small pure function
  (<20 lines; extract a unit-scale helper if needed). Export it via the same `export const` style used for
  `parseGitBoolean`.

  **`key`/`source` on the thrown error — the design's resolution (read carefully — it removes the apparent
  signature gap):** the error variant has `key`/`source` fields, but `parseGitInt` is value-only and cannot
  know them. This is intentional and consistent because **`parseGitInt`'s throw is NEVER the surfaced
  refusal**: the only refusal a user sees is the *valueless* case, and that is built directly by the
  Slice-3 guard via `configBadNumericValue(found.key, found.source, '', 'invalid unit')` (the guard has
  `key`/`source` from `findFirstValuelessEntry`) WITHOUT calling `parseGitInt`. The *only* caller of
  `parseGitInt` is `applyCoreEntry` (Slice 2, merge-time), which is LENIENT on a thrown error
  (valued-invalid is out of scope) and catches-and-discards it. Therefore `parseGitInt` throws
  `configBadNumericValue('', '', value, reason)` with EMPTY `key`/`source` placeholders — they are never
  surfaced (always swallowed by the merge-time catch). Assert in the unit tests that the thrown error's
  `value` + `reason` + `code` are correct; do NOT assert `key`/`source` from `parseGitInt` (they are
  placeholder-empty by design — assert they equal `''` to pin the contract and kill the mutant).

**Faithful int grammar (design "Int parser semantics" + "Faithful int parser spec" — decision 4=b):**
- Trim leading whitespace (ASCII space/tab) only — git skips leading whitespace.
- Parse with strtoimax base-0 over the trimmed value: decimal, `0x`/`0X` hex, leading `+`/`-` sign.
- At most ONE trailing unit byte from `{k,K,m,M,g,G,t,T}` applying ×1024^n (k=1, m=2, g=3, t=4),
  case-insensitive. (Git accepts k/m/g/t; design names "single k/m/g/t unit ×1024^n".)
- ANY other trailing byte (multi-char like `1kb`, decimal like `1.5`, trailing whitespace like `5 `),
  or no digits consumed (incl. empty / valueless `''`) → throw `configBadNumericValue('', '', value, 'invalid unit')`
  (empty `key`/`source` placeholders — see the signature note above; `value` is the raw read string, `''` for null).
- Magnitude exceeding the signed 32-bit `int` range after scaling (`< -2147483648` or `> 2147483647`)
  → throw `configBadNumericValue('', '', value, 'out of range')`.
- Return the scaled number on success.
- Never return `NaN`, never throw an unstructured error (totality — property-tested below).

**Pinned grammar table the unit tests must reproduce** (design "Int parser semantics"):
`10→10`, `0x10→16`, `+5→5`, `-7→-7`, ` 5→5` (leading ws), `1k→1024`, `1K→1024`,
`5 →invalid unit`, `1kb→invalid unit`, `1.5→invalid unit`, `''→invalid unit`, and an out-of-range
magnitude → `out of range`.

**Out-of-range boundary — apparent contradiction in the design, resolve empirically (mandatory):** the
design's "Int parser semantics" table (`--type=int` accessor) shows `2g → 2147483648` exit 0 (valid), but
the "three distinct int error suffixes for core.loosecompression" table shows `2147483648 (≥ INT_MAX after
unit) → out of range` (exit 128). The two come from DIFFERENT git accessors (`git config --type=int`
generic vs the `core.loosecompression` operational read). The parser this slice ships is the GENERIC
faithful int parser (decision 4=b), so its boundary is `git_config_int`'s range, NOT `core.loosecompression`'s
consumer range. **Pin the exact boundary against real git in a mktemp throwaway before finalizing**: probe
`git config --type=int` on `2147483647`, `2147483648`, `2147483647k`, `2g`, and `0x7fffffff` — capture
which exit 0 vs which die `out of range`. Pin the unit-test boundary rows to whatever the GENERIC `--type=int`
accessor reports (that is what `parseGitInt` models). Never probe in the worktree; use `mktemp -d` with
scrubbed `GIT_*` + `GIT_CONFIG_NOSYSTEM=1` + isolated `HOME`. (The TIGHTER `core.loosecompression` range
is the deferred `bad zlib compression level` consumer check — out of scope here.)

**Error-assertion convention (mutation-resistant):** each failure-row test asserts the thrown error's
`.data` fields individually via try/catch — `data.code === 'CONFIG_BAD_NUMERIC_VALUE'`,
`data.value === '<row>'`, `data.reason === 'invalid unit'|'out of range'`, and `data.key === ''` /
`data.source === ''` (the placeholder contract — assert them to kill the mutant; the surfaced key/source
come from the Slice-3 guard, not the parser). Never bare `toThrow(TsgitError)`. Each guard branch
(unit-suffix accepted vs trailing-garbage rejected vs
no-digits/empty rejected vs out-of-range) gets an ISOLATED test so a single test triggering two conditions
can't hide a dead guard.

**Test files to create/extend:**
- New unit file `test/unit/application/primitives/parse-git-int.test.ts` (sibling of the config-read unit
  tests; `parseGitBoolean` has no standalone file, but `parseGitInt` warrants one given the grammar table).
  Drive the pinned grammar table + isolated failure-row tests.
- New property file `test/unit/application/primitives/config-int.properties.test.ts` (design "Property
  tests" — lenses 1 decode + 3 totality). Per-family arbitraries: reuse/extend
  `test/unit/application/primitives/arbitraries.ts` if it already holds number-grammar generators (it
  exists, 15.8K — CHECK it first; if no int-string arbitrary, add one there or inline a local arbitrary in
  the properties file). Three properties:
  - Decode round-trip (numRuns 200): arbitrary in-range integer `n` rendered as a faithful git int string
    (decimal, optionally `0x`-hex, optionally a k/m/g/t suffix with the value pre-scaled so `s` denotes
    `n`) → `parseGitInt(s, key, source) === n`. `Given an arbitrary integer string`.
  - Totality over the safe ASCII subset (numRuns 100): any ASCII string either returns a finite number OR
    throws a `TsgitError` whose `data.code === 'CONFIG_BAD_NUMERIC_VALUE'` — never `NaN`, never an
    unstructured throw.
  - Negative grammar (numRuns 50): a string with a trailing non-unit byte / multi-char unit / no digits
    throws `reason === 'invalid unit'`.
  - Never commit a seed; same Given/When/Then + AAA + `sut` conventions; additive (does not replace the
    example table).
- Extend `test/unit/domain/commands/error.test.ts`:
  - Add a `configBadNumericValue` helper describe (mirror `describe('Given the configMissingValue helper', ...)`
    at lines 1097–1110): construct `sut = configBadNumericValue('core.loosecompression', '/abs/.git/config', '', 'invalid unit')`,
    assert each `data` field (`code`, `key`, `source`, `value`, `reason`) individually after the
    `if (data.code !== 'CONFIG_BAD_NUMERIC_VALUE') return;` narrow.
  - Add a row to the `cases: ReadonlyArray<Case>` formatting table (lines 1116+; existing
    `CONFIG_MISSING_VALUE` row at 1347–1348). New row:
    ```ts
    [
      { code: 'CONFIG_BAD_NUMERIC_VALUE', key: 'core.loosecompression', source: '/repo/.git/config', value: '', reason: 'invalid unit' },
      "CONFIG_BAD_NUMERIC_VALUE: bad numeric config value '' for 'core.loosecompression' in file /repo/.git/config: invalid unit",
    ],
    ```
    (Confirm the table's expected-string prefix format `<CODE>: <message>` from the existing
    `CONFIG_MISSING_VALUE` row before pinning the literal.) Add a second row for `reason: 'out of range'`
    with a non-empty `value` to cover that arm.

**Pinned behaviour bytes this slice reproduces** (design authoritative single line):
`bad numeric config value '' for 'core.loosecompression' in file .git/config: invalid unit`
— the render arm produces everything after the `<CODE>: ` prefix; file token UNquoted; NO `at line`.

**Public-surface gate to pre-pay IN-slice:** regenerate `reports/api.json` (new public `CommandError`
member + new exported `configBadNumericValue` factory) via `npm run docs:json` and commit `reports/api.json`
in this slice. `check:doc-typedoc` (`git diff --exit-code -- reports/api.json`) is a PREPUSH gate, not a
validate gate — local validate stays green without it, but the push hook rejects a stale api.json. The
typedoc-id diff is large and normal.

**Coverage scope (project memory):** the vitest coverage `include` gates `src/domain/**`, `src/ports/**`,
`src/adapters/{node,memory}/**`, `src/operators/**` at 100% — so the error code/factory/render in
`src/domain/**` ARE under the 100% line/branch gate (every render arm + factory exercised). `parseGitInt`
lives in `src/application/**`, which is OUTSIDE the coverage `include` but IS mutated by Stryker against
the unit tests — so write exhaustive, mutation-resistant `parseGitInt` tests even though they don't move
the coverage number. Do NOT add coverage-suppression directives anywhere.

### TDD steps

1. RED — write `parse-git-int.test.ts` driving the pinned grammar table (decimal, hex, sign, leading ws,
   units k/K/m/M/g/G/t/T, and isolated failure rows `5 `/`1kb`/`1.5`/`''`→`invalid unit`, out-of-range→
   `out of range`). Fails: `parseGitInt` does not exist (import error / not exported).
2. RED — write `config-int.properties.test.ts` (decode round-trip, totality, negative grammar). Fails:
   same missing symbol.
3. RED — extend `error.test.ts` with the `configBadNumericValue` helper describe + the two `cases` rows.
   Fails: `configBadNumericValue` not exported and `CONFIG_BAD_NUMERIC_VALUE` not a known code (render
   returns the `never`-fallback string).
4. GREEN — add the `CONFIG_BAD_NUMERIC_VALUE` union member + `configBadNumericValue` factory in
   `src/domain/commands/error.ts`; add the render arm in `src/domain/error.ts`; add `parseGitInt` in
   `src/application/primitives/config-read.ts`. Resolve the out-of-range 32-bit boundary against a real-git
   mktemp probe.
5. GREEN — run the slice gate; iterate to green.
6. REFACTOR — extract a unit-scale helper if `parseGitInt` exceeds ~20 lines or nests >2; keep early
   returns; named constants for unit factors / INT_MAX bounds (no magic values).
7. Pre-pay surface gate — `npm run docs:json`; stage `reports/api.json`.

### Gate

`npx vitest run test/unit/application/primitives/parse-git-int.test.ts test/unit/application/primitives/config-int.properties.test.ts test/unit/domain/commands/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commands/error.ts src/domain/error.ts src/application/primitives/config-read.ts test/unit/application/primitives/parse-git-int.test.ts test/unit/application/primitives/config-int.properties.test.ts test/unit/domain/commands/error.test.ts`

Surface gate (prepush, pre-pay in-slice): `npm run docs:json` then `git diff --exit-code -- reports/api.json` must be clean after committing the regenerated `reports/api.json`.

### Commit

`feat(config): faithful git int parser`

## Slice 2 — parse core.loosecompression/compression into ParsedConfig

### Context

**Goal:** widen `ParsedConfig.core` with `looseCompression?: number`, populate it via `applyCoreEntry`
(NON-null → `parseGitInt`; precedence `loosecompression` > `compression`), keep the valueless (`null`)
case merging as absent (porcelain survival). No refusal here — refusal is Slice 3 on the eager gate.

**Files + symbol name-paths to touch (all in `src/application/primitives/config-read.ts` — verified line
ranges):**

- `ParsedConfig` interface (lines 9–46) — `core` object literal (lines 10–18) gains:
  `readonly looseCompression?: number;` (place after `sparseCheckoutCone`).
- `type MutableCore` (lines 933–941) — add `looseCompression?: number;`.
- `applyCoreEntry` (lines 948–965) — add the int branch. Current body BOOLEAN/string branches:
  `bare`, `logallrefupdates`, `sparsecheckout`, `sparsecheckoutcone` handle `null` (treat valueless as a
  value); then `if (value === null) return undefined;` (string fields skip null); then `excludesfile`,
  `attributesfile`, `hookspath`. The int keys are like the STRING fields — valueless merges as absent —
  so the int branch goes AFTER the `if (value === null) return undefined;` guard, alongside the string
  keys (decision: valueless int merges as absent, ADR-315 D4 unchanged; the refusal is NOT at merge
  time). Branch (value-only `parseGitInt`, LENIENT on throw — valued-invalid is out of scope, so a parse
  failure merges as absent, matching the design's "other int-ish keys stay unparsed (lenient)"):
  ```ts
  if (lowered === 'loosecompression' || lowered === 'compression') {
    let parsed: number;
    try {
      parsed = parseGitInt(value); // value is non-null here (past the `value === null` guard)
    } catch {
      return undefined; // valued-but-invalid int → treat as absent (out of scope; eager gate handles valueless)
    }
    if (lowered === 'compression' && /* loosecompression already won */ ...) return core;
    return { ...core, looseCompression: parsed, /* precedence flag */ };
  }
  ```
  (Swallowing the thrown error here is intentional and scoped — NOT a swallowed-error smell: the error is
  the lenient-by-design valued-invalid path the design explicitly defers; document the `// why` on the
  catch. The valueless refusal is surfaced by the Slice-3 guard, not here.)
  **Precedence subtlety (design "Valid-path consumed behaviour" pin: `loosecompression` > `compression`):**
  `core.loosecompression` must win regardless of file order. Two sub-cases to handle so BOTH orders pin
  correctly:
  - `loosecompression` seen → always set `looseCompression` (overrides any prior `compression`-derived value).
  - `compression` seen → set only if no `loosecompression` has been recorded yet AND must not later
    override when `loosecompression` appears.
    Because `applyCoreEntry` is fold-style (one entry at a time, no lookahead), track precedence with a
    discriminator: EITHER add a transient `MutableCore` field (e.g. `looseCompressionFromLoose?: boolean`)
    cleared in `finalizeCore`, OR record which source set the value. **Implementer chooses the minimal
    fold-safe mechanism** and pins it with the order-independent precedence unit tests below. The
    simplest correct fold: store the effective value plus a boolean "set by loosecompression"; when
    `loosecompression` arrives, always overwrite + set the flag; when `compression` arrives, overwrite
    only if the flag is false. Strip the flag in `finalizeCore`.
  - **Valued-invalid at merge time is LENIENT (no `source` threading needed):** because `parseGitInt` is
    value-only (Slice 1) and the merge-time caller catches-and-discards its throw (sketch above), a
    valued-but-invalid int (`core.loosecompression = abc`) merges as absent — the field is simply not set.
    This matches the design's "valued-but-invalid is out of scope" + "other int-ish keys stay unparsed
    (lenient)". `applyCoreEntry`'s signature is UNCHANGED (no `source` param). Confirm this does not
    regress porcelain (`config --list` must still print the raw value — `applyCoreEntry` only feeds
    `ParsedConfig`, never the porcelain token surface). Add a unit test: valued-invalid int → field absent,
    no throw at merge.
- `finalizeCore` (lines 1127–1152) — its parameter type literal (lines 1128–1138) and the returned
  spread object both enumerate every core field; add `looseCompression`:
  - parameter type: `looseCompression?: number;`
  - return spread: `...(core.looseCompression !== undefined ? { looseCompression: core.looseCompression } : {})`
  - If a transient precedence flag was added to `MutableCore`, `finalizeCore` is where it gets DROPPED
    (it already projects only the public fields — just don't copy the flag).
- `finalize` (lines 1154–1199) — its inline `out.core` shape literal (lines 1156–1164) enumerates the
  core fields; add `looseCompression?: number;` there too (this literal must structurally match
  `ParsedConfig['core']` or `out.core = core` assignment fails `check:types`).

**Test files to extend:** `test/unit/application/primitives/config-read.test.ts` (165K — the existing
`applyCoreEntry`/`ParsedConfig` example suite). Add a describe block mirroring the existing core-field
tests:
- valued `core.loosecompression = 9` → `parsed.core?.looseCompression === 9`.
- units: `core.loosecompression = 1k` → `1024` (proves `parseGitInt` is wired, not a raw parseInt).
- precedence both orders: `[core] loosecompression=1\n compression=9` → `1`; AND
  `[core] compression=9\n loosecompression=1` → `1` (loosecompression wins regardless of order).
- `compression` fallback: `[core] compression=9` (no loosecompression) → `looseCompression === 9`.
- absent: no `[core]` int key → `parsed.core?.looseCompression === undefined` (no field).
- valueless merges as absent: `[core] loosecompression\n` (valueless) → `looseCompression === undefined`,
  NO throw at parse/merge (porcelain survival — refusal lands in Slice 3).
- valued-invalid lenient: `[core] loosecompression = abc` → `looseCompression === undefined`, no throw.

**Pinned behaviour this slice reproduces** (design "Valid-path consumed behaviour" precedence table):
`loosecompression=1, compression=9 → 1`; `loosecompression=9, compression=1 → 9`;
`compression=9` (no loosecompression) → `9`. The bytes themselves (`78da`) are Slice 4's concern; this
slice only pins the parsed-field value + precedence.

**Public-surface gate to pre-pay IN-slice:** `ParsedConfig.core.looseCompression` is a new public field
(`ParsedConfig` appears in `reports/api.json`). Regenerate via `npm run docs:json` and commit
`reports/api.json` in this slice (prepush `check:doc-typedoc` gate; large typedoc-id diff is normal).

### TDD steps

1. RED — extend `config-read.test.ts` with the valued / units / precedence-both-orders / compression-
   fallback / absent / valueless-as-absent / valued-invalid-lenient cases. Fails: `looseCompression` is
   not a `ParsedConfig.core` field (type error in the test) and `applyCoreEntry` has no int branch.
2. GREEN — widen `ParsedConfig.core`, `MutableCore`, `finalizeCore` (param + spread), `finalize`'s
   `out.core` literal; add the `applyCoreEntry` int branch with order-independent precedence + lenient
   valued-invalid + valueless-as-absent.
3. GREEN — run the slice gate; iterate to green.
4. REFACTOR — keep the precedence mechanism minimal and fold-safe; ensure `finalizeCore` drops any
   transient flag; no magic values.
5. Pre-pay surface gate — `npm run docs:json`; stage `reports/api.json`.

### Gate

`npx vitest run test/unit/application/primitives/config-read.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts test/unit/application/primitives/config-read.test.ts`

Surface gate (prepush, pre-pay in-slice): `npm run docs:json` then `git diff --exit-code -- reports/api.json` clean after committing the regenerated `reports/api.json`.

### Commit

`feat(config): parse core.loosecompression/compression into ParsedConfig`

## Slice 3 — refuse valueless int core path on the operational surface

### Context

**Goal:** add the int sibling guard (throwing `CONFIG_BAD_NUMERIC_VALUE`) reusing `findFirstValuelessEntry`,
and wire it into the eager-broad `[core]` gate with cross-class file-line ordering vs the existing string
keys (decision 6=b: two `findFirstValuelessEntry` calls + `line` compare, throw the lower-line entry's
shape). Add the interop pins.

**Files + symbol name-paths to touch:**

- New guard file `src/application/primitives/internal/bad-numeric-config-guard.ts` (sibling of
  `valueless-config-guard.ts`). Mirror `valueless-config-guard.ts`'s `assertNoValuelessConfig`
  (lines 18–26):
  ```ts
  assertNoValuelessConfig = async (ctx, section, subsection, keys): Promise<void> => {
    const found = await findFirstValuelessEntry(ctx, section, subsection, keys);
    if (found !== undefined) throw configMissingValue(found.key, found.source, found.line);
  }
  ```
  The int sibling throws the INT shape instead (valueless → `value: ''`, `reason: 'invalid unit'`,
  NO `line`):
  ```ts
  export const assertNoBadNumericConfig = async (
    ctx: Context,
    section: string,
    subsection: string | undefined,
    keys: ReadonlyArray<string>,
  ): Promise<void> => {
    const found = await findFirstValuelessEntry(ctx, section, subsection, keys);
    if (found !== undefined) throw configBadNumericValue(found.key, found.source, '', 'invalid unit');
  }
  ```
  Imports: `findFirstValuelessEntry` from `../config-read.js` (same as the string guard — verify the exact
  relative path used by `valueless-config-guard.ts`); `configBadNumericValue` from
  `../../../domain/commands/error.js` (match the string guard's `configMissingValue` import path).
  `Context` type from the same place the string guard imports it.
- `src/application/primitives/internal/repo-state.ts` — rewire the eager gate. Current
  `assertNoValuelessCorePaths` (lines 40–42):
  ```ts
  assertNoValuelessCorePaths = async (ctx: Context): Promise<void> => {
    await assertNoValuelessConfig(ctx, 'core', undefined, ['excludesfile', 'attributesfile']);
  }
  ```
  Replace with the cross-class line-compare (decision 6=b). The int keys are `['loosecompression',
  'compression']`; the string keys stay `['excludesfile', 'attributesfile']`. Call
  `findFirstValuelessEntry` once per class, compare the two results' `line`, throw the LOWER-line entry's
  shape (string → `configMissingValue(...)` with `line`; int → `configBadNumericValue(..., '', 'invalid unit')`).
  Sketch:
  ```ts
  assertNoValuelessCorePaths = async (ctx: Context): Promise<void> => {
    const str = await findFirstValuelessEntry(ctx, 'core', undefined, ['excludesfile', 'attributesfile']);
    const num = await findFirstValuelessEntry(ctx, 'core', undefined, ['loosecompression', 'compression']);
    // throw the earlier-by-file-line entry with ITS shape; lines are distinct (different entries)
    if (str !== undefined && (num === undefined || str.line < num.line)) {
      throw configMissingValue(str.key, str.source, str.line);
    }
    if (num !== undefined) {
      throw configBadNumericValue(num.key, num.source, '', 'invalid unit');
    }
  }
  ```
  This keeps the eager gate's existing wiring (`assertOperationalRepository` lines 50–54 calls
  `assertNoValuelessCorePaths`, unchanged). Imports to add: `findFirstValuelessEntry`,
  `configMissingValue`, `configBadNumericValue` (the file currently imports `assertNoValuelessConfig`
  from `./valueless-config-guard.js`; you may keep using the new `assertNoBadNumericConfig` helper for the
  int-only paths elsewhere, but the cross-class ORDERING logic must live inline here since it spans both
  classes — the `assertNoValuelessConfig` indirection cannot do the line compare). **Decide in-slice:**
  either (a) inline both `findFirstValuelessEntry` calls in `assertNoValuelessCorePaths` (cleanest for the
  compare) and keep `assertNoBadNumericConfig` for unit-test coverage of the int-only guard in isolation,
  or (b) drop the separate guard file and inline only. The design's slice-3 description names a "new int
  guard (sibling of `valueless-config-guard.ts`)" — KEEP the guard file so the int refusal has its own
  reusable, unit-tested primitive (other int keys will reuse it per design out-of-scope), and inline the
  cross-class line compare in `repo-state.ts`.

**Tests — unit (`test/unit/application/commands/internal/repo-state.test.ts`, the existing suite; imports
from `commands/internal/repo-state.js` shim which re-exports the primitives file). Mirror the existing
cross-class describes (lines 484–531 show the string-only earlier/later ordering pattern with
`seedRepo`/`seedConfig`/`createMemoryContext`/`MissingValueData`):**

- valueless int alone (`[core]\n\tloosecompression\n`) via `assertOperationalRepository` →
  `CONFIG_BAD_NUMERIC_VALUE`, `key === 'core.loosecompression'`, `value === ''`, `reason === 'invalid unit'`,
  no `line` field. Add a `BadNumericData` interface mirroring `MissingValueData` (without `line`, with
  `value`/`reason`).
- valueless `core.compression` alone → same shape, `key === 'core.compression'`.
- valued int (`loosecompression = 9`) → no-op (no throw).
- absent int → no-op.
- cross-class ordering BOTH directions (the load-bearing decision-6 pins):
  - `[core]\n\texcludesfile\n\tloosecompression\n` (string earlier) → `CONFIG_MISSING_VALUE`,
    `key === 'core.excludesfile'`, `line === 2`.
  - `[core]\n\tloosecompression\n\texcludesfile\n` (int earlier) → `CONFIG_BAD_NUMERIC_VALUE`,
    `key === 'core.loosecompression'`, `value === ''`, `reason === 'invalid unit'`, no `line`.
- isolated guard test for `assertNoBadNumericConfig` (new file
  `test/unit/application/primitives/internal/bad-numeric-config-guard.test.ts`, or fold into repo-state
  test — prefer a dedicated file mirroring how the string guard is exercised): valueless → throw int
  shape; valued/absent → no-op. Each guard CONDITION isolated.
- porcelain-bypass at the unit layer: `configList`/`configGet` on the valueless int fixture do NOT invoke
  the eager gate (they succeed; the key stays `value: null`). This already holds because porcelain uses
  `assertRepository` not `assertOperationalRepository` — assert it explicitly to pin the split.

**Tests — interop (`test/integration/missing-value-refusal-interop.test.ts`, the 24.9l/24.9r structure).
Extend, do NOT create a new file (reuse the `describe.skipIf(!GIT_AVAILABLE)` block, `beforeEach`/
`afterEach` tmpdir lifecycle, `runGit`/`tryRunGit`/`runGitEnv`/`GIT_AVAILABLE` from `interop-helpers.ts`,
the `VALUELESS_*_FIXTURE` + `writeFile`-into-`.git/config` pattern, and the per-field `.data` assertion +
`expect(data.source).toMatch(/\/config$/)` normalization). Add fixtures:**

- `VALUELESS_LOOSECOMPRESSION_FIXTURE = '[core]\n\tloosecompression\n'` (or with a leading
  `repositoryformatversion = 0` line for realism — match the existing fixture style; the int shape has no
  `line` field so exact line position is irrelevant for this fixture).
- Cross-class fixtures with deterministic line positions for the ordering pins (design pinned lines):
  - order A (string then int): `[core]\n\texcludesfile\n\tloosecompression\n`
  - order B (int then string): `[core]\n\tloosecompression\n\texcludesfile\n`

Interop pins to add (design "Test strategy → Interop pins" 1,2,3,4,5,7,8 — pin 6 is Slice 4):

1. **git int-death pin** — write the valueless int fixture into a fresh repo's `.git/config`; run a pinned
   operational command (`git -C <dir> status` or `git -C <dir> add <new>`) via `tryRunGit`; assert
   `g.ok === false`, single-line stderr (`stderr` has no `error:` line — assert it does not match
   `/^error:/m`), contains `bad numeric config value ''`, `for 'core.loosecompression'`, `: invalid unit`,
   and does NOT contain `at line`. (Pin against git 2.54.0 stderr; exit 128.)
2. **tsgit structured pin** — same fixture; drive a `[core]`-gated operational command via the
   `openRepository` facade (`repo.status()` / `repo.log()` / `repo.add(...)` — use whichever the existing
   interop test already drives; the file already imports `openRepository` from `index.node.js`); try/catch
   + per-field `.data`: `code === 'CONFIG_BAD_NUMERIC_VALUE'`, `key === 'core.loosecompression'`,
   `value === ''`, `reason === 'invalid unit'`, `source` matches `/\/config$/`. Mutation-resistant
   per-field; never bare `toThrow`.
3. **single-line reconstruction** — reconstruct git's single line from tsgit's `{value,key,source,reason}`
   with the file-token normalization (UNquoted; reconstruct repo-relative `.git/config`) and assert byte
   equality against the captured git stderr line, INCLUDING the absence of `error:`/`at line`.
4. **shape-distinctness from `CONFIG_MISSING_VALUE`** — a sibling valueless STRING `[core]` key
   (`excludesfile`) on the same surface refuses `CONFIG_MISSING_VALUE` (two lines, quoted file, `at line`),
   while the int key refuses `CONFIG_BAD_NUMERIC_VALUE` (one line, unquoted file, no line). Assert both
   shapes coexist without bleeding.
5. **eager-broad breadth matrix** — with the valueless int fixture, assert MULTIPLE operational commands
   die in BOTH git and tsgit (at minimum `status`, `log`, and a ref-listing `branch`/`tag` — design's broad
   set), each with the right `{key,value,reason,source}`; and the config porcelain SURVIVES
   (`configList`/`configGet`/`configGetRegexp` exit-ok in tsgit; `git config --list`/`--get` exit-ok in
   git; the int key visible as `value: null` on tsgit's porcelain). `configGet`/`configList`/`configGetRegexp`
   are already imported in the interop file.
7. **absent-vs-valueless distinctness** — a `[core]` section with the int key ABSENT keeps the default (no
   refusal), proving the guard fires only on present-but-valueless.
8. **cross-class file-line ordering** — order A → git+tsgit report `core.excludesfile`
   (`CONFIG_MISSING_VALUE`, two-line); order B → git+tsgit report `core.loosecompression`
   (`CONFIG_BAD_NUMERIC_VALUE`, one-line). Assert tsgit's `.data.code`/`key` matches the earlier-by-line
   key in EACH order against real git's stderr.

Follow interop isolation (isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off, scrubbed `GIT_*` — all
inherited via `runGitEnv`/`SAFE_ENV`). Reuse a shared `beforeAll`/`beforeEach` repo where the matrix
allows (project memory: heavy git-spawning interop times out hooks under validate concurrency — keep the
new pins lean, share one fixture-write helper). Pin the peer git to `-c merge.conflictStyle=merge` is NOT
needed here (no merge markers), but DO confirm the ambient `core.loosecompression` death is not masked by
the user's global config — `GIT_CONFIG_NOSYSTEM=1` + isolated `HOME` in `SAFE_ENV` already handles it
(project memory: scrub global config in interop).

**Pinned behaviour bytes this slice reproduces** (design authoritative):
- int death single line: `fatal: bad numeric config value '' for 'core.loosecompression' in file .git/config: invalid unit` (exit 128, `grep -c '^error:'` = 0).
- order A reports `core.excludesfile` (string, two-line + `at line N`); order B reports
  `core.loosecompression` (int, one-line, no line). Both via `git_default_config` per-entry order.

**Public-surface gate:** none new in this slice (the error code + field landed in Slices 1–2; the guard is
internal). No api.json regen needed. Confirm with the slice's own `check:types`.

**Coverage scope (project memory):** the guard + the rewired `assertNoValuelessCorePaths` live in
`src/application/**`, OUTSIDE the vitest coverage `include` but mutated by Stryker — write exhaustive,
mutation-resistant unit tests for both ordering directions and each no-op branch even though they don't
move the coverage number. Each guard CONDITION isolated (per CLAUDE.md: `if (A || B)` style guards need a
test per condition). Never use coverage/mutation suppression directives.

### TDD steps

1. RED — unit: extend `repo-state.test.ts` with the int-alone, compression-alone, valued/absent no-op,
   and cross-class both-direction ordering tests + add `BadNumericData` interface. Add
   `bad-numeric-config-guard.test.ts` for the isolated guard. Fails: `assertNoBadNumericConfig` missing;
   `assertNoValuelessCorePaths` still string-only (int fixtures don't throw / throw the wrong shape).
2. RED — interop: add the int-death/structured/reconstruction/shape-distinctness/breadth/absent/ordering
   pins to `missing-value-refusal-interop.test.ts`. Fails: tsgit operational command does not refuse the
   valueless int (or refuses with the wrong code).
3. GREEN — create `bad-numeric-config-guard.ts`; rewire `assertNoValuelessCorePaths` with the cross-class
   line compare in `repo-state.ts`.
4. GREEN — run the slice gate (unit + interop); iterate to green.
5. REFACTOR — keep the line-compare guard ≤20 lines with early returns; extract a small helper if the
   two-class compare reads awkwardly; no nesting >2.

### Gate

`npx vitest run test/unit/application/commands/internal/repo-state.test.ts test/unit/application/primitives/internal/bad-numeric-config-guard.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/bad-numeric-config-guard.ts src/application/primitives/internal/repo-state.ts test/unit/application/commands/internal/repo-state.test.ts test/unit/application/primitives/internal/bad-numeric-config-guard.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit

`feat(config): refuse valueless int core path on the operational surface`

## Slice 4 — honour core.loosecompression at loose-object write

### Context

**Goal:** widen the `Compressor` port `deflate(data, level?)`, honour the level on `NodeCompressor`
(`deflateSync(data, { level })`), accept+ignore on memory/browser (Web `CompressionStream` has no level),
and pass `config.core?.looseCompression` from `write-object.ts` ONLY when the value is in zlib's `-1..9`
domain (else omit → adapter default — the deferred-refusal safety guard). `build-pack.ts` stays no-level.

**Files + symbol name-paths to touch:**

- `src/ports/compressor.ts` (interface `Compressor`, line 8; `deflate` line 9–10) — widen:
  ```ts
  /** Deflate (compress) data using zlib deflate format (RFC 1950).
   *  `level` (when given and in zlib's -1..9 domain) tunes the compression
   *  level; adapters that cannot set a level accept and ignore it. */
  readonly deflate: (data: Uint8Array, level?: number) => Promise<Uint8Array>;
  ```
- `src/adapters/node/node-compressor.ts` (`deflate` arrow, lines 28–34) — honour:
  ```ts
  deflate = async (data: Uint8Array, level?: number): Promise<Uint8Array> => {
    try {
      return new Uint8Array(level === undefined ? deflateSync(data) : deflateSync(data, { level }));
    } catch (err) {
      throw compressFailed(describeError(err));
    }
  };
  ```
  (`deflateSync` is already imported from `node:zlib`.) Note `node:zlib` `deflateSync` accepts a
  `ZlibOptions` second arg with `level`; passing `level` only when defined avoids re-deriving the default.
- `src/adapters/memory/memory-compressor.ts` (`deflate` arrow, lines 18–24) — accept + ignore:
  ```ts
  deflate = async (data: Uint8Array, _level?: number): Promise<Uint8Array> => { ... unchanged body ... }
  ```
  (Web `CompressionStream('deflate')` has no level param; the `_level` is accepted to satisfy the port and
  documented as ignored.) Add a one-line `// why` comment: CompressionStream exposes no level; loose disk
  bytes are out of the faithfulness contract (equivalence-under-readback).
- `src/adapters/browser/browser-compressor.ts` (`deflate` METHOD, lines 13–22 — note this adapter uses
  method-shorthand, NOT an arrow property like node/memory) — accept + ignore:
  ```ts
  async deflate(data: Uint8Array, _level?: number): Promise<Uint8Array> { ... unchanged body ... }
  ```
  Same `// why` comment. **Coverage note:** `src/adapters/browser/**` is OUTSIDE the vitest coverage
  `include` (vitest.config.ts covers `domain`, `ports`, `adapters/node`, `adapters/memory`, `operators`).
  The browser adapter is exercised only by `test/browser/` (Playwright e2e) — NO vitest unit test for it.
  This change is type-checked (`check:types`) and behaviourally a no-op (ignored param); do NOT add a
  `browser-compressor.test.ts` (none exists). It IS still mutated by Stryker against whatever exercises it.
- `src/application/primitives/write-object.ts` (`writeObject`, lines 20–46; deflate call at line 35:
  `const compressed = await ctx.compressor.deflate(bytes);`) — read the config level and pass it ONLY when
  in zlib's valid domain. **Config-access pattern (verified):** primitives read config via
  `readConfig(ctx)` from `./config-read.js` — exactly how `src/application/primitives/run-hook.ts` (line 67:
  `const config = await readConfig(ctx)`, line 70 reads `config.core?.hooksPath`) does it. Add the import
  `import { readConfig } from './config-read.js';` and:
  ```ts
  const config = await readConfig(ctx);
  const level = config.core?.looseCompression;
  const compressed =
    level !== undefined && level >= -1 && level <= 9
      ? await ctx.compressor.deflate(bytes, level)
      : await ctx.compressor.deflate(bytes);
  ```
  Use named constants for the zlib domain bounds (`ZLIB_MIN_LEVEL = -1`, `ZLIB_MAX_LEVEL = 9`) — no magic
  values. **Deferred-refusal safety guard (load-bearing, ADR-353):** a valid 32-bit int OUTSIDE `-1..9`
  (e.g. `99`) must NOT reach `deflateSync` (Node throws `ERR_OUT_OF_RANGE`) — the `>= -1 && <= 9` check
  falls back to the adapter default instead. This is a documented under-refusal (git dies on `=99`; tsgit
  uses the default); the faithful death is the deferred `bad zlib compression level` follow-up.
  - **`build-pack.ts` stays no-level** — its deflate call (`src/application/primitives/build-pack.ts` line
    56: `const compressedData = await ctx.compressor.deflate(content);`) must NOT pass `looseCompression`
    (git's pack path uses `pack.compression`, a different key). Leave it unchanged; add a negative unit
    test below proving the loose level does not change pack bytes.

**Tests:**

- Unit `test/unit/adapters/node/node-compressor.test.ts` (the existing NodeCompressor suite — verified to
  exist): `deflate(data, 9)` produces zlib header `78da`; `deflate(data, 0)` → `7801`; `deflate(data, -1)`
  → `789c` (default); `deflate(data)` (no level) → the existing default header (`789c` = level 6). Assert
  the first two header bytes (`Uint8Array` slice) — these are the pinned zlib headers. NodeCompressor is
  under the 100% coverage gate, so the `level === undefined ? deflateSync(data) : deflateSync(data, { level })`
  branch needs BOTH arms exercised (a level-given test AND a no-level test).
- Unit `test/unit/adapters/memory/memory-compressor.test.ts` (verified to exist): `deflate(data, 9)`
  returns valid deflate output readable back by `inflate` (equivalence-under-readback) and IGNORES the
  level (output equals `deflate(data)`). Behaviour test, not a byte-pin. MemoryCompressor is under the
  coverage gate; the existing roundtrip already covers the line, but add an explicit accept+ignore test.
- (No browser-compressor unit test — `src/adapters/browser/**` is coverage-excluded and e2e-only; see the
  browser-compressor context note above.)
- Optionally extend the shared `test/unit/ports/compressor.contract.ts` with a `level`-accepting roundtrip
  assertion (it is imported by both the node and memory suites via `compressorContractTests(createSut)`),
  so accept+ignore is asserted once across both adapters. Keep this additive.
- Unit `test/unit/application/primitives/write-object.test.ts` (verified to exist):
  - in-range level threads: with `core.loosecompression = 9` in config, `writeObject` calls
    `deflate(bytes, 9)` (spy/mock the compressor) — assert the level argument; on a real NodeCompressor the
    loose file's zlib header is `78da`.
  - absent: no config level → `deflate(bytes)` (no level arg) → default header.
  - out-of-range valid int safety guard: `core.loosecompression = 99` → `writeObject` does NOT crash and
    calls `deflate(bytes)` with NO level (default) — the documented under-refusal. (Pin via the spy: no
    second arg, or argument `undefined`.)
- Negative unit for build-pack: `build-pack` deflate is unaffected by `core.loosecompression` (the pack
  bytes do not change when the loose level is set) — assert via the build-pack test suite (locate it) or a
  focused spy that build-pack calls `deflate(content)` with no level.
- Interop pin 6 (design "Valid-path consumed behaviour") in
  `test/integration/loose-object-interop.test.ts` (the existing equivalence-under-readback suite; uses
  `makePeerPair`/`initBothRepos`/`runGit`/`writeObject`) OR extend
  `missing-value-refusal-interop.test.ts` — prefer `loose-object-interop.test.ts` since it already pins
  the loose-write contract:
  - write a valid `core.loosecompression = 9` into the repo config; write a loose object via tsgit
    (`writeObject`) on NodeCompressor; assert the loose file's zlib header is `78da` (matching git's pinned
    `78da` for level 9) AND the object is readable cross-tool (`git cat-file -p` reads the payload, SHA
    matches — equivalence-under-readback, the existing contract).
  - absent case → default header (no level set), still readable.

**Pinned behaviour bytes this slice reproduces** (design "Valid-path consumed behaviour" + zlib headers):
- `loosecompression=9` → loose zlib header `78da` (level 9) on NodeCompressor; matches git.
- `loosecompression=0` → `7801`; `-1` → `789c`; absent → adapter default (Node `789c` level 6).
- equivalence-under-readback preserved on ALL adapters (memory/browser ignore level but stay readable).
- `loosecompression=99` (out of zlib domain) → no crash, default level (under-refusal).

**Public-surface gate:** `Compressor.deflate`'s widened signature is an internal port type (not re-exported
from package entries). Verify no api.json drift with the slice's own `check:types` + a `git diff
reports/api.json` sanity check; if the port type IS captured by typedoc and drifts, regenerate
`reports/api.json` via `npm run docs:json` and commit it in-slice (treat as a possible prepush gate —
confirm by running `npm run docs:json` and checking `git diff reports/api.json`).

### TDD steps

1. RED — node-compressor test: `deflate(data, 9/0/-1)` header pins. Fails: `deflate` ignores a second arg.
2. RED — memory/browser compressor tests: accept+ignore `level` (readback equivalence). Fails: arity /
   signature.
3. RED — write-object test: in-range threads `deflate(bytes, 9)`; absent → no level; out-of-range `99` →
   default, no crash. Fails: `writeObject` does not read config / does not pass a level.
4. RED — build-pack negative test: loose level does not change pack bytes. Fails only if a naive impl
   wires the loose level into build-pack (guards against that).
5. RED — interop pin 6: tsgit loose header `78da` for `loosecompression=9`, readable by git. Fails:
   default level produced.
6. GREEN — widen `Compressor.deflate`; honour on NodeCompressor; accept+ignore on memory/browser; wire
   the domain-guarded level into `write-object.ts`; leave `build-pack.ts` no-level.
7. GREEN — run the slice gate (unit + interop); iterate to green.
8. REFACTOR — named constants for the zlib `-1..9` bounds; keep the level-selection branch flat (early
   ternary, no nesting >2); one-line `// why` comments on the accept+ignore adapters.

### Gate

`npx vitest run test/unit/adapters/node/node-compressor.test.ts test/unit/adapters/memory/memory-compressor.test.ts test/unit/ports/compressor.contract.ts test/unit/application/primitives/write-object.test.ts test/unit/application/primitives/build-pack.test.ts test/integration/loose-object-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/compressor.ts src/adapters/node/node-compressor.ts src/adapters/memory/memory-compressor.ts src/adapters/browser/browser-compressor.ts src/application/primitives/write-object.ts test/unit/adapters/node/node-compressor.test.ts test/unit/adapters/memory/memory-compressor.test.ts test/unit/ports/compressor.contract.ts test/unit/application/primitives/write-object.test.ts test/unit/application/primitives/build-pack.test.ts test/integration/loose-object-interop.test.ts`

(`compressor.contract.ts` is an importable helper, not a standalone test file — running it directly is a
no-op describe; it executes via the node/memory suites that import it. Keep it in the biome list because
it is a touched file if you extend it; it can be dropped from the `vitest run` list. Browser adapter has
no unit test — covered by `check:types` + e2e.)

Surface gate (verify, not assumed): `npm run docs:json` then `git diff reports/api.json` — if the widened
`Compressor.deflate` drifts api.json, commit the regenerated file in-slice.

### Commit

`feat(config): honour core.loosecompression at loose-object write`
