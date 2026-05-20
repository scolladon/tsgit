# Backlog — tsgit v1

Track: `[ ]` todo, `[~]` in progress, `[x]` done, `[-]` skipped

**Progress:** Phases 0–11 complete. `@scolladon/tsgit@1.0.0` published on npm with sigstore provenance (trusted-publisher OIDC). Phase 12.1 (clone smart-HTTP pack fetch), 12.2 (fetch + shallow + prune), 12.3 (push), 12.4 (clone bench), 13.1 (checkout materialize), 13.2 (reset --mixed rebuilds the index), 13.3 (reset --hard materialises both index and working tree), 13.5 (checkout lock-first ordering — closes a known TOCTOU window), and 13.6 (path-restore from staged content via index-tree synthesis) shipped. Remaining Phase 13.x items (3-way merge tree walk, index-parser path validation hardening) are next.

---

## Phase 0: Engineering Harness

- [x] **0.1** Project scaffolding (git, dotfiles, package.json, tsconfig)
- [x] **0.2** Build pipeline (rollup dual ESM/CJS, size-limit, attw)
- [x] **0.3** Lint & format (biome, ls-lint, knip, jscpd, cspell, dependency-cruiser)
- [x] **0.4** Test infrastructure (vitest, stryker, playwright config)
- [x] **0.5** Git hooks (husky, lint-staged, commitlint)
- [x] **0.6** CI/CD (GitHub Actions, release-please, npm publish, weekly reports)
- [x] **0.7** Claude Code hooks (auto-format, typecheck, filename validation)
- [x] **0.8** Docs (README, CONTRIBUTING, DESIGN, RUNBOOK, SECURITY, CLAUDE.md, ADRs)

---

## Phase 1: Domain — Object Model

The foundation. Every layer above depends on this.

- [x] **1.1** Value objects: `ObjectId`, `RefName`, `FilePath`, `FileMode`, `AuthorIdentity`
- [x] **1.2** Blob: type definition, parse, serialize
- [x] **1.3** Tree: type definition, `TreeEntry`, parse, serialize (binary format with raw SHA bytes)
- [x] **1.4** Commit: type definition, `CommitData`, `AuthorIdentity`, parse, serialize
- [x] **1.5** Tag: type definition, `TagData`, parse, serialize
- [x] **1.6** `GitObject` discriminated union
- [x] **1.7** Object header parsing (`<type> <size>\0<content>`)
- [x] **1.8** Error types: `TsgitError` discriminated union

Design: `docs/design/domain-object-model.md`

---

## Phase 2: Domain — Object Storage

How objects are read from and written to disk.

- [x] **2.1** Loose object reader — domain layer: `computeLooseObjectPath` (I/O deferred to Phase 4/7)
- [x] **2.2** Loose object writer — domain layer: path computation (I/O deferred to Phase 4/7)
- [x] **2.3** Pack index reader (v2 `.idx` format, fanout table binary search)
- [x] **2.4** Packfile reader (v2 `.pack` format, entry header parsing)
- [x] **2.5** Delta resolution (OBJ_REF_DELTA, OBJ_OFS_DELTA, `applyDelta` single-pass)
- [x] **2.6** Delta base LRU cache (configurable byte-bounded)
- [x] **2.7** Object lookup pipeline — domain building blocks done, full pipeline in Phase 7
- [x] **2.8** Packfile writer (`serializePackfile` + `serializePackIndex`)

Design: `docs/design/object-storage.md`

---

## Phase 3: Domain — Refs & Index

Reference resolution and the staging area.

- [x] **3.1** Ref resolution (loose refs, symbolic refs, `HEAD`)
- [x] **3.2** Packed-refs reader (`.git/packed-refs` format)
- [x] **3.3** Ref peeling (tag → commit → tree)
- [x] **3.4** Ref writer (create, update, delete — atomic)
- [x] **3.5** Git index reader (v2 format, stat cache entries)
- [x] **3.6** Git index writer
- [x] **3.7** Index entry comparison (stat cache validation for `status`)

Design: `docs/design/refs-and-index.md`

---

## Phase 4: Ports & Adapters

The hexagonal boundary.

- [x] **4.1** `FileSystem` port interface
- [x] **4.2** `HttpTransport` port interface
- [x] **4.3** `HashService` port interface
- [x] **4.4** `Compressor` port interface
- [x] **4.5** `ProgressReporter` port interface
- [x] **4.6** `Context` type (aggregates all ports + config)
- [x] **4.7** Node adapter (`node:fs`, `node:crypto`, `node:zlib`, `node:http`)
- [x] **4.8** Browser adapter (OPFS, SubtleCrypto, DecompressionStream, fetch) — type-check only, runtime tests deferred to Phase 11
- [x] **4.9** Memory adapter (in-memory Map, first-class test adapter)

Design: `docs/design/ports-and-adapters.md`

---

## Phase 5: Domain — Diff & Merge

Tree comparison and three-way merge.

