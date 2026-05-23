# Phase 19.2 — Testing-pyramid audit · Implementation plan

Derived from `docs/design/phase-19-2-testing-pyramid-audit.md` +
ADRs 104–108. TDD throughout. One concept per commit.

## Working assumptions

- Node ≥ 22.22.1 (engines). Use `node:fs/promises` + the stable `node:fs.glob`
  (added in 22.x) for directory walking — no `fast-glob` dep.
- `minimatch` (10.2.5) is already a devDep — used for glob match in the
  manifest classifier.
- Script is invoked as
  `node --experimental-strip-types scripts/audit-test-pyramid.ts` — matches
  the pattern of `scripts/check-mutation-budgets.ts` and
  `scripts/check-doc-coverage.ts`. No `tsx` dep needed.
- Pure helpers under `scripts/test-pyramid/**`; I/O entry in
  `scripts/audit-test-pyramid.ts`. Unit tests under
  `test/unit/scripts/test-pyramid/`; an end-to-end integration test under
  `test/integration/scripts/`.

## Slice ordering

Each slice is its own commit. Red → Green → Refactor → `npm run validate`
(scoped) → commit. Slices are ordered so each lands a working vertical:
manifest first, then classification, then heuristics, then reporting, then
wiring.

---

### Slice 1 — Manifest schema + JSON

**Test first** (`test/unit/scripts/test-pyramid/parse-manifest.test.ts`):

- Given a well-formed manifest, When parsed, Then returns a typed
  `PyramidManifest` with three tiers and two heuristics.
- Given a manifest missing `tiers`, When parsed, Then throws with a
  message naming the missing field.
- Given a manifest with a tier whose `target+warnBelow` are inverted,
  When parsed, Then throws.
- Given a manifest with a heuristic regex that fails to compile, When
  parsed, Then throws.
- Given a manifest with an unknown heuristic key, When parsed, Then
  throws.

**Implement**:

1. `test-pyramid-budgets.json` at repo root (values per design §6.2).
2. `scripts/test-pyramid-budgets-schema.json` (JSON Schema draft-07).
3. `scripts/test-pyramid/parse-manifest.ts`:
   - `parseManifest(raw: string): PyramidManifest`
   - Hand-rolled validator (no Zod), matching `mutation-budgets.ts`.
   - Exports `PyramidManifest`, `TierDefinition`, `HeuristicConfig` types.

**Verify**: vitest unit pass. No outward effect yet — Slice 1 is types + data.

**Commit**: `feat(scripts): pyramid-audit manifest schema + parser`

---

### Slice 2 — Test-file classifier

**Test first** (`test/unit/scripts/test-pyramid/classify-test-file.test.ts`):

- Given `test/unit/foo.test.ts`, When classified, Then returns `unit`.
- Given `test/integration/foo.test.ts`, When classified, Then returns
  `integration`.
- Given `test/integration/posix-only/foo.test.ts`, When classified, Then
  returns `integration` (subdir inclusion).
- Given `test/browser/foo.spec.ts`, When classified, Then returns `e2e`.
- Given `test/fixtures/foo.ts`, When classified, Then returns
  `unclassified`.
- Given `test/bench/foo.bench.ts`, When classified, Then returns
  `unclassified`.

**Implement**:

`scripts/test-pyramid/classify-test-file.ts`:

```ts
export type TierName = 'unit' | 'integration' | 'e2e';
export const classifyTestFile = (
  manifest: PyramidManifest,
  repoRelPath: string,
): TierName | 'unclassified'
```

Pure: takes manifest + path string, returns tier or `unclassified`.
Uses `minimatch` against each tier's glob in manifest order.

**Verify**: vitest unit pass.

**Commit**: `feat(scripts): pyramid-audit test-file classifier`

---

### Slice 3 — Tier counter + share calculator

**Test first**
(`test/unit/scripts/test-pyramid/count-tier-files.test.ts`):

- Given an empty list, When counted, Then all tier counts are 0 and shares
  are `0.0`.
- Given 8 unit + 1 integration + 1 e2e, When counted, Then shares are 80
  / 10 / 10.
