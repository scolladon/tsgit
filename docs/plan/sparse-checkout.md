# Sparse Checkout — Implementation Plan (Phase 17.3)

> Derived from `docs/design/sparse-checkout.md` and ADRs 069–074. Each step is
> Red → Green → Refactor; `npm run validate` passes before every commit;
> commits are atomic conventional-commit subjects.

## Slice ordering & dependencies

```
1 Index v3 ─┐
2 Sparse domain ─┼─→ 4 Sparse primitives ─→ 6 Command ─┐
3 Config ────┘        │                                 ├─→ 8 Facade + docs
                      └─ 5 materializeTree ─→ 7 Integration ┘
```

Slices 1 / 2 / 3 are mutually independent — implementable in parallel (agent
teams). Slice 5 needs 1 + 2. Slice 4 needs 1 + 2 + 3. Slice 7 needs 4 + 5.

---

## Slice 1 — Index v3 / skip-worktree

**1.1 — `IndexEntryFlags` reshape.**
- Test (`test/unit/domain/git-index/index-entry.test.ts`): `STAGE0_FLAGS` is
  `{ assumeValid:false, stage:0, skipWorktree:false, intentToAdd:false }`.
- Impl: edit `index-entry.ts` — drop `extended`, add `skipWorktree` /
  `intentToAdd`; export `STAGE0_FLAGS`; widen `GitIndex.version` to `2 | 3`.
  Export `STAGE0_FLAGS` from `git-index/index.ts`.
- Verify: `npm run check:types` fails at every stale `{ …extended… }` literal.

**1.2 — Migrate `IndexEntry` construction sites.**
- The `flags:` literals are anonymous, so the **compiler** enumerates them:
  run `npm run check:types` and fix each reported site (`index-parser.ts`,
  `apply-changeset.ts`, `add.ts`, `build-index-from-tree.ts`,
  `synthesize-tree-from-index.ts`, the conflict→index code, tests).
- Impl: replace `{ assumeValid:false, extended:false, stage:0 }` with
  `STAGE0_FLAGS`; non-zero-stage sites use `{ ...STAGE0_FLAGS, stage:N }`.
- Verify: `npm run check:types` green; existing test suite green (no v3 yet —
  pure refactor).
- Commit: `refactor(git-index): IndexEntryFlags carries skip-worktree`.

**1.3 — Parser v3.**
- v3 fixtures are built as explicit byte arrays in-test (the existing
  index-parser tests already construct index bytes this way); the slice-8
  interop test additionally cross-checks against a real git-written index.
- Test (`index-parser.test.ts`): a v3 fixture with one skip-worktree entry
  parses (`skipWorktree:true`); an `intentToAdd` entry round-trips the bit; a
  v2-header index with an `extended` bit throws `INVALID_INDEX_ENTRY`; a v3
  extended entry truncated mid extended-flags throws; `version` returned is
  `3`. Isolated guard tests per bit mask.
- Impl: accept `version 2|3`; `parseFlags(raw, offset, version)` reads the
  extended field; widen the per-entry truncation guard by 2 when `extended`;
  shift the post-header cursor by `(extended?2:0)`.

**1.4 — Writer v3.**
- Test (`index-writer.test.ts`): an index with a skip-worktree entry
  serialises with header version 3 and a 64-byte entry header; with no such
  entry serialises v2 byte-identical to today; `intentToAdd` emitted; padding
  correct for an extended entry (path length `+1` proves the 8-byte boundary).
- Impl: `chooseVersion(entries)`; per-entry `extended` flag; write `ext16`;
  `entryLength` / `paddedLength` account for the 2 extra bytes.
- Verify: round-trip property test parse∘serialize∘parse = identity for v2 and
  v3 fixtures.
- Commit: `feat(git-index): index v3 skip-worktree extended flags`.

---

## Slice 2 — Sparse domain (`src/domain/sparse/`)

**2.1 — `tokenizeIgnoreLine` extraction.**
- Test (`test/unit/domain/ignore/parse-gitignore.test.ts`, extend):
  `tokenizeIgnoreLine` arms — comment, blank, `!`, leading `/`, trailing `/`,
  escape; returns `undefined` for skipped lines.
- Impl: extract the comment/blank/escape/`!`//`/`-decomposition out of
  `parseGitignore` into exported `tokenizeIgnoreLine`; `parseGitignore` calls
  it; export from `domain/ignore/index.ts`.
- Verify: `parse-gitignore` suite green; **re-run `stryker` on
  `parse-gitignore.ts`** — the extraction may invalidate existing
  `Stryker disable` comments; re-tune.
- Commit: `refactor(ignore): extract tokenizeIgnoreLine`.

