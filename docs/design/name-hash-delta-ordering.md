# Design — name-hash ordering for delta-base selection

> Brief: 30.4's packer orders delta-window candidates by `(typeRank, size DESC, oid ASC)`;
> git orders by type, then a path-derived **name hash**, then size, then first-seen order.
> Thread the path the reachability walk already discovers into `buildPack` as a name hash,
> amend the ordering half of ADR-769, revisit the alternative it declined, and re-measure
> against a peer command whose object set is comparable.
> Status: draft → self-reviewed ×3 (pass 1: citations pinned to v2.55.0 line numbers, corpus
> sizing, root-order assumption; pass 2: the `reuse: 'cruft'` identity, bundle enumerator has
> no closure object; pass 3: DC table and measurement contract against the body) → awaiting
> decisions

## Context

### What the packer sorts by today, and the corpus that defeats it

`deltifyEntries` (`src/application/primitives/internal/deltify.ts`) sorts every object once
with `comparePackEmissionOrder` (`src/domain/storage/delta-policy.ts:36-42`) —
`(type ASC, uncompressedSize DESC, id ASC)` — then slides a `pack.window`-sized window over
that order, offering each emitted object as an `OFS_DELTA` base to its successors. Emission
order **is** the search order: the window holds the last `W` emitted objects, whatever they
turned out to be.

Size adjacency is a good proxy for "same file, neighbouring revisions" only while sizes
differ. `DELTA_CHAIN_FIXTURE` (`test/bench/support/fixture-generator.ts:160-168`) is the case
where they do not: the `evolving` strategy rewrites one path, `evolving.dat`, on each of 300
commits by flipping ~1 % of its bytes **in place** (`mutateEvolvingContent`, `:352-360`), so
all 300 blob versions are exactly 4 096 bytes. Every one of them ties on `(type, size)` and
falls to `id ASC` — a uniformly random order with respect to version adjacency. The window of
10 then sees ten random versions of the file; the nearest of ten random picks among 300 is
~27 generations away, which at 1 % of bytes per generation is ~1 100 flipped bytes, and a
delta over that many breaks cannot fit the 2 048-byte search bound. That is the brief's
`git verify-pack -v` finding — 808 of 900 objects emitted as bases, max chain 5, against
git's ~43 — and the 300 one-entry root trees (same size, no path) tie the same way.

The same corpus shows why the brief's own remedy is necessary but **not sufficient**. All
300 versions share the path `evolving.dat`, so a name hash is *identical* across them and
cannot break the tie either. What separates them in git is the comparator's **last** key,
which is first-seen order in a newest-first traversal: version 300 sorts before 299 before
298, each deltas against its immediate predecessor, and the chain grows to the depth cap. The
name hash is the fix for the many-distinct-files class (`MEDIUM_FIXTURE`, real history);
the tiebreak is the fix for the deep-chain class. This design does both and attributes each
in the measurement (§11).

### What git sorts by — pinned from source

No git C source is installed locally (`/opt/homebrew/opt/git` is a binary install), so the
pin is taken from the tagged upstream source at **v2.55.0** — the same version the local
`git --version` reports and the version every earlier pin in this subsystem used. The
functions were also compiled verbatim with the system `cc` to produce the vector table in
§1a; that compiled oracle is the only local execution of git's hash there is. Files are cited
as `<file>:<line>` at that tag.

`builtin/pack-objects.c` sorts the delta list with `type_size_sort` (`:2650-2680`) and hands
it to `ll_find_deltas(delta_list, n, window + 1, depth, …)` (`:3662-3663`). Every comparison is
descending:

```c
if (a_type > b_type) return -1;               /* 1. type, DESC over OBJ_COMMIT=1..OBJ_TAG=4 */
if (a->hash > b->hash) return -1;             /* 2. name hash, DESC                          */
if (a->preferred_base > b->preferred_base)    /* 3. preferred base first                     */
if (use_delta_islands) island_delta_cmp(…);   /* 4. opt-in, off by default                   */
if (a_size > b_size) return -1;               /* 5. size, DESC                               */
return a < b ? -1 : (a > b);                  /* 6. pointer compare — "newest first"         */
```

The pointer compare is not the random tiebreak it looks like. `packlist_alloc`
(`pack-objects.c`, the library file) hands out entries sequentially from one growing array,
and `delta_list` is filled by walking `to_pack.objects` in index order (`:3640-3650`), so
`a < b` is exactly "`a` was added to the pack list before `b`" — **first-seen order**, and
git's traversal shows commits newest-first. It is reproducible in tsgit as caller order; it
is not reproducible as a pointer.

The name hash is `pack_name_hash` (`pack-objects.h:204-222`), pinned verbatim in §1a. Its
input is the string `show_object` receives (`builtin/pack-objects.c:4402-4407` →
`add_object_entry(&obj->oid, obj->type, name, 0)`), and `list-objects.c` decides what that
string is: a blob's full path from the root (`process_blob`, `:51-93` — `path` is the
running prefix plus the entry name), a tree's full path **without** a trailing slash
(`process_tree`, `:149-218` — shown at `:199` before `strbuf_addch(base, '/')` at `:201`),
and the empty string for a root tree. Commits and tags are added with `NULL` (`show_commit`,
`:4391-4394`; `add_tag_chain`, `:3357`), and `pack_name_hash(NULL)` is `0`. An object reached
twice keeps its first name: `have_duplicate_entry` (`:1536-1556`) returns before any entry is
created.

### Where tsgit already knows the path, and where it throws it away

| Caller | How its object set is enumerated | Path available today? |
|---|---|---|
| `gc-pipeline.ts:284-293` `computeReachableSet` | `computeClosure(…, { objects: true, tier: 'walk' })` — the walk tier fills `ClosureObject.path` for every tree and blob | **Yes, then discarded**: `new Set(closure.objects.map((o) => o.id))` keeps the id only, and `partitionOwned` (`:379-420`) re-derives the pack input from `owned` and sorts it by oid |
| `pack-objects.ts:79-87` | `computeClosure` at the caller's tier — `useBitmapIndex` **defaults to the bitmap tier**, which never fills `path` | Walk tier only; discarded by `closure.objects.map((o) => o.id)` |
| `bundle-create.ts:309-312` via `enumerateBundleObjects` | Its **own** recursive walk over `treeObj.entries` (`enumerate-bundle-objects.ts:66-140`), pruned by `seenTrees` — it does not use `computeClosure` at all | No path is built; `entry.nameBytes` is in hand at every step |
| `push.ts:353` | closure, base-only pack (ADR-767) | Out of scope — no delta emission |

So the brief's "`pack-objects` and `bundle-create` already carry `ClosureObject.path`" is half
right: `pack-objects` does on the walk tier; `bundle-create` has the raw name bytes but no
path, and no closure object. The gc path is the one that discovers and discards.

ADR-769 declined the path hint with *"helps only the callers that have paths; gc has none"*.
The table shows the premise was wrong in a specific way: gc's reachability walk has every
path git's has — it is the reduction to a `Set<ObjectId>` one line later that loses it.
Threading it through is one type change on `computeReachableSet`'s return, one on
`partitionOwned`'s input, and a 4-byte-per-object slab into `BuildPackInput`.

### Governing decision records

| ADR | Subject | What this design does with it |
|---|---|---|
| 769 | Metas are identified triples in emission order; emission order is `buildPack`'s own concern | **Amended**: the identified-triples half stands untouched; the ordering half (`(typeRank, size DESC, oid ASC)` in its Context, and declined option 3) is superseded by the key in §3. §10 states the amendment precisely |
| 767 | Delta emission is opt-in per caller (gc ×3, `pack-objects`, `bundle-create`) | Unchanged — the same five sites gain the hash slab; `push` stays base-only |
| 768 | Pure codec + comparator in the domain, lazy window in `deltify.ts` | Followed — the hash and the widened comparator are pure domain functions; `deltify.ts` only threads a number |
| 771 | Writer clamps to depth 50; both readers accept it | Unchanged; the tiebreak makes the cap *reachable* on the deep-chain corpus, which is the point |
| 772 | `pack.windowMemory` bounds residency; no per-object cap | Unchanged; the hash adds no window residency (§7) |
| 773 | Config surface is `window`/`depth`/`windowMemory` | Unchanged — git 2.55.0 has **no** `pack.nameHashVersion` config key (§1d), so no new key arises |
| 776 | `PackWriterEntry` is the union | Untouched — the writer never sees the hash |
| 790 | The oid slab is born in `buildPack`; typed-array slabs on the write path | Followed — `nameHashes` is a `Uint32Array` aligned to `oids`, the same shape as `emissionOrder` on the result side |
| 748 | Tree-name decisions are made on raw bytes, never on the decoded string | Binding — the hash is folded over `nameBytes`, and a re-encoded decoded path is refused as the input (DC-3) |
| 226 / 249 | Prime directive; structured output | Pack layout was ruled outside the byte-for-byte contract in 30.4 ("byte-identity with git's packer was never the contract"); the divergences this design keeps (§6) are recorded in the ordering ADR rather than left implicit |

