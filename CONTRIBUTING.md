# Contributing to tsgit

## Git-faithfulness (prime directive)

tsgit replicates canonical git's **observable behaviour byte-for-byte** — object
SHAs, ref & reflog contents, on-disk state files, refusal conditions, and message
formats. **Match git by default.** When in doubt, verify against real `git`
(scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM`, signing off) rather than
guessing its behaviour, and pin the
result with a cross-tool interop test (see [Write-surface interop
audit](#write-surface-interop-audit-phase-197)). A deliberate divergence is
permitted only when it carries its own ADR recording what diverges and why. This is
the project's prime directive — see [ADR-226](docs/adr/226-git-faithfulness-prime-directive.md).

## Development Workflow

1. Create a branch from `main`
2. Write tests first (TDD: Red → Green → Refactor)
3. Implement the feature
4. Run `npm run validate` to verify all quality gates
5. Commit using conventional commits
6. Open a PR — `pkg-pr-new` will comment with an install command
   (`npm install https://pkg.pr.new/scolladon/tsgit@<pr-number>`) that
   lets reviewers smoke-test the build without waiting for a release

## Test Conventions

All tests in this project **must** follow these conventions.

### Test Title Format: Given / When / Then

Every test title describes the context, action, and expected outcome:

```typescript
it('Given <context>, When <action>, Then <expected result>', () => {
  // ...
});
```

Examples:
- `'Given empty repository, When initializing, Then .git directory is created'`
- `'Given packed object, When reading by id, Then content matches original'`
- `'Given two conflicting trees, When merging, Then conflicts are reported'`

### Test Body Format: AAA (Arrange / Act / Assert)

Every test body is structured in three sections with comments:

```typescript
it('Given empty cart, When adding item, Then cart contains one item', () => {
  // Arrange
  const sut = new Cart();
  const item = createItem('widget');

  // Act
  sut.add(item);

  // Assert
  expect(sut.count).toBe(1);
});
```

### System Under Test: `sut`

The variable being tested **must** be named `sut` (System Under Test):

```typescript
it('Given a commit object, When serializing, Then output matches git format', () => {
  // Arrange
  const sut = createCommit({
    tree: treeId,
    parents: [parentId],
    message: 'initial',
  });

  // Act
  const result = serializeCommit(sut);

  // Assert
  expect(result).toEqual(expectedBytes);
});
```

### Test Organization

```text
test/
├── unit/                       # Isolated tests, memory adapter, fast — cross-platform
│   ├── domain/                 # Per-module domain tests
│   ├── ports/                  # Contract test suites (*.contract.ts — imported by adapter tests)
│   └── adapters/               # Per-adapter tests (Memory, Node) that invoke the contract suites
├── integration/
│   ├── network/                # Real repos, cross-adapter, git-http-backend interop (Linux-only)
│   ├── posix-only/             # Real POSIX filesystem semantics (symlinks, chmod, EACCES)
│   └── win-only/               # Real Windows filesystem semantics (8.3 short names, drive letters)
├── browser/                    # Playwright × Chromium/Firefox/WebKit — OPFS round-trip, SubtleCrypto, DecompressionStream, command surface (log/branch/checkout/tag), and the cross-adapter parity driver (parity.spec.ts)
├── parity/                     # Cross-adapter parity scenarios (Phase 19.5) — one Scenario<TResult> per file, asserted byte-identically by node.test.ts, memory.test.ts, and browser/parity.spec.ts
├── runtime-parity/             # Cross-runtime parity drivers (Phase 19.8) — runs the same SCENARIOS registry on Deno (deno/), Bun (bun/), and Cloudflare Workers (workers/) against the dist/ artifact
└── bench/                      # vitest bench scenarios comparing tsgit vs isomorphic-git
```

#### Adding a cross-adapter parity scenario (Phase 19.5)

When a new `Repository` flow needs the Node × Memory × Browser parity
guarantee, add a single file under `test/parity/scenarios/<name>.scenario.ts`:

1. Declare a `<Name>Result` interface — only fields exact-equality-safe
   across all three adapters (use the existing `ChangedPath` shape for
   `status.changes`).
2. Export `scenario: Scenario<<Name>Result>` with `name`, `inputs` (drawn
   from `test/parity/fixtures.ts` constants — no inline literals; the
   `check:parity-fixtures` audit gates determinism), `expected` (with
   40-hex `commit.id` literals — see [ADR-128](docs/adr/128-golden-commit-id-as-parity-signal.md)),
   and `run`.
3. Append to `SCENARIOS` in `test/parity/scenarios/index.ts`. All three
   drivers and the browser bundle pick it up automatically.
4. Run `npm run test:parity` — it fails with the real Node-side SHA-1;
   copy that into `expected.commit.id`. Re-run; then `npm run test:e2e`
   to verify the browser side. See `RUNBOOK.md` → "Cross-adapter parity"
   for the full recipe.

#### Test-folder placement rule (Phase 14.4)

Tests are gated by **folder**, not by `describe.skipIf(process.platform !== '…')`:

- **`test/unit/`** — cross-platform. Platform-aware behaviour is exercised
  via the `PathPolicy` ([ADR-046](docs/adr/046-path-policy-abstraction.md))
  + `FsOperations` ([ADR-047](docs/adr/047-fs-operations-dependency-injection.md))
  injection seam on `NodeFileSystem`. A simulated-Windows test runs on
  every host because the platform is data, not a `process.platform`
  read.
- **`test/integration/posix-only/`** — real POSIX filesystem semantics
  (real symlinks, real mode bits, real `EACCES`). CI: the
  `posix-integration` job (`ubuntu-latest` + `macos-latest`).
- **`test/integration/win-only/`** — real Windows filesystem semantics
  (real 8.3 reconciliation, real drive-letter casing). CI: the
  `win-integration` job (`windows-latest`).

See [ADR-048](docs/adr/048-platform-segregated-test-folders.md) for
the rationale. Do not use `describe.skipIf(process.platform !== '…')`
or `it.skipIf(process.platform !== '…')` to gate platform-specific
behaviour — put the test in the folder that matches the platform it
needs.

### Running test subsets

```bash
# Vitest filters
npx vitest run test/unit/domain/objects/blob.test.ts   # one file
npx vitest run -t "OPFS round-trip"                     # by test title
npx vitest run --project unit                           # whole project
npx vitest run --project integration                    # cross-platform shim

# Browser E2E (build is automatic via wireit)
npm run test:e2e                                        # all 3 browsers
npx playwright test --project=chromium                  # one browser
npx playwright install --with-deps chromium             # first-time setup

# Benchmarks
npm run test:bench                                      # raw JSON in reports/benchmarks/
npm run bench:summary                                   # markdown summary
npm run bench:fixture -- medium                         # pre-warm the scaled-bench fixture

# Runtime-parity matrix (Phase 19.8) — CI-gated; local-optional
npm run test:parity:deno                                # requires Deno on PATH
npm run test:parity:bun                                 # requires Bun on PATH
npm run test:parity:workers                             # uses @cloudflare/vitest-pool-workers (devDep)
```

The runtime-parity matrix (Deno + Bun + Cloudflare Workers) runs as
three blocking jobs in CI on every code-touching PR (ADR-144). It does
**not** join `npm run validate` (ADR-147): contributors who only edit
docs or stay within the Node/Browser/Memory adapters never need to
install Deno or Bun. If you want to validate locally before pushing —
e.g. you touched `src/index.default.ts` or the Memory adapter — install:

```bash
curl -fsSL https://deno.land/install.sh | sh        # ~/.deno/bin/deno
curl -fsSL https://bun.sh/install | bash            # ~/.bun/bin/bun
# wrangler ships as a devDependency; nothing extra to install for Workers.
```

Then run any of the three `test:parity:*` recipes above. The Workers
recipe also serves as the wireit-cached gate for the `parity-workers`
CI job, so a local green is a strong signal for CI.

Bench scenarios are declared with the `benchScenario` wrapper
(`test/bench/support/bench-dsl.ts`) so they read with the same
Given/When/Then discipline as unit tests. Scaled scenarios
(`*-scale.bench.ts`) run against a cached fixture — see RUNBOOK.md.

### Contract Test Pattern

Port behaviors are defined once as reusable test suites in `test/unit/ports/*.contract.ts` and executed against every adapter. Adapters pass a factory returning the adapter plus any fixture helpers it needs:

```typescript
// test/unit/ports/file-system.contract.ts
export interface FileSystemContractEnv {
  readonly fs: FileSystem;
  readonly rootDir: string;
  readonly getRootDirSibling: () => Promise<string>;   // for sibling-bypass tests
  readonly getExistingInRoot: () => Promise<string>;   // for rename-dst tests
  readonly cleanup?: () => Promise<void>;
}

export function fileSystemContractTests(
  createSut: () => Promise<FileSystemContractEnv>,
): void { /* 38 behavioral tests + 34 security-matrix tests */ }

// test/unit/adapters/memory/memory-file-system.test.ts
fileSystemContractTests(async () => ({
  fs: new MemoryFileSystem({ rootDir: '/repo' }),
  rootDir: '/repo',
  getRootDirSibling: async () => '/repo-evil/x',
  getExistingInRoot: async () => '/repo/existing.txt',
}));
```

**Contract files are `.contract.ts` (NOT `.test.ts`)** — vitest picks up only `*.test.ts` directly. Contract files are plain modules imported by adapter test files, so they must explicitly `import { describe, it, expect } from 'vitest'`.

### Coverage Requirements

| KPI | Threshold |
|---|---|
| Line coverage | 100% |
| Branch coverage | 100% |
| Function coverage | 100% |
| Statement coverage | 100% |
| Mutation score | Per-bucket budgets — see [Mutation budgets](#mutation-budgets) |

### Mutation budgets

Mutation testing is bucketed by architecture tier. Each bucket has its own `break` threshold; the PR gate enforces the budget for files touched in the PR diff.

| Bucket | Globs | break | Why |
|---|---|---|---|
| `domain` | `src/domain/**` | 99 | Pure logic, no platform escape hatch. |
| `application` | `src/application/**`, `src/repository.ts`, `src/repository/**`, `src/dispose-adapters.ts` | 95 | Composition of primitives + ports; defensive guards covered by integration. |
| `adapters` | `src/adapters/node/**`, `src/adapters/memory/**`, `src/adapter-detect.ts` | 85 | Errno-conditional code covered by `posix-integration` + `win-integration` jobs, not unit mutation. |
| `infra` | `src/operators/**`, `src/transport/**`, `src/ports/**`, `src/progress.ts` | 90 | Pure operators + timer-sensitive transport middleware. |

Source of truth: `mutation-budgets.json` at repo root. The gate is `npm run check:mutation-budgets`, invoked after `stryker run`.

**Local workflow** (full-tree):
```bash
npm run test:mutation
npm run check:mutation-budgets
```

**CI workflow** (diff-scoped): `.github/scripts/compute-mutation-scope.sh` derives the file list from the PR diff vs `base.sha`; `test:mutation:pr` runs Stryker over that scope; `check:mutation-budgets` evaluates the resulting report. PRs that don't touch `src/` skip mutation entirely. See `docs/design/phase-19-1-mutation-pyramid.md` and ADRs 100–102.

**Equivalent mutants.** When a mutant is provably equivalent (the test would pass for both the original and the mutant), annotate the source with `// equivalent-mutant: <why>` on the line above. No catalogue, no allowlist — the annotation is the documentation.

### Testing-pyramid audit (Phases 19.2 + 19.3 + 19.4)

`npm run check:test-pyramid` (also part of `npm run validate`) counts
unit/integration/e2e tests, reports their share against an 80/15/5 target
(ADR-106), and lints unit tests for expressiveness. Source of truth:
`test-pyramid-budgets.json` at repo root. Tooling lives in `tooling/`
alongside `src/` and `test/`; tooling tests are at `tooling/test/{unit,
integration}/` and are scanned by the same audit globs.

**Report-only (ADR-104, ADR-107, ADR-125)** — never blocks merges:

- **Over-mocked integration** — any `test/integration/**` (or
  `tooling/test/integration/**`) file matching
  `\bvi\.(mock|fn|spyOn|stubGlobal|stubEnv)\(`. Use real fixtures (the memory
  adapter is fine — it's a real class, not a mock).
- **Integration usefulness** — every `test/integration/**/*.test.ts` file
  must carry a `@proves` JSDoc header declaring `surface`, `bucket`, and
  `unique`. The audit reports three classes:
  - `missing` — header absent or grammar-invalid
  - `duplicate` — two files claim the same `(surface, bucket)` pair without
    the platform-only exemption (`posix-only/` + `win-only/` with bucket
    `platform-only` is allowed)
  - `misplaced` — bucket's directory rule rejects the file's directory
    (e.g. `real-http` outside `network/`)

  The audit also writes `reports/integration-surfaces.json` — a derived
  index consumed by browser surface-parity tooling. Ships warn-only;
  promotion to gating is a follow-up PR after one clean observation cycle.

  Bucket taxonomy (one per file):

  | Bucket | What only this tier can prove |
  |---|---|
  | `real-fs` | Real Node `fs` semantics against a tmpdir, OS-agnostic. |
  | `real-http` | Real HTTP socket against canonical `git-http-backend`. |
  | `real-process` | Real `child_process.spawn` against canonical `git`. |
  | `cross-tool-interop` | Bytes on disk round-trip against canonical `git`. |
  | `platform-only` | Behaviour bound to one OS (POSIX perms, NTFS, etc.). |
  | `multi-adapter-parity` | End-to-end flow through the memory adapter. |
  | `coverage-gap` | Code path the unit suite cannot reach. |

**Gating (ADRs 109–116)** — exit code `1` on any finding, fails CI:

- **Under-asserted unit** — `it()`/`test()` blocks in `test/unit/**` whose
  body contains no `expect(...)` / `assert.*(...)` call. Promoted from
  report-only by 19.3. `.skip` / `.todo` / `.fails` exempt.
- **GWT title** — every unit `it()`/`test()` title must match
  `^Given .+?, When .+?, Then .+$` (case-sensitive). Skipped blocks are
  still validated (ADR-113).
- **AAA body comments** — every non-skipped unit test body must contain
  both `// Arrange` and `// Assert` markers at the start of a `//`-comment
  line. Compound forms (`// Arrange + Act`, `// Act + Assert`) count as
  both. `// Act` is optional (ADR-112).
- **`sut` naming** — declaring any of `subject`, `objectUnderTest`,
  `systemUnderTest`, `cut` as a `const`/`let`/`var` in a unit test body is
  rejected. The convention is `sut` (ADR-110). Destructured forms
  (`const { subject } = …`) bypass the check by design.
- **Bare-class `.toThrow(Class)`** — `.toThrow(SomeError)` /
  `.toThrowError(SomeError)` where the only argument is a PascalCase
  identifier is rejected. Replace with a data-bearing matcher such as
  `expect.objectContaining({ data: expect.objectContaining({ code: 'X' }) })`
  or a try/catch with `.data.code` assertions (ADR-111).
- **Empty AAA section** — every `// Arrange`, `// Act`, or `// Assert`
  marker that is *present* in a non-skipped unit body must be followed
  by at least one statement-bearing line before the next marker (or end
  of body). Markers introduced by an autofix but adjacent to another
  marker with nothing between them are flagged: extract a `sut`
  variable, hoist the act statement, or merge the two markers into a
  compound `// Arrange + Assert` line (ADRs 114–116).

**Per-heuristic gating** — flip `gating.<heuristic>` to `true` in
`test-pyramid-budgets.json`. Default-off so a newly-added heuristic ships
report-only until graduated by ADR.

**Self-test exclusions** — files listed in `excludePaths` (e.g. the audit's
own detector tests, which use intentional anti-pattern fixtures) are
skipped from heuristic scanning. Add a path there if a test file is
genuinely demonstrating a lint violation.

**Local escape hatch** — run `node --experimental-strip-types
tooling/audit-test-pyramid.ts --report-only` to inspect findings without
the gate triggering. Useful mid-fix; CI never uses the flag.

### Write-surface interop audit (Phase 19.7)

When you add a module under `src/` that emits Git-on-disk bytes (an
object writer, a refs writer, an index writer, a config writer, …),
declare its surface with a `@writes` JSDoc tag on the module header:

```ts
/**
 * Example writer.
 *
 * @writes
 *   surface: exampleSurface
 *   kind:    byte-identical | equivalent-under-readback | readback-only
 *   format:  git-example-format
 */
```

Then ship a matching integration test under `test/integration/` whose
`@proves` block carries `bucket: cross-tool-interop` and
`interopSurface: <surface name>` (or a comma-list of surface names if
one test covers multiple). The test invokes canonical `git` to
produce reference bytes and asserts the contract for the declared kind
(see `docs/design/phase-19-7-interop-suite.md` §4).

**Composite porcelain (`mv`, `add`, `rm`, `reset`, …)** are *also* `@writes`
surfaces, even though they define no new on-disk format — they compose the
primitive writers, and their end-to-end faithfulness to `git` is what the
cross-adapter parity goldens (tsgit-computed) cannot vouch for (ADR-204). Tag
the command module (`src/application/commands/<cmd>.ts`) with
`surface: <cmd>`, `kind: equivalent-under-readback`, `format:
git-index-tree-state`, and ship `<cmd>-interop.test.ts`. The comparison is the
host-independent **readback** of each side — `git ls-files --stage` (index),
`git write-tree` (tree), `git rev-parse HEAD` (ref) — never raw `.git/index`
bytes (stat-cache fields are per-host). Drive the command through the
`openRepository` facade, not the primitives, and prove refusals symmetrically
(`tryRunGit` confirms git also refuses, with no mutation on either side). See
`docs/design/porcelain-interop-harness.md`.

`npm run check:write-surfaces` (also part of `npm run validate`) walks
both sides and reports gaps, allowlist rot, orphan coverage, and
malformed headers. Ships warn-only (ADR-139) — promotion to blocking
is a follow-up PR after one clean observation cycle. Exemptions live
in `tooling/audit-write-surfaces.allowlist.json` with a written
`reason` and a `deferredTo` phase tag.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

Examples:
- `feat: add packfile reader with delta resolution`
- `fix: correct fanout table binary search off-by-one`
- `refactor: extract tree diff into dedicated domain service`
- `test: add roundtrip tests for commit serialization`

## Code Style

- **Immutability** — All domain objects are `readonly`. Mutations produce new instances.
- **FP-first** — Pure functions, function composition, no shared mutable state.
- **Object Calisthenics** — Branded types for domain concepts. No primitive obsession.
- **Small functions** — Single responsibility. Early returns over nesting.
- **No `any`** — biome enforces `noExplicitAny`. Use `unknown` + type narrowing.
- **Kebab-case files** — Enforced by ls-lint. All `.ts` files in `src/` and `test/` are kebab-case.
- **No tracking refs in code or tests** — Don't write `Phase 14.5`, `§14.5.10`, `ADR-046`, or `BACKLOG`-pointer comments inside source files or test titles. Git history records when and why a change happened; references in code duplicate that and rot when the tracking scheme changes. Tracking refs are fine in commit messages, design docs (`docs/design/`), plans (`docs/plan/`), ADRs (`docs/adr/`), and `BACKLOG.md` itself — those documents are the tracking surface.

## Architecture Rules

1. **Domain has zero outward imports** — `src/domain/` never imports from `application/`, `ports/`, or `adapters/`
2. **Commands use primitives** — `application/commands/` is built from `application/primitives/`
3. **Ports are interfaces only** — `src/ports/` contains no implementations
4. **Adapters implement ports** — Each adapter in `src/adapters/` implements the port interfaces

## Quality Gates

Before any PR can merge, all of these must pass:

- [ ] `npm run check` — biome lint + format
- [ ] `npm run check:types` — tsc strict compilation
- [ ] `npm run check:dead-code` — knip (no unused code)
- [ ] `npm run check:duplicates` — jscpd (no copy-paste)
- [ ] `npm run check:filesystem` — ls-lint (naming conventions)
- [ ] `npm run check:doc-coverage` — every `repo.*` and `repo.primitives.*` has a docs page
- [ ] `npm run check:doc-typedoc` — committed `reports/api.json` matches the regenerated snapshot. **Scoped to `npm run prepush` (and CI), NOT `npm run validate`** — the typedoc regen costs ~10 s + a multi-MB diff on every export-touching change, so it runs at push time instead of every inner-loop check. If the pre-push hook fails because `reports/api.json` is stale, run `npm run docs:json && git add reports/api.json && git commit --amend` (or a fresh commit), then push again.
- [ ] `npm run check:doc-links` — markdown links resolve (requires `lychee` locally; `brew install lychee` / `cargo install lychee`)
- [ ] `npm run test:coverage` — 100% on all KPIs
- [ ] `npm run test:mutation` — Stryker (target 0 survivors)
- [ ] CI pipeline green (7 stages)

### Doc-maintenance harness (Phase 18.3)

Four CI checks detect documentation drift; see `docs/design/18-3-doc-maintenance-harness.md`.

- **Link checker** — `lychee` (Rust binary) scans every `.md` file in the doc tree. Local install: `brew install lychee` or `cargo install lychee`. Run via `npm run check:doc-links`.
- **API coverage** — when you add a `repo.<command>` or `repo.primitives.<primitive>` binding in `src/repository.ts`, the same PR must add the matching `docs/use/{commands,primitives}/<kebab>.md` and a row in the funnel `README.md`.
- **TypeDoc snapshot** — `reports/api.json` is the committed public-surface baseline. After any JSDoc change on an exported symbol, run `npm run check:doc-typedoc` and commit the regenerated `reports/api.json`.
- **Docs PR gate** — CI-only, currently **warn-only**. When you touch `src/application/{commands,primitives}/<name>.ts`, the PR comment will flag a missing matching docs change. Promotion to blocking is tracked as a 18.x follow-up.

## Mutation Testing Discipline

Tests that pass are not necessarily tests that protect. Every feature branch targets **0 surviving mutants**. Mutants that cannot be killed must be:

1. **Provably equivalent** — the mutation produces identical observable behavior for every reachable input. This must be demonstrable via reasoning about the surrounding code, not assumption.
2. **Documented inline** — add a `// equivalent-mutant:` comment next to the mutated construct explaining why the two branches are equivalent. Example:
   ```typescript
   // equivalent-mutant: starting i at segments.length + 1 performs extra undefined-segment
   // skips before landing on the same real index, so the returned value is identical.
   for (let i = segments.length - 1; i >= 0; i--) { /* ... */ }
   ```

**Never use `stryker-disable`, `v8 ignore`, `istanbul ignore`, or other suppression directives without explicit approval.**

## Branch Finalization Checklist

Before merging a feature branch, complete all of these steps:

1. **100% coverage** — `npm run test:coverage` passes the 100% threshold for lines/branches/functions/statements on all files included in `vitest.config.ts` coverage.
2. **Mutation testing** — `npm run test:mutation` passes the 90% break threshold with **0 non-equivalent surviving mutants**. Every surviving mutant must be documented per "Mutation Testing Discipline" above.
3. **Parallel reviews** — run code review, security review, performance review, and test review. For test review, use the `test-review` skill's 10-dimension audit. Address HIGH/CRITICAL findings before merge.
4. **Documentation** — update post-implementation state:
   - `docs/BACKLOG.md` — mark all completed items `[x]`
   - `docs/design/*.md` — status line → `Implemented (at <sha>)` if applicable
   - `docs/adr/*.md` — status → `Accepted (at <sha>)` for new ADRs
   - `README.md` — update the phase-status table if a phase transitions
   - `docs/understand/architecture.md` / `docs/use/recipes.md` / `CONTRIBUTING.md` — reflect any new architectural or testing conventions introduced
5. **Clean commit history** — squash WIP commits; ensure every commit passes tests (pre-commit hooks enforce this).
6. **Worktree cleanup** — after squash-and-merge, `git worktree remove` and `git branch -D` the feature branch.