**2.2 — Types.** `sparse-pattern.ts`: `SparseRule`, `SparseSpec`,
`SparseMatcher`. No test (types only).

**2.3 — Cone.**
- Test (`test/unit/domain/sparse/cone.test.ts`): `buildConeSpec` derives
  `R`/`P` (nested, siblings, ancestor-also-recursive); rejects `..`/`*`/`?`;
  `coneMatcher` in/out (root file, parent direct file, parent *sub*dir file
  excluded, recursive subtree file); `serializeCone` byte-exact vs a
  git-written fixture; `parseCone` round-trips, returns `undefined` on a
  non-cone line.
- Impl: `cone.ts` — `buildConeSpec`, `coneMatcher`, `serializeCone`,
  `parseCone`.

**2.4 — Non-cone.**
- Test (`non-cone.test.ts`): `compileSparseRule` recursive vs non-recursive per
  the design §4.3 table; `nonConeMatcher` last-match-wins, negation,
  `/src/*`-direct-only.
- Impl: `non-cone.ts` — `compileSparseRule`, `nonConeMatcher` (reuse
  `compileGlob`, `tokenizeIgnoreLine`).

**2.5 — `parseSparseCheckout` + `buildSparseMatcher`.**
- Test (`parse-sparse-checkout.test.ts`): cone-requested + cone file →
  `{spec:cone, degraded:false}`; cone-requested + non-cone file →
  `{spec:no-cone, degraded:true}`; non-cone-requested → `degraded:false`;
  `buildSparseMatcher` dispatches.
- Impl: `parse-sparse-checkout.ts`; `domain/sparse/index.ts` barrel;
  re-export from `domain/index.ts`.
- Commit: `feat(sparse): cone + non-cone pattern engine`.

---

## Slice 3 — Config

**3.1 — `config-read` keys.**
- Test (`config-read.test.ts`): `sparsecheckout` / `sparsecheckoutcone` parsed
  case-insensitively; `finalizeCore` emits `core` when only one is set.
- Impl: add the two fields to `ParsedConfig.core`; `mergeCore` /
  `finalizeCore` arms. Rename `__resetConfigCacheForTests` →
  exported `invalidateConfigCache(ctx)` (keep a test alias if referenced).

**3.2 — `setCoreConfigEntry` + `updateCoreConfig`.**
- Test (`test/unit/application/primitives/update-config.test.ts`):
  `setCoreConfigEntry` — replace existing key; insert under existing `[core]`;
  create `[core]` when absent; other sections/comments/order intact;
  case-insensitive key. `updateCoreConfig` writes the file and invalidates the
  cache (a follow-up `readConfig` sees the new value).
- Impl: `update-config.ts` — pure `setCoreConfigEntry`, primitive
  `updateCoreConfig`; barrel export.
- Commit: `feat(config): core.sparseCheckout keys + targeted writer`.

---

## Slice 4 — Sparse primitives

**4.1 — `path-layout`.** Add `sparseCheckoutPath(gitDir)`; trivial test.

**4.2 — `isWorkingTreeDirty` export.**
- Impl: rename `apply-changeset.ts`'s `isTrackedDirty` →
  exported `isWorkingTreeDirty`; barrel export. Existing `apply-changeset`
  tests stay green (internal rename).

**4.3 — `read-sparse-checkout`.**
- Test (`read-sparse-checkout.test.ts`): `readSparsePatternText` — absent file
  → `undefined`; over-`MAX_SPARSE_PATTERN_FILE_BYTES` (`limit+1`) throws
  `SPARSE_PATTERN_FILE_TOO_LARGE`. `loadSparseMatcher` — `core.sparseCheckout`
  falsy → `undefined`; cone vs non-cone dispatch; absent file → empty-pattern
  matcher; degraded cone file logs a warning.
- Impl: needs the `SPARSE_PATTERN_FILE_TOO_LARGE` error variant + factory
  (`domain/commands/error.ts`) + `extractDetail` arm (`domain/error.ts`) +
  `MAX_SPARSE_PATTERN_FILE_BYTES` constant first. `read-sparse-checkout.ts`.

**4.4 — `write-sparse-checkout`.**
- Test: `writeSparsePatternText` mkdir-s `info/` and writes the file.
- Impl: `write-sparse-checkout.ts`.

**4.5 — `apply-sparse-checkout`.**
- Test (`apply-sparse-checkout.test.ts`): narrow (file removed, bit set);
  widen (file written, bit cleared); dirty excludee retained w/o `force`,
  removed w/ `force`; `matcher:undefined` re-materialises all and clears every
  bit; `materialized`/`removed`/`retained` counts exact (try/catch + `.data`
  assertions). Memory adapter.
