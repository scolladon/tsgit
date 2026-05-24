# Plan — Phase 19.4: Integration-test usefulness audit

Derived from `design/phase-19-4-integration-test-usefulness-audit.md` and
ADRs 121–126.

Order is load-bearing. Each numbered slice is a separate commit unless noted
("squashed with N" means it lands in the same commit as the previous slice).
TDD throughout: write the test, watch it fail, write the code, watch it pass,
refactor, validate (`npm run check && npm run check:types && npm run
test:unit && npm run test:integration && npx node --experimental-strip-types
tooling/audit-test-pyramid.ts --report-only`).

## Slice 1 — manifest schema gains `integrationProof`

Schema before parser so the parser can `import { IntegrationProofHeuristic }`
on the first compile. Otherwise slice 1 wouldn't typecheck in isolation.

Files:
- `tooling/test-pyramid/parse-manifest.ts`
- `tooling/test-pyramid-budgets-schema.json`
- `test-pyramid-budgets.json`
- `tooling/test/unit/test-pyramid/parse-manifest.test.ts`

Tests (add to existing `parse-manifest.test.ts`):

1. Manifest with a valid `integrationProof` block parses to an
   `IntegrationProofHeuristic` exposing `buckets: ReadonlyArray<string>`,
   `surfaceRegex: RegExp`, `uniqueMinLength: number`, `uniqueMaxLength: number`,
   `directoryRules: ReadonlyMap<string, ReadonlyArray<DirectoryClass>>`.
2. Missing `integrationProof` block → fail with `manifest invalid:
   heuristics.integrationProof ...`.
3. `buckets` empty or contains duplicates → fail.
4. `directoryRules` keys ≠ `buckets` (set comparison) → fail.
5. `directoryRules` value contains an unknown directory class → fail.
6. `surfaceRegex` is not a valid regex string → fail.
7. `uniqueMinLength >= uniqueMaxLength` → fail.
8. `gating.integrationProof` defaults to `false` when omitted, matching
   the existing gating-key default behaviour.

Implementation:
- Add `integrationProofHeuristic` definition to
  `tooling/test-pyramid-budgets-schema.json`.
- Add `integrationProof` to the schema's required `heuristics` keys.
- Extend `parseManifest` to compile the regex and build the
  `directoryRules` map.
- Add `'integrationProof'` to `GATING_KEYS`.
- Extend the live `test-pyramid-budgets.json` with the new block (per
  design §6) and `gating.integrationProof: false`.

Commit: `feat(tooling): integrationProof heuristic in pyramid manifest schema`.

## Slice 2 — `parseProvesHeader` pure-string parser

Files:
- `tooling/test-pyramid/parse-proves-header.ts` (new)
- `tooling/test/unit/test-pyramid/parse-proves-header.test.ts` (new)

Tests (one `it()` per branch — see design §11):

1. Happy path — JSDoc with `@proves` + three valid keys → `{ ok: true, header }`.
2. Shebang then JSDoc → parsed (consumes shebang line first).
3. CRLF line endings → normalised and parsed.
4. No JSDoc at all → `{ ok: false, error: { reason: 'no-jsdoc-at-top' } }`.
5. JSDoc not at byte 0 (e.g. `import` before it) → `'no-jsdoc-at-top'`.
6. JSDoc without `@proves` → `'no-proves-block'`.
7. `@proves` with two of three keys → `'missing-key'` (detail names the missing one).
8. `surface` value violates regex (uppercase start, > 41 chars, illegal char) → `'bad-surface'`.
9. `bucket` value not in heuristic enum → `'bad-bucket'`.
10. `unique` < 12 chars / > 200 chars / contains `\n` → `'bad-unique'`.
11. Free-form prose before / between / after `@proves` is preserved (parser ignores it).
12. Extra keys (e.g. `foo: bar`) are silently ignored (only the three required keys are read).