- Given 207 / 24 / 4 (the current baseline), When counted, Then shares
  round to 88.0 / 10.2 / 1.7.
- Given a list containing one `unclassified` file, When counted, Then
  shares are computed over classified-only and the unclassified file is
  reported in a separate count.

**Implement** (`scripts/test-pyramid/count-tier-files.ts`):

```ts
export interface TierTally {
  readonly tier: TierName;
  readonly fileCount: number;
  readonly sharePct: number;       // one decimal place
  readonly status: 'ok' | 'warn-below' | 'warn-above';
}

export interface TallyResult {
  readonly tiers: ReadonlyArray<TierTally>;
  readonly unclassified: ReadonlyArray<string>;
  readonly totalClassified: number;
}

export const tallyTierFiles = (
  manifest: PyramidManifest,
  paths: ReadonlyArray<string>,
): TallyResult
```

Rounding: `Math.round(share * 10) / 10`. Status from manifest warn bands.

**Verify**: vitest unit pass.

**Commit**: `feat(scripts): pyramid-audit tier counter + share calc`

---

### Slice 4 — Over-mocked integration scanner

**Test first**
(`test/unit/scripts/test-pyramid/detect-over-mocked.test.ts`):

- Given a clean file (no vi.* calls), When scanned, Then no finding.
- Given a file with `vi.mock('foo')`, When scanned, Then a finding with
  count 1.
- Given a file with `vi.fn()` and `vi.spyOn()`, When scanned, Then a
  finding with count 2.
- Given a file with `vi.useFakeTimers()`, When scanned, Then no finding
  (timer control is exempt).
- Given a file with `vi.mock` inside a comment, When scanned, Then
  reports count 1 (false positive accepted, per ADR-107).
- Given multiple files, When scanned, Then per-file findings sorted by
  path.

**Implement** (`scripts/test-pyramid/detect-over-mocked.ts`):

```ts
export interface OverMockedFinding {
  readonly path: string;
  readonly hits: number;
}

export const detectOverMocked = (
  manifest: PyramidManifest,
  files: ReadonlyArray<{ readonly path: string; readonly source: string }>,
): ReadonlyArray<OverMockedFinding>
```

Pure: takes pre-read file contents (caller owns I/O). Uses the regex from
the manifest's `overMockedIntegration` config.

**Verify**: vitest unit pass.

**Commit**: `feat(scripts): pyramid-audit over-mocked integration scanner`

---

### Slice 5 — Under-asserted unit scanner

**Test first**
(`test/unit/scripts/test-pyramid/detect-under-asserted.test.ts`):

- Given a single `it()` with one `expect()`, When scanned, Then no
  finding.
- Given a single `it()` with zero assertions, When scanned, Then one
  finding (file + line + title).
- Given `it.skip(...)` with zero assertions, When scanned, Then no
  finding (skip exempt).
- Given `it.todo(...)`, When scanned, Then no finding.
- Given nested `describe()` blocks, When scanned, Then each inner `it()`
  is scanned independently.
- Given `it.each([...])(...)` with one `expect()`, When scanned, Then no
  finding (counted as one test).
- Given a multi-line opener `it(\n  'title',\n  async () => {`, When
  scanned, Then the body's assertions are counted.
- Given a body containing `expectGitObject(...)` (helper-prefixed), When
  scanned, Then matches `\bexpect\w*\(` and no finding.
- Given a body containing only `assert.equal(...)`, When scanned, Then
  no finding (assertion regex matches).

**Implement** (`scripts/test-pyramid/detect-under-asserted.ts`):

```ts
export interface UnderAssertedFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
}

export const detectUnderAsserted = (
  manifest: PyramidManifest,
  files: ReadonlyArray<{ readonly path: string; readonly source: string }>,
): ReadonlyArray<UnderAssertedFinding>
```

Internal `scanItBlocks(source: string)` returns `[{ line, title, body }]`.
A second pass counts assertions via the manifest regex.

Brace-scanner contract:

