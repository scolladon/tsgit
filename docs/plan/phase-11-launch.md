# Plan: Phase 11 — Polish & Launch

Implements [design/phase-11-launch.md](../design/phase-11-launch.md).
Covers [backlog](../BACKLOG.md) items 11.1–11.7.

Phase 11 is release engineering plus verification — most steps are
configuration, harness, and documentation rather than library code. The
exceptions are the Node integration tests (closing the `index.node.ts`
mutation-coverage gap) and the browser-runtime suite (picking up the deferred
Phase 4.8 work).

---

## Backlog → Step Mapping

| Backlog | Description | Step |
|---|---|---|
| **11.2** | Cross-platform CI matrix expansion (Ubuntu/macOS/Windows × Node 20/22/24) | 1 |
| **11.2** | Node integration tests against real disk | 2 |
| **11.3** | Browser E2E suite (Playwright × Chromium/Firefox/WebKit) | 3 |
| **11.1** | Benchmark suite with isomorphic-git baseline | 4 |
| **11.4** | TypeDoc generation + gh-pages deploy | 5 |
| **11.5** | npm publish dry-run + arethetypeswrong verification | 6 |
| — | Documentation refresh (CONTRIBUTING, RUNBOOK, SECURITY, MIGRATION) | 7 |
| **11.6** | GitHub repo setup (branch protection, secrets, metadata) | 8 |
| **11.7** | v1.0.0 release via release-please | 9 |
| — | Mutation testing + final reviews + post-release watch | 10 |

---

## Workflow

Each step follows TDD where applicable (integration + browser tests are real
TDD; benchmarks, docs, and config are not). After every green step run
`npm run validate`.

**Commit strategy.** One commit per substep when small; one per step when
small. Steps 1–6 are independent and can be parallelized across two
contributors; Steps 7–10 are sequential.

**Branch strategy.** Implement on `feat/phase-11-launch` (or worktree).
Plan + design land on main first (this commit). Implementation lands on a
branch and squash-merges.

---

## Prerequisites (before Step 0)

1. Phase 10 merged on main. ✓
2. CI status green on the existing matrix (`ubuntu-latest × 22`).
3. `release-please` bot installed and configured (Phase 0.6).
4. GitHub repo permissions sufficient to add secrets and configure branch
   protection (admin access required for Step 8).

---

## Step 1 — Cross-platform CI matrix expansion

**Design:** §3.

**Modify:** `.github/workflows/ci.yml`.

### 1.1 Matrix expansion

Expand the existing `unit-tests` job from `[ubuntu-latest] × [22]` to:

```yaml
matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]
  node: [20, 22, 24]
```

The existing `coverage upload` step keeps its `if: matrix.os == 'ubuntu-latest' && matrix.node == 22` filter (single canonical cell uploads to Codecov).

### 1.2 Windows-specific test gate

Add an explicit assertion that `validateOptions` accepts Windows absolute
paths on Windows runners:

```typescript
// test/integration/cross-platform/windows-paths.test.ts
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { openRepository } from '../../../src/index.node.js';

describe('Windows path handling', () => {
  it.skipIf(process.platform !== 'win32')(
    'Given a Windows drive-letter cwd, When openRepository runs, Then it does NOT throw INVALID_OPTION',
    async () => {
      const cwd = nodePath.resolve('.');
      // C:\... must be accepted by validateOptions.isAbsolutePath.
      const repo = await openRepository({ cwd });
      expect(repo.ctx.cwd).toBe(cwd);
      await repo.dispose();
    },
  );
});
```

### 1.3 Verify

`npm run check:types && npm run test:unit` must pass on every cell.

**Commit.** `ci: expand unit-test matrix to Ubuntu/macOS/Windows × Node 20/22/24`.

---

## Step 2 — Node integration tests

**Design:** §3.3, §9.3.

**Create:** `test/integration/<scenario>.test.ts` files. Each exercises
`openRepository` from `src/index.node.ts` against a real tmpdir.

### 2.1 Test fixture helper

