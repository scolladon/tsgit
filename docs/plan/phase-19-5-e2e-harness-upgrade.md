# Plan — Phase 19.5 E2E harness upgrade

Implements `docs/design/phase-19-5-e2e-harness-upgrade.md`. ADRs 127, 128, 129 already committed alongside the design.

## Ordering

Eight slices, in order. Slices 1, 2, 3 could parallelise but sequentially the diff narrative is clearer (scaffolding → drivers → audit → wiring). Each slice is one or two commits; no sub-worktrees — every slice is small enough for one TDD cycle in this tree.

| Slice | Topic | Sub-worktree? |
|---|---|---|
| 0 | Scaffolding — fixtures barrel + first scenario shape (no drivers yet) | no |
| 1 | Node parity driver — `test/parity/node.test.ts` running the first scenario | no |
| 2 | Memory parity driver — `test/parity/memory.test.ts` running the same scenario | no |
| 3 | Second scenario — `branch-lifecycle` lights up on Node + Memory | no |
| 4 | Determinism audit — `tooling/audit-parity-fixtures.ts` + unit tests + `check:parity-fixtures` wireit recipe + `validate` dep | no |
| 5 | Browser parity driver — `test/browser/parity-scenarios.bundle.ts` + `tooling/build-parity-bundle.ts` + `test/browser/parity.spec.ts` + harness wire + `build:parity` wireit + `test:e2e` dep | no |
| 6 | CI wiring — `parity-tests` job + Playwright artifact name suffix | no |
| 7 | Docs refresh + BACKLOG tick + parallel reviews | no |

Two scenarios ship: `init-add-commit-status` and `branch-lifecycle`. Per ADR-129, no existing browser specs are deleted.

---

## Slice 0 — Scaffolding

**Files created:**

- `test/parity/fixtures.ts` — exports `AUTHOR` (`AuthorIdentity`), `MESSAGES`, `FILES`.
- `test/parity/scenarios/types.ts` — exports `ScenarioInputs` and the generic `Scenario<TResult>` interface (`{ name, INPUTS, EXPECTED, run }`).
- `test/parity/scenarios/init-add-commit-status.scenario.ts` — exports the typed `scenario: Scenario<InitAddCommitStatusResult>` const with `name`, `INPUTS`, `EXPECTED` (commit.id placeholder filled in slice 1), and `run`.
- `test/parity/scenarios/index.ts` — barrel re-exporting `SCENARIOS: ReadonlyArray<Scenario<unknown>>` (the registry the drivers iterate). Initially one entry; slice 3 appends.
- `tsconfig.json` — confirm `test/parity/**` is already covered by the existing `include`; no change expected. If not, extend.

**No tests yet.** The scenario module is data and a `run` function with no caller — the unit-test bar applies once a driver exercises it.

**Acceptance:**
- `npm run check:types` passes.
- `npm run check:filesystem` (ls-lint) passes — kebab-case filenames.
- `npm run check` (biome) passes.

**Commit:** `test(parity): scaffold fixtures + init/add/commit/status scenario`.

---

## Slice 1 — Node parity driver

### TDD cycle

**Red:**
1. Add `test/parity/node.test.ts` — `describe.each(SCENARIOS)('Given the <name> scenario', (scenario) => describe('When the Node driver runs it', () => it('Then the result matches EXPECTED', async () => { ... }))`. Body: `mkdtemp`, materialise `INPUTS.files` via `fs/promises.writeFile`, open Node `Repository` via `openRepository({ cwd: tmpDir })`, call `scenario.run(repo, scenario.INPUTS)`, assert `expect(actual).toEqual(scenario.EXPECTED)`. The scenario's `EXPECTED.commit.id` is still the placeholder from slice 0 → test fails with a golden mismatch showing the real Node-side SHA-1.

**Green:**
2. Copy the real SHA-1 from the failed-test output into the scenario's `EXPECTED.commit.id`. Re-run → green.
3. Add `vitest.config.ts` project `parity` covering `test/parity/**/*.test.ts`.
4. Add `package.json` script `"test:parity": "wireit"` + wireit recipe (`vitest run --project parity`, files `test/parity/**/*.ts`, `vitest.config.ts`).

**Refactor:**
5. Extract `setupNodeRepo(scenario)` helper if the temp-dir mkdtemp / `inputs.files` materialisation grows past 15 lines — keep the test body declarative.
6. Add `test:parity` to the `validate` wireit recipe's `dependencies` list — the parity drivers are a gate, not informational.

