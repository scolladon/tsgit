# Internal building blocks

Internal building blocks that power the Tier-1 commands. Most are exported from `@scolladon/tsgit/primitives` for advanced composition (but **not** bound on `repo.primitives.*`); a few are **fully internal** — reachable only by the commands themselves — and are listed here to document how the porcelain works, not as a public surface. Each entry names the source file under `src/application/primitives/`; that file is the canonical reference for the signature.

Alphabetical.

### `applyChangeset`
`apply-changeset.ts`. Apply a computed working-tree changeset (writes, deletes, chmods). Every `add`/`update` target's entry name is validated against git's index-entry rules before anything is written — a hostile name aborts the whole apply, working tree untouched (git's own two-phase split between building the index in memory and checking it out). A write through a symlinked leading directory unlinks it and creates a real directory first, matching git; a delete through one is skipped silently, leaving the symlink untouched. Used by [`checkout`](../commands/checkout.md) and [`reset`](../commands/reset.md) (`hard`).

### `applyMergeToWorktree`
`apply-merge-to-worktree.ts`. **Fully internal.** Materialise a 3-way-merge outcome onto the working tree and index — clean outcomes are written through; conflicts get marker files (or a bare take-ours write for a symlink/gitlink pair) plus stage-1/2/3 index entries. Shares the same symlinked-leading-directory parity as `applyChangeset`: a write unlinks a symlinked leading component and creates a real directory first; a delete through one is skipped silently. The user-facing description of this shared behaviour lives on [`merge`](../commands/merge.md)'s "Conflict writes" section. Used by [`cherryPick`](../commands/cherry-pick.md), [`revert`](../commands/revert.md), [`rebase`](../commands/rebase.md), and [`stash`](../commands/stash.md) `apply`/`pop`.

### `buildIndexFromTree`
`build-index-from-tree.ts`. Project a tree to a stage-0 IndexEntry list with stat-cache donor preservation. Each leaf's entry name is validated against git's index-entry rules before it is projected — a `.git` alias (and its NTFS/HFS+ forms) or a `.gitmodules` entry staged as a symlink throws `INVALID_INDEX_ENTRY`. Used by [`reset`](../commands/reset.md) (`mixed`), [`checkout`](../commands/checkout.md).

### `buildPack`
`build-pack.ts`. Construct a packfile from an enumerated object set. Returns the pack bytes, the trailer SHA, the object count, and `entries` — `serializePackfile`'s own per-entry crc32 and offset metadata, in `input.oids` order, so a caller writing a matching `.idx` reuses the offsets and checksums the serializer already computed instead of deriving them a second time. Used by [`push`](../commands/push.md), [`packObjects`](../commands/pack-objects.md), [`bundle`](../commands/bundle.md) (`create`).

### `compareWorkingTreeDelta` · `compareWorkingTreeEntry`
`compare-working-tree-entry.ts`. Compare one index entry against its working-tree file — the per-path building block behind [`status`](../commands/status.md)'s unstaged column, [`rm`](../commands/rm.md)'s dirty guard, and every stash/merge/cherry-pick/revert/rebase working-tree comparison. `compareWorkingTreeDelta` takes an index entry directly; `compareWorkingTreeEntry` resolves it from a path first. Both accept an optional index-file mtime that arms the `ie_match_stat` stat-cache short-circuit (only `status` supplies it) and an optional shared stat map, consulted before issuing `lstat` and populated on a successful sample — also only `status`, sharing one instance with its untracked-pass walk so a tracked path is `lstat`ed at most once per invocation.

### `computeChangeset`
`compute-changeset.ts`. Tree-vs-working-tree diff for the dirty-tree guard. Used by [`checkout`](../commands/checkout.md), [`reset`](../commands/reset.md), [`status`](../commands/status.md).

### `computeClosure`
`internal/closure-engine.ts` (plus `internal/bitmap-binding.ts`, `internal/pack-bitmap-binding.ts`, `internal/midx-bitmap-binding.ts`, `internal/bitmap-container.ts`, `internal/pack-artefact-source.ts`, `internal/closure-not-marks.ts`, `internal/object-emit.ts`). **Fully internal.** The shared reachability closure [`revList`](../commands/rev-list.md) and [`packObjects`](../commands/pack-objects.md) both compose over the same `wants AND NOT not` question. The caller supplies a required `tier` (`'walk'` or `'bitmap'`) — the engine holds no default, since the two commands disagree on which to default to. `'bitmap'` prefers a usable multi-pack-index bitmap for the in-use generation, then a usable per-pack bitmap, decoding the EWAH streams and trusting them exactly as git trusts them — no digest check on this read path; verification stays in [`fsck`](../commands/fsck.md). Any fault along that path — none present, unreadable, structurally refused, or a decoded position out of range for the artefact it indexes — falls back to the walk silently: no error, no signal that the fallback happened. Object `path` is a walk-only product: a bitmap encodes reachability and each object's type, never a name, so `path` is always absent on the bitmap tier regardless of `objects`.

### `createPackRegistry`
`pack-registry.ts` (plus the internal `midx-source.ts`, `midx-binding.ts` and `pack-shared.ts`). Fully internal. Two independent memos, not one shared scan. A module-level store gate (`createStoreGate`) loads `objects/pack/multi-pack-index` (flat, else the `multi-pack-index.d/` chain) on its own — this is the memo `assertLoadable()` awaits ahead of **every** read, loose objects included, because canonical git dies during object-store setup on exactly one thing (a structurally self-inconsistent multi-pack-index) and this gate reproduces that death before any loose-vs-pack branch is reached. The directory listing and pack construction sit behind a second, separate memo, forced only by `lookup()`, `all()`, `health()`, `indexFaults()`, `midxHealth()`, and `midxBitmap()` — never by a loose-only read. Two consumer-visible behaviours follow from the split: a pack directory whose listing is refused (permission denied, say) no longer denies a loose read, only a pack-forcing call; and a pack directory that is a regular file — `ENOTDIR` — folds to an empty pack listing the same way a missing directory does, so it no longer denies a loose read either (git itself serves a loose read at exit 0 in this case, printing its own warning). The `packRegistry: skipping pack index with no pack file` warn lives inside the pack-listing memo, so it no longer fires on a loose hit — it still fires on any read that forces the pack store. The `packRegistry: discarding unusable multi-pack-index` warn lives inside the store gate itself, so it **does** still fire on a loose hit whenever the midx is unusable. When a midx loads, it is treated as **authoritative** for the packs it names: a pack the midx claims that is gone or unusable makes its objects report missing even though a sibling pack in the same midx still holds them, exactly like git; a pack the midx does not name is served by the ordinary per-pack scan as before. A `.idx` missing its sibling `.pack` is excluded from the generation at scan time (one warn, no I/O — the listing is already in hand); a `.idx` that is corrupt or unreadable is now classified lazily, the first time something touches that pack (a lookup, or a forced `health()`/`all()` walk), rather than eagerly for every pack at scan time. A pack whose index claims a requested object gets a memoised 12-byte header probe at lookup — signature, version (2 or 3), header-vs-index object count — and is skipped per pack if unusable (its objects report missing, other packs and loose objects still serve, no negative cache), mirroring git's open-time validation. Midx corruption follows git's own two tiers: a structurally self-inconsistent midx or chain layer denies every read through the `Context` — loose objects included — until the on-disk state changes; a merely-unusable one (too small, unreadable, an offset outside the file, a hash-version mismatch) is discarded with one warn and every read falls back to the `.idx` scan. [`fsck`](../commands/fsck.md) audits the same registry through a cache-bypassing `Context` view (the session delta cache is cleared, never a second registry) so an integrity check never gets an answer the cache masked for an object a fresh decode would refuse. `refresh()` clears both memos together — the store gate and the pack-listing scan — then retires and closes the outgoing pack set, so the next read re-probes the midx and the next `all()`/`lookup()` re-lists the pack directory; `dispose()` awaits any in-flight scan, closes every handle it ever opened, and is terminal; a `Context` that only ever hit loose objects never forced the pack-listing memo, so it disposes without ever listing the pack directory. One registry per `Context`, behind every packed-object read ([`readObject`](read-object.md), [`readBlob`](read-blob.md), [`streamBlob`](stream-blob.md)) and `fsck`'s enumeration. The offset table (`buildOffsetTable`, behind `nextOffsetForEntry`'s successor lookup on every packed-object read) consults a pack's own `.rev` only once that pack carries at least `REV_INDEX_MIN_OBJECTS` objects, the measured point from which the O(n) gather outruns sorting the offsets directly; below it the artefact is never opened at all, because the cost of opening one is essentially fixed per pack and a repository between `git gc` runs would otherwise pay it once per pack for no gain. When it does load, the body is trusted exactly as git trusts it — no digest check on this path. Every other artefact state (absent, unreadable, structurally refused, or a decoded position out of range for the pack it indexes) falls back silently to sorting the offsets, comparator-free over a `Float64Array` — the same job canonical git does with a radix sort. The registry also exposes `midxBitmap()`, the accessor `computeClosure`'s bitmap tier consumes for the midx-bitmap preference; the per-pack bitmap fallback loads directly off the packs `all()` already lists.

