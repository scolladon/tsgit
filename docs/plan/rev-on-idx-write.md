# Plan — write the pack reverse index (`.rev`) beside every `.idx`

> Source: design doc `docs/design/rev-on-idx-write.md` · ADRs `624–632`
> Backlog **28.4** · git pinned **2.55.0**, darwin 25.5.0
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.

## Reading order for every part agent

1. `docs/design/rev-on-idx-write.md` — Pins A–L are the **behavioural contract**; §D1–§D14 are
   the shape. Do not re-derive a pin; do not re-litigate a decision.
2. The ADRs your part names. `627` is the only ratified-deviation one and the only one whose
   grammar paragraph the design corrects (see the design's "Revision note").
3. `CLAUDE.md` (git-faithfulness prime directive, structured-data-only, test conventions) and
   `.claude/workflow/surface-gates.md`.

## Cross-cutting rules that bind every part

- **Test conventions.** `describe('Given <context>')` > `describe('When <action>')` >
  `it('Then <expected>')`; AAA section comments in the body; the system under test is bound to
  `sut` (the *function*, never its result). 100 % line/branch/function/statement on
  `src/domain/**` and adapters.
- **Mutation-resistant assertions.** Never `toThrow(SomeError)` alone — use `try`/`catch` and
  assert `err.data.code` plus the payload fields (`key`, `value`, `source`, `check`, `reason`).
  Guard clauses with `||` get one isolated test per disjunct.
- **No provenance refs in code.** No `§D6a`, `ADR-627`, `Pin K`, `28.4` inside `src/` or `test/`.
  Explain the *behaviour* ("git narrows the boolean path to a C int"), never the document.
- **No suppression directives** (`@ts-ignore`, `v8 ignore`, `biome-ignore`, `stryker-disable`
  except a *freshly re-proven* equivalent-mutant note). No swallowed errors, no bare `catch`.
- **Serena is already activated** — use `find_symbol` / `replace_symbol_body` /
  `find_referencing_symbols` / `replace_content` as the default editors; `get_diagnostics_for_file`
  after each source edit. Diagnostics are advisory; `npm run check:types` is ground truth.
- **Never commit on a red gate. Never `--no-verify`.**
- Existing suites **will** go red in Parts 1–3. A test asserting a malformed boolean coerces to
  `false` encodes the divergence being removed — re-point it at the new verdict. A test that merely
  *uses* a sloppy value incidentally gets a valid value instead. Neither is a reason to weaken a gate.

## Public-surface decisions (made here, not deferred)

| new symbol | verdict | gates the owning part must pre-pay |
|---|---|---|
| `CONFIG_BAD_BOOLEAN_VALUE`, `CONFIG_BAD_BOOLEAN_LITERAL` (error codes) | **public** | union member in `src/domain/commands/error.ts`; message arm in `src/domain/error.ts`; case labels in `test/unit/domain/exhaustiveness.ts`; `reports/api.json` regenerated (`npm run docs:json`) — Part 1 |
| `configBadBooleanValue`, `configBadBooleanLiteral` (factories) | **internal** | none — sibling factories (`configBadNumericValue`) do not appear in `reports/api.json` (verified: 0 hits) |
| `serializePackRevIndex` | **public** | barrel `src/domain/storage/index.ts`; `reports/api.json`; `check:exports` / `check:size` / `check:tarball` stay green — Part 4 |
| `ParsedConfig.pack.writeReverseIndex` | **public** (`ParsedConfig` is barrel-exported from `src/application/primitives/index.ts:13`) | `reports/api.json` — Part 5 |
| `sortPackIndexEntries`, `SortedEntry` (`domain/storage/pack-order.ts`) | **internal** | ADR-625 + design §D3: deliberately **not** added to `src/domain/storage/index.ts` |
| `parseGitBoolean` (module export from `config-read.ts`) | **internal** | not added to `src/application/primitives/index.ts` — mirrors `parseGitInt`, which is exported from the module and absent from the barrel |
| `findFirstInvalidBoolean`, `findFirstInvalidBooleanInSection`, `InvalidBooleanEntry` | **internal** | mirrors `findFirstInvalidCompression` (module export, not barrelled), **not** `findFirstValuelessEntry` (which is barrelled) |
| `assertValidBooleanConfig` & siblings (`internal/boolean-config-guard.ts`) | **internal** | under `internal/`, never barrelled |
| `buildRev`, `WritePackArtifactsInput` (`internal/write-pack-artifacts.ts`) | **internal** | under `internal/`, never barrelled |

`reports/api.json` staleness is a **prepush** gate (`check:doc-typedoc`), not a `validate` gate —
local `validate` can be green while the push hook rejects. Regenerate and commit it in the same
part that adds the export.

## Two placement calls the design left open (decided here)

1. **Where the shared sort lives** — design §D3 offers `pack-writer.ts` or a new leaf. Chosen:
   **`src/domain/storage/pack-order.ts`**, the leaf. It keeps `rev-index.ts` (a parser-bearing
   file that will also carry the `@writes` block) from importing a `@writes`-annotated module, and
   every other `domain/storage` module already has a 1:1 sibling test file.
2. **Where the boolean guards live** — design §D6a calls them "the exact sibling of
   `assertNoValuelessConfig`". Chosen: a **new** `src/application/primitives/internal/boolean-config-guard.ts`.
   Putting them in `valueless-config-guard.ts` would make that filename lie about half its contents.

## Sizing rules

- Every part costs a full agent lifecycle — it must earn it. No standalone test-only parts for
  FEATURE code: coverage/interop/property tests fold into the part whose code they exercise.
  Part 6 is the one blessed exception: a cross-tool interop suite with **no `src/` delta**, which
  has no implementation part to fold into (ADR-629 makes it its own file, and it must land after
  the write path exists to have anything to compare).
- Parts are sequential and share one working tree; each builds on the previous one's committed state.

---

## Part 1 — Strict git boolean grammar and the two refusal error codes

### Context

**Implements:** design §D6a ("The parse", "The error", "Finding the offender"), Pins K1–K5,
requirements 14/15/18 · **ADR-627** (read the design's "Revision note" first: the ADR's own
numeric sketch is wrong; Pin K is authoritative).

**What this part does NOT do:** it does not make anything refuse. No gate is placed. After this
part a malformed boolean leaves its `ParsedConfig` field **absent** instead of `false`; the
refusal machinery exists and is unit-tested, but nothing calls it yet. Placement is Parts 2–3.

#### Files and exact current shapes

**`src/application/primitives/config-read.ts`** (1712 lines)

- L1622, the function being replaced:
  ```ts
  const TRUE_VALUES = new Set(['true', 'yes', 'on', '1']);
  const parseGitBoolean = (value: string | null): boolean =>
    value === null || TRUE_VALUES.has(value.toLowerCase());
  ```
- L1690 `export const parseGitInt = (value: string | null): GitIntResult` — returns
  `{ ok: true; value: number } | { ok: false; reason: 'invalid unit' | 'out of range' }`. It
  implements the **64-bit** grammar (`GIT_INT_MAX = 9223372036854775807n`, `GIT_INT_MIN`,
  `UNIT_SCALE` k/K/m/M/g/G, `MAX_SIGNIFICANT_DIGITS = 32`, `matchDigits` radix auto-detect).
  **Reuse it for tokenisation; apply the `int32` range on top** — Pin K4 is the trap.
- The **eleven** `parseGitBoolean` call sites, all in this file:

  | line | site | field |
  |---|---|---|
  | 1134 | `applyCoreEntry` | `core.bare` |
  | 1137 | `applyCoreEntry` | `core.sparseCheckout` |
  | 1139 | `applyCoreEntry` | `core.sparseCheckoutCone` |
  | 1167 | `parseLogAllRefUpdates` | `core.logAllRefUpdates` (`boolean \| 'always'`) |
  | 1210 | `applyRemoteEntry` | `remote.<n>.promisor` |
  | 1282 | `mergeSubmodule` | `submodule.<n>.active` |
  | 1326 | `mergeDiffDriver` | `diff.<d>.cachetextconv` |
  | 1337 | `applyFilterEntry` | `filter.<d>.required` |
  | 1376 | `mergeCommit` | `commit.gpgSign` |
  | 1384 | `mergeTag` | `tag.gpgSign` |
  | 1392 | `parsePushGpgSign` | `push.gpgSign` (`'true' \| 'false' \| 'if-asked'`) |

- The finder family to mirror: `findFirstValuelessEntry` (L196), `findFirstValuelessInSection`
  (L238, has the `requireSubsection` option and the subsection-verbatim qualified-key builder),
  `findFirstInvalidCompression` (L299 — **the structural twin**: walks `readConfigEntry(ctx)`'s
  cached tokens, matches `[core]` subsectionless, runs `parseGitInt`, returns
  `{ key, source, line, failure }` for the first failing entry).
- `matchesSection(tokenSection, tokenSubsection, section, subsection)` at L179 — reuse.
- `readConfigEntry(ctx)` (L133) returns `{ parsed, tokens, source }`, memoised per `Context`.
  The finders consume `tokens`/`source`, never re-read the file.
- `ConfigToken` entry shape: `{ kind: 'entry'; key: string; value: string | null; startLine: number }`
  (`line` reported as `startLine + 1`).

**`src/domain/commands/error.ts`** (826 lines)

- `CONFIG_BAD_NUMERIC_VALUE` variant at L151–156 — the model:
  ```ts
  | {
      readonly code: 'CONFIG_BAD_NUMERIC_VALUE';
      readonly key: string;
      readonly source: string;
      readonly value: string;
      readonly reason: 'invalid unit' | 'out of range';
    }
  ```
- `configBadNumericValue` factory at L551–563 — runs `value` through `sanitizeForDisplay`
  (defined L270, also aliased `export const sanitize` at L283).
- `configMissingValue` at L532.

**`src/domain/error.ts`** — message arms at L429–436; add beside `CONFIG_BAD_NUMERIC_VALUE` (L433).

**`test/unit/domain/exhaustiveness.ts`** — the shared `assertExhaustiveSwitch(data)` over
`TsgitErrorData`; `CONFIG_BAD_NUMERIC_VALUE` is at L149. Two new case labels go beside it, or
`check:types` fails on the `never` default arm.

#### Symbols to add

```ts
// config-read.ts — module-private type, module export for the function
type GitBooleanResult =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false };

// git's boolean path narrows to a C int; its --type=int path keeps the full
// 64-bit range, which is why parseGitInt's bounds cannot be reused here.
const GIT_BOOL_INT_MAX = 2_147_483_647;
const GIT_BOOL_INT_MIN = -2_147_483_648;

export const parseGitBoolean = (value: string | null): GitBooleanResult
export interface InvalidBooleanEntry {
  readonly key: string;
  readonly source: string;
  readonly line: number;
  readonly value: string;
}
export const findFirstInvalidBoolean = (
  ctx: Context, section: string, subsection: string | undefined, keys: ReadonlyArray<string>,
): Promise<InvalidBooleanEntry | undefined>
export const findFirstInvalidBooleanInSection = (
  ctx: Context, section: string, keys: ReadonlyArray<string>,
): Promise<InvalidBooleanEntry | undefined>
```

Arm order in `parseGitBoolean` is Pin K's, exactly:
1. `value === null` ⇒ `{ ok: true, value: true }` (valueless key — git's internal NULL).
2. `value === ''` ⇒ `{ ok: true, value: false }`.
3. case-insensitive match against two frozen word sets — `true`/`yes`/`on` and `false`/`no`/`off`.
   **`1` and `0` are NOT words here** — they fall to arm 4 and land on the same verdict by
   arithmetic, which is what makes `2`, `007` and `0x1` come out right.
4. `parseGitInt(value)`; on `ok`, refuse when the value is outside
   `[GIT_BOOL_INT_MIN, GIT_BOOL_INT_MAX]`, else `{ ok: true, value: value !== 0 }`; on `!ok`,
   `{ ok: false }`.

Merger migration: every one of the eleven sites becomes "parse, and on `{ ok: false }` leave the
field **absent**" — never guess a default. The refusal is raised by the guards (Parts 2–3), never
by a merger: a merger runs for every key on every `readConfig`, so raising there would make every
key Tier-1 and `git config --list` would die on a bad `core.sparseCheckout`, which git survives.
`parseLogAllRefUpdates` keeps its `'always'` pre-check ahead of the boolean parse;
`parsePushGpgSign` keeps its `'if-asked'` pre-check.

`findFirstInvalidBoolean*` return the **first failing entry by config-file line**, with the
qualified key built exactly as `findFirstValuelessEntry` builds it: section and variable
lower-cased, **subsection verbatim** (`core.bare`, `core.sparsecheckout`, `submodule.sm.active`,
`diff.d.cachetextconv`). `value` is the raw post-tokenizer string. Valid, absent and
out-of-section entries all return `undefined` — that totality is what lets a Tier-3 guard sit on
the success path in Part 5.

#### Error factories

```ts
export const configBadBooleanValue = (key: string, source: string, value: string): TsgitError
export const configBadBooleanLiteral = (key: string, source: string, value: string): TsgitError
```
Both route `value` through `sanitizeForDisplay` — this is the first genuinely attacker-influenceable
text field in the change, and a raw control character must not break a consumer's log line.
Two codes, not one with a flag: `push.gpgSign` is the only key whose git message differs
(`error: invalid value for 'push.gpgsign'` vs `fatal: bad boolean config value '<v>' for '<k>'`),
and a separate discriminant is how the structured-data-only rule expresses that — the library
renders neither line.

Message arms in `src/domain/error.ts` (these strings are the library's own diagnostics, not a
faithfulness contract — the interop tests reconstruct git's line from the fields):
```
CONFIG_BAD_BOOLEAN_VALUE   → `bad boolean config value '${data.value}' for '${data.key}' in file ${data.source}`
CONFIG_BAD_BOOLEAN_LITERAL → `invalid value for '${data.key}' in file ${data.source}`
```

#### Tests to extend

- `test/unit/application/primitives/config-read.test.ts` — existing style is
  `describe('Given a config with a [core] bare value')` > `describe('When readConfig')` >
  `it('Then …')`.
- `test/unit/application/primitives/config-read.properties.test.ts` — `fast-check` is already
  imported; existing describes read `Given an arbitrary …`; `numRuns` is passed explicitly.
- `test/unit/domain/commands/error.test.ts` — already asserts `CONFIG_BAD_NUMERIC_VALUE`.

### TDD steps

**RED 1 — the word arm and the presence arm.** In `config-read.test.ts`, a table-driven sweep over
`parseGitBoolean`: `true`/`TRUE`/`TrUe`/`yes`/`Yes`/`yEs`/`on`/`ON` ⇒ `{ok:true,value:true}`;
`false`/`FALSE`/`no`/`No`/`off`/`OFF`/`oFf` ⇒ `{ok:true,value:false}`; `null` ⇒ true;
`''` ⇒ false; `' '` (one space) ⇒ `{ok:false}`.
*Fails:* `parseGitBoolean` returns a bare `boolean`, so `.ok` is `undefined` — type error and
assertion failure.

**RED 2 — the integer arm, one case per Pin K3 row, none skipped.**
true: `1`, `2`, `-1`, `+1`, `007`, `0x1`, `0x7fffffff`, `1k`, `1K`, `1m`, `1M`, `1g`, `1G`,
`2147483647`, `-2147483648`.
false: `0`, `00`, `0x0`, `0k`.
refuse: `2147483648`, `-2147483649`, `0x80000000`, `2g`, `maybe`, `truthy`, `1.0`.
The four **boundary pairs** are the mutation-critical assertions —
`2147483647` accepted vs `2147483648` refused, `-2147483648` accepted vs `-2147483649` refused —
they are what kills an off-by-one on the range check. `0x80000000` and `2g` prove the check runs on
the **scaled, radix-resolved** value and not on the source text.
*Fails:* today every one of these is `false` with no `ok` discriminant.

**RED 3 — the two error factories.** In `test/unit/domain/commands/error.test.ts`: each factory
produces its own `code`, carries `key`/`source`/`value`, and **sanitises** `value` (feed a control
character, assert it does not survive verbatim). Assert via `try`/`catch` on `.data`, never
`toThrow(TsgitError)`.
*Fails:* the factories do not exist.

**RED 4 — `findFirstInvalidBoolean` and its wildcard sibling.** Fixtures written as raw config text
so line numbers are controlled (git's CLI cannot emit a valueless entry, and the finders key on
`line`):
- two malformed keys under `[core]` ⇒ the **lower-line** one is returned;
- a malformed key under `[core]` when the caller asked for `[commit]` ⇒ `undefined`;
- a valid value, and an absent key ⇒ `undefined` (both, separately — this totality is load-bearing);
- `findFirstInvalidBooleanInSection(ctx, 'diff', ['cachetextconv'])` over
  `[diff "a"]` + `[diff "b"]` ⇒ the lower-line entry, with the qualified key
  `diff.b.cachetextconv` keeping the subsection **verbatim** while section and variable lower-case
  (use a mixed-case subsection such as `[diff "MyDriver"]` so a `toLowerCase()` mutant on the
  subsection dies).
*Fails:* the finders do not exist.

**RED 5 — merger absence.** `readConfig` over `[core]\n\tbare = maybe\n` ⇒ `config.core?.bare` is
`undefined` (**not** `false`); over `[core]\n\tbare = 2\n` ⇒ `true`; over
`[push]\n\tgpgSign = maybe\n` ⇒ `config.push?.gpgSign` is `undefined`; over
`[core]\n\tlogAllRefUpdates = maybe\n` ⇒ `undefined` while `= always` still yields `'always'`.
*Fails:* today all of these are `false` / `'false'`.

**RED 6 — properties** (`config-read.properties.test.ts`):
- *totality* — `Given an arbitrary ASCII string without NUL (and `null`)` / `When parseGitBoolean
  classifies it` / `Then it returns a result and never throws`, `numRuns: 100`.
- *the integer arm* — `Given an arbitrary integer in [-2147483648, 2147483647] rendered in decimal,
  octal or hex, with an optional sign and an optional in-range unit factor` / `When parseGitBoolean
  parses the rendering` / `Then it is ok and its value is n !== 0`, `numRuns: 100`. The oracle is
  arithmetic (`n !== 0`), not a re-implementation of the parse — that is what makes it a property
  and not a tautology.
*Fails:* no result union.

**GREEN.** Implement `parseGitBoolean`, `GIT_BOOL_INT_MIN`/`MAX` (with a comment pinning *why*
they differ from `GIT_INT_MIN`/`MAX` — git's boolean path narrows to a C int while its integer path
does not), the two finders, the two error variants + factories + message arms, the exhaustiveness
case labels, and migrate all eleven merger sites. Add the two case labels to
`test/unit/domain/exhaustiveness.ts`.

**GREEN — pre-pay the surface gate.** `npm run docs:json` and commit the regenerated
`reports/api.json` (the two new codes widen the public `TsgitErrorData` union; the huge typedoc-id
diff is normal).

**GREEN — sweep the fallout.** `npx vitest run test/unit` and re-point every test that asserted a
malformed boolean coerces to `false`. A test that merely used a sloppy value incidentally gets a
valid value instead.

**REFACTOR.** Factor the shared token-walk of `findFirstInvalidBoolean` /
`findFirstInvalidBooleanInSection` if and only if the extraction is smaller than the duplication —
`findFirstValuelessEntry` and `findFirstValuelessInSection` deliberately stay separate today; match
that judgement rather than fighting it. Keep every function under 20 lines and nesting ≤ 2.

### Gate

```
npx vitest run test/unit/application/primitives/config-read.test.ts \
              test/unit/application/primitives/config-read.properties.test.ts \
              test/unit/domain/commands/error.test.ts \
              test/unit/domain \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/config-read.ts \
       src/domain/commands/error.ts src/domain/error.ts \
       test/unit/domain/exhaustiveness.ts \
       test/unit/application/primitives/config-read.test.ts \
       test/unit/application/primitives/config-read.properties.test.ts \
       test/unit/domain/commands/error.test.ts
```
Plus, because the whole unit tier is in the blast radius: `npx vitest run test/unit`.

### Commit

`feat(config): parse boolean config values with git's exact grammar`

---

## Part 2 — Tier-1 and Tier-2 refusal gates

### Context

**Implements:** design §D6a ("Placement — one tier per gate", "Ordering across three classes",
"B12 needs the parse, not just a guard"), Pins L1–L6 and L-order, requirements 16/17/19 ·
**ADR-627**, refining **ADR-346** (eager `[core]` gate vs per-accessor) and **ADR-314** (porcelain
config reads stay faithful).

**The one thing to get right:** git's refusal is **lazy and tiered**. Tier beats line; line breaks
ties within a tier. A single eager whole-config gate would refuse where git succeeds and is
therefore *not* faithful — `git config --get core.sparsecheckout` on a `maybe` value exits 0 and
prints `maybe`, while `git status` exits 128.

| tier | keys in this part | refuses | still succeeds |
|---|---|---|---|
| **T1 — discovery** | `core.bare`, `extensions.worktreeConfig` | every command **including** the `config` porcelain | — |
| **T2 — default-config** | `core.sparseCheckout`, `core.sparseCheckoutCone`, `core.logAllRefUpdates`, `diff.<d>.cachetextconv` (**every** `[diff *]` subsection) | the operational surface | `config --get` / `config --list` |

#### Files and exact current shapes

**`src/application/primitives/internal/repo-state.ts`** (181 lines)

- L45–52 `assertRepository(ctx)` — today it only checks `${gitDir}/HEAD` exists and returns the
  repo root. It is the **one gate both the operational surface and the `config` porcelain pass
  through**, which is precisely git's discovery pass, which is why T1 belongs here and nowhere else.
- L54 `const CORE_STRING_KEYS = ['excludesfile', 'attributesfile']`.
- L70–87 `assertCoreConfigValid(ctx)` — the current **two-class** cross-ordering:
  ```ts
  const [str, comp] = await Promise.all([
    findFirstValuelessEntry(ctx, 'core', undefined, CORE_STRING_KEYS),
    findFirstInvalidCompression(ctx),
  ]);
  // equivalent-mutant: … `str.line === comp.line` can never occur — `<` and `<=` are indistinguishable.
  if (str !== undefined && (comp === undefined || str.line < comp.line)) {
    throw configMissingValue(str.key, str.source, str.line);
  }
  if (comp !== undefined) { … }
  ```
- L96–100 `assertOperationalRepository(ctx)` = `assertRepository` + `assertCoreConfigValid`.
  **It keeps its name and its ~50 call sites.** Only the inner helper is renamed.

**`src/application/commands/internal/repo-state.ts`** — a `@deprecated` re-export shim listing
`assertCoreConfigValid` among nine names. The rename must land here too (and is the only other
production reference — verified by grep: `src/` has exactly these two).

**`src/application/primitives/internal/config-scope.ts`** (113 lines)

- L50–64 `isWorktreeScopeActive(ctx)` — reads `${commonGitDir(ctx)}/config` itself, calls
  `parseIniSections`, and at **L60** does `return entry.value === 'true';`. This is B12: **doubly
  wrong** — it rejects `TRUE`/`yes`/`on`/`1`/`2` (git accepts all of them) and swallows `maybe`
  (git refuses). Adopting the shared parse fixes the accepted-value half; the T1 guard fixes the
  refusal half. It is the **only** row in the whole change whose *accepted* values change, and the
  only fix that is not purely additive.
- `resolveScopePath` (L71) calls `isWorktreeScopeActive` for the `worktree` scope.

**`src/application/primitives/internal/valueless-config-guard.ts`** (27 lines) — the guard shape to
mirror exactly: `assertNoValuelessConfig(ctx, section, subsection, keys)` → finder → throw on a
hit, return silently otherwise.

#### Symbols to add / rename

New file **`src/application/primitives/internal/boolean-config-guard.ts`**:
```ts
export const assertValidBooleanConfig = (
  ctx: Context, section: string, subsection: string | undefined, keys: ReadonlyArray<string>,
): Promise<void>                               // throws configBadBooleanValue
export const assertValidBooleanConfigInSection = (
  ctx: Context, section: string, keys: ReadonlyArray<string>,
): Promise<void>                               // wildcard-subsection sibling
export const assertValidBooleanLiteral = (
  ctx: Context, section: string, subsection: string | undefined, keys: ReadonlyArray<string>,
): Promise<void>                               // throws configBadBooleanLiteral — push.gpgSign only
```
`assertValidBooleanLiteral` shares the **same finder** as `assertValidBooleanConfig`, so the two can
never disagree about *what is invalid*, only about which code reports it.

In `repo-state.ts`:
- `assertRepository` gains, after the HEAD-exists check and before returning the root, a single T1
  gate over `core.bare` and `extensions.worktreeConfig`. Run **both finders in parallel and throw
  the lower-line result** — not two sequential guards, which would report by call order instead of
  by line. (git's relative order between these two specific T1 keys is not separately pinned;
  lowest-line is the rule git applies *within* a tier, so it is the faithful default and it keeps
  one ordering rule in the codebase instead of two.)
- `assertCoreConfigValid` → **`assertEagerConfigValid`** (the name must describe what it now does:
  it is no longer `[core]`-only). Its body becomes a **three-class** lowest-line reduce over
  `Promise.all([ valueless, compression, boolean-core, boolean-diff ])`.

#### The three-class ordering rule (requirement 17)

git reports the entry with the **lowest config-file line**, cross-class, within a tier. T1 preempts
line order entirely: with `core.sparseCheckout = alpha` on an earlier line and `core.bare = beta`
on a later one, git still reports `core.bare` — and it reports `core.bare` even when a valueless
`core.excludesFile` precedes it.

The existing equivalent-mutant comment on the two-class comparison (`str.line === comp.line` can
never occur) **must be re-proven against the new structure or deleted** — it names specific finders
and a specific operator, and a data-structure migration falsifies a carried-forward equivalence
proof. Re-derive it (distinct keys occupy distinct lines) against the reduce that replaces it, or
drop the comment and let the mutant be killed by a test.

**B7 (`diff.<d>.cachetextconv`) has no tsgit consumer at all** — the key is parsed and never read.
It goes in the eager gate anyway, because git refuses `status`/`log` on it across every `[diff *]`
block with no matching `.gitattributes` in play. This is the one guard in the change whose only job
is faithfulness; leaving it out to protect a function name would be a deliberate under-refusal.

#### Tests to extend

- `test/unit/application/commands/internal/repo-state.test.ts` — note the path: the test file for
  `primitives/internal/repo-state.ts` lives under `commands/internal/`. Existing describes:
  `describe('assertCoreConfigValid (string path-likes)')` at L400 and `describe('assertCoreConfigValid')`
  at L702, with `assertCoreConfigValid` called at L415/443/742/775/831/857/898.
- `test/unit/application/primitives/internal/config-scope.test.ts` and
  `config-scope.properties.test.ts`.

### TDD steps

**RED 1 — the guards.** New `test/unit/application/primitives/internal/boolean-config-guard.test.ts`:
each of the three guards throws its own code with `key`/`source`/`value` on a malformed entry, and
returns silently for a valid value, an absent key, and an out-of-section key (three separate `it`s
— one test covering all three does not prove each arm).
*Fails:* the module does not exist.

**RED 2 — T1 on `assertRepository`.** `core.bare = maybe` ⇒ `assertRepository` throws
`CONFIG_BAD_BOOLEAN_VALUE` with `key: 'core.bare'`, `value: 'maybe'`.
`extensions.worktreeConfig = maybe` ⇒ same. And the **negative, which is the load-bearing half**:
`core.sparseCheckout = maybe` (a T2 key) leaves `assertRepository` **silent**.
*Fails:* `assertRepository` only stats HEAD.

**RED 3 — T2 on the eager gate.** `assertEagerConfigValid` refuses `core.sparseCheckout = maybe`,
`core.sparseCheckoutCone = maybe`, `core.logAllRefUpdates = maybe` and
`[diff "MyDriver"] cachetextconv = maybe`, each its own `it`, each asserting
`key`/`value` on `.data`. The `[diff *]` case asserts the qualified key is
`diff.MyDriver.cachetextconv` — subsection verbatim, section and variable lower-cased.
*Fails:* the gate is `[core]`-only and knows no boolean class.

**RED 4 — cross-class ordering (requirement 17).** Fixtures with controlled line numbers:
- `core.sparseCheckout = maybe` (line 2) then valueless `core.excludesFile` (line 3)
  ⇒ `CONFIG_BAD_BOOLEAN_VALUE`;
- the reverse order ⇒ `CONFIG_MISSING_VALUE`;
- boolean before an invalid `core.compression` ⇒ `CONFIG_BAD_BOOLEAN_VALUE`;
- the reverse ⇒ `CONFIG_BAD_NUMERIC_VALUE`.
Assert the **code** that comes back. This is the test that catches a reduce written over two classes
and extended to three by copy-paste.
*Fails:* one class is missing from the comparison.

**RED 5 — B12's accepted values.** `isWorktreeScopeActive` returns `true` for `TRUE`, `yes`, `on`,
`1`, `2` and a valueless `worktreeConfig`; `false` for `false`, `off`, `0`, `''` and an absent key.
*Fails:* the bare `entry.value === 'true'` comparison rejects everything but the exact lowercase word.

**RED 6 — B12 through `resolveScopePath`.** `[extensions] worktreeConfig = yes` makes
`resolveScopePath(ctx, 'worktree')` resolve `${gitDir}/config.worktree` instead of throwing
`CONFIG_SCOPE_NOT_AVAILABLE`. This is the *behaviour* change requirement 19 documents — a witness,
not an assumption.
*Fails:* `yes` reads as false today.

**GREEN.** Write `boolean-config-guard.ts`; wire T1 into `assertRepository`; rename
`assertCoreConfigValid` → `assertEagerConfigValid` (use Serena's `rename_symbol` so the shim in
`src/application/commands/internal/repo-state.ts` and every test reference move together) and
generalise its comparison to the three classes; rewrite `isWorktreeScopeActive`'s L60 to use the
shared `parseGitBoolean` (accepting the result only on `{ ok: true }`; a `{ ok: false }` value here
is inert — the T1 guard is what refuses it, and it runs first on every command).

**REFACTOR.** Extract the lowest-line selection into a small named helper if the reduce exceeds 20
lines or nests past 2; re-prove or delete the equivalent-mutant comment; confirm
`assertOperationalRepository` still reads as one sentence.

### Gate

```
npx vitest run test/unit/application/primitives/internal/boolean-config-guard.test.ts \
              test/unit/application/commands/internal/repo-state.test.ts \
              test/unit/application/primitives/internal/config-scope.test.ts \
              test/unit/application/primitives/internal/config-scope.properties.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/boolean-config-guard.ts \
       src/application/primitives/internal/repo-state.ts \
       src/application/commands/internal/repo-state.ts \
       src/application/primitives/internal/config-scope.ts \
       test/unit/application/primitives/internal/boolean-config-guard.test.ts \
       test/unit/application/commands/internal/repo-state.test.ts \
       test/unit/application/primitives/internal/config-scope.test.ts
```
Plus `npx vitest run test/unit` — the T1 gate is on **every** command's pre-flight, so the whole
unit tier is in the blast radius. Expect fixtures elsewhere that carry a sloppy `core.bare`.

### Commit

`feat(config): refuse malformed booleans at git's discovery and default-config tiers`

---

## Part 3 — Tier-3 consumer gates, and the cross-tool tier pins

### Context

**Implements:** design §D6a (T3 row of the placement table, "T3 guards go on the consuming path,
not the refusal path"), Pins L7–L12 and L9's distinct message, requirements 16/18 · the interop
rows X11–X16 of the design's test strategy · **ADR-627**, **ADR-314**.

**The rule that makes T3 correct:** the valueless guards could sit on a command's *fallback* arm
because a valueless key is always a defect. A boolean key with a **valid** value must still resolve
normally, so a T3 guard runs **immediately before the consuming read, on the success path too**,
and no-ops for every accepted value. `findFirstInvalidBoolean` returning `undefined` for valid and
absent entries alike is what makes that safe. A site that reads the field without the preceding
assert re-opens the bug, because for a boolean **absent and refused are indistinguishable
downstream**.

#### The six consuming sites (exact locations, verified)

| key | guard call | site |
|---|---|---|
| `filter.<d>.required` | `assertValidBooleanConfig(ctx, 'filter', name, ['required'])` — **subsection-specific, not the wildcard** | `src/application/primitives/resolve-filter-driver.ts` — `namedFilterChoice(ctx, name)` (L26–37), immediately before `required: section.required ?? false` at **L34**. git refuses only once a matching `filter=<d>` attribute is in play, so the guard names the **selected** driver's subsection; the wildcard sibling would refuse on an unselected `[filter "other"]` block and over-refuse. It belongs inside `namedFilterChoice`, **not** in `resolveFilterDriver`'s entry. Downstream consumers of the resulting `required` flag: `apply-changeset.ts:188`, `commands/add.ts:398`. |
| `commit.gpgSign` | `assertValidBooleanConfig(ctx, 'commit', undefined, ['gpgsign'])` | `src/application/commands/commit.ts:205` — `const wantSign = opts.sign ?? config.commit?.gpgSign === true;` |
| `tag.gpgSign` | `assertValidBooleanConfig(ctx, 'tag', undefined, ['gpgsign'])` | `src/application/commands/tag.ts:144` — `const wantSign = input.sign ?? config.tag?.gpgSign === true;` — git refuses for a **lightweight** tag too, so the guard must precede the annotated/lightweight branch |
| `push.gpgSign` | `assertValidBooleanLiteral(ctx, 'push', undefined, ['gpgsign'])` | `src/application/commands/push.ts:360–367` — `resolveSignedPushMode`, before `const configured = config.push?.gpgSign;` at L363. **Distinct code** `CONFIG_BAD_BOOLEAN_LITERAL` (requirement 18). Note the early return at L361 (`if (opts.signed !== undefined) return opts.signed;`) — git reads the config regardless, so the guard goes **before** that early return |
| `submodule.<n>.active` | `assertValidBooleanConfigInSection(ctx, 'submodule', ['active'])` | `src/application/commands/submodule.ts` — the status and update entry points (`submoduleList` L435, `submoduleUpdate` L746), each right after its `readConfig(ctx)` |
| `remote.<n>.promisor` | `assertValidBooleanConfigInSection(ctx, 'remote', ['promisor'])` | `src/application/commands/fetch-missing.ts` — `fetchMissingInternal` L79–90, the promisor-remote resolution, before `config.remote?.get(remoteName)?.url` at L88 |

**Both `submodule.<n>.active` and `remote.<n>.promisor` are parsed into `ParsedConfig` and read
nowhere in `src/`** (verified by grep for `?.active` / `?.promisor` — zero field consumers). Their
guards therefore sit at the command git dies in, which is the closest true analogue of "the read
that made git die". Do not invent a consumer for them.

`core.logAllRefUpdates` (B4), `core.sparseCheckout` (B2), `core.sparseCheckoutCone` (B3) and
`diff.<d>.cachetextconv` (B7) are **T2 — already gated in Part 2**. Do not add T3 guards for them;
that would over-refuse. `read-sparse-checkout.ts:61` and `commands/sparse-checkout.ts:86/128/142/162`
stay untouched.

`pack.writeReverseIndex` is also T3 but its gate lands in **Part 5**, inside
`writePackArtifacts`' own helper, because that key does not exist yet.

#### The interop file this part lands

**`test/integration/config-boolean-interop.test.ts`** (new). It carries **no** `interopSurface:`
key — nothing here is a `@writes` surface, and folding these rows into the `.rev` interop file would
make one file answer to two unrelated contracts.

Header grammar, copied from `test/integration/missing-value-refusal-interop.test.ts:1–11`:
```
 * @proves
 *   surface:        config
 *   bucket:         cross-tool-interop
 *   unique:         boolean refusal tier boundaries pinned against canonical git
```
Helpers to reuse from `test/integration/interop-helpers.ts`: `GIT_AVAILABLE`, `runGit`,
`runGitEnv`, `tryRunGit` (returns `{ status, stdout, stderr }`), `git(dir, ...args)`,
`makePeerPair`, `initBothRepos`. One shared `beforeAll` fixture with an explicit **60 000 ms**
timeout — every git-spawning integration file in this repo needs it.

The file needs **one extra helper of its own**: writing a raw config line with `writeFile`. git's
CLI cannot emit a valueless entry, and — pinned — with `core.bare = maybe` already in place even
`git config --unset core.bare` exits 128, so fixture setup must be file-write.

| # | fixture | both refuse | the tier boundary (both succeed) |
|---|---|---|---|
| X11 | `core.bare = maybe` (**T1**) | git `status` exits 128; tsgit's operational command throws `CONFIG_BAD_BOOLEAN_VALUE` | git `config --list` **also** exits 128 ⇒ tsgit's `config` porcelain (`configList`/`configGet`) must refuse too |
| X12 | `core.sparseCheckout = maybe` (**T2**) | git `status` exits 128; tsgit's operational command throws | `git config --get core.sparsecheckout` exits 0 printing `maybe` ⇒ tsgit's `config` porcelain must **still succeed** |
| X13 | `commit.gpgSign = maybe` (**T3**) | git `commit` exits 128; tsgit's `commit` throws | git `status`/`log` exit 0 ⇒ tsgit's `status`/`log` must **not** refuse |
| X14 | `core.bare = 2` | neither refuses | both report the repository as **bare** — the one accepted-value flip in the change |
| X15 | `push.gpgSign = maybe` (**T3**) | git `push` exits 128 with `error: invalid value for 'push.gpgsign'`; tsgit throws `CONFIG_BAD_BOOLEAN_LITERAL` | git `status` exits 0 ⇒ tsgit's `status` must not refuse |
| X16 | `core.sparseCheckout = maybe` line 1 + valueless `core.excludesFile` line 2, then the reverse | both tools name the **lower-line** entry | tsgit's error **code** switches between `CONFIG_BAD_BOOLEAN_VALUE` and `CONFIG_MISSING_VALUE` |

**X11 and X12 together are the load-bearing pair** — they pin the porcelain boundary in both
directions, which is the single thing a one-tier implementation gets wrong.
Every row must assert **both tools**; a row that only checked tsgit's refusal would pass while
over-refusing.

Environment discipline: scrub `GIT_*` (that is what `runGitEnv` is for — `-C` does **not** override
an inherited `GIT_DIR`), signing off, `GIT_CONFIG_NOSYSTEM=1`, `HOME` isolated. Dispose every
`Context` per row. Guard the whole suite on `GIT_AVAILABLE`.

### TDD steps

**RED 1 — six unit refusal cases.** One per site, in the site's existing unit suite
(`test/unit/application/primitives/resolve-filter-driver.test.ts`,
`test/unit/application/commands/{commit,tag,push,submodule,fetch-missing}.test.ts`): a malformed
value in that key makes that command throw the right code with `key`/`value` on `.data`.
*Fails:* the value is coerced away today (Part 1 made it absent; nothing refuses).

**RED 2 — six unit no-op pairs.** For each site: a **valid** value resolves normally
(`commit.gpgSign = yes` still signs, `filter.x.required = 0` still yields `required: false`), and an
**absent** key still falls through to the existing default. Two separate `it`s per site — a guard
that throws unconditionally passes a refusal-only test.
*Fails once the guard is added the wrong way*; write these before the guards so a guard-on-the-
refusal-path implementation cannot slip through.

**RED 3 — the tier negatives.** `commit.gpgSign = maybe` leaves `status` and `log` silent;
`push.gpgSign = maybe` leaves `status` silent; `filter.x.required = maybe` with **no** matching
`filter=x` attribute is inert. These are the tests that stop the implementation from
over-refusing, which is the failure mode a "make it strict" instinct produces.
*Fails:* trivially green today, so write them and watch them stay green — then re-run after GREEN.

**RED 4 — the interop file.** Write `config-boolean-interop.test.ts` with X11–X16 as above.
*Fails:* X11/X12/X13/X15/X16 fail on the tsgit side (no refusal, or refusal at the wrong tier);
X14 fails until Part 1's integer arm is in place (it is — assert it here end-to-end).

**GREEN.** Add the six guards at the six sites listed above, each immediately before its consuming
read, on the success path.

**REFACTOR.** If three or more command entry points end up repeating
`await assertValidBooleanConfig(ctx, …)` with the same arguments, hoist a named constant for the key
list beside the guard rather than duplicating string literals. Do **not** hoist the guards into a
shared pre-flight — that would silently promote T3 keys to T2 and break X13/X15.

### Gate

```
npx vitest run test/unit/application/primitives/resolve-filter-driver.test.ts \
              test/unit/application/commands/commit.test.ts \
              test/unit/application/commands/tag.test.ts \
              test/unit/application/commands/push.test.ts \
              test/unit/application/commands/submodule.test.ts \
              test/unit/application/commands/submodule-update.test.ts \
              test/unit/application/commands/fetch-missing.test.ts \
  && npx vitest run test/integration/config-boolean-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/resolve-filter-driver.ts \
       src/application/commands/commit.ts src/application/commands/tag.ts \
       src/application/commands/push.ts src/application/commands/submodule.ts \
       src/application/commands/fetch-missing.ts \
       test/integration/config-boolean-interop.test.ts
```

### Commit

`feat(config): refuse malformed booleans at each consuming command`

---

## Part 4 — Domain: the shared pack ordering and the `.rev` serializer

### Context

**Implements:** design §D2, §D3, §D10, §D11 (H-1…H-7), requirements 2/5/6, Pins B/E/F ·
**ADR-624** (the serializer joins the parser), **ADR-625** (one shared sort), **ADR-140**
(`@writes` grammar).

#### Files and exact current shapes

**`src/domain/storage/pack-writer.ts`** — file header carries
`@writes surface: packfile · kind: equivalent-under-readback · format: git-packfile-v2`.
ADR-140 permits **one `@writes` block per file**, which is exactly why the `.rev` serializer cannot
live here.
- L65 `const IDX_SHA_LENGTH = 20;` — a pre-existing SHA-1-only limit of the **`.idx`** writer.
  This part neither widens nor depends on it.
- L67–70 (private):
  ```ts
  interface SortedEntry { readonly shaBytes: Uint8Array; readonly entry: PackIndexWriterEntry; }
  ```
- L71–170 `serializePackIndex(entries, packChecksum)`; its ordering step at L80–84:
  ```ts
  const withBytes: SortedEntry[] = entries.map((entry) => ({ shaBytes: hexToBytes(entry.id), entry }));
  withBytes.sort((a, b) => compareBytes(a.shaBytes, b.shaBytes));
  ```
  Two `Stryker disable next-line` equivalent-mutant comments live at the fanout loops (L~123, L~129)
  — **do not disturb them**; a directive anchors on its expression line.
- L39–43 `export interface PackIndexWriterEntry { readonly id: string; readonly crc32: number; readonly offset: number; }`

**`src/domain/storage/rev-index.ts`** (101 lines) — carries **no** `@writes` block today.
- L3 `const REV_MAGIC = 0x52494458; // 'RIDX'`, L5 `export const REV_HEADER_SIZE = 12;`
- L33 `parsePackRevIndex(bytes, digestLength, objectCount): PackRevIndex` — its size rule is
  `REV_HEADER_SIZE + 4 * objectCount + 2 * digestLength`; the serializer must satisfy it exactly.
- L92 `revIndexPositionAt(rev, p)`.
- `invalidPackRevIndex(check: RevIndexCheck, reason: string)` from `./error.js` — the closed union
  is `'size' | 'signature' | 'version' | 'hash-id'`. **Reuse `'hash-id'`; do not widen the union.**

**`src/domain/storage/index.ts`** — L60–84; the rev-index block already exports
`parsePackRevIndex`, `REASON_REV_INDEX_CORRUPT`, `REASON_REV_INDEX_TOO_SMALL`, `REV_HEADER_SIZE`,
`revIndexPositionAt` and the `PackRevIndex` type. `serializePackRevIndex` joins that export list
(alphabetical within the block).

**`src/domain/objects/encoding.ts`** — `compareBytes`, `hexToBytes`, `bytesToHex`.

#### The bytes to reproduce (Pin B — the F1 fixture, SHA-1, 80 bytes)

```
00000000: 52 49 44 58 | 00 00 00 01 | 00 00 00 01     'RIDX' | version=1 | hashId=1
0000000c: 00000003 00000004 00000005 00000001         body: 7 × u32BE
          00000006 00000002 00000000
00000028: <20 bytes> embedded pack checksum (= the .pack trailer)
0000003c: <20 bytes> the .rev's own digest over [0, len − 20)
```
Derivation, confirmed against `git verify-pack -v`: the `.idx` order (oid-ascending) is
`035f9b74, 4d4bc1c7, 75db9909, 7ee14440, 9a554c2e, a0054e49, f1f36270` with offsets
`333, 276, 314, 94, 106, 257, 295`; ranking index positions by ascending offset gives
`[3, 4, 5, 1, 6, 2, 0]` — exactly the bytes on disk.

Sizes: **52** bytes for 0 objects (git still writes the file), **56** for 1 object (`body = [0]`),
`12 + 4·N + 2·digestLength` in general. SHA-256 ⇒ `hashId = 2` and both digests 32 bytes wide.

#### Symbols to add

New file **`src/domain/storage/pack-order.ts`** (leaf, no `@writes` block):
```ts
export interface SortedEntry {
  readonly shaBytes: Uint8Array;
  readonly entry: PackIndexWriterEntry;
}
/** Writer entries paired with their raw oid bytes, oid-ascending — the index order
 *  the .idx encodes and the .rev permutes. */
export function sortPackIndexEntries(
  entries: ReadonlyArray<PackIndexWriterEntry>,
): ReadonlyArray<SortedEntry>
```
`serializePackIndex` consumes it verbatim (it may keep a local mutable copy for its own in-place
writes; the returned array is the shared ordering definition, not a shared mutable buffer).

In **`rev-index.ts`**:
```ts
export function serializePackRevIndex(
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packChecksum: Uint8Array,
): Uint8Array
```
Body, in order:
1. Refuse `packChecksum.length` ∉ {20, 32} with `invalidPackRevIndex('hash-id', …)`. This is the
   writer's **only** refusal, and it is unreachable from every production call site (`packSha` is
   always a verified pack trailer) — which makes it a mutation hazard needing **one isolated test
   per rejected width**.
2. `digestLength = packChecksum.length`; `hashId = digestLength === 32 ? 2 : 1`.
3. `sortPackIndexEntries(entries)` → a `Uint32Array` of `[0, N)` sorted by
   `sorted[a].entry.offset − sorted[b].entry.offset`. A **comparator** is required (not the
   comparator-free numeric sort) because the values sorted are positions, not the offsets keying
   them. `N < 2³²` by format definition, so `Uint32Array` is exact.
4. Allocate exactly `12 + 4·N + 2·digestLength`; write magic / `1` / `hashId` / the N body words /
   `packChecksum` at `12 + 4·N`. **Leave the final `digestLength` bytes zero** — the application
   assembler fills them in place.
5. Return the whole buffer, trailer region included and zeroed.

**Offsets are unique by construction** — each pack entry begins where the previous one ends, and
both producers emit strictly increasing offsets. Tie behaviour is undefined *because ties cannot
occur*; invent no tie-break rule and write no test pretending to cover one.

Hash-width genericity is a hard rule: no literal `20`/`32` in any size or offset expression. The
only literal widths permitted are the accepted-width guard and the `hashId` mapping — the format's
own enumeration, not arithmetic.

#### The `@writes` block

Add to the **file header** of `rev-index.ts` (ADR-140 grammar; the file emits the bytes):
```
 * @writes
 *   surface: packRevIndex
 *   kind:    byte-identical
 *   format:  pack-rev-index-v1
```
`kind: byte-identical` is justified by the pin that git regenerates the file identically from the
pack alone. `check:write-surfaces` will report one gap (no interop test names `packRevIndex` yet)
until **Part 6** — the audit is warn-only (it exits 0 without `--blocking`), so `validate` stays
green in the interim; Part 6 must verify the gap is gone with the allowlist still `{"surfaces": []}`.

#### Tests

- `test/unit/domain/storage/rev-index.test.ts` (existing, 14.6 K).
- `test/unit/domain/storage/rev-index.properties.test.ts` (existing) — imports
  `arbRevIndexSpec`, `buildRevIndex` from `./arbitraries.js`; existing round-trip runs at
  `numRuns: 200`, the totality property at `100`.
- `test/unit/domain/storage/arbitraries.ts` L394–458 — `RevIndexSpec`, `buildRevIndex`,
  `arbRevIndexSpec`. **Keep them exactly as they are.** They generate hostile specs (disagreeing
  `hashId`/width, non-permutation bodies) that the production serializer cannot emit and that the
  parser's negative properties need; replacing them with the production writer would silently
  narrow the parser's input space. Add a **new** arbitrary for writer entries beside them.
- `test/unit/domain/storage/pack-writer.test.ts` (existing, 19.1 K) — must stay green unchanged,
  which is the proof the sort extraction is behaviour-preserving.
- New `test/unit/domain/storage/pack-order.test.ts` — every module in `domain/storage` has a 1:1
  sibling test file; the new leaf gets one.

### TDD steps

**RED 1 — the exact bytes.** `rev-index.test.ts`: build the F1 fixture's seven
`PackIndexWriterEntry`s from the oids and offsets above; assert bytes `[0, 60)` equal the Pin B
literal (magic, version, `hashId = 1`, body `[3,4,5,1,6,2,0]`, embedded checksum at `0x28`) and that
bytes `[60, 80)` are **all zero**. The real trailer is the assembler's test — this function does
not hash.
*Fails:* `serializePackRevIndex` does not exist.

**RED 2 — ordering independence.** The same entry set fed in ascending / descending / interleaved
offset order produces the identical body.
*Fails:* same.

**RED 3 — degenerate counts.** 0 entries ⇒ 52 bytes, empty body, checksum at offset 12.
1 entry ⇒ 56 bytes, body `[0]`. Assert the byte length **and** the checksum position, so a mutant
on the size formula cannot hide.
*Fails:* same.

**RED 4 — SHA-256.** A 32-byte checksum ⇒ `hashId = 2`, size `12 + 4N + 64`, checksum at `12 + 4N`.
*Fails:* same.

**RED 5 — the guard, one `it` per width.** `packChecksum.length` of **0**, **19**, **21**, **33** —
four separate tests, each asserting `err.data.code === 'INVALID_PACK_REV_INDEX'` **and**
`err.data.check === 'hash-id'` **and** the `reason` text via `try`/`catch`. One test covering all
four widths does not prove the guard fires on each.
*Fails:* same.

**RED 6 — large offsets.** Entries with offsets above `0x7fffffff` still order correctly: the
writer sorts the real offsets, not their `.idx` large-offset encoding.
*Fails:* same.

**RED 7 — round-trip property** (`rev-index.properties.test.ts`, `numRuns: 200`).
`Given an arbitrary set of pack index writer entries with distinct oids and distinct offsets and a
checksum of either width` / `When serializing then parsing` / `Then every header field, the object
count, the pack checksum and every revIndexPositionAt round-trip`. Additionally assert the body is
a **permutation of `[0, N)`** and that mapping it through the entries yields **strictly ascending**
offsets. The parser ignores the trailer's value, so the zeroed tail parses cleanly.
*Fails:* same.

**RED 8 — totality property** (`numRuns: 100`). `Given an arbitrary entry set and either digest
width` / `When serializing` / `Then it never throws and the size is exactly 12 + 4N + 2d`.
*Fails:* same.

**RED 9 — `pack-order.test.ts`.** `sortPackIndexEntries` returns entries oid-ascending, pairs each
with its own `shaBytes`, and is stable-in-the-only-way-that-matters (distinct oids ⇒ a total order).
Empty input ⇒ empty output.
*Fails:* the module does not exist.

**GREEN.** Create `pack-order.ts`; rewire `serializePackIndex` to it and delete its private
`SortedEntry` and inline sort; implement `serializePackRevIndex`; add the `@writes` block; export
`serializePackRevIndex` from `src/domain/storage/index.ts`.

**GREEN — pre-pay the surface gate.** `npm run docs:json`, commit the regenerated
`reports/api.json`. Confirm `npm run check:exports` and `npm run check:types` are green (the `.d.ts`
truthfulness checks must stay green).

**REFACTOR.** Extract the body-permutation computation into a named local if
`serializePackRevIndex` exceeds 20 lines. Confirm `pack-writer.test.ts` passes **unchanged** — that
is the behaviour-preservation proof for the extraction.

### Gate

```
npx vitest run test/unit/domain/storage/rev-index.test.ts \
              test/unit/domain/storage/rev-index.properties.test.ts \
              test/unit/domain/storage/pack-order.test.ts \
              test/unit/domain/storage/pack-writer.test.ts \
  && npm run check:types \
  && npm run check:exports \
  && ./node_modules/.bin/biome check src/domain/storage/rev-index.ts \
       src/domain/storage/pack-order.ts src/domain/storage/pack-writer.ts \
       src/domain/storage/index.ts \
       test/unit/domain/storage/rev-index.test.ts \
       test/unit/domain/storage/rev-index.properties.test.ts \
       test/unit/domain/storage/pack-order.test.ts
```
Also `npx vitest run --coverage test/unit/domain/storage` — domain coverage is 100 % enforced.

### Commit

`feat(pack): serialize the pack reverse index`

---

## Part 5 — Write the `.rev` beside every `.idx`

### Context

**Implements:** design §D4, §D5, §D6, §D7, §D8, §D9, §D12, requirements 1/3/4/7/12/13, Pins
A4/A5/D1–D6/E1/G/H1 · **ADR-626** (`writePackArtifacts` owns assembly and the gate),
**ADR-628** (`writeExclusive`), **ADR-630** (a failed `.rev` write fails the operation),
**ADR-632** (no per-call override).

#### Files and exact current shapes

**`src/application/primitives/internal/write-pack-artifacts.ts`** (66 lines) — the whole file today:

```ts
export const buildIdx = async (
  ctx: Context, entries: ReadonlyArray<PackIndexWriterEntry>, packSha: string,
): Promise<Uint8Array> => { … hexToBytes(packSha) → serializePackIndex → ctx.hash.hashHex(body)
                                → concat body + trailer … };

export interface WrittenPackArtifacts {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  readonly packSha: string;
}

export const writePackArtifacts = async (
  ctx: Context, packDir: string, packBytes: Uint8Array, idxBytes: Uint8Array,
  packSha: string, objectCount: number, promisor: boolean,
): Promise<WrittenPackArtifacts> => {
  await ctx.fs.mkdir(packDir);
  const packPath = `${packDir}/pack-${packSha}.pack`;
  const idxPath  = `${packDir}/pack-${packSha}.idx`;
  await ctx.fs.writeExclusive(packPath, packBytes);
  await ctx.fs.writeExclusive(idxPath, idxBytes);
  if (promisor) await ctx.fs.writeExclusive(`${packDir}/pack-${packSha}.promisor`, new Uint8Array(0));
  return { packPath, idxPath, objectCount, packSha };
};
```

**`src/application/primitives/fetch-pack.ts`** — `materializePack` at L156–186:
```ts
const idxBytes = await buildIdx(ctx, entries, packSha);
const written = await writePackArtifacts(ctx, packsDir(commonGitDir(ctx)), download.packBytes,
                                         idxBytes, packSha, entries.length, input.promisor === true);
refreshPackRegistry(ctx);
return { ...written, shallow: download.shallow, unshallow: download.unshallow };
```
`FetchPackResult` (L90–100) declares `packPath`, `idxPath`, `objectCount`, `packSha`, `shallow`,
`unshallow`. **That trailing spread must become an explicit construction of the six fields** —
otherwise `indexBytes` rides along at runtime on a type that does not declare it (TypeScript's
excess-property check does not fire on spreads). `emptyPackResult` (L138–147) already constructs
explicitly; match it.

**`src/application/commands/pack-objects.ts`** — L90–110: `buildIdx` → `writePackArtifacts(…, false)`
→ `if (opts.outputDirectory === undefined) refreshPackRegistry(ctx);` →
`return { packId, objectCount, packBytes: pack.bytes.length, indexBytes: idxBytes.length };`.
`PackObjectsResult` (L44–56) is **unchanged** — no `revPath` is exposed. `indexBytes` now comes
from `written.indexBytes`.

**`src/application/primitives/config-read.ts`** — `ParsedConfig` (L13–104), `MutableParsedConfig`
(L1021–1045), `dispatchSection` (L1057–1077, the subsectionless `else if` chain ordered
`remote`/`core`/`user`/`extensions`/`commit`/`tag`/`push`/`gpg`), and the merger precedents
`mergeCommit` (L1373) / `mergeTag` (L1381) — each is a five-line `for (const entry of sec.entries)`
with a lower-cased key comparison.

**`src/application/primitives/path-layout.ts`** — `packsDir(gitDir) = \`${gitDir}/objects/pack\``.

**`test/parity/scenarios/pack-objects.scenario.ts`** — L17–21 and L26:
```ts
  /** The pack directory holds exactly the `.pack` + `.idx` this call wrote —
   *  no `.rev`, no bitmap. */
  readonly packDirEntryCount: number;
…
  expected: { objectCount: 3, idxObjectCount: 3, packDirEntryCount: 2 },
```
This is the **only** structural pack-dir assertion in the whole parity suite (verified: one
`readdir` across all scenarios).

#### Symbols to add / change

```ts
// write-pack-artifacts.ts
export const buildRev = async (
  ctx: Context, entries: ReadonlyArray<PackIndexWriterEntry>, packSha: string,
): Promise<Uint8Array>
// hexToBytes(packSha) → serializePackRevIndex → ctx.hash.hash(bytes.subarray(0, len − d))
//   → bytes.set(digest, len − d). One allocation, filled in place.

export interface WritePackArtifactsInput {
  readonly packDir: string;
  readonly packBytes: Uint8Array;
  readonly entries: ReadonlyArray<PackIndexWriterEntry>;
  readonly packSha: string;
  readonly promisor: boolean;
}
export interface WrittenPackArtifacts {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  readonly indexBytes: number;   // new — pack-objects no longer recomputes it
  readonly packSha: string;
}
export const writePackArtifacts = (ctx: Context, input: WritePackArtifactsInput)
  : Promise<WrittenPackArtifacts>
```

**No `revPath` is returned.** No production caller needs it, and a field only tests read is dead
code by the repo's own guardrail. Tests compose `${packDir}/pack-${packSha}.rev` or read the
directory.

`buildRev` uses `ctx.hash.hash` (raw bytes), not `ctx.hash.hashHex` — `buildIdx` needs hex because
it concatenates; `buildRev` writes the digest in place. `digestLength` is derived from the checksum
bytes, so a width mismatch between `packSha` and the hash service is structurally impossible:
`packSha` **is** the pack trailer.

The in-place trailer fill is **not** an immutability violation: the buffer is freshly allocated and
exclusively owned by `buildRev`, which has not published it — the same discipline
`serializePackIndex` already uses inside its own body. `buildIdx` concatenates because
`serializePackIndex` does not reserve a tail; the `.rev` writer does. The asymmetry is deliberate;
do not "fix" it.

The gate helper, beside the writer in the same file:
```ts
const WRITE_REVERSE_INDEX_KEY = 'writeReverseIndex'; // the finders lower-case their key list

const writeReverseIndex = async (ctx: Context): Promise<boolean> => {
  await assertValidBooleanConfig(ctx, 'pack', undefined, [WRITE_REVERSE_INDEX_KEY]);
  return (await readConfig(ctx)).pack?.writeReverseIndex ?? true;
};
```
**The guard must precede the read, and it is not optional.** §D6a leaves a refused boolean *absent*
in `ParsedConfig`, so the one-liner `(await readConfig(ctx)).pack?.writeReverseIndex ?? true` maps
`= maybe` onto the default and silently **writes** the `.rev` where git refuses to run at all. For a
boolean, absent and refused are indistinguishable downstream. Keeping the guard inside the same
helper as the read is what makes drift structurally impossible.

Order of operations inside `writePackArtifacts`:

0. **`const wantRev = await writeReverseIndex(ctx);` — hoisted to the very top, before `mkdir`.**
   git's config read precedes `index-pack`'s output entirely and a refused value leaves the pack dir
   empty; hoisting costs nothing and makes "the pack write never happens" literally true.
1. `mkdir(packDir)`.
2. `buildIdx` → `writeExclusive(.pack)` → `writeExclusive(.idx)`.
3. `.promisor` sentinel — **kept immediately after the `.idx`**, exactly where it is today, so the
   window in which a promisor pack is visible without its sentinel does not widen.
4. `if (!wantRev) return …`.
5. `buildRev` → `writeExclusive(.rev)`.

**`.rev` last is load-bearing.** Pack discovery keys on the `.pack`/`.idx` pair (`pack-registry.ts`
`scanPacks` registers a pack only when its `.pack` exists by name), so a concurrent reader that sees
the pair before the `.rev` lands takes the absent-artefact arm and sorts — the correct answer, and
exactly the state git leaves under `pack.writeReverseIndex=false`. The reverse order would create a
window in which a `.rev` exists for a pack with no `.idx`.

`writeExclusive` (not `write`) for the `.rev`, like all three siblings — it is a `FileSystem` port
method implemented by the node, memory and browser/OPFS adapters, and it carries the symlink-safe
ancestor containment check and `O_EXCL`. No adapter branch, no new port method.

A `.rev` write failure **propagates** — no new `catch`, no "best effort, warn and continue" arm.
The enclosing `fetch`/`clone`/`packObjects` fails, matching git's `die`.

Config surface, following the `[commit]`/`[tag]` precedent exactly:
```ts
// ParsedConfig
/** `pack.writeReverseIndex` — write a sibling `.rev` beside each pack index. git defaults to true. */
readonly pack?: { readonly writeReverseIndex?: boolean };
// MutableParsedConfig
pack?: { writeReverseIndex?: boolean };
// dispatchSection — one new subsectionless arm
} else if (sec.section === 'pack') { mergePack(acc, sec); }
```
`mergePack` uses the shared strict parse from Part 1 (so a valueless key ⇒ `true`, `2` ⇒ `true`,
`0` ⇒ `false`, and a refused value leaves the field absent). Key comparison on the lower-cased key.

**Known, stated, not fixed:** `readConfig` reads only `${commonGitDir}/config`, so a
`pack.writeReverseIndex=false` in `~/.gitconfig` is invisible to tsgit. Systemic and pre-existing;
the interop test therefore sets the key in the **local** repo config. Corollary: during `clone`,
`writeCloneConfig` runs *after* `fetchPack`, so a clone always sees the default and always writes
the `.rev` — faithful, because git's clone also cannot read a config the new repository does not
have yet and reaches the same default.

#### Read-side pickup (verify, change nothing)

`refreshPackRegistry(ctx)` drops the generation, so the next `scanPacks` `readdir` builds a
`fileNames` set containing `pack-<sha>.rev` and `loadPackRevIndex` is handed `present: true`.
`resolveSortedOffsets` (`internal/pack-offset-table.ts`, L94) consumes it **only** at or above
`REV_INDEX_MIN_OBJECTS = 5_000` — below that the accelerator is deliberately skipped and the file
is never opened. So **for ordinary test-sized packs the newly written `.rev` is never read by
tsgit**; a test claiming "the accelerator now fires" on a 7-object pack proves nothing. The scaled
case is Part 6.

#### Tests

New **`test/unit/application/primitives/internal/write-pack-artifacts.test.ts`** — no such file
exists today. Use the memory adapter (see `test/unit/application/primitives/fetch-pack.test.ts` and
`test/unit/application/commands/pack-objects.test.ts` for the existing context-construction
patterns in this repo).
Existing suites to update: `test/unit/application/primitives/fetch-pack.test.ts`,
`test/unit/application/commands/pack-objects.test.ts`,
`test/unit/application/primitives/config-read.test.ts`.

### TDD steps

**RED 1 — `buildRev`'s trailer.** The last `digestLength` bytes equal
`ctx.hash.hash(bytes.subarray(0, len − digestLength))`, and the result re-parses through
`parsePackRevIndex` without throwing.
*Fails:* `buildRev` does not exist.

**RED 2 — the independent oracle.** For the same entry set, `buildRev`'s body equals
`packPositionMap(parsePackIndex(await buildIdx(ctx, entries, packSha)))`
(`src/application/primitives/internal/pack-positions.ts:18`). Two implementations of one
computation is deliberate — `packPositionMap` consumes a **parsed** `PackIndex`, the writer consumes
writer entries; collapsing them would make `fsck`'s cross-check tautological.
*Fails:* same.

**RED 3 — three files by default.** `writePackArtifacts` with no `[pack]` section writes
`.pack`, `.idx` **and** `.rev`; `readdir(packDir)` returns three entries; the `.rev` name is
`pack-${packSha}.rev`.
*Fails:* only two are written.

**RED 4 — the gate suppresses only the `.rev`.** `pack.writeReverseIndex = false` ⇒ exactly two
entries, and the `.pack`/`.idx` bytes are unchanged. Separately: `= 0` ⇒ suppressed, `= 2` ⇒
written, a valueless `writeReverseIndex` ⇒ written.
*Fails:* the gate does not exist.

**RED 5 — the refusal happens before any file.** `pack.writeReverseIndex = maybe` ⇒
`writePackArtifacts` throws `CONFIG_BAD_BOOLEAN_VALUE` whose `key` is `pack.writeReverseIndex`
with the section and variable segments lower-cased (git's own convention, and what the finder
produces), and whose `value` is `'maybe'` — **and the pack directory is empty** (not even the `.pack`). This is the test that
holds the hoist honest — a guard placed at step 4 passes a refusal-only assertion and fails this one.
*Fails:* nothing refuses today.

**RED 6 — `.promisor` unaffected.** With `promisor: true`, the sentinel is written both with the
gate on (four entries) and with it off (three entries).
*Fails:* same.

**RED 7 — a `.rev` write failure propagates.** Stub `writeExclusive` to reject on the `.rev` path
with a known `TsgitError`; assert the same `data.code` escapes `writePackArtifacts` and that the
`.pack`/`.idx` remain on disk (git's own death leaves exactly that state).
*Fails:* same.

**RED 8 — zero objects.** `writePackArtifacts` with `entries: []` still writes a header-only `.rev`
(**52** bytes at SHA-1: `12 + 0 + 2·20`) beside its `.pack`/`.idx` — git writes the file for an
empty pack too. Conversely `fetchPack` with zero entries writes nothing at all: it suppresses the
whole artefact set before reaching the writer, so no `.idx` means no `.rev`, unchanged from today
(assert it in `fetch-pack.test.ts`).
*Fails:* same.

**RED 9 — `outputDirectory`.** `packObjects({ wants, outputDirectory })` writes all three files into
the external directory and does **not** refresh the pack registry.
*Fails:* same.

**RED 10 — config rows.** `config-read.test.ts`: `[pack] writeReverseIndex` ⇒ `true` / `false` /
valueless ⇒ `true` / mixed-case key ⇒ parsed / `= 2` ⇒ `true` / `= 0` ⇒ `false` / absent section ⇒
`config.pack === undefined`.
*Fails:* `ParsedConfig` has no `pack`.

**RED 11 — parity.** Flip `expected.packDirEntryCount` `2 → 3` and correct the interface comment
from *"no `.rev`, no bitmap"* to *"`.pack` + `.idx` + `.rev`; no bitmap"*.
*Fails:* the write path is not in place yet; passes after GREEN, across **every** driver.

**GREEN.** Implement `buildRev`; convert `writePackArtifacts` to the options object with the
hoisted gate and the `.rev` write last; add `ParsedConfig.pack` + `MutableParsedConfig.pack` +
`mergePack` + the `dispatchSection` arm; migrate both call sites — `fetch-pack.ts` with an
**explicit six-field construction** replacing `{ ...written, … }`, and `pack-objects.ts` reading
`written.indexBytes` instead of `idxBytes.length`.

**GREEN — pre-pay the surface gate.** `npm run docs:json`, commit the regenerated
`reports/api.json` (`ParsedConfig.pack` is public through `src/application/primitives/index.ts:13`).

**GREEN — all five parity drivers.** Rebuild the parity bundle before the browser driver: a stale
`test/browser/parity-scenarios.bundle.js` shows up as **uniform e2e timeouts**, not as a diff.

**REFACTOR.** Keep `writePackArtifacts` under 20 lines by extracting the artefact-path trio and/or
the promisor sentinel into named locals. Confirm no caller recomputes `indexBytes`. Confirm the
`.promisor` write still sits immediately after the `.idx`.

### Gate

```
npx vitest run test/unit/application/primitives/internal/write-pack-artifacts.test.ts \
              test/unit/application/primitives/fetch-pack.test.ts \
              test/unit/application/commands/pack-objects.test.ts \
              test/unit/application/primitives/config-read.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/write-pack-artifacts.ts \
       src/application/primitives/fetch-pack.ts src/application/commands/pack-objects.ts \
       src/application/primitives/config-read.ts \
       test/parity/scenarios/pack-objects.scenario.ts \
       test/unit/application/primitives/internal/write-pack-artifacts.test.ts
```
Then, because the parity expectation moved, **all five drivers**:
```
npm run test:parity && npm run test:parity:deno && npm run test:parity:bun \
  && npm run test:parity:workers && npm run build:parity && npm run test:e2e
```

### Commit

`feat(pack): write the reverse index beside every pack index`

---

## Part 6 — Cross-tool interop for the `.rev` write surface

### Context

**Implements:** design §Test strategy (integration/interop, X1–X10), §D8, requirements 2/6/7/8/11 ·
**ADR-629** (its own byte-identical interop file), **ADR-631** (read-side pickup proven at both
scales), **ADR-606** (the read path trusts the body, so the byte compare is the contract).

**Why this part is standalone despite having no `src/` delta.** ADR-629 requires the `.rev`
faithfulness pins to live in their own interop file naming `interopSurface: packRevIndex`; that file
cannot exist before the write path does, and it has no implementation part to fold into — the write
path's own part already carries its unit suite and the parity expectation it asserts. It also
closes the `check:write-surfaces` gap that Part 4's `@writes` block opens.

#### The oracle, and why it works

git's `.rev` is a **pure function of the pack**: `git index-pack -o p.idx p.pack` on a copy of a
git-written pack regenerates the byte-identical `.rev` (and `.idx`), repeatably. And
`git index-pack -o` runs **outside any repository**, which is what makes it usable here.
Method: copy a tsgit-written `.pack` into a scratch dir, run
`git index-pack -o <stem>.idx <stem>.pack`, compare `<stem>.rev` to tsgit's byte for byte.
The `.rev` path is the **`.idx` path with the suffix replaced** — never a name derived from the pack
checksum.

#### The file

**`test/integration/rev-write-interop.test.ts`** (new). Header:
```
 * @proves
 *   surface:        packRevIndex
 *   bucket:         cross-tool-interop
 *   unique:         tsgit-written pack reverse index byte-compared against git index-pack
 *   interopSurface: packRevIndex
```
`interopSurface: packRevIndex` is the key `tooling/audit-write-surfaces.ts` matches against
Part 4's `@writes surface: packRevIndex`. `tooling/audit-write-surfaces.allowlist.json` must stay
`{"surfaces": []}` — **do not add an entry**.

One shared `beforeAll` fixture with an explicit **60 000 ms** timeout, `GIT_*` scrubbed, signing
off, every `Context` disposed per row, whole suite guarded on `GIT_AVAILABLE`.

Helpers to reuse rather than reinventing a third fixture vocabulary:
- `test/integration/interop-helpers.ts` — `GIT_AVAILABLE`, `runGit`, `runGitEnv`, `runGitBytes`,
  `git(dir, ...args)`, `tryRunGit` (`{ status, stdout, stderr }`), `makePeerPair`, `initBothRepos`,
  `disableAutoMaintenance` (**call it** — a background `gc` would write its own `.rev` and poison a
  byte compare).
- `test/integration/rev-bitmap-fixture-helpers.ts` — `DIGEST_LENGTH` (20),
  `packArtefactPaths(dir)`, `packArtefactPathsNamed(dir, name)` returning the artefact path trio.

| # | row | assertion |
|---|---|---|
| X1 | tsgit `packObjects` writes a pack; copy the `.pack` to a scratch dir; `git index-pack -o <stem>.idx <stem>.pack` | tsgit's `.rev` bytes **equal** git's, byte for byte |
| X2 | the same with a fixture of ≥ 3 objects whose oid order and offset order are **non-monotonically correlated** | the permutation is non-trivial — a fixture whose body is the identity would pass for the wrong reason. Assert explicitly that the body is not `[0, 1, …, N−1]` |
| X3 | `git verify-pack -v` and `git fsck --strict` over a repo whose pack dir tsgit wrote | exit 0, no `.rev` finding |
| X4 | tsgit `fsck` over the same repo | no `.rev` finding, exit bit **64 clear**. The strongest cheap oracle available: `src/application/commands/internal/fsck/rev-index-health.ts` already verifies the trailer with `ctx.hash` over `[0, len − digestLength)` **and** cross-checks every body position against `packPositionMap`, so a green `fsck` proves the digest and the whole permutation against an independently written reader |
| X5 | `pack.writeReverseIndex=false` in the **local** repo config, then `packObjects` | no `.rev`; `git fsck --strict` still clean |
| X6 | `pack.writeReverseIndex` **valueless** in the local config (written with `writeFile` — git's CLI cannot emit one) | `.rev` written |
| X7 | `pack.writeReverseIndex=maybe`, the same repo state handed to both tools | **both refuse** — git exits 128 with `bad boolean config value`; tsgit throws `CONFIG_BAD_BOOLEAN_VALUE` carrying the lower-cased key and `value: 'maybe'`, and writes **no** pack artefacts, matching git's empty pack dir |
| X7b | `pack.writeReverseIndex=2` and `=0` | both tools accept; `2` ⇒ `.rev` written, `0` ⇒ suppressed — the integer arm proven end-to-end, not only in the unit sweep |
| X8 | tsgit clone/fetch against a local `git` peer (whichever transport the existing helpers already support) | the fetched pack has all three files, and git reads objects out of it |
| X9 | `packObjects` into an `outputDirectory` **outside** the repo | `.rev` present there |
| X10 | tsgit re-reads its own artefact: `loadPackRevIndex(ctx, <written .rev path>, true, digestLength, objectCount)` ⇒ `kind: 'usable'`, and `revIndexPositions(rev, objectCount)` ≡ `packPositionMap(parsedIdx)` | requirements 6 and 7, at the always-on scale |

`loadPackRevIndex` lives at `src/application/primitives/internal/pack-artefact-source.ts:96` with
signature `(ctx, revPath, present, digestLength, objectCount)`; `revIndexPositions` and
`packPositionMap` at `src/application/primitives/internal/pack-positions.ts:36` and `:18`.

#### The scaled read-side case

`resolveSortedOffsets` (`internal/pack-offset-table.ts:94`) takes the gathered arm only at or above
`REV_INDEX_MIN_OBJECTS = 5_000`. One case builds a pack at or above that threshold so the
accelerator arm actually fires on tsgit's own freshly written `.rev`; assert reads succeed and — only
if a seam allows it **without new production code** — that the fallback warning
(`ctx.logger?.warn?.('packRegistry: discarding unusable pack reverse index', …)`) never fires.
It is legitimate to inject a recording `logger` on the `Context` for that. If the build cost proves
incompatible with the integration tier's timeouts, move the case to
`test/bench/support/fixture-generator.ts`'s family rather than dropping the coverage — never drop it.

Tier budgets: `test-pyramid-budgets.json` puts the integration tier at target 15 %, `warnAbove` 25.
Current counts are 581 unit / 125 integration / 6 e2e ⇒ 17.6 %; two new integration files (this one
plus Part 3's) move it to 17.8 %. **No budget edit is needed** — if the report says otherwise, read
it, do not silence it.

### TDD steps

**RED 1 — X1 and X2, the byte compares.** They are the contract; write them first. Expect a real
byte diff on the first run if anything in Part 4's serializer is off — dump both hex windows in the
failure message so the diff is readable (offset, expected, actual).

**RED 2 — X3/X4, acceptance by both fsck implementations.**

**RED 3 — X5/X6/X7/X7b, the gate rows.** X7 asserts **both** sides: git's exit 128 *and* tsgit's
typed refusal *and* the empty pack dir.

**RED 4 — X8/X9, the other write surfaces.**

**RED 5 — X10 and the scaled case.**

**GREEN.** These rows should pass against Parts 4–5 as landed. **A failure here is a defect in the
writer, never a licence to relax the assertion** — Pins B/C are empirical, not aspirational.
If a row fails, fix the writer and re-run Part 4's and Part 5's gates before re-running this one.

**REFACTOR.** Collapse repeated scratch-dir plumbing into one local helper inside the file; keep
each `it` to one behaviour. Do not extract into `interop-helpers.ts` unless a second file needs it.

**Verify the audit closes.** Run `npm run check:write-surfaces` and confirm
`reports/write-surface-coverage.json` reports **zero gaps** with
`tooling/audit-write-surfaces.allowlist.json` still `{"surfaces": []}`.

### Gate

```
npx vitest run test/integration/rev-write-interop.test.ts \
  && npm run check:types \
  && npm run check:write-surfaces \
  && npm run check:test-pyramid \
  && ./node_modules/.bin/biome check test/integration/rev-write-interop.test.ts
```

### Commit

`test(pack): pin the reverse-index write surface against canonical git`

---

## Phase-boundary gate

After Part 6, from the worktree root:

```
npm run validate
```

Watch specifically for:
- **`check:write-surfaces`** — zero gaps, allowlist untouched (requirement 11).
- **`test:coverage`** — 100 % on `src/domain/**`; the new serializer and `pack-order.ts` are fully
  covered by the unit + property tests.
- **`check:spelling`** — the cspell dictionary lags on some British `-ising/-ised` forms; the full
  `validate` is the authority, the commit hook may not catch it.
- **`check:deps`** (`npm outdated`) is a pre-PR gate; `@ls-lint/ls-lint` and `typescript` are the
  standing exceptions.

Before pushing: regenerate `reports/api.json` one final time (`npm run docs:json`) and confirm it is
committed — `check:doc-typedoc` is a **prepush** gate, and a green cached `validate` can precede a
red prepush.

No bench gate: the added cost is one `Uint32Array` sort plus one digest over `4N + 52` bytes per
pack write, invisible beside the pack's own inflate and hash. If a fetch bench moves, that is a
defect, not a budget negotiation.

## Explicitly out of scope (do not drift)

`.bitmap` / multi-pack-index / commit-graph **writing**; `repack`/`gc`/`prune`/`maintenance`;
global and system config reading; artefact file mode (git writes `0444`, tsgit writes `0644` for
`.pack`/`.idx` today and the `.rev` inherits that — the divergent-file count goes 2 → 3 and this
change does not open the question); `.git/sequencer/opts`' `hasTrueKey` coercion
(`src/application/commands/internal/sequencer-state.ts:99` — tool-written repository state, not
user configuration); `extensions.*` beyond `worktreeConfig`; delta compression in the pack writer; a
plumbing `index-pack` command or a `--rev-index`-style flag; any per-call `writeReverseIndex`
option on `packObjects`/`fetchPack`.