### The measurement trap, and the second one behind it

The ×2.05 real-history figure 30.4 first published compared tsgit's cruft-retaining `gc`
against `git repack -a -d -f`, which drops unreachable objects — 7 553 objects git had
deleted were charged to tsgit. The corrected ×1.42 used `gc` on both sides with counts within
0.25 % (24 879 vs 24 817). That correction removed one asymmetry and left another: `git gc`
does **not** pass `-f` to `repack`, so git *reused* the deltas already in the source pack
(`builtin/gc.c:628-650`, `:897`; `builtin/repack.c:334-352` — no `--no-reuse-delta`), deltas
chosen by whatever multi-threaded packer produced the clone. tsgit always re-encodes from
inflated content (`delta-writing-packer.md` §Out of scope). The ×1.42 therefore compared a
fresh single-threaded selection against an inherited one, and understates how far tsgit's
*selection* is from git's. §11 fixes both asymmetries at once: a corpus with no unreachable
objects, and a peer that re-selects (`repack -a -d -f`), with object counts asserted equal
before any byte is divided.

---

## Requirements

Everything below is verifiable by a test named in §Test strategy.

**The hash**

- **R1** `packNameHash(bytes)` equals git 2.55.0's `pack_name_hash` for every vector in §1a:
  computed over **bytes**, skipping exactly `{0x09, 0x0a, 0x0d, 0x20}`, wrapping at 32 bits,
  and returning `0` for the empty path. Bytes `0x80..0xff` contribute their unsigned value.
- **R2** The incremental fold composes: `fold(fold(seed, a), b) === packNameHash(a ++ b)` for
  all byte sequences `a`, `b`; the whole-path function is the fold from the seed.

**The key**

- **R3** `comparePackEmissionOrder` is `(type ASC, nameHash DESC, uncompressedSize DESC,
  sourceIndex ASC)` — a strict total order over any input in which `sourceIndex` is unique.
- **R4** For a fixed `(oids sequence, nameHashes, config)`, `buildPack` produces the same bytes
  on every call. Two gc runs over an unchanged repository reproduce the same normal, promisor
  and cruft pack checksums (the existing `maintenance-interop.test.ts:1399-1455` pin); gc
  seeds its closure from sorted roots and sorts every path-less input so that holds by
  construction.

**Where the hash comes from**

- **R5** On the walk tier, every tree and blob `ClosureObject` carries `nameHash` computed
  over its full byte path with git's naming: root tree `''` → `0`; nested `a/b` folded over
  `a`, `/`, `b`; first-seen path wins. Commits, tags and directly-wanted blobs carry `0`. The
  bitmap tier carries `undefined`.
- **R6** gc hands the normal pack its reachable objects in **traversal order** with their
  hashes; the cruft and promisor packs are handed oid-sorted input, the cruft pack with no
  hash slab (every member is unreachable — git names them `""`).
- **R7** `packObjects` forwards the closure's hashes (all zero on the bitmap tier);
  `bundleCreate` computes them inside its own enumerator from `entry.nameBytes`.
- **R8** `BuildPackInput.nameHashes` is optional. Absent means every object hashes to `0`.
  A slab whose length differs from `oids.length` is refused before any object is read, with
  error data naming both lengths.

**What must not change**

- **R9** Every existing validity oracle holds on packs written under the new order:
  `git index-pack --strict`, `git fsck --strict`, `git verify-pack -v`, tsgit's own fsck and
  `readObject`; max chain depth ≤ 50 (ADR-771).
- **R10** The `.idx`, `.rev`, cruft `.mtimes` and midx paths are untouched — all are oid-keyed
  and consume `PackIndexEntries` as before; `emissionOrder` still maps ordinal → input index.
- **R11** No published type breaks. `BuildPackInput`, `WalkTreeEntry`, `WalkTreeOptions` gain
  optional fields only; `reports/api.json` is regenerated.
- **R12** Steady-state residency grows by at most ~32 B per object and by 8 B per tree-walk
  frame; no path string is retained that is not retained today (§7).

**The measurement**

- **R13** On a tie-dense corpus (one path, constant-size versions), every version but the
  chain roots is emitted as a delta and the maximum chain reaches
  `min(versions − 1, pack.depth)` — a structural oracle, asserted through
  `git verify-pack -v`, independent of any size ratio.
- **R14** The size ratio against the §11 peer is recorded for `DELTA_CHAIN_FIXTURE`,
  `MEDIUM_FIXTURE` and a fresh clone of tsgit's history, each with equal object counts on both
  sides and the git version stated, before the backlog entry is ticked.

---

## Design

### 1. The pinned matrix

#### 1a. The hash function

`pack-objects.h:204-222`, git v2.55.0, verbatim:

```c
static inline uint32_t pack_name_hash(const char *name)
{
	uint32_t c, hash = 0;
	if (!name)
		return 0;
	/*
	 * This effectively just creates a sortable number from the
	 * last sixteen non-whitespace characters. Last characters
	 * count "most", so things that end in ".c" sort together.
	 */
	while ((c = *name++) != 0) {
		if (isspace(c))
			continue;
		hash = (hash >> 2) + (c << 24);
	}
	return hash;
}
```

Three details a port gets wrong from memory:

1. **`isspace` is git's own `sane_ctype`, not C's.** `sane-ctype.h:40` maps it to
   `GIT_SPACE`, and `ctype.c`'s table sets that bit on exactly four bytes: `0x09` (`\t`),
   `0x0a` (`\n`), `0x0d` (`\r`) and `0x20`. Vertical tab (`0x0b`) and form feed (`0x0c`) carry
   only the control bit and **are hashed**. Nothing at or above `0x80` is space.
2. **Bytes, not code points.** `name` is the raw path bytes from the tree. A byte ≥ `0x80`
   read through `const char *` sign-extends on signed-`char` platforms, but `c << 24` keeps
   only the low byte, so the result equals the unsigned computation on every platform (the
   compiled oracle checks this: `0xe9` → `0xe9000000` both ways). In TypeScript the fold is
   `((hash >>> 2) + (c << 24)) >>> 0` over a `Uint8Array`.
3. **Only the last sixteen non-space bytes matter.** Each step shifts the accumulator right
   by two; after sixteen steps every earlier contribution has left the word. `0123456789abcdef`,
   `X0123456789abcdef` and `XYZ0123456789abcdef` hash identically.

Vectors, from the functions compiled verbatim with the system `cc` (scratch file
`name-hash-oracle.c`; `isspace` implemented as the four-byte set above):

| Path bytes | v1 | v2 (not shipped — DC-4) |
|---|---|---|
| `` (empty; also `NULL`) | `0x00000000` | `0x00000000` |
| `a` | `0x61000000` | `0x86000000` |
| `ab` | `0x7a400000` | `0x67800000` |
| `a b` (space skipped) | `0x7a400000` | `0x67800000` |
| `ab\t` (tab skipped) | `0x7a400000` | `0x67800000` |
| `\x0bab` (VT hashed) | `0x7af00000` | `0x74800000` |
| `\x0cab` (FF hashed) | `0x7b000000` | `0x6a800000` |
| `churn.txt` | `0x9a8bd300` | `0x3ac57e00` |
| `src/churn.txt` | `0x9a8be72b` | `0x395cfe00` |
| `lib/churn.txt` | `0x9a8be6f0` | `0x3b7efe00` |
| `deep/er/churn.txt` | `0x9a8be7c7` | `0x3b1f5980` |
| `README.md` | `0x83977600` | `0x5e0d7200` |
| `src/main.c` | `0x77854ac0` | `0xeef20000` |
| `src/util.c` | `0x777a4ac0` | `0xea880000` |
| `0123456789abcdef` | `0x878af8e3` | `0x9569c357` |
| `X0123456789abcdef` | `0x878af8e3` | `0x9569c358` |
| `\xc3\xa9.txt` (UTF-8 `é`) | `0x9ad1c000` | `0x3af5c000` |
| `\xff` | `0xff000000` | `0xff000000` |

