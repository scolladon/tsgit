# Phase 19.3a — AAA-marker semantic audit — Implementation plan

Derived from `docs/design/phase-19-3a-aaa-marker-semantic-audit.md` and
ADRs 114–116. Red → Green → Refactor for each implementation step;
atomic commits.

Convention reminders:
- Test titles: `Given <ctx>, When <act>, Then <expected>`.
- Test bodies: AAA section comments (`// Arrange`, optional `// Act`,
  `// Assert`). SUT variable is `sut`.
- 100% coverage on `tooling/test-pyramid/**`; scripts excluded from
  Stryker (ADR-108).
- Sweep commits must not silently change semantics — only marker
  placement and `sut` extraction.

## File inventory

| # | Action | Path |
|---|---|---|
| 1 | NEW | `tooling/test-pyramid/detect-empty-aaa-section.ts` |
| 2 | EDIT | `tooling/test-pyramid/parse-manifest.ts` — new heuristic + GATING key |
| 3 | EDIT | `tooling/test-pyramid/render-report.ts` — new finding section |
| 4 | EDIT | `tooling/audit-test-pyramid.ts` — wire detector + gating map |
| 5 | EDIT | `tooling/test-pyramid-budgets-schema.json` — schema for new heuristic + gating key |
| 6 | EDIT | `test-pyramid-budgets.json` — register heuristic, default `gating.emptyAaaSection: false` |
| 7 | NEW | `tooling/test/unit/test-pyramid/detect-empty-aaa-section.test.ts` |
| 8 | EDIT | `tooling/test/unit/test-pyramid/manifest-fixture.ts` — default + override for new heuristic |
| 9 | EDIT | `tooling/test/unit/test-pyramid/parse-manifest.test.ts` — required key + gating key validation |
| 10 | EDIT | `tooling/test/unit/test-pyramid/render-report.test.ts` — markdown + JSON sections |
| 11 | EDIT | `tooling/test/integration/audit-test-pyramid.test.ts` — gated and `--report-only` fixtures |
| 12 | SWEEP | `test/unit/adapters/node/**` — Patterns A/B/C |
| 13 | SWEEP | `test/unit/application/commands/**` |
| 14 | SWEEP | `test/unit/application/commands/internal/**` |
| 15 | SWEEP | `test/unit/application/primitives/**` |
| 16 | SWEEP | `test/unit/domain/**` (subdirectories: commands, diff, git-index, ignore, merge, objects, pathspec, protocol, reflog, refs, storage, top-level) |
| 17 | SWEEP | `test/unit/operators/**` |
| 18 | SWEEP | `test/unit/ports/**` |
| 19 | SWEEP | `test/unit/repository/**` |
| 20 | SWEEP | `test/unit/transport/**` |
| 21 | EDIT | `test-pyramid-budgets.json` — flip `gating.emptyAaaSection` to `true` |
| 22 | EDIT | `CONTRIBUTING.md` — describe `emptyAaaSection` under "Gating" |
| 23 | EDIT | `docs/BACKLOG.md` — flip 19.3a `[ ]` → `[x]` |

Sweep commits 12–20 will each pass `npm run test:unit` before commit.
The single `test/unit/domain` row will likely be split into multiple
commits, one per subdirectory, depending on diff size — same intent,
finer granularity if needed.

## Step sequence

### Step 1 — Detector + scanner reuse (RGR)

**Red.** Write `tooling/test/unit/test-pyramid/detect-empty-aaa-section.test.ts`
covering the §7 table from the design:

- Arrange + Assert both non-empty → no finding.
- Arrange empty + Assert one statement → finding under Arrange.
- Arrange one statement + Assert empty (closing brace next) → finding
  under Assert.
- Arrange empty + Act one stmt + Assert one stmt → finding under
  Arrange.
- Arrange empty + Assert empty → findings under both markers.
- Compound `// Arrange + Act` + one statement → no finding.
- Marker followed only by another marker → finding.
- Marker followed only by a block-comment line then marker → finding.
- Marker followed only by a closing brace → finding.
- `.skip` body with empty sections → no finding.
- Integration tier file with empty sections → no finding.
- Multiple findings → sorted by `path` then `line`, then marker order
  (Arrange < Act < Assert) for ties.

