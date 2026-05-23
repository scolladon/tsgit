# Phase 19.1 — Mutation pyramid

Wave 0 of v2 starts here. Every Phase 20+ command ships against this harness, so 19.1 is a tooling-and-policy phase: no new product code, no new commands, just a stricter, faster, and more honest mutation feedback loop.

## 1. Goals

1. **Per-domain budgets.** The current single global threshold (`high:100 / low:95 / break:90`) treats `src/domain/objects/blob.ts` and `src/adapters/node/node-file-system.ts` the same. They are not the same — one is pure-core logic that must be airtight; the other is platform glue exercised by real-OS integration tests. Budgets must reflect that.
2. **Fast PR gate.** The current per-PR `mutation` job runs Stryker with `--incremental` over the whole tree. On a small diff this is still expensive (Stryker boots a full vitest worker pool). Speed comes from scoping the mutate-set to the diff.
3. **Catch regressions before they ship, not after.** A surviving mutant in a file the PR touched is a PR-time finding. A surviving mutant in a file the PR did not touch is not 19.1's problem — once a bucket meets its budget on `main`, it stays at or above that budget because every future touch is gated.
4. **Don't pay for signal we don't use.** The per-OS nightly mutation job (`mutation-os.yml`) has never caught a platform-specific mutant since it landed (ADR-055). It costs macOS minutes (billed at premium) and Windows minutes. Removed.

## 2. Non-goals

- No equivalent-mutant catalogue. The inline `// equivalent-mutant: <why>` comments stay canonical. A separate generated doc would be a second source-of-truth to maintain.
- No incremental state on the PR gate. Diff-scoping is the bigger lever; incremental adds state-management complexity that diff-scoping makes redundant.
- No change to the `test:mutation` npm script's behaviour for local invocation. Devs still get the full-tree run on demand.

## 3. Domain partitioning — 4 buckets

The architecture tiers collapse to four buckets for budget purposes:

| Bucket | Globs | What lives here | Why this strictness |
|---|---|---|---|
| `domain` | `src/domain/**` | Pure value objects, parsers, binary encoders, ref/index/pack readers, merge engine, diff engine, hooks runner, glob matcher | Zero platform deps. Bugs here are bugs in git's data model. Tests must be exhaustive. |
| `application` | `src/application/**`, `src/repository.ts`, `src/repository/**`, `src/dispose-adapters.ts` | Tier-1 commands (`clone`, `commit`, `status`…), tier-2 primitives (`readObject`, `walkCommits`…), the `openRepository` facade | Composition of pure primitives with effectful ports. Most user-visible behaviour lives here. |
| `adapters` | `src/adapters/node/**`, `src/adapters/memory/**`, `src/adapter-detect.ts` | Node FS, hash, compressor, transport; in-memory test fixture | Platform glue. Real-OS quirks (errno parity, 8.3 names, ELOOP) are exercised by `posix-integration` + `win-integration` jobs, not by mutation alone. Looser budget reflects this. |
| `infra` | `src/operators/**`, `src/transport/**`, `src/ports/**`, `src/progress.ts` | AsyncIterable operators, transport middleware (retry/auth/logging), port interfaces, progress reporter | Thin glue between layers. Operators are pure; transport middleware composes around `HttpTransport`. |

Excluded from mutation entirely (unchanged from current config):
- `src/**/index.ts` — re-export barrels, no behaviour to mutate.
- `src/**/*.d.ts` — type-only.
- `src/adapters/browser/**` — OPFS/SubtleCrypto/DecompressionStream are not callable under vitest's Node runtime.

`src/index.ts` / `src/index.node.ts` / `src/index.browser.ts` / `src/index.default.ts` / `src/global.d.ts` — already excluded via the index/d.ts globs.

## 4. Per-domain budgets

`high` is "score considered green and displayed without warning". `low` is "warn but pass". `break` is "fail the CI job".