### Acceptance

- `npm run test:parity -- --project parity` passes.
- The scenario file's `EXPECTED.commit.id` is a real 40-hex literal that the audit lint (slice 4) will require.
- `npm run validate` still passes end-to-end with `test:parity` in the chain.

**Commit:** `test(parity): node driver + first scenario green`.

---

## Slice 2 — Memory parity driver

### TDD cycle

**Red:**
1. Add `test/parity/memory.test.ts`, same shape as `node.test.ts` but uses `openRepository` from `tsgit/auto/memory` (or `../../src/index.default.ts` for the in-tree import path). Run → either green (if Memory adapter matches Node byte-for-byte) or red with a SHA-1 mismatch.

**Green:**
2. If red: the divergence is a real adapter parity bug — open as a finding, fix in `src/adapters/memory/**` (out of scope for *this* PR if non-trivial; spike result + ADR if so).
   If green from the first run: that's the load-bearing proof — Memory's `commit.id` already equals Node's. Commit the test.

**Refactor:**
3. Factor any duplicated `inputs.files` staging logic into `setupMemoryRepo(scenario)` mirroring slice 1.

### Acceptance

- `npm run test:parity` runs both `node.test.ts` and `memory.test.ts` against the same `EXPECTED`. Both pass.
- No `src/` change unless slice 2's red revealed a real adapter bug — in which case capture it as a separate slice 2a + ADR before continuing.

**Commit:** `test(parity): memory driver — parity with node confirmed`.

---

## Slice 3 — Second scenario `branch-lifecycle`

### TDD cycle

**Red:**
1. Add `test/parity/scenarios/branch-lifecycle.scenario.ts` — declares its own `BranchLifecycleResult` (per design §3.1; not the same shape as the round-trip scenario). `INPUTS` seeds one file; `run` does init → add → commit → `branch create feature` → `branch list` → `branch delete feature` → `branch list`. `EXPECTED` golden includes the seed commit.id and the `refs/heads/feature` ID (which equals the seed commit since `branch create` defaults to HEAD).
2. Append `branchLifecycleScenario` to `test/parity/scenarios/index.ts`'s `SCENARIOS` registry — the drivers automatically pick it up via `describe.each(SCENARIOS)`.

**Green:**
3. Run → fill in the two SHA-1 literals from the failed Node-side output.

**Refactor:**
4. The barrel pattern is already in place (from slice 0). If the result-shape branching inside `run` for the lifecycle scenario crosses ~50 lines, extract `branch-lifecycle/operations.ts` colocated with the scenario.

### Acceptance

- `npm run test:parity` runs four assertions: 2 scenarios × 2 drivers.

**Commit:** `test(parity): branch-lifecycle scenario`.

---

## Slice 4 — Determinism audit

### TDD cycle

**Red — detector unit tests:**
1. Add `tooling/test/unit/parity-fixtures/detect-nondeterministic.test.ts` with the standard `describe('Given <fixture>, When detectNondeterministic runs, Then …')` pattern. Six scenarios:
   - bare `Date.now()` → finding
   - `Math.random()` → finding
   - `performance.now()` → finding
   - `new Date('2026-01-01')` → no finding (pinned string literal)
   - `new Date()` (no args) → finding
   - clean module → no findings
2. All red.