```
findItOpeners(source)        // regex over /\b(it|test)(\.[\w]+)*\s*\(/g
  for each opener:
    skip if any modifier in {skip, todo, fails} (or chain ends in those)
    locate first ', ' separator → title string (skip if not a string literal)
    locate '=> {' from the opener → body start
    advance brace counter from body start until balanced → body end
    yield { line, title, body }
```

**Verify**: vitest unit pass.

**Commit**: `feat(scripts): pyramid-audit under-asserted unit scanner`

---

### Slice 6 — Report renderer (JSON + markdown)

**Test first**
(`test/unit/scripts/test-pyramid/render-report.test.ts`):

- Given a tally + empty findings, When rendered, Then JSON contains
  `findings: { overMocked: [], underAsserted: [] }`.
- Given a tally with one warn-below tier, When rendered as markdown, Then
  the table row has a warning marker (`⚠`) and a row note.
- Given findings, When rendered as markdown, Then a "Findings" section
  lists each.
- Given a tally with zero classified files, When rendered, Then the
  output explains "no tests classified" rather than divide-by-zero.

**Implement** (`scripts/test-pyramid/render-report.ts`):

```ts
export interface AuditOutcome {
  readonly tally: TallyResult;
  readonly findings: {
    readonly overMocked: ReadonlyArray<OverMockedFinding>;
    readonly underAsserted: ReadonlyArray<UnderAssertedFinding>;
  };
}

export const renderJson = (outcome: AuditOutcome): string  // pretty-printed
export const renderMarkdown = (outcome: AuditOutcome): string
```