| Bucket | high | low | break | Rationale |
|---|---|---|---|---|
| `domain` | 100 | 100 | 99 | Pure logic, no platform escape hatch. 99% break leaves room for one provably-equivalent mutant per ~100 mutants without forcing a `// equivalent-mutant:` annotation on a freshly-touched file. |
| `application` | 100 | 98 | 95 | Composition of primitives; some branches are defensive guards that integration tests cover. |
| `adapters` | 95 | 90 | 85 | Platform branches exercised in real-fs integration jobs; mutation cannot cover errno-conditional code paths because the unit suite stubs the FS. |
| `infra` | 100 | 95 | 90 | Operators are pure (target 100), but transport middleware has retry timers and abort plumbing that mutation tooling can't always reach without flake. |

These thresholds apply to **the set of files mutated in a given run**. On the PR gate, that is the diff scope: if a PR touches one `adapters/` file and three `domain/` files, the gate enforces `domain ≥ 99` and `adapters ≥ 85` for those four files only. Buckets with no mutated files in the run are reported as `n/a` and do not gate.

Rationale and alternatives in [ADR-100](../adr/100-mutation-pyramid-bucket-partitioning.md) and [ADR-101](../adr/101-mutation-budgets-per-bucket.md).

## 5. Enforcement mechanism

Stryker has no native per-folder threshold. Options considered:

1. **Multiple Stryker runs per bucket** — N runs with different `mutate` scopes, each with its own thresholds. Rejected: 4× the boot cost, 4× the runtime worst-case, plus four reports to aggregate.
2. **Single Stryker run + post-process the JSON report** — one run, one report, parse `reports/mutation/mutation-report.json`, bucket the files by glob, compute per-bucket scores, fail if any bucket misses its `break` threshold. Chosen.
3. **Custom Stryker reporter plugin** — same as 2 but as a Stryker reporter. Rejected: extra plugin surface, no benefit over a post-process script that reads the already-emitted JSON.

### The script — `scripts/check-mutation-budgets.ts`

