# Plan — Benchmark regression gate in CI

> Source: design doc `docs/design/bench-regression-gate.md` · ADRs `487, 488, 489, 490, 491`
> The plan is the implementation script AND the knowledge handoff. Part agents start with
> zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below (`## Part N` / `### Context` / `### TDD steps` /
> `### Gate` / `### Commit`) — the plan phase cannot close without it.
> No ADR/phase/backlog number appears in any source, test, or YAML — only here and in the PR body.

## Scope

A **CI/tooling** change. It adds **no library or command surface** — no command, error code,
public export, barrel entry, facade method, or `Repository` change. The surface-gates context
(`.claude/workflow/surface-gates.md`) therefore does **not** apply: nothing here is reachable by
library users. The one new `export` (`SnapshotEntry` in `tooling/bench-to-snapshot.ts`) is a
**tooling-internal** type shared between two `tooling/*.ts` modules — it never crosses into `src/`
or the package entry, so it trips no api.json / doc-coverage / browser-surface / exhaustiveness
gate. `reports/api.json` is **not** regenerated (typedoc reports `src/` only; `tooling/**` is not
in the typedoc surface — verify: no `tooling/**` path in the typedoc entry points).

Net deliverable files:

- **`tooling/bench-to-snapshot.ts`** — one-word change: `export` the `SnapshotEntry` interface
  (Part 1).
- **`tooling/bench-check.ts`** — new: pure `compareToBaseline` + `gatedEntries` filter (Part 1),
  then `main()` I/O wrapper (Part 2).
- **`tooling/test/unit/bench-check.test.ts`** + **`tooling/test/unit/bench-check.properties.test.ts`**
  + **`tooling/test/unit/arbitraries.ts`** — new unit + property tests (Part 1).
- **`.github/workflows/ci.yml`** — edit the existing `benchmark-compare` job: replace the inline
  `node <<'SCRIPT'` heredoc with an invocation of the new tool; keep `continue-on-error: true`
  (Part 3).
- **`package.json`** — optional non-wireit `bench:check` passthrough for local ergonomics
  (Part 4, **skippable** — nothing gates on it).

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it must earn it.
  No standalone test-only parts for FEATURE code. EXCEPTION: test-infra-only and config/CI-only
  parts (tooling config, CI YAML, `package.json` scripts) with no `src/` delta ARE legitimately
  standalone. **Every part here is tooling/CI/config-only; there is no `src/` delta anywhere in
  this feature.**
- Part 1 folds its unit test + property sibling into the slice that creates the code under test
  (per the RED→GREEN→REFACTOR rule); it is not a standalone test part because the pure function it
  exercises is born in the same part.
- Part 2 (`main()` I/O glue) and Part 3 (CI YAML) have **no vitest red/green** — their verification
  is stated explicitly per part (type-check + `actionlint` + reasoning + manual smoke), not a
  pretend failing unit test.

## Coverage / mutation note (applies to every part)

`tooling/**` and `test/bench/**` are **outside** the `vitest.config.ts` coverage `include`
(`src/{domain,ports,adapters/node,adapters/memory,operators}/**` only — verified) — same precedent
as `tooling/profile.ts`, `tooling/bench-memory.ts`, `bench-summarize.ts`, `bench-to-snapshot.ts`.
So `bench-check.ts` carries **no coverage or mutation gate**. Its unit test still **runs**:
`tooling/test/unit/**/*.test.ts` is in the `unit` vitest project `include` (verified,
`vitest.config.ts` line 22). **Do not chase 100% coverage or a 0-survivor mutation score on
`bench-check.ts`** — neither gate touches it. The test exists for correctness (asymmetry, boundary,
scope filter), not a coverage number.

## Biome note (applies to Parts 1, 2, 4 — read before running the part gate)

`biome.json` `files.includes` covers `src/**`, `test/**`, root `*.ts`, `*.json`, and
**only** `tooling/profile.ts` / `tooling/profile-*.ts` / `tooling/test/unit/profile-*.test.ts` —
it does **NOT** include `tooling/bench-check.ts` or `tooling/test/unit/bench-check*.test.ts`.
Empirically confirmed: `biome check tooling/bench-to-snapshot.ts` → *"Checked 0 files … These paths
were provided but ignored"*, **exit 0**. So the part gate's `biome check <touched-files>` step is a
**no-op that exits 0** for the new tooling `.ts` files — it neither lints nor formats them, and
neither does `npm run validate`. **Consequence:** formatting/lint discipline on `bench-check.ts`
and its tests is a **manual mirror-the-sibling** obligation — match `bench-to-snapshot.ts`'s exact
biome style by hand (2-space indent, single quotes, trailing commas, `always` semicolons, arrow
parens, ≤100 line width, `import type` for type-only imports, `.js` specifiers on relative imports).
`package.json` (Part 4) **is** in `*.json` scope, so biome *does* lint it. The CI YAML (Part 3) is
not TS/JSON — biome does not lint it; `actionlint` is its checker.

