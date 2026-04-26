# Backlog — tsgit v1

Track: `[ ]` todo, `[~]` in progress, `[x]` done, `[-]` skipped

**Progress:** Phases 0–10 complete. Phase 11 (Polish & Launch) is next.

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
- [~] **5.2** Working tree diff (filesystem vs index) — deferred to Phase 7 `status`; domain building block (`diffIndexAgainstTree`) delivered
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

- [ ] **11.1** Benchmark suite (log, readBlob, status, clone vs isomorphic-git)
- [ ] **11.2** Cross-platform E2E tests (Ubuntu, macOS, Windows × Node 18/20/22)
- [ ] **11.3** Browser E2E tests (Chrome, Firefox, Safari via Playwright)
- [ ] **11.4** TypeDoc API documentation
- [ ] **11.5** npm publish dry run, verify with arethetypeswrong
- [ ] **11.6** GitHub repo setup (branch protection, secrets, gh-pages)
- [ ] **11.7** v1.0.0 release

---

## Dependencies

```
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