Markdown shape (informational; details in tests' golden fixtures):

```
# Testing-pyramid audit

| Tier | Files | Share | Target | Status |
|---|---:|---:|---:|:--:|
| unit | 207 | 88.0% | 80% | ✓ |
| integration | 24 | 10.2% | 15% | ⚠ below 10% floor coming |
| e2e | 4 | 1.7% | 5% | ⚠ below 3% |

## Findings

### Over-mocked integration tests
_none_

### Under-asserted unit tests
- `test/unit/foo.test.ts:42` — Given ..., When ..., Then ...
```

**Verify**: vitest unit pass (golden snapshots).

**Commit**: `feat(scripts): pyramid-audit report renderer (json + markdown)`

---

### Slice 7 — Entry-point script

**Test first** (`test/integration/scripts/audit-test-pyramid.test.ts`):

End-to-end against a curated temp directory:

- Arrange: create `tmp/audit-fixture/` with a minimal manifest + a few
  synthetic test files (unit, integration with vi.mock, e2e).
- Act: spawn `node --experimental-strip-types scripts/audit-test-pyramid.ts
  --root tmp/audit-fixture --out tmp/audit-out`.
- Assert: `tmp/audit-out/test-pyramid.json` exists and matches the expected
  outcome; same for `.md`; exit code is `0`.
- Second case: malformed manifest → exit `1`, stderr contains
  `manifest invalid:`.

**Implement** (`scripts/audit-test-pyramid.ts`):

```ts
#!/usr/bin/env node
// Pyramid audit (Phase 19.2). Report-only — see ADR-104.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';
import {
  parseManifest, classifyTestFile, tallyTierFiles,
  detectOverMocked, detectUnderAsserted, renderJson, renderMarkdown,
} from './test-pyramid/index.ts';

interface CliArgs {
  readonly root: string;       // default: process.cwd()
  readonly manifestPath: string; // default: test-pyramid-budgets.json
  readonly outDir: string;     // default: reports/
}
```

Steps:

1. `parseArgs(process.argv.slice(2))`.
2. Load manifest, walk each tier glob via `node:fs/promises.glob` (relative
   to root), collect paths.
3. Classify each path; build `paths` array of classified files.
4. Read all integration file contents → run `detectOverMocked`.
5. Read all unit file contents → run `detectUnderAsserted`.
6. `tallyTierFiles` over the classified set.
7. `renderJson` + `renderMarkdown`; write to `outDir/test-pyramid.json` and
   `outDir/test-pyramid.md`. Also echo the markdown to stdout.
8. Exit `0` on success, `1` only on manifest/IO failure.

**Verify**: integration test pass; manual run produces the expected
baseline (207/24/4) on the repo's current state.

**Commit**: `feat(scripts): pyramid-audit entry-point + integration test`

---

### Slice 8 — Wire into npm scripts + CI

**Test first**: not unit-tested; verify via `npm run check:test-pyramid`
locally and CI logs.

**Implement**:

1. `package.json`:
   - Add `"check:test-pyramid": "wireit"` to `scripts`.
   - Add wireit block per design §6.3, including
     `scripts/test-pyramid/**/*.ts` in `files`.
   - Add `check:test-pyramid` to the `validate` umbrella's `dependencies`.
2. `.github/workflows/ci.yml`:
   - In the `lint` job (or a new dedicated step), add
     `run: npm run check:test-pyramid`.
   - Upload `reports/test-pyramid.{json,md}` as a workflow artifact.

**Verify**:

- `npm run check:test-pyramid` succeeds, writes both report files.
- `npm run validate` includes the new step and stays green.
- CI dry-run via push verifies artifact upload (the artifact appears on the
  PR's Actions tab).

**Commit**: `ci(scripts): wire pyramid-audit into validate + CI artifact`

---

### Slice 9 — Docs refresh

**Implement** (no tests; doc-only):

1. `docs/understand/testing.md` (or `docs/understand/architecture.md` if no
   testing page exists yet) — short section: how the audit works, where the
   report lives, link to ADRs 104–108.
2. `CONTRIBUTING.md` — note the new `check:test-pyramid` in the "Quality
   gates" section.
3. `RUNBOOK.md` — entry under "Test infrastructure" referencing the audit
   and how to interpret findings.
4. `README.md` — only if a "Testing" or "Quality" section already exists;
   otherwise skip.
5. `docs/BACKLOG.md` — flip 19.2 `[ ]` → `[x]` with ADR references:

```
- [x] **19.2** Testing-pyramid audit — directory-based classification,
  80/15/5 target, report-only · ADRs 104–108 ·
  `design/phase-19-2-testing-pyramid-audit.md`
```

**Verify**: `npm run check:doc-links` clean, `npm run check:doc-coverage`
clean.

**Commit**: `docs: phase 19.2 testing-pyramid audit (BACKLOG + understand + runbook)`

---

## Out-of-scope follow-ups (not in this PR)

- PR-comment posting of the audit report. The artifact + CI logs are
  enough for v1.
- Per-`it()`-block tier counts. File-level is sufficient.
- Promotion of either heuristic to a hard gate. Owned by 19.3 / 19.4.

## Verification matrix

| Slice | Test | Verify |
|---|---|---|
| 1 | parse-manifest unit | `npm run test:unit -- parse-manifest` |
| 2 | classify-test-file unit | `npm run test:unit -- classify-test-file` |
| 3 | count-tier-files unit | `npm run test:unit -- count-tier-files` |
| 4 | detect-over-mocked unit | `npm run test:unit -- detect-over-mocked` |
| 5 | detect-under-asserted unit | `npm run test:unit -- detect-under-asserted` |
| 6 | render-report unit | `npm run test:unit -- render-report` |
| 7 | audit-test-pyramid integration | `npm run test:integration -- audit-test-pyramid` |
| 8 | (wire-up) | `npm run validate` |
| 9 | (docs) | `npm run check:doc-links`, `npm run check:doc-coverage` |

After Slice 9: full `npm run validate` + `npm run test:mutation` (no src/
changes → mutation gate auto-skips per ADR-103 if the diff truly contains
no src changes; otherwise the touched files get mutated).

## Risk-driven order

The plan starts with the manifest (Slice 1) because every downstream slice
imports its types — schema churn during later slices is expensive.
Classification (Slice 2) and counting (Slice 3) come before the heuristics
because the heuristic outputs reference tier-mapped paths. Renderer (Slice
6) consumes everything else and is best done with the upstream contracts
stable. Entry-point (Slice 7) is the smallest viable orchestration, with
the integration test as its single regression net. Wiring (Slice 8) and
docs (Slice 9) only land once the audit produces a stable report locally.
