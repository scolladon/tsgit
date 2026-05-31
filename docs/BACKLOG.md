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
| **v2.0** — test base + porcelain completeness + history rewriting | 19–22 | in progress (19.1–19.8 shipped; wave 0 complete) |
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

- [~] **20.1** Snapshot+join surface (`repo.snapshot.head/index/workdir/…` + `join`/`innerJoin` + operators). Wave 1 lands the engine (resolvers, bus + view, snapshot impls, factory, join, operators, deprecation helper, public exports); Waves 2–8 migrate consumers (`status`, `diff`, `add`, `checkout`, `merge`, …) and deprecate the legacy walkers.
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
- [ ] **25.3** Smart-HTTP v2. Must deliver **incremental fetch negotiation**: tsgit's v1 upload-pack client strips `multi_ack_detailed` and runs a single round, so it cannot fetch new objects when the client holds a base (`want C1 / have C0 / done` returns no pack — `clone` and no-op fetch work, "remote advanced → fetch new" does not). v2's `fetch` command (`ack`/`ready`/`done`) subsumes this; alternatively a focused v1 `multi_ack_detailed` round can be hoisted earlier if real incremental `fetch`/`pull` is needed before v2. Surfaced by 21.1 — `pull`'s over-the-wire fast-forward/merge composes for free once this lands (no `pull` change); FF/merge/conflict are unit-proven against a local graph until then.
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
