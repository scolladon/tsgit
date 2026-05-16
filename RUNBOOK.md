# Runbook

## Development

### Prerequisites

- Node.js >= 20.3 (matches the `engines` floor — Phase 10 ADR-005)
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
2. **Unit Tests** — Matrix: Ubuntu/macOS/Windows × Node 20/22/24
3. **Mutation Testing** — Stryker (0 survivors target)
4. **Integration Tests** — Real git repos, canonical git interop
5. **E2E Tests** — Playwright: Chrome, Firefox, Safari
6. **Performance** — vitest bench + bundle size checks
7. **MegaLinter** — Comprehensive linting (parallel with all stages)

### Release Process

1. Merge to `main` triggers release-please
2. release-please creates a version bump PR with changelog
3. Merging the release PR pushes a `v*` tag
4. `pre-publish.yml` runs `npm run verify:tarball` against the actual artifact
5. On green, `publish.yml` runs `npm publish` with provenance

#### Cutting a manual patch release

Prefer the release-please path. If you must publish manually:

```bash
# 1. Confirm the working tree is clean and on main.
git checkout main && git pull && git status

# 2. Bump the version and tag.
npm version patch  # creates a vX.Y.Z tag locally

# 3. Run the full verification chain locally before pushing the tag.
npm run validate
npm run verify:tarball

# 4. Push the tag — pre-publish workflow runs automatically.
git push origin main --follow-tags
```

#### Rolling back a bad release

1. `npm deprecate tsgit@<bad-version> "<reason>"` — marks the version deprecated on npm.
2. Revert the offending PR(s) on `main`; release-please will produce a fresh patch.
3. **Never** use `npm unpublish` — it breaks consumers who already locked the version.

#### Rotating secrets

```bash
# NPM token (publish auth) — generate at npmjs.com/settings/<user>/tokens
gh secret set NPM_TOKEN --body "<new-token>"

# Codecov upload token
gh secret set CODECOV_TOKEN --body "<new-token>"
```

After rotation, re-run the latest CI workflow on `main` to confirm both
publish and coverage steps still authenticate.

### Bumping the engines floor

ADR-005 (Phase 10) set the floor to `>=20.3`. To raise it:

1. Update `engines.node` in `package.json` AND add an ADR documenting why.
2. Refresh the CI matrix in `.github/workflows/ci.yml` to drop the now-unsupported line.
3. Mark the bump `BREAKING CHANGE:` in the next commit (release-please promotes to a major bump).

### Secrets Required

| Secret | Where | Purpose |
|---|---|---|
| `RELEASE_PLEASE_PAT` | GitHub repo | PAT for release-please to trigger CI on PRs |
| `NPM_TOKEN` | GitHub repo | npm publish authentication |
| `CODECOV_TOKEN` | GitHub repo | Codecov upload from the Ubuntu × 22 cell |

## One-time GitHub repo setup

These steps require admin access. Document the date + commit SHA when run.

### Branch protection on `main`

```bash
gh api repos/scolladon/tsgit/branches/main/protection \
  --method PUT \
  --field 'required_status_checks[strict]=true' \
  --field 'required_status_checks[contexts][]=lint' \
  --field 'required_status_checks[contexts][]=typecheck' \
  --field 'required_status_checks[contexts][]=unit-tests (ubuntu-latest, 22)' \
  --field 'required_status_checks[contexts][]=integration' \
  --field 'required_status_checks[contexts][]=e2e (chromium)' \
  --field 'required_status_checks[contexts][]=build' \
  --field 'required_pull_request_reviews[required_approving_review_count]=1' \
  --field 'required_pull_request_reviews[dismiss_stale_reviews]=true' \
  --field 'required_linear_history=true' \
  --field 'allow_force_pushes=false' \
  --field 'allow_deletions=false' \
  --field 'enforce_admins=false'
```

`enforce_admins=false` lets the maintainer push the release-please
release tag without a PR; flip to `true` once the bot owns the release
path entirely.

### Repo metadata

```bash
gh repo edit scolladon/tsgit \
  --description "Pure TypeScript git library — Node + browser, zero deps." \
  --add-topic git \
  --add-topic typescript \
  --add-topic nodejs \
  --add-topic browser \
  --add-topic opfs \
  --enable-discussions=true \
  --enable-issues=true
```

### GitHub Pages

The TypeDoc deploy runs from `.github/workflows/gh-pages.yml` and uses
the `github-pages` deployment environment. Enable Pages once via the UI
(Settings → Pages → Source = "GitHub Actions"). Workflow handles the
rest.

### Secret seeding

```bash
gh secret set NPM_TOKEN
gh secret set CODECOV_TOKEN
gh secret set RELEASE_PLEASE_PAT
```

`gh secret set` reads from stdin — paste the value and Ctrl+D.

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