---

## Part 1 — Export `SnapshotEntry` + pure `compareToBaseline` core (test-first)

### Context

**Goal.** Introduce the pure, deterministic comparison core with zero I/O — the unit SUT — plus
the `tsgit`-scope filter, driven test-first. Also make `SnapshotEntry` shareable by adding `export`
to it in the sibling module. No `main()` yet (Part 2).

**File to change — `tooling/bench-to-snapshot.ts` (one word).** The interface is currently declared
**without** `export` (verified — lines 34-38):

```ts
interface SnapshotEntry {
  readonly name: string;
  readonly unit: 'ms';
  readonly value: number;
}
```

Change line 34 to `export interface SnapshotEntry {`. `toSnapshotEntries` (line 45) and `RawReport`
(line 30) are **already** `export`ed (verified) — do not touch them. This is the only change to this
file. `noUnusedVariables`/`noUnusedImports` do not fire (the type is now imported by `bench-check.ts`).

**File to create — `tooling/bench-check.ts` (new; pure core only in this part).**

- Header: `#!/usr/bin/env node` shebang + a `/** … */` module doc (mirror `bench-to-snapshot.ts`
  lines 1-10 house style — say what the tool does: same-runner base-vs-head per-scenario median-ms
  comparison, advisory).
- Import the shared types from the sibling (note the `.js` specifier — the test sibling already uses
  `'../../bench-to-snapshot.js'`, so from `tooling/bench-check.ts` it is `./bench-to-snapshot.js`):

  ```ts
  import { type RawReport, type SnapshotEntry, toSnapshotEntries } from './bench-to-snapshot.js';
  ```

  `RawReport` and `toSnapshotEntries` are used in Part 2's `main()`; in Part 1 only `SnapshotEntry`
  is consumed by the pure function. **To avoid a `noUnusedVariables`/`noUnusedImports` complaint at
  type-check time in Part 1**, import in Part 1 ONLY what Part 1 uses (`SnapshotEntry`), and widen
  the import in Part 2 when `main()` lands. (Biome does not lint this file — see the Biome note —
  but `tsc --noEmit` via `check:types` still compiles it, and an unused import is a `tsc` error only
  under `noUnusedLocals`; verify `tsconfig.json` `noUnusedLocals` — if set, keep the import minimal;
  if not set, a wider import is harmless. Keep it minimal regardless for cleanliness.)

- **Threshold source — the single documented default.** Declare a module constant as the one
  documented default:

  ```ts
  const DEFAULT_THRESHOLD_PCT = 10;
  ```

  The pure `compareToBaseline` takes the threshold **explicitly** via `policy.thresholdPct` (no env
  coupling in the pure core — keeps it deterministic and unit-testable). `main()` (Part 2) resolves
  the effective threshold as `Number(process.env.REGRESSION_THRESHOLD ?? DEFAULT_THRESHOLD_PCT)` —
  so the **constant is the pinned default** and the pre-existing CI env var `REGRESSION_THRESHOLD`
  is the documented **tuning knob**, tunable in one place (the YAML `env:` or, absent it, the
  constant). This is the single documented source required by the design; state it in the module doc.

- **Filter helper** — keep only `tsgit`-named entries (key suffix ` > tsgit`), dropping
  `isomorphic-git`:

  ```ts
  const TSGIT_KEY_SUFFIX = ' > tsgit';
  const gatedEntries = (entries: readonly SnapshotEntry[]): readonly SnapshotEntry[] =>
    entries.filter((entry) => entry.name.endsWith(TSGIT_KEY_SUFFIX));
  ```

  `gatedEntries` is **tooling-internal** (not exported) — only `compareToBaseline`'s callers
  (`main()`) and the test use it. Export it too so the test can exercise the filter directly if
  preferred; both `compareToBaseline` and `gatedEntries` are exported (module-internal to `tooling/`
  — no barrel, no api.json impact).