- [x] **5.1** Tree diff algorithm (`diffTrees`, two-pointer walk + rename detection)
- [x] **5.2** Working tree diff (filesystem vs index) — domain building block `diffIndexAgainstTree` delivered in Phase 5; the filesystem-vs-index comparison itself shipped in the `status` command (`classifyEntry` lstat + content-hash compare, plus untracked-file enumeration)
- [x] **5.3** Index diff (`diffIndexAgainstTree` + `groupUnmergedEntries` + `conflictsToIndexEntries`)
- [x] **5.4** Three-way merge engine (`mergeTrees` async + `mergeContent` + `writeConflictMarkers`)
- [x] **5.5** Conflict detection and representation (MergeConflict + 7 ConflictType variants)

Design: `docs/design/diff-and-merge.md`

---

## Phase 6: Operators

AsyncIterable composition toolkit (zero domain dependencies).

- [x] **6.1** `pipe`
- [x] **6.2** `filter`
- [x] **6.3** `map`
- [x] **6.4** `flatMap`
- [x] **6.5** `take`
- [x] **6.6** `find`
- [x] **6.7** `toArray`
- [x] **6.8** `groupBy`

Design: `docs/design/operators.md`

---

## Phase 7: Primitives (Tier 2)

Low-level composable operations built from domain + ports.

- [x] **7.1** `readObject` — read any git object by id
- [x] **7.2** `writeObject` — write a git object to storage
- [x] **7.3** `readTree` — read a tree by ref
- [x] **7.4** `writeTree` — write a tree, return ObjectId
- [x] **7.5** `readBlob` — read blob content
- [x] **7.6** `walkCommits` — AsyncIterable commit walker
- [x] **7.7** `walkTree` — AsyncIterable tree entry walker
- [x] **7.8** `resolveRef` — resolve ref to ObjectId
- [x] **7.9** `updateRef` — update a ref atomically
- [x] **7.10** `readIndex` — read the staging area
- [x] **7.11** `createCommit` — create a commit from tree + parents
- [x] **7.12** `diffTrees` — compare two tree iterables

Design: `docs/design/primitives.md`

---

## Phase 8: Transport

Smart HTTP protocol and middleware.

- [x] **8.1** Smart HTTP protocol v1 (discovery, negotiation, packfile exchange)
- [x] **8.2** `withRetry` middleware
- [x] **8.3** `withAuth` middleware (bearer, basic)
- [x] **8.4** `withLogging` middleware

Design: `docs/design/transport.md`. Plan: `docs/plan/phase-8-transport.md`.

---

## Phase 9: Commands (Tier 1)

High-level operations built from primitives.

- [x] **9.1** `init` — initialize a new repository
- [x] **9.2** `add` — stage files to the index
- [x] **9.3** `commit` — create a commit from the current index
- [x] **9.4** `status` — compare working tree, index, and HEAD
- [x] **9.5** `log` — walk commit history
- [x] **9.6** `diff` — diff working tree, index, or commits
- [x] **9.7** `branch` — list, create, delete branches
- [x] **9.8** `tag` — list, create, delete tags
- [x] **9.9** `checkout` — switch branches or restore working tree files
- [x] **9.10** `clone` — clone a remote repository
- [x] **9.11** `fetch` — fetch refs and objects from remote
- [x] **9.12** `push` — push refs and objects to remote
- [x] **9.13** `merge` — three-way merge with conflict detection
- [x] **9.14** `rm` — remove files from the index (and optionally working tree)
- [x] **9.15** `reset` — move HEAD with soft / mixed / hard semantics
- [x] **9.16** `revParse` — resolve revision expressions to ObjectIds

Design: `docs/design/commands.md` (drafted; ready for plan phase)

---

## Phase 10: Repository Facade (Tier 1 Surface)

- [x] **10.1** `openRepository()` — frozen record of closures over context
- [x] **10.2** Auto-detection of adapter (Node vs Browser)
- [x] **10.3** Progress reporting integration

Design: `docs/design/repository-facade.md`

---

## Phase 11: Polish & Launch

- [x] **11.1** Benchmark suite (log, readBlob, status vs isomorphic-git; clone deferred to v1.x)
- [~] **11.2** Cross-platform E2E tests (Ubuntu, macOS, Windows × Node 20/22/24) — matrix expanded, integration suite landed; per-OS mutation gap still open (CI runs the `mutation` job on `ubuntu-latest` only — tracked as **15.4**)
- [x] **11.3** Browser E2E tests (Chromium, Firefox, WebKit via Playwright) — OPFS round-trip, SubtleCrypto SHA-1 parity, DecompressionStream
- [x] **11.4** TypeDoc API documentation
- [x] **11.5** npm publish dry run, verify with arethetypeswrong
- [x] **11.6** GitHub repo setup (branch protection, secrets, gh-pages) — all admin actions complete
- [x] **11.7** v1.0.0 release — `@scolladon/tsgit@1.0.0` live on npm with sigstore provenance

---

## Dependencies

