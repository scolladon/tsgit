# Backlog — tsgit

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` skipped

Details live in git history, ADRs (`docs/adr/`), and design docs (`docs/design/`). This file is the index.

---

## Status

| Stream | Phases | Status |
|---|---|---|
| **v1.0** — foundation through launch | 0–11 | shipped (`@scolladon/tsgit@1.0.0`) |
| **v1.x** — semantic completion | 12–17 | shipped |
| **v1.x** — housekeeping & doc restructure | 18 | shipped (18.3 doc-maintenance harness) |
| **v2.0** — test base + porcelain completeness + history rewriting | 19–22 | complete; **2.0.0 release PR open via release-please** |
| **v3.0** — inspection + topology + utilities + extension | 23–24 | queued |
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
- [x] **18.3** Doc-maintenance harness — automated drift detection so the new structure doesn't rot. ADRs 095–099 · `design/18-3-doc-maintenance-harness.md`
  - Markdown link checker (lychee in CI via `.lychee.toml`; `npm run check:doc-links` locally)
  - API coverage drift (`scripts/check-doc-coverage.ts` parses `src/repository.ts`, verifies per-file pages + index rows under `docs/use/{commands,primitives}/`)
  - TypeDoc drift (`reports/api.json` committed as baseline; CI diffs against regenerated snapshot)
  - Path-based docs PR gate — warn-only at land time (ADR-099); promote to blocking after one cycle of observation

---

## Phase 19 — Test base (Wave 0 of v2)

Front-loaded. Every Phase 20+ item ships against this harness. Goal: catch regressions before they ship, not after.

- [x] **19.1** Mutation pyramid — per-bucket budgets (domain/application/adapters/infra) + diff-scoped PR gate; per-OS nightly removed (ADR-102 supersedes ADR-055); equivalent-mutant catalogue kept inline-only; docs-only PRs skip code-dependent CI jobs (ADR-103) · ADRs 100–103 · `design/phase-19-1-mutation-pyramid.md`
- [x] **19.2** Testing-pyramid audit — directory-based classification, 80/15/5 target, report-only · ADRs 104–108 · `design/phase-19-2-testing-pyramid-audit.md`
- [x] **19.3** Unit-test expressiveness lint — gates GWT titles, AAA body comments, `sut` naming, bare-class `toThrow` ban, and promotes the under-asserted-unit check from 19.2; ships behind a per-heuristic `gating` map with self-test `excludePaths`; tooling moved from `scripts/` to `tooling/` · ADRs 109–113 · `design/phase-19-3-unit-test-expressiveness-lint.md`
- [x] **19.3a** AAA-marker semantic audit — `emptyAaaSection` heuristic + gate; swept 690 offenders across 60 files into `sut` extractions, dropped Act markers, or compound `// Arrange + Assert` lines · ADRs 114–116 · `design/phase-19-3a-aaa-marker-semantic-audit.md`
- [x] **19.3b** Scanner support for two-stage call shapes — `it.skipIf(cond)('title', body)` / `it.runIf(cond)('title', body)` (mirrored on `describe`) now extract titles via the same path as `it.each([…])(…)`; `isSkipped` stays `false` per ADR-120; zero new findings today (all current `…If` usage is integration-tier, where the gates don't apply) · ADR-120 · `design/phase-19-3b-scanner-skipif-runif.md`
- [x] **19.3c** GWT describe/it split — promote Given/When into `describe()` ancestors, leave `Then` on `it()`. Rewrite `gwtTitle` heuristic to validate the describe→it path; new `scanDescribeBlocks` sibling scanner; one-shot codemod swept ~4,300 leaves across 209 unit files; biome `noExcessiveCognitiveComplexity` disabled for test scopes. Companion CI: `cancel-on-merge.yml` cancels feature-branch CI on PR merge · ADRs 117–119 · `design/phase-19-3c-gwt-describe-it-split.md`
- [x] **19.4** Integration-test usefulness audit — every integration file declares `@proves` (surface, bucket, unique); audit emits `reports/integration-surfaces.json` and three finding classes (missing/duplicate/misplaced); ships warn-only per ADR-125 · ADRs 121–126 · `design/phase-19-4-integration-test-usefulness-audit.md`
- [x] **19.5** E2E harness upgrade — shared `Scenario<TResult>` registry runs against Node + Memory (vitest) + Browser/OPFS (Playwright); golden `commit.id` per scenario is the load-bearing parity assertion; `audit-parity-fixtures` lint gates determinism; new `parity-tests` CI job + per-OS Playwright artifact suffix · ADRs 127–129 · `design/phase-19-5-e2e-harness-upgrade.md`
- [x] **19.5a** Playwright surface coverage audit — `tooling/audit-browser-surface.ts` parses `src/repository.ts`, scans `test/browser/*.spec.ts` + `test/parity/scenarios/*.ts`, exits non-zero on any name without coverage or an allowlist entry; closes 26 gaps via 8 new bundled parity scenarios; opening allowlist holds the four transport commands (deferred to 19.8) + `runHook` (Node-only by adapter design). Blocking gate joined to `validate` per ADR-132 · ADRs 130–133 · `design/phase-19-5a-playwright-surface-coverage-audit.md`
- [x] **19.5b** Browser-surface audit — namespace awareness. `audit-browser-surface.ts` now parses `readonly X: commands.\w+Namespace` bindings (mirroring `check-doc-coverage.ts`) and its call-site scanner detects dotted `repo.X.verb(` invocations, bringing the five nested-namespace CRUD commands (`config`, `remote`, `branch`, `tag`, `sparseCheckout`) under the browser-coverage gate at namespace granularity. `remote`/`branch`/`tag`/`sparseCheckout` were already exercised by existing scenarios/specs; `config` is closed with a dedicated `config.scenario.ts` parity scenario (set/get/unset, local scope) rather than an allowlist entry, since local-scope config is fully browser-capable (ADR-195). Closes the browser-surface half of the gap ADR-194 deferred · ADR-195 · `design/phase-19-5b-browser-surface-namespace-awareness.md`
- [x] **19.6** Property-based tests for parsers — fills the property-test gap on `header`, `file-mode`, `index-parser`, `compile-pathspec`/`match-pathspec`, `parse-gitignore`/`matcher-stack`; `tree`, `refs`, `packfile`, `commit`/`tag`/`object-id`/`author-identity`/`encoding` already covered. New `*.properties.test.ts` siblings co-located with per-family `arbitraries.ts`; tiered `numRuns` budget (200/100/50); 100% mutation score across the six touched parser families · ADRs 134–136 · `design/phase-19-6-property-based-parsers.md`
- [x] **19.7** Interop suite — every byte-emitting module in `src/` carries a `@writes` JSDoc tag; integration tests with `bucket: cross-tool-interop` + `interopSurface:` claim coverage; new `check:write-surfaces` audit detects gaps + allowlist rot + orphan coverage + malformed headers, ships warn-only per ADR-139; three comparison kinds (`byte-identical`, `equivalent-under-readback`, `readback-only`); 13 surfaces shipped (the inventory dropped from 14 once `packIndex` was absorbed into `packfile` per ADR-140); audit caught two real divergences (loose-object zlib compression level + packed-refs trailing space) — the second fixed in this PR · ADRs 137–140 · `design/phase-19-7-interop-suite.md`
- [x] **19.8** Runtime parity matrix — Deno (`Deno.test`) + Bun (`bun:test`) + Cloudflare Workers (`@cloudflare/vitest-pool-workers` inside `workerd`) drivers iterate the shared `SCENARIOS` registry against the `dist/` artifact; three blocking CI jobs (`parity-deno`, `parity-bun`, `parity-workers`); Workers is memory-adapter-only (no `node:fs` in workerd, ADR-143), Deno + Bun cover Node + Memory; matrix gates the README `Cross-runtime` claim, no `continue-on-error` (ADR-144); CI-only, not in `npm run validate` so contributors don't need Deno/Bun/wrangler locally (ADR-147) · ADRs 141–147 · `design/phase-19-8-runtime-parity-matrix.md`

ADR required for: pyramid ratios, mutation budgets per domain, interop-test scope, runtime-parity contract.

## Phase 20 — Foundation primitives (v2)

High-reuse building blocks. Unlocks Phase 21–22.

- [x] **20.1** Snapshot+join surface (`repo.snapshot.head/index/workdir/…` + `join`/`innerJoin` + operators). The engine shipped in Wave 1 (#81): resolvers, bus + view, snapshot impls, factory, join, operators, public exports. **The surface is additive** — investigation showed it does NOT subsume `walkTree`/`walkWorkingTree` (no subtree enumeration; reduced working-tree stat), so the walkers are kept public as first-class primitives, the snapshot is the recommended high-level read path, and no consumer was migrated (ADR-239 supersedes ADR-152's deprecation cycle; design/plan Waves 2–8 withdrawn). The walker-below-snapshot one-way layering is lint-enforced (`primitives-cannot-import-adapters`). · ADR-239
- [x] **20.2** Standalone primitives — `hashBlob`, `isIgnored`, plus granular index CRUD (`stageEntry`, `unstageEntry`, `setEntryFlags`) · ADRs 162–165 · `design/phase-20-2-standalone-primitives.md`
- [x] **20.3** Diff patch-text output (`diff({ format: 'patch' })`); unified-diff serializer in domain. Reuses Myers (`diffLines`) for hunk grouping; canonical headers for add/delete/modify/rename/type-change/binary; OID abbrev=7, default context=3. Byte-parity with `git diff` double-pinned (live + frozen golden). · ADRs 166–169 · `design/phase-20-3-diff-patch-format.md`
- [x] **20.4** Merge state machine — `abortMerge`, `continueMerge` on `repo.*`. `abortMerge` hard-resets HEAD/index/working-tree to `ORIG_HEAD` and clears `MERGE_HEAD` + `MERGE_MSG` (preserves `ORIG_HEAD` as cross-operation recovery aid); `continueMerge` thin-wraps `commit` with a precondition that `MERGE_HEAD` exists. New `NO_OPERATION_IN_PROGRESS` error code mirrors the existing `OPERATION_IN_PROGRESS`. Pre-shapes Phase 22's cherry-pick / rebase abort+continue. · ADRs 170–174 · `design/phase-20-4-merge-state-machine.md`
- [x] **20.5** `remote` CRUD porcelain (`add`/`remove`/`rename`/`setUrl`/`show`) on `repo.*`. Action-discriminated single-method surface (ADR-175); default fetch refspec `+refs/heads/*:refs/remotes/<name>/*` on `add` (ADR-176); `remove` drops the config section + tracking refs + clears `branch.<X>.remote`/`merge` referrers (ADR-177); `rename` conservatively rewrites the canonical refspec only and moves loose tracking refs (ADR-178); `setUrl { push: true }` writes `pushurl` and `push` honours `pushurl ?? url` (ADR-179); `show` is local-only — no network query (ADR-180). New domain codes `REMOTE_EXISTS`, `REMOTE_NAME_INVALID`. `validateRemoteName` rejects `\n` / `\r` / `\t` / `\0` / `"` / `\\` / `]` / `/` (slash ban prevents cross-remote ref deletion via prefix collision). · ADRs 175–180 · `design/phase-20-5-remote-crud-porcelain.md`
- [x] **20.6** `config` porcelain on `repo.*` (read/write user-facing); promote primitive-tier `setConfigEntry`. Ships nested-namespace shape (`repo.config.get/set/unset/unsetAll/getAll/getRegexp/list/renameSection/removeSection`) per ADR-181; all four scopes (local/global/system/worktree) per ADR-182; quote-on-write per ADR-186; pure text-helper rename to `*InText` suffix per ADR-188. New `FileSystem.homedir/xdgConfigHome/systemConfigPath` capabilities; FS validator allowlists the four scope paths. · ADRs 181–188 · `design/phase-20-6-config-porcelain.md`
- [x] **20.7** Multi-base `mergeBase` (`--all`, `--octopus`). Breaking unified array API `mergeBase(commits, { all?, octopus? }): readonly ObjectId[]` (ADR-189); Git-faithful paint-down-to-common (date-PQ + `STALE` + `remove_redundant`), results match Git including criss-cross multi-LCA (ADR-190); legacy bidirectional BFS deleted, single-base routed through the one core, `merge.ts` migrated to `const [base] = …` (ADR-191). `--octopus` folds pairwise then reduces. 100% coverage + 100% mutation (order-independence + `removeRedundant` safety-net equivalents annotated). · ADRs 189–191 · `design/phase-20-7-multi-base-merge-base.md`
- [x] **20.8** Migrate CRUD-family porcelain (`repo.remote`, `repo.branch`, `repo.tag`, `repo.sparseCheckout`) from action-discriminator (ADR-175) to nested namespace (ADR-181). Per-verb Context-aware functions with concrete result types — no `kind`/`action` discriminator on input OR result (ADR-192); the callable discriminator form is hard-removed (`repo.X` is a frozen non-callable namespace object, ADR-193); ADR-175 marked Deprecated. doc-coverage audit taught to recognise `commands.*Namespace` bindings so the five CRUD namespaces stay enforced; browser-surface namespace awareness deferred to **19.5b** (ADR-194). `reflog`/`submodules` stay on the discriminator (out of ADR-181 scope). · ADRs 192–194 · `design/phase-20-8-crud-porcelain-nested-namespace.md`

## Phase 21 — High-usage porcelain (v2)

Composition on Phase 20.

- [x] **21.1** `pull` — `fetch` + `merge` on `repo.*`. Strict upstream resolution (`opts.remote ?? branch.<cur>.remote ?? origin`; `opts.branch ?? branch.<cur>.merge`), and `clone` now writes `[remote "origin"]` + `[branch "<head>"]` tracking config for every clone (ADR-196). pull resolves the tracking ref → OID and delegates to `merge` with a faithful `Merge branch '<x>' of <url>` message + a new `merge` `reflogLabel` so the reflog reads `pull:` exactly like git (ADR-197). `merge.resolveTarget` broadened to gitrevisions ref-DWIM (`origin/main`, tags) via a shared `refCandidates` ladder + tag peeling (ADR-199). `rebase` mode omitted until 22.3 (ADR-198). Conflicts compose with the 20.4 state machine (abort/continue) unchanged. Also fixed a latent fetch bug: the per-`Context` pack registry was not refreshed after a pack write. · ADRs 196–199 · `design/phase-21-1-pull.md`
- [x] **21.2** `mv` — atomic rename in index + working tree on `repo.*`. Validate-all-then-execute so a refusal moves nothing; the working file is renamed as-is and the source's index entry (blob id + mode) is copied to the destination (no re-hash, so unstaged edits travel with the file — verified byte-identical to `git mv`). Directory sources reparent every tracked entry and move the subtree leaf-by-leaf (adapter-portable, since memory/OPFS `rename` is file-only). Ships `force`/`dryRun`/`skipErrors` (ADR-201); `(sources[], destination)` API (ADR-200); granular `MV_*` refusal codes (ADR-202) faithful to git's eight refusal reasons (incl. overlapping-sources). · ADRs 200–202 · `design/mv-atomic-rename.md`
- [x] **21.2a** git-faithfulness interop harness — extend the `cross-tool-interop` suite to assert write **porcelain** (`mv`/`add`/`rm`/`reset`) against real `git`, not just primitives. Models composite porcelain as `@writes` write surfaces so `audit-write-surfaces` machine-tracks their interop coverage (ADR-204); reuses the host-independent readback technique (`git ls-files --stage` / `git write-tree` / `git rev-parse`) to compare each command's resulting index+tree+HEAD against canonical git, plus co-refusal proofs. Shipped `mv`/`add`/`rm`/`reset` interop, retired the `mv` parity golden's "verified out-of-band" note, and **caught a shipped bug**: `repo.mv` on a directory rename threw `EISDIR` on the Node adapter (memory tolerated it, so unit+parity missed it) — fixed by removing the emptied source dir via `rmRecursive` (leaf-only `rm`). · ADRs 204–205 · `design/porcelain-interop-harness.md`
- [x] **21.2b** `commit` — git `stripspace` message normalization (the `whitespace` cleanup mode `git commit -m` applies: per-line trailing-whitespace strip, blank-line-run collapse, leading/trailing blank drop, single trailing `\n`) so commit-object SHAs match canonical git. A pure domain `stripspace` is routed through the single `sanitizeMessage` seam, fixing the commit, merge-commit, and `commit-msg` hook paths together; the `createCommit` primitive stays byte-verbatim (ADR-203). Commit-id goldens regenerated suite-wide and verified against real git; a porcelain-vs-`git commit` interop test pins faithfulness. · ADR 203 · `design/commit-message-stripspace.md`
- [x] **21.2c** `rm` — safety valve, faithful to `git rm`'s `check_local_mod`. Implements the **full** valve (not just the staged case): a present working file is refused when its index `(id, mode)` differs from `HEAD` (`RM_STAGED_CHANGES`), when the working file differs from the index (`RM_LOCAL_MODIFICATIONS`), or both (`RM_STAGED_AND_LOCAL_CHANGES`, `-f`-only); `--cached` suppresses the first two but not the third, `force` overrides all; an absent working file is never refused; validate-all-then-execute so a refusal removes nothing (ADR-207, granular codes per ADR-202). The local-change check is **content + working-tree mode** (ADR-208), mutualized into one `compareWorkingTreeEntry` primitive that `status` now also consumes — making `status` mode-aware — with shared `deriveWorkingMode` + `serializeAndHash` atoms and `apply-changeset` reusing the hash core (ADR-209). Co-refusal interop pins `repo.rm` vs `git rm` (plain/`--cached`/`-f`) byte-for-byte. · ADRs 207–209 · `design/rm-staged-change-safety-valve.md`
- [x] **21.2d** browser `log` message trailing-`\n` parity (CI-red). `e2e (chromium)` / `e2e (firefox)` were persistently red since `03616689` (the `stripspace` PR), while `e2e (webkit)` stays green only because Playwright's headless WebKit skips every OPFS scenario. The cause was **not** a browser quirk or timing: `repo.log()` returns the raw commit-object body verbatim on every platform, and `stripspace` (21.2b) made every porcelain-written message end with one trailing `\n`, so `repo.log()` faithfully reads `'second commit\n'` on Node *and* browser. That PR updated the Node `log` unit assertion to track the `\n` but left the browser `surface-parity.spec.ts` › `log` expectation stale (`'second commit'`). Fixed by correcting the browser expectation to the faithful `'second commit\n'` — raw body kept (git-faithful, matches isomorphic-git and the established Node contract; no production change). · ADR 206 · `design/browser-log-trailing-newline.md`
- [x] **21.3** `stash` — `push`/`pop`/`list`/`drop`/`apply` on `repo.stash.*` (nested namespace per ADR-210). Faithful `git stash` on-disk model: the stack is the `refs/stash` reflog, each entry a `WIP` commit with `[base, index]` (or `[base, index, untracked]` with `-u`) parents; the `stash-ref` primitive force-creates the reflog (git logs `refs/stash` regardless of `core.logAllRefUpdates`, ADR-214) and `drop` rewrites the stack (`--rewrite`/`--updateref` semantics). `push` ships `-m` / `includeUntracked` / `keepIndex`; `apply`/`pop` ship `restoreIndex` and faithful conflict handling — `<<<<<<<` markers + stage-1/2/3 unmerged entries (no `MERGE_HEAD`), an upfront `STASH_APPLY_WOULD_OVERWRITE` guard, and stash-retained-on-conflict `pop` (ADR-212); numeric `index` selector (ADR-213). The 3-way restore lands in a shared `applyMergeToWorktree` primitive reused by Phase 22 (ADR-215); the `SnapshotFactory.stashEntry` stub is wired into the `StashSnapshot` trio. Also fixes the shared `refCandidates` ladder to the full gitrevisions order (adds `refs/<name>` + `refs/remotes/<name>/HEAD`, swaps heads↔tags), unlocking `rev-parse stash@{N}` (ADR-216). Stash trees verified byte-identical to canonical `git stash` (cross-tool interop). · ADRs 210–216 · `design/stash.md`

## Phase 22 — History rewriting (v2)

Dependent chain: 22.1 → 22.2 → 22.3 → 22.4. Each item ships its own conflict-resolution coverage on top of 20.4.

- [x] **22.1** `cherry-pick` (single + range) — `run`/`continue`/`skip`/`abort` on `repo.cherryPick.*` (nested namespace per ADR-217). Faithful `git cherry-pick`: each pick is a new **single-parent** commit that preserves the source author + message (committer becomes the current identity), applied as a 3-way merge (`base = parent(C)`, `ours = HEAD`, `theirs = C`) through the shared `applyMergeToWorktree` primitive (ADR-215). Conflicts/empty picks stop under a dedicated `CHERRY_PICK_HEAD` state machine (distinct from `MERGE_HEAD`, never promoted to a second parent — ADR-220) with a `MERGE_MSG` draft carrying a `# Conflicts:` block; `commit` and `add` recognise the marker so the resolving commit stays single-parent. Multi-pick / range runs persist a **git-byte-faithful, bidirectionally cross-tool-resumable** `.git/sequencer/` (`head`/`todo`/`abort-safety`/`opts`, no `done` file — ADR-218): a tsgit-started range finishes under `git cherry-pick --continue` and vice-versa (verified by cross-tool interop). v1 flags: `-x` (record origin), `--allow-empty`, `-n`/`--no-commit` (ADR-219). Ranges expand `A..B` oldest-first excluding the source's full ancestor set; `A...B` / `^`-exclusion forms are rejected (`INVALID_OPTION`), never mis-expanded. Picking a merge commit without a mainline refuses with `CHERRY_PICK_MERGE_NO_MAINLINE`; in a range, earlier picks commit and the sequence stops at the merge (git-faithful partial-apply — ADR-221). Adds the `resolveOidPrefix` primitive (abbreviated-oid resolution over loose objects + pack fanout, shared by the sequencer / commit-ish ladder / `rev-parse` — ADR-222) and the `sequencer/todo` grammar. New error codes `AMBIGUOUS_OID_PREFIX`, `INVALID_SEQUENCER_TODO`, `CHERRY_PICK_MERGE_NO_MAINLINE`. · ADRs 217–222 · `design/cherry-pick.md`
- [x] **22.2** `revert` — `run`/`continue`/`skip`/`abort` on `repo.revert.*` (nested namespace, cherry-pick lineage). The **inverse** of `cherry-pick`: each revert is a new **single-parent** commit authored by the **current identity** (not the reverted commit's author) whose patch is the **reverse** 3-way merge (`base = C`, `ours = HEAD`, `theirs = parent(C)`) through the shared `applyMergeToWorktree` primitive; a root commit reverts against the empty tree. The default message is `Revert "<subject>"\n\nThis reverts commit <oid>.` (subject C-quoted, escaping only `"`/`\`). Conflicts stop under a dedicated `REVERT_HEAD` machine with the `Revert "…"` `MERGE_MSG` + `# Conflicts:` block; `commit` and `add` recognise the marker (resolving commit stays single-parent, plain `commit:` reflog — git writes no `commit (revert):`). Ranges expand `A..B` **newest-first** (the opposite of cherry-pick — undo the tip first); `A...B`/`^` rejected (`INVALID_OPTION`). git has **no `--allow-empty`**, so an empty revert stops **markerless** (no `REVERT_HEAD`; single writes no state, multi persists only the sequencer); `skip`/`continue` drop it, `commit --allow-empty` keeps it (ADR-223). `abort` records git's faithful `reset: moving to <oid>` reflog (ADR-224). Multi-revert runs persist the git-byte-faithful, bidirectionally cross-tool-resumable `.git/sequencer/` with a generalised `pick | revert` todo grammar; reverting a merge without `-m` refuses with `REVERT_MERGE_NO_MAINLINE` (range partial-apply). v1 flag: `-n`/`--no-commit`. Centralised `resolveCurrentIdentity` (shared with cherry-pick). · ADRs 223–224 · `design/revert.md`
- [x] **22.2a** `cherry-pick` faithfulness + test follow-ups (surfaced by 22.2). (1) Aligned `cherryPick.abort`'s reflog to git's faithful `reset: moving to <oid>` (was a non-faithful `cherry-pick: aborted`; `revert.abort` already faithful per ADR-224) — behaviour-preserving except the reflog string, now pinned by a `cherry-pick-interop` move-case parity test (range commits one pick, conflicts, both tools abort → identical `reset: moving to <oid>`). (2) Closed the mutation gap on `CHERRY_PICK_MERGE_NO_MAINLINE`'s display message: added the `cherryPickMergeNoMainline` rendered-`.message` assertion (mirrors revert) to kill the `StringLiteral` mutant, then merged the two byte-identical `…_MERGE_NO_MAINLINE` rendering cases into one shared-body branch to eliminate the pre-existing equivalent fall-through mutant with no suppression. · `design/cherrypick-abort-reflog-followups.md`
- [x] **22.2b** abort/sequencer follow-ups (surfaced by 22.2a). (1) **No-op reflog skip** — git's ref backend splits a symbolic-`HEAD` update into a *needs-commit* branch update (no reflog entry when `old === new`) and a *log-only* `HEAD` update (always logs); so on a lone-conflict abort (the branch never moved) git writes **no branch reflog entry** but still records `reset: moving to <oid>` on **`HEAD`** — an asymmetry 22.2a's "no reflog entry" framing missed. Fixed centrally in `updateRef`: gate the direct-ref `recordRefUpdate` on `oldId !== newId`, keep `logCoupledHead` unconditional (ADR-225). The one behaviour-preserving change fixes both abort paths **and** the audited siblings (`merge --abort`, symbolic `reset --hard HEAD`, up-to-date `fetch`/`push`); move cases stay byte-identical. Pinned by lone-abort `cherry-pick-interop` / `revert-interop` parity (branch unchanged, `HEAD` `reset: moving to`, tsgit == git) + `updateRef` unit tests (0 surviving mutants). (2) **`abortSequencerReset` extraction** — **deferred to 22.3**: rule-of-three needs `rebase --abort` as the third consumer; extracting at two consumers (`cherryPickAbort` / `revertAbort`) is speculative. (3) **`cherryPickAbort` guard mutant** — 22.2a's "unreachable / likely equivalent" hypothesis was **wrong**: the merge-no-mainline partial-apply path (`runSequence` persists the sequencer then throws `CHERRY_PICK_MERGE_NO_MAINLINE` with **no** `CHERRY_PICK_HEAD`) makes `source === undefined && seqHead !== undefined` reachable via `cherryPick.run('A..B')` over a range hitting a merge — the cherry-pick analog of revert's existing merge-stop abort test. Killed with that abort test, no suppression. Also established **git-faithfulness as the documented prime directive** (ADR-226; architecture / CONTRIBUTING / CLAUDE / PR-template anchors). · ADRs 225–226 · `design/abort-noop-reflog-skip.md`
- [x] **22.2c** abort/reflog audit follow-ups (surfaced by 22.2b). (1) **Detached `reset --hard HEAD` no-op** — `reset`'s detached path called `recordRefUpdate(HEAD, …)` directly (not via `updateRef`), so 22.2b's no-op skip never reached it; git skips the `HEAD` reflog on a detached no-move (a direct ref → needs-commit semantics) while tsgit wrote a spurious `reset: moving to HEAD`. Fixed by **routing the detached write through `updateRef`** (ADR-227) — deviating from the backlog's literal "caller-level gate" to inherit the single central no-move gate (DRY: one gate, not two) plus git-faithful lock-file atomicity, then a behaviour-preserving collapse of the symbolic/detached branches into one `updateRef` call. (2) **`merge --abort` `HEAD` message** — `abort-merge` wrote `merge: aborted`; real git writes `reset: moving to HEAD` (the literal `HEAD`, not the oid — `merge --abort` delegates to a `reset` whose rev arg is `HEAD`) on the `HEAD` symref while the branch entry is skipped (no-move). Aligned the message. Both pinned by new cross-tool interop (`reset-interop` detached no-move + move; new `merge-abort-interop`); 0 surviving mutants on both touched files. · ADR 227 · `design/abort-reflog-audit-followups.md`
- [x] **22.3** `rebase` (non-interactive) — `run`/`continue`/`skip`/`abort` on `repo.rebase.*` (nested namespace per ADR-230). Faithful to git's **merge backend**: HEAD detaches at `onto` (`rebase (start): checkout`), each commit replays as a cherry-pick through the shared `applyMergeToWorktree` (preserved author, current committer, single parent, `rebase (pick)` reflog), then the branch is updated (`rebase (finish): refs/heads/<b> onto <oid>`) and HEAD reattached — replaying on a **detached HEAD** (ADR-228), distinct from cherry-pick/revert. The decision is `onto === mergeBase` → up-to-date no-op, `mergeBase === head` → fast-forward, else replay `mergeBase..head`. Commits already upstream are **patch-id pre-dropped** (git's default); patch-id is an internal equivalence key pinned by observable drop-set parity, not by `git patch-id` hex (ADR-231). Conflicts stop under a **full byte-faithful, bidirectionally cross-tool-resumable** `.git/rebase-merge/` (`head-name`/`onto`/`orig-head`/`git-rebase-todo`(+`.backup`)/`done`/`message`/`author-script`/`end`/`msgnum`/`interactive`/`rewritten-list`/`patch`/`stopped-sha` + `.git/REBASE_HEAD`, ADR-229): a tsgit stop finishes under `git rebase --continue` and vice-versa. `--onto <newbase>` and detached-HEAD rebase supported; `-i`/`--autosquash`/`--exec`/`--root` deferred to 22.4. Extracted the shared `abortSequencerReset` for cherry-pick + revert (22.2b item 2, ADR-232); rebase's abort faithfully diverges (HEAD reattach, no branch move). New domain `rebase/` (todo grammar `pick <oid> # <subject>`, `author-script`, backup help block) + `patch-id` primitive (relocated `materialisePatchFiles` to the primitives tier). Surfaced + fixed an empty-pick index-reset bug via mutation testing. · ADRs 228–232 · `design/rebase-non-interactive.md`
- [x] **22.4** `rebase --interactive` (`pick`/`reword`/`edit`/`squash`/`fixup`/`drop`) — `repo.rebase.run({ interactive })` takes the post-`$EDITOR` todo as a data list (a library has no editor, ADR-233); reword/squash messages are inline (reword required, squash optional with git's default combination template, ADR-234). git's **fast-forward fold** is replicated — unchanged leading picks fold into `rebase (start)` and any linearly-continuing commit fast-forwards (original oid kept), so an all-`pick` `-i` is a byte-identical no-op (ADR-235). `edit` is a new conflict-free `{ kind: 'stopped' }` result resumed by `continue` (amend-or-keep via the `amend` marker, ADR-236); `squash`/`fixup` chains are reproduced **fully faithfully** — each member commits with the running `# This is a combination of N commits.` template (fixup bodies commented out), cleaned only at the group's end (ADR-237). New `domain/rebase/squash-message` builder; `domain/rebase/todo` widened to the six verbs; `.git/rebase-merge/` gains `amend`/`current-fixups`/`message-squash`/`rewritten-pending`. Cross-tool interop pins drop/squash/fixup tree+count parity, the all-pick no-op oid identity, and **bidirectional `edit`-stop resume** (a tsgit `edit` stop finished by `git rebase --continue` and vice-versa). v1 limitation: inline reword/squash messages scheduled *after* a stop are not carried across it (replay with the original/default). · ADRs 233–237 · `design/rebase-interactive.md`
- [x] **22.3a** Centralise the `readCommitData` / `treeOf` / `subjectOf` one-liners and `requireSymbolicHead` (the trio was triplicated across `cherry-pick.ts` / `revert.ts` / `rebase.ts`; `requireSymbolicHead` was duplicated in cherry-pick + revert — rebase replays detached, so it never guarded a symbolic HEAD) into a shared `internal/history-rewrite.ts` helper consumed by all three commands (surfaced by 22.3's architecture pass; bounded blast radius kept it out of the rebase PR per YAGNI/KISS). Behaviour-preserving verbatim move + a focused unit test (100% coverage, 0 surviving mutants — 12 of the module's mutants are type-system kills). Architecture pass left `isMergeCommit` alone (2 copies, divergent doc comments, below rule-of-three) and deferred the cross-module `subjectOf` duplication to **22.3b**. · `design/history-rewrite-helpers.md`
- [x] **22.3b** Unify the "first line of a commit message" projection (surfaced by 22.3a's architecture pass). A completeness sweep found **four** copies, not two: the `subjectOf` helpers in `internal/history-rewrite.ts` (`split('\n')[0]`) and `internal/stash-message.ts` (`indexOf`/`slice`), plus inline copies in `internal/revert-state.ts` (`revertMessage`) and `commit.ts` (reflog subject). Extracted one pure `subjectLine(message)` into `domain/objects/commit-message.ts` (the `indexOf`/`slice` form — no `as string` cast); all six consumers (cherry-pick / revert / rebase / stash / revert-state / commit) import it directly. Kept **internal** (not added to the `domain/objects/index.ts` barrel) so it stays out of `api.json` — net public-API change zero. Byte-faithful (empty → `''`, CRLF retains CR). 100% coverage + property tests (idempotence / no-newline / prefix / newline-free→verbatim), 0 surviving mutants. · `design/commit-subject-line.md`
- [x] **22.4a** Interactive-rebase faithfulness + robustness follow-ups (surfaced by 22.4's mutation grind). (1) **Unrelated-history rebase divergence** — `rebaseRun` refused a no-common-ancestor rebase with `UNSUPPORTED_OPERATION`, but canonical `git rebase <unrelated>` *succeeds* (empty merge-base → replays the whole branch onto the upstream, the root commit against the empty-tree base, like `merge`'s `EMPTY_TREE_OID` add-add path). Resolved in favour of **faithfulness** (ADR-238): the refusal is deleted and `base: ObjectId | undefined` is threaded through `commitsToReplay` (no exclusion walk when `base` is undefined → the whole `head` history is the replay set), `dropCherryEquivalents`, and `planInteractive`; the root replay reuses the already-shared empty-base branch of `mergeUnderLock` (`applyMergeToWorktree`), so no new domain code. Pinned by a unit test (root reparented onto upstream, both histories' files in the tip) + cross-tool interop (tree + commit-count + single-parent parity vs `git rebase <orphan>`). (2) **Empty reword/squash message rejected mid-replay** — an inline `reword`/`squash` message that cleaned to empty threw `EMPTY_COMMIT_MESSAGE` from `stepReword`/`meldGroupMember` *after* HEAD had detached, leaving a partial, un-abortable rebase. Fixed by rejecting empty messages **upfront** in `planInteractive` (`INVALID_OPTION`, mirroring the existing reword-without-message guard), before any state change — the two replay `allowEmpty: false` guards are now provably equivalent (annotated inline, the `BooleanLiteral` survivors retired). · ADR 238 · `design/rebase-interactive-followups.md`

v2.0 is complete (22.4 landed; 20.1's snapshot surface shipped in #81 and is recognised as additive per ADR-239). 2.0.0 is cut by the already-merged-but-unreleased breaking changes (array-only `mergeBase`, namespace-only CRUD porcelain) via release-please. Perf pass for v2 covered in **26**.

---

## Phase 23 — Inspection (v3)

- [x] **23.1** `show` — formatted object output for commit / tag / tree / blob, faithful to `git show`. Tier-1 `repo.show(input?, opts?)` returns a structured per-object `ShowResult` union (commit carries `CommitData` + optional `PatchResult`; tag carries `TagData` + the recursively-shown `target`; tree carries its entries; blob carries raw `content`) **plus** `bytes` — the byte-faithful `git show` stream (ADR-240). Default `HEAD`; a multi-rev arg list renders with git's `shown_one` separator + commit de-duplication (ADR-241); commit patches detect renames by default like `git show` (`diff.renames`), diverging from `diff`'s opt-in (ADR-242). Faithful default date format, 4-space message indentation (leading/trailing blanks stripped), `Merge:` line + trailing-blank terminator + no patch for merges, root-vs-empty-tree patch, recursive (flattened) per-file patch, and verbatim tree/blob rendering — all pinned byte-for-byte by `show-interop` cross-tool parity. New pure `domain/show/` subsystem (date formatter, per-kind renderers, `shown_one` composer); `contextLines` passthrough. Surfaced **23.1a**. · ADRs 240–242 · `design/show-object-output.md`
- [x] **23.1a** `diff` patch path should recurse into sub-trees (surfaced by 23.1). `repo.diff({ format: 'patch' })` threw `UNEXPECTED_OBJECT_TYPE` on any tree containing a sub-directory — the single-level `diffTrees` surfaced a sub-dir as one tree-add and `materialisePatchFiles` then `readBlob`d a tree. Promoted `show`'s local flatten-then-diff into a shared `recursive` option on the `diffTrees` primitive (both sides flattened to a full-path blob projection, then the existing classifier; git's recursive order is reproduced by the trailing-`/` directory-sort equivalence). Adopted by **four** consumers carrying the same latent defect: `diff` patch (always recurses — git porcelain), `show` (dropped its bespoke copy), `computePatchId` (rebase cherry-equivalent drop-set), and `rebase`'s `renderCommitPatch` (`.git/rebase-merge/patch`). Public `DiffOptions.recursive` (default off) opts the structured `tree` format into `git diff-tree -r` (ADR-243); patch ignores the flag. Pinned by a nested-directory diff interop (live git + frozen golden). · ADR-243 · `design/diff-recursive-tree-diff.md`
- [x] **23.1b** `show` v2 flags (deferred from 23.1). All six flag-groups shipped as additive `ShowOptions` fields (no breaking change): `-s`/`--no-patch`; the full `--pretty`/`--format` engine (`oneline`/`short`/`medium`/`full`/`fuller`/`raw`/`reference`/`email`/`mboxrd` + a `format:`/`tformat:` placeholder engine with unknown-`%?` passthrough + `%d`/`%D` decoration); `--stat`/`--numstat` (faithful `scale_linear` graph, `Bin … bytes`, git's summary-clause pluralisation); `<rev>:<path>` resolved as a new rev-parse grammar branch (`@{…}`-aware colon split); `-m` per-parent and the full **combined** merge diff (`-c`/`--cc`, dense the merge default, N-parent octopus — a port of `combine-diff.c`); and `--date=` (deterministic absolute modes interop-pinned, plus now-dependent `relative`/`human` covered structurally). **Surfaced + fixed a latent default-merge bug**: `git show <merge>` defaults to dense combined diff, not "no patch" (23.1 only looked correct on a trivial merge). Each surface is pinned byte-for-byte by an extended `show-interop` suite (non-trivial + octopus merges, every format, decoration, all absolute date modes); `relative`/`human`/`local` are structural (now-/host-dependent). New domain subsystems: `domain/show/{date-*,pretty-*,diff-stat,combined-diff,decoration}`. · ADRs 244–248 · `design/show-v2-flags.md`
- [x] **23.2** `describe` — nearest reachable tag, faithful to `git describe`. Tier-1 `repo.describe(input?, opts?)` returns **structured data only** (chosen ref, describe short-name, commit distance, full target oid, exact/dirty flags) — the library renders no line and never abbreviates; assembling `<name>-<distance>-g<abbrev>` and any cosmetics (`--long`/`--abbrev`/date/mark) are the caller's (ADR-249, which also establishes the project-wide "structured output, not cosmetics" rule + the 23.2a sweep of `show`/`log`). Faithful port of `describe.c`'s date-ordered BFS: candidate cap + finish-depth, found-order tie-break, exact `|tag..target|` distance, newer-tagger-date dedup, `replace_name` priority (annotated > lightweight > ref under `--all`). Data/behaviour selectors only — `tags`/`all`/`exactMatch`/`candidates`/`always`/`firstParent`/`match`/`exclude`/`dirty`/`broken` (no rendering flags). Refusals (`NO_NAMES`/`NO_ANNOTATED_NAMES`/`NO_REACHABLE_NAMES`/`NO_EXACT_MATCH`) co-refuse with git. New pure `domain/describe/` (ref-name, replace-name, compare-candidates, match); peel bound shares `MAX_PEEL_DEPTH`. Reconstructed-line cross-tool parity vs real `git describe` pins faithfulness; `--dirty` detects unstaged tracked changes only (inherits `status`'s missing staged column — tracked as **23.2b**). · ADR-249 · `design/describe-nearest-tag.md`
- [x] **23.2a** Cosmetic-output sweep (breaking) — enforced the "structured output, not cosmetics" rule (ADR-249) across the existing command surface. The audit found `log`/`reflog`/`status`/`cat-file` already compliant; the offenders were `show` + `diff`. `diff` now returns `TreeDiff` only (dropped `format`/`PatchResult`/`text`/`contextLines`/`pathPrefix`); `show` returns a structured per-object union only (dropped `bytes`/`text` and `--pretty`/`--date`/`--stat`/`-s`/`-c`/`--cc`), with merges carrying `perParent: TreeDiff[]`. Per-file line counts are kept as the data half of `--numstat` via an opt-in `withStat` selector on each `DiffChange`, symmetric across `diff`/`show` and blob-free by default. The whole `domain/show/*` (21 files) + the pretty/date/decoration/combined/stat engines were deleted from `src`; the byte-faithful reconstruction was relocated to the `show`/`diff` interop tests (default `git show` + `git show -m`), while `renderPatch`/`materialisePatchFiles` stay internal for rebase/patch-id. Net −3.9k LOC. Breaking → groups into a major bump; supersedes the rendering halves of ADRs 240/241/244–248 and 166–169/243. · ADRs 250–253 · `design/cosmetic-output-sweep.md`
- [x] **23.2b** `status` staged (index-vs-HEAD) column — `status` now populates `indexChanges` with the real **staged** column (git's "Changes to be committed", `git diff-index --cached HEAD`) by wiring the already-built-but-unused domain `diffIndexAgainstTree` against HEAD's tree. New `readHeadTree` primitive (HEAD's flattened tree, or `undefined` for an unborn HEAD) feeds it; `rm` was migrated onto the shared primitive, deleting its private `headTreeEntries` copy (architecture pass). `clean` is now true only when both columns and the untracked set are empty. The two columns are orthogonal passes — a path may appear in both (removed from the index but still on disk → staged `deleted` + `untracked`). A staged type change folds into `modified`, mirroring the working-tree column's coarse `ChangeKind` (ADR-254); first-class `T`/mode + "Unmerged paths" reporting are logged follow-ups (**23.2c**). `describe --dirty`/`--broken` now detect **staged-only** changes faithfully (`git diff-index HEAD` over both columns). Latent bug fixed along the way: `status` no longer swallows a corrupt-index error into an empty index (which would have reported every HEAD path as a spurious staged deletion) — it propagates, like git. Pinned by a `status-interop` cross-tool suite reconstructing `git status --porcelain` from the structured columns (staged add/modify/delete, `M `/`MM`, `D `+`??`, unborn HEAD, clean) + a staged-only `describe --dirty` interop case. · ADR-254 · `design/status-staged-column.md`
- [x] **23.2c** `status` faithfulness follow-ups (surfaced by 23.2b). **(1) First-class `type-changed` / `mode-changed`** across **both** columns (ADR-255, supersedes 254): a kind change (file↔symlink) is `type-changed` (git `T`); a same-blob mode-only change is `mode-changed` (git `M`); content stays `modified`. The working-tree oracle `compareWorkingTreeEntry` was reordered to hash before deciding mode-vs-content and now returns the richer union; the dirty valves (`rm`, `apply-merge-to-worktree`) widened from `=== 'modified'` to a shared `isWorkingTreeModified` predicate (fixing a latent under-detection). A gitlink/submodule entry deliberately stays `modified` — `deriveWorkingMode` can't derive a gitlink and git reports a submodule as `M`, not `T` (regression caught in review, guarded + tested). The staged projection reads `type-change`/`oldId===newId` off `diffIndexAgainstTree`'s existing `DiffChange` (no domain change). **(2) Unmerged paths** as a first-class `StatusResult.unmerged` field (ADR-256, shape B): each entry carries the conflict `kind` (the seven git states via the new pure `domain/diff/classifyUnmerged`) **and** the per-stage `{ id, mode }` blobs (`base`/`ours`/`theirs`) — lossless against porcelain v1 (`XY`) and v2 (`u`-line). `status` now partitions the index via the already-built-but-unused `groupUnmergedEntries`; conflicted paths are reported only under `unmerged` (excluded from staged/working/untracked), fixing a latent mis-classification. `clean` and `describe --dirty/--broken` both count the unmerged column (a mid-merge index is dirty). Architecture pass unified `status`'s two path-sorts onto the domain `comparePaths` byte comparator (dropped a `Stryker disable` shortcut + a redundant sort). Pinned by `status-interop` (byte-equal `T`/`M`/`UU`/`AA`/`UD`/`DU` reconstruction vs real `git status --porcelain`) + a conflicted-index `describe --dirty` interop case; 100% mutation on every touched file. · ADRs 255–256 · `design/status-faithfulness-followups.md`
- [x] **23.3** `blame` — line-by-line authorship via reverse-diff history walk. Tier-1 `repo.blame(path, opts?)` returns **structured data only** — a flat, **denormalized per-line** array (each `BlameLine` carries the blamed commit oid, its position in the queried file (`finalLine`) and in the originating commit (`sourceLine`), the rename-aware `sourcePath`, the `author`/`committer`/`summary`/`boundary`/`previous`, and the line `content`); the library renders no `git blame` / `--porcelain` line (ADR-257). A faithful port of git's scoreboard: a commit-date priority queue (`domain/blame/priority-queue.ts`) drives a backwards walk that diffs each suspect against **every** parent via the existing Myers `diffLines`, passing common regions down (the pure `domain/blame/splitAgainstParent`) and blaming lines that differ from all parents (or reach a root) there — so a merge is blamed only for lines unique to it. Whole-file renames are followed by default (exact-content `detectRenames`; rename-with-edit deferred); `-L` ranges are a faithful output selector (clamped end, refused bad bounds). v1 blames a committed rev (default HEAD), not the working-tree "Not Committed Yet" pseudo-commit (ADR-258). Pinned byte-for-byte by `blame-interop` reconstructing `git blame --porcelain` (linear / prepend-shift / merge / rename / `-L`). Architecture pass logged **23.3a** (the date-ordered priority-queue now has three consumers). · ADRs 257–258 · `design/blame-line-authorship.md`
- [x] **23.3a** Consolidated the date-ordered **commit priority-queue** (`precedes` = commit-date desc, oid-asc tie-break + sorted `enqueue`) into one shared domain helper. The blame variant was the canonical generic, payload-carrying shape; it was **relocated verbatim** from `domain/blame/priority-queue.ts` to a new `domain/commit/priority-queue.ts` (ADR-259 — a `domain/commit/` home for commit-walk ordering primitives, forward-looking for shortlog/range-diff/name-rev), and the two inline copies were deleted: `commands/describe.ts` and `primitives/merge-base.ts` now import the shared `enqueue`/`QueueEntry<T>`, adopting `QueueEntry<undefined>` for their payload-free walks (merge-base's entry field renamed `id`→`oid`; the structural-`Ordered` alternative was rejected for keeping two entry types and churning the already-correct blame module). Behaviour-preserving: no SHA/ref/reflog/state/refusal change; internal-only (no `api.json` change). Net suppression **reduction** — the two inline copies' `// Stryker disable` equivalent-mutant annotations were deleted with the code; the shared logic is mutation-proven by blame's order-sensitive test (100% on the relocated module + both changed consumers, 0 survivors), hardened with a new `priority-queue.properties.test.ts` (comparator total-order axioms + enqueue sortedness/counting invariants). Architecture pass: no-op — `walk-commits` is a plain topo FIFO (different concern), the 2-copy memoizing commit-readers are below rule-of-three and divergent. · ADR-259 · `design/consolidate-commit-priority-queue.md`
- [ ] **23.4** API foundation & read model — an ergonomics pass laid **before** completing the Phase 23 inspection surface, because every remaining inspection command (23.5–23.8) builds on it. Surfaced by the 23.4 API review (capability-map + golden-path stress test + parameter audit): params are already cosmetic-free post-ADR-249, but the surface mirrors git's CLI 1-to-1 and the read Core is too weak to build on. Captures **every** finding from that review. Several sub-items change the public API, but breaking changes stay unconstrained until the end of Phase 28, so 23.4 sequences **purely by dependency** — no release-bundling. The read-model **convergence** (commands as thin projections over the model) is the capstone 23.4j, sequenced **last** and gated on the model proving out across the command set — respecting the over-design caution rather than forcing the abstraction early.
  - [x] **23.4a** snapshot surface — **kept the name** `snapshot` (git's model is "snapshots, not deltas"; the iteration-stability invariant *is* database **snapshot isolation** — a power-tool surface, not everyday porcelain). Dropped the nine `*Deps` / `create*Snapshot` **wiring re-exports** from the `src/index.ts` barrel and demoted the four `*Deps` interfaces (`IndexSnapshotDeps`/`TreeSnapshotDeps`/`WorkdirSnapshotDeps`/`SnapshotFactoryDeps`) to module-local — consumers read snapshots through `repo.snapshot.*`, never hand-wired deps. The public snapshot type vocabulary (`SnapshotFactory`/`StashSnapshot`/`WorkdirSnapshotOptions`/`Snapshot`/`TreeSnapshot`/…) + `join`/`innerJoin`/`requireSnapshot` stay exported; the `create*` factories stay reachable by direct module path for `repository.ts` + tests. Verified: no consumer imported the removed symbols from the barrel; `reports/api.json` unchanged (the barrel is not a typedoc entry point); breaking-to-the-legacy-barrel only (allowed in the 23.4 window). Source accessors **deferred, not dropped** — the `repo.stash` collision with the stash command namespace + `repo.tree(rev)` overlapping 23.4c/23.4e → tracked as **23.4k**, gated on 23.4j. _(S7; the name is confirmed right.)_ · ADR-260 · `design/snapshot-surface.md`
  - [x] **23.4b** History/commit view + folded subject — landed two additive read-model foundations. **(1) `walkCommitsByDate`** (Tier-2 `repo.primitives.walkCommitsByDate`): an all-parents, commit-date-ordered walk (newest committer-date first, oid-asc tie-break) over the shared `domain/commit` priority-queue — the payload-carrying consumer ADR-259 anticipated. Shipped as a **dedicated primitive**, not a third `order` on `walkCommits` (ADR-261): the eager date discipline and the lazy FIFO can't share a queue, and isolating it gives a tighter mutation surface, perf headroom, and keeps a later fusion open. It is a **lazy** walk (parents discovered on pop) so it equals `git rev-list --date-order` for every causally-dated history — i.e. everything produced by normal git ops, since a parent object predates its child; strict `--date-order` under *forged* reverse-causal committer dates is deferred to 23.4j. The `walkCommits` commit reader was extracted to a shared `internal/read-commit.ts` both walkers co-own, and the now-vestigial `pickNext` scheduler stub was inlined. **(2) `foldSubject`** — git's `%s` / `format_subject` port (leading paragraph folded to one space-joined line, per-line trailing-trim, stop at the first blank line), a domain projection beside `subjectLine`/`stripspace`, kept domain-internal (YAGNI). Pinned by a `history-interop` cross-tool suite (walk order vs `git rev-list --date-order`; `%s` vs `git log --format=%s`, multi-line subject included) + property tests; 100% mutation on every touched file. **Unblocks 23.5–23.8.** Logged follow-up **23.4l** (consolidate `describe`'s bespoke date walk once a third consumer lands). _(E1 + M2.)_ · ADR-261 · `design/history-view-folded-subject.md`
  - [x] **23.4c** `readFileAt(rev, path)` — Tier-1 `repo.readFileAt(rev, path, options?)` reads a file's bytes as of a revision (the structured `git show <rev>:<path>` / `git cat-file blob <rev>:<path>`), collapsing the former resolve → readObject → readTree → walk → readBlob dance into one call. Returns **structured data only** — `{ id, mode, content }` (blob oid + tree-entry mode + verbatim committed bytes); the library renders nothing (ADR-262). Resolves the **full `revParse` grammar** (short names, `~`/`^`, abbreviated oids, reflog selectors — the convenience a commit-ish-only primitive would miss), peels to the root tree, and descends the `/`-separated path. Refusals co-refuse with git: a directory or gitlink final entry → `UNEXPECTED_OBJECT_TYPE` (expected blob), a missing or non-tree-intermediate segment → `PATH_NOT_IN_TREE`, an over-cap read → `OBJECT_TOO_LARGE` (`options.maxBytes` bounds only the file read). The shared `<rev>:<path>` segment descent was lifted out of `rev-parse` into a new internal `descendTreePath` primitive both consumers co-own (DRY, behaviour-preserving — `rev-parse`'s own `peel` error semantics kept). Pinned byte-for-byte by a `read-file-at-interop` cross-tool suite (blob bytes vs `git cat-file blob`, mode vs `git ls-tree`, directory/missing co-refusal); 100% mutation on the new files. _(M1.)_ · ADR-262 · `design/read-file-at.md`
  - [x] **23.4d** merge/pull reshape — unified the interrupted-op state machine into the frozen non-callable `repo.merge.{run,continue,abort}` **namespace** (parity with rebase/cherryPick/revert; supersedes ADR-172's flat `merge`/`abortMerge`/`continueMerge`, whose namespace objection dissolved once ADR-193 made namespaces non-callable). Replaced the contradictory `fastForwardOnly`/`noFastForward` boolean pair (both-true was representable) with a single `fastForward: 'only' | 'never' | 'allow'` (default `'allow'`) on **both** `merge` and `pull` — the illegal state is now unrepresentable. Dropped public `reflogLabel`: it has no `git merge` CLI analogue (it modelled `GIT_REFLOG_ACTION`, set by the parent porcelain), so `pull`'s faithful `pull: …` reflog now flows through an internal-only `MergeInternalOptions.reflogAction` third arg (off the barrel/api.json), superseding the public-field half of ADR-197. Symbol/type renames for verb parity (`mergeRun`/`mergeContinue`/`mergeAbort`, `MergeRunInput`/`MergeContinueInput`/`MergeContinueResult`/`MergeAbortResult`); single `merge.md` page (folded the abort/continue pages). Clean break, no aliases (23.4 breaking window). Byte-for-byte git-observable behaviour unchanged — SHAs/refs/reflogs/state files/refusals identical; interop + parity suites updated mechanically only. Architecture pass: no-op (a generic `bindNamespace` over the 10 binders rejected under KISS — distinct verb sets/signatures; a shared `FastForwardPolicy` type deferred at rule-of-two). 100% mutation on every touched file. _(S1 + S2 + S5.)_ · ADRs 263–265 · `design/merge-pull-reshape.md`
  - [x] **23.4e** rev vocabulary — standardised the "which commit-ish" parameter on **`rev`** and split the vocabulary into three precise words (ADR-266): **`rev`** = a commit-ish (`blame` kept; `log.from`→`rev`, `merge`/`reset` `target`→`rev`, `describe`/`show` positional `input`→`rev`); **`from`/`to`** = a genuine range (`diff` kept — the canonical owner of the reserved range words); **`ref`** = a literal ref name (`pull.branch`→`ref`, since a remote branch short-name is *not* an arbitrary commit-ish). **`checkout`** folded in during implementation (user directive): its switch `CheckoutSwitchOptions.target`→`rev` (the path-restore `paths` variant + `invalidOption` refusal moved with it). Kept as-is (distinct concepts, not deferred): `tag.target` (an *object* reference, broader than a commit-ish), `branch.rename` `from`/`to` (a name pair), `revert`/`cherryPick`/`rebase` `revisions` (plural ranges). Breaking (no aliases, 23.4 window) but **behaviour-preserving** — no SHA/ref/reflog/state/refusal change (reflog values byte-identical; the renamed `invalidOption` reason is a structured-error string). Verified by `check:types` (rename-completeness oracle) + the unchanged unit/interop/parity suites + 100% mutation on `checkout`. Considered + declined an architecture pass: the divergent per-command `rev`→oid resolvers (`log`/`reset`/`checkout` vs the shared `resolveCommitIsh`) cannot be unified without changing behaviour. · ADR-266 · `design/rev-vocabulary.md`
  - [x] **23.4f** infra/policy off op signatures — moved two pieces of repository-**environment policy** off per-call command options onto `openRepository`'s `config`, where they already lived (the per-call copies were redundant duplicates the facade never wired). **(1) `breakStaleLockMs`** dropped from `AddOptions`/`MvOptions`/`RmOptions`; the shared lock acquirer `acquireIndexLock` now resolves the window as `opts.breakStaleLockMs ?? ctx.config?.breakStaleLockMs`, so the stale-`index.lock` break policy is **repo-wide** — every index-mutating command (checkout/merge/rebase/reset/stash/cherry-pick/revert alongside add/mv/rm) honours one knob instead of only three. The three Tier-2 primitives (`stageEntry`/`unstageEntry`/`setEntryFlags`) keep their explicit option (precedence: `opts` wins) — left to **23.4g**. **(2) clone SSRF** (`resolver`/`allowInsecure`/`allowPrivateNetworks`) dropped from `CloneOptions`, and the redundant in-`clone` `validateUrl` block deleted: the guard is now enforced **solely** by `wrapTransportValidator` (wired from `config.{dnsResolver,allowInsecure,allowPrivateNetworks}` at open), the single enforcement point — shedding two `Stryker disable` annotations. Behaviour-preserving under the default (unset ⇒ git-faithful strict locking, fail-closed SSRF); breaking only to callers passing the removed fields (24.x window). `index.node`'s `allowInsecureHttp` (the distinct Node-HTTP plaintext gate) is unchanged — already at adapter creation. 100% mutation on `index-lock`; `addAll`'s internal signature simplified (no public/api.json impact). · ADR-267 · `design/infra-policy-off-signatures.md` _(S4 + S6.)_
  - [x] **23.4g** primitive Tier-2 audit — pared `repo.primitives.*` from **26 → 21** against a four-part framework (a blessed primitive is **composed-from** by a command, **safe** — can't manufacture inconsistent state, **faithful** — byte-faithful output, and a **capability not a less-safe duplicate**). The six flagged mutation leaks split three ways. **Deleted** (module + tests + docs) the three index-CRUD verbs `stageEntry`/`unstageEntry`/`setEntryFlags`: zero command consumers (ADR-164 predicted `stash pop`/`mv` — neither uses them; the real index-mutation block turned out to be `acquireIndexLock`+`applyChangeset`), `stageEntry` writes non-faithful stat (zeroed `ctime`/`mtime`/`dev`/`ino` where `add` records real `lstat`), and `setEntryFlags` is pure `update-index --assume-unchanged` plumbing with no porcelain analogue — re-addable additively if a real consumer appears. **Demoted to internal** (kept the module, stripped from **both** the namespace **and** the `@scolladon/tsgit/primitives` barrel **and** the blessed docs) `recordRefUpdate` (a decoupled reflog write disagreeing with its ref is a footgun no command produces; `updateRef` is the coherent ref-write surface) and `writeSymbolicRef` (a symref-backend mechanism, largely porcelain-reachable — grouped with `recordRefUpdate` as internal). **Kept** `runHook` (genuine extension, maps to `git hook run`, safe + faithful, composed-from). Architecture pass collapsed the now-dead per-call `AcquireOptions.breakStaleLockMs` (the deleted verbs were its only override callers) to the repo-wide `ctx.config?.breakStaleLockMs`. Behaviour-preserving (no SHA/ref/reflog/state/refusal change — deleted verbs had no command path; demoted writers fire verbatim from their internal call sites); breaking only to the two public surfaces (24.x window, no aliases). 100% mutation on `index-lock`; `internals.md` documents the two demoted writers as fully-internal mechanisms. · ADR-268 · `design/primitive-tier2-audit.md` _(S8.)_
  - [x] **23.4h** status↔diff correlation — made every `status` change self-describing, finishing for the staged & working-tree columns what 23.2c did for `unmerged`. `StatusResult` is restructured (breaking, 23.4 window) to **one correlated `ChangedPath` record per path** — the structured form of `git status --porcelain=v2`'s ordinary line: `staged`/`unstaged` kinds (git's X/Y) on **one** record, plus the blob endpoints of each side (`head`/`index` as `BlobSide {id,mode}`, `worktree` as `WorktreeSide {mode}` — no working oid, matching git's missing `hW`). `indexChanges`/`workingTreeChanges` collapse into `changes`; **untracked** moves to its own `untracked: FilePath[]` field (git's separate `?` lines, keeping the `rm --cached` `D `+`??` case as two clean sources); `ChangeKind` drops `'untracked'`; `ConflictStage` is renamed/unified to the shared `BlobSide`. The hunks for any path are one read away (staged: `readBlob(head)`↔`readBlob(index)`; unstaged: `readBlob(index)`↔working file by `path`) — **endpoints only, no `withHunks`** (ADR-269 decision 2, keeps the hot path free of folded-in Myers). The endpoints are data status already computed and discarded: the staged side comes from the existing `diffIndexAgainstTree`, the working side from a new richer `compareWorkingTreeDelta` core (`{status, worktreeMode}`) with the enum `compareWorkingTreeEntry` as a one-line projection, so its four enum-only consumers (`rm`/`stash`/clean-work-tree/apply-merge) are untouched. `describe --dirty/--broken` simplifies to `changes.length > 0 || unmerged.length > 0` (behaviour-preserving). Pinned by `status-interop` reconstructing **both** `git status --porcelain` (v1) and `--porcelain=v2` (the ordinary `mH mI mW hH hI` endpoints) byte-for-byte; 100% mutation on `status.ts` + `compare-working-tree-entry.ts`. Architecture pass: no-op (unifying `BlobSide` with the domain `FlatTreeEntry` would cross the hexagonal boundary). Logged **23.4m**. · ADR-269 · `design/status-diff-correlation.md` _(M3.)_
  - [x] **23.4i** `blame` working-tree pseudo-commit — added git's bare `git blame <file>` behaviour as an explicit `worktree: true` opt-in (ADR-270, non-breaking: omitting it preserves the committed-rev default ADR-258 set). On a dirty tree, lines matching the committed history blame to their real commits; uncommitted lines (modified, or staged-new) blame to the zero-oid "Not Committed Yet" pseudo-commit. `BlameLine` became a discriminated union `CommittedBlameLine | UncommittedBlameLine` on a `committed` tag (ADR-271): the uncommitted variant omits git's fabricated oid/identity/timestamp/summary (the caller reconstructs them — ADR-249-clean, and the non-deterministic `NOW` never enters the data). The pseudo-commit never enters the walk — it's a seed-time projection that diffs the working blob against HEAD, schedules common lines into the existing committed walk, and finalizes the rest as `committed: false`. Faithful refusals co-refuse with git (untracked → `PATH_NOT_IN_TREE`; missing-on-disk → new `WORKTREE_FILE_ABSENT`; unborn HEAD → `REF_NOT_FOUND`). Worktree mode reads the file from disk, so the user path is constrained to the repo via the shared `validateWorkingTreePath` guard (rejects `..`/absolute/`.git`) before any FS access. Rename-following for the pseudo-commit (pure `git mv` blamed by new name pre-commit) is a documented faithful divergence (deferred). Pinned byte-for-byte by `blame-interop` reconstructing bare `git blame --porcelain` (dirty / staged-new / `-L`), plus a worktree parity step across node+memory+browser; 100% mutation on `blame.ts` (remaining survivors provably equivalent). · ADRs 270–271 · `design/blame-working-tree-pseudo-commit.md` _(O2.)_
  - [x] **23.4j** Read-model convergence (capstone) — refactored the porcelain reads into thin projections over the read model, honouring the over-design caution: the read model **already exists** as the Tier-2 read primitives, so this is a **focused convergence of the holdouts** onto them — **no new abstraction layer, no new accessors** (the accessor shape stays the deferred **23.4k**, whose proof-out gate this convergence is; ADR-272). **`log`** converged onto `walkCommitsByDate`: its default order is now git-faithful — every reachable commit across **all** parents, newest committer-date first (git's default `git log`), with `order: 'first-parent'` (`git log --first-parent`) preserving the prior behaviour as an explicit, faithful mode (**breaking** output change on branchy histories, in the 23.4 window; ADR-273). Both `log` (`rev`/`excluding`) and **`diff`** (`from`/`to`) now resolve through the **full `revParse` grammar** (`~`/`^`/`@{…}`/oid-prefix + annotated-tag peel), replacing two bespoke resolvers (`resolveStart`/`resolveExcluding`, `resolveTreeId`) with one shared `resolveCommit`/`resolveTreeish` (`revParse` + a peel-to-kind); an unresolvable `rev`/`excluding` now refuses (`OBJECT_NOT_FOUND`, consistent with `show`/`readFileAt`) instead of silently skipping, shedding two `Stryker disable` suppressions. `LogEntry` unchanged (raw `message`; ADR-249). Architecture pass relocated the generic `peel` from `rev-parse` to a shared `primitives/internal/peel.ts` (sibling of `descendTreePath`), removing the command→command reach; considered + **deferred** routing `resolveCommitIsh`'s replay-command consumers onto the grammar (behaviour change, own ADR) and folding `describe`'s candidate-entangled date walk onto `walkCommitsByDate` (**23.4l**, not a plain reachable-set walk). Pinned byte-for-byte by a new `log-interop` suite (default order / first-parent / tag-peel / exclude-range vs real `git`); 100% mutation on every touched file. _(E2's convergence half.)_ · ADRs 272–273 · `design/read-model-convergence.md`
  - [x] **23.4k** snapshot source accessors — **weighed → declined** (ADR-274, superseding ADR-260's deferral). With the three gating items shipped (23.4c/e/j), the weigh resolved on its merits: 23.4j's convergence proved the command set projects onto the Tier-2 read primitives with **no accessors** (ADR-272), so the deferred abstraction was validated as unneeded. All four declined — `repo.stash` collides with the stash command namespace; `repo.index`/`repo.workdir` are either capability-dropping getters (can't carry `SnapshotOptions`/`WorkdirSnapshotOptions`) or verbatim aliases of `repo.snapshot.*`; `repo.tree(rev)` hoists a power-tool `TreeSnapshot` into the porcelain altitude ADR-260 separated and overloads `repo.snapshot.tree(oid)`, for a one-`revParse` saving. Sources stay reached through the cohesive `repo.snapshot.*` factory; the decline is regression-pinned by the exhaustive facade key-set test. Docs-only (no source/test change). · ADR-274 · `design/snapshot-source-accessors.md`
  - [ ] **23.4l** consolidate the date-ordered commit walk (deferred from 23.4b) — `describe` still carries its own bespoke date-ordered scoreboard walk (entangled with candidate-reachability/depth bookkeeping), distinct from the new `walkCommitsByDate`. Rule-of-three is not yet met (these are the first two general consumers). Re-evaluate folding `describe`'s walk onto `walkCommitsByDate` (or a shared core) once a third date-walk consumer lands — likely a 23.4j-era converged `log`. _(ADR-261.)_
  - [ ] **23.4m** `UnmergedEntry` worktree mode (deferred from 23.4h) — `status`'s `unmerged` entries carry the per-stage base/ours/theirs blobs but not the conflicted path's **worktree mode** (`mW` of `git status --porcelain=v2`'s `u` line), so the full v2 `u` line is the one porcelain shape that cannot yet be reconstructed. Add the worktree side to `UnmergedEntry` (the conflicted file's on-disk mode), closing v2 `u`-line reconstruction symmetrically with the ordinary-line endpoints 23.4h added. Small, additive. _(surfaced by 23.4h.)_
- [ ] **23.5** `shortlog` — per-author commit summary, a thin consumer of 23.4b's history view + `foldSubject`. Groups reachable commits by raw author (or committer) identity, oldest-first within a group; structured data only (per-author groups of `{ id, email, subject }`, sorted byte-wise by name) — the `-e`/`-n`/`-s` renderings are caller projections. `.mailmap` canonicalisation is a deferred cross-cutting follow-up (no mailmap support anywhere yet). _(was 23.4.)_
- [ ] **23.6** `range-diff` — compare two commit ranges. _(was 23.5.)_
- [ ] **23.7** `whatchanged` — log with raw diffs. _(was 23.6.)_
- [ ] **23.8** `name-rev` + `describe --contains` — name a commit by the nearest tag/ref that **contains** it (the inverse of 23.2's nearest-ancestor tag), with git's `~`/`^` path notation (`v2.0~3^2~1`). A reverse-reachability walk from refs down to the commit (git's `name-rev`), a different algorithm from describe's date-ordered BFS — `describe --contains` (+ `--all`/`--tags`) delegates to it. Answers "which release first contains this commit?". Surfaced by 23.2's deferral. _(was 23.7.)_

## Phase 24 — Maintenance, topology & extension (v3)

Three waves, ordered by cohesion + structural risk: repo topology first (structurally invasive — multi-gitdir / nested-repo assumptions), extension points second, leaf utilities last. (Item numbers are stable IDs, so they read non-monotonically across the reordered waves.)

### Wave A — Repo topology (submodule & worktree)

- [ ] **24.1** Submodule write side — `add`/`init`/`update`/`sync`/`deinit`. Completes the submodule story (read side shipped in 17.5). _(was 25.4)_
- [ ] **24.2** `worktree` — add / list / move / remove (distinct working trees over one gitdir).

### Wave B — Extension points (hooks & merge drivers)

- [ ] **24.8** Hook coverage parity — `post-commit`, `post-merge`, `post-checkout`, `prepare-commit-msg`, `pre-rebase`, `post-rewrite`, server-side hooks. Layers over the 17.2 hook runner. _(was 25.5)_
- [ ] **24.9** Custom merge drivers — `.gitattributes` `merge=<driver>` resolution + configurable `[merge "<driver>"]` driver invocation, layered over the built-in 3-way content merge (`domain/merge/`) reused by `merge`/`stash`/`cherry-pick`/`revert`. Sub-dependency: `.gitattributes` parsing is net-new (only `.gitignore` exists today, 14.3).

### Wave C — Utilities (leaf, low-coupling)

- [ ] **24.3** `fsck` — repository integrity check.
- [ ] **24.4** `archive` — tar/zip export of a tree.
- [ ] **24.5** `bundle` — create / verify / list-heads.
- [ ] **24.6** `bisect` — binary search.
- [ ] **24.7** `notes` — add / read / list / remove on `refs/notes/*`.

v3.0 ships when Phase 24 completes. Perf pass covered in **26**.

---

## Phase 25 — Transport & signing (v4)

- [ ] **25.1** SSH transport — new port; key resolution delegated, browser stays inert.
- [ ] **25.2** GPG signing — new port; signed commits (`-S`), signed tags, signed pushes.
- [ ] **25.3** Smart-HTTP v2. Must deliver **incremental fetch negotiation**: tsgit's v1 upload-pack client strips `multi_ack_detailed` and runs a single round, so it cannot fetch new objects when the client holds a base (`want C1 / have C0 / done` returns no pack — `clone` and no-op fetch work, "remote advanced → fetch new" does not). v2's `fetch` command (`ack`/`ready`/`done`) subsumes this; alternatively a focused v1 `multi_ack_detailed` round can be hoisted earlier if real incremental `fetch`/`pull` is needed before v2. Surfaced by 21.1 — `pull`'s over-the-wire fast-forward/merge composes for free once this lands (no `pull` change); FF/merge/conflict are unit-proven against a local graph until then.

Submodule write side and hook coverage parity moved to **24.1** / **24.8** — neither is transport/signing.

## Phase 26 — Performance pass (closes v4)

Runs against a stable surface; instruments every command on medium + large fixtures.

- [ ] **26.1** Per-command profile capture (`npm run profile <cmd>`); commit baseline.
- [ ] **26.2** Hot-path optimizations from 26.1 findings (no speculative work).
- [ ] **26.3** Regression gate in CI — `bench:summary` diff must not exceed ±N% per scenario.
- [ ] **26.4** Memory-pressure scenarios (large packs, deep delta chains) added to bench suite.
- [ ] **26.5** Magic-literal sweep — centralize the magic strings/numbers scattered across commands (operation labels like `'revert'` / `'revert --continue'`, reflog prefixes `revert:` / `commit:` / `reset: moving to`, marker filenames, conflict-marker tokens, walk caps) into named constants / shared enums. Behavior-preserving; reduces primitive-obsession smell flagged during the Phase 22 history-rewrite work.
- [ ] **26.6** Competitor benchmark comparison (deferred from 18.2) — publish a fair, reproducible head-to-head vs isomorphic-git (and other pure-JS git libraries) and fold it into the README's "Why tsgit" section, which currently ships our-numbers-only per 18.2. Builds on the existing vs-isomorphic-git benches (11.1 `log` / `readBlob` / `status`, 12.4 `clone:small-repo`); the perf pass produces the comprehensive dataset + documented methodology / caveats so the comparison stays honest. Lands here because it needs the stable-surface measurements.
- [ ] **26.7** Bundle-size optimization — the v2.0.0 compressed tarball grew to ~625 KiB (from ~220 KiB at v1.0) as the v2 feature set landed, so the `verify:tarball` cap was relaxed 10× (to ~7.5 MiB) as a generous temporary ceiling. Drive it back down toward the floor: verify minify + tree-shaking are effective across both ESM/CJS outputs, audit the npm `files` set for redundant artefacts (source maps, duplicate format/type emission), measure per-module contribution, then re-tighten the `tooling/verify-tarball.sh` cap once optimized. Honours the "dist must be the smallest possible" principle.

---

## Parking lot (revisit on demand / community traction)

Not abandoned — deferred indefinitely. Pull back into a phase if profiling or community demand justifies the lift.

- **gc / repack / prune** — pack consolidation. Large lift, largely redundant for a library embedded next to canonical git (the host's `git gc` already maintains the object store). Revisit if profiling shows loose-object explosion hurting the browser/memory adapters, or on community demand. _(was 24.1)_

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

## Phase 27 — Test base rework (sequenced after Phase 26)

Restructure every test tier around minimal-but-complete coverage instead
of breadth-of-cases. Each tier optimises for a different target.
Companion to (not replacement for) the mutation-pyramid harness shipped
in Phase 19. Starts AFTER Phase 26 lands so 27.4 has the perf data it
needs to define hot paths.

- [ ] **27.1 Unit — minimise while preserving GWT discipline.** Keep one
  `it('Then …')` per distinct behaviour. Minimise by collapsing tests
  that prove the SAME behaviour with different inputs into one
  parameterised test (`it.each`). Delete strict-subset tests outright.
  Outcome: 100 % line / branch / function / statement coverage AND
  only provably-equivalent mutants surviving (documented inline per
  existing convention). Intention-revealing test titles preserved.
- [ ] **27.2 Integration — collapse same-scenario-different-input
  overlap.** Two integration tests overlap when they exercise the same
  user journey or code path with different fixtures. Such tests merge
  into one parameterised case; strict-subset tests delete.
  **Parity cross-products (Node × Memory × Browser × Deno × Bun ×
  Workers) are NOT overlap** — they prove cross-adapter equivalence
  and stay distinct.
- [ ] **27.3 E2E — same overlap definition.** Each Playwright / browser
  flow asserts a user journey no other E2E flow asserts. Parity
  cross-products excluded from the overlap audit.
- [ ] **27.4 Perf — rebuild bench suite around hot paths.** Hot-path
  list is NOT pre-frozen here; it's derived from the Phase 26 perf
  pass output (the perf pass produces measurements that pick the
  hottest operations). Once that list lands as an ADR, hot paths get
  small / medium / large fixtures; non-hot paths keep medium only.
  Bench gating only on hot paths.

ADRs required before kick-off:
- ADR-N: Phase 27 rework rationale + sequencing after Phase 26.
- ADR-N+1: Unit-tier minimisation policy (GWT preserved, parameterise
  same-behaviour-different-input cases).
- ADR-N+2: Overlap definition for integration / E2E + parity carve-out.
- ADR-N+3: Hot-path picking methodology (Phase-26-data-driven, list
  refreshed each major version).

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