**Green — detector implementation:**
3. Add `tooling/audit-parity-fixtures.ts` exposing `detectNondeterministic(source: string, path: string): Finding[]`. Regex-based (matches the pyramid audits' approach in `tooling/test-pyramid/`). Tests go green.
4. Add a small CLI driver in the same file: glob `test/parity/scenarios/**/*.ts` + `test/parity/fixtures.ts`, run the detector, exit `1` on any finding. JSON report to `reports/parity-fixtures.json`.

**Refactor:**
5. If the detector grows past ~80 lines, split into `tooling/parity-fixtures/detect-nondeterministic.ts` (pure) + the CLI driver thin wrapper. Matches the pyramid's split.

**Wireit + validate:**
6. Add `check:parity-fixtures` wireit recipe to `package.json` (command, `files`, `output`).
7. Add `check:parity-fixtures` to the `validate` dependency list.

### Acceptance

- `npm run check:parity-fixtures` exits `0` on the current state.
- `npm run test:unit -- --project unit tooling/test/unit/parity-fixtures` — 100% coverage on the detector module (matches project bar).
- `npm run validate` still passes end-to-end.

**Commit:** `feat(harness): parity-fixtures determinism audit`.

---

## Slice 5 — Browser parity driver

### TDD cycle

**Red — bundle + harness wire:**
1. Add `test/browser/parity-scenarios.bundle.ts` — imports both scenarios from `test/parity/scenarios/**` and assigns `{ [name]: { INPUTS, EXPECTED, run } }` to `window.__tsgitParity`. Adds `window.dispatchEvent(new Event('tsgit-parity:ready'))` for the spec to wait on.
2. Extend `test/browser/index.html` (one new `<script type="module">` import line for `/test/browser/parity-scenarios.bundle.js`).
3. Add `tooling/build-parity-bundle.ts` — standalone rollup invocation reading the bundle entry, emitting `test/browser/parity-scenarios.bundle.js`, ESM, IIFE-style or whatever the Playwright page consumes cleanly via `<script type="module">`.
4. Add `.gitignore` entry for `test/browser/parity-scenarios.bundle.js` and any sourcemap. Verify the `serve.mjs` MIME map covers `.js` (already does — line 16 of `test/browser/serve.mjs`).
5. Add `build:parity` wireit recipe — `command: "node --experimental-strip-types tooling/build-parity-bundle.ts"`, `files: ["test/parity/scenarios/**/*.ts", "test/parity/fixtures.ts", "test/browser/parity-scenarios.bundle.ts", "tooling/build-parity-bundle.ts"]`, `output: ["test/browser/parity-scenarios.bundle.js", "test/browser/parity-scenarios.bundle.js.map"]`. Add `build:parity` to `test:e2e`'s `dependencies` array (alongside `build`). Extend `test:e2e`'s `files` glob to include `test/browser/parity-scenarios.bundle.js` so a stale bundle invalidates `test:e2e`.

**Red — spec:**
6. Add `test/browser/parity.spec.ts` — `test.describe('parity')` containing one `test.describe.each(SCENARIOS)('Given the <name> scenario', (scenario) => test('Then the OPFS-backed result matches EXPECTED', ...))`. Playwright's default per-test isolation (fresh page → `readyPage` fixture → `resetOpfs`) is enough; no `serial` modifier.
   - Body skips on WebKit (existing OPFS-gap pattern).
   - One `page.evaluate(async ({ name, inputs }) => { ... })` per test: opens OPFS root, stages `inputs.files` via writable streams (driver-owned, same pattern as `seedRepo`), opens `Repository` via `tsgit.openRepository({ rootHandle })` inside the evaluate, calls `window.__tsgitParity[name].run(repo, inputs)`, disposes the repo in `finally`, returns the result.
   - The `name` lookup must happen inside `page.evaluate` because the `Scenario` object holds a function and cannot cross the boundary; `INPUTS` is structured-cloneable and passed across as data.
   - Asserts `expect(actual).toEqual(scenario.EXPECTED)` on the Node side.

**Green:**
7. Iterate the spec until both scenarios pass on chromium + firefox. If the OPFS-side commit.id differs from Node's/Memory's, that is a parity bug — same triage rule as slice 2.

**Refactor:**
8. Lift OPFS staging into a `stageFiles(rootHandle, files)` helper inside `parity.spec.ts` or `fixtures.ts`.

### Acceptance

- `npm run test:e2e -- --project=chromium` and `--project=firefox` pass.
- Webkit shows `skipped` for the two parity scenarios (existing pattern).
- The Playwright trace artifact contains the bundled scenarios (chrome-devtools tab shows them in Sources, useful for triage).

**Commit:** `test(parity): browser driver — chromium + firefox`.

---

## Slice 6 — CI wiring

**Files modified:** `.github/workflows/ci.yml`.

1. Add `parity-tests` job: `needs: [changes]`, gate `if: needs.changes.outputs.code == 'true'`, `runs-on: ubuntu-latest`. Steps: `npm run test:parity`. On failure, upload `reports/parity/` as `parity-report-node-memory` artifact, 14-day retention. (Vitest's default JSON reporter writes there if we configure `reporters: ['default', ['json', { outputFile: 'reports/parity/results.json' }]]` for the `parity` project — add to `vitest.config.ts` in this slice.)
2. Rename the Playwright upload artifact from `playwright-report-${{ matrix.browser }}` to `playwright-report-${{ matrix.browser }}-ubuntu`. No behavior change today; future-proof for 19.8's OS matrix expansion.

**Acceptance:**

- The CI workflow YAML lints cleanly (`actionlint` if available locally, otherwise rely on PR push).
- Locally: `act -j parity-tests` if `act` is installed; otherwise rely on the PR run.

**Commit:** `ci: parity-tests job + per-os playwright artifact suffix`.

---

## Slice 7 — Docs refresh + BACKLOG tick + parallel reviews

**Files modified:**

- `docs/BACKLOG.md` — flip `[ ] 19.5` to `[x]` with the ADR references (`ADRs 127–129 · design/phase-19-5-e2e-harness-upgrade.md`).
- `docs/understand/architecture.md` — short paragraph on the three-driver parity layer (one-paragraph add under the existing "Testing" section if present, otherwise after the test-pyramid section).
- `RUNBOOK.md` — `npm run test:parity` recipe + how to update a scenario's `EXPECTED.commit.id` after a deliberate input change.
- `CONTRIBUTING.md` — short callout under "Adding tests" pointing at `test/parity/scenarios/` as the place to add a new cross-adapter scenario.
- `README.md` — only if the "Testing" feature line needs updating; otherwise leave alone (parity is internal harness).

**Parallel agent reviews** (per CLAUDE.md §6):
- `typescript-reviewer` on the diff.
- `security-reviewer` on the diff (the parity bundle is a new browser-served artifact; check for path traversal in `tooling/build-parity-bundle.ts`).
- `test-review` on the new test files (GWT discipline + AAA).
- Pass 1 findings → fix. Pass 2 → fix. Pass 3 → fix or accept with rationale.

**Acceptance:**

- `npm run validate` passes.
- `stryker run` — no new survivors in `src/` (no src changes); audit detector unit tests should hit 0 survivors (regex-heavy code, but the test fixtures kill the obvious mutants).
- `npm run test:parity` and `npm run test:e2e` both green.

**Commit:** `docs: phase 19.5 wrap-up + BACKLOG tick`.

---

## Dependency graph

```
0 (scaffold) ──► 1 (node driver) ──► 2 (memory driver) ──► 3 (second scenario)
                                                              │
                                                              ▼
                                                          4 (audit)
                                                              │
                                                              ▼
                                                          5 (browser driver)
                                                              │
                                                              ▼
                                                          6 (CI wiring)
                                                              │
                                                              ▼
                                                          7 (docs + reviews)
```

Slice 4 only requires slices 0+3 (it audits scenario files); slice 5 only requires slice 0 + a bundle layer over scenarios. The sequence above is preferred for diff narrative, not for technical necessity.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Slice 2 reveals a real Memory ↔ Node parity bug | Spike + ADR, fix in a dedicated slice 2a before continuing. The whole point of 19.5 is to *catch* exactly this. |
| Slice 5's `page.evaluate` cannot return a `Repository` across the boundary | Already known and the design accounts for it — `run` opens, calls, disposes, and returns the `ScenarioResult` inside one `evaluate`. The driver only ships `INPUTS` across. |
| The browser bundle's import paths break in rollup | The standalone rollup config in `tooling/build-parity-bundle.ts` uses the same TypeScript plugin as `rollup.config.ts`; the only new path patterns are `../../src/...` type-only imports (erased) and `./scenarios/*.ts`. Both validate at slice 5 build time. |
| Audit detector regex misclassifies legitimate uses (e.g. a comment containing `Date.now(`) | Detector unit tests in slice 4 explicitly cover comment-only matches and negate-them findings. If a real false positive surfaces post-merge, add it as a test case and tighten the regex. |
| Vitest JSON reporter file path differs from `reports/parity/results.json` | Verify at slice 6 by running `npm run test:parity` locally with the configured reporter and inspecting the actual output path. Adjust the upload step accordingly. |

## Out of scope (reaffirmed from design §4)

- More than two scenarios in this PR. 19.5a's audit fills the rest.
- Deletion of `opfs-roundtrip.spec.ts` / `surface-parity.spec.ts`. ADR-129.
- Property-based scenarios (19.6), interop suite (19.7), runtime matrix (19.8).