The `churn.txt` rows show the clustering the comment describes: three files with the same
basename in different directories land within `0x14b` of each other, far from `README.md`.

#### 1b. The sort key, and what drops out of it

| git term | git value in tsgit's situations | tsgit key |
|---|---|---|
| type DESC (`OBJ_TAG`, `OBJ_BLOB`, `OBJ_TREE`, `OBJ_COMMIT`) | — | **type ASC** (commit, tree, blob, tag). Direction has no effect on selection: `try_delta` refuses cross-type pairs (`:2800`) and so does `tryCandidate`; types are contiguous blocks, so at a block boundary the window holds only refused members. Kept as-is; recorded, not decided (§6) |
| name hash DESC | `pack_name_hash(name)` | **`nameHash` DESC** — new |
| `preferred_base` first | Set only by `add_preferred_base` (`:2126`), reached from `show_edge` (`:4483-4486`) via `mark_edges_uninteresting` (`:4885`) — i.e. only when the traversal has UNINTERESTING edges — and such entries are never written (`write_one`, `:816`). They exist to be thin-pack bases. tsgit never emits `REF_DELTA` (ADR-774), so an object outside the pack can never be a base; the term is identically `0` | dropped — constant |
| delta islands | `use_delta_islands` is off unless `--delta-islands`/`repack.useDeltaIslands`; tsgit reads neither | dropped — constant |
| size DESC | `SIZE(entry)` = uncompressed object size | **`uncompressedSize` DESC** — unchanged |
| pointer compare | first-seen order (`packlist_alloc` is sequential; commits newest-first) | **`sourceIndex` ASC** — the caller's input position; callers that walk pass traversal order (DC-1) |

#### 1c. What git names, object class by class

| Object class | git's `name` | hash | tsgit source of the same value |
|---|---|---|---|
| commit | `NULL` (`show_commit`, `:4391-4394`) | `0` | `emit(commit.id, 'commit')` — no path → `0` |
| tag (any hop of a tag chain) | `NULL` (`:3357`) | `0` | `resolveTagChain` emits tags with no path → `0` |
| root tree of a commit | `""` (`process_tree` shows `base->buf` before appending `/`; root base is empty) | `0` | `emitTree` emits `ROOT_PATH = ''` → `0` |
| nested tree at `a/b` | `"a/b"` — no trailing slash (`list-objects.c:199-201`) | `hash("a/b")` | `walkTree` path `a/b`; fold of `a`, `/`, `b` |
| blob at `a/b/c.txt` | `"a/b/c.txt"` (`process_blob`, `:51-91`) | `hash("a/b/c.txt")` | same fold, one segment deeper |
| object seen under two paths | first path wins (`have_duplicate_entry` returns before `create_object_entry`); a `SEEN` tree is not re-entered | first | `tryEmit` dedups on first emit; `enumerateBundleObjects` prunes on `seenTrees`. `closure-engine.ts`'s `emitTree` re-walks an already-emitted subtree but `tryEmit` still keeps the first hash |
| blob or tree wanted directly (`resolveWants`) | the pending object's own name — for `--indexed-objects` the index path, for a command-line object the argument text | path hash | **`0`** — tsgit emits a direct want with no path. gc's `addIndexRoots` wants index-entry blobs this way, so a staged-but-uncommitted blob orders by size alone where git would use its index path. Recorded divergence (§6), layout-only |
| unreachable object (cruft; `--keep-unreachable`, `--pack-loose-unreachable`) | `""` (`:4496`, `:4550`) | `0` | cruft pack gets no slab → `0` |
| promisor-pack member | repacked separately by `repack_promisor_objects`; reachable members carry their traversal name | path hash or `0` | promisor pack: reachable members look up the walk's hash, the rest `0` |

Traversal shape differs in one recorded way: git shows **all** commits (rev-list order,
newest-first by date) and then walks trees per pending root in that order
(`do_traverse`, `list-objects.c:377`); tsgit's `walkAndEmitCommits` walks in topo order and emits
each commit followed by its tree. Type is the primary key, so interleaving is invisible; the
newest-first intent survives on the main line and differs only across concurrent branches.

#### 1d. Version selection

`builtin/pack-objects.c` carries two hashes. `name_hash_version` starts at `-1` (`:287`),
becomes `1` unless `GIT_TEST_NAME_HASH_VERSION` says otherwise (`:5344-5345`), is settable by
`--name-hash-version=<n>` (`:5152`), validated to `1..2` (`:299-302`), and is **forced back to
`1` whenever a bitmap is written or read** (`:303-306`, `:4668-4675` — "the version implied by
the bitmap format"). There is **no `pack.*` config key** for it in 2.55.0 (grep of
`builtin/pack-objects.c` and `builtin/repack.c` for a `nameHashVersion` config read — none;
`name_hash_version` is assigned only from the option, the env var and the bitmap override).
`git gc` and `git repack` never pass the flag. The faithful default is therefore v1, and there
is no repository setting a v2 port would be honouring. v2 (`pack_name_hash_v2`,
`pack-objects.h:224-250`) is pinned in the vector table for completeness and is DC-4.

#### 1e. The peer commands and their object sets

| Command | Object set | Delta selection | Comparable to tsgit `gc`'s normal pack? |
|---|---|---|---|
| `git -c pack.threads=1 repack -a -d -f` | reachable from refs + reflogs + index (`--all --reflog --indexed-objects`, `repack.c:350-352`); unreachable objects **dropped** | fresh (`-f` = `--no-reuse-delta`), single-threaded, deterministic (ADR-772 measured byte-identical runs) | **Yes on a corpus with no unreachable objects** — every bench fixture, and a fresh clone |
| `git -c pack.threads=1 gc` | same reachable set into the normal pack; unreachable into a cruft pack (`gc.cruftPacks` default on, `gc.c:632-640`) | **reused** from the source pack — `gc` never passes `-f` (`gc.c:897`) | Only pack-for-pack with counts asserted, and only if the source pack's deltas are discounted — which they cannot be. Not the peer for a *selection* claim |
| `git -c pack.threads=1 repack -a -d` (no `-f`) | as the first row | reused | No — the existing X7 interop pin uses this and compares against inherited deltas; it is a validity band, not a selection measure |

#### 1f. Window mechanics compared — what this design deliberately leaves as-is

`find_deltas` (`builtin/pack-objects.c:2972`) and `try_delta` (`:2789-2830`) carry four heuristics
beyond ordering. None is in this entry's scope; they are the named residual if re-measurement
(§11) does not close the gap, and DC-6 asks whether to fold them in now:

| git heuristic | tsgit today | Effect on the deep-chain corpus once ordering is fixed |
|---|---|---|
| Search bound scales with depth: `max_size = (size/2 − hashSize) × (max_depth − src.depth) / (max_depth − ref_depth + 1)` | flat `floor(size × 0.5)` | git prefers shallower bases and ends chains around depth 43; tsgit will run to the cap of 50 — *more* compression, not less, at the cost of longer read chains |
| size pre-filters: skip when the size difference reaches `max_size`, or when the target is under 1/32 of the source | none — every same-type window member is encoded | CPU only; no size effect on same-size versions |
| Window scan `break`s at the first cross-type member (`ret < 0`) | scans on, refusing each | CPU only |
| The chosen base is moved to the most-recent window slot | FIFO, no promotion | on a chain-shaped corpus the predecessor is already the most recent member; no effect |

### 2. Layer 1 — the hash (`src/domain/storage/pack-name-hash.ts`, new)

Pure, total over any `Uint8Array`, no allocation:

```ts
export const PACK_NAME_HASH_SEED = 0;
const GIT_SPACE = new Uint8Array(256);            // 0x09, 0x0a, 0x0d, 0x20 set to 1
export function foldPackNameHash(state: number, bytes: Uint8Array): number {
  let hash = state;
  for (const c of bytes) {
    if (GIT_SPACE[c] === 1) continue;
    hash = ((hash >>> 2) + (c << 24)) >>> 0;
  }
  return hash;
}
export const packNameHash = (pathBytes: Uint8Array): number =>
  foldPackNameHash(PACK_NAME_HASH_SEED, pathBytes);
export const PACK_NAME_HASH_V1: PathHasher = { seed: PACK_NAME_HASH_SEED, fold: foldPackNameHash };
```