```text
Phase 1 (objects) → Phase 2 (storage) → Phase 3 (refs & index)
                                              ↓
Phase 4 (ports & adapters) ←──────────────────┘
       ↓
Phase 5 (diff & merge)
       ↓
Phase 6 (operators)  ← independent, can start anytime
       ↓
Phase 7 (primitives) → Phase 8 (transport) → Phase 9 (commands)
                                                    ↓
                                              Phase 10 (facade)
                                                    ↓
                                              Phase 11 (launch)
```

---

## Post-v1 Backlog

Captured from Phase 11 design §9.2 + parallel-review deferrals. Grouped by
target release (v1.x patches/minor vs. v2). Each item carries a one-line
acceptance hint so the next planner can scope it without re-deriving context.

### Phase 12 — Network completion (v1.x minor)

Surface exists today; stub bodies need real loops. Highest user-visible value.

- [x] **12.1** `clone`: smart-HTTP pack fetch + write-objects loop.
      _Accepted:_ `repo.clone({ url })` against a real `git-upload-pack` endpoint produces a working repo whose `git log` matches the remote's HEAD line. End-to-end integration test against a local `git-http-backend` is green (`test/integration/network/clone-http-backend.test.ts`). Shallow / `depth: N` deferred to 12.2 per [ADR-008](adr/008-clone-defer-shallow.md). Streaming the pack to a temp file (instead of in-memory buffer) deferred per [ADR-007](adr/007-clone-resume-semantics.md). Smart-HTTP v2 deferred per [ADR-005](adr/005-clone-protocol-v1.md).
- [x] **12.2** `fetch`: ls-refs + want/have negotiation + pack write.
      _Accepted:_ shallow + non-shallow fetch updates `refs/remotes/<remote>/*` and writes received objects. End-to-end integration tests against a local `git-http-backend` for both the non-shallow path and the `depth: 1` shallow path (`test/integration/network/fetch-http-backend.test.ts`, `test/integration/network/fetch-shallow-http-backend.test.ts`). `clone({ url, depth })` reopens via the same `fetchPack` extension. ADRs [009](adr/009-fetch-shallow-where.md), [010](adr/010-fetch-haves-strategy.md), [011](adr/011-fetch-ref-update-tx.md), [012](adr/012-fetch-prune-semantics.md) capture the four design choices.
- [x] **12.3** `push`: pack send via `git-receive-pack`.
      _Accepted:_ `repo.push({ remote, refspecs })` advances the remote ref and uploads only the missing objects via a real receive-pack negotiation. End-to-end integration test against a local `git-http-backend` (`test/integration/network/push-http-backend.test.ts`) exercises both the create-then-push happy path and the up-to-date no-op path. Force-with-lease (`'auto'` and explicit oid) and delete refspecs are supported. ADRs [013](adr/013-push-pack-encoding.md), [014](adr/014-push-refspec-scope.md), [015](adr/015-push-force-with-lease.md), [016](adr/016-push-atomic-tx.md) capture the four design choices.
- [x] **12.4** Bench: `clone:small-repo` scenario.
      _Accepted:_ `test/bench/clone-small-repo.bench.ts` boots a shared `git-http-backend` CGI once per `describe`, then runs full-clone iterations against the committed `test/fixtures/clone-source/source.git` fixture for both tsgit (`openRepository → repo.clone → repo.dispose`) and isomorphic-git (`git.clone(..., { singleBranch: true })`). The new row flows into `reports/benchmarks/summary.md` via the existing `scripts/bench-summarize.ts` with no script changes. CGI lifecycle captured in [ADR-017](adr/017-bench-cgi-server-lifecycle.md). The shared helper at `test/bench/support/http-backend-server.ts` is also imported by `test/integration/network/clone-http-backend.test.ts` — eliminating the previously duplicated CGI plumbing.

### Phase 13 — Working-tree fidelity (v1.x minor)

Today `checkout` / `reset --hard` move HEAD only. Materializing the working
tree is the visible gap.

- [x] **13.1** `checkout:materialize` — diff target tree vs current working tree; write/delete/chmod files atomically.
      _Accepted:_ `repo.checkout({ target })` now materialises the target tree onto the working tree, atomically commits a new `.git/index`, and moves HEAD. Path-restore mode (`repo.checkout({ paths, source? })`) is available with `source` defaulting to `'index'`. Regular/executable files honour the `chmod` semantics from FILE_MODE; symlinks are written as platform symlinks; gitlinks become empty placeholder directories. Dirty-tree guard refuses to overwrite tracked-modifications or untracked-collisions unless `force: true`. Per-path progress emitted via `'checkout:materialize'`. Atomicity is per-file (matches canonical git) — see [ADR-018](adr/018-checkout-atomicity-model.md). Dirty-tree guard reuses the loose-object hash; the stat-cache fast path is documented for a follow-up — see [ADR-019](adr/019-checkout-dirty-tree-guard.md). API shape (`{ target }` vs `{ paths }`) keeps backwards compatibility — see [ADR-020](adr/020-checkout-paths-api-shape.md).
