# Design — close the isomorphic-git performance gap + sfdx-git-delta backend spike findings

> Brief: ONE PR merging two source tracks. **Track A** closes the four losing
> nightly-bench scenarios (delta-chain `readBlob` 0.15×, log walk 0.55×, status
> clean 0.4×, cold-LRU `readBlob` 0.71×), root-caused and verified 2026-07-26
> (nightly run 30190673126). **Track B** lands the eight findings from the
> sfdx-git-delta backend spike (empty-tree read, export/binding drift, whitespace
> diff, tree-diff representation tax, walkTree per-entry cost, commit-graph read
> support, handle lifecycle) benchmarked on the sfdx-git-delta repo (824 commits)
> and a synthetic megarepo (16,050 files) against tsgit 3.1.0. Twelve fixes
> (A1–A4, B1–B8), merged scope. The prime directive binds: A2/A3/B1 must match
> canonical git byte-for-byte, pinned empirically below.
> Status: decisions settled — ADRs 509–516 (DC-1…DC-8 resolved); designed &
> self-reviewed to convergence.

## Context

### Subsystems this touches

| Fix | File / symbol | Tier |
|---|---|---|
| A1 | `src/application/primitives/object-resolver.ts` → `resolveObject`, `resolvePackChain`, `resolveBaseForRefDelta`, `enforceCachedCap`, `finalize` | primitive |
| A2 / B7b | `src/application/primitives/object-resolver.ts` → `tryLoose`, `looseCompressedBytes`; `src/application/primitives/pack-registry.ts` → `createPackRegistry`, `RegisteredPack`; `src/application/primitives/path-layout.ts` → `looseObjectPath` | primitive |
| A3 | `src/application/primitives/compare-working-tree-entry.ts` → `compareWorkingTreeDelta`; `src/domain/git-index/index-entry.ts` → `isStatClean`; `src/application/primitives/internal/index-entry-from-stat.ts` → `indexEntryFromStat`; `src/application/primitives/read-index.ts` → `readIndex`; `src/application/commands/status.ts` → `scanWorkingTree`; `src/ports/file-system.ts` → `FileStat` | primitive + domain + command |
| A4 / B8 | `src/adapters/node/node-file-system.ts` → `readSlice`, `openWithNoFollow`; `src/application/primitives/pack-registry.ts` → `RegisteredPack`; `src/application/primitives/object-resolver.ts` → `readEntryHeaderWithChunk`; `src/repository.ts` → `openRepository`, `dispose`; `src/dispose-adapters.ts`; `src/ports/file-system.ts` → `FileHandle` | primitive + adapter + port + facade |
| B1 | `src/application/primitives/object-resolver.ts` → `resolveObject`; `src/domain/objects/object-id.ts` → `EMPTY_TREE_OID`; `src/domain/objects/tree.ts` → `parseTreeContent` | primitive + domain |
| B2 | `src/public-types.ts` (L32 `export type *`); `src/index.node.ts` / `src/index.default.ts` / `src/index.browser.ts` / `src/index.ts`; `src/domain/diff/similarity.ts` → `MAX_SCORE`, `toSimilarityPercent`; `src/domain/diff/index.ts` | barrel + domain |
| B3 | `src/application/primitives/flatten-tree.ts` → `flattenTree`; `src/application/primitives/index.ts`; `src/repository.ts` → `BindCtx`, `primitives` table (L266–290 types, L680–732 runtime) | facade + primitive |
| B4 | `src/application/commands/diff.ts` → `diff`, `DiffOptions`, `resolveDiffOptions`; `src/application/primitives/diff-trees.ts` → `diffTrees`, `applyLinePassAndStat`; `src/domain/diff/whitespace.ts` → `normalizeLine`, `linesEqualUnder`, `LineKey`; `src/domain/diff/line-diff.ts` → `diffLines`, `splitLines`; `src/application/primitives/stream-blob.ts` → `streamBlob` | command + primitive + domain |
| B5 | `src/domain/diff/tree-diff.ts` → `diffTrees`, `treeEntryCompare`; `src/application/primitives/diff-trees.ts` → `diffRecursive`, `blobProjection`; `src/domain/objects/tree.ts` → `parseTreeContent`; `src/domain/objects/object-id.ts` → `ObjectId.fromRaw`, `SHA1_HEX_RE` | domain + primitive |
| B6 | `src/application/primitives/walk-tree.ts` → `walkTree`; `src/application/primitives/types.ts` → `WalkTreeEntry`, `WalkTreeOptions` | primitive |
| B7 / B7b | `src/application/primitives/walk-commits.ts` → `walkCommits`; `src/application/primitives/walk-commits-by-date.ts` → `walkCommitsByDate`; `src/application/primitives/internal/commit-date-walk.ts` → `commitDateWalk`; `src/domain/commit/binary-heap.ts`; **new** commit-graph parser (domain — single-file **and** chain/split) + reader (primitive) with bounded parent-frontier prefetch and a per-`Repository` commit-header cache, all via the `FileSystem` port | primitive + domain + port |
| B8 | (see A4 / B8 above) | facade + port |

All twelve land at or below the primitive tier or behind an existing port, so
browser and memory adapters inherit the wins through the shared `Context`/port
surfaces — no per-adapter fork. The load-bearing shared state: `Context.deltaCache`
(an existing 16 MiB-bounded `LruCache<Uint8Array>` created once per repo), the
per-`Context` `PackRegistry` (WeakMap-cached in `read-object.ts`; now also the owner of
the persistent per-pack `FileHandle`s from A4/ADR-510), and — new for B7 — a
per-`Context` parsed commit-graph (single-file *or* chain/split) plus a per-`Repository`
commit-header cache, both read through `ctx.fs`.

### Prior decisions that constrain this design

- **ADR-226 — git-faithfulness prime directive.** Observable behaviour (object
  SHAs, refusal conditions, on-disk state, *object-store precedence*) is
  byte-for-byte git unless a *new* ADR explicitly diverges. Governs A2/B7b (object
  precedence), A3 (`ie_match_stat`), and B1 (empty-tree virtual object).
- **ADR-249 — `describe`/structured data, not cosmetics.** Faithfulness binds the
  DATA and on-disk state, *not* rendered stdout. Refines A2/B7b's precedence
  question (the corrupt-loose stderr warning is a diagnostic, not data — see DC-1)
  and directly constrains B2 (`toSimilarityPercent` is a *display* helper) and B6
  (no batch shape that leaks rendering).
- **`docs/design/checkcontainment-hot-path.md` DC-7 — "STAY FAITHFUL / reorder
  rejected".** Already pinned git as **loose-first** and rejected a pack-first
  reorder of `resolveObject`; its object-store loose-probe optimisation was
  implemented then **reverted** for a cold-read regression. `hasObject`
  (`has-object.ts`) is *already* pack-first (a pure-presence probe, correctly
  divergent from the content read). A2/B7b re-opened exactly this ground — the brief
  asked for the reorder DC-7 rejected. This design re-pinned git from scratch (below);
  DC-1 was settled by **ADR-509**, which upholds checkcontainment DC-7 (loose-first
  preserved) and amortises the probe with a loose-oid cache rather than reversing the
  accepted decision.