`PathHasher` is the one-method seam §4a's walker folds through — `{ seed: number;
fold(state, bytes): number }` — declared in the same domain module so that both the domain
constant and the application-layer option can name it without the domain importing outward.
`(c << 24)` on a byte never exceeds `0xff000000` and `hash >>> 2` never exceeds
`0x3fffffff`, so the sum fits in 32 bits before the final `>>> 0`; the `>>> 0` is what keeps
the result non-negative when bit 31 is set. The fold state is a plain `number` holding a
uint32 — the only state v1 has. v2 would need two words (`hash`, `base`); if it is ever
adopted the seam widens to a generic state, not before (DC-4).

### 3. Layer 2 — the comparator (`src/domain/storage/delta-policy.ts`, extended)

```ts
export interface PackEmissionKey {
  readonly type: BasePackEntryType;
  readonly nameHash: number;          // uint32; 0 for a path-less object
  readonly uncompressedSize: number;
  readonly sourceIndex: number;       // position in the caller's `oids` — the first-seen proxy
}
export function comparePackEmissionOrder(a: PackEmissionKey, b: PackEmissionKey): number {
  if (a.type !== b.type) return a.type - b.type;
  if (a.nameHash !== b.nameHash) return b.nameHash - a.nameHash;
  if (a.uncompressedSize !== b.uncompressedSize) return b.uncompressedSize - a.uncompressedSize;
  return a.sourceIndex - b.sourceIndex;
}
```

`id` leaves the key: it was only ever the tiebreak, and `sourceIndex` is unique by
construction over one input array. `b.nameHash - a.nameHash` is exact — both operands are
below 2³², so the difference is an exact integer in a float64. The module doc's claim "no two
distinct objects compare equal because oids are unique" becomes "because input positions are
unique", and the existing "duplicate oid compares equal" case (`delta-policy.test.ts:109-125`)
turns into "same position compares equal".

### 4. Layer 3 — carrying the hash from the tree to the packer

The hash is computed exactly where the path bytes are in hand and travels onward as a
`number`; no layer allocates or retains a path it does not already hold.

```
walkTree ── nameHash per entry ──▶ closure-engine ── ClosureObject.nameHash ──▶ pack-objects ─┐
                                                                             └─▶ gc-pipeline ──┤
enumerate-bundle-objects ── own fold over entry.nameBytes ──▶ bundle-create ────────────────────┤
                                                                                               ▼
                                                   buildPack({ oids, nameHashes?: Uint32Array })
                                                                                               ▼
                                                   deltifyEntries(ctx, oids, policy, nameHashes)
                                                                                               ▼
                                                   PackEmissionKey.nameHash → comparePackEmissionOrder
```

#### 4a. `walkTree` folds the hash per frame (`src/application/primitives/walk-tree.ts`)

`WalkTreeOptions` gains `pathHasher?: PathHasher`; `WalkTreeEntry` gains
`nameHash?: number`, present exactly when a hasher was supplied. `WalkFrame` (`:40-46`) gains
`readonly hashState: number` — the fold state of the frame's `prefix`; the root frame built at
`:131` starts from `hasher.seed`. `nextFrameEntry` (`:96-107`) computes, for every yielded entry:

```
state = frame.prefix === '' ? frame.hashState : hasher.fold(frame.hashState, SLASH)
nameHash = hasher.fold(state, entry.nameBytes)
```

and `enterTree` (`:59-71`) receives that `nameHash` as the child frame's `hashState`. The
fold consumes `entry.nameBytes` — the authoritative bytes ADR-748 mandates — never `entry.name`
or the joined `path` string. Cost: one `fold` over the entry's own name bytes per yielded
entry (not over the whole path), 8 bytes per frame, zero allocation. With no hasher the option
is an `undefined` check per entry and every existing consumer (`ls-tree`, `checkout`,
`status`, diff) pays nothing and sees no new field.

The empty-prefix guard is git's own rule (`if (base->len) strbuf_addch(base, '/')`): a
root-level entry is hashed as `name`, not `/name`. It is also the mutant a test must kill
in isolation (§Test strategy).

#### 4b. The closure engine (`src/application/primitives/internal/closure-engine.ts`)

`ClosureObject` gains `readonly nameHash?: number` with the doc "git's `pack_name_hash` of
`path`; `0` for a path-less object; populated by the walk tier only — a reachability artefact
encodes types and bits, never names, so the bitmap tier never fills this" (mirroring `path`'s
existing note at `:67-75`). `Emit` gains a fourth parameter. `emitTree` walks with
`{ pathHasher: PACK_NAME_HASH_V1 }` and passes `entry.nameHash`; the root emits
`PACK_NAME_HASH_SEED`. `resolveWants` and the commit emitters pass `0` explicitly, so on the
walk tier the field is always a number. The fold runs on every walk-tier closure, `rev-list`
included: its cost is a few dozen byte operations per visited entry against a tree read and
parse per tree, and keeping `ClosureObject` uniform on the walk tier is worth more than an
opt-in flag on `ClosureRequest` (non-decision, §6).

`emitTree` re-walks subtrees an earlier commit already emitted — an existing cost this design
neither adds to nor fixes; `tryEmit` rejects the repeat before the hash is stored, so the
first-seen rule holds.

#### 4c. The gc pipeline (`src/application/commands/internal/gc-pipeline.ts`)

`computeReachableSet` (`:284-293`) becomes `computeReachable`, returning an insertion-ordered
`ReadonlyMap<ObjectId, number>` — id → `nameHash ?? 0` in traversal order. The `?? 0` is
reachable only through the bitmap tier, and gc pins `CLOSURE_TIER = 'walk'` (`:59`), so the
map is built as `new Map(closure.objects.map((o) => [o.id, o.nameHash ?? 0]))` and a unit test
asserts the walk-tier values rather than the fallback.

`partitionOwned` (`:379-420`) takes the map and produces the normal-pack input by iterating
**the map**, not `owned`: every reachable id that is not kept and is either owned or a
promisor-pack member goes to `toNormalPack`, in traversal order, together with its hash. That
is the same set the two existing loops produce — `reachable ∩ (owned ∪ ownedPromisor) \ kept` —
collected side by side and sealed into a `Uint32Array`, so no lookup and no unreachable
fallback arm exists to survive mutation. The `toNormalPack.sort()` at `:419` and its Pin W
comment go: the sort existed because the base-only path emits in input order and `owned`'s
iteration order depends on where objects live; traversal order is a function of the graph and
the roots alone, so it is stable across the loose→packed transition run 1 causes (R4) —
**provided the roots are seeded in a stable order**. `collectRetentionRoots` returns a `Set`
whose insertion order follows ref, reflog, index and worktree enumeration, and nothing today
depends on that order. `computeReachable` therefore **sorts the roots** before handing them to
`computeClosure` as `wants`; the walk is then a pure function of `(sorted roots, graph)`.
`cruftCandidates` keeps its `owned`-order derivation and is **sorted by oid** before
`computeCruftMtimes` — new, and required: with `sourceIndex` as the final key, the cruft
pack's bytes would otherwise follow `owned`'s layout-dependent order and the
`existingCruftShas.has(pack.sha)` reuse at `:561` would miss on every second run.
`toPromisorPack` (`:859`) is already sorted; its slab is built by map lookup with a
reachable `?? 0` arm (unreachable promisor members are retained and path-less).

The three `buildPack` calls become:

| Site | `oids` | `nameHashes` |
|---|---|---|
| normal (`:484`) | `toNormalPack` in traversal order | the aligned slab from `partitionOwned` |
| promisor (`:527`) | `toPromisorPack`, oid-sorted | lookup slab, `0` for unreachable members |
| cruft (`:560`) | `survivors`, now oid-sorted upstream | **omitted** — every member is unreachable; git names them `""` |

`emissionOrder` on the cruft result still maps ordinal → `survivors` index for `mtimeAt`;
nothing on that path changes.

**One identity weakens, and it is named here rather than discovered.** `buildAndWriteNormalPack`
reports `reuse: 'cruft'` (`:492-496`) when the fresh normal pack's sha equals an existing cruft
pack's — the "resurrected cruft set moving intact into the normal pack" case that
`declassifyCruftPack` (`:920-922`) then handles in place. That equality needs the same object
set **and the same emission bytes**; today both packs are built from oid-sorted, hash-less
input, so any resurrected set reproduces. After this change the normal pack is built from
traversal order with hashes and the cruft pack from sorted, hash-less input, so a
multi-object resurrected set generally yields a *different* sha: gc then takes the ordinary
route — a new normal pack is written, the cruft pack's objects are no longer survivors, and
the cruft lifecycle retires or rewrites it. The arm stays reachable and keeps its tests: the
resurrection pins (`maintenance.test.ts:2098-2150`, `maintenance-interop.test.ts:577-600`)
resurrect a **single** blob, and a one-object pack has no order for a key to change. The plan
adds the multi-object case and asserts the ordinary route (new sha, no `declassifyCruftPack`
call, cruft retired through its own fate), so the weakened identity is covered rather than
assumed.

#### 4d. `packObjects` (`src/application/commands/pack-objects.ts:79-87`)

```ts
const oids = closure.objects.map((object) => object.id);
const nameHashes = Uint32Array.from(closure.objects, (object) => object.nameHash ?? 0);
const pack = await buildPack(ctx, { oids, nameHashes, delta: true });
```

The `?? 0` arm is live here — the bitmap tier is this command's **default** — and the unit
test covers both tiers. The `PackObjectsResult.packId` doc (`:46-56`) already says "never
compare this across tiers"; its last sentence — "with delta emission on … a function of the
object SET, not of the closure's own traversal order" — was true under `oid ASC` and becomes
false under either the hash (present on one tier only) or the tiebreak. The sentence is
rewritten to the documented rule and `pack-objects.test.ts:289`'s cross-tier equality
inverts into a cross-tier inequality with the same object set (§6).

#### 4e. `bundleCreate` (`src/application/primitives/enumerate-bundle-objects.ts`)

`emitTreeObjects` (`:116-160`) is a recursion over `treeObj.entries` with `entry.nameBytes`
in hand at every step, so it folds the hash itself: the recursion gains a `hashState`
parameter (root = seed), each entry's hash is `fold(fold(state, SLASH) unless root, nameBytes)`,
and a subtree's call receives its own hash as state. `BundleEmitState` (`:63`) gains
`readonly nameHashes: number[]` pushed on every successful `tryEmit` alongside the id, and
`BundleObjectClosure` (`:46-55`) gains `readonly nameHashes: Uint32Array` aligned to
`objects`; commits and tags push `0`. `bundle-create.ts:312` passes both. The `seenTrees`
prune (`:125`) means a subtree already emitted under an earlier path is never re-entered —
the same first-seen rule as git's `SEEN` flag, with no second hash ever computed.

The uninteresting-side walk (`collectTreeObjects`, `:79-114`) computes nothing: its objects
are never packed.

#### 4f. `buildPack` and `deltifyEntries`

`BuildPackInput` gains:

```ts
/** git's `pack_name_hash` of each object's path, aligned index-for-index with `oids`;
 *  `0` for an object with no path. Absent means every object hashes to `0`, which is
 *  what git itself does for an object it has no name for. Refused when the length
 *  differs from `oids.length`. */