- [x] **13.2** `reset --mixed`: clear index entries beyond the lock-release stub.
      _Accepted:_ `repo.reset({ mode: 'mixed', target })` now rebuilds `.git/index` from the target commit's tree under the same `acquireIndexLock` that commits it — closing the TOCTOU window where a concurrent writer could otherwise make the donor map stale. The new `buildIndexFromTree` primitive in `src/application/primitives/` projects the target tree to a stage-0 IndexEntry list and preserves stat-cache fields for paths whose `id + mode` survive (the "stat-cache donor" strategy — [ADR-021](adr/021-reset-mixed-stat-cache-donor.md)). Pathspec scoping (`reset --mixed -- <pathspec>`) is deferred to Phase 14.2 — [ADR-022](adr/022-reset-mixed-pathspec-scope.md). Working tree is never touched; bare repos accept `reset --mixed`. Mutation-hardened: every surviving mutant is documented inline as `// equivalent-mutant`.
- [x] **13.3** `reset --hard`: invoke 13.1's materialize routine.
      _Accepted:_ `repo.reset({ mode: 'hard', target })` now atomically rewrites the working tree AND `.git/index` to match the target commit's tree. Composition only — wires Phase 13.1's `materializeTree` (working-tree materialise) with Phase 13.2's lock-first ordering (acquireIndexLock wraps readIndex + materializeTree + commit). Bare repos still reject `reset --hard` upfront. The index commit uses materializeTree's post-write lstat-derived stats per [ADR-023](adr/023-reset-hard-index-stat-source.md). A small primitive surface addition (`forceRewriteAll` option on materializeTree) is required so locally-modified files whose index still records the committed `id` are overwritten rather than skipped as noops. Mutation-hardened: stats-tally arithmetic verified via progress-event capture. Pathspec scoping deferred to Phase 14.2.
- [x] **13.4** Three-way tree merge in `merge`: walk HEAD ∩ THEIRS ∩ BASE, apply per-path resolution, write conflict markers.
      _Accepted:_ shipped in two slices — **13.4a** (clean-merge tree walk wires `mergeTrees`, merge commit reflects the merged tree, conflicting merges throw `MERGE_HAS_CONFLICTS` with conflict paths) and **13.4b** (conflict-resolution machinery — working-tree markers, unmerged stage-1/2/3 index, `.git/MERGE_HEAD`/`MERGE_MSG`/`ORIG_HEAD`; see the dedicated **13.4b** entry below). Both complete.
- [x] **13.5** Tighten `checkout` to lock-first ordering.
      _Accepted:_ `repo.checkout({ target })` and `repo.checkout({ paths, source: 'HEAD' | <ObjectId> })` now acquire `index.lock` BEFORE `readIndex`, closing the TOCTOU window where a concurrent index writer could otherwise stale the donor stat fields between read and commit. Path-restore from the default `source: 'index'` stays lock-free by design (no index write happens; the operation acts on the index snapshot we read — well-defined). Two new private helpers (`materializePathRestoreLockless` / `materializePathRestoreLocked`) name the actual semantic axis. Also harmonised the no-op commit skip across `checkout` / `reset --hard` / `reset --mixed`. 4 new tests pin the lock-first ordering (including a corrupted-index discriminator that proves the lock acquires BEFORE readIndex, and an ObjectId-source branch coverage). Mutation score on `checkout.ts` improved from 42.86% (main) to 50.56% — no new survivors introduced.
- [x] **13.6** Path-restore from index — synthesise tree from index directly.
      _Accepted:_ `repo.checkout({ paths, source: 'index' })` now restores from staged content via the new `synthesizeTreeFromIndex` primitive (`src/application/primitives/`), instead of falling back to HEAD's tree. The synthesis is the inverse of Phase 13.2's `buildIndexFromTree`. Single-snapshot semantics: `materializePathRestoreLockless` reads the index ONCE and shares it between synthesis and diff, closing a TOCTOU window. Path-restore (both lockless and locked branches) now passes `forceRewriteAll: true` to match canonical `git checkout -- <path>` semantics (always write the source content). Defensive segment validation rejects `..`/`.`/empty/leading-slash paths and caps recursion at MAX_TREE_DEPTH (4096); the canonical fix moves to the index parser as a follow-up (see §13.7). Also backfilled the missing `buildIndexFromTree` barrel export from Phase 13.2.
- [x] **13.7** Defensive path validation at the index parser.
      _Accepted:_ `parseIndex` (in `src/domain/git-index/index-parser.ts`) now calls `validateIndexPath` (`src/domain/git-index/path-validator.ts`) before constructing the branded `FilePath`. Unsafe entries — leading `/`, `..`/`.`/empty segments, backslashes, C0/C1 controls, BIDI/isolate Unicode controls (TR9) — are rejected at parse time with `INVALID_INDEX_ENTRY` carrying the byte offset. `synthesizeTreeFromIndex` keeps a defence-in-depth call via `NO_PARSER_OFFSET` so paths constructed outside the parser (test fixtures, future in-memory builders) still get rejected. Shipped in PR #35; this BACKLOG tick was missed by the squash-merge — corrected in the Phase 13.8 PR.
