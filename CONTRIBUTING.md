# Contributing to tsgit

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
├── browser/                    # Playwright × Chromium/Firefox/WebKit — OPFS round-trip, SubtleCrypto, DecompressionStream, command surface (log/branch/checkout/tag)
└── bench/                      # vitest bench scenarios comparing tsgit vs isomorphic-git
```

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
```

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
| Mutation score | Target: 100% (break threshold: 90%) |

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
- [ ] `npm run test:coverage` — 100% on all KPIs
- [ ] `npm run test:mutation` — Stryker (target 0 survivors)
- [ ] CI pipeline green (7 stages)

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
