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
| `npm run test:mutation` | Mutation testing — full tree (Stryker) |
| `npm run test:mutation:pr` | Mutation testing — diff-scoped (reads `TSGIT_MUTATE_PATHS_FILE` or `--mutate`); CI invokes this |
| `npm run check:mutation-budgets` | Evaluate per-bucket mutation budgets against the latest `reports/mutation/mutation-report.json` (Phase 19.1) |
| `npm run test:bench` | Performance benchmarks |
| `npm run bench:fixture -- <medium\|large>` | Generate + cache a scaled bench fixture |
| `npm run profile` | V8 CPU profiles for log / status / pack-read |
| `npm run check:architecture` | Hexagonal dependency rules (dependency-cruiser) |
| `npm run check:spelling` | Spell checking (cspell) |
| `npm run check:size` | Bundle size budget (size-limit) |
| `npm run check:exports` | Package exports correctness (attw) |
| `npm run check:security` | Dependency vulnerability audit |
| `npm run check:doc-links` | Markdown link checker (`lychee` required) |
| `npm run check:doc-coverage` | Verify every `repo.*` binding has a `docs/use/*` page |
| `npm run check:doc-typedoc` | Verify committed `reports/api.json` matches the regenerated snapshot |
| `npm run docs:json` | Emit `reports/api.json` (the typedoc drift baseline) |
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

### Benchmarking

`npm run test:bench` runs every scenario in `test/bench/`. The small
scenarios build their fixtures inline; the **scaled** scenarios
(`*-scale.bench.ts`) read a cached fixture instead.

- **Pre-warm the cache first:** `npm run bench:fixture -- medium` builds a
  5k-commit / 20k-blob repo under `~/.cache/tsgit-bench` (one-time, ~5 s;
  later runs are cache hits). The scaled benches `skipIf` the fixture is
  absent, so a cold run without `git` on `PATH` skips cleanly.
- **Large fixture:** set `TSGIT_BENCH_LARGE=1` to point the scaled benches at
  the 50k-commit / 200k-blob repo (`npm run bench:fixture -- large` first).
  Opt-in only — it never runs in CI.
- **Profiling:** `npm run profile` captures V8 CPU profiles for the `log`,
  `status`, and `pack-read` hot paths against the medium fixture, writing
  digests to `reports/profiles/` (git-ignored).

## CI/CD

### Pipeline Stages

1. **Static Analysis** — biome, tsc, knip, jscpd, ls-lint, npm outdated (parallel)
2. **Unit Tests** — Matrix: Ubuntu/macOS/Windows × Node 22/24 (Windows re-added in Phase 14.4)
3. **Mutation Testing** — Stryker incremental on PRs (Linux, ADR-044); macOS + Windows nightly via `mutation-os.yml` (ADR-055)
4. **Integration Tests** — Three jobs split by platform contract (see below)
5. **E2E Tests** — Playwright: Chrome, Firefox, Safari (Linux runner)
6. **Performance** — vitest bench (PR base-vs-PR compare + main-push snapshot to the `gh-pages` data branch) + bundle size checks
7. **MegaLinter** — Comprehensive linting (parallel with all stages)

Action references float on major-version tags (`@v4`); Dependabot bumps them
weekly as a single grouped PR (`.github/dependabot.yml`). SHA pinning was
considered and rejected — see ADR-057.

#### Integration test jobs (Phase 14.4)

The integration stage runs three sibling jobs, each gated by the
platform-segregated folder structure described in
[ADR-048](docs/adr/048-platform-segregated-test-folders.md):

| Job                 | Runner(s)                       | Folder                          | What it exercises |
|---------------------|---------------------------------|---------------------------------|-------------------|
| `integration`       | `ubuntu-latest`                 | `test/integration/network/**`   | `git-http-backend` clone/fetch/push, end-to-end protocol scenarios. POSIX-only because the CGI stack is. |
| `posix-integration` | `ubuntu-latest` + `macos-latest`| `test/integration/posix-only/**`| Real POSIX symlinks, real `chmod 0o600` enforcement, real `EACCES` from a locked directory parent. |
| `win-integration`   | `windows-latest`                | `test/integration/win-only/**`  | Real 8.3 short-name parent reconciliation, real drive-letter casing, real Windows symlink-privilege handling, `openRepository` against `C:\`-prefixed paths. |

The cross-platform integration project excludes the `*-only/**`
folders so the Linux `integration` job does not double-run the
platform-bound suites. Tests are gated by their **folder location**,
not by `skipIf` blocks in the test body.

#### Windows-runner notes

The `windows-latest` `unit-tests` cell exercises `NodeFileSystem` via
the `PathPolicy` + `FsOperations` injection seam — every Windows
behavioural test in `test/unit/adapters/node/node-file-system-injected.test.ts`
runs on every OS because the simulated platform is data, not a host
read. The `win-integration` job covers the OS → Node → adapter wiring
that simulation cannot fake (8.3 short-name expansion through real
`fsPromises.realpath`, NTFS reparse-point behaviour). Wall time is
~2–3× Linux; expect ~12–15 min for the `unit-tests` job. Per-PR
mutation stays on Linux (per ADR-044 cost analysis); per-OS mutation on
macOS + Windows runs nightly via the `mutation-os.yml` workflow (ADR-055).

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

### Doc-maintenance harness (Phase 18.3)

Four CI checks detect doc drift; their design lives in
`docs/design/18-3-doc-maintenance-harness.md`. Local reproduction:

```bash
# Markdown link checker (requires lychee binary on PATH).
brew install lychee                # or: cargo install lychee
npm run check:doc-links

# API coverage drift — every repo.*/repo.primitives.* binding has a docs page.
npm run check:doc-coverage