- [x] **13.8** Bounded-size object reads for clean-merge content.
      _Accepted:_ `readObject(ctx, id, { maxBytes })` and `readBlob(ctx, id, { maxBytes })` throw `OBJECT_TOO_LARGE` (carrying `id`, `actualSize`, `limit`) for objects whose serialised payload exceeds the cap. Loose objects cap at the post-inflate header parse; pack base entries cap pre-inflate via the declared header size; pack delta-resolved entries cap post-apply (see [ADR-024](adr/024-bounded-reads-where-cap-fires.md)). `buildContentMerger` reads ours/theirs/base in `Promise.all` with `maxBytes: MAX_CONFLICT_OUTPUT_BYTES` — adversarial blobs are rejected upfront before `mergeContent`'s line-diff path runs, and the parallel fetch reduces merge wall-time to a single round trip ([ADR-025](adr/025-merge-parallel-blob-reads.md)). A forged-header merge test proves OBJECT_TOO_LARGE fires for a `MAX_CONFLICT_OUTPUT_BYTES + 1` blob without materialising the buffer. Design: `docs/design/phase-13-8-bounded-object-reads.md`.
- [x] **13.4b** Three-way merge conflict handling.
      _Accepted:_ `repo.merge({ target })` no longer throws on conflicts — it returns `{ kind: 'conflict', conflicts, mergeHead, origHead }`. Per-path conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) are written to the working tree via `writeConflictMarkers`; the index gains stage-1/2/3 entries via `conflictsToIndexEntries`; `.git/MERGE_HEAD`, `.git/MERGE_MSG`, and `.git/ORIG_HEAD` persist the merge state under the `index.lock`. `commit` reads `MERGE_HEAD` as a second parent and clears the merge-state files after the resolving commit succeeds. `add` and `commit` accept `{ except: 'merge' }` to allow staging resolved files during a conflicted merge; other pending operations (rebase / cherry-pick / revert) still block. Unsupported conflict types (`rename-rename`, `gitlink`) reject upfront with `unsupportedOperation` before any disk write. Design: `docs/design/phase-13-4b-merge-conflict-handling.md`. ADRs: [026](adr/026-merge-conflict-returns-not-throws.md) (return-vs-throw), [027](adr/027-merge-conflict-write-order.md) (working-tree → ORIG_HEAD → MERGE_HEAD → MERGE_MSG → index), [028](adr/028-merge-msg-content.md) (no Conflicts trailer).

### Phase 14 — Glob & pathspec (v1.x patch)

- [x] **14.1** `add --all` (bulk mode walking the working tree).
      _Accepted:_ `repo.add([], { all: true })` walks the working tree via the new `walkWorkingTree` primitive (DFS through `FileSystem.readdir` + `lstat`), stages every modified/new tracked path plus every untracked non-ignored path, and surfaces the staged set on `AddResult` (added/modified/removed, each sorted). Mixing `all: true` with a non-empty pathspec throws `INVALID_OPTION { option: 'all' }`. The host `.git` is skipped; embedded `.git` directories AND worktree-pointer files mark their parent as opaque (no `160000` gitlink). Symlinks stage as mode `120000` (lstat-only, never followed). Per-file size cap `MAX_WORKING_TREE_BLOB_BYTES` (256 MiB) throws the new `WORKING_TREE_FILE_TOO_LARGE` variant with no partial index commit — defended at both walk-time and the authoritative post-re-lstat re-check. A walk→stage TOCTOU re-lstat aborts the call with `OPERATION_ABORTED` if any of `isFile`/`isDirectory`/`isSymbolicLink` flips between the walk and the stage. Ignore evaluation is a stub `defaultIgnorePredicate` (see [ADR-029](adr/029-add-all-ignore-stub.md)) — Phase 14.3 will plug the real `.gitignore` evaluator without changing the seam. Design: `docs/design/phase-14-1-add-all.md`. ADRs: [029](adr/029-add-all-ignore-stub.md) (ignore stub), [030](adr/030-add-all-walk-strategy.md) (new walkWorkingTree primitive), [031](adr/031-add-all-symlink-gitlink-policy.md) (symlink/gitlink policy), [032](adr/032-add-all-large-file-guard.md) (large-file guard).