Use the existing `makeManifest` fixture; default `gating.emptyAaaSection
= false` (the detector doesn't read gating — emission happens
unconditionally; the script consumes gating).

**Green.** Implement `detect-empty-aaa-section.ts`:

```ts
export interface EmptyAaaSectionFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly marker: AaaMarker;
}

export const detectEmptyAaaSection = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<EmptyAaaSectionFinding> => { /* ... */ };
```

Algorithm:
1. For each unit file (per `classifyTestFile`), iterate
   `scanItBlocks(file.source)`.
2. Skip blocks where `isSkipped`.
3. Within the body, find marker lines (line-index, marker name, line
   number relative to file). Use a single regex sweep that captures
   *all* markers on a line — a line like `// Arrange + Act` yields two
   marker records sharing the same line index.
4. For each marker record except records sharing a line with another
   marker: the section spans (markerLineIndex + 1) .. (nextMarker
   LineIndex − 1) or end-of-body. Check whether any line in that span
   is *statement-bearing* (non-empty, first non-whitespace not `//`
   and not `}` `)` `]`). If not, emit a finding under the marker's
   name.
5. For markers sharing a line (compound), only the *first* marker
   appearing on the line emits a finding. The shared-line marker(s)
   that follow have zero-length sections and would never have content
   — skip them silently.
6. Sort findings by `path`, then `line`, then marker order (Arrange <
   Act < Assert).

**Refactor.** Pull line-bearing detection into a small helper
(`isStatementBearingLine(line: string): boolean`) for unit testability;
no separate test file (covered transitively).

Commit: `feat(tooling): detect empty AAA sections in unit tests`.

### Step 2 — Manifest schema + parse (RGR)

**Red.** Extend
`tooling/test/unit/test-pyramid/parse-manifest.test.ts`:

- `emptyAaaSection` is a required key inside `heuristics`; missing →
  `manifest invalid: heuristics.emptyAaaSection is required`.
- `emptyAaaSection.tier` must reference a known tier name.
- `emptyAaaSection` as non-object → invalid.
- Gating key `emptyAaaSection` is accepted; unknown gating key still
  rejected with the existing message.
- Default `gating.emptyAaaSection` is `false` when the gating block is
  absent.

Extend `manifest-fixture.ts` to populate `emptyAaaSection: { tier:
'unit' }` by default and `gating.emptyAaaSection: false` by default,
plus an override hook (`gating: { emptyAaaSection: true }`).

**Green.** In `parse-manifest.ts`:

- Add `EmptyAaaSectionHeuristic { tier: TierName }` plus `parseEmpty
  AaaSection`.
- Add `emptyAaaSection` to `requiredHeuristicKeys` and to the
  `heuristics` return shape.
- Extend `GATING_KEYS` with `'emptyAaaSection'`.
- Add `emptyAaaSection: false` to `DEFAULT_GATING`.

Update `tooling/test-pyramid-budgets-schema.json` to match (new
heuristic entry, new gating key).

Update `test-pyramid-budgets.json` to register the heuristic with
`gating.emptyAaaSection: false`.

Commit: `feat(tooling): manifest entry + gating key for emptyAaaSection`.

### Step 3 — Renderer (RGR)

**Red.** Extend `render-report.test.ts`:

- Markdown contains "### Empty AAA sections" section.
- Empty findings array renders `_none_`.
- Findings render as `- \`path:line\` — empty <marker> section
  (<title>)`.
- JSON output includes `findings.emptyAaaSection: [...]`.

**Green.** In `render-report.ts`:

- Import `EmptyAaaSectionFinding`.
- Extend `AuditFindings` with `emptyAaaSection: Readonly
  Array<EmptyAaaSectionFinding>`.
- Add `renderEmptyAaaSection` formatter.
- Wire into `renderMarkdown` (between the under-asserted and bad-title
  sections — keeps related AAA gates near each other in the report).

Commit: `feat(tooling): renderer support for empty-AAA section
findings`.

### Step 4 — Audit script wiring (RGR)

**Red.** Extend `audit-test-pyramid.test.ts` integration suite:

- Fixture: unit file `it('Given x, When y, Then z', () => { //
  Arrange\n// Assert\n  expect(1).toBe(1); });` triggers
  `emptyAaaSection` finding (no gating → exit 0; JSON contains
  finding).