```typescript
// test/integration/fixtures.ts
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const withTmpRepo = async (
  body: (cwd: string) => Promise<void>,
): Promise<void> => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-it-'));
  try {
    await body(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
```

### 2.2 Round-trip integration

```
Given a fresh tmpdir, When init → add → commit → status round-trips,
Then status reports clean and HEAD points at refs/heads/main.

Given a sub-directory of an initialized repo, When openRepository runs with
that sub-dir as cwd, Then findLayout discovers the parent .git correctly.

Given a long-running log walk, When dispose() is called mid-stream, Then the
in-flight walk rejects with OPERATION_ABORTED (proves dispose's atomic gate
on a real adapter).
```

### 2.3 Wire into CI

Add a `test:integration` script in `package.json`:

```json
"test:integration": "vitest run test/integration"
```

CI runs the integration suite ONCE per matrix cell (no Codecov upload — just
pass/fail).

### 2.4 Coverage on `index.node.ts`

Mutation testing is now able to reach `index.node.ts`. After this step, run
`stryker run --mutate src/index.node.ts` and verify ≥ 80%. Target gaps with
additional integration tests if the score is below target.

**Commit.** `test(integration): add Node-runtime integration suite`.

---

## Step 3 — Browser E2E suite

**Design:** §4.

**Create:** `test/browser/index.html`, `test/browser/browser-bundle.ts`,
`test/browser/<scenario>.spec.ts`.

### 3.1 Bundle entry

```typescript
// test/browser/browser-bundle.ts
import { openRepository } from '../../src/index.browser.js';

declare global {
  interface Window {
    __tsgit: { openRepository: typeof openRepository };
  }
}

window.__tsgit = { openRepository };
```

### 3.2 Static page

```html
<!-- test/browser/index.html -->
<!doctype html>
<title>tsgit browser harness</title>
<script type="module" src="/test/browser/browser-bundle.ts"></script>
```

### 3.3 Playwright config

Update the Phase 0 `playwright.config.ts`:

```typescript
{
  webServer: {
    command: 'vite serve test/browser',
    port: 5173,
    reuseExistingServer: !process.env['CI'],
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
}
```

### 3.4 Scenarios

```
Given an OPFS rootHandle granted by the harness, When init → add → commit →
status round-trips, Then status reports clean.

Given a blob committed in the browser, When the same id is read back via
readBlob, Then the bytes are identical to the original (proves SubtleCrypto
SHA-1 matches Node's crypto).

Given a gzip-compressed pack body, When the browser adapter inflates it via
DecompressionStream, Then the unpacked bytes match a Node-side reference.

Given a fetch to a CORS-disallowed origin, When clone() is called, Then it
throws cleanly (no zombie listeners on the AbortController).
```

### 3.5 CI integration

Add `browser-e2e` job to `ci.yml`, runs only on `ubuntu-latest` (Playwright
Linux supports all three engines). Uploads test artifacts (screenshots,
traces) on failure.

**Commit.** `test(browser): add Playwright E2E suite for OPFS-backed shim`.

---

## Step 4 — Benchmark suite

**Design:** §2.

**Create:** `test/bench/<scenario>.bench.ts` files; `scripts/bench-summarize.ts`;
`reports/benchmarks/.gitkeep`.

### 4.1 Vitest bench config

Add `vitest.bench.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    benchmark: {
      include: ['test/bench/**/*.bench.ts'],
      reporters: ['default', 'json'],
      outputJson: 'reports/benchmarks/raw.json',
    },
  },
});
```

### 4.2 Scenarios

For each row in design §2.2, write a bench file:

```typescript
// test/bench/log.bench.ts
import { bench, describe } from 'vitest';
import * as git from 'isomorphic-git';
import { openRepository } from '../../src/index.node.js';
import { mediumRepoPath } from './fixtures.js';

describe('log:walk-1000-commits', () => {
  bench('tsgit', async () => {
    const repo = await openRepository({ cwd: mediumRepoPath });
    await repo.log({ depth: 1000 });
    await repo.dispose();
  });

  bench('isomorphic-git', async () => {
    await git.log({ fs, dir: mediumRepoPath, depth: 1000 });
  });
});
```