- **ADR-209 — mutualize work-vs-index comparison into one primitive.** Names
  `compareWorkingTreeDelta`/`compareWorkingTreeEntry` as the single source of truth
  for "is this index entry dirty?", consumed by `status`, `rm`, `stash`,
  clean-work-tree, apply-merge, and explicitly calls out "the natural home for the
  future stat-cache fast path (perf priority #5)." A3 realises that extension point.
- **ADR-150 / ADR-050 — generation-tracking cache invalidation / racy-stat.** The
  `CachingIndexResolver` already uses a generation counter + mtime/ns stat-match + a
  SHA-trailer racy fallback. A3's per-entry racy-clean guard reuses the same racy
  concept; the loose-oid cache (ADR-509) reuses the same generation-counter
  invalidation.
- **ADRs 378–382 — whitespace-diff-options (24.14).** Surfaced the structured
  `WhitespaceMode` on the diff options; B4 optimises the path those ADRs shipped
  (the spike's O(blob-bytes) strip-and-compare is exactly what B4 replaces).
- **ADR-243 — `diff` public `recursive` flag (24.12).** Recursive tree diff is
  public; B5 optimises its hot loop (`diffRecursive`/`diffTrees`).
- **ADR-239 — keep `walkTree`/`walkWorkingTree` public, snapshot additive.** B6's
  batching must stay additive to the public `walkTree` surface.
- **ADR-471 / ADR-485 / ADR-486 — deep-delta-chain bench fixture; status-clean
  containment-tax amortisation.** A1/A4 lean on the deep-chain fixture; A3 composes
  with 26.4's `checkContainment` + `parentRealpathCache` work.

### Current code shape (the redundancies being removed)

**Track A — `resolveObject`** resolves loose-first, then pack, and only *writes* the
delta cache:

```ts
// object-resolver.ts
export async function resolveObject(ctx, registry, id, verifyHash, maxBytes) {
  checkAborted(ctx);
  const loose = await tryLoose(ctx, id);                 // A2: fs.exists probe per object
  if (loose !== undefined) { enforceLooseCap(...); return finalize(ctx, id, loose, verifyHash); }
  const hit = await registry.lookup(id);                 // linear scan over packs, fanout binary search within
  if (hit === undefined) throw objectNotFound(id);
  const bytes = await resolvePackChain(ctx, registry, hit, id, maxBytes); // A1 writes cache, A4 per-step readSlice
  return finalize(ctx, id, bytes, verifyHash);
}
async function tryLoose(ctx, id) {
  const path = looseObjectPath(commonGitDir(ctx), id);
  if (!(await ctx.fs.exists(path))) return undefined;    // realpath-follow + internally-thrown ENOENT per object
  const compressed = await ctx.fs.read(path);
  return ctx.compressor.inflate(compressed);
}
```

`resolvePackChain` (L288–289) caches the reconstructed object under `targetId`, and
`resolveBaseForRefDelta` (L367) is the **only** reader. Because `git repack` emits
OFS deltas, `resolveBaseForRefDelta` is never reached on a repacked repo — the cache
is **write-only**, so every warm read of the same target replays the whole chain
(A1). `enforceCachedCap` + `finalize` already implement the exact "return cached
loose-format bytes safely" path A1 needs (`enforceCachedCap` measures
`cached.length - (nulIdx + 1)` against the cap; `finalize` honours `verifyHash` +
`parseObject`). `readSlice` (node) does, **per call**: `checkContainment('read')` →
`open` → `Buffer.alloc(length)` (zero-fill) → `handle.read` → `Uint8Array.from(copy)`
→ `finally close()`; `collectDeltaChain` calls it once per chain step, so a 43-deep
OFS chain issues **43 sequential open+alloc+read+copy+close round-trips** (A4).
`compareWorkingTreeDelta` always `lstat`s then — for a regular file — **reads and
SHA-1-hashes the whole working file**; there is no stat-cache short-circuit (A3).
`isStatClean(entry, stat)` exists in `index-entry.ts` but compares a `StatData` (not
a `FileStat`), compares every field exactly (no 32-bit truncation, no racy guard),
and is currently unused. `readIndex` `stat`s `.git/index` for a size pre-check but
**discards the mtime** the racy guard needs; `indexEntryFromStat` writes
`mtimeNanoseconds: 0`, so tsgit-staged entries carry **no ns precision**.

**Track B — key current shapes:**

- **B1.** `readObject → resolveObject` is the single object-store read choke point
  (`readTree`, `catFile`, `walkTree`, `archive`, `diff` all funnel through it).
  `EMPTY_TREE_OID` (`object-id.ts:32`) is exported (SHA-1 only; **no SHA-256
  constant**) but feeding it into `resolveObject` throws `OBJECT_NOT_FOUND` unless
  the object was physically written.
- **B2.** `src/public-types.ts:32` does `export type * from './domain/diff/index.js'`.
  `export type *` **strips runtime values**, so `MAX_SCORE` (a `const`) and
  `toSimilarityPercent` (a function) — both re-exported as *values* from
  `domain/diff/index.ts` — reach the built `.d.ts` as declared exports but are
  **absent from the runtime bundle**. (The brief's "barrel drift" framing is the
  symptom; the `export type *` is the mechanism.)
- **B3.** `flattenTree` (`flatten-tree.ts:20`) is exported from the primitives
  barrel (`primitives/index.ts:36`) but **missing** from `repository.ts`'s
  `primitives` table (types L266–290, runtime L680–732) — a wiring-drift twin of B2
  on the facade axis. `diffRecursive`/`blobProjection` (B5) already compose
  `flattenTree` internally.
- **B4.** `diff.ts` folds `DiffOptions.ignoreWhitespace` → `DiffTreesOptions`;
  `diff-trees.ts` `applyLinePassAndStat` materialises every modified blob pair,
  string-decodes, `splitLines`, `normalizeLine`-per-line and runs `diffLines`
  (Myers) — **even when the caller only needs the boolean "did anything survive?"**.
- **B5.** `diffTrees` (`tree-diff.ts:53`) merge-joins pre-sorted entries;
  `parseTreeContent` (`tree.ts:31`) calls `ObjectId.fromRaw(rawHash)` **per entry**,
  which runs `ObjectId.from(bytesToHex(bytes))` → `SHA1_HEX_RE.test(hex)` (the
  hot-loop regex) and a `TextDecoder` for mode/name — every ~29k unchanged entry
  pays hex-conversion + branding-regex + decode.
- **B6.** `walkTree` (`walk-tree.ts:32`) is an `async function*` yielding **one
  `WalkTreeEntry` at a time** (recursive DFS via `yield*`); one promise per entry.
- **B7.** `walkCommits` (`walk-commits.ts:25`) uses a plain FIFO array;
  `walkCommitsByDate` → `commitDateWalk` uses the `BinaryHeap` date queue. **No
  commit-graph support exists** — every parent/date comes from a full
  `readCommit → readObject` loose-then-pack scan.
- **B8.** `openRepository` (`repository.ts:369`) holds a frozen `Context`, one
  `AbortController`, the `deltaCache` LRU, the pack-registry WeakMap, and the
  promisor/transport closures. **No persistent OS file handles or watchers today** —
  FDs are opened per-operation and closed in `finally`; there is **no `unref`, no
  idle-close, no `[Symbol.asyncDispose]`** — everything lives until explicit
  `dispose()`. The `FileHandle` port (`file-system.ts:34`, `openWithNoFollow`) has a
  single in-scope caller (`working-tree.ts:59`).

## Empirically pinned matrices (git 2.55.0)

Pinned per `.claude/workflow/faithfulness.md`: each probe ran in a `mktemp -d`
throwaway with `GIT_*` scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing
off, then cleaned up. These are the load-bearing external behaviours the faithful
fixes must match.

### Pin A — object-store precedence: git CONSULTS LOOSE even with a valid pack (A2 / B7b)

Setup: `hash-object -w` a blob (loose), `pack-objects` it into a registered pack
**without `-d`** so the object exists in **both** stores (`verify-pack` confirms the
oid is in the pack; deleting the loose copy and reading proves the pack alone
serves it). Then recreate the loose copy as **non-zlib garbage** and read:

| Command | stdout | stderr | exit |
|---|---|---|---|
| `git cat-file -p <oid>` | `hello-precedence-probe-content` (pack copy) | `error: inflate: data stream error (incorrect header check)` | 0 |
| `git cat-file --batch` | `<oid> blob 23\n<content>` (pack copy) | `error: inflate: data stream error (incorrect header check)` | 0 |

git **surfaces the corrupt loose object's inflate error** on both the `-p` and the
`--batch` (`readObject`) paths, *even though a valid pack copy exists*, then falls
back to the pack for the content. A pure **pack-first-and-stop** implementation would
find the object in the pack and **never touch the corrupt loose copy**, so it would
not surface that error. Reproduced identically to `checkcontainment-hot-path.md`'s
DC-7 pin, now re-confirmed on git 2.55.0.

**Consequence for A2/B7b:** the brief's premise — *"Pack-first is MORE git-faithful:
canonical git runs `find_pack_entry` before `loose_object_info`"* — **does not survive
the pin.** In the both-stores case git demonstrably consults loose and surfaces its
error. Reordering `resolveObject` to pack-registry-first therefore changes an
observable (which store answers, and the error surfaced when the winning store's copy
is corrupt) and is a **divergence from ADR-226**. The returned *data* is byte-identical
in every healthy case, and ADR-249 refines faithfulness to bind data/state not stderr
— so whether this diagnostic difference is faithfulness-binding was the call in DC-1.
**Settled by ADR-509:** keep loose-first precedence (upholding ADR-226 and
checkcontainment DC-7) and remove the probe cost with a per-fanout-dir loose-oid cache —
no divergence.

### Pin B — empty tree is a virtual always-present object; empty blob is NOT (B1)

| oid (never written) | `cat-file -t` | `cat-file -s` | `cat-file -p` | `diff EMPTY..HEAD` |
|---|---|---|---|---|
| `4b825dc6…` empty **tree** | `tree` (exit 0) | `0` (exit 0) | *(empty, exit 0)* | `A\tf.txt` (exit 0) |
| `e69de29b…` empty **blob** | `fatal: could not get object info` (exit 128) | — | `fatal: Not a valid object name` (exit 128) | — |
| `hash-object -t tree /dev/null` | → `4b825dc642cb6eb9a060e54bf8d69288fbee4904` | | | |

git treats the empty **tree** as virtual anywhere a tree-ish is valid — but **only
the empty tree**, never the empty blob (which errors like any missing object).

**Consequence for B1:** synthesize a `tree 0\0` object (loose-format header `tree 0`,
NUL, zero content bytes) **only** for the empty-tree oid of the active hash algo —
not a general "size 0" rule and not the empty blob.

### Pin C — racy-clean re-hash + assume-valid + skip-worktree (A3)

| Scenario | `status --porcelain` | Meaning |
|---|---|---|
| same-size edit, file mtime == index mtime | `AM f.txt` | git **re-hashed** despite matching size+mtime → racy ⇒ re-hash |
| `update-index --assume-unchanged`, then longer edit | *(no `M`)* | `CE_VALID` ⇒ unconditionally clean |
| `update-index --skip-worktree`, then edit | *(no `M`)* | worktree side skipped entirely |

**Consequence for A3:** the stat-cache short-circuit MUST (i) treat `assumeValid`
entries as unconditionally clean, (ii) skip `skipWorktree` entries, (iii) fall back
to read+hash when the entry mtime is `>=` the index file's own mtime (racy).
Without (iii), a same-second same-size edit is missed — a correctness bug. The index
file's own mtime must be plumbed into the comparator (ADR-511).

### Pin D — commit-graph on-disk format (B7)

`commit-graph write --reachable` on a 5-commit repo → `.git/objects/info/commit-graph`
(1412 bytes). Header + chunk table decoded from the raw bytes:

```
43 47 50 48  01 01 04 00     magic "CGPH", version 1, hash-version 1 (SHA-1=1/SHA-256=2), 4 chunks, 0 base graphs
4f 49 44 46  00 00 00 00 00 00 00 44   OIDF @   68  (256 × u32 fanout          = 1024 B)
4f 49 44 4c  00 00 00 00 00 00 04 44   OIDL @ 1092  (N × 20-byte oid, sorted   =  100 B)
43 44 41 54  00 00 00 00 00 00 04 a8   CDAT @ 1192  (N × 36 B: tree oid[20] + parent1 pos[4] + parent2 pos[4] + gen/date[8])
47 44 41 32  00 00 00 00 00 00 05 5c   GDA2 @ 1372  (N × u32 generation-data v2 =   20 B)
00 00 00 00  00 00 00 00 00 00 05 70   sentinel → chunk-data end @ 1392, then 20-byte trailer ⇒ file 1412
```

Self-consistent: 1092−68=1024 (fanout), 1192−1092=100 (5×20), 1372−1192=180 (5×36),
1392−1372=20 (5×4), 1392+20=1412. Parent positions use the sentinels `0x70000000`
(no parent) and `0x80000000|edge-pos` (octopus → EDGE chunk).

**Chain/split form** (pinned on git 2.55.0: two `git commit-graph write --reachable
--split=no-merge` passes, 3 then 2 commits ⇒ a 2-layer chain, `GIT_*` scrubbed / signing
off / isolated `HOME`). `.git/objects/info/commit-graphs/commit-graph-chain` holds one
lowercase-hex layer hash per line, **base→tip**, and there is one `graph-<hash>.graph`
per layer:

| Layer | header bytes 0–7 | num-chunks | num-base-graphs | chunks | commits |
|---|---|---|---|---|---|
| base `ef664751…` | `43 47 50 48 01 01 04 00` | 4 | 0 | OIDF, OIDL, CDAT, GDA2 | 3 (global pos 0–2) |
| tip `d823c2d1…` | `43 47 50 48 01 01 05 01` | 5 | 1 | OIDF, OIDL, CDAT, GDA2, **BASE** | 2 (global pos 3–4) |

- **`num-base-graphs`** = header **byte 7** (0 on the base layer, 1 on the tip). It
  equals the number of 20-byte oids in that layer's **`BASE` chunk**, which lists the
  base layers' graph hashes — the tip's `BASE` chunk (20 bytes, verified) holds exactly
  the base layer's own hash `ef664751…`.
- **Cross-layer position resolution:** a layer's OIDL/CDAT are addressed by a *global*
  position = (Σ commit counts of all base layers) + local index. The base owns positions
  0–2, the tip owns 3–4. A parent position `p` recorded in the tip resolves to the base
  layer when `p < 3`, else to the tip at `p − 3`. EDGE/GDA2 are read per layer with the
  same base-offset arithmetic.
- **Staleness (pinned):** delete a referenced layer file then `git -c
  core.commitGraph=true rev-list --all` ⇒ **exit 0** with `warning: unable to find all
  commit-graph files` on stderr; git silently falls back to object reads. So a chain that
  references a missing `graph-<hash>.graph` ⇒ treat the whole graph as **absent**.

**Consequence for B7 (ADR-516 — full chain/split scope):** the parser reads the chunk
table by id (not fixed offsets) and handles **both** on-disk forms — the single
`objects/info/commit-graph` and the chain (`commit-graphs/commit-graph-chain` +
per-layer `graph-<hash>.graph`). For the chain it walks layers base→tip, links them via
the `num-base-graphs` byte and the `BASE` chunk, resolves parent positions against the
concatenated global ordering (base-offset arithmetic above), and treats a chain that
references a missing layer as **absent**. It serves `root-tree / parents / commit-date /
generation` from CDAT+GDA2+EDGE and **falls back to `readObject`** for any commit not in
the graph (or if the graph is absent/stale). The commit-graph is git's own cache, so a
correct parser yields parents/dates *identical* to object reads — generation numbers
only accelerate pruning/ordering, never change the visible commit set or order.

## Requirements

1. **A1 — warm delta reads reuse the reconstructed object.** After `resolveObject`
   reconstructs a packed target once, a second `resolveObject(id)` returns from
   `deltaCache` without re-walking the chain — for OFS-delta packs, not only
   REF-delta. `maxBytes` and `verifyHash` semantics byte-identical to the non-cached
   path.
2. **A2/B7b — no wasted per-object loose I/O on packed walks**, without violating the
   pinned loose-first precedence — via the per-fanout-dir loose-oid cache (ADR-509),
   not a pack-first reorder.
3. **A3 — clean tracked files are not read or hashed during `status`** when their
   index stat matches, faithful to `ie_match_stat` (Pin C): assume-valid ⇒ clean;
   skip-worktree ⇒ skipped; racy ⇒ re-hash; 32-bit ino/size; ns only when the
   platform supplies it. Dirty/absent/type-changed/mode-changed verdicts unchanged.
4. **A4 — cold delta-chain walks do not pay a per-step open/close** (a 43-deep chain
   reads its slices without 43 FD lifecycles).
5. **B1 — the empty-tree oid is readable everywhere** (catFile/readTree/walkTree/
   archive/diff) without a physical write, matching git's virtual object (Pin B);
   diff from `EMPTY_TREE_OID` on a repo that never wrote it matches git.
6. **B2 — every declared public *value* export is defined at runtime**, enforced by a
   permanent guard test that diffs the built `.d.ts` value exports against the built
   runtime bundle (kills the class, not just two symbols).
7. **B3 — `flattenTree` is bound on `repo.primitives`**, enforced by a guard test that
   audits the `repository.primitives` binding table against the primitives-barrel
   export list (every exported primitive bound or on an explicit exclusion list).
8. **B4 — whitespace-mode diff is within ~2× of plain-mode diff, flat memory**, by
   splitting the drop-pass predicate ("did any significant change survive?") from
   stat counting.
9. **B5 — recursive tree diff over the megarepo is competitive with git**; ~29k
   unchanged entries pay no hex-conversion / path-decode / branding-regex, and equal-
   oid subtrees are pruned before any entry materialisation.
10. **B6 — bulk tree traversal reduces the per-entry async overhead** of `walkTree`,
    additively to the public surface (ADR-239).
11. **B7 — commit walking is git-competitive via commit-graph read** in **both** on-disk
    forms (single-file and chain/split), with fallback to object reads for commits absent
    from the graph (or a stale chain); visible commit set/order/parents/dates identical to
    the object-read walk. Bounded parent-frontier prefetch and a per-`Repository`
    commit-header cache back the walk (ADR-516).
12. **B8 — a process that opens a repo, runs one diff, and returns without `dispose()`
    exits within N seconds**, and this stays true even if A4 introduces persistent
    handles.
13. **No regression on the winning benches** — pack-read warm/cold medium (360×/8.2×),
    clone, status-dirty, blob reads — confirmed by the bench suite. All published perf
    numbers come from the CI nightly bench artifact, never local runs.
14. **Adapter-agnostic** — every change at/below the primitive tier or behind an
    existing port; the commit-graph read goes through the `FileSystem` port.
15. **Structured output preserved (ADR-249)** — no rendering options or pre-rendered
    strings on any new/changed surface.

## Design

### Track A

#### A1 — read the delta cache for the target id at the top of `resolveObject`

Add a cache probe as the first step of `resolveObject`, composing the two helpers
that already exist for exactly this:

```ts
export async function resolveObject(ctx, registry, id, verifyHash, maxBytes) {
  checkAborted(ctx);
  const cached = ctx.deltaCache.get(id);
  if (cached !== undefined) {
    enforceCachedCap(id, cached, maxBytes);       // same cap the REF-delta reader uses
    return finalize(ctx, id, cached, verifyHash); // honours verifyHash + parseObject
  }
  const loose = await tryLoose(ctx, id);
  …
}
```

**Faithfulness.** The cache is keyed by `ObjectId` and populated only from
`resolvePackChain`/`serializeObject`, which produce the canonical loose-format
`<type> <size>\0…` bytes for that oid. Object content is oid-determined, so cached
bytes are byte-identical to a loose or pack read of the same oid — probing the cache
before `tryLoose` cannot change *content* (it is not a precedence question: A1 is
distinct from A2, whose precedence choice concerns which *on-disk store* answers a
miss). A poisoned entry is still caught: `finalize` runs `verifyHash` when requested,
`enforceCachedCap` re-applies `maxBytes`. A miss falls through to the existing
loose→pack path. **Memory:** reads only, no new entries; the 16 MiB LRU bound is
unchanged. **Verified (brief):** warm delta-chain `readBlob` 4.17 → 0.005 ms; warm
log-small 5.97 → 0.53 ms; log-medium 13.8 ms vs iso-git 294 ms.

#### A2 / B7b — eliminate the wasted per-object loose probe (ADR-509 — loose-oid cache)

The cost is real and independent of the precedence question: on a packed repo every
object misses loose, so `tryLoose`'s `ctx.fs.exists(loosePath)` pays an uncached
`realpath`-follow plus an internally-thrown ENOENT per object (14 % of log samples in
`handleErrorFromBinding`, brief). B7b (probe order in commit walking) is the *same*
probe on the same path — one implementation.

**Settled — ADR-509: keep loose-first, amortise with a per-fanout-dir loose-oid cache
(git's `odb_loose_cache`).** The pinned precedence (Pin A) is preserved exactly; the
per-object `ctx.fs.exists` is replaced with an in-memory sorted-oid-set membership test
built lazily once per fanout dir (`objects/xx`, ≤256) by a single `readdir`. A full
history walk pays ≤256 `readdir`s instead of thousands of `realpath`+ENOENT probes; a
membership hit is still read via `ctx.fs.read`, so the containment gate, corrupt-loose
error surfacing (Pin A), and escaping-symlink handling are byte-for-byte unchanged.
Cache invalidation reuses the ADR-150 generation counter (bumped on loose write/prune).
B7b consumes the same cache — the commit walk's object-store probes go through it.

**Rejected alternatives** (recorded in ADR-509): *pack-first reorder* — kills the probe
but Pin A shows it diverges (serves the pack copy silently where git surfaces the
corrupt-loose error), needing a divergence ADR against ADR-226 and overturning
checkcontainment DC-7; *cheaper per-object probe* (fold `exists`+`read`, realpath-cached
`lstat`) — faithful but un-amortised, and previously regressed the cold single read
(+0.011 ms).

#### A3 — `ie_match_stat`-faithful stat-cache short-circuit in `compareWorkingTreeDelta`

Insert a fast path after the `lstat` and the `type-changed` guard, before read+hash:

```ts
const stat = await ctx.fs.lstat(absPath).catch(() => undefined);
if (stat === undefined) return { status: 'absent' };
const worktreeMode = deriveWorkingMode(stat);
if (entry.mode !== FILE_MODE.GITLINK && !isSameKind(worktreeMode, entry.mode))
  return { status: 'type-changed', worktreeMode };

// NEW — stat-cache short-circuit (only when the racy-guard timestamp is supplied)
if (isEntryStatClean(entry, stat, indexMtime))
  return { status: worktreeMode === entry.mode ? 'unchanged' : 'mode-changed', worktreeMode };
// …existing read + clean-filter + hash path unchanged for every non-clean case…
```

`isEntryStatClean(entry, stat: FileStat, indexMtime)` encodes git's `ie_match_stat`,
pinned in Pin C, field-by-field against `match_stat_data`/`ce_match_stat_basic`:

- **assume-valid ⇒ clean** regardless of stat (`CE_VALID`).
- **skip-worktree** handled at the caller (`scanWorkingTree` already skips these — the
  comparator never runs on them).
- **racy-clean guard.** If entry mtime `>=` the index file's own mtime (`indexMtime`),
  the stat is racy — do **not** short-circuit; fall through to read+hash. Compare
  seconds, and ns when both sides have it.
- **content-stat field comparison** (non-assume-valid, non-racy): mtime (sec, +ns when
  available), ctime (sec, +ns when available), uid, gid, ino, size; **dev NOT compared**
  (git's default build has `USE_STDEV` off). ino/size compared **32-bit-truncated**
  (`x >>> 0`) to match the index's on-disk field width. Any mismatch ⇒ read+hash. This
  is git's default `core.checkStat=true` + `trust_ctime=true` field set; `core.checkStat=
  minimal` (mtime+size only) is honoured-or-noted per §Out of scope.
- **mode is NOT an `isEntryStatClean` field.** A content-clean stat with a differing
  exec bit is reported `mode-changed` by the snippet's ternary **without a hash** —
  git trusts the stat cache for content and reads the mode from the stat, so a pure
  exec-bit change never re-hashes. (`isEntryStatClean` returning true means "content
  unchanged per the stat cache"; the mode verdict is the caller's ternary.)
- **ns availability.** `FileStat.mtimeNs`/`ctimeNs` are optional; compare ns only when
  present (git's non-`USE_NSEC` path), mirroring `CachingIndexResolver.needsRacyCheck`.

**Two supporting sub-changes (both required for the win to fire):**

1. **Plumb the index's own mtime (ADR-511).** `readIndex` already `stat`s `.git/index`;
   surface that mtime (sec + ns) to `status`, which passes it into
   `compareWorkingTreeDelta` as a new **optional** argument. When absent (every
   non-`status` ADR-209 consumer — `rm`, `stash`, clean-work-tree, apply-merge), the
   short-circuit is **disabled** and the comparator behaves exactly as today. Only
   `status` opts into the fast path initially.
2. **Populate ns in `indexEntryFromStat`.** Today it writes `mtimeNanoseconds: 0`, so a
   tsgit-staged entry never matches a real file's ns and the fast path never fires on a
   tsgit-written index (git-written indexes carry real ns and already work). Derive ns
   from `stat.mtimeNs`/`ctimeNs` when available. This is *more* git-faithful but
   **changes serialized index bytes** → index-write goldens/interop must be re-pinned
   against git in the same change (a stale golden reds the gate — see §Test strategy).

**Faithfulness.** Every short-circuit outcome is a verdict git would produce; dirty
files never reach the clean return (a content edit changes size or mtime; a same-size
same-mtime edit is caught by the racy guard). The read+hash path (symlink `readlink`,
clean-filter, catch→`modified`) is untouched. **Verified (brief):** status-small 17.1
→ 5.8 ms (iso 7.0); status-medium → 483 ms vs iso 686 ms.

#### A4 — cut per-step I/O in the delta-chain walk (ADR-510 — persistent per-pack handles, joint with B8)

Measured problem is a **cold single chain**: 43 sequential `readSlice` calls, each a
full open+alloc+read+copy+close, keeping cold delta-chain `readBlob` at 4.2 ms vs
iso-git's 1.07 ms (iso slurps the whole pack once). **Settled — ADR-510:** the pack
registry owns one lazily-opened persistent `FileHandle` per pack (via the existing
`FileHandle` port), and the chain walk issues all its slice reads against that handle —
**one `open` per pack, not per step** — closing it in `dispose()`. Because an idle Node
`fs` `FileHandle` does not ref the libuv loop, this preserves B8's exit-without-
`dispose()` invariant (the joint reconciliation is B8, below). Alongside, the
`Buffer.alloc` zero-fill and the `Uint8Array.from` full copy in `readSlice` are trimmed
(allocate exactly `bytesRead`, avoid the double copy) as a faithful micro-win.
**Rejected** (ADR-510): a windowed per-pack byte cache (memory-bounding cost on
multi-GB packs) and a `(packPath,offset)` intermediate-base cache (cross-object reuse,
not the single-chain fix — the A1 target-id cache already covers the warm case).
**Verified (brief):** cold delta-chain `readBlob` 4.2 → toward 1.07 ms.

### Track B

#### B1 — synthesize the empty tree at the object-store read layer

At the very top of `resolveObject` — **before A1's `deltaCache` probe** and any
loose/pack lookup (the deepest single choke point: covers `readObject`, `readTree`,
`catFile`, `walkTree`, `archive`, `diff`, and even the pathological
empty-tree-as-delta-base) — intercept the empty-tree oid **for the active hash algo**
and return the synthesized object:

```ts
if (id === emptyTreeOid(ctx.hashConfig)) {
  return parseObject(id, EMPTY_TREE_BYTES, ctx.hashConfig); // "tree 0\0", zero entries
}
```

- **Scope (Pin B):** only the empty *tree*, never the empty blob or a general size-0
  rule. `EMPTY_TREE_BYTES` = `tree 0\0` (loose-format header, NUL, no content).
- **SHA-256.** `object-id.ts` ships only the SHA-1 `EMPTY_TREE_OID`. Add the SHA-256
  counterpart `EMPTY_TREE_OID_SHA256 = 6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321`
  and select by `ctx.hashConfig` (there is active SHA-256 plumbing via `HashConfig`).
- **Faithfulness.** `verifyHash` trivially holds (the oid *is* the empty-tree hash);
  `maxBytes` (size 0) never trips; the intercept short-circuits before
  `OBJECT_NOT_FOUND`, so the promisor lazy-fetch path never fires for the empty tree
  (correct — git never fetches it). **Interop:** diff from `EMPTY_TREE_OID` on a repo
  that never wrote it matches `git diff <empty-tree> HEAD`.

#### B2 — restore the runtime value exports + guard the class

Root cause is `export type *` in `public-types.ts:32` stripping runtime values, not a
per-symbol barrel omission. Fix + guard:

1. **Value-export the affected symbols at runtime** from the public entry (a `export {
   … } from './domain/diff/index.js'` value re-export, distinct from the `export type
   *`), so the runtime bundle matches the declared `.d.ts`. The audit must sweep
   **all** value exports of `domain/diff/index.ts`, not only `MAX_SCORE` /
   `toSimilarityPercent`.
2. **Permanent guard test** (kills the bug class): import the built
   `dist/esm/index.node.js` and parse the declared **value** exports out of the built
   `dist/types/index.node.d.ts`; assert every declared value export is `!== undefined`
   at runtime.

**ADR-249 tension — settled by ADR-512 (add the runtime exports).**
`toSimilarityPercent` converts a raw score to a *display* percentage (`similarity index
NN%`) — a rendering helper, so publishing it as runtime API sits awkwardly with
structured-output. But the `.d.ts` had already declared both symbols as values and a
consumer (sfdx-git-delta) shipped a local workaround, so ADR-512 adds the runtime value
exports to honour the published contract and stands `toSimilarityPercent` as a
**documented, narrow ADR-249 exception** — ADR-249 still bars *new* cosmetic surfaces;
this covers only the already-declared symbols. Rejected: removing both from the type
surface, and exposing the raw score only.

**Surface gates.** The new public runtime exports hit the api.json / README-count /
doc-coverage gates.

#### B3 — bind `flattenTree` on `repo.primitives` + guard the class

1. Add `flattenTree` to the `repository.ts` `primitives` type table (L266–290) and the
   runtime binding block (L680–732), following the existing `guard(); return
   primitives.flattenTree(ctx, …)` shape. `flattenTree` returns a `FlatTree` (a
   `Map<FilePath, FlatTreeEntry>`) — structured data, ADR-249-clean.
2. **Guard test:** audit the `repository.primitives` binding table against the
   primitives-barrel export list (`primitives/index.ts`); every exported `(ctx, …)`
   primitive is bound or on an explicit exclusion list. Same wiring-drift class as B2
   on the facade axis.

**Surface gates:** the barrel already exports it; binding it adds a
`repository.primitives.*` key → repository.test keys + api.json + README count +
doc-coverage + a browser scenario. B3 also gives B6 its documented "bulk path".

#### B4 — split the whitespace drop-pass predicate from stat counting

Today `applyLinePassAndStat` always runs the full string-decode + `splitLines` +
`normalizeLine`-per-line + Myers `diffLines` on every modified blob pair, even when the
caller only needs "does any significant change survive whitespace normalisation?"
(933 ms / 674 MB vs git 39 ms / 143 MB; profile 52% line-diff + 28% GC). Split the two
concerns:

- **Predicate path (drop-pass, no `withStat`).** Stream both blobs via `streamBlob`
  (`streamInflate` machinery), scan **raw bytes** line-by-line, fold the `WhitespaceMode`
  normalisation into a **rolling hash per line** (no string decode, no line arrays), and
  **early-exit on the first significant mismatch**. Equality needs no Myers alignment —
  a changed-only-by-whitespace pair collapses to "no significant change" without any
  alignment. `LineKey`/`normalizeLine`'s byte-level rules are reused, applied to the
  raw stream rather than decoded strings.
- **Stat path (`withStat: true`) keeps full line-diff** but, per **ADR-513**, interns
  normalised lines to ints first so Myers runs over int arrays (git's approach),
  collapsing the string/GC cost. Predicate and stat share one normalisation rule set so
  their verdicts stay provably consistent.

**Faithfulness.** The drop-pass verdict must equal git's "is this file changed under
`-w`?" — the predicate and the stat path must agree on which files survive; an interop
test pins both against `git diff --ignore-all-space`/`--ignore-space-change`/
`--ignore-space-at-eol`. Target: whitespace mode within ~2× plain-mode, flat memory.
Highest-value single perf fix in Track B.

#### B5 — tree-diff hot-loop representation tax

Megarepo recursive diff ~88 ms vs git ~15–20 ms; profile 30% tree parse/diff, 11.5%
`TextEncoder`/`TextDecoder`, 3.3% oid regex, 7.2% GC. Three independent steps, value
order:

- **(a) byte-level entry comparison in `diffTrees`** — compare mode+name+raw-oid at the
  byte level in the merge-join and materialise hex strings / decoded paths **only for
  emitted changes**; ~29k unchanged entries never hit `bytesToHex` or `TextDecoder`.
  **Settled — ADR-514:** this stays a `diffTrees`-local byte comparison; the internal
  oid remains a hex string elsewhere. A full end-to-end 20/32-byte `Uint8Array` oid
  representation (git's approach) is a whole-domain change, **foreclosed** to a future
  dedicated ADR.
- **(b) validate oids at API boundaries only.** `parseTreeContent` calls
  `ObjectId.fromRaw` → `ObjectId.from(bytesToHex(bytes))` → `SHA1_HEX_RE.test` **per
  entry**. `bytesToHex` emits only `[0-9a-f]` by construction on a length-checked 20/32-
  byte slice, so the regex re-validation is **provably vacuous**. Give `fromRaw` a
  trusted brand path (length-check + `bytesToHex`, no regex) — a faithful micro-fix
  (the observable is unchanged; a corrupt slice still fails the length check).
- **(c) prune equal-oid subtrees before materialisation.** In `diffRecursive`, a dir
  entry whose oid is unchanged (TREESAME) must not be flattened via `blobProjection` at
  all — skip the subtree before any entry is built.

#### B6 — cut `walkTree`'s per-entry promise cost

A 16.5k-entry recursive walk spends ~35–50 ms with 28.8% event-loop idle; per-entry
work is ~2 µs but the async-generator machinery doubles it. **Settled — ADR-515: bind +
document `flattenTree` (B3) as the bulk traversal path.** The eager `Map` builder is
already the zero-per-entry-promise route, and B3 lands its `repo.primitives` binding
anyway, so B6 is "bind + document" with **zero new surface** (ADR-239/249-clean).
`walkTree` keeps its per-entry streaming shape unchanged; a batched-yield option
(`WalkTreeEntry[]` per subtree) is **deferred to a future consumer-driven ADR** rather
than added speculatively.

#### B7 — commit-graph read support (ADR-516 — full chain/split scope; B7b folds into A2/B7b)

Add a **read-side** commit-graph path (Pin D): a domain parser
(`commit-graph.ts`, chunk-table-driven) + a primitive reader that serves
`root-tree / parents / generation / committer-date` from the graph, wired through
`ctx.fs` (adapter-agnostic). `walkCommits` / `walkCommitsByDate` consult the graph
first and **fall back to `readObject`** for any commit not in it (or if the graph is
absent/stale). Pairs with the existing `BinaryHeap` date queue; makes log, blame,
describe, merge-base, and rev-list-shaped walks git-competitive (824 commits ~95 ms →
toward git's 7.6 ms). **Settled — ADR-516 (deviating from the design's original
recommendation to defer chain/split): full chain/split scope, prefetch, and header
cache all land in this PR.** Sub-parts, all in scope:

- **(a) graph read + serve — both on-disk forms.** The parser handles the single
  `objects/info/commit-graph` file **and** the chain/split form (Pin D chain/split
  matrix): read `commit-graphs/commit-graph-chain` (base→tip layer hashes), open each
  `graph-<hash>.graph`, and resolve commits across layers by **global position** =
  (Σ base-layer commit counts) + local index. Per layer, the header's `num-base-graphs`
  byte and the `BASE` chunk (base-layer oids) link the layers; parent positions decode
  against the concatenated ordering; EDGE handles octopus parents; GDA2 carries the
  generation data. A chain that references a **missing layer ⇒ treat the whole graph as
  absent** and fall back to object reads (git's own behaviour — Pin D staleness).
- **(b) probe order** = A2/B7b — one implementation (the loose-oid cache, ADR-509).
- **(c) bounded parent-frontier prefetch** — read the parent frontier in parallel
  (bounded 8–16 in flight) instead of one awaited read per commit, attacking the ~75%
  syscall/idle directly.
- **(d) per-`Repository` parsed-commit-header cache** (oid → parents/date) — cheap and
  shared across every walk in the repo's lifetime.

**Faithfulness.** The graph is git's own cache; a correct reader — single-file or chain
— yields parents/dates/order identical to object reads. Interop: walk with a single-file
graph present, with a **chain/split** graph present (built via `git commit-graph write
--split`), and with the graph **absent** → all identical to each other and to `git
rev-list`. Generation numbers only prune/order, never change the visible set. The parser
is a decoder → property-test candidate (round-trip / total-function lenses).

#### B8 — handle lifecycle (ADR-510, joint with A4)

**Today** `openRepository` holds **no persistent OS file handles or watchers** — FDs
are per-operation and closed in `finally` — so a process already exits without
`dispose()` for the *file* path; any lingering aliveness is the HTTP transport
(keep-alive sockets, which *do* ref the event loop) or an un-`unref`'d timer.

**Technical reconciliation with A4 (ADR-510).** An idle Node `fs` `FileHandle` does
**not** keep the libuv event loop alive (only pending fs requests, sockets, servers,
watchers, and un-`unref`'d timers do); the OS reclaims the fd on exit. So A4's persistent
per-pack `FileHandle` does **not** by itself regress B8's "exit without `dispose()`"
invariant — but it *does* leak fds until process exit for an undisposed repo (fd
exhaustion under many repos). The coherent lifecycle story:

1. A4's persistent pack handles are owned by the pack registry and disposed with the
   repo (`dispose-adapters.ts`), preserving clean exit because idle fds don't ref the
   loop.
2. If an idle-close timer is later added for pack handles, **the timer itself must be
   `unref()`'d** — an un-`unref`'d `setTimeout` would ironically keep the loop alive.
3. B8's independent target is the actual loop-keeping references: `unref()` the
   transport agent's idle sockets / any keep-alive timer where semantically safe.
4. **Regression test:** a child process opens a repo, runs one diff, returns without
   `dispose()`, and must exit within N seconds — the empirical guard for the whole
   lifecycle story under ADR-510's persistent handles.

## Decisions (settled — ADRs 509–516)

All eight decision candidates are resolved. "ratified" = the user made the call;
"adopted-as-recommended" = the designer's recommendation stood with no user judgment
needed.

| # | Question | Settled choice | ADR | Status |
|---|---|---|---|---|
| DC-1 | A2/B7b object-store precedence — reorder pack-first vs stay loose-first. | Keep loose-first; amortise the probe with a per-fanout-dir loose-oid cache (git `odb_loose_cache`, generation-invalidated). Pack-first reorder and cheaper-per-object-probe rejected. | ADR-509 | ratified |
| DC-2 | A4 delta-chain per-step I/O **and** B8 handle lifecycle. | Persistent per-pack `FileHandle` owned by the registry, disposed with the repo; idle fds don't ref the loop so B8 exit holds; any idle-close timer must be `unref()`'d. Windowed cache and intermediate-base cache rejected. | ADR-510 | ratified |
| DC-3 | How to source/thread the index's own mtime for the racy-clean guard. | `readIndex` surfaces the index mtime; `compareWorkingTreeDelta` gains an optional racy-guard arg (absent ⇒ no short-circuit, so non-`status` consumers are unchanged). | ADR-511 | adopted-as-recommended |
| DC-4 | B2 fix direction given the ADR-249 tension on `toSimilarityPercent`. | Add the runtime value exports to honour the `.d.ts`; `toSimilarityPercent` stands as a documented, narrow ADR-249 exception. Guard test locks the whole `domain/diff` value surface. | ADR-512 | ratified |
| DC-5 | B4 whitespace line-equality mechanism (predicate + stat). | Streaming rolling-hash predicate with early-exit **and** int-array Myers for the stat path (each mechanism where it pays). | ADR-513 | adopted-as-recommended |
| DC-6 | B5 how far to take the byte-level oid representation. | `diffTrees`-local byte comparison; internal oid stays a hex string elsewhere. End-to-end `Uint8Array` representation foreclosed to a future dedicated ADR. | ADR-514 | adopted-as-recommended |
| DC-7 | B6 how to cut `walkTree`'s per-entry promise cost. | Bind + document `flattenTree` (B3) as the bulk path; `walkTree` keeps per-entry streaming. Batched-yield option deferred to a consumer-driven ADR. | ADR-515 | adopted-as-recommended |
| DC-8 | B7 commit-graph scope + which sub-parts ride along. | **Full chain/split format** read support + bounded parent-frontier prefetch + per-`Repository` header cache — all in this PR. **Deviates from the design recommendation** (single-file only + prefetch + cache). Write-side stays out of scope. | ADR-516 | ratified (deviates from recommendation) |

## Test strategy

- **A1 (unit).** Second `resolveObject(id)` behind an OFS-delta chain returns without
  touching the pack (spy `readSlice`/registry; identical bytes). Cover cache hit honours
  `verifyHash` (poison entry → assert `OBJECT_HASH_MISMATCH` with the mismatched oid in
  `.data`), honours `maxBytes` (→ `OBJECT_TOO_LARGE` with size/limit), and cold miss
  still resolves. Assert error `.data`, not just the class.
- **A2/B7b (unit + interop, Pin A · ADR-509).** Unit: a packed-repo walk performs at
  most one `readdir` per touched fanout dir (`objects/xx`, ≤256) and **no** per-object
  `realpath`/ENOENT probe (spy the FS); the loose-oid cache membership test drives the
  probe. Interop: build a repo where an object is loose-corrupt + pack-valid and assert
  tsgit **surfaces the loose inflate error like git** (loose-first preserved). Scrub
  `GIT_*`, sign off.
- **A3 (unit + interop + property, Pin C).** Unit table over `isEntryStatClean`:
  assume-valid ⇒ clean; racy (entry mtime == index mtime) ⇒ read+hash; ns-present vs
  absent; 32-bit ino/size truncation boundary; exec-bit-only ⇒ `mode-changed`; each
  field's mismatch as an **isolated** case (guard-clause isolation rule). Interop:
  reproduce Pin C (same-second same-size ⇒ modified; assume-valid stays clean;
  skip-worktree skipped) and re-pin index-write goldens after the `indexEntryFromStat`
  ns change. Property (ADR-134 lens 2, compositional matcher): a clean-stat entry with
  any single mutated field is never clean; assume-valid clean for arbitrary stats; racy
  always defers.
- **A4 (unit).** Deep-chain fixture (ADR-471) resolves with one `open`/`close` per pack
  (not per step) against the registry's persistent `FileHandle` (ADR-510; spy the port);
  byte-identical output; `readSlice` allocates exactly `bytesRead` (no zero-fill / double
  copy).
- **B1 (unit + interop, Pin B).** Unit: `resolveObject(EMPTY_TREE_OID)` on a repo that
  never wrote it returns a zero-entry tree (both SHA-1 and, if plumbed, SHA-256); the
  empty *blob* still throws `OBJECT_NOT_FOUND`. Interop: `diff EMPTY_TREE_OID..HEAD`
  matches `git diff <empty-tree> HEAD`.
- **B2 (guard).** Import built `index.node.js` + parse declared value exports from built
  `index.node.d.ts`; assert each is runtime-defined. Fails today for the affected
  symbols; must stay green for the whole `domain/diff` value surface.
- **B3 (guard).** Audit `repository.primitives` bindings against `primitives/index.ts`
  exports (bound or explicitly excluded); assert `flattenTree` bound. Plus a repository
  test exercising `repo.primitives.flattenTree`.
- **B4 (unit + interop + property, ADR-134).** Unit: drop-pass predicate agrees with the
  full-diff verdict on whitespace-only vs significant changes across every
  `WhitespaceMode`; early-exit proven (spy the stream — no full materialisation).
  Interop: pin against `git diff --ignore-all-space`/`--ignore-space-change`/
  `--ignore-space-at-eol`. Property (round-trip/aggregator): normalised-line equality is
  reflexive/agrees between predicate and stat paths.
- **B5 (unit + property).** Unit: unchanged-entry tree diff performs no `bytesToHex`/
  `TextDecoder`/regex in the hot loop (spy or count); equal-oid subtree pruned before
  flatten; emitted changes still carry hex oids + decoded paths. Property: `fromRaw`
  trusted path ≡ validated path for all 20/32-byte inputs; `diffTrees(parse(x))`
  invariants. (Parser touched → property-test the tree parse.)
- **B6 (unit).** The bulk path `flattenTree` (ADR-515) yields the same entry set as a
  per-entry `walkTree` drain with zero per-entry promises (count awaits); `walkTree`'s
  per-entry shape is unchanged.
- **B7 (unit + interop + property, Pin D · ADR-516).** Unit: the parser round-trips the
  pinned **single-file and chain/split** chunk layouts (layer linking via
  `num-base-graphs` + the `BASE` chunk, cross-layer global-position resolution, EDGE
  octopus parents); the reader serves parents/gen/date matching object reads; a chain
  that references a **missing layer**, a stale graph, or a commit absent from the graph
  falls back to `readObject`; prefetch stays within its 8–16 bound; the header cache
  returns the same headers on the second walk. Interop: build fixtures with a
  **single-file** graph (`git commit-graph write --reachable`), a **chain/split** graph
  (`git commit-graph write --reachable --split`), and **no** graph — all three walks
  identical to each other and to `git rev-list` order. Property (decoder lenses):
  chunk-table parse is total over the safe subset; parse∘serialize round-trip.
- **B8 (integration).** Child process opens a repo, runs one diff, returns without
  `dispose()`; assert exit within N seconds. With ADR-510's persistent handles, also
  assert no fd leak after `dispose()`.
- **Bench (req 13).** Nightly bench shows the four losing scenarios (delta-chain
  `readBlob`, log, status-clean, cold-LRU `readBlob`) and the Track-B scenarios
  (whitespace diff, megarepo tree diff, commit walk, walkTree) improved, and the winners
  (pack-read warm/cold medium, clone, status-dirty, blob reads) non-regressed. Perf
  numbers in this doc and the PR come from the CI nightly artifact, never local runs.

## Out of scope

- **Any rendering/output change** — pure read-path performance + wiring; structured
  output (ADR-249) is untouched apart from ADR-512's documented, already-declared
  `toSimilarityPercent`/`MAX_SCORE` exception (no *new* cosmetic surface; B6 adds none).
- **`hasObject`/`objectExistsLocally` probe switching** — already pack-first
  presence probes, not hot content frames; left as today (checkcontainment-hot-path
  DC-7 narrowing).
- **Commit-graph *write*** — B7 is read-only; both the single-file and chain/split forms
  are parsed, never emitted; tsgit does not generate `commit-graph` files (ADR-516).
- **Full internal 20/32-byte oid representation** — foreclosed by ADR-514 as a
  whole-domain change; split out to its own ADR if ever pursued.
- **`git gc`/repack** — tsgit does not repack; Pin A's both-stores case arises only from
  external tools, which is why the corrupt-loose precedence detail is pathological but
  observable (and why ADR-509 keeps loose-first rather than reorder).
- **A3 `core.checkStat=minimal` / `trust_ctime=false` config variants** — A3 targets
  git's default (`core.checkStat=true`, `trust_ctime=true`) field set. Honouring the
  `minimal` variant (compare mtime+size only) is a documented follow-on: comparing the
  full default field set under a `minimal`-configured repo only makes tsgit's fast path
  *more conservative* (falls through to read+hash more often), which is always a correct
  verdict — never a mis-report — so honouring `minimal` is additive and not required to
  close the measured gap.
