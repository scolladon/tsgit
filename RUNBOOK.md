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
3. Merging the release PR pushes a `v*` tag AND publishes a GitHub Release
4. `pre-publish.yml` runs `npm run verify:tarball` against the actual artifact
5. The GitHub Release event triggers `npm-service.yml`, which runs
   `npm publish --provenance --access public` over OIDC

Authentication to npm uses **trusted publisher** (OIDC), not a long-lived
`NPM_TOKEN`. The workflow's `id-token: write` permission lets GitHub mint a
short-lived OIDC token that npm exchanges for publish rights, gated on the
`scolladon/tsgit` ↔ `.github/workflows/npm-service.yml` binding configured
in the package settings on npmjs.com. No secret rotation required.

First-time binding setup (npmjs.com → tsgit package → Settings → "Trusted
publishers" → Add):
- Publisher: GitHub Actions
- Organization / User: `scolladon`
- Repository: `tsgit`
- Workflow file: `.github/workflows/npm-service.yml`
- Environment: _(leave blank)_

#### PR preview builds (pkg.pr.new)

Every push to a PR (and every push to `main`) is built and published to
[`pkg.pr.new`](https://github.com/stackblitz-labs/pkg.pr.new) — a free
public preview registry that is **separate from the npm registry**. The
`pkg-pr-new` CLI drops a rolling comment on the PR with the install
command:

**One-time setup** — install the [`pkg-pr-new` GitHub App](https://github.com/apps/pkg-pr-new) on
the repository: open it, Configure → Only select repositories → tick `tsgit`.
Without this the workflow exits 404 ("the app is not installed").

```bash
# Install a specific PR's build:
npm install https://pkg.pr.new/scolladon/tsgit@<pr-number>

# Install a specific commit's build (after the PR merges, before release):
npm install https://pkg.pr.new/scolladon/tsgit@<short-sha>
```

Use this for early adopter feedback on a feature before tagging a real
release. Preview tarballs expire on `pkg.pr.new`'s own schedule (weeks,
not months); never depend on a preview URL from a production
`package.json`.

#### Bootstrap: the very first publish

npm's trusted-publisher binding can only be added **after** the package
exists on the registry. The first publish therefore has to happen
manually with a short-lived token; every subsequent publish runs through
the OIDC workflow.

```bash
# 1. Generate a granular automation token scoped to the tsgit package only.
#    npmjs.com → Access Tokens → "Generate New Token" → "Granular Access Token"
#      - Token name: tsgit-bootstrap-publish
#      - Expiration: 7 days (long enough to recover from a bad seed publish)
#      - Packages and scopes: Read and write, tsgit only
#      - IP allowlist + 2FA: leave default

# 2. Verify the build + tarball one last time.
npm run validate
npm run verify:tarball

# 3. Authenticate and publish. Provenance is NOT signed for this seed —
#    it requires the GitHub Actions OIDC token; subsequent CI publishes
#    will carry attestations.
export NODE_AUTH_TOKEN="<token from step 1>"
npm publish --access public

# 4. Verify on npmjs.com/package/tsgit that the version landed.

# 5. Add the trusted-publisher binding:
#    npmjs.com → tsgit package → Settings → "Trusted publishers" → Add
#      - Publisher:        GitHub Actions
#      - Organization:     scolladon
#      - Repository:       tsgit
#      - Workflow file:    .github/workflows/npm-service.yml
#      - Environment:      (blank)

# 6. Revoke the bootstrap token (npmjs.com → Access Tokens → Revoke).
#    From here on the workflow handles publishing via OIDC.
```

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

Only one long-lived secret remains; publish + coverage need no rotation.

```bash
# release-please PAT — must be regenerated when GitHub auto-expires it.
gh secret set RELEASE_PLEASE_PAT --body "<new-pat>"
```

If you ever revoke the npm trusted-publisher binding on npmjs.com you must
re-add it from the package settings page; the workflow needs no change.

### Bumping the engines floor

ADR-005 (Phase 10) set the floor to `>=20.3`. To raise it:

1. Update `engines.node` in `package.json` AND add an ADR documenting why.
2. Refresh the CI matrix in `.github/workflows/ci.yml` to drop the now-unsupported line.
3. Mark the bump `BREAKING CHANGE:` in the next commit (release-please promotes to a major bump).

### Secrets Required

| Secret | Where | Purpose |
|---|---|---|
| `RELEASE_PLEASE_PAT` | GitHub repo | PAT for release-please to trigger CI on its PRs |

npm publish runs via **trusted publisher** OIDC — no `NPM_TOKEN` needed
(see "Release Process" above). Coverage runs locally in CI via vitest's
100% threshold and is uploaded as the `coverage-report-*` workflow
artifact when a run breaches the threshold — no `CODECOV_TOKEN` either.

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

Only one repository secret is required:

```bash
gh secret set RELEASE_PLEASE_PAT
```

`gh secret set` reads from stdin — paste the PAT value and Ctrl+D.

Authentication to npm is **trusted-publisher OIDC**, configured once on
the npmjs.com package page (see "Release Process" above). Coverage runs
inside CI with no external service.

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

## Operating `repo.add({ all: true })` (Phase 14.1)

Bulk-mode `add` walks every file under the working directory via the
new `walkWorkingTree` primitive. Operator-visible behaviours:

- **`.git` skipped** — both the host repository's own `.git` and any
  embedded `.git` (nested clone / worktree pointer). Embedded
  directories yield nothing, so a nested repo never produces a
  `160000` gitlink. This matches Git's default; v1 has no submodule
  support, so a deliberate gitlink would not be honoured.
- **Symlinks staged as `120000`** — the link target string is the
  blob content (POSIX semantics). The walker uses `lstat`, never
  `stat`, so symlinks are never followed.
- **256 MiB per-file cap** — files whose `lstat.size` exceeds
  `MAX_WORKING_TREE_BLOB_BYTES` (256 MiB) cause the call to throw
  `WORKING_TREE_FILE_TOO_LARGE` carrying the offending path, size,
  and limit. No partial commit lands — the `.git/index` is byte-
  identical to the pre-call state.
- **`.gitignore` honoured (Phase 14.3):** four sources are composed
  in evaluation order — `core.excludesFile` (from git config) →
  `.git/info/exclude` → repo-root `.gitignore` → nested
  `.gitignore` files. Last-matching rule wins. `~`-expansion uses
  `ctx.layout.homeDir` (the node shim populates it from
  `os.homedir()`; memory adapter accepts an `homeDir?` option;
  browser leaves it `undefined`). Ignored directories are pruned at
  walk-time — no `lstat` on entries inside them.
- **`status` emits untracked entries** — a non-indexed,
  non-ignored working-tree file now shows up as
  `{ kind: 'untracked', path }`. `clean` is `false` whenever any
  untracked file is present.
- **Tracked-but-ignored stays tracked.** Once a path is in the
  index, no ignore rule un-tracks it (Git's invariant). To stop
  tracking an ignored file, use `repo.rm` explicitly.
- **`.gitignore` size cap:** 1 MiB (`MAX_GITIGNORE_BYTES`). Files
  above the cap throw `GITIGNORE_FILE_TOO_LARGE` — the error
  payload's `path` is the basename only so absolute home-directory
  paths don't leak.
- **Non-regular ignore sources:** symlinks, directories, fifos,
  block devices, and other special files pointed at by
  `core.excludesFile` are silently skipped. Defends against
  configurations like `excludesFile = /dev/zero`.

## Operating pathspec globs (Phase 14.2)

`repo.add`, `repo.rm`, and `repo.checkout({ paths })` accept globs
(`*.ts`, `src/**`) alongside literal paths. Operator-visible behaviour:

- **Detection:** patterns containing `*`, `?`, or `**` are treated
  as globs; everything else is a literal. Literals also match
  descendants (`src` selects `src` and every file under it).
- **Exclusion:** a `!`-prefixed pattern excludes earlier matches.
  Last-match wins (mirrors `.gitignore`).
- **No-match semantics:**
  - Glob with no match → no-op, no throw.
  - Literal with no match → `PATHSPEC_NO_MATCH` (Git-like contract).
- **Pattern budget:** each pattern is capped at 256 UTF-8 bytes
  AND at most 4 `**` tokens. Over either → `INVALID_OPTION` with
  `option: 'paths'`. Bounds compiled-regex cost.
- **Character classes (`[abc]`) and magic prefixes** are NOT
  supported in v1.
- **`status`** does NOT take a `paths` filter — see
  `docs/adr/039-defer-status-pathspec.md`. Filter the returned
  `ChangeEntry[]` client-side if needed.
- **Atomicity** — the `.git/index.lock` is acquired before the walk,
  released after either a successful single-shot commit OR a thrown
  error. Concurrent processes hitting the index see either the old
  or new state, never a partial blend.