### `enumerateObjects`
`enumerate-objects.ts`. Enumerate every object id in the database (loose ∪ pack-index), sorted and de-duplicated. Takes an optional `accessiblePacksOnly` flag (default `false`) that restricts the pack half to packs whose header gate passes — [`fsck`](../commands/fsck.md)'s own universe knob, not a general filter; the default preserves cat-file-like enumeration, since every other surface (git's `cat-file --batch-all-objects`, `count-objects`) still lists a refused pack's ids. Used by `fsck`.

### `enumeratePushObjects`
`enumerate-push-objects.ts`. Diff local vs remote heads to compute the push-pack object set. Used by [`push`](../commands/push.md).

### `enumerateRefs`
`enumerate-refs.ts`. List every ref (loose + packed). Used by [`branch`](../commands/branch.md), [`tag`](../commands/tag.md), [`fetch`](../commands/fetch.md).

### `fetchPack`
`fetch-pack.ts`. Smart-HTTP `git-upload-pack` exchange — discover refs, send `want`/`have`, receive pack. Used by [`clone`](../commands/clone.md), [`fetch`](../commands/fetch.md), [`fetchMissing`](../commands/fetch-missing.md).

### `getSpawnCwd`
`path-layout.ts`. Working directory for a spawned child process (hook, signer, textconv, merge/filter driver): the work tree when the repository has one, else the gitDir — git's own bare hooks run with `PWD=<bare.git>`. Same value as [`getRepoRoot`](get-repo-root.md), distinct in intent: names the spawn contract so call sites stop restating its why-comment. Used by [`runHook`](run-hook.md), `signPayload`, `applyTextconv`, `runFilterDriver`, `runMergeDriver`.

