# Design: Phase 11 — Polish & Launch

**Status: Draft** — Phase 11 of the [backlog](../BACKLOG.md).

Phase 11 takes tsgit from "v1 surface ready" (after Phase 10) to a published
v1.0.0 on npm with branch protection, cross-platform CI, browser proof, generated
API docs, and a benchmark suite that demonstrates the speed claim.

This is a **release engineering and verification phase**: most of the work is
configuration, harness, and documentation rather than new library code. The
exceptions are the deferred Phase 4.8 browser-runtime tests and the Phase 10
progress-wiring extension points that need real loops.

---

## 1. Overview

**Six deliverables (matching backlog 11.1–11.7):**

1. **Benchmark suite (11.1).** Reproducible perf comparison against
   `isomorphic-git` for 4 hot paths (`log`, `readBlob`, `status`, `clone`).
   Output: a JSON timing report committed under `reports/benchmarks/` and a
   markdown summary published to the README.

2. **Cross-platform E2E (11.2).** GitHub Actions matrix runs the full unit +
   integration suite on Ubuntu, macOS, and Windows × Node 20 + 22 + 24. (Note:
   the backlog lists Node 18/20/22, but Phase 10 bumped engines to >=20.3 — the
   matrix MUST follow the engines floor.)

3. **Browser E2E (11.3).** Playwright tests in Chromium, Firefox, and WebKit
   exercise `init → add → commit → status → log` round-trip via the OPFS-backed
   adapter. Picks up the deferred Phase 4.8 work.

4. **TypeDoc (11.4).** Generated API documentation published to GitHub Pages.
   Documents every public type and the `openRepository()` surface.

5. **npm publish dry-run (11.5).** `npm pack` + `arethetypeswrong` + manual
   review of the tarball contents. Verifies the conditional-exports wiring
   actually resolves correctly under all four resolution modes.

6. **GitHub repo configuration (11.6).** Branch protection on `main`, required
   status checks, secrets for npm publish, gh-pages deployment, security
   advisories enabled.

7. **v1.0.0 release (11.7).** `release-please` PR merged; npm publish; GitHub
   release notes; announce on relevant channels.

**Scope boundaries.** Phase 11 does NOT:

- Add new commands or primitives. The library surface freezes at the v1 line
  drawn by Phase 10.
- Wire progress-update sites into the 5 commands that currently emit
  start/end pairs only (clone/fetch/push/checkout/merge). Those get real loops
  in v1.x or v2 when the underlying network/working-tree work is implemented.
- Implement working-tree materialization for `checkout` or three-way merge for
  `merge`. Both are explicitly deferred.

---

## 2. Benchmark Suite (11.1)

### 2.1 Methodology

- **Harness:** `vitest bench` for in-process timings; `node --prof` for
  CPU-bound profiling. Reports go to `reports/benchmarks/<scenario>.json`.
- **Baseline:** `isomorphic-git@2` pinned at the time of benchmarking. Captured
  in the report so future re-runs compare like-for-like.
- **Hardware:** GitHub Actions `ubuntu-latest` runners (4 vCPU, 16 GB RAM at
  the time of writing). Local-machine numbers documented separately when
  meaningfully different.
- **Sample sizes:** 100 iterations per scenario; report median, p95, p99.
  Discard the first 10 iterations as warm-up (lets the LRU caches fill).
- **Repos under test:**
  - **small** — 50 commits, 200 blobs, 50 KB total. Synthetic.
  - **medium** — 5,000 commits, 20,000 blobs, 50 MB total. The tsgit repo
    itself (or a fixture clone of it).
  - **large** — 50,000 commits, 200,000 blobs, 500 MB total. A clone of a
    well-known OSS repo (e.g., chromium subset, or a synthetic generator).

### 2.2 Scenarios

| Scenario | tsgit API | isomorphic-git API |
|---|---|---|
| `log:walk-1000-commits` | `repo.log({ depth: 1000 })` | `git.log({ fs, dir, depth: 1000 })` |
| `readBlob:cold-cache` | `repo.primitives.readBlob(id)` (fresh ctx) | `git.readBlob({ fs, dir, oid })` |
| `readBlob:warm-cache` | `repo.primitives.readBlob(id)` (1000th call, same id) | same |
| `status:clean` | `repo.status()` (no working-tree changes) | `git.statusMatrix({ fs, dir })` |
| `status:dirty-100-files` | `repo.status()` (100 modified) | same |
| `clone:small-repo` | `repo.clone({ url })` | `git.clone({ fs, http, dir, url })` |