- Same fixture with `gating.emptyAaaSection: true` → exit 1, stderr
  contains `emptyAaaSection`.
- `--report-only` flag forces exit 0 even with gating on.

**Green.** In `audit-test-pyramid.ts`:

- Import `detectEmptyAaaSection`.
- Add to the `findings` object in `runAudit`.
- Extend `FINDING_KEY_BY_GATING` with `emptyAaaSection:
  'emptyAaaSection'`.

Commit: `feat(tooling): wire emptyAaaSection detector into audit
script`.

### Step 5 — Cleanup sweeps (one commit per directory)

For each directory under `test/unit/` that contains offenders (per
the §1 design triage — 20 directories), apply the §6 sweep policy
from the design (Patterns A, B, C). Mechanical edits; tests must
pass after each commit.

Ordering (alphabetical for predictability):

1. `test/unit/adapters/node/**`
2. `test/unit/application/commands/**` (top-level)
3. `test/unit/application/commands/internal/**`
4. `test/unit/application/primitives/**`
5. `test/unit/domain/**` (top-level files only)
6. `test/unit/domain/commands/**`
7. `test/unit/domain/diff/**`
8. `test/unit/domain/git-index/**`
9. `test/unit/domain/ignore/**`
10. `test/unit/domain/merge/**`
11. `test/unit/domain/objects/**`
12. `test/unit/domain/pathspec/**`
13. `test/unit/domain/protocol/**`
14. `test/unit/domain/reflog/**`
15. `test/unit/domain/refs/**`
16. `test/unit/domain/storage/**`
17. `test/unit/operators/**`
18. `test/unit/ports/**`
19. `test/unit/repository/**`
20. `test/unit/transport/**`

Each commit:
- Run `npm run test:unit` before commit. Green required.
- Commit subject: `test(unit/<dir>): extract sut from empty-AAA
  sections`.
- No semantic test changes — only marker placement / `sut`
  extraction per Patterns A / B / C.

A small codemod (`tooling/sweep-empty-aaa.ts`, optional) can apply
the rewrites mechanically. The codemod is **not** committed (it's
working scaffolding) unless it materially helps future-19.3b style
sweeps — then it gets its own ADR.

### Step 6 — Gate flip

Flip `gating.emptyAaaSection: true` in
`test-pyramid-budgets.json`. Run `npm run validate` to confirm
clean.

Commit: `feat(tooling): gate emptyAaaSection in test-pyramid audit`.

### Step 7 — Docs + BACKLOG

- Update `CONTRIBUTING.md`: add `emptyAaaSection` to the "Gating"
  list under "Testing-pyramid audit". Reference ADRs 114–116.
- Flip `docs/BACKLOG.md` line 222: `[ ] **19.3a** ...` →
  `[x] **19.3a** ...`.
- Update the BACKLOG line's blurb if it materially differs from
  what shipped (it shouldn't — the design tracks the BACKLOG
  verbatim).

Commit: `docs: 19.3a empty-AAA-section gate documented + flipped`.

## Dependencies between steps

```
Step 1 ─┐
Step 2 ─┼─→ Step 3 ─→ Step 4 ─→ Step 5 ─→ Step 6 ─→ Step 7
        │
        └─ Step 2 produces the manifest shape Step 4 + makeManifest
           rely on; do Step 2 before Step 4. Step 1's detector is
           independent of manifest gating (it always emits findings).
```

## Validation gates per step

| Step | Local check before commit |
|---|---|
| 1 | `npm run test:unit -- detect-empty-aaa-section` |
| 2 | `npm run test:unit -- parse-manifest` |
| 3 | `npm run test:unit -- render-report` |
| 4 | `npm run test -- audit-test-pyramid` (integration) |
| 5 (each) | `npm run test:unit` (full unit suite) |
| 6 | `npm run validate` |
| 7 | `npm run validate` + `npm run check:doc-links` |

## Out of scope (deferred to other items)

- `scanItBlocks` two-stage call shapes (`skipIf` / `runIf`) — 19.3b.
- Empty-section detection on integration / e2e tiers — 19.4.
- Codemod committed as a maintained tool — only ships if the sweep
  produces material reuse evidence.
- Promotion of `overMockedIntegration` — 19.4.