Contract:
- Input: `reports/mutation/mutation-report.json` (Stryker's `mutation-report-schema-v2` JSON, already emitted by the `jsonReporter`).
- Input: `mutation-budgets.json` at repo root — a typed manifest of `{ bucket, globs, thresholds: { high, low, break } }[]`.
- Output: a per-bucket table to stdout (file count, mutants total, killed, survived, score, threshold, status). Exit `0` if every bucket with mutated files meets its `break` threshold, exit `1` otherwise.
- Run as a wireit step `check:mutation-budgets`, depending on `test:mutation`'s `reports/mutation/mutation-report.json` output.

Bucket-assignment algorithm: walk `report.files` keys (paths are repo-relative); for each path, take the **first** bucket in manifest order whose globs match. Disjointness is checked as a side effect of the walk: if any file matches more than one bucket, the script fails with `bucket overlap: <path> matches <bucket-a> and <bucket-b>` before mutation results are aggregated. Paths matching no bucket are also a hard fail — a new src folder added without a bucket update surfaces as `unassigned file: <path>` rather than silent skip. Both error modes exit `1`, fail the CI job, and surface in the PR check.

The manifest itself is validated at load time by a hand-rolled checker (no Zod dep): every bucket has a `name`, `globs` (non-empty array of strings), and a `thresholds` block with three numbers in `0..100`. Malformed manifest → `manifest invalid: <reason>` and exit `1`.

Why this catches the cases we care about:
- A PR drops a `domain/` file's score from 100 to 95: bucket-aggregate for `domain` falls below 99 → break.
- A PR adds a new `application/` file with no tests: bucket-aggregate for `application` falls below 95 → break.
- A PR adds a new `src/foo/` folder with no bucket entry: assignment fails → break.

## 6. Fast PR gate — diff-scoped

The `mutation` job in `ci.yml` changes from:

```yaml
- run: npm run test:mutation:incremental
```

to:

```yaml
- name: Compute mutated file set
  run: bash .github/scripts/compute-mutation-scope.sh > /tmp/mutate.txt
- name: Skip if no src changes
  run: |
    if [ ! -s /tmp/mutate.txt ]; then
      echo "No src/ files changed — skipping mutation"
      exit 0
    fi
- run: npm run test:mutation:pr
  env:
    TSGIT_MUTATE_PATHS_FILE: /tmp/mutate.txt
- run: npm run check:mutation-budgets
```

`compute-mutation-scope.sh` derives the diff from `${{ github.event.pull_request.base.sha }}..HEAD`, filters to `src/**/*.ts`, and excludes the same paths Stryker excludes (`index.ts`, `*.d.ts`, `adapters/browser/**`). Output is a comma-separated absolute-from-repo-root path list — Stryker's `--mutate` accepts that.

`test:mutation:pr` is a new wireit script that runs a tiny shim `scripts/run-stryker-pr.ts`, which reads `TSGIT_MUTATE_PATHS_FILE` (or falls back to `--mutate` argv when invoked locally), splits the comma list, and spawns `stryker run --mutate <list>` non-incremental. The shim keeps the wireit declaration argument-free (wireit caches keyed on declared inputs, not argv), so cache invalidation stays correct across PRs with different diff scopes. `ignoreStatic: true` is already in the config and inherited. Incremental is dropped because the diff scope is the dominant filter; layering incremental on top would re-introduce state-management bugs (incremental cache vs PR base SHA mismatch) for negligible gain.

Fine-tuning beyond diff scope:
- `ignoreStatic: true` — already in `stryker.config.json`; no static fields mutated. Kept.
- `disableTypeChecks: false` — the `typescript-checker` plugin stays on: it rejects mutants that don't compile, saving runner time and removing a class of false-positive surviving mutants.
- `concurrency: "50%"` — kept. CI runners are 4-core; this gives 2 workers, headroom for the vitest reporter.
- `timeoutFactor: 2`, `timeoutMS: 60000` — kept; flaky timeouts are a worse failure mode than slow ones.

The local `npm run test:mutation` keeps the full-tree behaviour (devs sometimes want it). The PR gate uses the new diff-scoped flow.

Detail and trade-offs in the plan (`docs/plan/phase-19-1-mutation-pyramid.md`).

## 7. Per-OS nightly — removed

`.github/workflows/mutation-os.yml` is deleted. Rationale captured in [ADR-102](../adr/102-remove-per-os-mutation-nightly.md), which supersedes ADR-055.

Summary: the job has not caught a platform-specific surviving mutant since it landed. The real-OS coverage that matters lives in `posix-integration` and `win-integration` (which test errno parity, 8.3 names, symlink semantics directly). Mutation testing the adapters on macOS and Windows pays runner cost (macOS minutes are premium-billed) for redundant signal.

Backlog item 11.2 (which ADR-055 used to keep `[x]`) is unaffected: the cross-platform E2E story is the per-OS unit-tests matrix + per-OS integration jobs, not per-OS mutation.

## 8. Equivalent mutants — inline-only

The 16 existing `// equivalent-mutant: <why>` annotations stay where they are. No generated index, no allowlist file, no machine-readable catalogue.

A `check:mutation-budgets` script does not need to know about them: equivalent mutants survive Stryker, count against the bucket score, and force the author to either kill them or annotate-and-accept. The annotation is documentation for future maintainers reading the file, not a CI input.

If a `// equivalent-mutant:` annotation later proves wrong (the mutant is actually killable), removing the annotation is a code change like any other; the next mutation run will surface the survivor and force a real test.

## 9. File layout — what lands in this PR

```
docs/
  design/phase-19-1-mutation-pyramid.md    (this file)
  adr/100-mutation-pyramid-bucket-partitioning.md
  adr/101-mutation-budgets-per-bucket.md
  adr/102-remove-per-os-mutation-nightly.md
  plan/phase-19-1-mutation-pyramid.md
mutation-budgets.json                       (typed manifest; src of truth for buckets + thresholds)
scripts/
  check-mutation-budgets.ts                 (post-process + assertion)
.github/
  scripts/compute-mutation-scope.sh         (PR-diff → mutate-list)
  workflows/
    ci.yml                                  (mutation job rewritten)
    mutation-os.yml                         (deleted)
test/unit/scripts/
  check-mutation-budgets.test.ts            (unit tests for the script — pure I/O at the edges)
test/integration/scripts/
  compute-mutation-scope.test.ts            (real `git diff` against a tmp repo)
package.json                                (wireit: test:mutation:pr, check:mutation-budgets)
stryker.config.json                         (unchanged thresholds; mutate-list unchanged)
docs/BACKLOG.md                             (19.1 → [x])
docs/use/, docs/understand/                  (CONTRIBUTING + understand/quality.md links)
```

`stryker.config.json`'s `thresholds` block stays — it's the safety net for the bare `stryker run` (used locally or on demand). The per-bucket script is the authoritative gate; the global thresholds are a fallback.

## 10. Types and contracts

### `mutation-budgets.json`

```json
{
  "$schema": "./scripts/mutation-budgets-schema.json",
  "buckets": [
    {
      "name": "domain",
      "globs": ["src/domain/**"],
      "thresholds": { "high": 100, "low": 100, "break": 99 }
    },
    {
      "name": "application",
      "globs": [
        "src/application/**",
        "src/repository.ts",
        "src/repository/**",
        "src/dispose-adapters.ts"
      ],
      "thresholds": { "high": 100, "low": 98, "break": 95 }
    },
    {
      "name": "adapters",
      "globs": [
        "src/adapters/node/**",
        "src/adapters/memory/**",
        "src/adapter-detect.ts"
      ],
      "thresholds": { "high": 95, "low": 90, "break": 85 }
    },
    {
      "name": "infra",
      "globs": [
        "src/operators/**",
        "src/transport/**",
        "src/ports/**",
        "src/progress.ts"
      ],
      "thresholds": { "high": 100, "low": 95, "break": 90 }
    }
  ]
}
```

### `scripts/check-mutation-budgets.ts` — public surface

```ts
type BucketName = 'domain' | 'application' | 'adapters' | 'infra';

type Thresholds = Readonly<{ high: number; low: number; break: number }>;

type BucketDefinition = Readonly<{
  name: BucketName;
  globs: readonly string[];
  thresholds: Thresholds;
}>;

type BucketResult = Readonly<{
  bucket: BucketName;
  fileCount: number;
  mutants: { total: number; killed: number; survived: number; noCoverage: number; timeout: number; ignored: number };
  score: number; // 0..100; NaN if no testable mutants
  threshold: number; // the `break` value
  status: 'pass' | 'fail' | 'n/a';
}>;

type BudgetCheckOutcome = Readonly<{
  results: readonly BucketResult[];
  unassignedFiles: readonly string[]; // hard error if non-empty
  ok: boolean;
}>;

export function evaluateBudgets(
  report: StrykerMutationReport,
  manifest: { buckets: readonly BucketDefinition[] }
): BudgetCheckOutcome;
```

Pure function. The CLI wrapper reads the two JSON files, calls `evaluateBudgets`, prints the table, exits `0`/`1`.

Score formula matches Stryker's `mutationScore` (the value the project's existing global `thresholds` already gate on):