**Targets:** tsgit must be at least as fast as `isomorphic-git` on all
scenarios; a 2× speedup on `readBlob:warm-cache` and `log:walk-1000-commits` is
the marketing claim worth backing with numbers.

### 2.3 Output format

```json
{
  "scenario": "log:walk-1000-commits",
  "repo": "medium",
  "samples": 100,
  "tsgit":          { "median_ms": 42.1, "p95_ms": 51.2, "p99_ms": 73.4 },
  "isomorphicGit":  { "median_ms": 78.6, "p95_ms": 95.1, "p99_ms": 142.0 },
  "speedup_median": 1.87,
  "captured_at": "2026-05-01T12:00:00Z",
  "node_version": "v22.11.0",
  "isomorphic_git_version": "2.4.0"
}
```

A small CLI (`scripts/bench-summarize.ts`) collates per-scenario JSON files
into a markdown table for the README.

---

## 3. Cross-Platform E2E (11.2)

### 3.1 Matrix

```yaml
matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]
  node: [20, 22, 24]
```

The `ubuntu-latest × 22` cell already runs the full validate pipeline today
(set up in Phase 0). Phase 11 extends that to all 9 cells and adds:

- **Windows-specific path handling.** Confirms `validateOptions.isAbsolutePath`
  accepts `C:\…` (the Phase 10 review fix) on real Windows.
- **macOS APFS quirks.** Case-insensitive filesystem; verify ref names that
  differ only in case do NOT collide.
- **Node 24 forward-compat.** Surface any deprecation warnings before they
  become errors.

### 3.2 Test selection

The 9-cell matrix runs:
- `npm run check:types` (no platform variation, but cheap to verify everywhere)
- `npm run test:unit` (the full suite)
- `npm run test:coverage` ONLY on `ubuntu-latest × 22` (uploads to Codecov).
- `npm run test:integration` (new — see §3.3).

Mutation testing stays on `ubuntu-latest × 22` only (cost-prohibitive across
the matrix).

### 3.3 Integration tests

New: `test/integration/<scenario>.test.ts` — exercise `openRepository` end-to-
end via the Node shim against real disk. Scenarios:

- **init-add-commit-status** round-trip on a fresh tmpdir.
- **clone-from-disk** of a fixture repo seeded by the test setup.
- **dispose-while-in-flight** — start a long-running `repo.log()`, call
  `repo.dispose()` mid-stream, expect `OPERATION_ABORTED`.
- **walk-up cwd discovery** — `cwd` set to a sub-directory of a real repo;
  `findLayout` discovers the .git correctly.

These complement the existing in-memory unit tests (which cover `index.default`
exhaustively) by exercising `index.node` against real I/O. Closes the
0%-mutation-score gap on `index.node.ts`.

---

## 4. Browser E2E (11.3)

### 4.1 Harness

Playwright already has a `playwright.config.ts` (Phase 0 deliverable). Phase 11
adds:

- A test bundle (`test/browser/browser-bundle.ts`) that imports
  `tsgit/auto/browser` and exposes a few global hooks (`window.__tsgit`) for
  the Playwright tests to drive.
- A static page (`test/browser/index.html`) loaded via Playwright's webserver.
- Three browser projects: `chromium`, `firefox`, `webkit`.

### 4.2 Scenarios

- **OPFS round-trip:** `init → add → commit → status` works against the OPFS
  rootHandle the page hands the facade.
