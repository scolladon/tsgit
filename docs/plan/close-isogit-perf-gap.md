# Plan — close the isomorphic-git performance gap + sfdx-git-delta backend spike findings

> Source: design doc `docs/design/close-isogit-perf-gap.md` · ADRs `509`–`516`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part is one atomic conventional commit's worth of red→green→refactor TDD
  (tests + implementation together). Parts are ordered by dependency and share ONE
  sequential working tree — a later part sees every earlier part's edits.
- The 12 fixes map to 11 feature parts + 1 test-infra-only bench part (12 total): `B3`
  and `B6` collapse into one part (ADR-515 defines B6 as "bind + document `flattenTree`",
  which is B3's binding); `A4` and `B8` are one part (ADR-510 joint decision); `B7` splits
  into a domain-parser part and a reader/integration part (each an atomic commit's worth,
  dependency-ordered).
- No standalone test-only parts for FEATURE code. Property/interop/regression tests fold
  into the part whose code they exercise. Part 12 is the one sanctioned standalone: it is
  test-infra-only (bench fixtures + scenarios, NO `src/` delta) and closes req 13's
  nightly-measurement requirement for the Track-B wins.

## Gate convention

- **Part gate** (run at the end of every part before its commit):
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`.
- **Phase gate** `npm run validate` runs ONCE at phase end, not per part. `reports/api.json`
  staleness and `check:doc-coverage` are `prepush` gates — parts that add public surface
  (B2, B3, A3) regenerate/refresh them in-part (steps below) so the push hook stays green.
- State-mutating faithfulness probes (real `git`) run in `mktemp -d` throwaways with
  `GIT_*` scrubbed and signing off — never in the worktree. Interop tests spawn git via
  `runGitAsync` from `test/integration/interop-helpers.ts` (NEVER sync — it deadlocks the
  in-process server tests), share a `beforeAll` repo, and use 60s timeouts.

## Ordering (dependency-first)

`B1 → A1 → A2 → A3 → A4/B8 → B2 → B3/B6 → B4 → B5 → B7-parser → B7-reader → bench`.
Rationale: B1's empty-tree intercept and A1's cache probe and A2's loose-oid cache all
edit the head of `resolveObject`, top-to-bottom in that order; A2's loose-oid cache must
land before the B7 reader (B7b consumes it); B7-parser (domain decoder) precedes the
B7-reader that consumes it; the bench part is last (it benches the landed Track-B code).
A3, A4/B8, B2, B3/B6, B4, B5 are mutually independent.

---

## Part 1 — B1: serve the empty tree as a virtual object

### Context

Fix **B1** (Pin B). Git treats the empty **tree** (`4b825dc6…`, SHA-256
`6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321`) as a virtual,
always-present object anywhere a tree-ish is valid — `cat-file -t/-s/-p` and
`diff <empty-tree> HEAD` all succeed with exit 0 on a repo that never wrote it. The
empty **blob** (`e69de29b…`) is NOT virtual — it errors like any missing object. Scope is
ONLY the empty tree of the active hash algo — not a general "size 0" rule, not the blob.

Files / symbols:
- `src/application/primitives/object-resolver.ts` → `resolveObject` (L28–52). Insert the
  intercept as the FIRST step, right after `checkAborted(ctx)` (L35), **above** everything
  else (this is the deepest choke point — covers `readObject`, `readTree`, `catFile`,
  `walkTree`, `archive`, `diff`, and empty-tree-as-delta-base). Parts 2 (A1) and 3 (A2)
  will insert below this intercept.
- `src/domain/objects/object-id.ts` → currently exports `EMPTY_TREE_OID` (SHA-1 only,
  L32; used by `merge`). Its VALUE is NOT re-exported at runtime by `public-types.ts` (only
  the type flows via `export type *`).
- **Public-surface decision — all new symbols INTERNAL.** To avoid any typedoc/api.json
  shift on the `domain/objects` barrel, keep the new symbols as module-LOCALS in
  `object-resolver.ts` (not exported, not added to the barrel): `EMPTY_TREE_OID_SHA256`
  (the SHA-256 empty-tree oid constant), `EMPTY_TREE_BYTES`, and
  `emptyTreeOid(hash: HashConfig): ObjectId` (selects SHA-1 vs SHA-256 by `digestLength`,
  importing the existing `EMPTY_TREE_OID` from `object-id.ts` and `HashConfig` from
  `domain/objects/hash-config.js`, `digestLength: 20 | 32`). No surface gates, no api.json.
- `src/domain/objects/git-object.ts` → `parseObject(id, rawBytes, hash)` (L16) — the
  intercept returns `parseObject(id, EMPTY_TREE_BYTES, ctx.hashConfig)`.

Pinned bytes: `EMPTY_TREE_BYTES` = the loose-format content `tree 0\0` (7 bytes:
`0x74 0x72 0x65 0x65 0x20 0x30 0x00`), zero content bytes. `parseObject` of these yields a
`Tree` with `entries: []`. Faithfulness: `verifyHash` holds trivially (the oid *is* the
empty-tree hash); a size cap never trips (size 0); the intercept short-circuits before
`OBJECT_NOT_FOUND`, so the promisor lazy-fetch (in `read-object.ts`) never fires for the
empty tree (git never fetches it).

Test files to extend: `test/unit/application/primitives/object-resolver.test.ts`;
new interop `test/integration/empty-tree-diff-interop.test.ts` (use `runGitAsync`,
`runGitEnv`, `makePeerPair`/`mktemp` from `interop-helpers.ts`).

### TDD steps

- RED (unit): `resolveObject(ctx, registry, EMPTY_TREE_OID, true, undefined)` on a repo that
  never wrote the empty tree → expected fail today with `OBJECT_NOT_FOUND` (`.data.code`).
  Assert it returns `{ type: 'tree', id: EMPTY_TREE_OID, entries: [] }`.
- RED (unit, isolated guard): the empty **blob** oid `e69de29b…` still throws
  `OBJECT_NOT_FOUND` — assert `.data.code === 'OBJECT_NOT_FOUND'` and the missing oid in
  `.data` (proves the intercept is tree-only, not size-0).
- RED (unit): SHA-256 path — with a `hashConfig` of `SHA256_CONFIG`
  (`digestLength: 32`), `resolveObject(EMPTY_TREE_OID_SHA256)` returns a zero-entry tree;
  the SHA-1 empty-tree oid under a SHA-256 config is NOT intercepted (falls through).
- RED (interop): build a repo, `git add`+`commit` one file (`runGitAsync`), then assert
  tsgit `diff({ from: EMPTY_TREE_OID })` equals reconstructing `git diff <empty-tree> HEAD`
  from the structured `TreeDiff` (one `add` per HEAD path). `git hash-object -t tree
  /dev/null` confirms the oid in the fixture.
- GREEN: add the module-local `EMPTY_TREE_OID_SHA256`, `emptyTreeOid(hash)`, and
  `EMPTY_TREE_BYTES` to `object-resolver.ts`; add `if (id === emptyTreeOid(ctx.hashConfig))
  return parseObject(id, EMPTY_TREE_BYTES, ctx.hashConfig);` as the first line of
  `resolveObject` after `checkAborted`.
- REFACTOR: confirm no mutation-surviving dead guard (the blob-still-throws test isolates
  the tree-only branch); assert error `.data`, not just class.

### Gate

`npx vitest run test/unit/application/primitives/object-resolver.test.ts test/integration/empty-tree-diff-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts test/unit/application/primitives/object-resolver.test.ts test/integration/empty-tree-diff-interop.test.ts`

### Commit

`feat(object-resolver): serve the empty tree as a virtual object`

---

## Part 2 — A1: serve warm delta-chain reads from the object cache

### Context

Fix **A1** (req 1). `resolvePackChain` (`object-resolver.ts` L260–291) caches the
reconstructed target under `targetId` (L288–289 `cacheEntry(ctx.deltaCache, targetId,
fullBytes)`), but the ONLY reader is `resolveBaseForRefDelta` (L367) — never reached on a
repacked OFS repo. So the cache is **write-only**: every warm read of the same target
replays the whole chain. Add a cache probe as the first step of `resolveObject`, composing
the two helpers that already exist for exactly this.

Files / symbols (`src/application/primitives/object-resolver.ts`):
- `resolveObject` (L28–52). Insert the probe AFTER Part 1's empty-tree intercept and
  BEFORE `tryLoose` (current L36):
  ```ts
  const cached = ctx.deltaCache.get(id);
  if (cached !== undefined) {
    enforceCachedCap(id, cached, maxBytes);   // existing, L77
    return finalize(ctx, id, cached, verifyHash); // existing, L169
  }
  ```
- `enforceCachedCap(id, cached, maxBytes)` (L77–90) — already measures
  `cached.length - (nulIdx + 1)` against the cap and raises `OBJECT_TOO_LARGE`.
- `finalize(ctx, id, bytes, verifyHash)` (L169–183) — already honours `verifyHash`
  (raises `OBJECT_HASH_MISMATCH` via `objectHashMismatch(id, actual)`) + `parseObject`.
- `ctx.deltaCache` is the existing 16 MiB `LruCache<Uint8Array>` (`ports/context.ts` L116;
  created once per repo in `index.node.ts` L80). Keyed by `ObjectId`. Object content is
  oid-determined, so cached bytes are byte-identical to a loose/pack read — A1 is NOT a
  precedence question (distinct from A2). Reads only, no new entries; the LRU bound is
  unchanged.

Test file: `test/unit/application/primitives/object-resolver.test.ts` (extend). Spy the
pack `readSlice`/registry `lookup` to prove no re-walk on the second read.

### TDD steps

- RED: build an OFS-delta pack fixture, resolve a packed target once (populates cache),
  then spy `registry.lookup` / the pack's slice read and call `resolveObject(id)` again →
  today it re-walks (spy called). Assert the second call returns byte-identical bytes with
  ZERO pack touches.
- RED (isolated): a poisoned `deltaCache` entry (wrong bytes for `id`) with
  `verifyHash: true` → `resolveObject` throws `OBJECT_HASH_MISMATCH`; assert
  `.data` carries the mismatched actual oid (not just the class).
- RED (isolated): a cached entry larger than `maxBytes` → `OBJECT_TOO_LARGE`; assert
  `.data` size/limit.
- RED: cold miss (empty cache) still resolves via loose→pack unchanged.
- GREEN: add the probe.
- REFACTOR: each guard (hash-mismatch, too-large, miss) has its own isolated test so no
  mutant survives on a shared assertion.

### Gate

`npx vitest run test/unit/application/primitives/object-resolver.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts test/unit/application/primitives/object-resolver.test.ts`

### Commit

`perf(object-resolver): serve warm delta-chain reads from the object cache`

---

## Part 3 — A2/B7b: amortise the loose-object probe with a per-fanout-dir cache

### Context

Fix **A2/B7b** (req 2, ADR-509). Keep loose-first precedence exactly (Pin A: git consults
loose and surfaces its inflate error even when a valid pack copy exists — a pack-first
reorder was **rejected**). Replace the per-object `ctx.fs.exists(loosePath)` probe (an
uncached `realpath`-follow + internally-thrown ENOENT — 14 % of log-walk samples) with an
in-memory sorted-oid membership test built lazily once per fanout dir (`objects/xx`, ≤256)
by a single `readdir`. B7b (the commit walk's object-store probe) is the same probe on the
same path — one implementation; the walk in Part 11 consumes this cache transparently
(commit reads funnel through `resolveObject`).

Files / symbols:
- `src/application/primitives/object-resolver.ts` → `tryLoose` (L148–153) and
  `looseCompressedBytes` (L160–167) both do `looseObjectPath(commonGitDir(ctx), id)` then
  `ctx.fs.exists(path)`. Replace the `exists` probe in BOTH with a membership test against
  the new cache; a hit still reads via `ctx.fs.read(path)` (so the containment gate,
  corrupt-loose inflate-error surfacing, and escaping-symlink handling stay byte-for-byte
  unchanged — Pin A holds); a miss returns `undefined` WITHOUT any fs call.
- **Public-surface decision — INTERNAL.** The cache helper + its WeakMap live at the
  application-internal tier; nothing is exported from `public-types.ts` or bound on
  `repo.primitives`. No surface gates.
- **Invalidation mechanism.** ADR-509 frames invalidation as "reuses the ADR-150 generation
  counter", but that counter (the snapshot-factory generation view, `repository.ts`
  L321–325) is permanently 0 today (Wave 2 not landed) and is not reachable from the object
  read path. Use instead a LOCAL per-prefix invalidation: `writeObject` drops the cached
  fanout-dir set for the written oid's prefix (this achieves the generation-invalidation
  intent — coherence with loose writes — without wiring the dead counter). tsgit does not
  prune loose objects (`gc`/repack is out of scope), so write is the only invalidation point.
- New helper `src/application/primitives/internal/loose-oid-cache.ts`:
  `probeLooseOid(ctx, id): Promise<boolean>` — resolves the fanout dir
  `objectsDir(commonGitDir(ctx), id.slice(0,2))` (`path-layout.ts` L43 `objectsDir`), lazily
  `ctx.fs.readdir` it once (ENOENT / non-dir → empty set), stores the 38-hex suffixes in a
  `Set<string>` keyed by prefix in a module-level `WeakMap<Context, Map<string, Set<string>>>`
  (mirror the `registryCache` WeakMap pattern in `read-object.ts` L14), and returns
  `set.has(id.slice(2))`; and `invalidateLooseOid(ctx, id)` — drops the cached set for
  `id`'s prefix so the next probe re-reads the dir.
- `src/application/primitives/write-object.ts` → `writeObject` (L21). After a successful
  `ctx.fs.writeExclusive(path, compressed)` (L45) AND on the `FILE_EXISTS` early-return
  (L48, already-present object), call `invalidateLooseOid(ctx, computed)` so a freshly
  written loose object is visible to the next probe (ADR-509 generation-invalidation
  intent: bump on loose write).
- `commonGitDir` (`path-layout.ts` L24), `looseObjectPath` (L34), `computeLooseObjectPath`
  (`domain/storage/loose-path.ts`) — the prefix is `id.slice(0,2)`, the suffix `id.slice(2)`.

Faithfulness pin (Pin A, interop): a repo where an object exists loose-corrupt AND
pack-valid (`hash-object -w` loose, `pack-objects` without `-d`, then overwrite the loose
file with non-zlib garbage). `git cat-file -p <oid>` → serves the pack copy on stdout,
exit 0, but stderr `error: inflate: data stream error (incorrect header check)`. tsgit MUST
surface the loose inflate error identically (loose-first preserved) — the membership hit
still routes through `ctx.fs.read` + `ctx.compressor.inflate`, so the error path is intact.

Test files: `test/unit/application/primitives/object-resolver.test.ts` (+ a new
`test/unit/application/primitives/loose-oid-cache.test.ts` for the helper); interop
`test/integration/loose-corrupt-precedence-interop.test.ts`.

### TDD steps

- RED (unit): a packed-repo walk touching N objects across a fanout dir performs at most
  ONE `readdir` per touched dir and ZERO per-object `exists`/`realpath` probes — spy
  `ctx.fs.readdir`/`ctx.fs.exists` and assert counts.
- RED (unit, isolated): membership hit reads via `ctx.fs.read`; membership miss returns
  `undefined` with no `ctx.fs.read`/`ctx.fs.exists` call.
- RED (unit, isolated): after `writeObject`, the next `probeLooseOid` sees the new oid
  (invalidation fires); without invalidation the stale set would miss it.
- RED (unit, isolated): fanout dir absent (ENOENT on `readdir`) → empty set, miss, no throw.
- RED (interop): the corrupt-loose + valid-pack repo → tsgit surfaces the inflate error
  like git (assert the error `.data`/type), NOT a silent pack serve. Scrub `GIT_*`, sign
  off, `runGitAsync`.
- GREEN: add `loose-oid-cache.ts`, rewire `tryLoose` + `looseCompressedBytes`, add the
  `write-object.ts` invalidation.
- REFACTOR: each guard (hit/miss/ENOENT/invalidate) isolated; assert error `.data`.

### Gate

`npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/loose-oid-cache.test.ts test/integration/loose-corrupt-precedence-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/primitives/internal/loose-oid-cache.ts src/application/primitives/write-object.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/loose-oid-cache.test.ts test/integration/loose-corrupt-precedence-interop.test.ts`

### Commit

`perf(object-resolver): amortise the loose-object probe with a per-fanout-dir cache`

---

## Part 4 — A3: skip read+hash for stat-clean tracked files

### Context

Fix **A3** (req 3, ADR-511, Pin C). `compareWorkingTreeDelta` always `lstat`s then — for a
regular file — reads + SHA-1-hashes the whole working file; there is no stat-cache
short-circuit. Insert an `ie_match_stat`-faithful fast path after the `lstat` and the
`type-changed` guard, before read+hash.

Files / symbols:
- `src/application/primitives/compare-working-tree-entry.ts` → `compareWorkingTreeDelta`
  (L78–116). After the `type-changed` guard (L93–95) and before the `try` read+hash
  (L96), insert:
  ```ts
  if (indexMtime !== undefined && isEntryStatClean(entry, stat, indexMtime))
    return { status: worktreeMode === entry.mode ? 'unchanged' : 'mode-changed', worktreeMode };
  ```
  Add an OPTIONAL 4th positional param `indexMtime?: { seconds: number; nanoseconds: number }`
  (absent ⇒ short-circuit disabled ⇒ every non-`status` ADR-209 consumer — `rm`, `stash`,
  clean-work-tree, apply-merge — behaves exactly as today). `compareWorkingTreeEntry`
  (L123) does NOT gain the arg.
- New app-tier helper `src/application/primitives/internal/is-entry-stat-clean.ts` →
  `isEntryStatClean(entry: IndexEntry, stat: FileStat, indexMtime): boolean`. MUST live at
  the application tier (it consumes the port type `FileStat` from `ports/file-system.ts`;
  the domain must not import ports — do NOT reuse the domain `isStatClean(entry, StatData)`
  in `domain/git-index/index-entry.ts` L70, which is a different signature and stays as-is).
  Encode Pin C field-by-field:
  - **assume-valid** (`entry.flags.assumeValid`) ⇒ clean regardless of stat (`CE_VALID`).
  - **racy guard:** entry mtime `>=` `indexMtime` (compare `mtimeSeconds`, and
    `mtimeNanoseconds` when both sides have ns) ⇒ NOT clean (fall through to read+hash).
    Without this, a same-second same-size edit is missed (correctness bug, Pin C row 1).
  - **content-stat comparison** (non-assume-valid, non-racy): mtime (sec + ns when
    available), ctime (`ctimeSeconds`/`ctimeNanoseconds` vs `Math.floor(stat.ctimeMs/1000)`
    + `stat.ctimeNs`), uid, gid, ino, size. **dev NOT compared** (git default `USE_STDEV`
    off). ino/size compared **32-bit-truncated** (`x >>> 0`). Any mismatch ⇒ NOT clean.
  - ns availability: `FileStat.ctimeNs`/`mtimeNs` are optional `bigint`
    (`ports/file-system.ts` L14–17); compare ns only when present, mirroring
    `CachingIndexResolver.needsRacyCheck`. Derive entry-side seconds from
    `entry.mtimeSeconds`, ns from `entry.mtimeNanoseconds`.
  - **mode is NOT a field** — the caller's ternary decides `unchanged` vs `mode-changed`;
    a pure exec-bit change never re-hashes.
- `skip-worktree`: handled at the caller — `scanWorkingTree` (`commands/status.ts` L168–183)
  already skips `entry.flags.skipWorktree` (L177), so the comparator never runs on them.
- **Sub-change 1 — plumb the index mtime (ADR-511).** `src/application/primitives/read-index.ts`
  → `readIndex` (L12) already `ctx.fs.stat`s `.git/index` (L18) for the size pre-check and
  discards the mtime. Surface it: return the parsed `GitIndex` augmented with an optional
  `indexMtime?: { seconds; nanoseconds }` (mirror the existing transient-metadata precedent
  `trailerSha` on `GitIndex`, `domain/git-index/index-entry.ts` L45–54). Add the optional
  field to the `GitIndex` interface; populate it in `readIndex` from the stat
  (`Math.floor(stat.mtimeMs/1000)` + ns from `stat.mtimeNs`); leave it undefined on the
  empty-index early return (L15, unborn repo ⇒ fast path stays off). `parseIndex` (domain,
  pure) stays unchanged — `readIndex` composes `{ ...parseIndex(bytes), indexMtime }`.
  - **Public-surface decision — the new `GitIndex.indexMtime?` field is PUBLIC** (`GitIndex`
    reaches `public-types.ts` L34 via `export type * from domain/git-index`). Surface gates
    to pre-pay in-part: (1) regenerate `reports/api.json` via `npm run docs:json` and commit
    it (prepush `check:doc-typedoc`); (2) if `test/unit/public-types.test.ts` asserts the
    `GitIndex` member set, extend it. `repo.primitives.readIndex` return type widens
    compatibly (optional field ⇒ no primitives-snapshot change). The new app-internal
    `isEntryStatClean` and the comparator's 4th arg are INTERNAL — no gates.
- `src/application/commands/status.ts` → `status` (L122) reads `index.indexMtime` from the
  `readIndex(ctx)` result (L131) and threads it through `scanWorkingTree` (L168) into
  `compareWorkingTreeDelta` as the new 4th arg (only `status` opts in).
- **Sub-change 2 — populate ns in `indexEntryFromStat`.** `src/application/primitives/internal/index-entry-from-stat.ts`
  (L12) writes `ctimeNanoseconds: 0` / `mtimeNanoseconds: 0`. Derive ns from
  `stat.ctimeNs` / `stat.mtimeNs` when available (`Number(stat.mtimeNs % 1_000_000_000n)`),
  else 0. This is more git-faithful (git writes real nsec) but **changes serialized index
  bytes** → index-write goldens must be re-pinned against git in THIS part (a stale golden
  reds the gate). Goldens live in `test/integration/index-interop.test.ts` and
  `test/integration/add-interop.test.ts` — re-pin by comparing a tsgit-`add`-written index
  to a `git add`-written index for the same file (both read the file's own ctime/mtime, so
  ns now matches subject to fs precision). `add` and `submodule add` share this helper.

Test files: `test/unit/application/primitives/compare-working-tree-entry.test.ts`, new
`test/unit/application/primitives/internal/is-entry-stat-clean.test.ts` +
`is-entry-stat-clean.properties.test.ts`, `test/unit/application/primitives/read-index.test.ts`,
interop `test/integration/status-racy-clean-interop.test.ts`, `index-interop.test.ts`,
`add-interop.test.ts`.

### TDD steps

- RED (unit table over `isEntryStatClean`, each an ISOLATED case per the guard-isolation
  rule): assume-valid ⇒ clean for arbitrary stat; racy (entry mtime == indexMtime) ⇒ NOT
  clean; ns-present-and-differs ⇒ NOT clean; ns-absent both sides ⇒ compares sec only;
  32-bit ino/size truncation boundary (`ino = 2^32 + k` vs `k`) ⇒ clean; each of
  mtime/ctime/uid/gid/ino/size mismatched in isolation ⇒ NOT clean; dev mismatch ⇒ still
  clean (dev not compared).
- RED (unit, comparator): a stat-clean regular file with `indexMtime` supplied returns
  `unchanged` WITHOUT calling `ctx.fs.read`/`serializeAndHash` (spy them); a stat-clean
  file with a differing exec bit returns `mode-changed` with NO hash; `indexMtime` absent
  ⇒ old behaviour (always reads).
- RED (property, ADR-134 lens 2): a clean-stat entry with any single mutated stat field is
  never clean; assume-valid is clean for arbitrary stats; racy always defers.
- RED (unit): `readIndex` surfaces `indexMtime` (sec + ns) for a present index; undefined
  for an absent one.
- RED (interop, Pin C): same-size same-second edit ⇒ `status` reports modified (racy
  re-hash); `update-index --assume-unchanged` then longer edit ⇒ no `M`;
  `update-index --skip-worktree` then edit ⇒ skipped. Reconstruct porcelain from
  `StatusResult`. `runGitAsync`, scrub `GIT_*`.
- RED (interop): tsgit-written index bytes match git-written for the same staged file
  (ns now populated) — the re-pinned golden.
- GREEN: add `is-entry-stat-clean.ts`, wire the comparator + `status` + `readIndex` +
  `indexEntryFromStat`; regenerate `reports/api.json`.
- REFACTOR: no dead guard; assert error/verdict `.data`; confirm the racy comparison
  handles the ns-optional branches without a `?? 0` that masks a real mutant.

### Gate

`npx vitest run test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/is-entry-stat-clean.properties.test.ts test/unit/application/primitives/read-index.test.ts test/unit/public-types.test.ts test/integration/status-racy-clean-interop.test.ts test/integration/index-interop.test.ts test/integration/add-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/compare-working-tree-entry.ts src/application/primitives/internal/is-entry-stat-clean.ts src/application/primitives/internal/index-entry-from-stat.ts src/application/primitives/read-index.ts src/application/commands/status.ts src/domain/git-index/index-entry.ts`
(plus: `npm run docs:json` and commit `reports/api.json`.)

### Commit

`perf(status): skip read+hash for stat-clean tracked files`

---

## Part 5 — A4/B8: reuse persistent per-pack file handles and pin dispose-free exit

### Context

Fixes **A4** (req 4, ADR-510) + **B8** (req 12, joint). A cold 43-deep OFS chain issues 43
sequential `readSlice` calls, each a full containment-check + open + zero-filled alloc +
read + full copy + close (`node-file-system.ts` L475–491) — keeping cold delta-chain
`readBlob` at ~4.2 ms vs iso-git's 1.07 ms (iso slurps the whole pack once). The pack
registry will own ONE lazily-opened persistent `FileHandle` per pack; the chain walk
issues all slice reads against it — one `open` per pack, not per step — closed on
`dispose()`. Idle Node `fs.FileHandle`s do NOT ref the libuv loop, so exit-without-dispose
still holds (B8).

Files / symbols:
- `src/application/primitives/pack-registry.ts`:
  - `RegisteredPack` (L23–30) — add `readSlice(offset: number, length: number):
    Promise<Uint8Array>` (backed by a lazily-opened persistent handle) and `close():
    Promise<void>`.
  - `loadPack` (L68–93) — add a lazily-memoised `handle` (open via
    `ctx.fs.openWithNoFollow(packPath, 'read')`, `ports/file-system.ts` L150 / node impl
    L683; the `FileHandle.read(buffer, offset, length, position)` port method, L36) and
    implement `readSlice`/`close` over it. Trim the alloc: allocate exactly `length`, read
    into it at `position=offset`, return a `bytesRead`-length view — no zero-fill, no double
    copy (mirror the `readSlice` trim below).
  - **Adapter-agnostic edge:** browser OPFS `openWithNoFollow` throws
    `UNSUPPORTED_OPERATION` (`ports/file-system.ts` L146). `RegisteredPack.readSlice` MUST
    catch that and fall back to a per-call `ctx.fs.readSlice(packPath, offset, length)`
    (today's behaviour) — browser loses only the Node-fs syscall win, correctness is
    preserved. Memory adapter supports `openWithNoFollow` for non-symlink leaves (returns a
    handle), so it keeps the persistent handle.
  - `createPackRegistry` (L122–158) — track loaded packs; add `dispose(): Promise<void>`
    that `close()`s every loaded pack's handle. Add `dispose` to the `PackRegistry`
    interface (L37–43).
- `src/application/primitives/object-resolver.ts` → `readEntryHeaderWithChunk` (L341–357)
  currently calls `ctx.fs.readSlice(hit.pack.packPath, hit.offset, sliceLength)` (L352).
  Switch to `hit.pack.readSlice(hit.offset, sliceLength)` (the persistent-handle path).
- `src/adapters/node/node-file-system.ts` → `readSlice` (L475–491): trim the standalone
  method too (used elsewhere, e.g. pack-index lookups) — replace `Buffer.alloc(length)` +
  `Uint8Array.from(buf.subarray(0, bytesRead))` (L482–484) with an exact-size
  `Buffer.allocUnsafe(length)` + a `bytesRead`-length view (no zero-fill, no double copy).
  Faithful micro-win; keep the `finally { handle?.close() }` for the standalone path.
- `src/application/primitives/read-object.ts` → add `disposePackRegistry(ctx): Promise<void>`
  = `await registryCache.get(ctx)?.dispose()` (does NOT create a registry if none exists).
- `src/repository.ts` → `dispose` (L462–480). Inside the `disposePromise` IIFE, after the
  macrotask boundary and **before** `disposeAdapters(ctx)` (L476), call
  `await disposePackRegistry(ctx)` — pack handles are FileHandles owned by `ctx.fs`, so
  they must close BEFORE any fs-adapter teardown.
- **Public-surface decision — INTERNAL.** `RegisteredPack.readSlice`/`close`,
  `PackRegistry.dispose`, and `disposePackRegistry` are internal (the `PackRegistry`
  facade is not re-exported from `public-types.ts` nor bound on `repo.primitives`). No
  surface gates. `FileHandle`/`openWithNoFollow` are existing port surfaces (unchanged).
- **B8 lifecycle:** the Node HTTP transport (`node-http-transport.ts`) holds no keep-alive
  Agent/timer today (verified — grep found none), so there is nothing to `unref()`; the
  design's "unref where semantically safe" is a no-op here — record that in the part. B8's
  concrete deliverable is the regression test + proving A4's persistent handles don't break
  exit. If a keep-alive Agent is later present, its idle sockets/timer must be `unref()`'d
  (any idle-close timer must itself be `unref()`'d) — note only.

Fixture: the deep-delta-chain pack (`DELTA_CHAIN_FIXTURE`, chain depth ≈ 43) in
`test/bench/support/fixture-generator.ts`, exercised by
`test/bench/delta-chain-read.bench.ts`. For the unit test, build/reuse an equivalent deep
OFS chain via the existing pack test fixtures.

Test files: `test/unit/application/primitives/pack-registry.test.ts`,
`test/unit/application/primitives/object-resolver.test.ts`,
`test/unit/adapters/node-file-system*.test.ts` (readSlice trim),
`test/unit/repository/repository.test.ts` (dispose closes handles), new integration
`test/integration/dispose-free-exit.test.ts` (spawns a child node process).

### TDD steps

- RED (unit): resolving a deep-chain leaf issues exactly ONE `open`/`close` per pack (not
  per step) against the registry's persistent handle — spy the port `open`/`close`
  (or `openWithNoFollow`) and assert count == pack count; byte-identical output.
- RED (unit): `RegisteredPack.readSlice` returns exactly `bytesRead` bytes (no trailing
  zero-fill) for a short read at EOF; `close()` is idempotent.
- RED (unit): the node `readSlice` allocates exactly `bytesRead` (assert length, and that a
  short read at EOF has no zero padding).
- RED (unit): `repo.dispose()` closes every loaded pack handle (spy `close`); a repo that
  never touched a pack disposes without creating a registry.
- RED (integration): a child node process `openRepository` → one `diff` → return WITHOUT
  `dispose()` must exit within N seconds (assert exit code + wall time). With persistent
  handles present, also assert no fd leak after an explicit `dispose()`.
- GREEN: implement the handle ownership, rewire `readEntryHeaderWithChunk`, trim node
  `readSlice`, add `disposePackRegistry` + wire into `repo.dispose`.
- REFACTOR: containment check happens once at open (via `openWithNoFollow`); confirm the
  `finally`/idempotent-close invariants; no swallowed errors on close.

### Gate

`npx vitest run test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/repository/repository.test.ts test/integration/dispose-free-exit.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts src/application/primitives/object-resolver.ts src/application/primitives/read-object.ts src/adapters/node/node-file-system.ts src/repository.ts`

### Commit

`perf(pack): reuse persistent per-pack file handles across delta-chain steps`

---

## Part 6 — B2: export declared diff value symbols at runtime + guard the class

### Context

Fix **B2** (req 6, ADR-512). `src/public-types.ts` L32 does
`export type * from './domain/diff/index.js'`. `export type *` strips runtime VALUES, so
`MAX_SCORE` (a `const`, `domain/diff/similarity.ts` L16) and `toSimilarityPercent` (a
function, L197) reach the built `.d.ts` as declared value exports but are ABSENT from the
runtime bundle — TS consumers (sfdx-git-delta) compile green and crash at runtime. Fix +
permanent guard that kills the whole drift class.

Files / symbols:
- `src/public-types.ts` — add a NAMED value re-export line (distinct from the L32
  `export type *`), e.g. `export { MAX_SCORE, toSimilarityPercent, … } from
  './domain/diff/index.js'`, sweeping ALL of `domain/diff/index.ts`'s value exports EXCEPT
  the names already explicitly handled to avoid re-introducing the TS2308 clashes the
  `export type *` avoided (`diffTrees` is handled at L59; do not value-re-export it here).
  The diff barrel's value exports are enumerated in `src/domain/diff/index.ts`
  (L2–3, 20, 24, 28–34, 38–48, 52, 61, 63, 66, 71–77, 81, 84, 89–93). The guard test is the
  acceptance oracle for the exact required set.
- All three runtime entries already propagate values: `index.node.ts` L131 / `index.default.ts`
  L68 / `index.browser.ts` L75 all do `export * from './public-types.js'` (value star), so a
  value re-export in `public-types.ts` flows through — no per-entry edit needed. Confirm.
- ADR-249 note: `toSimilarityPercent` is a display-percent helper; it stands as a
  documented, NARROW ADR-249 exception (the `.d.ts` already published it). No NEW cosmetic
  surface is added.
- **Surface gate:** new public runtime exports → regenerate `reports/api.json`
  (`npm run docs:json`) and commit it (prepush `check:doc-typedoc`). README count line
  (`README.md` L46 "43 Tier-1 commands · 20+ … primitives") is NOT affected (these are
  neither commands nor primitives). `check:doc-coverage` is NOT affected (it audits only
  `repo.*` commands/primitives).

Guard test — **requires the built dist**: import the built `dist/esm/index.node.js` and
parse the declared VALUE exports out of the built `dist/types/index.node.d.ts` (exports
declared without the `type` keyword), asserting every declared value export is `!==
undefined` at runtime. Place in `test/integration/` (build-dependent), e.g.
`test/integration/public-runtime-exports.test.ts`. The part MUST `npm run build` before the
vitest gate runs (validate builds anyway); a `beforeAll` that shells `npm run build` or a
gate step ordering both work.

### TDD steps

- RED: the guard (against a fresh build) asserts `MAX_SCORE !== undefined` and
  `toSimilarityPercent !== undefined` on the imported `dist/esm/index.node.js` — fails
  today (runtime omits them).
- RED (generalised): parse ALL declared value exports from `dist/types/index.node.d.ts`;
  assert each is runtime-defined — fails for the affected symbols.
- GREEN: add the named value re-export to `public-types.ts`; `npm run build`;
  `npm run docs:json`.
- REFACTOR: confirm no TS2308 (`check:types`) from the added line; confirm the guard reads
  the built artefacts (not source) so it locks the actual shipped surface.

### Gate

`npm run build && npx vitest run test/integration/public-runtime-exports.test.ts && npm run check:types && ./node_modules/.bin/biome check src/public-types.ts test/integration/public-runtime-exports.test.ts`
(plus: `npm run docs:json` and commit `reports/api.json`.)

### Commit

`fix(public-types): export declared diff value symbols at runtime`

---

## Part 7 — B3/B6: bind flattenTree as the bulk tree-traversal primitive

### Context

Fixes **B3** (req 7) + **B6** (req 10, ADR-515). `flattenTree` (`flatten-tree.ts` L20) is
exported from the primitives barrel (`primitives/index.ts` L36) but MISSING from
`repository.ts`'s `primitives` table — a wiring-drift twin of B2 on the facade axis. Bind
it and document it as the bulk traversal path (the zero-per-entry-promise route ADR-515
picks over batching `walkTree`; `walkTree` keeps its per-entry streaming shape unchanged).

Files / symbols:
- `src/repository.ts`:
  - Type table (L266–290): add `readonly flattenTree: BindCtx<typeof primitives.flattenTree>;`
    in alphabetical position (after `diffTrees` L270, before `getRepoRoot` L271).
  - Runtime binding block (L640–733): add, following the existing
    `guard(); return primitives.flattenTree(ctx, treeIdOrObject);` shape, in the same
    alphabetical slot (after `diffTrees` L653–656, before `getRepoRoot` L657–660).
  - `flattenTree(ctx, treeIdOrObject: ObjectId | Tree): Promise<FlatTree>` returns a
    `FlatTree` (`{ entries: Map<FilePath, FlatTreeEntry> }`) — structured data, ADR-249-clean.
- `test/unit/repository/repository.test.ts`:
  - Add `'flattenTree'` to the sorted primitives `Object.keys` snapshot list (L294–319).
  - Add a repository test exercising `repo.primitives.flattenTree(<treeId>)` (near the
    existing `sut.primitives.writeTree`/`walkSubmodules` tests L683–705).
- **New guard test** (kills the B3 drift class): audit `repository.primitives` binding
  keys against the primitives-barrel export list (`src/application/primitives/index.ts`) —
  every exported `(ctx, …)` primitive is bound on `repo.primitives` or on an explicit
  exclusion list; assert `flattenTree` bound. Place in `test/unit/api-surface/`
  (alongside `snapshot-barrel-surface.test.ts`), e.g.
  `test/unit/api-surface/primitives-binding-surface.test.ts`.
- **B6 unit** (folds in here): the bulk path `flattenTree` yields the SAME entry set as a
  per-entry `walkTree` drain, with zero per-entry promises (count `await`s / assert one
  eager pass); `walkTree`'s per-entry shape is unchanged.
- **Surface gates** (a new `repo.primitives.*` key):
  - `check:doc-coverage` (`tooling/check-doc-coverage.ts`): create
    `docs/use/primitives/flatten-tree.md` AND add an index row
    `[\`flattenTree\`](flatten-tree.md)` to `docs/use/primitives/README.md` (both required;
    kebab = `flatten-tree`).
  - `audit-browser-surface` (`tooling/audit-browser-surface.ts` scans `repo.primitives.X(`):
    invoke `repo.primitives.flattenTree(…)` in a `test/parity/scenarios/*.scenario.ts`
    `run()` (extend `diff-pipeline.scenario.ts`, which already exercises the diff path), or
    add an allowlist entry with a reason in `tooling/audit-browser-surface.allowlist.json`.
  - `reports/api.json`: regenerate via `npm run docs:json` and commit (prepush gate).
  - README count line (`README.md` L46) reads "20+ … primitives" — no numeric bump needed
    (it is a floor, not an exact count); confirm, don't edit.

### TDD steps

- RED: the primitives-binding guard test asserts `flattenTree` is bound → fails today
  (binding absent).
- RED: `repository.test.ts` primitives-snapshot expects `flattenTree` in the sorted keys →
  fails today.
- RED (B6): `repo.primitives.flattenTree(treeId)` returns a `FlatTree` whose `entries`
  equal the non-directory entries of a `walkTree` drain; assert the bulk path performs no
  per-entry promise beyond the object reads (structural — one eager `Map` build).
- GREEN: add the type-table entry + runtime binding; add the doc page + index row; add the
  browser scenario call (or allowlist); `npm run docs:json`.
- REFACTOR: confirm `check:doc-coverage`, `audit-browser-surface`, and the binding guard
  all pass; the guard's exclusion list (if used) is minimal and reasoned.

### Gate

`npx vitest run test/unit/repository/repository.test.ts test/unit/api-surface/primitives-binding-surface.test.ts test/unit/application/primitives/flatten-tree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/repository.ts test/unit/repository/repository.test.ts test/unit/api-surface/primitives-binding-surface.test.ts`
(plus: `node --experimental-strip-types tooling/check-doc-coverage.ts`, `node --experimental-strip-types tooling/audit-browser-surface.ts`, `npm run docs:json` + commit `reports/api.json`.)

### Commit

`feat(repository): bind flattenTree as the bulk tree-traversal primitive`

---

## Part 8 — B4: stream a rolling-hash predicate for whitespace-only changes

### Context

Fix **B4** (req 8, ADR-513). `applyLinePassAndStat` (`diff-trees.ts` L95–115) always
materialises every modified blob pair (`materialisePatchFiles`), string-decodes, splits
lines, `normalizeLine`s per line, and runs Myers `diffLines` — even when the caller only
needs the drop-pass predicate "did any significant change survive whitespace
normalisation?" (933 ms / 674 MB vs git 39 ms / 143 MB; 52 % line-diff + 28 % GC). Split the
two concerns; the predicate and stat paths MUST agree on which files survive.

Files / symbols:
- `src/application/primitives/diff-trees.ts` → `applyLinePassAndStat` (L95),
  `statOptionsFor` (L73), `shouldDrop` (L123). Route the **drop-pass predicate path**
  (`lineKeyActive` and NOT `withStat`) through a new streaming predicate that scans raw
  bytes and early-exits — avoiding `materialisePatchFiles` + full `computeStatFields`. The
  **stat path** (`withStat: true`) keeps full line-diff but over interned ints (below).
  Predicate and stat share one normalisation rule set (verdict-consistent).
- New predicate `src/application/primitives/internal/whitespace-drop-predicate.ts` (or
  co-located) → for a modify change, stream BOTH blobs via `streamBlob`
  (`stream-blob.ts` L32, `streamInflate` machinery), scan raw bytes line-by-line, fold the
  `WhitespaceMode` normalisation into a rolling hash per line (no string decode, no line
  arrays), and early-exit on the first significant mismatch. Equality (changed-only-by-
  whitespace) collapses to "no significant change" with no Myers alignment. Consumes only
  the blob oids on the change (`oldId`/`newId`).
- `src/domain/diff/whitespace.ts` → reuse `normalizeLine`/`linesEqualUnder`/`LineKey`
  (L107–123) byte-level rules on the raw stream. Add a byte-level per-line normalise-and-
  hash helper (rolling hash over the normalised bytes) that reproduces `normalizeLine`'s
  `dropAllWs`/`collapseRuns`/`dropTrailingWs`/`dropTrailingCr` semantics (L27–96) WITHOUT
  allocating a normalised `Uint8Array` per line.
- `src/domain/diff/line-diff.ts` → `diffLines` (L260), `splitLines` (L33). For the STAT
  path (ADR-513), intern normalised lines to ints first so Myers runs over int arrays
  (git's approach), collapsing the string/GC cost. Keep the drop verdict identical to
  today's `shouldDrop`.

Faithfulness: the drop-pass verdict MUST equal git's "is this file changed under `-w`?".
Interop pins both paths against `git diff --ignore-all-space` (`WhitespaceMode 'all'`),
`--ignore-space-change` (`'change'`), `--ignore-space-at-eol` (`'at-eol'`), plus
`--ignore-cr-at-eol` and `--ignore-blank-lines` (the `ignoreCrAtEol`/`ignoreBlankLines`
`DiffOptions`, `commands/diff.ts` L30–41). Parser/scanner touched → property sibling
required (four-lens rule).

Test files: `test/unit/application/primitives/diff-trees.test.ts`,
`test/unit/domain/diff/whitespace.test.ts` + `whitespace.properties.test.ts` (extend both),
new interop `test/integration/diff-whitespace-modes-interop.test.ts`.

### TDD steps

- RED (unit): a whitespace-only modify (e.g. reindent) with `ignoreWhitespace: 'all'` and
  NOT `withStat` is dropped by the predicate WITHOUT materialising both blobs fully — spy
  the stream / `materialisePatchFiles` to prove early-exit; a significant change survives.
- RED (unit): the predicate agrees with the full-diff `shouldDrop` verdict across every
  `WhitespaceMode` (`all`/`change`/`at-eol`/`none`) and the `ignoreCrAtEol`/
  `ignoreBlankLines` combinations.
- RED (property, round-trip/aggregator): normalised-line equality is reflexive and the
  predicate/stat verdicts agree for arbitrary line pairs under an arbitrary `LineKey`.
- RED (interop): pin predicate + stat survivors against the five git flags above; scrub
  `GIT_*`, `runGitAsync`, shared `beforeAll` repo, 60s timeout.
- GREEN: add the streaming rolling-hash predicate; route the stat path through int-array
  Myers; wire `applyLinePassAndStat` to pick the predicate path when
  `lineKeyActive && !withStat`.
- REFACTOR: predicate and stat share the normalisation rule set (one source); flat memory
  (no per-line array); assert early-exit and verdict-consistency, not just counts.

### Gate

`npx vitest run test/unit/application/primitives/diff-trees.test.ts test/unit/domain/diff/whitespace.test.ts test/unit/domain/diff/whitespace.properties.test.ts test/integration/diff-whitespace-modes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/diff-trees.ts src/application/primitives/internal/whitespace-drop-predicate.ts src/domain/diff/whitespace.ts src/domain/diff/line-diff.ts test/unit/application/primitives/diff-trees.test.ts test/unit/domain/diff/whitespace.test.ts test/unit/domain/diff/whitespace.properties.test.ts`

### Commit

`perf(diff): stream a rolling-hash predicate for whitespace-only changes`

---

## Part 9 — B5: skip the representation tax for unchanged tree entries

### Context

Fix **B5** (req 9, ADR-514). Megarepo recursive diff ~88 ms vs git ~15–20 ms; profile
30 % tree parse/diff, 11.5 % `TextEncoder`/`TextDecoder`, 3.3 % oid regex, 7.2 % GC. Three
independent steps, value order — all `diffTrees`-local; the internal oid stays a hex
string elsewhere (a full `Uint8Array` oid representation is FORECLOSED to a future ADR).

Public-surface decision: no new exported symbols — (a)/(b)/(c) all change INTERNAL
implementations of existing functions (`diffTrees`, `ObjectId.fromRaw`, `parseTreeContent`,
`diffRecursive`); signatures/types are unchanged ⇒ no api.json / surface gate. `fromRaw`'s
observable contract (length-checked, throws `INVALID_OBJECT_ID`) is preserved.

Files / symbols (value order — (c) is the primary saver: unchanged SUBTREES are the ~29k
entries; (a)/(b) are per-entry micro-trims for the entries that ARE compared):
- **(c) prune equal-oid subtrees** — PRIMARY. In `src/application/primitives/diff-trees.ts`
  → `diffRecursive` (L150–157), `blobProjection` (L166–175). A dir entry whose oid is
  unchanged (TREESAME) must NOT be read/flattened via `blobProjection`/`flattenTree` at all
  — skip the subtree before any entry is built or parsed. This is where the ~29k
  unchanged entries stop paying parse/hex/decode.
- **(a) byte-level entry comparison** in `src/domain/diff/tree-diff.ts` → `diffTrees`
  (L53–88), `classifySamePath` (L24–46), `treeEntryCompare` (via `domain/objects/tree.ts`
  L113). Within the merge-join, compare same-position entries by mode + name + oid and defer
  any FURTHER hex/decode materialisation to EMITTED changes only (unchanged same-oid entries
  short-circuit). Stays `diffTrees`-local per ADR-514 (the internal oid stays a hex string
  elsewhere; a full `Uint8Array` representation is foreclosed to a future ADR).
- **(b) trusted `fromRaw`** in `src/domain/objects/object-id.ts` → `ObjectId.fromRaw`
  (L17–22). Today: `ObjectId.from(bytesToHex(bytes))` → `SHA1_HEX_RE.test(hex)` (L11, the
  hot-loop regex) per entry. `bytesToHex` emits only `[0-9a-f]` by construction on a
  length-checked 20/32-byte slice, so the regex re-validation is provably vacuous. Give
  `fromRaw` a trusted brand path (length check + `bytesToHex`, NO regex). Observable
  unchanged — a corrupt slice still fails the length check (L18–20). API-boundary
  validation (`ObjectId.from` on external hex) is untouched.
- `src/domain/objects/tree.ts` → `parseTreeContent` (L31–73) calls `ObjectId.fromRaw`
  (L61) per entry. Route it through the trusted path; if (a) needs raw entry slices to
  avoid decoding unchanged entries, expose them without changing `parseTreeContent`'s
  public `Tree` return signature.

Faithfulness: the observable `TreeDiff` (change set, order, emitted hex oids + decoded
paths) is byte-identical; only the internal work for unchanged entries is elided. Parser
(`parseTreeContent`) + matcher (`fromRaw`) touched → property siblings required.

Test files: `test/unit/domain/diff/tree-diff.test.ts`,
`test/unit/domain/objects/tree.test.ts` + new `tree.properties.test.ts`,
`test/unit/domain/objects/object-id.test.ts` (+ properties for `fromRaw`),
`test/unit/application/primitives/diff-trees.test.ts`.

### TDD steps

- RED (unit): unchanged same-oid entries are compared without paying extra hex/path
  materialisation (spy/count `bytesToHex`/`TextDecoder`/regex — the count scales with
  EMITTED changes, not total entries); emitted changes still carry hex oids + decoded paths.
- RED (unit): an equal-oid subtree is pruned before `flattenTree`/`blobProjection` runs
  (spy `flattenTree` — not called for the TREESAME dir).
- RED (property): `fromRaw` trusted path ≡ the old validated path for ALL valid 20/32-byte
  inputs; a wrong-length slice still throws `INVALID_OBJECT_ID` (assert `.data`).
- RED (property): `diffTrees(parseTreeContent(x), parseTreeContent(y))` invariants
  (round-trip / aggregator lens) hold.
- GREEN: implement (a) byte compare, (b) trusted `fromRaw`, (c) subtree prune.
- REFACTOR: no behaviour drift on emitted changes; assert error `.data` on the length-check
  guard; confirm the byte-compare merge-join order matches `treeEntryCompare`.

### Gate

`npx vitest run test/unit/domain/diff/tree-diff.test.ts test/unit/domain/objects/tree.test.ts test/unit/domain/objects/tree.properties.test.ts test/unit/domain/objects/object-id.test.ts test/unit/application/primitives/diff-trees.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/tree-diff.ts src/domain/objects/object-id.ts src/domain/objects/tree.ts src/application/primitives/diff-trees.ts`

### Commit

`perf(diff): skip the representation tax for unchanged tree entries`

---

## Part 10 — B7 (parser): parse single-file and chained commit-graphs

### Context

Fix **B7** sub-part (a), domain half (ADR-516, Pin D). Add a pure, chunk-table-driven
domain decoder for the commit-graph on-disk format. Read-side only — write-side
(`commit-graph` generation) stays OUT of scope. This part lands the domain parser + its
unit/property tests; the reader/integration that consumes it is Part 11.

Public-surface decision — INTERNAL. `src/domain/commit/` has no aggregating barrel and is
NOT covered by any `public-types.ts` wildcard (which re-exports `domain/objects`,
`domain/diff`, `domain/git-index`, `domain/grep`, `domain/pathspec`, `domain/snapshot` —
not `domain/commit`). The parser is imported directly by the Part-11 reader. No surface
gates, no api.json.

Files / symbols:
- New `src/domain/commit/commit-graph.ts` (sits beside `binary-heap.ts` +
  `priority-queue.ts` in `src/domain/commit/`). Pure — zero port/adapter deps. Parses ONE
  graph file's bytes into a structured layer + provides intra-layer lookups. The
  cross-layer chain assembly (reading `commit-graph-chain` + opening each
  `graph-<hash>.graph`) needs `ctx.fs` and lives in the Part-11 reader.
- Pinned format (Pin D, git 2.55.0):
  - Header 8 bytes: magic `43 47 50 48` ("CGPH"), version `01`, hash-version byte
    (`01`=SHA-1 / `02`=SHA-256), num-chunks byte, num-base-graphs byte (byte 7 — 0 on base
    layer, 1 on tip; equals the count of 20/32-byte oids in the `BASE` chunk).
  - Chunk table: `(4-byte id, 8-byte u64 offset)` rows, terminated by a sentinel row whose
    offset marks chunk-data end; read chunks BY ID, not fixed offsets. Ids:
    `OIDF`("OIDF") 256×u32 fanout; `OIDL` N×(20/32-byte oid, sorted); `CDAT` N×(tree
    oid[20/32] + parent1-pos[4] + parent2-pos[4] + gen/date[8]); `GDA2` N×u32
    generation-data-v2; `EDGE` octopus edge list; `BASE` base-layer graph hashes.
  - Parent-position sentinels: `0x70000000` = no parent; `0x80000000 | edge-pos` = octopus
    (→ `EDGE` chunk). 20-byte trailer closes the file.
  - Self-consistency example (5-commit single file, 1412 bytes): OIDF @68 (1024 B), OIDL
    @1092 (100 B = 5×20), CDAT @1192 (180 B = 5×36), GDA2 @1372 (20 B = 5×4), end @1392 +
    20-byte trailer = 1412.
- Parser API (suggested): `parseCommitGraphLayer(bytes): CommitGraphLayer` exposing
  hash-version, num-base-graphs, the `BASE` oids, a fanout-backed `positionOf(oid)`
  (binary search within the layer), and `commitDataAt(localPos): { rootTree, parent1Pos,
  parent2Pos, generation, committerDate }` + EDGE resolution for octopus parents. Throw a
  domain error (`domain/storage/error.ts` style or a new `domain/commit` error) with
  specific `.data` on a malformed magic/version/truncated chunk.
- Property tests need a TEST-ONLY encoder (write-side is out of scope for `src/`): put a
  `buildCommitGraphBytes(model)` byte encoder + generators in a new
  `test/unit/domain/commit/arbitraries.ts` so the round-trip lens works
  (`parseCommitGraphLayer(build(m))` recovers `m`).

Test files: new `test/unit/domain/commit/commit-graph.test.ts`,
`test/unit/domain/commit/commit-graph.properties.test.ts`,
`test/unit/domain/commit/arbitraries.ts`.

### TDD steps

- RED (unit): decode the pinned 5-commit single-file layout — assert chunk offsets, 256-entry
  fanout, sorted OIDL, per-commit CDAT (tree oid + parent positions + gen/date), GDA2, and
  the no-parent/octopus sentinels.
- RED (unit): decode a chain LAYER — base layer header `43 47 50 48 01 01 04 00`
  (num-base-graphs 0, no BASE chunk); tip layer header `… 05 01` (num-base-graphs 1, a
  `BASE` chunk of one 20-byte oid = the base layer's hash). Assert `num-base-graphs` from
  header byte 7 equals the `BASE` chunk oid count.
- RED (unit, isolated): malformed magic → specific error `.data`; truncated chunk → specific
  error `.data`; version/hash-version mismatch → specific error `.data`.
- RED (property, decoder lenses): total function over the safe subset (parse never throws
  on a structurally-valid built layout); `parseCommitGraphLayer(buildCommitGraphBytes(m))`
  round-trips the model (fanout, oids, parent positions, generation).
- GREEN: implement the chunk-table-driven parser + intra-layer lookups.
- REFACTOR: read chunks by id (not fixed offset); no dead guard; assert error `.data`, not
  class.

### Gate

`npx vitest run test/unit/domain/commit/commit-graph.test.ts test/unit/domain/commit/commit-graph.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commit/commit-graph.ts test/unit/domain/commit/commit-graph.test.ts test/unit/domain/commit/commit-graph.properties.test.ts test/unit/domain/commit/arbitraries.ts`

### Commit

`feat(commit-graph): parse single-file and chained commit-graphs`

---

## Part 11 — B7 (reader): serve commit walks from the commit-graph

### Context

Fix **B7** sub-parts (a: reader half), (c: prefetch), (d: header cache) — req 11, ADR-516.
Add a primitive reader over the Part-10 parser wired through `ctx.fs`, consult it first in
the commit walks, fall back to `readObject` for commits absent from the graph (or an
absent/stale graph). Visible commit set/order/parents/dates identical to the object-read
walk (the graph is git's own cache; generation numbers only prune/order). B7b (object-store
probe order) is Part 3's loose-oid cache — the reader's fallback object reads funnel through
`resolveObject`, which already consumes it; no extra probe code here.

Public-surface decision — INTERNAL. The reader is consumed only by `walkCommits` /
`commitDateWalk` (import it directly, like `internal/read-commit.ts`). Do NOT add it to the
primitives barrel `src/application/primitives/index.ts` and do NOT bind it on
`repo.primitives` — otherwise Part 7's primitives-binding guard (which audits the barrel)
flags it as an unbound export. Placing it under `src/application/primitives/internal/` keeps
it off both the barrel and the binding table. No `check:doc-coverage` /
`audit-browser-surface` / api.json gate fires.

Files / symbols:
- New `src/application/primitives/internal/read-commit-graph.ts` (internal, off the barrel).
  Via `ctx.fs`:
  - Locate the graph: single-file `objects/info/commit-graph`, else chain
    `objects/info/commit-graphs/commit-graph-chain` (lines = layer hashes base→tip) + one
    `objects/info/commit-graphs/graph-<hash>.graph` per layer. Use `commonGitDir(ctx)`
    (`path-layout.ts` L24); add path helpers for `objects/info/commit-graph[s]`.
  - Parse each layer with `parseCommitGraphLayer` (Part 10). Link layers via
    `num-base-graphs` + the `BASE` chunk; resolve a parent position `p` to the owning layer
    by GLOBAL position = (Σ base-layer commit counts) + local index (base owns 0..k-1, tip
    owns k..; `p < k` → base, else tip at `p−k`). EDGE handles octopus parents.
  - **Staleness (Pin D):** a chain that references a MISSING `graph-<hash>.graph` ⇒ treat
    the WHOLE graph as absent and fall back to object reads (git's own behaviour — exit 0
    with a warning, silent object-read fallback).
  - Serve `commitHeader(oid) → { rootTree, parents, committerDate, generation } | undefined`
    (undefined = not in graph ⇒ caller falls back).
  - Cache the parsed graph per `Context` (`WeakMap<Context, …>`, mirror `registryCache`
    in `read-object.ts` L14) so it is parsed once per repo lifetime.
- **(d) per-Repository commit-header cache**: `WeakMap<Context, Map<oid, CommitHeader>>`
  populated from the graph or a fallback object read (oid → parents/date/tree/generation);
  shared across every walk in the repo's lifetime.
- **Integration** — `src/application/primitives/walk-commits.ts` → `walkCommits` (L25) FIFO
  and `src/application/primitives/internal/commit-date-walk.ts` → `commitDateWalk` (L70)
  heap. Both currently discover parents/dates via `readCommit` (`internal/read-commit.ts`
  L18) → `readObject` per commit, sequentially awaited. Rewire so the FRONTIER/ORDERING
  decisions (parents for enqueue; committer date for the `BinaryHeap` key,
  `commit-date-walk.ts` L127) come from `commitHeader` when present. Both walks yield full
  `Commit` objects, so the commit BODY is still read — but via **(c) bounded parent-frontier
  prefetch**: read the frontier's commit objects in parallel (bounded 8–16 in flight, reuse
  `RepositoryConfig.parallelism` default 8, `ports/context.ts` L69) instead of one awaited
  `readCommit` per pop. Keep `until`/`shallow`/`ignoreMissing`/`verifyHash` semantics and
  the `seen`/`visited` dedup exactly.
- `BinaryHeap` (`domain/commit/binary-heap.ts`) + `precedes`/`QueueEntry`
  (`domain/commit/priority-queue.ts`) are reused unchanged.

Faithfulness (interop, Pin D): build fixtures with (1) a single-file graph
(`git commit-graph write --reachable`), (2) a chain/split graph
(`git commit-graph write --reachable --split`), (3) NO graph — all three walks identical to
EACH OTHER and to `git rev-list` order/set. Also: delete a referenced layer file (stale
chain) → walk still identical (falls back). `runGitAsync`, scrub `GIT_*`, sign off, shared
`beforeAll` repo, 60s timeout.

Test files: new `test/unit/application/primitives/internal/read-commit-graph.test.ts`,
`test/unit/application/primitives/walk-commits.test.ts` (extend),
`test/unit/application/primitives/walk-commits-by-date.test.ts` (extend), new interop
`test/integration/commit-graph-walk-interop.test.ts`.

### TDD steps

- RED (unit): the reader serves `parents`/`generation`/`committerDate`/`rootTree` from a
  single-file graph fixture matching object reads; from a chain/split fixture (cross-layer
  global-position resolution + EDGE octopus + `BASE`-linked layers) matching object reads.
- RED (unit, isolated): a commit ABSENT from the graph → `commitHeader` undefined → the walk
  falls back to `readObject`; a chain referencing a MISSING layer → whole graph absent →
  fallback; a stale graph → fallback. Each isolated.
- RED (unit): the per-Repository header cache returns the same headers on the second walk
  (spy the parser / fs — parsed once); bounded prefetch stays within its 8–16 concurrency
  cap (assert in-flight count never exceeds the bound).
- RED (interop): single-file / chain-split / no-graph walks all identical to each other and
  to `git rev-list` (order + set + parents + dates). Stale-chain identical too.
- GREEN: implement the reader (both on-disk forms + staleness), the header cache, the
  bounded prefetch; wire into `walkCommits` + `commitDateWalk`.
- REFACTOR: yield-identical `Commit` set/order preserved; generation only prunes/orders;
  no swallowed errors on a partial/corrupt graph (fall back, don't crash); assert
  concurrency bound + fallback `.data`.

### Gate

`npx vitest run test/unit/application/primitives/internal/read-commit-graph.test.ts test/unit/application/primitives/walk-commits.test.ts test/unit/application/primitives/walk-commits-by-date.test.ts test/integration/commit-graph-walk-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/read-commit-graph.ts src/application/primitives/walk-commits.ts src/application/primitives/internal/commit-date-walk.ts test/unit/application/primitives/internal/read-commit-graph.test.ts test/unit/application/primitives/walk-commits.test.ts test/unit/application/primitives/walk-commits-by-date.test.ts test/integration/commit-graph-walk-interop.test.ts`

### Commit

`perf(walk-commits): serve commit walks from the commit-graph`

---

## Part 12 — bench coverage for the Track-B scenarios (test-infra-only)

### Context

Req 13 wants the CI **nightly** bench artifact to SHOW the Track-B wins improved (all
published numbers come from the nightly, never local runs). The four LOSING scenarios and
the winners already have benches (`delta-chain-read.bench.ts` for A1/A4,
`loose-read.bench.ts` + `pack-read.bench.ts` for A2/cold-LRU, `status.bench.ts` for A3,
`log.bench.ts` for the commit walk, `clone-small-repo.bench.ts` / `status-dirty.bench.ts`
for the winners), but three Track-B wins have NO bench today: whitespace-mode diff (B4),
recursive/megarepo tree diff (B5), and a **commit-graph-present** commit walk (B7 — the
existing `log.bench.ts` fixtures carry no commit-graph, so B7's path is unmeasured).

This is a **test-infra-only** part: NO `src/` delta, so it is legitimately standalone
(sizing-rules exception for fixtures/harness). It carries real work (a commit-graph fixture
variant + three bench scenarios), not a bare "run the suite".

Files / symbols:
- `test/bench/support/fixture-generator.ts` → fixture specs (L52–120) and the generator
  (`ensureScaledFixture` L469, `runGit`-style repo build). `MEDIUM_FIXTURE` (5 000 commits /
  20 000 blobs, L60) already serves as the megarepo for B5. Add a fixture VARIANT that runs
  `git commit-graph write --reachable` after building the repo (a new `FixtureSpec` flag or
  a derived fixture) so B7's graph path is exercised. Bump `FIXTURE_GENERATOR_VERSION`
  (L25) if the on-disk shape changes so cached fixtures regenerate.
- New / extended benches (mirror the existing `scaledScenario`/`tieredScenario` shape in
  `test/bench/support/scaled-bench.ts` + `tiered-bench.ts`; keep tsgit-only where there is
  no iso-git analog, as `diff.bench.ts` does):
  - **B4** — `test/bench/diff-whitespace.bench.ts` (or extend `diff.bench.ts`):
    `repo.diff({ from:'HEAD~1', to:'HEAD', ignoreWhitespace:'all' })` on `MEDIUM_FIXTURE`,
    compared to plain-mode diff (target ~2× plain, flat memory).
  - **B5** — `test/bench/diff-recursive.bench.ts`:
    `repo.diff({ from:'HEAD~1', to:'HEAD', recursive:true })` on `MEDIUM_FIXTURE`.
  - **B7** — extend `log.bench.ts` (or a new `commit-graph-walk.bench.ts`) to walk the
    commit-graph-enabled fixture so the graph path is measured against object-read walks.

### TDD steps

- Add the commit-graph fixture variant to `fixture-generator.ts`; add the three bench
  scenarios.
- Smoke-run the new benches locally with the scaled/tiered harness (correctness of the
  scenario wiring only — NOT a perf assertion; the nightly measures numbers). Confirm
  `npm run bench:check` (`tooling/bench-check.ts`) and the bench-config still parse the
  suite.
- No RED/GREEN/REFACTOR product cycle — this part ships fixtures + bench scenarios; the
  `src/` behaviour was landed by Parts 8/9/11.

### Gate

`npx vitest run --config vitest.bench.config.ts test/bench/diff-whitespace.bench.ts test/bench/diff-recursive.bench.ts test/bench/log.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/support/fixture-generator.ts test/bench/diff-whitespace.bench.ts test/bench/diff-recursive.bench.ts test/bench/log.bench.ts`
(the `vitest bench` run is a wiring smoke-check, not a perf gate; if the bench config only
runs under `npm run test:bench`, substitute that.)

### Commit

`test(bench): add whitespace, recursive-diff, and commit-graph walk scenarios`