### 4.3 Repo fixtures

`test/bench/fixtures.ts` exposes:
- `smallRepoPath` — synthetic, 50 commits
- `mediumRepoPath` — clone of tsgit itself or a fixed snapshot
- `largeRepoPath` — generated lazily on first run, cached under `~/.cache/tsgit-bench`

### 4.4 Summarizer

`scripts/bench-summarize.ts` reads `reports/benchmarks/raw.json` and emits a
markdown table. Wire into `package.json` as `npm run bench:summary`. Output
path: `reports/benchmarks/summary.md`.

### 4.5 README integration

Add a `## Benchmarks` section to README pointing at the latest summary.

### 4.6 CI

Benchmark runs are NOT in the default `validate` flow (too slow). Add a
nightly workflow `bench.yml` that runs on `ubuntu-latest`, uploads
`reports/benchmarks/` as an artifact, and posts the summary to a Discussions
thread.

**Commit.** `test(bench): add isomorphic-git comparison benchmark suite`.

---

## Step 5 — TypeDoc + gh-pages

**Design:** §5.

### 5.1 Install + configure

```bash
npm install --save-dev typedoc
```

Create `typedoc.json` per design §5.1.

### 5.2 Internal carve-outs

Add `@internal` JSDoc tags to:
- `src/repository.ts` — `RuntimeFallback`, `RepositoryLayoutInput`
- `src/repository/*.ts` — every helper file
- `src/application/commands/internal/*.ts` — every file

### 5.3 npm script

```json
"docs": "typedoc",
"docs:check": "typedoc --emit none --treatWarningsAsErrors"
```

`docs:check` becomes a CI gate ensuring the docs build is clean. Add to
`validate` wireit pipeline.

### 5.4 gh-pages workflow

`.github/workflows/gh-pages.yml`:

```yaml
on:
  push:
    branches: [main]
jobs:
  deploy:
    permissions:
      contents: read
      pages: write
      id-token: write
    steps:
      - actions/checkout@v4
      - uses: ./.github/actions/setup
      - run: npm run docs
      - uses: actions/upload-pages-artifact@v3
        with:
          path: reports/api
      - uses: actions/deploy-pages@v4
```

**Commit.** `docs: generate TypeDoc and deploy to GitHub Pages`.

---

## Step 6 — npm publish dry-run

**Design:** §6.

### 6.1 Tarball verification

Add `scripts/verify-tarball.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

npm pack
TARBALL=$(ls tsgit-*.tgz | tail -1)
SIZE=$(wc -c < "$TARBALL")
[[ $SIZE -lt 524288 ]] || { echo "Tarball $SIZE bytes > 500KB"; exit 1; }

# Inventory check
tar -tzf "$TARBALL" | tee /tmp/tsgit-tarball-inventory.txt
grep -E "^package/dist/" /tmp/tsgit-tarball-inventory.txt > /dev/null
! grep -E "^package/src/" /tmp/tsgit-tarball-inventory.txt
! grep -E "^package/test/" /tmp/tsgit-tarball-inventory.txt
! grep -E "^package/reports/" /tmp/tsgit-tarball-inventory.txt
! grep -E "^package/\.claude/" /tmp/tsgit-tarball-inventory.txt

# Resolution check (already wired as `check:exports`)
npx attw --pack "$TARBALL"

rm "$TARBALL"
```

### 6.2 Pre-publish CI workflow

`.github/workflows/pre-publish.yml`:

```yaml
on:
  push:
    tags: ['v*']
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - actions/checkout@v4
      - uses: ./.github/actions/setup
      - run: npm run build
      - run: bash scripts/verify-tarball.sh
```

### 6.3 Local install smoke-test

Documented in RUNBOOK.md (Step 7 below): `cd /tmp/tsgit-smoke && npm init -y && npm install ../tsgit-x.y.z.tgz` followed by a 10-line script importing
`openRepository` from each public subpath. Run manually before tagging a
release.