- **Row + result shape** (the exported verdict types the test asserts against):

  ```ts
  type Verdict = 'pass' | 'regress' | 'new' | 'missing';

  export interface CompareRow {
    readonly key: string;
    readonly baseMs: number | null;
    readonly currentMs: number | null;
    readonly deltaPct: number | null;
    readonly verdict: Verdict;
  }

  export interface CompareResult {
    readonly rows: readonly CompareRow[];
    readonly failed: boolean;
  }
  ```

- **The pure function** — exact signature (from the design, ADR-491):

  ```ts
  export const compareToBaseline = (
    base: readonly SnapshotEntry[],
    current: readonly SnapshotEntry[],
    policy: { readonly thresholdPct: number },
  ): CompareResult => { … };
  ```

  Algorithm (design §Comparison algorithm, steps 3-6 — the caller runs `gatedEntries` on each side
  before calling, so `compareToBaseline` receives already-filtered entries; the test feeds it
  gated + un-gated mixes to prove BOTH the filter path via `gatedEntries` AND the join):

  1. Build a `Map<key, value>` from `base` and from `current` (key = `entry.name`, value =
     `entry.value` — median-ms, smaller-better). On a duplicate key, last write wins (raw.json is
     one entry per scenario after gating — a dup is not expected; do not special-case it).
  2. Iterate the **union** of keys, sorted (deterministic row order — sort with default string
     compare so the table is stable across runs, matching the legacy heredoc's `allNames.sort()`).
  3. Per key:
     - **in current, not in base** → `{ baseMs: null, currentMs, deltaPct: null, verdict: 'new' }`.
     - **in base, not in current** → `{ baseMs, currentMs: null, deltaPct: null, verdict: 'missing' }`.
     - **in both, base value is 0** → division guard: `{ baseMs: 0, currentMs, deltaPct: null,
       verdict: 'missing' }` (treat as unmeasurable — never `Infinity`, never a fabricated
       `regress`; mirror `bench-summarize.ts`'s `formatSpeedup` `b === 0 → 'n/a'` guard — read that
       function for the precedent, do not import it). **Decision to pin:** a zero-base row uses
       verdict `missing` (unmeasurable, warned-not-flagged) with `deltaPct: null` — it must **not**
       flag. Assert this exact pair in the test.
     - **in both, base value > 0** → `deltaPct = ((currentMs − baseMs) / baseMs) * 100`; verdict is
       `'regress'` iff `deltaPct > policy.thresholdPct` (strict `>`; **asymmetric** — a negative
       delta / improvement is never `regress`), else `'pass'`.
  4. `failed = rows.some((row) => row.verdict === 'regress')`.

  Keep it under the 20-line function ceiling by extracting the per-key classification into a small
  pure helper (`classifyRow(key, baseMs, currentMs, thresholdPct): CompareRow`) — early returns for
  the `new` / `missing` / zero-base cases, then the delta computation. Immutable throughout (`map`,
  no mutation of inputs).

**Test file — `tooling/test/unit/bench-check.test.ts` (new).**

- Runs in the `unit` project (`tooling/test/unit/**/*.test.ts` is in the `include` — verified). No
  coverage gate (see Coverage note).
- **Conventions (CLAUDE.md):** `describe('Given …')` > `describe('When …')` > `it('Then …')` tree;
  AAA body with `// Arrange` / `// Act` / `// Assert` section comments; **`sut` = the FUNCTION under
  test** (`const sut = compareToBaseline;` then `const result = sut(base, current, policy);`), the
  returned verdict in **`result`**. **Do NOT copy the sibling `bench-to-snapshot.test.ts` mistake**
  (it names the *result* `sut` — that contradicts CLAUDE.md; verified at line 13). Import from the
  `.js` specifier: `import { compareToBaseline, gatedEntries } from '../../bench-check.js';` and the
  `SnapshotEntry` type from `'../../bench-to-snapshot.js'` if you build fixtures typed.
- **Fixture helper** (local to the test): a tiny `entry(name, value): SnapshotEntry` builder
  (`{ name, unit: 'ms', value }`) so cases read as data.
- **Cases (each its own `it`, boundary cases isolated per CLAUDE.md mutation-resistance — assert the
  numeric `deltaPct` AND the `verdict` enum AND `failed`, never verdict-only):**
  - Regress **above** threshold: base `{'x > tsgit': 100}`, current `{'x > tsgit': 120}`, policy
    `{thresholdPct: 10}` → row `deltaPct` = `20`, `verdict: 'regress'`, `failed: true`.
  - Pass **below** threshold: base 100, current 105, N=10 → `deltaPct` = `5`, `verdict: 'pass'`,
    `failed: false`.
  - **Boundary — exactly at threshold**: base 100, current 110, N=10 → `deltaPct` = `10`, and since
    the comparator is strict `>`, `verdict: 'pass'`, `failed: false`. (This is the test that kills
    the `>` vs `>=` mutant — assert `'pass'` explicitly.)
  - **Boundary — one step above**: base 100, current `110.0001` (or `111`), N=10 → `deltaPct` just
    over 10, `verdict: 'regress'`. (Pairs with the exactly-at case to pin the comparator.)
  - **Improvement never regresses** (asymmetry): base 100, current 50, N=10 → `deltaPct` = `-50`,
    `verdict: 'pass'`, `failed: false`. (Kills the "improvement flags" mutant / a `Math.abs` mutant.)
  - **New scenario** (in current, not base): base `[]`, current `{'y > tsgit': 42}` → row
    `verdict: 'new'`, `baseMs: null`, `deltaPct: null`, `failed: false`.
  - **Missing scenario** (in base, not current): base `{'z > tsgit': 42}`, current `[]` → row
    `verdict: 'missing'`, `currentMs: null`, `deltaPct: null`, `failed: false`.
  - **Zero base value** (division guard): base `{'w > tsgit': 0}`, current `{'w > tsgit': 5}` →
    `deltaPct: null`, `verdict: 'missing'`, `failed: false`, and NOT `Infinity`. (Assert
    `Number.isFinite` is not violated — e.g. `expect(result.rows[0].deltaPct).toBeNull()`.)
  - **tsgit-only scope filter** via `gatedEntries`: given a mixed array
    `[entry('s > tsgit', 10), entry('s > isomorphic-git', 20)]` → `gatedEntries(mixed)` returns only
    the `> tsgit` entry; feed both sides' `gatedEntries` output into `compareToBaseline` and assert
    NO row's `key` ends in `isomorphic-git` (proves the iso-git drop — ADR-490).
  - **Empty both**: base `[]`, current `[]` → `rows: []`, `failed: false` (identity — also covered by
    the property test, but keep one example for documentation).

**Property test — `tooling/test/unit/bench-check.properties.test.ts` (new; INCLUDED — lens 2 fits).**

`compareToBaseline` is a **compositional aggregator** (reduces a set of per-scenario deltas to a
`failed` verdict) — CLAUDE.md property-test **lens 2** applies. Stated as **invariants**, not by
re-implementing the reduction as an oracle (that would be the tautology CLAUDE.md forbids):

- **Identity / empty**: `compareToBaseline([], [], {thresholdPct: N}).failed === false` and
  `rows` is `[]`.
- **A regressing append flips `failed` true**: given any arbitrary base/current entry sets that do
  NOT already flag, appending one matched pair whose delta strictly exceeds N (base `b > 0`, current
  `b * (1 + (N + ε)/100)`) to BOTH sides makes `failed === true`.
- **Improvements/below-N appends never flip `failed`**: appending only matched pairs whose delta is
  `≤ N` (including negative / improvements) to a non-flagging set keeps `failed === false`.

- **Arbitraries** — co-located in **`tooling/test/unit/arbitraries.ts`** (new; the repo convention
  is a co-located `arbitraries.ts` in the same test directory — verified: property tests under
  `test/unit/**` co-locate generators; there is no pre-existing `tooling/**/arbitraries.ts`, so this
  file is new). Export a `snapshotEntryArb` (fc arbitrary of `SnapshotEntry` with a `' > tsgit'`
  key suffix and a positive finite `value`) and a `gatedEntrySetArb` (array of them with unique
  keys). Import `fast-check` (`import fc from 'fast-check';` — devDep `4.9.0`, verified).
- **Budget:** `numRuns: 100` (invariant tier per CLAUDE.md). Never commit a seed. Same
  describe/it/AAA/`sut` conventions; `Given` reads "Given an arbitrary gated entry set".
- **Not a round-trip pair** — lens 1 does not apply; do NOT write a `parse(serialize(x)) ≡ x`
  property. The invariants above are the whole contract.

### TDD steps

- **RED** — write `bench-check.test.ts` (all cases above) + `bench-check.properties.test.ts`
  against the not-yet-existing `compareToBaseline` / `gatedEntries`. Run
  `npx vitest run tooling/test/unit/bench-check.test.ts tooling/test/unit/bench-check.properties.test.ts`.
  Expected failure: **module resolution error** — `Cannot find module '../../bench-check.js'`
  (the file does not exist yet). This is the RED signal.
- **RED (compile)** — also add the `export` to `SnapshotEntry` in `bench-to-snapshot.ts` first (the
  test/property files and `bench-check.ts` import the type; without the `export`, `check:types`
  errors `Module '"./bench-to-snapshot"' declares 'SnapshotEntry' locally, but it is not exported`).
- **GREEN** — create `tooling/bench-check.ts` with `DEFAULT_THRESHOLD_PCT`, `gatedEntries`,
  `classifyRow`, `compareToBaseline`, and the exported row/result types (no `main()` yet). Run the
  same vitest command → all example + property cases pass. Run `npm run check:types` → green.
- **REFACTOR** — confirm every function is ≤20 lines (extract `classifyRow` if `compareToBaseline`
  is long), early returns for the `new`/`missing`/zero-base branches, immutable throughout, no magic
  numbers (the threshold flows through `policy`; `DEFAULT_THRESHOLD_PCT` and `TSGIT_KEY_SUFFIX` are
  named constants). Re-run the two test files → still green.

### Gate

`npx vitest run tooling/test/unit/bench-check.test.ts tooling/test/unit/bench-check.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check tooling/bench-check.ts tooling/bench-to-snapshot.ts tooling/test/unit/bench-check.test.ts tooling/test/unit/bench-check.properties.test.ts tooling/test/unit/arbitraries.ts`

Note (Biome note above): **every** path in this `biome check` invocation is config-ignored —
`bench-check.ts`, `bench-to-snapshot.ts`, and all three test files are outside biome's
`files.includes` (only `tooling/profile*` is included). So `biome check` reports *"Checked 0
files … paths were provided but ignored"* and **exits 0** — a no-op, not a lint. That is expected
and green; the real formatting discipline is the manual mirror-the-sibling obligation. `check:types`
is the meaningful automated gate here (`tsconfig.json` `include` covers `tooling/**/*.ts` — verified,
`noUnusedLocals`/`noUnusedParameters` both on, so an unused import IS a hard `tsc` error — keep
Part-1 imports minimal).

### Commit

`feat(bench): pure per-scenario median-ms regression comparator`

---

## Part 2 — `main()` I/O wrapper + two-argv interface

### Context

**Goal.** Wrap the Part-1 pure core in a thin CLI `main()` that reads **two `raw.json` argv paths**
(base, head), flattens both, gates both, compares, prints the per-scenario table, appends it to
`$GITHUB_STEP_SUMMARY`, writes the PR-comment markdown file, and exits non-zero iff `failed`. No
change to the pure core; this part only adds I/O glue below it in the same file.

**File to change — `tooling/bench-check.ts`** (add `main()` + the direct-invocation guard;
widen the top import to also pull `RawReport` + `toSnapshotEntries` now that `main()` uses them):

```ts
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RawReport, type SnapshotEntry, toSnapshotEntries } from './bench-to-snapshot.js';
```

Mirror `bench-to-snapshot.ts` (lines 56-77) for the idioms — read those lines; reuse the SAME
`invokedDirectly()` guard verbatim and the SAME `main().catch(...)` error handler:

- **Argv interface** (design §Input interface — two `raw.json` paths):
  - `const basePath = process.argv[2];` `const headPath = process.argv[3];`
  - If either is `undefined` → **throw** a clear usage error (no swallowed error):
    `throw new Error('usage: bench-check <base-raw.json> <head-raw.json>');`. This is caught by the
    shared `main().catch → stderr → process.exit(1)` handler.
- **Read + flatten + gate + compare:**
  ```ts
  const readReport = async (p: string): Promise<readonly SnapshotEntry[]> =>
    gatedEntries(toSnapshotEntries(JSON.parse(await readFile(p, 'utf8')) as RawReport));
  ```
  A bad path / unreadable file → `readFile` rejects → propagates to `main().catch` (loud, non-zero
  exit; tolerated in CI by `continue-on-error`, but never silent).
- **Threshold resolution** (Part-1 decision): 
  `const thresholdPct = Number(process.env.REGRESSION_THRESHOLD ?? DEFAULT_THRESHOLD_PCT);`
  (Guard: if `Number(...)` is `NaN` — e.g. a malformed env — throw a clear error rather than
  silently comparing against `NaN`. No swallowed error.)
- **Render** the per-scenario table (scenario | base ms | current ms | delta% | verdict). Build the
  markdown once (mirror the legacy heredoc's comment shape at ci.yml lines 613-623, but with the
  new columns/metric): a heading, a `> Threshold: N% (median-ms, same-runner, advisory)` line, a
  table with rows from `result.rows`, and a trailer line reflecting `result.failed`
  (`regression flagged — advisory` vs `no regression`). Format `deltaPct` with a sign and one
  decimal; render `null` deltas (new/missing/zero-base) as `—` / `n/a`. Verdict cells: plain words
  (`regress` / `pass` / `new` / `missing`) — no ADR/phase refs.
- **Emit** (CQS — separate the pure build from the writes):
  - `process.stdout.write(table + '\n');`
  - append to the step summary: `await appendFile(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', '\n' + table + '\n');`
    (mirror the legacy `appendFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/null', …)` — the
    `/dev/null` fallback keeps local runs working off-CI).
  - write the PR-comment markdown file to the path the "Post PR comment" step reads —
    **`/tmp/bench-comment.md`** (verified: ci.yml line 625/650/655 read `/tmp/bench-comment.md`).
    Use `writeFile('/tmp/bench-comment.md', comment, 'utf8')`. Keep the file path a named constant.
- **Exit code** (design §How the advisory tool signals): `process.exit(result.failed ? 1 : 0);`.
  The tool is honestly red on a flagged regression for local use; the advisory posture is enforced
  ENTIRELY by `continue-on-error: true` on the CI step (Part 3), not by softening the tool.
- **Empty-data guard:** if BOTH sides gate to `[]` (no `> tsgit` entries — e.g. a `SKIP`ped bench
  run), `result.rows` is `[]` and `failed` is `false` → still write a "no benchmark data to compare"
  comment and exit 0 (mirror the legacy `allNames.length === 0 → exit 0` branch at lines 608-611).
  This is a `main()` concern (the pure core already returns `{rows: [], failed: false}` for empty
  input — verified by the Part-1 empty-both test); `main()` just chooses friendlier prose.

**No `main().catch` swallowing** — reuse `bench-to-snapshot.ts`'s exact handler:
`main().catch((err: unknown) => { process.stderr.write(...); process.exit(1); });` under the
`if (invokedDirectly())` guard.

### TDD steps

- **No vitest red/green for this part.** `main()` is thin I/O glue over the Part-1 pure core, which
  is already fully unit-tested; the design and Test strategy explicitly place the I/O boundary
  outside the unit SUT (tooling has no coverage/mutation obligation — see Coverage note). Writing a
  unit test that stubs `process.argv` / `readFile` / `process.exit` would test the Node runtime, not
  our logic. **Do NOT invent a failing unit test here.** Verification is:
  - **`npm run check:types`** compiles the new `main()` (the meaningful automated gate — `tooling/**`
    is in `tsconfig` include).
  - **Manual smoke** in a mktemp throwaway (NOT the worktree — contract): write two tiny synthetic
    `raw.json` files to `$(mktemp -d)`, run
    `node --experimental-strip-types tooling/bench-check.ts "$tmp/base.json" "$tmp/head.json"`,
    confirm the table prints, `/tmp/bench-comment.md` is written, and the exit code is `1` when the
    head is >N% slower / `0` otherwise. Also run with a missing argv → confirm the usage error to
    stderr + non-zero exit. Delete the mktemp dir. This is a smoke check, not a committed test.
- REFACTOR: keep `main()` ≤20 lines by extracting `readReport`, `renderTable(result, thresholdPct)`,
  and the emit block into small helpers; early return on the empty-both branch.

### Gate

`npm run check:types && ./node_modules/.bin/biome check tooling/bench-check.ts`

(As in Part 1, the `biome check` is a config-ignored no-op exit-0 for this file; `check:types` is
the real gate. The manual mktemp smoke above is the behavioural verification — record its result in
the commit's work, do not commit the throwaway files.) The vitest suite from Part 1 must still pass
(`npx vitest run tooling/test/unit/bench-check.test.ts tooling/test/unit/bench-check.properties.test.ts`)
— `main()` must not change the pure core's behaviour.

### Commit

`feat(bench): bench-check CLI over two raw.json paths`

---

## Part 3 — Rewire the `benchmark-compare` CI job onto the extracted tool

### Context

**Goal.** Replace the untestable inline `node <<'SCRIPT'` heredoc in the existing
`benchmark-compare` job with an invocation of the Part-1/2 tool. Keep the entire same-runner recipe
and the `continue-on-error: true` advisory posture. No new job, no change to `benchmark-snapshot` or
`bench.yml`.

**File to change — `.github/workflows/ci.yml`, job `benchmark-compare`** (verified at lines
510-663). Keep **unchanged**: the `if` (line 511), `needs` (512), `runs-on` (513),
`continue-on-error: true` (516 — **KEEP; advisory, ADR-488**), `permissions` (517-518), the
"Checkout base branch" → `setup` → "Build and bench base branch"
(`cp reports/benchmarks/raw.json /tmp/base-bench.json`) → "Checkout PR branch" → `npm ci` →
"Build and bench PR branch" (`cp … /tmp/pr-bench.json`) steps (520-545), and the entire
"Post PR comment" step (636-663 — it reads `/tmp/bench-comment.md`, which the tool now writes).

**Edit — the "Compare and comment" step (lines 547-634):**

- Update the step comment on the job (lines 514-515) so the prose is honest: it currently says
  "Informative only … Same-runner benchmarking measures too much noise to block on." — keep the
  "advisory / never blocks" wording, and (if any inline prose says "ops/s" or "5%") correct it to
  "median-ms, asymmetric, tsgit-scoped, N ≈ 10%". No ADR/phase/backlog number in the YAML.
- In the step's `env:` (lines 548-551): keep `GH_TOKEN` and `PR_NUMBER`; change
  `REGRESSION_THRESHOLD: "5"` → `REGRESSION_THRESHOLD: "10"` (the tuning knob; the tool falls back to
  its `DEFAULT_THRESHOLD_PCT = 10` constant if the env is absent — either way the effective default
  is 10, one documented source).
- **Replace the entire heredoc** `run:` body (lines 552-634 — the `node << 'SCRIPT' … SCRIPT` block,
  its `hz`-based `extractBenchmarks`, its `delta < -threshold` regression sense, its comment
  assembly) with the single invocation:
  ```yaml
  run: |
    node --experimental-strip-types tooling/bench-check.ts /tmp/base-bench.json /tmp/pr-bench.json
  ```
  The tool prints the table to stdout, appends it to `$GITHUB_STEP_SUMMARY`, and writes
  `/tmp/bench-comment.md` (the exact file the "Post PR comment" step already reads). The tool exits
  non-zero on a flagged regression, and `continue-on-error: true` tolerates it — the advisory
  contract, unchanged. (Because `continue-on-error` is on the job/step, the non-zero exit does not
  fail the run.)
- **Metric/scope/threshold delta** now realised by the tool, not the YAML: median-ms (not `hz`),
  asymmetric (improvements never flagged), `tsgit`-only (iso-git filtered), N=10 (not 5). No logic
  lives in the YAML anymore — the past quote-collapse / untestable-heredoc pain is retired.
- **Verify** the "Post PR comment" step's fallback still holds: it writes "Benchmark comparison
  failed to generate." if `/tmp/bench-comment.md` is empty (lines 650-652). The tool always writes a
  non-empty comment (table or "no benchmark data"), so the happy path posts the tool's markdown.

### TDD steps

- **No vitest red/green** — a CI YAML edit has no unit test; pretending it does would be dishonest.
  The comparison *logic* is already unit-tested (Part 1); this part is a mechanical wiring swap.
  Verification:
  - **`actionlint .github/workflows/ci.yml`** (verified available: `/opt/homebrew/bin/actionlint`) →
    must report no new errors for the edited job (valid YAML, valid step/`run` shape, no shell
    lint regression from the simplified `run:`).
  - **Reasoning/consistency check:** the tool is invoked with exactly two argv paths in the order
    `base` then `head` (`/tmp/base-bench.json` `/tmp/pr-bench.json`) — matching `process.argv[2]` =
    base, `process.argv[3]` = head from Part 2. The comment-file path (`/tmp/bench-comment.md`) and
    the summary env (`GITHUB_STEP_SUMMARY`) both match what the tool writes and what the downstream
    step reads. Cross-check these three couplings explicitly before committing.
  - The end-to-end proof is the **PR's own base-vs-head run** on a live runner (design §Rollout) —
    it exercises the gate once this lands; no separate rollout capture is needed.

### Gate

`actionlint .github/workflows/ci.yml`

(No vitest/biome for a YAML file. The Part-1 suite is unaffected — do not re-run it here unless the
phase-boundary `npm run validate` prompts. `npm run validate` at the phase boundary does not lint
YAML either; `actionlint` is the YAML authority and is run here in-part.)

### Commit

`ci(bench): drive benchmark-compare via the extracted regression tool`

---

## Part 4 — Optional local `bench:check` passthrough (SKIPPABLE)

### Context

**Optional, non-gating — the plan may land or skip this part with no effect on the feature.** The CI
job (Part 3) invokes the tool directly with two argv paths; nothing in CI or `validate` depends on a
`package.json` script. This part adds a **local-ergonomics** passthrough only.

**File to change — `package.json`, the `"scripts"` block.** Add a **plain, non-wireit** passthrough
(it CANNOT be a wireit script — the two `raw.json` inputs come from two separate checkouts, so there
is no single working-tree `raw.json` for a wireit `files`/`output` graph to key on; design §"No
wireit `bench:check` script"). Place it alphabetically near the other `bench:*` scripts.
**Exact precedent:** `bench:fixture` and `bench:memory` (verified, `package.json` lines 193/195) are
already plain non-wireit `node --experimental-strip-types tooling/*.ts` passthroughs — slot
`bench:check` consistently among the `bench:*` block:

```json
"bench:check": "node --experimental-strip-types tooling/bench-check.ts"
```

Invoked as `npm run bench:check -- <base-raw.json> <head-raw.json>`. It is **not** wired into any
CI job, has **no** wireit `dependencies`/`files`/`output`, and nothing gates on it. Do NOT add a
wireit entry for it (adding one under the `wireit` block would imply a single-input graph that does
not exist). Keep it a bare passthrough string in `"scripts"`.

### TDD steps

- **No vitest red/green** — a `package.json` script string has no unit test. Verification:
  - **`npm run bench:check -- "$tmp/base.json" "$tmp/head.json"`** against the same mktemp synthetic
    `raw.json` files from Part 2's smoke (throwaway dir, NOT the worktree) → confirms the script
    forwards `--`-passed argv to the tool and produces the same table/exit code as the direct
    `node …` invocation. Delete the mktemp dir after.
  - **`npm run check:types`** still green (package.json change does not affect types, but the
    phase-boundary `validate` re-runs it; a malformed JSON edit would fail `biome check package.json`
    — see the Gate).

### Gate

`./node_modules/.bin/biome check package.json && npm run check:types`

(`package.json` IS in biome's `files.includes` via `*.json`, so `biome check package.json` is a
**real** JSON-validity/format gate here — unlike the tooling `.ts` no-op. Confirm the script slots
in without breaking JSON or biome's key ordering/format.)

### Commit

`chore(bench): local bench:check passthrough for the regression tool`

---

## Phase-boundary gate (after all parts)

`npm run validate` — the full quality gate. Expectations specific to this feature:

- **Coverage:** unchanged — no `src/**` file changed, so the 100% coverage gate over
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**` is unaffected. `bench-check.ts` is
  outside the coverage `include` and contributes nothing (see Coverage note). **Do not expect or
  chase a coverage number on `bench-check.ts`.**
- **Mutation:** not run by `validate`; and even under the mutation job, `tooling/**` is outside the
  mutated surface — `bench-check.ts` carries no mutation obligation.
- **`check:types`** compiles `tooling/**` (including the two new files) — the load-bearing automated
  gate for this feature.
- **Biome / `check`** does not lint the new `tooling/bench-check*.ts` files (config-ignored — Biome
  note); it DOES lint `package.json` (Part 4). Manual mirror-the-sibling formatting on the `.ts`
  files is the standing obligation.
- **`actionlint`** is not part of `npm run validate` — Part 3's in-part `actionlint` run is the YAML
  authority; the CI `megalinter`/actions-lint job is the remote backstop.
- **api.json / doc-coverage / browser-surface / exhaustiveness gates:** untouched — this feature
  adds no public/library surface (Scope). If `validate` flags any of these, something outside this
  plan's scope changed — stop and escalate `{ unit, reason, ≤3 options }`.