readonly nameHashes?: Uint32Array;
```

`buildPack` validates the length first — before `readConfig`, before any read, and regardless
of `delta`, since a misaligned slab is a caller defect whatever path follows — and throws
`invalidPackInput(reason, expected, actual)`, a new `INVALID_PACK_INPUT` member of the storage
error union with `{ reason, expected, actual }` data, so the assertion in the test can name
all three. Degenerate inputs keep their existing behaviour: an empty `oids` with an empty slab
builds the empty pack; a single object is emitted as a base whatever its hash, because a
one-entry sort has no order to change. `resolveWriterPlan` threads the slab to `deltifyEntries(ctx, oids, policy,
nameHashes)`; `boundCarriedContent` (`deltify.ts:93-117`) fills `nameHash: nameHashes?.[i] ?? 0`
into each `EmissionEntry` — the one place the absent-slab default lives — and `sourceIndex`,
already present, becomes a comparator input. The base-only path (`buildBaseEntries`) ignores
the slab: it emits in input order and needs no key. Nothing else in `deltify.ts` changes —
the window, the acceptance rule, the budget and the carried-content bound are all downstream
of the sort.

### 5. Objects without a path — the table, in one place

| Class | Hash | Where the `0` is produced |
|---|---|---|
| commit | `0` | closure engine / bundle enumerator emit with `0` |
| tag | `0` | same |
| root tree | `0` = seed | `emitTree` root; bundle root call |
| directly wanted blob or tree | `0` | `resolveWants` (divergence: git uses the pending name — §1c) |
| every object on the bitmap tier | `0` | `packObjects`' `?? 0` |
| every cruft-pack member | `0` | no slab passed |
| unreachable promisor-pack member | `0` | gc's lookup arm |
| any object when the caller passes no slab | `0` | `boundCarriedContent`'s `?? 0` |

### 6. Determinism — proof obligations, and the contracts that invert

**Still proven.** The selection path stays free of `Map`/`Set` iteration, `Date.now`,
`Math.random` and `Promise.race`; the comparator is a pure strict total order (R3); the hash
is a pure function of bytes (R1). The two existing pins — `buildPack` ×2 byte-equality and
gc ×2 checksum-equality (`maintenance-interop.test.ts:1399-1455`) — remain the gates and must
stay green unchanged. gc's inputs are deterministic by construction: traversal order is a
function of the object graph and the retention roots (`computeClosure`'s own doc: "Order is
deterministic for a given call"), and every path-less input is oid-sorted (§4c).

**Inverted, deliberately.** Three existing statements say the delta path is order-independent
and they stop being true under DC-1(a):

| Where | Today | After |
|---|---|---|
| `build-pack.test.ts:441-459` "shuffled oid array … same bytes" and `:462-480` "two permutations … same bytes" | input-order independence | **sequence determinism**: the same sequence twice gives the same bytes; a permutation with a tie in `(type, hash, size)` may legitimately give different bytes. The test is rewritten to assert the former and to *show* the latter on a tie-dense pair |
| `pack-objects.ts:46-56` docblock last sentence | "a function of the object SET" | withdrawn; the surrounding "never compare this across tiers" rule stands and is now literally true on the delta path too |
| `pack-objects.test.ts:289` "the two tiers write the same object set AND the same packId" | cross-tier packId equality | cross-tier packId **inequality** for a closure whose walk-tier hashes differ from zero, same object set read back from both `.idx` files |

**Divergences from git this design keeps, all inside the layout-only class 30.4 ruled outside
the byte contract, to be recorded in the ordering ADR:**

- type block order ASC where git's is DESC (no selection effect — §1b);
- `sourceIndex` as the first-seen proxy, with tsgit's topo traversal standing in for git's
  date-ordered rev-list (§1c);
- directly-wanted blobs and index-entry roots hash to `0` where git hashes the pending name;
- git's write order (`compute_write_order`: recency, tagged tips first) is not reproduced —
  tsgit emits in search order, as it always has.

**Non-decisions**, stated so a reviewer does not re-open them: the hash runs unconditionally on
the walk tier (cost negligible, `ClosureObject` uniform); the type direction stays ASC (flipping
it changes every pack sha for no size gain and no selection effect).

### 7. Memory — costing the carry

The memory hint on this entry warns that a path string per object is not free. This design
carries **no path it does not carry today**:

| Term | Today | After | Δ per object |
|---|---|---|---|
| `ClosureObject` (walk tier) | `{ id, type, path? }` — the path string is already allocated by `walkTree` and retained in the closure array on every `computeClosure` walk-tier caller (gc, `pack-objects`, `rev-list`), gc included (transiently, until `computeReachableSet` reduces it). `bundle-create` never builds one | `+ nameHash: number` | +8 B |
| gc reachable structure | `Set<ObjectId>` | `Map<ObjectId, number>`, same keys | +8 B |
| gc / pack-objects / bundle input | `oids` | `+ Uint32Array` | +4 B |
| `EmissionEntry` in `deltify.ts` | `{ id, sourceIndex, type, uncompressedSize, content? }` | `+ nameHash` | +8 B |
| `walkTree` frame | `{ entries, index, prefix, depth, id }` | `+ hashState` | +8 B **per frame** (depth-bounded), 0 per entry |
| window residency (ADR-772) | content + `DeltaIndex` | unchanged | 0 |

Worst case ≈ 28 B per object, transient, none of it in the window: for the 24 817-object
real-history corpus, under 0.7 MiB. `bundle-create`'s new `number[]` is the same shape as its
existing emitted-id array. No new term is proportional to path length.

### 8. Public surface

| Symbol | Change | Kind |
|---|---|---|
| `BuildPackInput.nameHashes?` | new optional field | additive |
| `WalkTreeOptions.pathHasher?`, `WalkTreeEntry.nameHash?` | new optional fields | additive |
| `PathHasher`, `packNameHash`, `foldPackNameHash`, `PACK_NAME_HASH_V1`, `PACK_NAME_HASH_SEED` | new domain exports through `domain/storage/index.ts` | additive |
| `INVALID_PACK_INPUT` | new storage error code with `{ reason, expected, actual }` | additive |
| `ClosureObject`, `PackEmissionKey`, `BundleObjectClosure`, `DeltifiedEntry` | internal (`api.json` lists none of them) | not published |

No published type breaks (R11). `reports/api.json` must be regenerated and committed — it is a
pre-push gate. No `path` string enters any public input shape; the public input is a slab of
`uint32`, and the hash function that produces it is itself published so a caller with paths
of its own can compute the same value.

### 9. Threat model

- **Input**: tree-entry name bytes from any object store, including a freshly fetched pack.
  The fold is total over any byte sequence, allocates nothing, recurses nowhere, and is
  bounded by the walk's own `MAX_FLAT_TREE_ENTRIES` / `core.maxTreeDepth` guards — an
  adversarial tree cannot make the hash cost more than the tree read it rides on.
- **Collisions** are a quality concern, never a safety one: two paths hashing equal simply
  share a neighbourhood, and the worst case is today's ordering.
- **A caller's slab** is typed `Uint32Array`, so every value is a uint32 by construction; only
  the length can be wrong, and it is refused before any I/O (R8). Values are never used as an
  index or a size.
- **Pack validity is unaffected by ordering**: the reader-side oracles (`index-pack --strict`,
  `fsck`, `verify-pack`, tsgit's chain readers) are the same for every emission order, and
  ADR-771's depth clamp still binds at the writer.
- **Determinism** is the one property an attacker-shaped input could disturb — a caller
  passing a non-deterministic sequence gets a non-deterministic pack sha. That is the
  base-only path's existing contract and gc already obeys it; it is documented on
  `BuildPackInput`, not enforced.

### 10. Relationship to ADR-769

ADR-769 made two statements. The one it decided — metas are `{ id, crc32, offset }` in
emission order, positional alignment is deleted — is untouched. The one it *assumed* — its
Context opens "Delta selection requires emitting objects in `(typeRank, size DESC, oid ASC)`
order" — and the reason it gave for declining option 3 — "helps only the callers that have
paths; gc has none" — are what this design supersedes. The new ordering ADR should
(a) state the key of §3, (b) record that gc's walk has every path git's has and that the
loss was in `computeReachableSet`'s reduction, (c) carry the §6 divergence list, and
(d) leave a one-line "ordering half amended by ADR-NNN" status note on 769 in the repo's
existing superseded-status style (`docs/adr/000-template.md:5`).

### 11. The measurement contract

Size is **deterministic** on both sides — tsgit by design (R4), git at `pack.threads=1`
(ADR-772 measured byte-identical repeats) — so unlike wall-clock numbers, a pack-size ratio
is reproducible locally and needs no CI runner. The nightly bench remains the only authority
for *timing*; this entry claims nothing about timing.

| Element | Contract |
|---|---|
| git version | 2.55.0, stated with every number |
| Peer | `git -c pack.threads=1 repack -a -d -f -q` — fresh single-threaded selection. `gc` is not a selection peer (§1e) |
| Corpora | `DELTA_CHAIN_FIXTURE` (tie-dense, one path); `MEDIUM_FIXTURE` (many paths, few ties); tsgit's own history as a **fresh clone** — `git clone --no-local` into `mktemp`, so no unreachable object exists on either side. The working repository, with its 7 553 unreachable objects, is not a corpus |
| Comparability gate | `git show-index` / `parsePackIndex` object counts **equal** on both sides before any byte is divided; a mismatch is a measurement defect, not a result |
| Structural readout | `git verify-pack -v` on both packs: base count, delta count, chain-length histogram, max depth — recorded alongside the ratio, because it is what shows *why* a ratio moved |
| Attribution | Under DC-1(a) the plan sequences the comparator change in two parts — the hash term first, the tiebreak second — and measures after each: `DELTA_CHAIN_FIXTURE` is expected to move only on the second, `MEDIUM_FIXTURE` on the first. If the hash-only run moves the deep-chain ratio, §Context's tie analysis is wrong and the design comes back here. Under DC-1(b) there is one measurement and the deep-chain figure is expected not to move |
| Environment | scrubbed `GIT_*`, `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, signing off — the standing procedure in `.claude/workflow/faithfulness.md`; each corpus copied per tool so neither repacks the other's output |
| Published where | the ratio table replaces the 30.4 figures in `docs/BACKLOG.md` §30.6 and `docs/use/commands/maintenance.md:227`; the interop band (§Test strategy) is set from the measured ratio with headroom, never the other way round |