**Commit.** `ci: add tarball verification and pre-publish workflow`.

---

## Step 7 — Documentation refresh

**Design:** §9.1.

### 7.1 CONTRIBUTING.md

Update with:
- Development workflow (TDD → validate → mutation → review).
- How to run a single test file, the bench suite, the browser suite.
- Branch + PR process.
- Code review expectations.

### 7.2 RUNBOOK.md

Add a release-engineering section:
- How to bump engines (link to Phase 10's design §11 precedent).
- How to publish a patch release manually (release-please path is preferred).
- How to rotate `NPM_TOKEN`, `CODECOV_TOKEN`.
- How to roll back a bad release (`npm deprecate` + revert PR).

### 7.3 SECURITY.md

Document the threat model from Phase 10 design §5.2.1:
- Trust boundaries (user-supplied adapters wrapped by default;
  `unsafeRawAdapters` is opt-in with documented danger).
- SSRF guards (private-network blocking, scheme allowlist, DNS pinning).
- Sanitization layers (logger, progress text, error reasons).
- Disclosure policy + contact info.

### 7.4 MIGRATION.md

New file. Maps every `isomorphic-git` API to its tsgit equivalent. Format:

```markdown
## `git.log` → `repo.log`

```typescript
// isomorphic-git
import * as git from 'isomorphic-git';
import * as fs from 'node:fs';
const commits = await git.log({ fs, dir: '.', depth: 100 });

// tsgit
import { openRepository } from 'tsgit';
const repo = await openRepository({ cwd: '.' });
const commits = await repo.log({ depth: 100 });
await repo.dispose();
\`\`\`
```

Cover at minimum: `init`, `clone`, `add`, `commit`, `status`, `log`, `branch`,
`checkout`, `tag`, `push`, `fetch`, `merge`, `readBlob`, `walk`. ~14 entries.

**Commit.** `docs: refresh CONTRIBUTING/RUNBOOK/SECURITY; add MIGRATION`.

---

## Step 8 — GitHub repo setup

**Design:** §6.

This step is performed via the GitHub web UI or `gh` CLI; some changes are
config-as-code (workflow files), some require admin clicks. Document the
manual steps in RUNBOOK.md alongside the automated ones.

### 8.1 Branch protection on `main` (UI / `gh api`)

```bash
gh api repos/scolladon/tsgit/branches/main/protection \
  --method PUT \
  --field required_status_checks[contexts][]=lint \
  --field required_status_checks[contexts][]=typecheck \
  --field required_status_checks[contexts][]='unit-tests (ubuntu-latest, 22)' \
  --field required_status_checks[contexts][]='browser-e2e (chromium)' \
  --field required_status_checks[contexts][]=arethetypeswrong \
  --field required_status_checks[contexts][]=mutation \
  --field required_pull_request_reviews[required_approving_review_count]=1 \
  --field required_pull_request_reviews[dismiss_stale_reviews]=true \
  --field required_linear_history=true \
  --field allow_force_pushes=false \
  --field allow_deletions=false
```

### 8.2 Secrets

```bash
gh secret set NPM_TOKEN --body "<token>"
gh secret set CODECOV_TOKEN --body "<token>"
gh secret set GH_PAGES_DEPLOY_KEY --body "<key>"
```

### 8.3 Repo metadata

```bash
gh repo edit scolladon/tsgit \
  --description "Pure TypeScript git library — Node + browser, zero deps." \
  --add-topic git --add-topic typescript --add-topic nodejs \
  --add-topic browser --add-topic opfs \
  --enable-discussions=true \
  --enable-issues=true
```

### 8.4 Issue templates

`.github/ISSUE_TEMPLATE/bug.yml` and `feature.yml` per Phase 0 conventions
(reuse the existing templates if present; otherwise add).

**Commit.** `chore(repo): branch protection rules + issue templates`.

---

## Step 9 — v1.0.0 release

**Design:** §8.

### 9.1 Pre-release checklist

- [ ] All Step 1–8 items merged on `main`.
- [ ] `npm run validate` green.
- [ ] Mutation testing on `ubuntu-latest × 22` reports ≥ 90%.
- [ ] `npm run docs:check` clean.
- [ ] `bash scripts/verify-tarball.sh` clean.
- [ ] README's `## Status` line updated to "v1.0.0 — production-ready".
- [ ] `docs/BACKLOG.md` items 11.1–11.7 marked `[x]`.
- [ ] `MIGRATION.md` reviewed for completeness.

### 9.2 Release-please flow

1. `release-please` opens a release PR with `0.x.y → 1.0.0` and a changelog.
2. Verify the changelog includes the BREAKING engines bump from Phase 10
   under "BREAKING CHANGES".
3. Merge the release PR.
4. Pre-publish workflow runs (Step 6.2). On success, npm publish triggers.
5. Verify on npmjs.com that the package is live, and that
   `npm install tsgit@1.0.0` works in a fresh tmpdir.

### 9.3 Announcement

Per design §8.2:
- Update README badges (npm version, downloads, build status).
- Optional: blog post / Reddit / lobste.rs submission.

**Commit.** Release-please auto-generates the squash commit message
`chore: release 1.0.0`.

---

## Step 10 — Mutation testing + final reviews + post-release watch

### 10.1 Mutation testing

Full-tree mutation run before release:

```bash
node_modules/.bin/stryker run
```

Target: ≥ 90% across the whole project. Address survivors that aren't
provably equivalent.

### 10.2 Parallel reviews

Three parallel agents (design's §6 of the Phase 10 plan precedent):

1. **`code-reviewer`** — quality, idiomatic TypeScript across Phase 11
   additions (mostly tests + tooling).
2. **`security-reviewer`** — secrets handling, supply-chain (npm publish
   workflow), branch-protection completeness.
3. **`test-review`** — integration + browser test coverage, fixture reuse.

Address all CRITICAL + HIGH findings before tagging the release.

### 10.3 Post-release watch list

For the first 14 days after release:

- Monitor GitHub issues; triage every new bug within 24h.
- Watch `npm-stat.com/charts.html?package=tsgit` for adoption.
- Schedule a follow-up agent at +14d to draft a "first-2-weeks retrospective"
  issue with bug tally, adoption numbers, and any patch-level fixes
  surfaced by usage.

**Commit.** Final commit on `main` is the release-please commit (Step 9.2).
Step 10 is verification, not new commits.

---

## Dependency Graph

| Step | Prerequisites | Could parallel with |
|---|---|---|
| 1 (CI matrix) | Phase 10 on main | 4, 5, 7 |
| 2 (integration tests) | 1 | 3, 4, 5, 7 |
| 3 (browser E2E) | none (Playwright already configured) | 1, 2, 4, 5, 7 |
| 4 (benchmarks) | 2 (uses Node integration helpers) | 3, 5, 7 |
| 5 (TypeDoc) | none | 1, 2, 3, 4, 7 |
| 6 (publish dry-run) | 1, 2, 5 (build artifacts must exist) | — |
| 7 (docs refresh) | none | 1, 2, 3, 4, 5 |
| 8 (repo setup) | 1, 3 (status checks must exist before being required) | 7 |
| 9 (v1.0.0 release) | all prior | — |
| 10 (mutation + reviews + watch) | 9 | — |

**Critical path:** 1 → 2 → 6 → 9 → 10 (5 hops); other steps slot in parallel.

**Sequential single-contributor order:** 1 → 2 → 3 → 4 → 5 → 7 → 6 → 8 → 9 → 10.

---

## Post-Plan — beyond v1

Merge of `feat/phase-11-launch` and the v1.0.0 release together close out the
v1 roadmap. The Phase 11 design §9.2 lists deferred work that becomes the
v1.x patch and v2 backlog:

- Pack fetch / pack send loops (clone/fetch/push real I/O).
- Working-tree materialization in checkout.
- Three-way tree merge in merge.
- Progress-update sites in the 5 commands that currently only emit start/end.
- Reflog, hooks, sparse checkout, partial clone (v2).