- [x] **14.2** Pathspec globs (`*.ts`, `src/**`) across `add`, `rm`, `checkout` (status filter deferred per [ADR-039](adr/039-defer-status-pathspec.md)).
      _Accepted:_ `repo.add`, `repo.rm`, and `repo.checkout({ paths })` accept globs (`*`, `?`, `**`) and literals in the same `paths` array. Auto-detection by content: any pattern with `*` or `?` is a glob, otherwise a literal that acts as a directory prefix (matches the exact path AND descendants — Git's `git add src` semantics). `!`-prefixed entries exclude; last-match wins (mirrors `.gitignore`). Literal-no-match throws `PATHSPEC_NO_MATCH`; glob-no-match is a silent no-op. The pathspec compiler reuses `compileGlob` (extracted from `parseGitignore` into a shared `src/domain/pathspec/` module). Pattern budget: 256 UTF-8 bytes per pattern, max 4 `**` tokens, both throw `INVALID_OPTION` — bounds compiled-regex cost. Mid-pattern `**/` correctly compiles to `(.*/)?` instead of `.*` (fixing a latent bug where `a/**/c` matched `a/xc`). `status` pathspec filtering is deferred (ADR-039) — `status` is a read-only summary; callers filter the result array themselves. Design: `docs/design/phase-14-2-pathspec-globs.md`. ADRs: [037](adr/037-pathspec-auto-detect.md) (auto-detect), [038](adr/038-pathspec-exclusion.md) (`!` exclusion), [039](adr/039-defer-status-pathspec.md) (status deferred), [040](adr/040-extracted-compile-glob.md) (shared compileGlob). Character classes (`[abc]`) and magic prefixes (`:(top)`, `:(literal)`) are NOT supported in v1.
- [x] **14.3** `.gitignore` evaluation in `add --all` and `status` untracked-file enumeration.
      _Accepted:_ `add --all` and `status` honour the four standard ignore sources in evaluation order (last-match-wins): `core.excludesFile` from git config (with `~` expanded via the new `RepositoryLayout.homeDir`), `.git/info/exclude`, repo-root `.gitignore`, and nested `.gitignore` files per directory. The new domain primitive `matchInStack` composes `IgnoreLevel`s; the application factory `buildRepoIgnorePredicate` builds a closure that lazily loads nested rules during the walk. `walkWorkingTree` accepts an async `ignore?: WalkIgnorePredicate`; ignored directories are pruned at walk-time so `node_modules/`, `dist/`, etc. never get lstat'd at the leaf level. `status` now emits `{ kind: 'untracked', path }` for non-ignored working-tree files not in the index (the `'untracked'` ChangeKind had been declared but never emitted since Phase 10). Tracked-but-ignored files stay in the index (Git's invariant) — the post-walk re-check consults every ancestor as a directory so a `vendor/` rule does not auto-untrack `vendor/foo.ts`. New error variant `GITIGNORE_FILE_TOO_LARGE` (1 MiB cap, `MAX_GITIGNORE_BYTES`) with a sanitized basename in the payload so absolute home-directory paths don't leak. Non-regular files pointed at by `core.excludesFile` (directories, symlinks, block devices) are silently skipped. Design: `docs/design/phase-14-3-gitignore.md`. ADRs: [033](adr/033-gitignore-sources.md) (sources), [034](adr/034-homedir-injection.md) (`homeDir` injection), [035](adr/035-walk-ignore-pruning.md) (async pruning predicate), [036](adr/036-gitignore-bounded-read.md) (size cap).
- [x] **14.4** Full Windows support.
      _Accepted:_ `NodeFileSystem` now reconciles 8.3 short-name vs long-name `realpath` outputs via a lazy `Promise<string>`-cached canonical root resolved at first call (`getCanonicalRoot`). Containment checks run through a new `pathContains(parent, child, policy)` helper that case-folds on Windows and uses the platform-native separator. The constructor accepts an optional second arg `pathPolicy: PathPolicy = nativePolicy` (the host-bound default from a new `src/adapters/node/path-policy.ts`) and an optional third arg `fsOps: FsOperations = realFsOps` (the Pick-shaped `node:fs/promises` surface from a new `src/adapters/node/fs-operations.ts`) — production uses the defaults; tests inject `posixPolicy` / `windowsPolicy` plus a `fakeFsOps` to exercise both arms on a single host without `vi.mock`. `mapErrno` gained a first-class `ELOOP → PERMISSION_DENIED` arm; `openWithNoFollow` pre-lstats on Windows so `EACCES`/`EPERM` rewraps only when the leaf is actually a symlink (a real EACCES on a regular file surfaces unchanged). `runFs`-style unsafe `as NodeJS.ErrnoException` casts replaced with `isErrnoException` guards. The shared `test/unit/ports/file-system.contract.ts` now uses `nodePath.join` everywhere instead of template-string concatenation. `.github/workflows/ci.yml` re-adds `windows-latest` × `node 22, 24` to the `unit-tests` matrix and adds two sibling integration jobs (`posix-integration` on ubuntu + macOS, `win-integration` on windows-latest) gated by folder placement (`test/integration/posix-only/` and `test/integration/win-only/`); mutation stays Linux-only (ADR-044). The cross-platform integration job excludes both `*-only/` folders. Lint-staged stays scoped to `--project unit` so commit hooks never run platform-bound suites on the wrong host. Design: `docs/design/phase-14-4-windows-support.md` (§9 captures the post-merge PathPolicy / FsOps / folder-split pivot). ADRs: [041](adr/041-windows-testing-strategy.md) (dev-vs-CI), [042](adr/042-canonical-root-lazy-realpath.md) (canonical-root cache), [043](adr/043-errno-mapping-placement.md) (errno placement), [044](adr/044-ci-matrix-windows-inclusion.md) (CI matrix), [045](adr/045-separator-normalisation-policy.md) (separator policy), [046](adr/046-path-policy-abstraction.md) (PathPolicy abstraction), [047](adr/047-fs-operations-dependency-injection.md) (FsOperations DI), [048](adr/048-platform-segregated-test-folders.md) (platform test folders).