### `invalidateConfigCache`
`config-read.ts`. Drop the in-memory `.git/config` cache. Use after an out-of-band edit.

### `isWorkingTreeDirty`
`apply-changeset.ts`. Predicate over a computed changeset. Used by [`checkout`](../commands/checkout.md)'s dirty-tree guard.

### `loadSparseMatcher`
`read-sparse-checkout.ts`. Compile `.git/info/sparse-checkout` to a `(path) => boolean` matcher. Used by [`sparseCheckout`](../commands/sparse-checkout.md), [`checkout`](../commands/checkout.md), [`reset`](../commands/reset.md).

### `longestStrictAncestor`
`src/repository/ceiling-stop.ts` (outside `application/primitives/` — layout resolution's own tier). **Fully internal.** The longest `ceilingDirs` entry that is a STRICT ancestor of the resolved cwd — the argument-array equivalent of `GIT_CEILING_DIRECTORIES`. Computed once, before the discovery walk starts, never per level. Because ancestry is strict, a ceiling equal to cwd (or equal to cwd *and* the resolved repo root) is a no-op rather than a refusal — the walk's first iteration always examines cwd. Entries are expected already resolved into the same coordinate system as cwd (the node shim realpaths both; sandboxed adapters compare lexically). Used by [`resolveLayout`](#resolvelayout).

### `materializeTree`
`materialize-tree.ts`. Apply a tree to the working tree (writes, deletes, chmods, symlinks). Used by [`checkout`](../commands/checkout.md), [`reset`](../commands/reset.md) (`hard`), [`merge`](../commands/merge.md) clean path.

### `readConfig`
`config-read.ts`. Read `.git/config` (INI tokenizer; reused by `.gitmodules` parsing in submodules). A layout the ownership-trust gate refuses (`untrusted` or `implicitBare`) short-circuits before the file is opened — every consumer of the cached entry observes the same empty scope the acceptance tier is about to refuse on, rather than racing a malformed value in the attacker's file. A layout the sibling format gate refuses is **not** guarded here: the format verdict is itself derived from this same read, so by the time any caller reaches `readConfig` on a format-rejected repository, `assertAcceptedRepository` has already thrown.

### `listWorktrees`
`list-worktrees.ts`. **Fully internal.** Enumerate the main worktree plus every linked worktree registered under `<commonDir>/worktrees/<id>/`, sorted by path. A linked entry's `gitdir` pointer is resolved once against its admin directory before use — both as the reported `path` and as the argument to the worktree-scoped `exists` probe that decides `prunable` — so a relative pointer (`extensions.relativeWorktrees`) reads correctly instead of escaping the worktree-scoped filesystem as an unresolved relative `FilePath`. Used by [`worktree`](../commands/worktree.md).

### `recordRefUpdate`
`record-ref-update.ts`. **Fully internal.** The single reflog *writer*: reads config, applies the autocreate gate, resolves identity, sanitises the message, appends one entry. It moves no ref — [`updateRef`](update-ref.md) is the coherent public surface that writes the ref *and* records the matching reflog atomically. Used internally by [`clone`](../commands/clone.md), [`checkout`](../commands/checkout.md), [`commit`](../commands/commit.md), [`rebase`](../commands/rebase.md), and `updateRef`.

### `writeSymbolicRef`
`write-symbolic-ref.ts`. **Fully internal.** Write a `ref: <target>` symbolic ref (HEAD and friends) atomically, validating both names. Used internally by [`init`](../commands/init.md), [`checkout`](../commands/checkout.md), [`branch`](../commands/branch.md), [`rebase`](../commands/rebase.md) to set or move HEAD's symbolic pointer.

### `appendReflog`
`reflog-store.ts`. Append one entry to `.git/logs/<ref>`. Called via `recordRefUpdate`.

### `deleteReflog`
`reflog-store.ts`. Drop one entry by index, optionally rewriting subsequent entries.

### `listReflogs`
`reflog-store.ts`. Enumerate refs that have a reflog.

### `readReflog`
`reflog-store.ts`. Read entries for one ref.

### `readRepositoryFormat`
`src/repository/read-repository-format.ts` (outside `application/primitives/` — layout resolution's own tier). **Fully internal.** Reads `core.bare` / `core.worktree` / `extensions.*` from `<commonDir>/config` — plus `<gitDir>/config.worktree` when `extensions.worktreeConfig` is on — through the same `LayoutProbe` the discovery walk uses; no `include.path`, no global/system scope. Runs *before* a `Context` exists, so `resolveLayout` can decide the work tree ahead of the first command. A malformed `core.bare` reports `'malformed'`; a valueless `core.worktree` reports `null` — the caller maps each to `CONFIG_BAD_BOOLEAN_VALUE` / `CONFIG_MISSING_VALUE`. The same pass also computes the repository-format acceptance verdict — `core.repositoryformatversion > 1`, or an `extensions.*` name git does not know at version 1 (or treats as v1-only at version 0) — and returns it as a carried `RepositoryFormatRefusal` rather than throwing; `resolveLayout` freezes it onto `RepositoryLayout.formatRefusal` for the command tier to read synchronously. One condition IS thrown here rather than carried: a top-level unbacked-extension entry (`compatObjectFormat`, `refStorage`) on a version-1 repository the verdict just accepted — tsgit cannot yet act on those extensions, so `REPOSITORY_EXTENSION_UNSUPPORTED` fires immediately, ahead of every config-porcelain read including `config --list`. Also resolved here: `extensions.refStorage` (`'files'` / `'reftable'`, defaulting to `'files'`), the same grammar shape and version-gating as `objectFormat` below — `resolveLayout` freezes it onto `RepositoryLayout.refStorage`, readable synchronously and consumed by ref-storage backend selection. Skipped entirely (an `EMPTY_FORMAT` substituted) when the layout resolution's trust gate has already rejected the repository — see [`resolveLayout`](#resolvelayout). Used by [`resolveLayout`](#resolvelayout).

### `readShallow`
`shallow-file.ts`. Read `.git/shallow` boundaries. Parses git's strict grammar at the repository's oid width; throws `SHALLOW_FILE_MALFORMED` on malformed content or more than 500 000 entries.

### `readSparsePatternText`
`read-sparse-checkout.ts`. Read raw `.git/info/sparse-checkout` text (no compilation).

### `reflogExists`
`reflog-store.ts`. Predicate over `.git/logs/<ref>`.

### `resolveLayout`
`src/repository/resolve-layout.ts` (outside `application/primitives/` — layout resolution's own tier). **Fully internal.** The one layout-resolution algorithm every runtime shim shares: locates the gitDir structurally (an explicit `opts.gitDir`, or the discovery walk — which now also recognises `cwd` itself as a git directory, bare or not); on a discovery/bare route (never on the explicit-`gitDir` route, which this gate always skips) evaluates the ownership-trust verdict and the `bareRepositories: 'explicit'` implicit-bare predicate — both computed from the walk outcome and caller arguments alone, no file read; only when accepted does it read the repository-format keys via [`readRepositoryFormat`](#readrepositoryformat) — a rejected repository substitutes an empty format (`core.bare`/`core.worktree`/`extensions.*` all absent) rather than reading a file the caller was told not to trust; then decides the work tree by git's own precedence (`opts.workDir` beats `core.bare` beats `core.worktree` beats the route's own default) and derives `bare` as `core.bare is not false AND no work tree was resolved`. Returns the shape each shim (`index.node.ts`, `index.default.ts`, the browser's `resolveFixedEntryLayout`) finishes into a `RepositoryLayoutInput`, carrying `untrusted` / `implicitBare` / `foreignPath` / `formatRefusal` / `refStorage` alongside it. `refStorage` is REQUIRED (unlike the other optional fields here): every `Context` constructor — including the raw adapter factories, which never run this Stage-2 scan at all — must set it explicitly, defaulting to `'files'` by assignment rather than by omission.

### `resolveReflogIdentity`
`reflog-identity.ts`. Resolve the identity for reflog entries (config + portable fallback).

### `writeReflog`
`reflog-store.ts`. Bulk write entries for one ref (used by `expire`).

### `setConfigEntry` · `setCoreConfigEntry` · `updateConfigEntries` · `updateCoreConfig`
`update-config.ts`. Targeted line-surgery writers for `.git/config`. Used by [`clone`](../commands/clone.md) (promisor + partial-clone config), [`sparseCheckout`](../commands/sparse-checkout.md).

### `sparseCheckoutPath`
`path-layout.ts`. Canonical path for `.git/info/sparse-checkout`.

### `synthesizeTreeFromIndex`
`synthesize-tree-from-index.ts`. Inverse of `buildIndexFromTree` — synthesize a tree from staged entries. Each entry's name is re-validated against git's index-entry rules before being written to the tree — now mode-aware, so a `.gitmodules` entry staged as a symlink is refused here too (previously only caught at the index-write boundary). Used by [`checkout`](../commands/checkout.md) (`{ paths, source: 'index' }`).

### `updateShallow`
`shallow-file.ts`. Write `.git/shallow` boundaries. Refuses (`SHALLOW_FILE_MALFORMED`) before writing when the resulting set would exceed the entry cap or an added oid's width doesn't match the repository hash.

### `writePackArtifacts`
`internal/write-pack-artifacts.ts`. **Fully internal.** Writes a pack's sibling artefacts in git's own order: `.pack`, `.idx`, an optional `.promisor` sentinel, then `.rev` last — `.rev` last because pack discovery keys on the `.pack`/`.idx` pair, so a concurrent reader that observes the pair before the `.rev` lands just takes the absent-artefact arm. The `.rev` write is gated by `pack.writeReverseIndex` (default `true`), resolved *before* any file is created, so a value git's boolean grammar refuses leaves the pack directory untouched. `buildIdx`/`buildRev` (same file) assemble each artefact's bytes — a body/trailer split where `ctx.hash` fills the trailer in place. Used by `fetchPack`, [`packObjects`](../commands/pack-objects.md).

### `writeSparsePatternText`
`write-sparse-checkout.ts`. Write raw `.git/info/sparse-checkout` text.