- **Hash interop:** a blob committed in the browser can be read back with
  the same id (proves SubtleCrypto SHA-1 matches Node's `crypto`).
- **DecompressionStream:** a gzip-compressed pack body unpacks correctly via
  the browser adapter.
- **Cross-origin transport:** a fetch to a CORS-allowed git server succeeds;
  a fetch to a disallowed origin fails cleanly (no zombie listeners).

CI runs the browser matrix only on `ubuntu-latest` (Playwright supports all
three engines on Linux; macOS/Windows browser CI is out of scope for v1).

---

## 5. TypeDoc (11.4)

### 5.1 Configuration

`typedoc.json`:

```json
{
  "$schema": "https://typedoc.org/schema.json",
  "entryPoints": ["src/index.node.ts"],
  "out": "reports/api",
  "excludePrivate": true,
  "excludeInternal": true,
  "categorizeByGroup": true,
  "navigationLinks": {
    "GitHub": "https://github.com/scolladon/tsgit",
    "npm": "https://www.npmjs.com/package/tsgit"
  }
}
```

The single entry point is the Node shim — it re-exports every public type the
facade needs (`Repository`, `OpenRepositoryOptions`, etc.). The browser/memory
shims add only their runtime-specific options; those get cross-linked from the
Node entry's docs.

### 5.2 Internal carve-outs

The following are marked `@internal` so TypeDoc skips them:

- `RuntimeFallback` and `RepositoryLayoutInput` (shim-to-core plumbing — Phase
  10 review P2)
- Every helper in `src/repository/` (`composeAdapters`, `wrapFsValidator`,
  etc.) is implementation detail
- `src/application/commands/internal/*` is internal to the command tier
- `src/domain/*` is exported for type completeness but not directly consumed

### 5.3 Hosting

Generated docs are committed to the `gh-pages` branch via an Action that runs
on every push to `main`. Public URL: `https://scolladon.github.io/tsgit/`.

---

## 6. npm Publish Dry-Run (11.5)

### 6.1 Verification checklist

- [ ] `npm pack` produces a tarball under 500 KB compressed.
- [ ] Tarball contents include `dist/`, `package.json`, `README.md`, `LICENSE`,
      and NO source `.ts` files, NO test files, NO `reports/`, NO `.claude/`.
- [ ] `arethetypeswrong --pack` reports 🟢 for every export under all four
      resolution modes (CJS-from-CJS, CJS-from-ESM, ESM, bundler).
- [ ] `npm install <tarball>` in a fresh directory succeeds.
- [ ] In that fresh directory:
  - `import { openRepository } from 'tsgit'` resolves to the Node shim and
    works at runtime.
  - `import { openRepository } from 'tsgit/auto/memory'` resolves and works.
  - TypeScript types for both surfaces resolve without errors.

### 6.2 Pre-publish CI hook

Add a `pre-publish.yml` workflow that runs the above checklist on every tag
push (before `release-please` actually publishes). Failure blocks the release.

---

## 7. GitHub Repo Setup (11.6)

### 7.1 Branch protection on `main`

- Require pull request reviews before merging (1 approval).
- Require status checks: lint, typecheck, unit tests (Ubuntu × 22), browser
  E2E (chromium), arethetypeswrong, dependency-cruiser, mutation testing.
- Dismiss stale reviews when new commits land.
- Require linear history.
- No force pushes; no direct pushes (admins included).

### 7.2 Secrets

- `NPM_TOKEN` — for `release-please` publish step.
- `CODECOV_TOKEN` — coverage upload from the Ubuntu × 22 cell.
- `GH_PAGES_DEPLOY_KEY` — TypeDoc deploy.

### 7.3 Repo metadata

- Description: "Pure TypeScript git library — Node + browser, zero deps."
- Topics: `git`, `typescript`, `nodejs`, `browser`, `opfs`.
- License file: MIT (already present).
- `SECURITY.md`: documents the SSRF guards, deepFreeze, sanitization layers,
  `unsafeRawAdapters` warning. Phase 10 docs fill this in.
- GitHub Discussions enabled for community Q&A; Issues enabled with
  `bug.yml` + `feature.yml` templates.

---

## 8. v1.0.0 Release (11.7)

### 8.1 Release-please flow

1. PRs landing on `main` accumulate `feat:` / `fix:` / `BREAKING CHANGE:`
   commits via Conventional Commits.
2. `release-please` (set up in Phase 0.6) opens a release PR with the bumped
   version and generated changelog.
3. The release PR includes the BREAKING engines bump (>=20.3) — the version
   bump must be a major (0.x → 1.0).
4. Merging the release PR triggers `npm publish` via the `pre-publish` workflow
   passing first.
5. GitHub release auto-created with the changelog body.

### 8.2 Announcement copy

Drafted ahead of the release:

- README's `## Status` flips to "v1.0.0 — production-ready".
- Blog post / launch tweet draft: "tsgit v1 — pure TypeScript git for Node +
  browser, zero deps. 1.87× faster than isomorphic-git on log walks. <link>"
- Hacker News submission optional; `r/typescript` and `lobste.rs` more likely
  productive surfaces.

### 8.3 Post-release watch list

For the first 14 days after release:

- Monitor GitHub issues; triage every new bug within 24h.
- Watch `npm-stat` for adoption.
- Open follow-up issues for every Phase 11 deferral that bites real users.

A `/schedule` agent runs at +14d and drafts a "first-2-weeks retrospective"
issue with the bug tally, adoption numbers, and any patch-level fixes
suggested by usage.

---

## 9. Cross-Cutting Concerns

### 9.1 Documentation refresh

Phase 11 also closes documentation gaps that Phase 10 left implicit:

- `CONTRIBUTING.md` updated with the development-workflow loop (TDD →
  validate → mutation → review).
- `RUNBOOK.md` (release engineering: how to bump engines, how to publish a
  patch, how to rotate secrets).
- `SECURITY.md` enumerates the threat model documented in the Phase 10
  facade design.
- A brand-new `MIGRATION.md` for users of `isomorphic-git` who want to
  switch — maps each `isomorphic-git` API to its tsgit equivalent.

### 9.2 Deferred Phase 10 work that Phase 11 may surface

These are NOT Phase 11 deliverables but may need triage during the launch:

- Progress wiring update-sites in `clone:write-objects`, `clone:checkout-files`,
  `fetch:write-objects`, `push:upload`, `checkout:materialize`,
  `merge:write-files`. Each blocked on the underlying loop being implemented;
  v1.x patch releases as the loops land.
- Working-tree materialization in `checkout` (today only updates HEAD).
- Three-way tree merge in `merge` (today writes a merge commit using HEAD's
  tree only).
- Pack fetch / pack send in `clone` / `fetch` / `push`.

### 9.3 Mutation-test gate on `index.node.ts`

Currently 0% (no tests reach that file from the unit-test layer). The Phase 11
integration tests close this by exercising `index.node.ts` end-to-end against
real disk. Target: ≥ 80% on `index.node.ts` after the integration suite lands.

---

## 10. Phase Ownership

### 10.1 New artifacts

| Artifact | Type | Reason |
|---|---|---|
| `reports/benchmarks/*.json` | Benchmark results | §2.3 |
| `scripts/bench-summarize.ts` | Tooling | §2.3 |
| `test/integration/*.test.ts` | Integration tests | §3.3 |
| `test/browser/*.{ts,html}` | Playwright bundle | §4.1 |
| `typedoc.json` | TypeDoc config | §5.1 |
| `.github/workflows/pre-publish.yml` | Release verification | §6.2 |
| `.github/workflows/gh-pages.yml` | TypeDoc deploy | §5.3 |
| `MIGRATION.md` | isomorphic-git → tsgit | §9.1 |

### 10.2 Existing-file modifications

| File | Change | Reason |
|---|---|---|
| `.github/workflows/ci.yml` | Expand matrix to 3×3, add integration job | §3.1 |
| `package.json` | Add `bench`, `test:integration`, `test:browser`, `docs` scripts | §2, §3.3, §4, §5 |
| `README.md` | Add benchmark summary section + links to typedoc | §2.3, §5 |
| `CONTRIBUTING.md` | Document development workflow | §9.1 |
| `RUNBOOK.md` | Add release-engineering section | §9.1 |
| `SECURITY.md` | Threat model from Phase 10 design §5.2.1 | §9.1 |
| `docs/BACKLOG.md` | Mark 11.1–11.7 as `[~]` then `[x]` | tracking |
| `package.json` `version` | Bump to 1.0.0 via release-please | §8.1 |

### 10.3 Out of scope

- Pack fetch / send (deferred to v1.x).
- Working-tree materialization (deferred to v1.x).
- Three-way merge implementation (deferred).
- Sparse checkout, partial clone, hooks, reflog (v2).

---

## 11. Backward Compatibility

Phase 11 is purely additive and verification-focused. The only version-affecting
change is the `0.x → 1.0` major bump performed by `release-please` to surface
the engines floor that already shipped in Phase 10.

No code changes touch the public surface; no `TsgitErrorData` widening; no new
adapters. Existing v0.x consumers (if any) need only:

- Upgrade Node to >= 20.3 (already required by Phase 10's `engines`).
- Update import paths IF they were depending on internal modules — none are
  exported from a public path, so this is a non-issue for clean consumers.

---

## 12. Open Questions

1. **Benchmark hardware variance.** GitHub Actions runner numbers fluctuate
   ±20%. Should we publish numbers from a dedicated bare-metal runner instead?
   Trade-off: reproducibility vs. setup cost. Default: GHA runners with the
   ±20% caveat documented in the README.

2. **Browser E2E hosting.** Playwright tests need a git server endpoint to
   exercise `clone`. Options: spin up an in-memory git-http server inside the
   test (preferred — fast, no external dependency), or use a fixed
   `localhost:port` git daemon. Default: in-memory.

3. **MIGRATION.md scope.** Should it include a runtime compatibility shim for
   `isomorphic-git` consumers? Probably not — that's a v2 concern. Default:
   text-only mapping table.

4. **gh-pages vs. dedicated docs site.** GitHub Pages is free and automatic.
   A dedicated VitePress / Docusaurus site has a richer experience but costs
   more setup. Default: gh-pages with TypeDoc; revisit if v1.x adoption
   warrants a richer site.

---