- Impl: `apply-sparse-checkout.ts` — lock-first; partition; dirty pre-scan;
  build `Changeset`; `applyChangeset(force:true)`; assemble v3 index;
  `lock.commit`. Barrel exports for all slice-4 primitives.
- Commit: `feat(sparse): read/write/apply sparse-checkout primitives`.

---

## Slice 5 — `materializeTree` sparse predicate

**5.1.**
- Test (`materialize-tree.test.ts`, extend): with `sparse`, an excluded target
  path → a `skipWorktree:true` index entry, no file on disk; a
  skip-worktree-before / in-pattern-now path → file written; a no-sparse call
  is byte-identical to today (regression pin).
- Impl: add `sparse?: SparseMatcher` to `MaterializeTreeOpts`; when set (and
  `paths` undefined) — split target, drop skip-worktree entries from the
  diff-index, `computeChangeset(filtered, inSparse)`, append synthesised
  excluded entries, re-sort.
- Commit: `feat(materialize-tree): sparse predicate`.

---

## Slice 6 — `sparseCheckout` command

**6.1.**
- Test (`test/unit/application/commands/sparse-checkout.test.ts`): each
  action — `list` (empty when disabled; dir list in cone; raw lines in
  non-cone); `set` cone vs non-cone (file written, config set, applied);
  `set` empty patterns → `invalidOption`; `add` before enable → `invalidOption`;
  `reapply`; `disable` (re-materialises, config false, file kept);
  persistence-ordering (a failed apply leaves config/file untouched);
  `assertNotBare` / `assertNoPendingOperation`.
- Impl: `sparse-checkout.ts` — discriminated dispatch; export from
  `commands/index.ts`.
- Commit: `feat(command): sparse-checkout (list/set/add/reapply/disable)`.

---

## Slice 7 — Integration

**7.1 — `checkout`.**
- Test (`checkout.test.ts`, extend): branch switch in a sparse repo
  materialises only in-pattern files, excluded entries are skip-worktree; a
  dirty file moving out of pattern → `CHECKOUT_OVERWRITE_DIRTY`; non-sparse
  repo unchanged.
- Impl: `switchBranch` calls `loadSparseMatcher`, threads `sparse` into
  `materializeTree`.

**7.2 — `status`.**
- Test (`status.test.ts`, extend): a skip-worktree entry produces no
  `deleted`; the path stays tracked (no spurious `untracked`).
- Impl: `classifyEntry` early-returns `undefined` for `skipWorktree` entries.

**7.3 — `add --all`.**
- Test (`add-all` test, extend): `add --all` does not stage removal of a
  skip-worktree entry; the entry is preserved in the new index.
- Impl: `addAll` removal pass skips `skipWorktree` entries.
- Commit: `feat(sparse): checkout/status/add honour skip-worktree`.

---

## Slice 8 — Facade + docs

**8.1 — Facade.**
- Test (`repository` facade test, extend): `repo.sparseCheckout` bound,
  `guard()` prologue, throws `REPOSITORY_DISPOSED` after dispose.
- Impl: `repository.ts` — `Repository.sparseCheckout` + bound closure.
- Commit: `feat(repository): bind repo.sparseCheckout`.

**8.2 — Integration suite.**
- `test/integration/sparse-checkout.test.ts` — full cone lifecycle, non-cone
  lifecycle, dirty-retain, `checkout` keeps the cone, `disable` round-trip,
  `add --all` after disable. Interop: skip-worktree index read by canonical
  `git`; tsgit-written sparse file accepted by `git sparse-checkout reapply`.

**8.3 — Docs.**
- `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md`, `DESIGN.md` — sparse-checkout
  usage + the `reset`/`merge` deferral sharp edge.
- `docs/BACKLOG.md` — tick **17.3**; add **17.3a** (reset/merge sparse-awareness).
- Design doc status flips to "Implemented".
- Commit: `docs: sparse checkout usage + 17.3a follow-up`.

---

## Validation gate (before PR)

- `npm run validate` — lint, types, dead-code, dup, fs, arch, spelling, deps,
  security, size, exports, 100 % coverage, integration tests.
- `stryker run` — 0 surviving mutants on every new/changed file; provably
  equivalent mutants documented inline `// equivalent-mutant: <why>`.
- Three review passes (code / perf / security / tests) — parallel agents.

## Mutation-resistance notes (carried into every test)

- Bit-mask guards (`extended` / `skipWorktree` / `intentToAdd` /
  `chooseVersion`) — isolated per-condition tests, boundary masks.
- `coneMatcher`'s three-way `∨` — one test per disjunct.
- Dirty pre-scan `force` branch — separate force/no-force cases.
- File-size cap + 256-byte / 2048-pattern budgets — `limit` and `limit+1`.
- Error assertions: try/catch + direct `.data` field assertions, never bare
  `toThrow(ErrorClass)`.