- [x] **14.5** Phase 14.4 follow-up bundle — 13 of 14 sub-items shipped (12 in one bundled PR, **14.5.13** in a separate follow-up); **14.5.3 abandoned** (see [Abandoned work](#abandoned-work)). Design: `docs/design/phase-14-5-followups.md`. ADRs: [049](adr/049-bundle-vs-split-followups.md) (bundle), [050](adr/050-cache-invalidation-policy.md) (cache invalidation), [051](adr/051-symlink-target-containment.md) (symlink target), [052](adr/052-directory-not-empty-error-code.md) (DIRECTORY_NOT_EMPTY), [053](adr/053-abandon-skip-resolve-optimization.md) (skip-resolve abandoned).
      - [x] **14.5.1** Cache `normalizeForCompare(rootDir)` + `normalizeForCompare(canonicalRoot)` as instance fields on `NodeFileSystem`. Eliminates ~4-6 string allocations per `checkContainment` call on Windows; biggest win on `status` / `add --all` hot paths. (Perf review HIGH.)
      - [x] **14.5.2** Bounded-concurrency walk in `NodeFileSystem.removeTree`. Replace the serial `for…of` over directory children with a `Promise.all` over batches of 8 entries. (Perf review HIGH; not §14.4-introduced — pre-existing.)
      - [x] **14.5.4** Parent-directory realpath LRU (capacity 64) in `resolveForCreation` to amortise the O(D) walk across writes into the same directory tree on a clone/checkout. (Perf review MEDIUM.)
      - [x] **14.5.5** Replace `this.lstat(real)` inside `rmRecursive` with a direct `runFs(() => this.fsOps.lstat(real), path)` — removes a redundant `checkContainment` round-trip on an already-verified path. (TS review MEDIUM-4.)
      - [x] **14.5.6** Mirror the read-mode pre-`realpath` containment check in `resolveForMode`'s `lstat` branch so obvious out-of-tree inputs fail-fast before any I/O. (TS review MEDIUM-3.)
      - [x] **14.5.7** Narrow `makePolicy`'s parameter type from `typeof nodePath.posix` to an explicit structural interface matching the methods actually consumed, to prevent accidental injection of the host `nodePath` namespace. (TS review MEDIUM-5.)
      - [x] **14.5.8** Move the `nativePolicy` default out of `src/repository/find-layout.ts` (which today imports across the hexagonal boundary — repository → adapter). Either inject the policy at the call site or hoist the default into a non-adapter module. (TS review LOW-7.)
      - [x] **14.5.9** Validate absolute-symlink targets against rootDir containment inside `NodeFileSystem.symlink` (currently the link entry is contained but the target string is passed raw to the kernel, enabling an in-rootDir symlink to point outside it — an info-oracle via `readlink`). Relative targets pass unconditionally. (Security review MEDIUM, pre-existing behaviour; tighten now that the canonical-root machinery is in place.)
      - [x] **14.5.10** Add `case 'EISDIR': return permissionDenied(path)` to `mapErrno` so Windows symlink-to-directory failures take a single hop instead of `EISDIR → UNSUPPORTED_OPERATION → isWindowsSymlinkRefusal → PERMISSION_DENIED`. (Security review LOW-1.)
      - [x] **14.5.11** Drop the always-`true` `isSymlinkLeaf` argument at the only `isWindowsSymlinkRefusal` call site (or thread the real lstat result through). The current signature reads as if it carries information it does not. (Security review LOW-2.)
      - [x] **14.5.12** Distinguish `ENOTEMPTY` from `ENOTDIR` in `mapErrno` (currently both map to `NOT_A_DIRECTORY`). Add a new error code or comment the deliberate coalescing. (Security review LOW-3.)
      - [x] **14.5.13** Strip a leading `\\?\` extended-length prefix inside Windows `normalizeForCompare` (and the `\\?\UNC\` variant). Without it, a `realpath` result carrying the prefix spuriously denied as out-of-tree against its plain-form sibling in `lstat`/`creation` modes. (Security review LOW-4.) The strip is a module-private pure helper gated by `caseInsensitive`; the POSIX arm stays identity. Originally implemented in the §14.5 bundle, reverted while bisecting an unrelated Windows-CI failure (root cause: 14.5.3), and reintroduced here on its own.
      - [x] **14.5.14** DI-level coverage of `openWithNoFollow(path, 'write')` against a Windows-mocked symlink — today the `'write'` flag-selection arm is only exercised via the POSIX-only locked-directory integration test. (Test review HIGH-2.)

### Phase 15 — Bench + observability follow-ups (v1.x patch)

- [ ] **15.1** "Medium" bench fixture: 5k commits / 20k blobs / ~50 MB (clone of the tsgit repo snapshot, cached in `~/.cache/tsgit-bench`).
- [ ] **15.2** "Large" bench fixture: 50k commits / 200k blobs / ~500 MB.
- [ ] **15.3** `node --prof` profiling captures for the three hot paths (log, status, pack-read).
- [ ] **15.4** Per-OS mutation testing on macOS + Windows (closes Phase 11.2 `[~]`).
- [ ] **15.5** Bench DSL convention: adapt vitest `bench` call sites to a thin wrapper that enforces Given/When/Then + `sut` naming (review deferral).
- [ ] **15.6** Re-enable the `benchmark-snapshot` ci.yml job. Needs a node script that converts `reports/benchmarks/raw.json` (vitest schema) into `[{name,value,unit}]` for `benchmark-action/github-action-benchmark@v1`'s `customSmallerIsBetter` tool. Disabled after the `tool: vitest` value was rejected by the action (it only accepts cargo/go/benchmarkjs/.../customSmaller|BiggerIsBetter).

### Phase 16 — Supply-chain & ops hardening (v1.x patch)

- [ ] **16.1** Pin every third-party GitHub Action `uses:` to a 40-char commit SHA (Phase 11 security review MEDIUM).
- [ ] **16.2** Dependabot config covers action SHAs (group with `update-strategy: lockfile-only`).
- [ ] **16.3** Browser E2E surface parity: extend `test/browser/` to cover `log`, `branch`, `checkout`, `tag` against OPFS (Phase 11 test-review gap).
- [ ] **16.4** Split the OPFS round-trip mega-scenario into per-step assertions for sharper failure messages.

### v2.0 — Larger semantic surface

- [ ] **17.1** Reflog (`HEAD@{N}`, `<branch>@{N}` syntax, `.git/logs/` writers).
- [ ] **17.2** Hooks (`pre-commit`, `commit-msg`, `pre-push` invocation contract; opt-in for the security model).
- [ ] **17.3** Sparse checkout (`.git/info/sparse-checkout` patterns, partial materialization).
- [ ] **17.4** Partial clone (`--filter=blob:none`, lazy-fetch on read).
- [ ] **17.5** Submodule walk (recurse into `.gitmodules`, expose as `repo.submodules` iterator).
- [ ] **17.6** `git-cat-file --batch` equivalent on the primitive layer for high-throughput readers.
- [ ] **17.7** isomorphic-git compatibility shim (runtime namespace re-export — explicitly out of scope for v1 per MIGRATION.md, revisit if adoption demands it).

### Cosmetic / housekeeping

- [x] **18.1** Fix `examples/try-on-self.mjs` `mode → kind` mapping — replaced single-literal compare with the full FILE_MODE table (tree/file/exec/symlink/gitlink).

---

## Abandoned work

Items that were started and then deliberately dropped. Ticked `[x]`
because the *decision* is final — they are NOT queued. Each links the
ADR that records why.

- [x] **14.5.3** Gate `policy.resolve()` in `checkContainment` to skip a "no-op" resolve on clean absolute inputs. Implemented in the §14.5 bundle, then abandoned: `policy.resolve` also normalises foreign separators (a `/` in a Windows path) — a contract ADR-045 requires the adapter to honour — and no cheap caller-side probe can safely mirror Node's full `path.resolve` normalisation surface. The cost the optimization chased (a `process.cwd()` hit) does not even occur for absolute inputs. See [ADR-053](adr/053-abandon-skip-resolve-optimization.md).

---

## Phase 11 admin tail — all completed 2026-05-17

- [x] npm **trusted publisher** binding configured (scolladon/tsgit ↔ npm-service.yml)
- [x] `RELEASE_PLEASE_PAT` secret seeded
- [x] Branch protection on `main` set via `gh api`
- [x] Repo metadata + topics + Discussions enabled via `gh repo edit`
- [x] GitHub Pages source set to "GitHub Actions"
- [x] Release-please PR merged → tag `v1.0.0` → `npm-service.yml` published `@scolladon/tsgit@1.0.0` via OIDC

### Lessons learned (worth recording for future packages)

- npm 10.9.x (Node 22's bundled npm) has a broken trusted-publisher OIDC PUT path that masks as `404 ... is not in this registry`. Pin the publish workflow to Node 24 so npm 11.x is bundled.
- npm's trusted-publisher provenance binding validates `package.json#repository.url` against the GitHub repo recorded in the sigstore attestation — set `repository`, `homepage`, `bugs` BEFORE the first publish or expect a `422 Unprocessable Entity`.
- The npm scoped name `@scolladon/tsgit` was forced after npm rejected the unscoped `tsgit` as too similar to existing `ts-git`.