Implementation:
- Pure functions, no side effects.
- Use `RegExp` for `surface` and bucket-membership for `bucket`.
- Public types: `ProvesHeader`, `ProvesError`, `ProvesResult` per design §7.
- Takes config as `IntegrationProofHeuristic` (imported from slice 1's
  `parse-manifest.ts`) so the parser stays data-driven.

Commit: `feat(tooling): parseProvesHeader pure-string parser`.

## Slice 3 — `detectIntegrationProof` detector

Files:
- `tooling/test-pyramid/detect-integration-proof.ts` (new)
- `tooling/test/unit/test-pyramid/detect-integration-proof.test.ts` (new)

Tests:

1. Empty input → empty findings (`{ missing: [], duplicate: [], misplaced: [] }`).
2. Unit-tier file (per `classifyTestFile`) is ignored.
3. Integration file with valid header → no finding; output's
   accepted-list (used by the surfaces sidecar in slice 4) carries
   one entry.
4. Integration file missing the header → `missing` carries one entry
   with the parser's `reason` and `detail` propagated.
5. Two integration files with `(surface=clone, bucket=real-http)` →
   `duplicate` carries one entry with both paths sorted.
6. Two integration files with `(nodeFs.symlinks, platform-only)` in
   `posix-only/` and `win-only/` → no `duplicate` finding (platform-only
   exemption per ADR-123).
7. Integration file at root claiming `bucket: real-http` → `misplaced`
   carries one entry (expected: `network/`).
8. Integration file under `network/` claiming `bucket: multi-adapter-parity`
   → `misplaced` (expected: root).
9. Integration file under `posix-only/` claiming `bucket: real-fs` →
   no `misplaced` (real-fs's `directoryRules` allows root, posix-only,
   win-only).
10. Same file shape but `bucket: cross-tool-interop` under `posix-only/`
    → `misplaced` (expected: root).

Implementation:
- Pure function: `(manifest, files) => IntegrationProofFindings`.
- Mirrors `detectOverMocked`: filter by `classifyTestFile`, iterate,
  collect.
- Computes the file's directory class once per file via a small helper
  `classifyDirectory(repoRelPath): 'network' | 'posix-only' | 'win-only' | 'root'`
  exported for reuse by the renderer and the sidecar writer.
- Returns findings sorted by path / by `(surface, bucket)` / by path,
  respectively, for stable diff output.

Commit: `feat(tooling): detectIntegrationProof finds missing/duplicate/misplaced`.

## Slice 4 — `audit-test-pyramid.ts` wiring + surfaces sidecar

Files:
- `tooling/audit-test-pyramid.ts`
- `tooling/test-pyramid/render-report.ts`
- `tooling/test/unit/test-pyramid/render-report.test.ts`
- `tooling/test/integration/audit-test-pyramid.test.ts` (new)

Tests:

1. **Render-report** adds three sub-tables for `integrationProof`:
   `Missing proof`, `Duplicate proof`, `Misplaced bucket`. Each table is
   omitted (not rendered as an empty section) when its finding list is empty.
2. **Render-report** for a fully clean run produces no
   `integrationProof` section at all.
3. **JSON render** includes the `integrationProof` field with three
   keys, always (even when empty), so consumers can rely on the shape.
4. **Integration test** — extend the existing
   `tooling/test/integration/audit-test-pyramid.test.ts` (already in the
   repo). The new `describe` block adds the bucket
   `multi-adapter-parity`, surface `pyramidAudit.integrationProof`
   coverage:
   - Build a synthetic repo tree in a `mkdtemp` directory with three
     integration files: one clean, one missing-header, one duplicate
     with another file.
   - Build a synthetic manifest (`test-pyramid-budgets.json`) with the
     new heuristic.
   - Invoke `runAudit({ root, manifestPath, outDir, reportOnly: true })`.
   - Assert `outcome.findings.integrationProof.missing.length === 1`.
   - Assert `outcome.findings.integrationProof.duplicate.length === 1`.
   - Assert `outcome.findings.integrationProof.misplaced.length === 0`.
   - Assert the markdown output contains both "Missing proof" and
     "Duplicate proof" sub-headings.
   - Assert `reports/integration-surfaces.json` exists and contains one
     `files` entry per accepted parse.