What local evidence cannot establish: any claim about gc wall-clock or residency under the new
order. Those stay with the nightly `maintenance.bench.ts` scenarios, whose delta-chain docblock
is rewritten to say it now measures the *ordered* search.

### 12. Blast radius — pre-chewed context per part

| Part | Files / symbols | Current signature being changed | Helpers and fixtures to extend |
|---|---|---|---|
| Hash | `src/domain/storage/pack-name-hash.ts` (new); `src/domain/storage/index.ts` export line | — | `test/unit/domain/storage/pack-name-hash.test.ts`, `.properties.test.ts` (new); `test/unit/domain/storage/arbitraries.ts` if a byte-array arbitrary is not already there |
| Comparator | `src/domain/storage/delta-policy.ts` — `PackEmissionKey`, `comparePackEmissionOrder(a, b)` | key loses `id`, gains `nameHash`, `sourceIndex` | `test/unit/domain/storage/delta-policy.test.ts:19-126` |
| walkTree | `src/application/primitives/walk-tree.ts` — `WalkFrame`, `enterTree(maxDepth, tree, prefix, depth, ancestry)`, `nextFrameEntry(config, counter, frame)`; `src/application/primitives/types.ts:171-186` `WalkTreeEntry`, `WalkTreeOptions` | frame gains `hashState`; `enterTree` gains it as a parameter | `test/unit/application/primitives/walk-tree.test.ts` (`buildDeepTree`-style helpers via `buildSeededContext` from `test/unit/application/primitives/fixtures.ts:156`) |
| Closure engine | `src/application/primitives/internal/closure-engine.ts` — `ClosureObject`, `Emit`, `emitTree`, `resolveWants`, `walkClosure` | `Emit = (id, type, path?) => void` gains `nameHash` | `test/unit/application/primitives/internal/closure-engine.test.ts` (`buildLinearChain`, `writeBlob`, `writeCommit`, `writeTag`; path assertions at `:242-243`, `:325-326`, `:333-343`) |
| gc | `src/application/commands/internal/gc-pipeline.ts` — `computeReachableSet` (`:284`), `partitionOwned` (`:379`, sort at `:419`), `runGcTask` (`:772`, steps 3/4 at `:827-869`), the three `buildPack` calls (`:484`, `:527`, `:560`); `src/application/commands/internal/fsck/roots.ts:493` `collectRetentionRoots` (order consumer) | `partitionOwned(owned, reachable: ReadonlySet, keptOids, ownedPromisor)` → takes `ReadonlyMap<ObjectId, number>`, returns the slab with `toNormalPack` | `test/unit/application/commands/maintenance.test.ts` — `vi.spyOn(buildPackMod, 'buildPack')` at `:1919` is the pattern; assert the captured `nameHashes` and `oids` order |
| pack-objects | `src/application/commands/pack-objects.ts:79-87`, docblock `:46-56` | — | `test/unit/application/commands/pack-objects.test.ts` (`:289` inverts) |
| bundle | `src/application/primitives/enumerate-bundle-objects.ts` — `BundleObjectClosure` (`:46`), `BundleEmitState` (`:63`), `emitTreeObjects` (`:116`), `enumerateBundleObjects` (`:183`); `src/application/commands/bundle-create.ts:312` | `emitTreeObjects(ctx, treeId, uninteresting, state, seenTrees, maxDepth, depth)` gains `hashState` | `test/unit/application/commands/bundle-create.test.ts` (`buildPack` spy at `:305`); `closure-engine.test.ts` also imports `enumerateBundleObjects` |
| buildPack / deltify | `src/application/primitives/build-pack.ts` — `BuildPackInput`, `resolveWriterPlan`; `src/application/primitives/internal/deltify.ts` — `deltifyEntries(ctx, oids, policy)`, `boundCarriedContent(oids, metas, budget)`, `EmissionEntry`; `src/domain/storage/error.ts` — the union and a factory | `deltifyEntries` gains `nameHashes?: Uint32Array`; `boundCarriedContent` gains it | `test/unit/application/primitives/build-pack.test.ts` (`:441-480` invert), `test/unit/application/primitives/internal/deltify.test.ts` (`writeBlob`, `chainDepthOf`, `findEntry`, `DEFAULT_POLICY`) |
| Interop + docs | `test/integration/delta-pack-interop.test.ts` (`buildTextChurnRepo` `:111`, `parseChainDepths` `:186`, X7 `:417-437`); `docs/use/commands/maintenance.md:227`; `docs/BACKLOG.md:568`; `test/bench/maintenance.bench.ts` docblock | — | `runGit`, `tmp`, `solePackIdx`, `trackedNodeContext` in the interop file |

