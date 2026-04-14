# Runbook

## Development

### Prerequisites

- Node.js >= 18
- npm

### Setup

```bash
git clone <repo-url>
cd tsgit
npm install
```

### Scripts

| Script | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run check` | Lint + format check (biome) |
| `npm run check:fix` | Lint + format auto-fix (biome) |
| `npm run check:types` | Type check (tsc --noEmit) |
| `npm run check:dead-code` | Dead code detection (knip) |
| `npm run check:duplicates` | Copy-paste detection (jscpd) |
| `npm run check:filesystem` | File naming conventions (ls-lint) |
| `npm run check:deps` | Outdated dependencies (npm outdated) |
| `npm run test` | Run all tests |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run test:e2e` | End-to-end tests (Playwright) |
| `npm run test:coverage` | Tests with 100% coverage enforcement |
| `npm run test:mutation` | Mutation testing — incremental (Stryker) |
| `npm run test:bench` | Performance benchmarks |
| `npm run check:architecture` | Hexagonal dependency rules (dependency-cruiser) |
| `npm run check:spelling` | Spell checking (cspell) |
| `npm run check:size` | Bundle size budget (size-limit) |
| `npm run check:exports` | Package exports correctness (attw) |
| `npm run check:security` | Dependency vulnerability audit |
| `npm run validate` | Full validation (all checks + tests) |

### Wireit Caching

Scripts are orchestrated by wireit. Repeat runs of unchanged code are cached:

```bash
npm run check:types  # First run: compiles
npm run check:types  # Second run: [cached] — instant
```

Clear cache: `rm -rf .wireit/`

### Git Hooks

Pre-commit (via husky + lint-staged):
- `biome check --write` — auto-fix lint + format on staged files
- `vitest related --run` — run tests related to changed files

Commit message (via commitlint):
- Must follow conventional commits: `feat:`, `fix:`, `refactor:`, etc.

## CI/CD

### Pipeline Stages

1. **Static Analysis** — biome, tsc, knip, jscpd, ls-lint, npm outdated (parallel)
2. **Unit Tests** — Matrix: Ubuntu/macOS/Windows x Node 18/20/22
3. **Mutation Testing** — Stryker (0 survivors target)
4. **Integration Tests** — Real git repos, canonical git interop
5. **E2E Tests** — Playwright: Chrome, Firefox, Safari
6. **Performance** — vitest bench + bundle size checks
7. **MegaLinter** — Comprehensive linting (parallel with all stages)

### Release Process

1. Merge to `main` triggers release-please
2. release-please creates a version bump PR with changelog
3. Merging the release PR creates a GitHub release
4. GitHub release triggers npm publish with provenance

### Secrets Required

| Secret | Where | Purpose |
|---|---|---|
| `RELEASE_PLEASE_PAT` | GitHub repo | PAT for release-please to trigger CI on PRs |
| `NPM_TOKEN` | GitHub repo | npm publish authentication |

## Troubleshooting

### Build fails with TypeScript errors

```bash
npm run check:types  # See exact errors
```

### Tests fail

```bash
npm run test:unit -- --reporter=verbose  # Detailed output
```

### Mutation testing slow

Stryker uses incremental mode. First run is slow; subsequent runs only re-test changed code.

```bash
npm run test:mutation  # Uses cached results from reports/stryker-incremental.json
```

### Coverage below 100%

```bash
npm run test:coverage  # See uncovered lines in coverage/index.html
```
