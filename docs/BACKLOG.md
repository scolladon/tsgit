# Backlog — tsgit

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` skipped

Details live in git history, ADRs (`docs/adr/`), and design docs (`docs/design/`). This file is the index.

---

## Status

| Stream | Phases | Status |
|---|---|---|
| **v1.0** — foundation through launch | 0–11 | shipped (`@scolladon/tsgit@1.0.0`) |
| **v1.x** — semantic completion | 12–17 | shipped |
| **v1.x** — housekeeping & doc restructure | 18 | in progress (18.2) |
| **v2.0** — test base + porcelain completeness + history rewriting | 19–22 | queued |
| **v3.0** — inspection + maintenance & exotic | 23–24 | queued |
| **v4.0** — transport + signing + perf | 25–26 | queued |

Wave 0 of every major (test base, then docs, then features) is non-negotiable. Performance pass closes each major.

---

## Phase 0 — Engineering harness

- [x] **0.1** Scaffolding (git, dotfiles, package.json, tsconfig)
- [x] **0.2** Build (rollup ESM/CJS, size-limit, attw)
- [x] **0.3** Lint & format (biome, ls-lint, knip, jscpd, cspell, dependency-cruiser)
- [x] **0.4** Test infra (vitest, stryker, playwright)
- [x] **0.5** Git hooks (husky, lint-staged, commitlint)
- [x] **0.6** CI/CD (Actions, release-please, npm publish)
- [x] **0.7** Claude Code hooks (format/typecheck/filename)
- [x] **0.8** Initial docs (README, CONTRIBUTING, DESIGN, RUNBOOK, SECURITY, CLAUDE.md, ADRs)

## Phase 1 — Domain: object model

- [x] **1.1** Value objects (`ObjectId`, `RefName`, `FilePath`, `FileMode`, `AuthorIdentity`)
- [x] **1.2** Blob
- [x] **1.3** Tree (binary format, raw SHA bytes)
- [x] **1.4** Commit (`CommitData`, `AuthorIdentity`)
- [x] **1.5** Tag
- [x] **1.6** `GitObject` discriminated union
- [x] **1.7** Header parsing (`<type> <size>\0<content>`)
- [x] **1.8** `TsgitError` discriminated union

Design: `design/domain-object-model.md`

## Phase 2 — Domain: object storage

- [x] **2.1** Loose object reader (domain)
- [x] **2.2** Loose object writer (domain)
- [x] **2.3** Pack index v2 (fanout binary search)
- [x] **2.4** Packfile v2 reader
- [x] **2.5** Delta resolution (`OBJ_REF_DELTA`, `OBJ_OFS_DELTA`)
- [x] **2.6** Delta base LRU cache
- [x] **2.7** Lookup pipeline (domain blocks; full pipeline in Phase 7)
- [x] **2.8** Packfile writer

Design: `design/object-storage.md`

## Phase 3 — Domain: refs & index

- [x] **3.1** Ref resolution (loose, symbolic, `HEAD`)
- [x] **3.2** Packed-refs reader
- [x] **3.3** Ref peeling
- [x] **3.4** Ref writer (atomic CRUD)
- [x] **3.5** Index v2 reader (stat cache)
- [x] **3.6** Index writer
- [x] **3.7** Stat-cache compare

Design: `design/refs-and-index.md`

## Phase 4 — Ports & adapters

- [x] **4.1**–**4.5** Port interfaces (`FileSystem`, `HttpTransport`, `HashService`, `Compressor`, `ProgressReporter`)
- [x] **4.6** `Context` record
- [x] **4.7** Node adapter
- [x] **4.8** Browser adapter (OPFS, SubtleCrypto, DecompressionStream)
- [x] **4.9** Memory adapter (first-class test fixture)

Design: `design/ports-and-adapters.md`

## Phase 5 — Domain: diff & merge

- [x] **5.1** Tree diff (two-pointer + rename detection)
- [x] **5.2** Working-tree diff (shipped in `status`)
- [x] **5.3** Index diff
- [x] **5.4** Three-way merge engine
- [x] **5.5** Conflict types

Design: `design/diff-and-merge.md`

## Phase 6 — Operators

- [x] **6.1**–**6.8** `pipe`, `filter`, `map`, `flatMap`, `take`, `find`, `toArray`, `groupBy`

Design: `design/operators.md`

## Phase 7 — Primitives (tier 2)

- [x] **7.1**–**7.12** `readObject`, `writeObject`, `readTree`, `writeTree`, `readBlob`, `walkCommits`, `walkTree`, `resolveRef`, `updateRef`, `readIndex`, `createCommit`, `diffTrees`

Design: `design/primitives.md`

## Phase 8 — Transport

- [x] **8.1** Smart HTTP v1 (discovery, negotiation, packfile exchange)
- [x] **8.2**–**8.4** Middleware (`withRetry`, `withAuth`, `withLogging`)

Design: `design/transport.md` · Plan: `plan/phase-8-transport.md`

## Phase 9 — Commands (tier 1)

- [x] **9.1**–**9.16** `init`, `add`, `commit`, `status`, `log`, `diff`, `branch`, `tag`, `checkout`, `clone`, `fetch`, `push`, `merge`, `rm`, `reset`, `revParse`

Design: `design/commands.md`

## Phase 10 — Repository facade

- [x] **10.1** `openRepository` (frozen handle)
- [x] **10.2** Auto-detection (Node / Browser)
- [x] **10.3** Progress integration

Design: `design/repository-facade.md`

## Phase 11 — Polish & launch

- [x] **11.1** Bench suite (log, readBlob, status vs isomorphic-git)
- [x] **11.2** Cross-platform E2E (Ubuntu/macOS/Windows × Node 20/22/24); per-OS mutation closed by 15.4
- [x] **11.3** Browser E2E (Chromium/Firefox/WebKit)
- [x] **11.4** TypeDoc
- [x] **11.5** npm publish dry-run + attw
- [x] **11.6** Repo setup (branch protection, secrets, gh-pages)
- [x] **11.7** v1.0.0 release with sigstore provenance

---

## Phase 12 — Network (v1.x)

- [x] **12.1** `clone` — smart-HTTP pack fetch + write-objects · ADRs 005–007 · `test/integration/network/clone-http-backend.test.ts`
- [x] **12.2** `fetch` — ls-refs + want/have + shallow + prune · ADRs 009–012
- [x] **12.3** `push` — receive-pack + force-with-lease + delete · ADRs 013–016
- [x] **12.4** Bench `clone:small-repo` vs isomorphic-git · ADR-017

## Phase 13 — Working-tree fidelity (v1.x)

- [x] **13.1** `checkout:materialize` (atomic per-file) · ADRs 018–020
- [x] **13.2** `reset --mixed` rebuilds index under lock; stat-cache donor · ADRs 021–022
- [x] **13.3** `reset --hard` composes 13.1 + 13.2 · ADR-023
- [x] **13.4a/b** 3-way merge tree walk + conflict handling · ADRs 026–028 · `design/phase-13-4b-merge-conflict-handling.md`
- [x] **13.5** Lock-first ordering in `checkout`
- [x] **13.6** Path-restore from index via `synthesizeTreeFromIndex`
- [x] **13.7** Defensive path validation at index parser
- [x] **13.8** Bounded-size object reads (`maxBytes`) · ADRs 024–025 · `design/phase-13-8-bounded-object-reads.md`

## Phase 14 — Glob & pathspec (v1.x)

- [x] **14.1** `add --all` + `walkWorkingTree` primitive · ADRs 029–032 · `design/phase-14-1-add-all.md`
- [x] **14.2** Pathspec globs in `add`/`rm`/`checkout` (status filter deferred) · ADRs 037–040
- [x] **14.3** `.gitignore` evaluation in `add --all` + `status` · ADRs 033–036
- [x] **14.4** Windows support (8.3 reconciliation, `ELOOP`/`EACCES` parity, `windows-latest` matrix) · ADRs 041–048 · `design/phase-14-4-windows-support.md`
- [x] **14.5** 14.4 follow-up bundle (13/14 shipped; 14.5.3 abandoned) · ADRs 049–053 · `design/phase-14-5-followups.md`

## Phase 15 — Bench & observability (v1.x)

- [x] **15.1** Medium fixture (5k/20k/~50MB) via `git fast-import`
- [x] **15.2** Large fixture (50k/200k/~500MB, opt-in `TSGIT_BENCH_LARGE=1`) · ADR-054
- [x] **15.3** `node --prof` captures (`npm run profile`)
- [x] **15.4** Per-OS mutation nightly (macOS + Windows) · ADR-055
- [x] **15.5** Bench DSL convention (`benchScenario`)
- [x] **15.6** `benchmark-snapshot` re-enabled · ADR-056

## Phase 16 — Supply-chain & ops hardening (v1.x)

- [-] **16.1** SHA-pin GitHub Actions — abandoned · ADR-057
- [x] **16.2** Dependabot grouped action bumps
- [x] **16.3** Browser E2E surface parity (`log`/`branch`/`checkout`/`tag` on OPFS)
- [x] **16.4** Split OPFS round-trip into per-step assertions

## Phase 17 — Semantic completion (v1.x)

- [x] **17.1** Reflog (`@{N}`, `@{date}`; `show`/`exists`/`delete`/`expire`) · ADRs 058–064 · `design/reflog.md`
- [x] **17.2** Hooks (`pre-commit`/`commit-msg`/`pre-push`, `noVerify`) · ADRs 065–068 · `design/hooks.md`
- [x] **17.3** Sparse checkout (index v3, cone + non-cone) · ADRs 069–074 · `design/sparse-checkout.md`
- [x] **17.3a** Sparse-aware `reset --hard`/`--mixed`/`merge` · ADRs 075–076 · `design/sparse-reset-merge.md`
- [x] **17.3b** Linear non-backtracking glob matcher · ADR-077 · `design/compile-glob-redos.md`
- [x] **17.4** Partial clone (`blob:none`/`blob:limit`/`tree:N`, lazy-fetch, `fetchMissing`) · ADRs 078–082 · `design/partial-clone.md`
- [x] **17.5** Submodule walk (`repo.submodules`, `walkSubmodules` AsyncIterable) · ADRs 083–086 · `design/submodule-walk.md`
- [x] **17.6** `cat-file --batch` (`catFileBatch` primitive + `repo.catFile`) · ADRs 087–090 · `design/cat-file-batch.md`
- [-] **17.7** isomorphic-git compat shim — abandoned · ADR-091

---

## Phase 18 — Housekeeping & doc restructure (v1.x, current)

Ships in v1.x. No major bump (SemVer: additive + cosmetic only).

- [x] **18.1** `examples/try-on-self.mjs` `mode → kind` fix
- [x] **18.2** Audience-first doc restructure. Target: a newcomer grasps tsgit and runs a working snippet in under a minute.
  - **README** — value prop + 60-second quickstart + jump links to the three funnels. Self-contained "Why tsgit": our numbers only, no competitor comparison (deferred to **26.6**). Runtime claims gated on tested matrix: Node + Browser + in-memory only until **19.8** lands Deno/Bun/Workers.
  - **`docs/get-started/`** — `node.md`, `browser.md`, `memory.md`, `migrate-from-isomorphic-git.md`
  - **`docs/use/`** — `api-commands.md` (tier-1 reference + recipes), `api-primitives.md` (tier-2 + composition), `recipes.md` (composed flows), `errors.md`
  - **`docs/understand/`** — `architecture.md`, `design-decisions.md` (curated ADR index), `performance.md`, `security.md`
  - `adr/`, `design/`, `plan/`, `prd/`, `BACKLOG.md` untouched
  - `git rm DESIGN.md MIGRATION.md` — content absorbed into `docs/understand/` and `docs/get-started/`; no redirect stubs (inbound links are internal only)
  - `CLAUDE.md` step 8 + `CONTRIBUTING.md` "Update docs" point at `docs/understand/` and `docs/get-started/` instead of root `DESIGN.md` / `MIGRATION.md`
- [ ] **18.3** Doc-maintenance harness — automated drift detection so the new structure doesn't rot. Follow-up PR after 18.2.
  - Markdown link checker (lychee or markdown-link-check) in CI; fails on broken internal/external links
  - API drift check — `scripts/check-doc-coverage.ts` compares `src/index.{node,browser,default}.ts` exports against the API ToC in `docs/use/api-{commands,primitives}.md`; CI fails on missing entries
  - TypeDoc drift check — regenerated `reports/api/` must equal committed; CI fails on diff
  - Path-based PR gate — when `src/application/{commands,primitives}/` files change, CI requires a corresponding `docs/use/*.md` change in the same PR

---

## Phase 19 — Test base (Wave 0 of v2)

Front-loaded. Every Phase 20+ item ships against this harness. Goal: catch regressions before they ship, not after.

- [ ] **19.1** Mutation pyramid — per-domain budgets + fast PR gate + full nightly. Quarantine equivalent-mutant catalogue.
- [ ] **19.2** Testing-pyramid audit — count unit/integration/e2e, target ratio, flag over-mocked integrations and under-asserted units.
- [ ] **19.3** Unit-test expressiveness lint — enforce `Given/When/Then` titles, AAA body comments, `sut` naming; ban `toThrow(Class)` without data assertion.
- [ ] **19.4** Integration-test usefulness audit — kill duplicates, promote orphans into surface-parity coverage, document what each one proves.
- [ ] **19.5** E2E harness upgrade — Playwright is the browser E2E driver. Deterministic fixtures, traces uploaded on failure. Same suite re-runs against the memory adapter for Node × Browser × Memory parity proof.
- [ ] **19.5a** Playwright surface coverage audit — gap-report every command/primitive without a browser E2E spec; close gaps. CI fails when a new command lands without a matching `test/browser/*.spec.ts`.
- [ ] **19.6** Property-based tests for parsers (objects, refs, index, packfile, pathspec, gitignore).
- [ ] **19.7** Interop suite — round-trip every write path through canonical `git` and assert byte-identical.
- [ ] **19.8** Runtime parity matrix — expand CI to exercise Deno + Bun + Cloudflare Workers against the same contract suite:
  - Deno via npm specifier (`npm:@scolladon/tsgit`)
  - Bun native runner
  - Cloudflare Workers via `wrangler dev` + Workers test harness (memory adapter + HTTP transport)
  - Same scenarios run across all runtimes; failures gate the matrix-wide claim
  - README opener + Capabilities `Cross-runtime` line restored to include Deno/Bun/Workers once green

ADR required for: pyramid ratios, mutation budgets per domain, interop-test scope, runtime-parity contract.

## Phase 20 — Foundation primitives (v2)

High-reuse building blocks. Unlocks Phase 21–22.

- [ ] **20.1** Unified `walk({ trees: [TREE, WORKDIR, STAGE], map })` — closes isomorphic-git parity, becomes the spine of inspection commands.
- [ ] **20.2** Standalone primitives — `hashBlob`, `isIgnored`, `updateIndex` granular CRUD.
- [ ] **20.3** Diff patch-text output (`diff({ format: 'patch' })`); unified-diff serializer in domain.
- [ ] **20.4** Merge state machine — `abortMerge`, `continueMerge`. Prereq for cherry-pick / rebase conflict flow.
- [ ] **20.5** `remote` CRUD porcelain (`add`/`remove`/`rename`/`set-url`/`show`) on `repo.*`.
- [ ] **20.6** `config` porcelain on `repo.*` (read/write user-facing); promote primitive-tier `setConfigEntry`.
- [ ] **20.7** Multi-base `mergeBase` (`--all`, `--octopus`).

## Phase 21 — High-usage porcelain (v2)

Composition on Phase 20.

- [ ] **21.1** `pull` — `fetch` + `merge` (or `rebase` once 22 lands). Refactor opportunity: `pull` is the test that 20.4 + 22.3 compose cleanly.
- [ ] **21.2** `mv` — atomic rename in index + working tree.
- [ ] **21.3** `stash` — `push`/`pop`/`list`/`drop`/`apply`. Introduces working-tree snapshot infra reused by 22.

## Phase 22 — History rewriting (v2)

Dependent chain: 22.1 → 22.2 → 22.3 → 22.4. Each item ships its own conflict-resolution coverage on top of 20.4.

- [ ] **22.1** `cherry-pick` (single + range).
- [ ] **22.2** `revert` (≈ inverted cherry-pick).
- [ ] **22.3** `rebase` (non-interactive).
- [ ] **22.4** `rebase --interactive` (`pick`/`reword`/`edit`/`squash`/`fixup`/`drop`).

v2.0 ships when 22.4 lands. Perf pass for v2 covered in **26**.

---

## Phase 23 — Inspection (v3)

- [ ] **23.1** `show` — formatted object output (commit/tag/tree/blob).
- [ ] **23.2** `describe` — nearest tag distance.
- [ ] **23.3** `blame` — line-by-line authorship via reverse-diff history walk.
- [ ] **23.4** `shortlog` — author summary.
- [ ] **23.5** `range-diff` — compare two commit ranges.
- [ ] **23.6** `whatchanged` — log with raw diffs.

## Phase 24 — Maintenance & exotic (v3)

- [ ] **24.1** `gc` / `repack` / `prune` — pack consolidation.
- [ ] **24.2** `fsck` — repository integrity check.
- [ ] **24.3** `archive` — tar/zip export of a tree.
- [ ] **24.4** `bundle` — create / verify / list-heads.
- [ ] **24.5** `bisect` — binary search.
- [ ] **24.6** `worktree` — add / list / move / remove (distinct working trees over one gitdir).
- [ ] **24.7** `notes` — add / read / list / remove on `refs/notes/*`.

v3.0 ships when 24.7 lands. Perf pass covered in **26**.

---

## Phase 25 — Transport & signing (v4)

- [ ] **25.1** SSH transport — new port; key resolution delegated, browser stays inert.
- [ ] **25.2** GPG signing — new port; signed commits (`-S`), signed tags, signed pushes.
- [ ] **25.3** Smart-HTTP v2.
- [ ] **25.4** Submodule write side — `add`/`init`/`update`/`sync`/`deinit`.
- [ ] **25.5** Hook coverage parity — `post-commit`, `post-merge`, `post-checkout`, `prepare-commit-msg`, `pre-rebase`, `post-rewrite`, server-side hooks.

## Phase 26 — Performance pass (closes v4)

Runs against a stable surface; instruments every command on medium + large fixtures.

- [ ] **26.1** Per-command profile capture (`npm run profile <cmd>`); commit baseline.
- [ ] **26.2** Hot-path optimizations from 26.1 findings (no speculative work).
- [ ] **26.3** Regression gate in CI — `bench:summary` diff must not exceed ±N% per scenario.
- [ ] **26.4** Memory-pressure scenarios (large packs, deep delta chains) added to bench suite.

---

## Abandoned

- **14.5.3** Skip-resolve optimization in `checkContainment` · ADR-053
- **16.1** SHA-pin GitHub Actions · ADR-057
- **17.7** isomorphic-git compat shim · ADR-091

---

## Cross-cutting invariants (apply to every phase ≥19)

- **Per-PR docs** — every command lands its `get-started` / `use` / `understand` entries in the same PR. No "docs come later".
- **Composition over reimplementation** — new commands MUST build on existing primitives (`materializeTree`, `applyChangeset`, `mergeBase`, `walk`). Reviews reject parallel building blocks.
- **ADR per user decision** — when the user weighs in on naming, scope, trade-off, or alternative, capture it as an ADR before moving on.
- **No phase refs in code** — `§N.M` / `Phase X` / `ADR-NNN` / `BACKLOG` refs do not appear in source or tests. The commit is the join point.
- **Mutation hardening** — every PR keeps mutation score at or above baseline. Equivalent mutants documented inline with `// equivalent-mutant: <why>`.

---

## Phase 11 admin tail — completed 2026-05-17

- [x] npm trusted-publisher binding (scolladon/tsgit ↔ `npm-service.yml`)
- [x] `RELEASE_PLEASE_PAT` secret seeded
- [x] Branch protection on `main`
- [x] Repo metadata + topics + Discussions
- [x] GitHub Pages source = GitHub Actions
- [x] Release-please → `v1.0.0` → npm via OIDC

**Lessons (for future packages):**
- npm 10.9.x has a broken trusted-publisher OIDC PUT path; pin publish workflow to Node 24 (npm 11.x).
- npm validates `package.json#repository.url` against sigstore attestation — set `repository`/`homepage`/`bugs` BEFORE first publish.
- Scoped name `@scolladon/tsgit` was forced after npm rejected unscoped `tsgit` as too similar to `ts-git`.