Barrel note: `src/application/primitives/index.ts` is an `export type *` barrel; only serena's
`find_referencing_symbols` resolves references through it. `BuildPackInput` and
`WalkTreeEntry` are re-exported there.

Mutation-gate note (from the memory hints): `vitest.stryker.config.ts` runs `test/unit/**`
only, so the slab wiring in §4c–4e is invisible to Stryker unless a unit test asserts the
callee's **captured argument**. The plan must require a `buildPack` spy assertion on
`nameHashes` content and on `oids` order at each of the five sites, and a `deltifyEntries`
spy on the `nameHashes` argument in `build-pack.test.ts`; an integration assertion alone
leaves those mutants alive with correct-looking coverage.

---

## Decision candidates

Six load-bearing choices not settled by an existing record. The session puts each to the
user; nothing below is decided here.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-1** | **The final tiebreak** — what separates objects that tie on `(type, nameHash, size)` | (a) **`sourceIndex ASC`** — the caller's input position; walk callers pass traversal order, gc sorts its path-less inputs. (b) **Keep `oid ASC`** — order-independent, set-keyed identity survives, but the deep-chain tie is left unbroken: the name hash alone cannot separate 300 same-path same-size versions (§Context). (c) **An explicit `recency?: Uint32Array` slab** alongside `nameHashes` — set-keyed identity survives when absent; a third aligned array, 4 B/object, and callers must produce it. | **(a)** | It is git's own semantics (first-seen, §1b) reduced to the one form tsgit can reproduce; it is the only key that fixes the corpus this entry exists for; and the "callers pass a deterministic sequence" discipline already governs the base-only path — gc sorts `toNormalPack` and `toPromisorPack` for exactly that reason today. Its cost is real and named in §6: three order-independence statements invert, and gc must sort cruft survivors. (b) ships half the fix and would have to be re-opened after the re-measure. (c) keeps a property no caller relies on at the price of a second slab and a second `?? 0` arm. |
| **DC-2** | **How the hash reaches `buildPack`** | (a) **`nameHashes?: Uint32Array` aligned to `oids`** — 4 B/object; the same typed-array slab shape ADR-790 chose for the result side, and the same input-alignment `emissionOrder` already assumes. (b) **`paths?: ReadonlyArray<Uint8Array \| undefined>`** — the packer hashes, as git's `add_object_entry` does; N path byte-arrays resident across the sort. (c) **`objects: ReadonlyArray<{ id, nameHash? }>` replacing `oids`** — one array, no alignment to validate; breaks the published `BuildPackInput`. | **(a)** | Smallest residency, additive, and the callers that have paths already hold them as the walk's strings — re-materialising bytes for (b) would be the "path string per object" cost the memory hint warns about, paid twice. (c) is cleaner in isolation but breaks a published input for no capability (a). |
| **DC-3** | **Where the path bytes are folded** | (a) **`walkTree` folds per frame through an optional `PathHasher`** and yields `nameHash` — byte-exact over `nameBytes`, allocation-free, opt-in so other consumers pay nothing. (b) **The closure engine re-encodes `entry.path`** with `TextEncoder` and hashes that — no walker change, one allocation per entry, and **lossy**: an invalid-UTF-8 name decodes to U+FFFD and re-encodes to `EF BF BD`, so two such names collide and neither matches git. (c) **`walkTree` yields `pathBytes`** — byte-exact, one allocation per entry for every consumer unless gated behind another option. | **(a)** | ADR-748 rules that tree-name decisions are made on bytes, which excludes (b) on principle, not just on the rare case. (c) is (a) with an allocation and a wider public field. (a)'s only cost is that a generic walker learns to fold *a* hasher — the seam is one interface, and the pack-specific constant stays in the domain. |
| **DC-4** | **Which name-hash version** | (a) **v1 only** — git's default, forced under bitmaps, no config key to honour (§1d). (b) **v1 + v2 behind a tsgit-only option** — v2 clusters by directory as well as basename; no git setting maps to it, so the option would be tsgit's alone. (c) **v2 only** — diverges from git's default on every pack. | **(a)** | Faithfulness has one default here and it is v1; there is no repository setting a v2 port would be honouring, so (b) is a tsgit-only knob and (c) a silent divergence. v2's two-word state also widens the `PathHasher` seam. Pinned vectors for v2 are recorded so adoption later is a port, not a re-pin. |
| **DC-5** | **Name hashes on the bitmap tier** (`packObjects`' default) | (a) **Walk tier only** — bitmap-tier packs hash everything to `0` and keep today's size ordering, as git does for a bitmap without a hash cache. (b) **Read the `.bitmap` name-hash cache** (`BITMAP_OPT_HASH_CACHE`, flag `0x4`, parsed at `pack-bitmap.c:272`; git fills `oe->hash` from it at `pack-bitmap.c:1749`, `:3147`) — faithful to git-with-cache, but a bitmap-format extension `bitmap.ts` does not parse today (it checks only `FULL_DAG`), and tsgit writes no bitmaps, so it helps only git-written bitmaps read by tsgit. (c) **Force the walk tier when delta emission is on** — changes `packObjects`' pinned default tier and the fewer-objects semantics of a bitmap closure with haves. | **(a)** | The gc path — the one this entry measures — is walk-tier by pin. (b) is a contained parser extension with a real faithfulness upside on git-written bitmaps, but it is a format feature with its own pin and no corpus in this entry exercises it; it is the natural next step if the user wants it in the same change. (c) trades a documented default for a size gain on one command. |
| **DC-6** | **Scope of git's other selection heuristics** (§1f) | (a) **Ordering only** — the key and the tiebreak; the four heuristics stay as named residuals. (b) **Also the depth-scaled search bound** — one formula in `selectBestCandidate`, changes which deltas win at depth. (c) **(b) plus best-base promotion in the window** — the FIFO window becomes an LRU-ish array with a move-to-front. | **(a)** | One variable per measurement is the argument ADR-773 used to keep `pack.compression` out, and it applies here verbatim: §11 attributes the deep-chain gain to the tiebreak and the many-files gain to the hash, and a bound change in the same run would make both unattributable. On the deep-chain corpus the depth-scaled bound *shortens* chains (§1f), so it cannot be what closes the gap. If the re-measure lands short, (b) is the first residual to try, with its own pin. |

---

## Test strategy

Conventions as everywhere: `describe('Given …')` > `describe('When …')` > `it('Then …')`, AAA
body, `sut`, no ignore directives, error assertions on data via try/catch.

### Unit — `test/unit/domain/storage/pack-name-hash.test.ts` (new)

| Area | Cases |
|---|---|
| vectors | every row of §1a's v1 column, as `it.each` over `[bytes, expected]` |
| whitespace set | four separate cases proving `0x09`, `0x0a`, `0x0d`, `0x20` are skipped (each alone flips the result when un-skipped); two proving `0x0b` and `0x0c` are **hashed** — one test per byte, because a single combined case lets a table mutant survive |
| high bytes | `0x80`, `0xff` contribute `c << 24` unsigned |
| window | a 16-byte tail with any prefix hashes the same; a 15-byte tail does not |
| composition | `fold(fold(seed, a), b) === packNameHash(concat(a, b))` on a fixed pair (the property file proves the grammar) |
| seed | `packNameHash(empty) === PACK_NAME_HASH_SEED === 0` |

### Property — `test/unit/domain/storage/pack-name-hash.properties.test.ts` (new)

Lenses 1 and 4 fit (compositional fold; whitespace-drop invariant). `numRuns` 200 for the
cheap ones:

- `fold(fold(seed, a), b) ≡ packNameHash(a ++ b)` over arbitrary byte arrays;
- inserting any of the four space bytes anywhere leaves the hash unchanged;
- the result is always an integer in `[0, 2³²)`; the function never throws (total);
- `packNameHash(p ++ s) ≡ packNameHash(q ++ s)` whenever `s` has ≥ 16 non-space bytes.

### Unit — `test/unit/domain/storage/delta-policy.test.ts` (extended)

- hash precedes size: same type, `nameHash` order disagrees with size order → hash wins;
- hash is DESC: two keys differing only in hash → the larger sorts first (kills `a - b`);
- size precedes `sourceIndex`; `sourceIndex` is ASC (kills the flip);
- strict total order over distinct positions; same position compares `0`;
- `id` is gone from the key — a compile-time fact, plus the existing "id ordering disagrees
  with type ordering" case re-expressed over positions.

### Unit — `test/unit/application/primitives/walk-tree.test.ts` (extended)

- no hasher → no `nameHash` field on any entry (`toStrictEqual` on the exact object shape —
  `toEqual` ignores an `undefined` property and would not see it);
- hasher → root-level entry hashes `name` (not `/name`) — the empty-prefix guard in isolation;
- nested entry hashes the full path with `/` folded; a two-level path matches §1a's
  `deep/er/churn.txt` row;
- a name containing bytes that are not valid UTF-8 hashes those bytes (spy-free: compare to
  `packNameHash` over the same `nameBytes`).

### Unit — `test/unit/application/primitives/internal/closure-engine.test.ts` (extended)

- walk tier, `objects: true`: root tree `0`; `file.txt` and `sub/deep.txt` carry
  `packNameHash` of their paths (extend the assertions at `:242-243`, `:325-326`);
- commits, tags, a directly-wanted blob: `nameHash` is `0` (extend `:333-343`, `:401`, `:464`);
- bitmap tier: `nameHash` absent (extend `bitmap-binding.closure.test.ts` or the tier tests);
- an object reachable under two paths keeps the first (arrange two commits whose trees place
  the same blob at different names; assert the first commit's hash).

### Unit — `test/unit/application/primitives/build-pack.test.ts` (extended)

- `nameHashes` threaded: `vi.spyOn` on the deltify module's `deltifyEntries`, assert the
  captured fourth argument is the very slab (identity) — the mutation-gate requirement;
- absent slab → every key hashes `0`: two same-size blobs under different hashes reorder when
  a slab is supplied and do not when it is absent;
- length mismatch: try/catch, assert `code === 'INVALID_PACK_INPUT'`, `expected`, `actual`;
  assert `readConfig`/`readObject` were not called (spy) — refused before I/O;
- `:441-480` rewritten: same sequence twice → equal bytes; a tie-dense pair in two orders →
  different bytes with the same object set read back.

### Unit — `test/unit/application/primitives/internal/deltify.test.ts` (extended)

- **the tie-dense chain**: eight same-size blobs of one lineage, all `nameHash` equal, in
  newest-first input order → each is a delta on its predecessor, chain depth 7 (via
  `chainDepthOf`); the same eight in oid order → strictly fewer deltas. This is the corpus-in-
  miniature and the test that kills the `sourceIndex` direction mutant;
- **hash grouping beats size adjacency**: two lineages with interleaved sizes and distinct
  hashes → every delta's base shares its target's hash.

### Unit — command tests

- `maintenance.test.ts`: with the existing `buildPack` spy, assert the normal-pack call
  receives `oids` in the closure's traversal order (not sorted) and a `nameHashes` slab whose
  entries equal `packNameHash` of each object's path; the cruft call receives no slab and
  sorted `oids`; the promisor call receives sorted `oids` and a slab with `0` for an
  unreachable member. The existing "second gc with nothing changed does not call buildPack for
  cruft" (`:1915-1929`) must stay green — it is the cruft-sort requirement's test. The
  single-blob resurrection pin (`:2098-2150`) stays green untouched; a **new multi-object
  resurrection** case (a commit, its tree and two blobs crufted, then re-referenced) asserts
  the ordinary route of §4c — a normal pack under a new sha, `declassifyCruftPack` not called,
  the cruft pack handled by its fate;
- `pack-objects.test.ts`: walk tier forwards non-zero hashes; bitmap tier forwards an all-zero
  slab of the right length; `:289` inverts as §6 states;
- `bundle-create.test.ts`: the `buildPack` spy at `:305` sees a slab aligned to `oids` with
  `0` for commits and the fold result for a nested blob.

### Integration — `test/integration/delta-pack-interop.test.ts` (extended)

- **New corpus builder** `buildSameSizeVersionsRepo(slug, versions)`: one path, `versions`
  revisions of a fixed-length file mutated in place through real `git commit`s (the `evolving`
  shape at interop scale). Oracles read **blob lines only** from `git verify-pack -v` (the
  `maxChainDepthOid` filter in `fixture-generator.ts` is the precedent; trees and commits are
  excluded because their deltas are decided by the deflate-size acceptance rule, not by
  ordering) and are structural by construction:
  - 45 versions — below the depth cap, so the cap never interferes: exactly **1** blob base,
    44 blob deltas, max blob chain **44** = `versions − 1`;
  - 60 versions — the cap binds: max blob chain **exactly 50**, blob bases ≤ 4 (after the cap
    the window still holds sub-cap members for the next ten emissions; a base recurs only when
    every window member is at depth 50);
  - histogram and per-object counts agree (`parseChainDepths`) — R13.
  The same repos repacked by git `-f` at `pack.threads=1` give the structural comparison —
  git's max chain is expected lower (§1f), recorded, not asserted;
- **X7 band** (`:417-437`): the peer becomes `repack -a -d -f -q`, object counts asserted equal
  first, and the upper band is set from the §11 measurement with 15 % headroom (the plan fills
  the number; the design refuses to guess it);
- every existing oracle (index-pack, fsck, verify-pack, corruption, bundle, pack-objects,
  push) unchanged and green.

### Integration — `test/integration/maintenance-interop.test.ts`

Unchanged; `:1399-1455` (gc twice → same three checksums) is R4's gate and must pass without
edits.

### Bench

No new timing scenario. `maintenance.bench.ts`'s delta-chain docblock is rewritten: it now
measures a search that finds deltas rather than one that mostly fails. Published numbers
come from the nightly artifact only.

### Mutation

Target 0 survivors. Hazards, each with a named kill:

- the `GIT_SPACE` table entries (six byte cases above); `>>> 2` vs `>> 2` (a high-bit vector);
  `<< 24` (any vector); the final `>>> 0` (the `\xff` vector, which sets bit 31);
- `frame.prefix === ''` in the walker (root-level entry test);
- `nameHash` DESC vs ASC; `sourceIndex` ASC vs DESC (the deltify chain test);
- `nameHashes?.[i] ?? 0` (absent-slab test); the length check `!==` (mismatch test — both
  `length + 1` and `length - 1`);
- `?? 0` arms: `packObjects` (bitmap tier), gc promisor lookup (unreachable member),
  gc reachable-map construction — the last is documented in §4c as reachable only via a tier
  gc never uses; the test asserts the walk-tier values and the mutant that drops the `?? 0`
  is an equivalent mutant on the gc path, to be **re-proved against the code as written**,
  not carried forward.

---

## Out of scope

- **The v2 hash** (DC-4 unless chosen), `--path-walk` packing, delta islands, `pack.island*`.
- **Preferred bases and thin packs** — structurally absent under ADR-774; the term is constant.
- **git's other selection heuristics** — the depth-scaled bound, the size pre-filters, the
  cross-type `break`, best-base promotion (DC-6 unless chosen). Named residuals for the
  re-measure.
- **The `.bitmap` name-hash cache** (DC-5 unless chosen) and any bitmap writing.
- **git's write order** (`compute_write_order`) — emission stays search order.
- **`-delta` gitattributes** (`no_try_delta`) — git skips delta selection for matching paths;
  tsgit reads no attributes on this path. A faithfulness gap recorded for a later entry.
- **Path hints for directly wanted objects** — the `resolveWants` `0` (§1c) is accepted; giving
  index-entry roots their index path would mean `collectRetentionRoots` carrying names.
- **Pruning re-walked subtrees in `closure-engine.ts`'s `emitTree`** — a pre-existing cost,
  independent of this change.
- **Timing claims of any kind** — the nightly bench owns them.