# TypeDoc snapshot drift — regenerate reports/api.json and diff against committed.
npm run check:doc-typedoc

# If reports/api.json is out of date, regenerate and commit:
npm run docs:json
git add reports/api.json
```

The path-based docs PR gate (`docs-pr-gate` job in CI) is GitHub-only — it
reads the changed-file set off the `pull_request` event payload. It is
**warn-only** at land time; a flagged PR receives an informational comment
and step summary but the job continues green. Promotion to a blocking gate
is a follow-up commit (ADR-099).

To debug a broken link locally:

```bash
lychee --config .lychee.toml --verbose README.md docs/**/*.md
```

The output reports each broken target as `<file>:<line> -> <url> (status: …)`.
External-URL flakes (429, transient timeouts) are retried in-process; if a
host is reliably flaky, add it to `.lychee.toml`'s `accept` list rather than
ignoring the link.

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

## Operating git hooks (Phase 17.2)

tsgit runs `.git/hooks/` scripts — `pre-commit` and `commit-msg` during
`commit`, `pre-push` during `push`. Operator-visible behaviour:

- **Default-on (Node).** `openRepository` / `createNodeContext` wire a hook
  runner by default; hooks run as under canonical git. The browser adapter has
  no runner — hooks are inert there.
- **Disabling.** `openRepository({ hooks: false })` or
  `createNodeContext({ hooks: false })` detaches the runner — no hook ever
  runs. Use it when operating on a repository you do not trust: hooks are
  arbitrary scripts that inherit the process environment (`process.env`,
  including any secrets).
- **Per-call skip.** `commit({ noVerify: true })` and `push({ noVerify: true })`
  skip verification for that one call — git's `--no-verify`.
- **Failure.** A non-zero hook exit throws `HOOK_FAILED { hook, exitCode,
  stderr }`; `stderr` is sanitised and capped at 4 KiB. `commit` aborts before
  the ref moves; `push` aborts before any upload.
- **`core.hooksPath`.** Honoured — an absolute path is used as-is, `~/…`
  expands against the home directory, a relative path resolves against the
  working tree. Absent → `${gitDir}/hooks`.
- **`commit-msg`.** The message is round-tripped through `.git/COMMIT_EDITMSG`
  (written, hook run with that path as `argv[1]`, re-read) — a hook may rewrite
  it. `pre-commit` runs before the index is read, so a re-staging hook is
  honoured.
- **Windows.** Hooks are spawned directly — native executables and `.bat` /
  `.cmd` run; extensionless `#!/bin/sh` scripts need a shell on `PATH` (the
  same constraint git-for-Windows carries). See ADR-068.
- **Output bounds.** Captured hook stdout/stderr is capped at 1 MiB per stream;
  a hung hook is killed when `ctx.signal` aborts.

## Operating sparse checkout (Phase 17.3)

`repo.sparseCheckout` materialises only a subset of tracked files into the
working tree. Excluded files keep their index entry, marked **skip-worktree**
(a git index v3 extended flag), so `commit` still records the whole tree.
Operator-visible behaviour:

- **Subcommands.** `{ action: 'set', patterns }` enables sparse checkout and
  restricts the tree to `patterns`; `add` widens it with more patterns;
  `list` returns `{ cone, patterns }`; `reapply` re-applies the on-disk
  patterns; `disable` turns sparse checkout off and re-materialises every
  file. `set`/`add`/`reapply`/`disable` return `{ kind: 'applied',
  materialized, removed, retained }` counts.
- **Pattern modes.** Cone (the default) takes a directory list; non-cone
  (`{ cone: false }`) takes `.gitignore`-style patterns, last-match wins.
  `core.sparseCheckout` / `core.sparseCheckoutCone` gate the feature and are
  written to `.git/config` via a targeted `[core]` line-surgery writer that
  preserves comments and unrelated sections.
- **Persistence ordering.** A mutating action reshapes the working tree
  **first** and persists the pattern file + config only on success — a failed
  apply (e.g. `RESOURCE_LOCKED`) leaves `.git` exactly as it was, never a
  half-state.
- **`reset` / `merge` honour sparse patterns.** `reset --hard` re-materialises
  only in-pattern files; `reset --mixed` rebuilds the index with skip-worktree
  bits intact; a conflicting `merge` keeps excluded blob-backed files out of
  the working tree (it still writes conflict markers and `resolved-merged`
  bytes — content with no other persistence). Excluded entries stay
  `skipWorktree: true`, so `status` never reports a phantom deletion.
- **Dirty out-of-cone files are retained.** When `set`/`reapply` would exclude
  a file that has uncommitted local modifications, the file is **left on disk**
  and its entry keeps `skipWorktree: false` — it is surfaced in
  `result.retained`, never silently discarded. Pass `force: true` to overwrite
  it. (`checkout` differs: a branch switch that would put a dirty file
  out-of-cone refuses the whole operation with `CHECKOUT_OVERWRITE_DIRTY`
  unless forced.)
- **The pattern file is local-only.** `.git/info/sparse-checkout` is never
  transferred by `clone` or `fetch` — same trust boundary as `.git/hooks/`. A
  cloned repo starts non-sparse regardless of the source repo's sparse state.
- **Hand-edited cone files degrade gracefully.** Editing
  `.git/info/sparse-checkout` into a shape that is no longer cone-valid makes
  the loader fall back to non-cone matching with a one-line logged warning —
  never a crash.
- **Size bounds.** The pattern file is capped at 1 MiB
  (`SPARSE_PATTERN_FILE_TOO_LARGE` above it); each pattern is capped at
  256 UTF-8 bytes, max 2048 patterns (`INVALID_OPTION` beyond either).