Implementation:
- Import `detectIntegrationProof` in `audit-test-pyramid.ts`.
- Wire it into `outcome.findings.integrationProof`.
- Add `'integrationProof'` to `FINDING_KEY_BY_GATING`.
- Extend `writeReports` to also produce
  `reports/integration-surfaces.json` derived from the accepted-list.
- Render layer: emit the three sub-tables in the markdown report.

Commit: `feat(tooling): wire integrationProof into audit + surfaces sidecar`.

## Slice 5 — sweep all 21 integration files

Files: every file listed in design §10. Per [ADR-126](../adr/126-integration-proves-sweep-policy.md):

- Append-only edit to each file's existing JSDoc.
- No prose rewrites, no whitespace normalisation, no import edits.
- Bucket + surface + unique fixed per the design's §10 table.

For each file the edit shape is:

```ts
/**
 * <existing prose, untouched>
 *
 * @proves
 *   surface: <value from design §10>
 *   bucket:  <value from design §10>
 *   unique:  <one-line description, ≤ 200 chars>
 */
```

After the sweep, run:
```
node --experimental-strip-types tooling/audit-test-pyramid.ts --report-only
```
and verify `integrationProof.missing` / `.duplicate` / `.misplaced` are all
empty.

Commit: `test: integration-proves headers on all 21 integration files`.

## Slice 6 — engineering-harness wiring (no-op if validation already runs)

Pre-flight confirmed: `package.json#scripts.validate` already chains
`check:test-pyramid` which invokes `audit-test-pyramid.ts`. The new
heuristic is therefore exercised by `npm run validate` from day one —
no `package.json` change.

If the CI workflow uploads the `reports/` directory as an artefact, the
new `reports/integration-surfaces.json` lands automatically; otherwise the
CI YAML gets a one-line glob extension. Spot-check `.github/workflows/`
and adjust only if needed.

No commit unless a glob change lands.

## Validation gates

After each slice:
- `npm run check && npm run check:types`
- `npm run test:unit -- --project=unit --reporter=verbose tooling/test/unit/test-pyramid/<files-changed>`
- After slice 4: `npm run test:integration`
- After slice 5: `node --experimental-strip-types tooling/audit-test-pyramid.ts --report-only` reports zero `integrationProof` findings.
- Before opening the PR: full `npm run validate` + `npx stryker run`.

## Coverage and mutation expectations

- New code under `tooling/test-pyramid/parse-proves-header.ts` and
  `detect-integration-proof.ts` must hit 100% line/branch/function/statement
  per the project policy.
- Mutation pyramid: the new files belong to the `tooling` bucket
  (`mutation-budgets.json`); no budget change needed unless the new code
  pushes the bucket over its threshold. If it does, raise the bucket budget
  in a separate commit, not in the sweep PR.
- Every error reason in `ProvesError.reason` must have a test that exercises
  it; the `missing-key` branch tests both two-of-three and zero-of-three
  shapes.

## Pre-flight facts (confirmed before drafting)

- `tooling/test/integration/audit-test-pyramid.test.ts` exists and runs
  the audit script via `execFile` against a temp manifest. Slice 4
  extends its `buildManifest` helper with the new `integrationProof`
  block and adds the new `describe` group.
- `tooling/test/unit/test-pyramid/parse-manifest.test.ts` exists. Slice 2
  amends it in place.
- `npm run validate` already chains `check:test-pyramid`. No
  `package.json` change for slice 6.
- All 21 existing integration files open with `/**`. The sweep is purely
  append-only per ADR-126; no creation of new JSDoc blocks.