```
score = killed / (killed + survived + timeout + noCoverage) * 100
```

`ignored`, `runtimeError`, and `compileError` mutants are excluded from the denominator (same as Stryker's default). `noCoverage` mutants count as "not killed" — uncovered code surfaced via a mutant is still a real test-quality gap, and using `mutationScore` (not `mutationScoreBasedOnCoveredCode`) keeps the gate aligned with the project's "kill every killable mutant" stance.

## 11. Testing strategy

Phase 19.1's own code is small but must be airtight: it is the gate for every other phase.

| Layer | Coverage |
|---|---|
| Unit — `evaluateBudgets` | Empty report → all `n/a`, `ok: true`. Report with one bucket below break → `ok: false`, that bucket `fail`. Unassigned file → `unassignedFiles` non-empty, `ok: false`. Mixed buckets at varying scores → correct per-bucket aggregation. Threshold boundary (exactly at `break`) → `pass`. |
| Unit — bucket assignment | Globs with overlap → longest-prefix wins. Tied prefixes → manifest order. Path not under any glob → unassigned. |
| Integration — `compute-mutation-scope.sh` | Real `git diff` against a tmp repo: no src/ changes → empty output; src/ changes → correct paths; mixed src + test changes → only src; deleted file → excluded; renamed file → new path. |
| Integration — wireit wiring | `npm run check:mutation-budgets` after a `test:mutation` run passes; manually-injected over-budget bucket fails the gate. |

Mutation testing of the new scripts themselves is included in the `infra` bucket (`scripts/**` is not currently mutated; this phase does NOT add it — the scripts are gate code, not product code, and have direct unit tests).

Coverage: 100% on `evaluateBudgets` and the bucket-assignment helpers (enforced by the repo's existing v8 100% gate).

## 12. Trade-offs

### What we accept

- **PR-only enforcement, no main-branch heartbeat.** If `main` ever drifts below a bucket's `break` threshold (e.g. an existing file's tests degrade without anyone editing the file), no automated job catches it. Acceptable because: (a) tests don't degrade without code changes — they degrade because someone edited a test, and that edit is itself a PR; (b) every PR's gate re-establishes the budget for any file it touches.
- **Diff-scoped runs can miss cross-file mutant interactions.** A PR that touches `commands/foo.ts` may inadvertently invalidate a test for `commands/bar.ts`. Test failure (not mutation) catches this — the unit suite still runs full on every PR. Mutation is a code-quality ratchet on touched code, not a regression suite.
- **No per-OS mutation signal.** ADR-102 captures this in full.

### What we explicitly do not accept

- Skipping the gate when "the diff is too big". The fast-gate model means a 50-file PR runs 50 files' worth of mutation, full stop. If that's slow, the PR should probably be smaller.
- Letting a bucket sit below its `break` threshold "until a follow-up." There is no quarantine state; either kill the mutant or annotate-and-accept inline.

## 13. Sequencing

See `docs/plan/phase-19-1-mutation-pyramid.md` for the TDD step-by-step. Headline order:

1. `mutation-budgets.json` + JSON schema, no script yet.
2. `evaluateBudgets` pure function with unit tests (RED → GREEN → REFACTOR).
3. CLI wrapper + wireit script wiring.
4. `compute-mutation-scope.sh` with integration tests against a tmp repo.
5. CI rewrite — `mutation` job uses the new flow.
6. Delete `mutation-os.yml`.
7. Docs (CONTRIBUTING + understand/quality.md update).
8. Flip BACKLOG 19.1 → `[x]`.

## 14. Open risks

- **CI runner perf variance.** Diff scope can still be slow if the diff is large. Mitigated by `concurrency: 50%` and the typescript-checker rejecting non-compiling mutants early; not eliminated. If wall-clock drifts above ~10 min on regular PRs, the next lever is splitting `test:mutation:pr` into a four-cell GitHub Actions matrix (one cell per bucket, each running `stryker run --mutate <bucket-globs ∩ diff>`), then aggregating the four reports in `check:mutation-budgets`. That's a strictly mechanical follow-up — out of scope for 19.1 because we have no data yet that it is needed.
- **`mutation-report.json` schema drift.** Stryker 9.x emits `schemaVersion: "1.0"` at the JSON root (via `mutation-testing-report-schema` 3.x — the package version and the schemaVersion string are intentionally independent). `evaluateBudgets` asserts the schema major matches `1`; an unknown major fails with `unsupported mutation-report schemaVersion: <v>`. Future schema majors require updating the parser before bumping the dep — the parser-level assertion is what catches it.
- **Diff-scope blind spot for new files with the *removed* tests.** A PR that deletes a test file without touching its src file passes the gate (no src in diff). The unit suite catches this through coverage: the removed-test will drop line/branch coverage below 100%, failing `npm run test:coverage` before mutation runs.
