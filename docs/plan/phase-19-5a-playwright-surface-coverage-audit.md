# Plan — Phase 19.5a Playwright surface coverage audit

Implements `docs/design/phase-19-5a-playwright-surface-coverage-audit.md`.
ADRs 130, 131, 132, 133 already committed alongside the design.

## Ordering

Six slices, sequential. Each slice is a TDD cycle (red → green →
refactor) ending in a single atomic commit. Slice 1 stands up the
audit + gate before any coverage closes, so the failing run names the
exact 31 gaps. Slices 2–4 close the gaps in bundles. Slice 5 promotes
the audit into the validate aggregate (after gaps are at zero). Slice
6 lands the doc refresh and the BACKLOG tick.

| Slice | Topic | Failing test first | Commit subject |
|---|---|---|---|
| 1 | Audit script + allowlist + unit tests + integration test | `test/unit/tooling/audit-browser-surface.test.ts` red on the parsers, then `test/integration/tooling/audit-browser-surface.test.ts` red on CLI exit code | `feat(harness): audit-browser-surface tool + 5-entry allowlist` |
| 2 | Read-side parity scenarios — `read-pipeline`, `walk`, `refs`, `cat-file` | Each scenario's Node parity test red on the golden | `test(parity): read-side scenarios (read-pipeline, walk, refs, cat-file)` |
| 3 | Write-side parity scenarios — `write-pipeline`, `reset-rm`, `rev-parse`, `diff` | Same | `test(parity): write-side scenarios (write-pipeline, reset-rm, rev-parse, diff)` |
| 4 | Composite parity scenarios — `merge-ff`, `reflog`, `sparse-checkout`, `submodules-empty` | Same | `test(parity): composite scenarios (merge-ff, reflog, sparse-checkout, submodules-empty)` |
| 5 | Wireit promotion — `check:browser-surface` joins `check` + `validate` | `npm run check` red until the script is added; `npm run validate` red until gaps == 0 | `ci(harness): promote check:browser-surface to validate gate` |
| 6 | Docs refresh + BACKLOG tick | n/a — docs only | `docs: 19.5a — promote browser-surface audit, tick BACKLOG` |

## Slice 1 — Audit script + allowlist + tests

### Files to create

- `tooling/audit-browser-surface.ts` (~150 LOC):
  - `parseRepositoryInterface(source) → { commands[], primitives[] }`
    — duplicated regex pair from `check-doc-coverage.ts`.
  - `scanCallSites(source) → { commands: Set<string>, primitives:
    Set<string> }` — applies `\brepo\.([a-zA-Z][\w]*)\s*\(` and
    `\brepo\.primitives\.([a-zA-Z][\w]*)\s*\(`.
  - `loadAllowlist(json) → Allowlist | throws` — schema validation,
    cross-checked against bound surfaces.
  - `computeGaps(bound, covered, exempt) → Gaps` — set-diff, sorted.
  - `formatReport(...) → string` (JSON) and `formatGapMessage(...) →
    string` (human stderr).
  - `main()` — reads `src/repository.ts`, globs the spec/scenario
    tree, writes `reports/browser-surface-coverage.json`, exits.
- `tooling/audit-browser-surface.allowlist.json` — the 5-entry
  opening list from ADR-133.
- `test/unit/tooling/audit-browser-surface.test.ts` (~250 LOC):
  - `parseRepositoryInterface` — Given a `BoundOnRepo` source, Then
    each tier returns the expected names; skip set filters `ctx`,
    `dispose`, `primitives`.
  - `scanCallSites` — Given a source with a mix of commands +
    primitives + comments + decoys (`fakeRepo.add(`,
    `repo.primitives`), Then returns the expected sets.
  - `loadAllowlist` — Given valid JSON, Then returns typed result;
    Given missing `reason`, Then throws with the entry index;
    Given a `name` not in the facade, Then throws with the name.
  - `computeGaps` — Given bound ∩ covered ∩ exempt sets, Then
    returns the difference; entries are sorted alphabetically per
    tier; the report summary numbers match the array lengths.
  - `formatGapMessage` — Given two gaps, Then the message names
    both with their tier prefix.
- `test/integration/tooling/audit-browser-surface.test.ts` (~100
  LOC):
  - `@proves: tooling/audit-browser-surface.ts:cli`
  - Builds a temp `src/repository.ts` stub, a fake spec, a fake
    allowlist; runs `main()` via `tsx` in a child process; asserts
    exit code + report JSON contents.

### Test order (TDD)

1. Red: write the parser unit tests against unimplemented exports.
2. Green: implement the parsers minimally.
3. Red: write the integration test that runs the audit against the
   real `src/repository.ts` and asserts exit 1 with the 31-name
   gap list.
4. Green: implement `main()` + report writer.
5. Refactor: extract pure helpers, name constants, split functions
   over 20 lines.

### Verify

- `npm run test:unit -- audit-browser-surface` green.
- `npm run test:integration -- audit-browser-surface` green.
- `npx tsx tooling/audit-browser-surface.ts` exits 1 with 31 gaps
  reported.

## Slices 2–4 — Parity scenarios

Each new scenario follows the existing pattern under
`test/parity/scenarios/`:

```typescript
export const fooScenario: Scenario<FooResult> = {
  name: 'foo',
  inputs: { files: [...], author: AUTHOR, message: MESSAGES.seed },
  expected: { /* golden literal */ },
  run: async (repo, inputs) => { /* exercises the targeted surfaces */ },
};
```

Each scenario file is registered in `test/parity/scenarios/index.ts`.
The Node and Memory drivers pick it up via `describe.each`. The
browser bundle picks it up on its next `npm run build:parity` (which
the `test:e2e` wireit step depends on).

### Slice 2 — Read-side scenarios

| Scenario | Surfaces |
|---|---|
| `read-pipeline.scenario.ts` | `readObject`, `readTree`, `readIndex`, `getRepoRoot` |
| `walk.scenario.ts` | `walkCommits`, `walkTree`, `walkWorkingTree` |
| `refs.scenario.ts` | `resolveRef`, `updateRef`, `writeSymbolicRef`, `recordRefUpdate` |
| `cat-file.scenario.ts` | `catFile`, `catFileBatch` |

Per scenario:
1. Red: add the scenario file with an empty `expected` and register
   it in `index.ts`. Run `npm run test:parity:node` — the test
   fails with "expected to equal" naming the actual run output.
2. Green: copy the actual output into `expected`. Re-run; green.
3. Refactor: factor common slicing into the existing
   `defensiveCopy` style if duplication exceeds three call sites.

### Slice 3 — Write-side scenarios

| Scenario | Surfaces |
|---|---|
| `write-pipeline.scenario.ts` | `createCommit`, `writeTree` |
| `reset-rm.scenario.ts` | `reset`, `rm` |
| `rev-parse.scenario.ts` | `revParse` |
| `diff.scenario.ts` | `diff`, `diffTrees`, `mergeBase` |

Same TDD loop. `reset-rm` is state-mutating; both surfaces
exercised in one scenario after a multi-commit seed.

### Slice 4 — Composite scenarios

| Scenario | Surfaces |
|---|---|
| `merge-ff.scenario.ts` | `merge` (fast-forward) |
| `reflog.scenario.ts` | `reflog` (show) |
| `sparse-checkout.scenario.ts` | `sparseCheckout` |
| `submodules-empty.scenario.ts` | `submodules`, `walkSubmodules` |

`merge-ff` is the most complex — requires two-branch divergence
then merge. `submodules-empty` is the cheapest — empty `.gitmodules`
yields empty results on both commands. Bundled in the same slice
because each is small and they share no setup.

## Slice 5 — Wireit promotion

Add to `package.json` wireit graph:

```jsonc
"check:browser-surface": {
  "command": "tsx tooling/audit-browser-surface.ts",
  "files": [
    "src/repository.ts",
    "test/browser/**/*.spec.ts",
    "test/parity/scenarios/**/*.ts",
    "tooling/audit-browser-surface.ts",
    "tooling/audit-browser-surface.allowlist.json"
  ],
  "output": ["reports/browser-surface-coverage.json"]
}
```

Add to the `check` aggregate's `dependencies[]`. Add to the
`validate` aggregate's `dependencies[]` (after the existing
`check:doc-coverage` entry).

Verify:
- `npm run check` exits 0 (after slices 2–4 closed all gaps).
- `npm run validate` exits 0.
- Reverting one scenario locally and re-running shows the audit
  catching it.

## Slice 6 — Docs refresh + BACKLOG tick

Update:

- `docs/get-started/browser.md` — short note pointing at the
  audit as the guarantee that every documented command runs in
  the browser.
- `docs/understand/architecture.md` (or similar, if a "tests" lane
  section exists) — one-line addition naming the new audit.
- `CLAUDE.md` — no change; the workflow already references
  `npm run validate` which now includes the audit.
- `docs/BACKLOG.md` — flip `[ ] **19.5a**` to `[x] **19.5a**`
  with the ADR list (130–133) + design link.

No README change — coverage claims already gated on the tested
matrix (Node + Browser + in-memory).

## Reviews

After slice 6, run the three-pass review (code-reviewer +
security-reviewer + test-review + typescript-reviewer in parallel
per pass). Address findings inline; do not defer.

## Rollback

If any slice's tests cannot be made green within the slice:

- Revert the slice's commit.
- The branch falls back to the previous green slice.
- Slices 1–5 are independent commits; slice 6 (docs) is independent
  of the implementation.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| New scenario produces non-deterministic `commit.id` across drivers | Low | Parity-fixtures audit (`tooling/audit-parity-fixtures.ts`) catches known non-determinism sources before runtime |
| `merge-ff` scenario fails on browser only (FS adapter divergence on ref atomicity) | Medium | Use the existing `checkout.materialize` lock-first ordering; merge fast-forward only writes a single ref |
| Audit regex misses a coverage source authored after this phase (e.g., a new helper module under `test/`) | Low | The audit globs `test/browser/**` and `test/parity/scenarios/**` — adding a new directory requires updating the audit explicitly, which the audit's own unit test will flag |
| Allowlist drift — a new exemption gets added without rationale | Low | Schema validation rejects empty `reason`; PR review catches the entry |
