# Design — name-hash ordering for delta-base selection

> Brief: 30.4's packer orders delta-window candidates by `(typeRank, size DESC, oid ASC)`;
> git orders by type, then a path-derived **name hash**, then size, then first-seen order.
> Thread the path the reachability walk already discovers into `buildPack` as a name hash,
> amend the ordering half of ADR-769, revisit the alternative it declined, and re-measure
> against a peer command whose object set is comparable.
> Status: draft → self-reviewed ×3 (pass 1: citations pinned to v2.55.0 line numbers, corpus
> sizing, root-order assumption; pass 2: the `reuse: 'cruft'` identity, bundle enumerator has
> no closure object; pass 3: DC table and measurement contract against the body) → decisions
> ratified as ADRs 826–831 → **revised against the ADRs** (four of six went against the
> recommendation; the §Ratified decisions block is authoritative, and the window heuristics
> DC-6 pulled into scope are pinned from source and from real git in §1f) → awaiting the three
> new decision candidates the revision surfaced (DC-7 to DC-9)

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
| `push.ts:353` | closure, base-only pack (ADR-767) | No delta emission — untouched by the ordering, but it passes `oids` and so migrates its input shape under ADR-827 (§12) |

So the brief's "`pack-objects` and `bundle-create` already carry `ClosureObject.path`" is half
right: `pack-objects` does on the walk tier; `bundle-create` has the raw name bytes but no
path, and no closure object. The gc path is the one that discovers and discards.

ADR-769 declined the path hint with *"helps only the callers that have paths; gc has none"*.
The table shows the premise was wrong in a specific way: gc's reachability walk has every
path git's has — it is the reduction to a `Set<ObjectId>` one line later that loses it.
Threading it through is one type change on `computeReachableSet`'s return, one on
`partitionOwned`'s input, and — under ADR-827 — a per-object `{ id, nameHash?, recency? }`
input to `buildPack` in place of the bare oid array.

The table also under-counts the callers. `buildPack` has **six** call sites, not the five
ADR-769 and ADR-827 name: the five delta-emitting ones (gc ×3, `pack-objects`,
`bundle-create`) plus `push.ts:353`, which is base-only. The five-count was the count of
callers that *opt in* to delta emission (ADR-767); it was already off by one as a count of
callers that pass `oids`, and ADR-827's breaking input change touches all six (§12).

### Governing decision records

| ADR | Subject | What this design does with it |
|---|---|---|
| 826 | Emission key is `(typeRank, nameHash DESC, size DESC, recency ASC, oid ASC)`; `recency` is caller-supplied and absent by default | **Governing** — §3 is its key; §6 is its two-mode determinism analysis; gc is the only caller that supplies recency |
| 827 | `BuildPackInput.oids` → `objects: ReadonlyArray<{ id, nameHash?, recency? }>` — breaking | **Governing** — §4f, §8, §12; all six call sites migrate in one step |
| 828 | The hash folds through an optional `PathHasher` in `walkTree`; `walkTree` separately gains opt-in `pathBytes` | **Governing** — §4a is the fold; §4g is the `pathBytes` capability the packer does not use |
| 829 | Name-hash version 1 only | **Governing** — §1d, §2; v2 vectors recorded as data |
| 830 | Walk tier only; bitmap-tier objects hash to `0` | **Governing** — §4d, §5 |
| 831 | Ordering, the depth-scaled bound and best-base promotion all ship, as three separately measured stages | **Governing** — §1f pins the two heuristics from source and from real git; §4h/§4i design them; §11 is the staged contract; §12 makes each stage its own part |
| 769 | Metas are identified triples in emission order; emission order is `buildPack`'s own concern | **Amended by ADR-826** (its Status line now says so): the identified-triples half stands untouched; the ordering half (`(typeRank, size DESC, oid ASC)` in its Context, and declined option 3) is superseded by the key in §3. §10 states the amendment precisely |
| 767 | Delta emission is opt-in per caller (gc ×3, `pack-objects`, `bundle-create`) | Unchanged — the five opt-in sites gain hashes; `push` stays base-only and migrates its input shape only (§12) |
| 768 | Pure codec + comparator in the domain, lazy window in `deltify.ts` | Followed — the hash and the widened comparator are pure domain functions; `deltify.ts` only threads a number |
| 771 | Writer clamps to depth 50; both readers accept it | Unchanged; the tiebreak makes the cap *reachable* on the deep-chain corpus, which is the point |
| 772 | `pack.windowMemory` bounds residency; no per-object cap | Unchanged; the hash adds no window residency (§7) |
| 773 | Config surface is `window`/`depth`/`windowMemory` | Unchanged — git 2.55.0 has **no** `pack.nameHashVersion` config key (§1d), so no new key arises |
| 776 | `PackWriterEntry` is the union | Untouched — the writer never sees the hash |
| 790 | The oid slab is born in `buildPack`; typed-array slabs on the write path | Followed on the **result** side — `emissionOrder` and `entries` keep their slab shapes. The input side is not a slab: ADR-827 chose identified objects over an aligned `Uint32Array`, for the alignment reason ADR-769 gave on the result side |
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

## Ratified decisions — authoritative

Every decision candidate below was put to the user and settled as ADRs 826–835. **This
section overrides any contrary recommendation later in this document**, including the
Decision-candidates table, which is kept as the record of what was weighed and is annotated
row by row. Ten candidates were settled in two rounds: DC-1 to DC-6 as ADRs 826-831, then DC-7 to DC-10 — surfaced by the revision pass — as ADRs 832-835. Four of the ten differ from the recommendation, all of them in the first round. The affected sections
were rewritten in the revision pass rather than annotated inline, so the body already says
what was decided; the corrections list below is the map of what moved.

| # | Ratified outcome | ADR | Diverges from the recommendation? |
|---|---|---|---|
| DC-1 | Key is `(typeRank, nameHash DESC, size DESC, recency ASC, oid ASC)`. `recency` is an optional per-object value the caller supplies; absent by default, so emission stays set-keyed and input-order-independent for every caller that does not opt in. gc opts in with its traversal ordinal. | 826 | **Yes** — recommendation was an unconditional `sourceIndex ASC` |
| DC-2 | `BuildPackInput.oids` is replaced by `objects: ReadonlyArray<{ id, nameHash?, recency? }>`. Breaking; all six call sites migrate in one step. | 827 | **Yes** — recommendation was an aligned `Uint32Array` slab |
| DC-3 | The hash folds per frame through an optional `PathHasher` in `walkTree` (as recommended) **and** `walkTree` gains an additive opt-in `pathBytes` option, default off, which the packer does not use. | 828 | **Yes (hybrid)** — recommendation was the fold alone |
| DC-4 | v1 only; v2 vectors recorded as data. | 829 | No |
| DC-5 | Walk tier only; bitmap-tier objects hash to `0`. | 830 | No |
| DC-6 | Ordering, the depth-scaled search bound and best-base promotion all ship in this change, as three separately committed and separately measured stages. | 831 | **Yes** — recommendation was ordering only |
| DC-7 | A `buildPack` input mixing objects that carry `recency` with objects that do not is refused (`INVALID_PACK_INPUT`, `reason: 'mixed-recency'`); gc synthesises ordinals for unreachable promisor members at `reachable.size + i` over the oid-sorted array. | 832 | No |
| DC-8 | Max-depth non-admission lands in the same commit as best-base promotion (stage 3), recording one measured zero for both. | 833 | No |
| DC-9 | git's 50-byte delta floor lands as a **fourth** measured stage: `DELTA_FLOOR_BYTES = 50`, under-floor objects emitted as bases and never admitted. | 834 | No |
| DC-10 | The search bound replicates git's unsigned underflow, so an object below `2 × hashSize` searches unbounded, pinned with sha1 and sha256 vectors. | 835 | No |

### Corrections to this document

1. **§6 was written for DC-1(a) and was wrong under DC-1(c).** Of the three "inverting"
   statements it listed, the two `build-pack.test.ts` permutation tests survive unchanged
   (they pass no recency), the `pack-objects.ts` docblock is qualified rather than withdrawn,
   and only `pack-objects.test.ts:289` still inverts — because of ADR-830's tier asymmetry in
   the *hash*, not because of the tiebreak. §6 is rewritten around the two modes.
2. **§4c's cruft-survivor sort is withdrawn.** It existed only because an unconditional
   `sourceIndex` made every input sequence-keyed. The cruft pack passes no recency, so its sha
   stays a function of the set and the `existingCruftShas.has(pack.sha)` reuse survives with
   no new sort.
3. **The `oids`/slab vocabulary is gone.** Every `nameHashes` slab, every `?? 0` slab arm
   and the length check in §4–§9 are restated as field absence on an identified object. The
   one input guard `buildPack` keeps is the mixed-recency refusal — DC-7, new.
4. **§1f is no longer a residual list.** It pins the window mechanics ADR-831 pulled into
   scope from source and from real git, and names two divergences the first draft missed —
   max-depth non-admission and git's 50-byte delta floor — as DC-8 and DC-9.
5. **§11 is a three-stage contract.** The published number is a composite; only stage 1's
   measurement supports a "what ordering bought" claim.
6. **R11 is inverted.** `BuildPackInput` breaks. Three `feat(…)!:` commits already sit
   between `v3.6.0` and `main`, so the break folds into the pending major.
7. **The caller count is six**, not five (§Context, §12).

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
  recency ASC, id ASC)` — a strict total order over any input in which ids are unique. When
  every object's recency is absent the `recency` term is inert and the order is
  `(type, nameHash, size, id)`: a function of per-object values only.
- **R4** For a fixed `(objects sequence, config)`, `buildPack` produces the same bytes on every
  call. In the recency-absent mode the bytes are additionally a function of the **set** of
  `(id, nameHash)` pairs, independent of input order. Two gc runs over an unchanged
  repository reproduce the same normal, promisor and cruft pack checksums (the existing
  `maintenance-interop.test.ts:1399-1455` pin); gc seeds its closure from sorted roots so its
  traversal — and therefore the recency it passes — is a pure function of the graph.

**Where the hash comes from**

- **R5** On the walk tier, every tree and blob `ClosureObject` carries `nameHash` computed
  over its full byte path with git's naming: root tree `''` → `0`; nested `a/b` folded over
  `a`, `/`, `b`; first-seen path wins. Commits, tags and directly-wanted blobs carry `0`. The
  bitmap tier carries no `nameHash` field.
- **R6** gc hands the normal pack its reachable objects in **traversal order**, each with its
  hash and `recency` = its traversal ordinal; the promisor pack oid-sorted, each with its hash
  (`0` for an unreachable member) and a recency (the ordinal for a reachable member, a value
  after every ordinal for an unreachable one — DC-7); the cruft pack with neither hash nor
  recency (every member is unreachable — git names them `""`).
- **R7** `packObjects` forwards the closure's objects unchanged — no recency; on the bitmap
  tier no hash. `bundleCreate` computes hashes inside its own enumerator from `entry.nameBytes`
  and passes no recency.
- **R8** `BuildPackInput.objects` is `ReadonlyArray<{ id, nameHash?, recency? }>`. An absent
  `nameHash` reads as `0`. Recency is all-or-nothing per call: an input where some objects
  carry `recency` and others do not is refused before `readConfig` or any object read, with
  error data naming both counts (DC-7's recommended shape; the alternative shapes are in the
  DC row and touch only this requirement, §3 and §4c).

**The walker**

- **R15** `walkTree(…, { pathBytes: true })` yields on every entry `pathBytes: Uint8Array` —
  the exact concatenation of every ancestor's `nameBytes` and the entry's own, joined by
  `0x2f`, with no trailing separator — a fresh array per entry, absent when the option is off,
  independent of `pathHasher`, and subject to `recursive` / `maxDepth` / `maxEntries` exactly
  as `path` is.

**The window**

- **R16** The search bound is git's `try_delta` bound (§1f): for a target with no incumbent,
  `floor(size / 2) − hashSize` at reference depth 1; with an incumbent, the incumbent's delta
  size at reference depth = incumbent base depth + 1; either scaled by
  `(maxDepth − baseDepth) / (maxDepth − refDepth + 1)` in truncating integer arithmetic. A
  bound of `0` refuses the candidate; a negative pre-scale bound (size below `2 × hashSize`)
  is unbounded, which is git's unsigned wrap — pinned in §1f. A candidate whose delta equals
  the incumbent's size replaces it only from a strictly shallower base.
- **R17** On a delta hit the chosen base is moved to the most-recent window slot and the
  newly emitted object sits directly behind it; a delta emitted at `maxDepth` is not admitted
  to the window and triggers no promotion (DC-8's recommended shape).

**What must not change**

- **R9** Every existing validity oracle holds on packs written under the new order:
  `git index-pack --strict`, `git fsck --strict`, `git verify-pack -v`, tsgit's own fsck and
  `readObject`; max chain depth ≤ 50 (ADR-771).
- **R10** The `.idx`, `.rev`, cruft `.mtimes` and midx paths are untouched — all are oid-keyed
  and consume `PackIndexEntries` as before; `emissionOrder` still maps ordinal → index into
  `objects`.
- **R11** `BuildPackInput` **breaks**: `oids` is removed and `objects` replaces it (ADR-827),
  folded into the pending major. `WalkTreeEntry` and `WalkTreeOptions` gain optional fields
  only. `reports/api.json` is regenerated.
- **R12** Steady-state residency: no path string is retained that is not retained today; the
  per-object costs are the ones §7 tables — one input wrapper per object on the gc, bundle,
  cruft and push inputs, none on `pack-objects`, 8 B per tree-walk frame.

**The measurement**

- **R13** On a tie-dense corpus (one path, constant-size versions), after **stage 1** every
  version but the chain roots is emitted as a delta and the maximum chain reaches
  `min(versions − 1, pack.depth)` — a structural oracle, asserted through
  `git verify-pack -v`, independent of any size ratio. After **stage 2** the cap is no longer
  the binding limit; the oracle becomes a band on max chain and base count set from the
  stage-2 readout with git's own readout recorded beside it (§11).
- **R14** The size ratio against the §11 peer is recorded per **stage** for
  `DELTA_CHAIN_FIXTURE`, `MEDIUM_FIXTURE` and a fresh clone of tsgit's history, each with equal
  object counts on both sides and the git version stated, before the backlog entry is ticked;
  the published table carries all three stages, never a single composite.

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
| pointer compare | first-seen order (`packlist_alloc` is sequential; commits newest-first) | **`recency` ASC, then `oid` ASC** — `recency` is caller-supplied per object and absent by default (ADR-826); gc passes its traversal ordinal, every other caller passes none and falls through to `oid ASC`, today's tiebreak |

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
| unreachable object (cruft; `--keep-unreachable`, `--pack-loose-unreachable`) | `""` (`:4496`, `:4550`) | `0` | cruft-pack input carries no `nameHash` field → `0` |
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

#### 1f. Window mechanics compared — pinned, and what ADR-831 pulls into scope

`find_deltas` (`builtin/pack-objects.c:2972-3112`) and `try_delta` (`:2789-2943`) carry
heuristics beyond ordering. The first draft listed four and left all of them out; ADR-831
brings two in as measured stages 2 and 3. Re-reading both functions for this revision, and
running real git against small inputs, found two more the draft never named. All six:

| git heuristic | Source | tsgit today | This change |
|---|---|---|---|
| **Depth-scaled search bound.** `max_size = trg_size/2` minus the hash size at `ref_depth = 1` when the target has no delta yet, else `max_size = DELTA_SIZE(trg)` at `ref_depth = trg->depth`; then `max_size = max_size × (max_depth − src->depth) / (max_depth − ref_depth + 1)` in `uint64_t` arithmetic; `0` refuses | `:2823-2834` | flat `floor(size × 0.5)`; incumbent bound `best.delta.length − 1` | **Stage 2** (§4h) |
| **Shallower same-size preference.** A candidate whose delta equals the incumbent's size wins only if `src->depth + 1 < trg->depth` | `:2909-2916` | unreachable — the incumbent bound is strict | **Stage 2**, it is the same rule's other half |
| **Best-base promotion.** After a hit the base rotates to the slot of the just-emitted object — the most recent — and the emitted object sits one behind it | `:3087-3097` | FIFO, no promotion | **Stage 3** (§4i) |
| **Max-depth non-admission.** An object that just became a delta at `max_depth` is not admitted to the window (`continue` skips `idx++`, so its slot is reused) and no promotion runs | `:3079-3080` | admitted like any other; refused as a base by `tryCandidate`'s depth guard but holding a slot | **DC-8** — recommended: fold into stage 3, same function |
| **50-byte floor.** `should_attempt_deltas` excludes any object under 50 bytes from `delta_list` — neither a target nor a base | `:3384-3386` | every object is offered | **DC-9** — new, byte- and structure-moving |
| Size pre-filters (size difference at or above the bound — `:2837`; target under 1/32 of the source) and the cross-type scan `break` | `:2835-2840`, `:3039-3040` | none / scans on refusing | residual — CPU-only on every corpus here; the 1/32 rule can in principle refuse a delta tsgit would take, on a tiny target against a huge base; not measured |

**Pinned from real git 2.55.0** — two-commit repositories, one file rewritten in place with a
one-byte change at the tail, `git -c pack.threads=1 repack -a -d -f`, read back with
`git verify-pack -v`; scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off:

| object format | sizes → both bases | sizes → one delta of 6 bytes | what it pins |
|---|---|---|---|
| sha1 (hash size 20) | 49, 50, 51 | 52, 53, 54 | 49: the floor. 50, 51: `25 − 20 = 5 < 6`. 52: `26 − 20 = 6`, and a 6-byte delta is accepted — `create_delta` refuses only an output position strictly above `max_size` (`diff-delta.c:503`), so the bound is **inclusive** |
| sha256 (hash size 32) | 49; 64, 65, 66, 70 | 50, 56, 62, 63; 76, 78, 80 | 49: the floor. 50–63: `size/2 − 32` is negative in `unsigned long`, wraps, and the search is **unbounded** — the wrap is reachable and git deltas them. 64, 65: `32 − 32 = 0` refuses. 66–70: bound 1–3, under 6. 76: `38 − 32 = 6` |

The wrap is not a curiosity for tsgit: sha256 repositories are supported, and under sha1 any
object below 40 bytes would hit it too were it not for the floor. Stage 2 replicates it as
"no bound" (R16); DC-9 decides whether the floor that hides it under sha1 is replicated as
well.

**What the depth scaling does on the deep-chain corpus**, from the formula: with no
incumbent, a base at depth `d` is allowed `(2 048 − 20) × (50 − d) / 50` bytes for a
4 096-byte target — 2 028 at depth 0, 1 014 at 25, 40 at 49. A 1 %-flip step between
adjacent versions costs roughly 200–250 delta bytes, which the bound stops admitting around
`d ≈ 44`; the chain restarts from a fresh base and git's `verify-pack` shows the ~43 the
brief measured. tsgit's flat bound admits the same step at every depth up to the cap of 50,
so stage 1 alone runs chains to 50 and packs **smaller** than git on this corpus; stage 2
gives that back deliberately (ADR-831: faithfulness over size). Promotion (stage 3) changes
nothing on a chain — the predecessor is already the most recent member — and nothing on
`MEDIUM_FIXTURE`'s short chains either; its stage exists to record that zero.

The window's *shape* is already git's: git passes `window + 1` slots (`:3663`) and scans the
`window` others most-recent-first (`:3028-3043`); `selectBestCandidate` walks a
`policy.window`-sized array back to front. Memory eviction is oldest-first on both sides
(`:3002-3008`; `evictToFit`).

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
/** A recency-absent object: every such object ties on this term and falls to `id`. */
export const NO_RECENCY = 0;

export interface PackEmissionKey {
  readonly id: string;
  readonly type: BasePackEntryType;
  readonly nameHash: number;          // uint32; 0 for a path-less object
  readonly uncompressedSize: number;
  /** Caller-supplied first-seen ordinal, or NO_RECENCY when the caller passed none. */
  readonly recency: number;
}
export function comparePackEmissionOrder(a: PackEmissionKey, b: PackEmissionKey): number {
  if (a.type !== b.type) return a.type - b.type;
  if (a.nameHash !== b.nameHash) return b.nameHash - a.nameHash;
  if (a.uncompressedSize !== b.uncompressedSize) return b.uncompressedSize - a.uncompressedSize;
  if (a.recency !== b.recency) return a.recency - b.recency;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
```

`id` **stays** in the key — it is the final term, exactly as today, and it is what keeps the
recency-absent mode a function of per-object values. `recency` sits between size and id. The
comparator itself has no conditional: `deltify.ts` normalises an absent `recency` to
`NO_RECENCY` in the one place it builds keys (§4f), and `buildPack` has already refused an
input that mixes present and absent (§4f, DC-7), so within one sort either every key carries
a caller ordinal or every key carries `NO_RECENCY` and the term is inert. `b.nameHash -
a.nameHash` and `a.recency - b.recency` are exact — both operands are non-negative integers
below 2⁵³, so the difference is an exact float64 integer. The module doc's claim "no two
distinct objects compare equal because oids are unique" stands unchanged, and the existing
"duplicate oid compares equal" case (`delta-policy.test.ts:109-125`) stays as it is.

Two of git's terms are deliberately not modelled — `preferred_base` (constant under ADR-774)
and delta islands (opt-in, unimplemented) — and the final term diverges from git's pointer
compare on purpose (ADR-826: determinism wins; the interop oracle is structural, never a
pack sha).

### 4. Layer 3 — the application layer, from the tree walk to the window

The hash is computed exactly where the path bytes are in hand and travels onward as a
`number` on an identified object; no layer allocates or retains a path it does not already
hold. The window (§4h, §4i) is the other half of this layer: it consumes the order the first
half produces.

```
walkTree ── nameHash per entry ──▶ closure-engine ── ClosureObject.nameHash ──▶ pack-objects ─┐
                                                                             └─▶ gc-pipeline ──┤  + recency (gc only)
enumerate-bundle-objects ── own fold over entry.nameBytes ──▶ bundle-create ────────────────────┤
push ── oids.map((id) => ({ id })) — base-only, no hash, no recency ────────────────────────────┤
                                                                                               ▼
                                          buildPack({ objects: [{ id, nameHash?, recency? }] })
                                                                                               ▼
                                                     deltifyEntries(ctx, objects, policy)
                                                                                               ▼
                       PackEmissionKey → comparePackEmissionOrder → window (bound §4h, promotion §4i)
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
in isolation (§Test strategy). The fold is independent of §4g's `pathBytes`: either option
may be on without the other, and the packer's walk turns on only the fold.

#### 4b. The closure engine (`src/application/primitives/internal/closure-engine.ts`)

`ClosureObject` gains `readonly nameHash?: number` with the doc "git's `pack_name_hash` of
`path`; `0` for a path-less object; populated by the walk tier only — a reachability artefact
encodes types and bits, never names, so the bitmap tier never fills this" (mirroring `path`'s
existing note at `:67-75`). `Emit` (`:86`) gains a fourth parameter. `emitTree` walks with
`{ pathHasher: PACK_NAME_HASH_V1 }` and passes `entry.nameHash`; the root emits
`PACK_NAME_HASH_SEED`. `resolveWants` and the commit emitters pass `0` explicitly, so on the
walk tier the field is always a number. The fold runs on every walk-tier closure, `rev-list`
included: its cost is a few dozen byte operations per visited entry against a tree read and
parse per tree, and keeping `ClosureObject` uniform on the walk tier is worth more than an
opt-in flag on `ClosureRequest` (non-decision, §6).

`ClosureObject` is, deliberately, already assignable to `buildPack`'s per-object input: it has
`id` and an optional `nameHash`, and it has no `recency`. That is what lets `packObjects` pass
the closure's own array through untouched (§4d).

`emitTree` re-walks subtrees an earlier commit already emitted — an existing cost this design
neither adds to nor fixes; `tryEmit` rejects the repeat before the hash is stored, so the
first-seen rule holds.

#### 4c. The gc pipeline (`src/application/commands/internal/gc-pipeline.ts`)

`computeReachableSet` (`:284-293`) becomes `computeReachable`, returning the closure's objects
in traversal order together with an insertion-ordered `ReadonlyMap<ObjectId, number>` from id
to traversal ordinal — the ordinal is the recency gc will pass. It **sorts the roots** before
handing them to `computeClosure` as `wants`: `collectRetentionRoots` returns a `Set` whose
insertion order follows ref, reflog, index and worktree enumeration, nothing today depends on
that order, and with recency in play the walk must be a pure function of `(sorted roots,
graph)` — independent of where objects live, which is what makes run 2 reproduce run 1 across
the loose→packed transition (R4).

`partitionOwned` (`:379-420`) takes the reachable objects and the ordinal map and produces the
normal-pack input by iterating **the closure**, not `owned`: every reachable object that is not
kept and is either owned or a promisor-pack member goes to `toNormalPack` as
`{ id, nameHash, recency: ordinal }`, in traversal order. That is the same set the two existing
loops produce — `reachable ∩ (owned ∪ ownedPromisor) \ kept` — collected in one pass. The
wrapper is built by one small helper, `toPackInput(object, recency)`, whose `nameHash ??
PATHLESS_HASH` arm is reachable only through the bitmap tier gc never uses; the helper is
unit-tested directly with a hash-less object so that arm is a tested branch, not an
equivalent mutant carried forward. The `toNormalPack.sort()` at `:419` and its Pin W comment
go: the sort existed because the base-only path emits in input order and `owned`'s iteration
order depends on where objects live; traversal order is a function of the graph and the sorted
roots alone, so Pin W holds by construction on both the delta and the base-only path.

`cruftCandidates` keeps its `owned`-order derivation and is **not** sorted — the first draft's
sort is withdrawn (§Corrections 2). The cruft pack passes neither hash nor recency, so its
bytes are a function of the survivor set alone whatever order `survivors` arrives in, and the
`existingCruftShas.has(pack.sha)` reuse at `:561` keeps matching on every run.

`toPromisorPack` (`:859`) is already oid-sorted and stays so; it is mapped to inputs by ordinal
lookup: a reachable member gets its walk hash and its ordinal, an unreachable member gets
`nameHash: 0` and `recency: reachable.size + i` for its index `i` in the sorted array — "first
seen after everything reachable, in oid order", a deterministic sequence that keeps the
promisor pack in the recency-present mode without a mixed input (DC-7). Under DC-7's
alternative (b) the unreachable members would simply carry no recency and sort last by
construction; the bytes are identical, only the caller's work differs.

The three `buildPack` calls become:

| Site | `objects` | mode |
|---|---|---|
| normal (`:484`) | `toNormalPack` — traversal order, `{ id, nameHash, recency }` | recency-present: sha is a function of the set, the hashes **and** the traversal sequence |
| promisor (`:527`) | oid-sorted, `{ id, nameHash, recency }` as above | recency-present |
| cruft (`:560`) | `survivors.map((id) => ({ id }))` | recency-absent: sha is a function of the set; a wrapper per survivor is a genuine new allocation (§7) |

`emissionOrder` on the cruft result still maps ordinal → `survivors` index for `mtimeAt`;
nothing on that path changes.

**One identity weakens, and it is named here rather than discovered.** `buildAndWriteNormalPack`
reports `reuse: 'cruft'` (`:492-496`) when the fresh normal pack's sha equals an existing cruft
pack's — the "resurrected cruft set moving intact into the normal pack" case that
`declassifyCruftPack` (`:920-922`) then handles in place. That equality needs the same object
set **and the same emission bytes**; today both packs are built from oid-sorted, hash-less
input, so any resurrected set reproduces. After this change the normal pack is built with
hashes and recency and the cruft pack with neither, so a multi-object resurrected set
generally yields a *different* sha: gc then takes the ordinary route — a new normal pack is
written, the cruft pack's objects are no longer survivors, and the cruft lifecycle retires or
rewrites it. The arm stays reachable and keeps its tests: the resurrection pins
(`maintenance.test.ts:2098-2150`, `maintenance-interop.test.ts:577-600`) resurrect a
**single** blob, and a one-object pack has no order for a key to change. The plan adds the
multi-object case and asserts the ordinary route (new sha, no `declassifyCruftPack` call,
cruft retired through its own fate), so the weakened identity is covered rather than assumed.

#### 4d. `packObjects` (`src/application/commands/pack-objects.ts:79-87`)

```ts
const pack = await buildPack(ctx, { objects: closure.objects, delta: true });
```

The `oids` map at `:86` is deleted and the closure's own array is passed through: on the walk
tier every object carries its hash, on the bitmap tier — this command's **default** — none
carries one, and `boundCarriedContent`'s `?? 0` (§4f) is the single place that reads absence.
No object carries `recency`, so this caller stays in the recency-absent mode. The
`PackObjectsResult.packId` doc (`:46-56`) is **qualified, not withdrawn**: "never compare this
across tiers" stands and is now true on the delta path for a second reason — the two tiers
supply different hashes for the same set — while "not of the closure's own traversal order"
stays literally true. `pack-objects.test.ts:289`'s cross-tier `packId` equality inverts into an
inequality on the same object set, attributable to ADR-830 (§6).

#### 4e. `bundleCreate` (`src/application/primitives/enumerate-bundle-objects.ts`)

`emitTreeObjects` (`:116-160`) is a recursion over `treeObj.entries` with `entry.nameBytes`
in hand at every step, so it folds the hash itself: the recursion gains a `hashState`
parameter (root = seed), each entry's hash is `fold(fold(state, SLASH) unless root, nameBytes)`,
and a subtree's call receives its own hash as state. `BundleObjectClosure.objects` (`:46-55`)
becomes `ReadonlyArray<{ id, nameHash }>` — the identified shape `buildPack` now takes — and
`BundleEmitState` (`:63`) pushes `{ id, nameHash }` on every successful `tryEmit`; commits and
tags push `nameHash: 0`. `bundle-create.ts:312` passes `closure.objects` straight through, no
recency. The `seenTrees` prune (`:125`) means a subtree already emitted under an earlier path
is never re-entered — the same first-seen rule as git's `SEEN` flag, with no second hash ever
computed.

The uninteresting-side walk (`collectTreeObjects`, `:79-114`) computes nothing: its objects
are never packed.

#### 4f. `buildPack` and `deltifyEntries`

`BuildPackInput` **changes shape** (ADR-827):

```ts
export interface PackObjectInput {
  readonly id: ObjectId;
  /** git's `pack_name_hash` of the object's path. Absent, or `0`, for an object
   *  the caller has no path for — what git itself does for an object it has no
   *  name for. */
  readonly nameHash?: number;
  /** The caller's first-seen ordinal — git's pointer-order tiebreak in the one
   *  form a caller can reproduce. Present on every object or on none: a mixed
   *  input is refused. When present the pack's bytes are a function of the
   *  sequence as well as the set, so pass a deterministic one. */
  readonly recency?: number;
}
export interface BuildPackInput {
  readonly objects: ReadonlyArray<PackObjectInput>;
  readonly delta?: boolean;
}
```

`buildPack` validates recency uniformity first — before `readConfig`, before any read, and
regardless of `delta`, since a mixed input is a caller defect whatever path follows — and
throws `invalidPackInput('mixed-recency', withRecency, withoutRecency)`, a new
`INVALID_PACK_INPUT` member of the storage error union with `{ reason, present, absent }`
data, so the assertion in the test can name all three. (This is DC-7's recommended shape; its
alternatives delete this guard and normalise instead — the DC row lists exactly what moves.)
Degenerate inputs keep their existing behaviour: an empty `objects` builds the empty pack; a
single object is emitted as a base whatever its hash or recency, because a one-entry sort has
no order to change.

`BuildPackResult.emissionOrder`'s docblock is restated: "Emission ordinal → index into the
`objects` this build was given. The packer emits in its own `(type, nameHash, size, recency,
oid)` order, so a caller holding per-object data keyed by ITS order — `gc`'s cruft mtimes are
the case — maps across with this instead of decoding an oid per object."

`resolveWriterPlan` threads `objects` to `deltifyEntries(ctx, objects, policy)`, whose
signature changes from `oids` to `objects`. `boundCarriedContent` (`deltify.ts:93-117`) builds
each `EmissionEntry` key as `{ id, sourceIndex: i, type, uncompressedSize, nameHash:
object.nameHash ?? 0, recency: object.recency ?? NO_RECENCY }` — the one place either absence
is read. `DeltifiedEntry.sourceIndex`'s docblock (`:41-48`) is restated from "(type, size,
oid)" to the new key. The base-only path (`buildBaseEntries`) reads `object.id` in input
order and needs no key. The window, the acceptance rule, the budget and the carried-content
bound are all downstream of the sort and unchanged by stage 1; stages 2 and 3 change the
window and are §4h and §4i.

#### 4g. `walkTree` yields path bytes on request (ADR-828, second half)

An additive, opt-in capability the packer does **not** use. It ships because the walker's
surface has a documented correctness gap: `walkTree` exposes only `path`, a decoded string,
while `TreeEntry.name`'s own docblock (`src/domain/objects/tree.ts:29-30`) says the decoded
name is "never read to make a decision; `nameBytes` is the authoritative value". A consumer
that must decide on bytes — the class ADR-748 created — cannot get them through the walker
today; the byte-level consumers that exist (`resolve-tree-path`, `walk-submodules`, fsck,
archive) all bypass the walker and read `tree.entries` directly. Zero of the twelve `walkTree`
call sites read name bytes through it. The gap is therefore latent, and ADR-828 accepted
closing it without a first consumer as the price of not leaving a public walker that can only
lie about names.

**Option shape.** `WalkTreeOptions.pathBytes?: boolean`, default `false`. `WalkTreeEntry.pathBytes?:
Uint8Array`, present on every yielded entry exactly when the option is on.

**What it yields.** The entry's full path as bytes: every ancestor's `nameBytes` and the
entry's own, joined by `0x2f`, no leading or trailing separator, a root-level entry being its
`nameBytes` alone. It is a fresh `Uint8Array` per entry, owned by the consumer — the same
ownership rule `TreeEntry.nameBytes` states — so a consumer may keep or mutate it without
touching the walk. `path` is unchanged and stays the display view; the two are related by
`path === decodePreservingBom(pathBytes)` only for names that decode losslessly, which is
exactly the point.

**Mechanics.** `WalkFrame` gains `readonly prefixBytes: Uint8Array | undefined` — the frame's
own private copy of its tree's path bytes, `undefined` when the option is off and an empty
array at the root. `nextFrameEntry` builds `pathBytes` as `prefixBytes.length === 0 ?
nameBytes.slice() : concat(prefixBytes, SLASH, nameBytes)`; `enterTree` receives a **copy** of
the directory entry's `pathBytes` as the child frame's `prefixBytes`, so the array the
consumer was handed and the array the walker keeps are never the same object. Cost when off:
one `undefined` check per entry, no field on the yielded object (`toStrictEqual` in the test
sees the exact shape). Cost when on: one allocation of `prefix + 1 + name` bytes per entry plus
one copy per directory entered — O(path length) per entry, which is precisely the residency
this design keeps off the packer, and why the packer uses the fold (§4a) instead.

**Interaction with the other options.** `recursive: false` yields root-level entries with
`pathBytes === nameBytes.slice()` and never enters a frame. `maxDepth` and `maxEntries` fire
in `enterTree`/`nextFrameEntry` before any bytes are built, exactly as for `path`. `pathHasher`
is independent: both on yields both fields, and the hash is still folded from `nameBytes` per
frame, never re-derived from `pathBytes`.

**Its own tests** are in §Test strategy; the load-bearing one is two entries whose names decode
to the same string (an invalid-UTF-8 byte and `EF BF BD`) yielding equal `path` and unequal
`pathBytes`.

#### 4h. Stage 2 — the depth-scaled search bound (`deltify.ts`, `selectBestCandidate` / `tryCandidate`)

Replaces the flat `Math.floor(content.length * DELTA_ACCEPT_RATIO)` and the strict incumbent
bound `best.delta.length - 1` with git's `try_delta` bound, pinned in §1f:

```ts
const NO_INCUMBENT_REF_DEPTH = 1;

/** git's `try_delta` bound (`builtin/pack-objects.c:2823-2834`): the byte budget a
 *  candidate base at `baseDepth` must fit, scaled so a deeper base must earn its
 *  place with a smaller delta and a shallower one may win with a larger. */
function searchBound(
  targetSize: number,
  hashSize: number,
  incumbent: Candidate | undefined,
  baseDepth: number,
  maxDepth: number,
): number | undefined {
  const [budget, refDepth] =
    incumbent === undefined
      ? [Math.floor(targetSize / 2) - hashSize, NO_INCUMBENT_REF_DEPTH]
      : [incumbent.delta.length, incumbent.chainDepth + 1];
  if (budget < 0) return undefined; // git's unsigned wrap: no bound at all (§1f)
  return Math.floor((budget * (maxDepth - baseDepth)) / (maxDepth - refDepth + 1));
}
```

`tryCandidate` keeps its cross-type and depth guards first — `member.chainDepth >=
policy.maxDepth` is git's `:2819`, and it is **not** subsumed by a zero bound because the
unbounded arm bypasses the scaling — then computes the bound, refuses on `0` (`:2833`), and
hands `undefined` to `encodeDeltaFromIndex`'s already-optional `maxSize` for the unbounded
case. The bound is inclusive on both sides (`create_delta` refuses only an output position strictly above `max_size`;
`encodeDeltaFromIndex` fits a delta of exactly `maxSize`). A delta that comes back is then
judged by git's same-size rule (`:2909-2916`): with an incumbent, `delta.length ===
incumbent.delta.length && member.chainDepth >= incumbent.chainDepth` keeps the incumbent.
`hashSize` is `ctx.hash.digestLength`, threaded into `selectBestCandidate` as a parameter
rather than added to `DeltaPolicy`, which stays a pure function of config.

What this changes in behaviour, stated so the stage-2 readout can be predicted: a shallower
base can displace an incumbent with a **larger** delta (factor above 1), a deeper one must
beat it by the factor, a base at depth 49 has 1/50th of the depth-0 budget, and chains on
the tie-dense corpus end where the step delta stops fitting — around depth 44 for a 1 % step
on 4 096 bytes (§1f) — instead of at the cap. `tryCandidate`'s docblock ("strictly smaller
wins; the most recently admitted member breaks anything left") is rewritten to this rule.
ADR-777's deflate-size acceptance still runs after the search and is unchanged: tsgit's
pipeline is git's search bound, then git's incumbent rules, then tsgit's on-disk acceptance.

Arithmetic: `budget × (maxDepth − baseDepth)` is at most `2⁵³ / 50` for any object tsgit can
read, so the product is exact and `Math.floor` of the quotient is C's truncating unsigned
division for non-negative operands.

#### 4i. Stage 3 — best-base promotion, and max-depth non-admission (`deltify.ts`, `deltifyEntries`)

Git's window after a hit (`:3087-3097`, traced in §1f) is, oldest to newest:
`[…others without the base, emitted object, base]` — the base becomes the most recent
member and is the first tried for the next target; the just-emitted object sits behind it.
`deltifyEntries`' admission step becomes:

```
no hit                     → admitToWindow(state, pending)                        (today)
hit, chainDepth < maxDepth → readmit(admitToWindow(without(state, base), pending), base)
hit, chainDepth ≥ maxDepth → state unchanged                                      (DC-8)
```

A "hit" is an **emitted delta**, not a found candidate: when ADR-777's deflate-size
acceptance rejects the candidate and `buildDeltifiedEntry` emits a base, the object takes the
no-hit row — git never reaches that situation because it accepts on raw size, so the
faithful reading is that no base was used and nothing is promoted.

`without` removes the base and subtracts its `memberWeight`; `admitToWindow` is unchanged
and admits the new member against a window that no longer holds the base, so the base can
never be the oldest member evicted to make room; `readmit` runs `evictToFit` and appends an
**existing** `WindowMember` — its `DeltaIndex` is kept, never rebuilt — so the count settles
at `policy.window` and the byte total at what it was. All three are pure and return a new
`WindowState`, the CQS shape `admitToWindow` and `evictToFit` already have. The window stays
a plain array walked back to front; no hash-keyed container enters the selection path.

Max-depth non-admission is git's `:3079-3080`: an object that just became a delta at
`max_depth` is not admitted and no promotion runs — the `continue` skips both. It is folded
into this stage under DC-8's recommended option because it lives in the same admission
step, is byte-neutral once stage 2 has landed (no chain reaches 50 on either fixture), and
is a real divergence under stage 1 alone (a depth-50 member holds a slot it can never use).
If DC-8 lands as a residual instead, the third row of the table above collapses into the
second.

### 5. Objects without a path — the table, in one place

Under ADR-827 there is no slab and no aligned lookup: "no path" is either an explicit
`nameHash: 0` written by the enumerator that knows the object is path-less, or an absent
field read by the one `?? 0` in `boundCarriedContent`.

| Class | Hash | How the `0` arrives at the comparator |
|---|---|---|
| commit | `0` | closure engine / bundle enumerator emit with `nameHash: 0` |
| tag | `0` | same |
| root tree | `0` = seed | `emitTree` root; bundle root call |
| directly wanted blob or tree | `0` | `resolveWants` emits `0` (divergence: git uses the pending name — §1c) |
| every object on the bitmap tier | `0` | `ClosureObject.nameHash` is absent; `boundCarriedContent`'s `?? 0` |
| every cruft-pack member | `0` | gc passes `{ id }` — field absent |
| unreachable promisor-pack member | `0` | gc's ordinal lookup misses and writes `nameHash: 0` explicitly |
| every `push` object | `0` | `{ id }` — field absent; base-only, the key is never built |
| any object whose caller passes no hash | `0` | `boundCarriedContent`'s `?? 0` |

Recency has a parallel table with two rows: gc's normal and promisor packs carry it on every
object; every other input carries it on none. There is no third row — a mixed input is refused
(§4f, DC-7).

### 6. Determinism — proof obligations, and the two modes

ADR-826 makes the comparator's final terms `recency ASC, oid ASC` with `recency` supplied per
object and absent by default. That splits every determinism statement into what holds always,
what holds only when no object carries recency, and what the one caller that opts in gives
up. The first draft of this section assumed an unconditional `sourceIndex` and listed three
contracts as inverting; under the ratified option two of them do not, and the third inverts
for a different reason than it said.

**Proven unconditionally.** The selection path stays free of `Map`/`Set` iteration,
`Date.now`, `Math.random` and `Promise.race`; the comparator is a pure strict total order over
unique ids in either mode (R3); the hash is a pure function of bytes (R1); the bound (§4h) and
the promotion (§4i) are pure functions of the window's contents and the config. For a fixed
`(objects sequence, config)` the bytes are the same on every call — the existing
`buildPack` ×2 byte-equality pin (`build-pack.test.ts:418-437`) stays green unchanged and
remains the gate.

**In the recency-absent mode** — every caller except gc's normal and promisor packs — the
key is `(type, nameHash, size, id)`: four per-object values and nothing positional. Emission
is a function of the **set of `(id, nameHash)` pairs** and the config, independent of input
order. Consequently:

| Where | Statement | Under ADR-826 |
|---|---|---|
| `build-pack.test.ts:441-459` "shuffled oid array … same bytes" and `:462-480` "two permutations … same bytes, decided by the id tiebreak" | input-order independence | **Stands, unchanged.** Both pass no recency (and no hash); the shuffled input reaches the `id` clause exactly as the comment says. Their only edit is the mechanical `oids` → `objects` migration. The plan adds the mirror pair for the recency-present mode (§Test strategy) rather than rewriting these |
| `pack-objects.ts:46-56` docblock last sentence | "a function of the object SET, not of the closure's own traversal order" | **Qualified, not withdrawn.** True as written for one tier — `packObjects` passes no recency — and false *across* tiers because the two tiers supply different hashes for the same set (ADR-830). The sentence gains "and of the name hashes the tier supplied"; the surrounding "never compare this across tiers" is unchanged and now has two reasons |
| `pack-objects.test.ts:289` "the two tiers write the same object set AND the same packId" | cross-tier `packId` equality | **Inverts** — into a cross-tier inequality with the same object set read back from both `.idx` files. The cause is the hash, not the tiebreak: the fixture's walk-tier closure carries three commits' worth of trees and blobs with non-zero hashes, the bitmap tier carries none, so the two sorts differ. Attributable to ADR-830; it would invert under DC-1(b) too |

**What gc gives up.** Its normal and promisor packs are in the recency-present mode: their sha
is a function of the set, the hashes **and** the traversal sequence. gc therefore inherits an
obligation the base-only path already carried — pass a deterministic sequence — and meets it
by construction: traversal order is a function of the object graph and the retention roots
(`computeClosure`'s own doc, `closure-engine.ts:15`: "Order is deterministic for a given
call"), and §4c sorts the roots so the walk does not depend on ref enumeration order. Every
path-less gc input stays oid-sorted or set-keyed. The gc ×2 checksum-equality pin
(`maintenance-interop.test.ts:1399-1455`) stays green unchanged and is R4's gate for this
mode. The one identity that weakens is `reuse: 'cruft'` on a multi-object resurrected set
(§4c), covered by a new test rather than assumed.

**Divergences from git this design keeps, all inside the layout-only class 30.4 ruled outside
the byte contract, recorded in ADR-826:**

- type block order ASC where git's is DESC (no selection effect — §1b);
- `oid ASC` as the final key where git compares pointers — deterministic where git is not;
  gc's traversal ordinal, not git's date-ordered rev-list, is the recency (§1c);
- directly-wanted blobs and index-entry roots hash to `0` where git hashes the pending name;
- git's write order (`compute_write_order`: recency, tagged tips first) is not reproduced —
  tsgit emits in search order, as it always has;
- ADR-777's deflate-size acceptance runs after git's search bound (§4h); git accepts on raw
  delta size and never deflates to decide. Pre-existing, unchanged, and the reason the §1f
  small-object pins are about the *bound*, not about which tiny objects end up as deltas.

**Non-decisions**, stated so a reviewer does not re-open them: the hash runs unconditionally on
the walk tier (cost negligible, `ClosureObject` uniform); the type direction stays ASC (flipping
it changes every pack sha for no size gain and no selection effect); `NO_RECENCY` is `0` and
gc's ordinals start at `0` — harmless, because an input is never mixed.

### 7. Memory — costing the carry

The memory hint on this entry warns that a path string per object is not free. This design
carries **no path it does not carry today**. What ADR-827 does change is the shape of the
input: an identified object per entry instead of an oid per entry, and that is not free
everywhere either. The honest table, per object, all transient (nothing below lives in the
window or survives the call):

| Term | Today | After | Δ per object |
|---|---|---|---|
| `ClosureObject` (walk tier) | `{ id, type, path? }` — the path string is already allocated by `walkTree` and retained in the closure array on every walk-tier `computeClosure` caller, gc included | `+ nameHash: number` | +8 B |
| gc reachable structure | `Set<ObjectId>` | `Map<ObjectId, number>` (id → ordinal), same keys | +8 B |
| gc normal-pack input | `ObjectId[]` — one reference per member | `PackObjectInput[]` — one `{ id, nameHash, recency }` wrapper per member | ≈ +40 B — a **new** allocation. The walk's own `ClosureObject` cannot be passed through here because it carries no `recency`, and gc must add one (§4c) |
| gc promisor-pack input | sorted `ObjectId[]` | wrappers as above | ≈ +40 B, small set |
| gc cruft-pack input | `survivors: ObjectId[]` | `{ id }` wrappers | ≈ +24 B — a **new** allocation on a path that today holds a real flat array; survivor sets are small |
| `pack-objects` input | `closure.objects.map((o) => o.id)` — a second array | `closure.objects` passed through | **−8 B** — the map and its array are deleted; zero wrappers, the walk's objects are the input |
| `bundle-create` input | `ObjectId[]` pushed per emit | `{ id, nameHash }` pushed per emit | ≈ +32 B |
| `push` input | `ObjectId[]` | `{ id }` wrappers | ≈ +24 B — a **new** allocation on the one base-only caller, which gains nothing from the ordering work and pays only the migration; bounded by the push |
| `EmissionEntry` in `deltify.ts` | `{ id, sourceIndex, type, uncompressedSize, content? }` | `+ nameHash + recency` | +16 B |
| `walkTree` frame | `{ entries, index, prefix, depth, id }` | `+ hashState`; `+ prefixBytes` only when `pathBytes` is on, which the packer never turns on | +8 B **per frame** (depth-bounded), 0 per entry |
| window residency (ADR-772) | content + `DeltaIndex` | unchanged — promotion moves an existing member, it never rebuilds an index | 0 |

Worst case on the gc path ≈ 72 B per normal-pack member, transient: for the 24 817-object
real-history corpus, under 1.8 MiB, against a window that is configured in tens of MiB. The
figure ADR-827 accepted — "a caller that today holds only a flat oid array pays for the
wrappers it creates" — is the gc, cruft, bundle and push rows; the `pack-objects` row is the
one place the change is a net reduction. No term is proportional to path length; the only
path-length-proportional cost in this design is §4g's `pathBytes`, and no caller in this
change turns it on.

### 8. Public surface

| Symbol | Change | Kind |
|---|---|---|
| `BuildPackInput.oids` | **removed** | **breaking** |
| `BuildPackInput.objects: ReadonlyArray<PackObjectInput>`, `PackObjectInput` | new — the replacement (ADR-827) | breaking (part of the same change) |
| `BuildPackResult.emissionOrder` | docblock restated: ordinal → index into `objects` | doc only; the value is unchanged |
| `WalkTreeOptions.pathHasher?`, `WalkTreeOptions.pathBytes?`, `WalkTreeEntry.nameHash?`, `WalkTreeEntry.pathBytes?` | new optional fields (ADR-828, both halves) | additive |
| `PathHasher`, `packNameHash`, `foldPackNameHash`, `PACK_NAME_HASH_V1`, `PACK_NAME_HASH_SEED`, `NO_RECENCY` | new domain exports through `domain/storage/index.ts` | additive |
| `INVALID_PACK_INPUT` | new storage error code with `{ reason, present, absent }` (DC-7's shape; absent under its alternatives) | additive |
| `ClosureObject`, `PackEmissionKey`, `BundleObjectClosure`, `DeltifiedEntry`, `DeltaPolicy` | internal (`api.json` lists none of them) | not published |

`BuildPackInput` is a published type (11 mentions in `reports/api.json`; `WalkTreeOptions`
and `WalkTreeEntry` 13 and 12; `DeltaPolicy` none) and it **breaks** (R11). The break lands as a `feat(pack)!:` commit and
folds into the pending major: `main` already carries three `feat(…)!:` commits since `v3.6.0`
(`5ac0cf0a`, `5d2e435f`, `1c6c5e5d`), so this costs no additional major bump. An external
caller with neither a hash nor a recency migrates with `oids.map((id) => ({ id }))` and is
otherwise untouched; one that has paths of its own can compute git's value with the published
`packNameHash` and pass it per object. `reports/api.json` must be regenerated and committed —
it is a pre-push gate. No `path` string enters any public input shape.

### 9. Threat model

- **Input**: tree-entry name bytes from any object store, including a freshly fetched pack.
  The fold is total over any byte sequence, allocates nothing, recurses nowhere, and is
  bounded by the walk's own `MAX_FLAT_TREE_ENTRIES` / `core.maxTreeDepth` guards — an
  adversarial tree cannot make the hash cost more than the tree read it rides on. `pathBytes`
  (§4g) allocates per entry in proportion to path length, bounded by the same guards, and is
  off unless a consumer asks.
- **Collisions** are a quality concern, never a safety one: two paths hashing equal simply
  share a neighbourhood, and the worst case is today's ordering.
- **A caller's per-object values** — `nameHash`, `recency` — are read by the comparator as
  numbers to subtract, never as an index or a size. A value outside `[0, 2³²)` or a
  non-integer only changes the order; a `NaN` degrades the sort to an arbitrary order, and
  every emission order is a valid pack. The one input guard is the mixed-recency refusal,
  which fires before any I/O (R8). Nothing else is validated because nothing else needs to
  be.
- **The search bound** (§4h) is arithmetic on sizes tsgit has already read and validated;
  the unbounded arm hands `undefined` to a codec whose output is bounded by the target's own
  length plus opcode overhead, so "no bound" is still O(target).
- **Pack validity is unaffected by ordering or by the window**: the reader-side oracles
  (`index-pack --strict`, `fsck`, `verify-pack`, tsgit's chain readers) are the same for every
  emission order and every base choice, and ADR-771's depth clamp still binds at the writer —
  stage 2 makes the cap harder to reach, never easier.
- **Determinism** is the one property an attacker-shaped input could disturb — a caller
  passing recency from a non-deterministic sequence gets a non-deterministic pack sha. That
  is the base-only path's existing contract, gc already obeys it, and it is documented on
  `PackObjectInput.recency`, not enforced. A caller that passes no recency cannot disturb
  it at all.

### 10. Relationship to ADR-769 — realised

ADR-769 made two statements. The one it decided — metas are `{ id, crc32, offset }` in
emission order, positional alignment is deleted — is untouched by this change. The one it
*assumed* — its Context opens "Delta selection requires emitting objects in `(typeRank, size
DESC, oid ASC)` order" — and the reason it gave for declining option 3 — "helps only the
callers that have paths; gc has none" — are superseded.

The first draft asked for a new ordering ADR to do four things. All four are done:

| Asked for | Where it landed |
|---|---|
| (a) state the key of §3 | ADR-826 §Decision: `(typeRank, nameHash DESC, size DESC, recency ASC, oid ASC)` |
| (b) record that gc's walk has every path git's has, and that the loss was in `computeReachableSet`'s reduction | ADR-826 §Consequences, last paragraph — "which ADR-828 disproves" |
| (c) carry the §6 divergence list | ADR-826 §Decision (the two terms not modelled, the deliberate final-key divergence) and §6 here |
| (d) a one-line status note on 769 | `docs/adr/769-…md:8` now reads **"accepted (ordering half amended by ADR-826)"** |

ADR-827 is 769's mirror image on the input side: 769 deleted a positional contract on the
result because alignment held only by convention; 827 declines to introduce one on the input
for the same reason, at the cost of the published `oids` field. Together they leave
`buildPack` with an identified object on the way in and an identified triple on the way out,
and no array a caller can mis-align on either side.

### 11. The measurement contract — three stages, one baseline, no composite

Size is **deterministic** on both sides — tsgit by design (R4), git at `pack.threads=1`
(ADR-772 measured byte-identical repeats) — so unlike wall-clock numbers a pack-size ratio is
reproducible locally, needs no CI runner, and has **no noise band**: a stage whose predicted
effect is zero must read exactly zero bytes, or the prediction was wrong. The nightly bench
remains the only authority for *timing*; this entry claims nothing about timing.

ADR-831 makes the shipped number a composite of a gain (ordering), a deliberate regression
(the depth-scaled bound) and an expected zero (promotion). The contract below exists so that
nobody — including the backlog entry — can read the shipped figure as "what name-hash
ordering bought". Only the stage-1 row supports that claim.

#### 11a. The fixed elements

| Element | Contract |
|---|---|
| git version | 2.55.0, stated with every number |
| Peer | `git -c pack.threads=1 -c pack.window=10 -c pack.depth=50 repack -a -d -f -q` — fresh single-threaded selection at the defaults both packers share. `gc` is not a selection peer (§1e): it reuses inherited deltas, which is the second asymmetry §Context found. The window/depth are stated because `DELTA_CHAIN_FIXTURE`'s generator packs at window 250 (`fixture-generator.ts:157-158`) — that is generation, not the measurement |
| tsgit side | `gc` at the stage commit, defaults (`pack.window` 10, `pack.depth` 50); the normal pack is the measured artefact; the run asserts no cruft pack was written (none of the corpora has an unreachable object) |
| Corpora | `DELTA_CHAIN_FIXTURE` (tie-dense, one path); `MEDIUM_FIXTURE` (many paths, few ties); tsgit's own history as a **fresh clone** — `git clone --no-local` into `mktemp`, so no unreachable object exists on either side. The working repository, with its 7 553 unreachable objects, is not a corpus. Each corpus is copied per tool per run so neither repacks the other's output |
| Comparability gate | `git show-index` / `parsePackIndex` object counts **equal** on both sides before any byte is divided; a mismatch is a measurement defect, not a result. This is the first asymmetry correction and it runs on every row |
| Structural readout | `git verify-pack -v` on both packs, blob lines and tree lines separately: base count, delta count, chain-length histogram, max depth — recorded beside every ratio, because it is what shows *why* a ratio moved and what makes a zero-effect stage verifiable as zero |
| Environment | scrubbed `GIT_*`, `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, signing off — the standing procedure in `.claude/workflow/faithfulness.md` |
| Driver | one committed script, `tooling/pack-size-compare.ts`, so the five-plus runs are one procedure and not five hand-typed variants; it imports tsgit from `dist/` (the `tooling/` rule) and the fixture generator from `test/bench/support/`, takes the corpus label and a stage label, and prints one table row per corpus. The reviewer re-runs it at any commit |

#### 11b. The stages, and what each one is allowed to move

The plan lands stage 1 as two commits so the hash and the recency can be told apart — the
sub-attribution the first draft wanted, now free because recency is a gc-only input. Every
row is measured on all three corpora.

| Point | Commit | What changed | Predicted on `DELTA_CHAIN` | Predicted on `MEDIUM` | Predicted on real history |
|---|---|---|---|---|---|
| **B0** | `main` (30.4 packer) | — | ×5.43 class re-measured on the new peer; 808 bases, max chain 5 | ×1.58 class re-measured | re-measured on the new peer (the ×1.42 was against `gc`, an inherited-delta peer; it is retired, not carried) |
| **S1a** | hashes supplied, recency absent everywhere | hash term live | **no movement** — all 300 versions share one hash and one size; the 300 root trees likewise. If this row moves, §Context's tie analysis is wrong and the design comes back here | **gain** — same-path history clusters | gain |
| **S1b** | gc supplies recency | tiebreak live for gc | **the large gain** — every version deltas on its predecessor; R13's cap oracle: max blob chain = `min(versions − 1, 50)`; a handful of blob bases (about one per 60 versions: after the cap binds, the FIFO window keeps offering its last sub-cap member for nine more emissions before a fresh base is forced). Expected **below** git's size: tsgit runs to 50 where git stops near 43 | no movement, or a small one where same-hash same-size ties exist | small gain |
| **S2** | depth-scaled bound (§4h) | which base wins at depth | **regression, deliberate** — chains end near 44; more bases; the ratio rises toward ×1.0 from below. Max blob chain drops from 50 to git's band; the R13 oracle becomes the band | small movement either way — shallower bases can now win with larger deltas | small |
| **S3** | promotion + max-depth non-admission (§4i, DC-8) | window residency | **exactly zero** — on a chain the predecessor is already the most recent member and no chain reaches 50 after S2 | **exactly zero** expected; a non-zero here means a base served two targets out of scan order, which the readout will show as a changed histogram | small, possibly non-zero: branchy history is where one base serves several targets |
| **S4** | 50-byte floor — **ratified (ADR-834)** | which objects are offered | growth of roughly 300 × (deflated 40-byte tree − deflated tree delta) — a few KiB; the tree readout flips from 300 deltas to 300 bases and matches git's | small growth; small-object bases match git's count | small growth |

The **shipped** figure is the last row that lands, which is S4. The published table
carries every row; the prose beside it says, in these words or their equivalent: *the
ordering gain is S1b − B0; the bound costs S2 − S1b and is the faithfulness trade ADR-831
records; promotion is S3 − S2 and was measured to be zero.* Any later comparison against these
numbers must name the row it compares.

Predictions are refutable, and a refuted one stops the run: S1a moving `DELTA_CHAIN`, S1b
failing the cap oracle, S2 *lowering* the ratio on `DELTA_CHAIN`, or S3 reading non-zero on
either fixture each mean the model in §1f is wrong somewhere, and the stage's commit does not
land until the design says where.

#### 11c. Where the numbers go

The stage table replaces the 30.4 figures in `docs/BACKLOG.md` §30.6 (`:568`) and the
paragraph at `docs/use/commands/maintenance.md:215-236` — both currently describe a
size-ordered window and both get the shipped row *and* the S1b row, with the sentence above
between them. The interop band (§Test strategy, X7) is set from the **shipped** row with 15 %
headroom, never the other way round; the R13 band after S2 is set from the S2 readout with
git's readout recorded beside it. `maintenance.bench.ts`'s delta-chain docblock is rewritten
to say it now measures an ordered search under git's bound.

What local evidence cannot establish: any claim about gc wall-clock or residency under the
new order. Those stay with the nightly `maintenance.bench.ts` scenarios.

### 12. Blast radius — parts, in landing order, each independently gate-able

The partition follows three rules. Every part leaves `npm run validate` green on its own.
The breaking input change is **one** part with no behaviour change, so its diff is pure
migration and its gate is "every existing test green modulo the type" — which is why it lands
*before* the closure engine starts emitting a hash any pass-through caller would pick up.
Each measured stage is its own commit with the measurement run between it and the next, so
§11's rows are commit shas, not diff hunks.

| # | Part | Files / symbols | Current signature being changed | Helpers and fixtures to extend | Gate |
|---|---|---|---|---|---|
| A | Hash | `src/domain/storage/pack-name-hash.ts` (new); `src/domain/storage/index.ts` export line | — | `test/unit/domain/storage/pack-name-hash.test.ts`, `.properties.test.ts` (new); `test/unit/domain/storage/arbitraries.ts` if a byte-array arbitrary is not already there | unit + property green |
| B | Comparator | `src/domain/storage/delta-policy.ts` — `PackEmissionKey`, `comparePackEmissionOrder(a, b)`, new `NO_RECENCY`; `deltify.ts` `boundCarriedContent` fills the two new key fields with `0` / `NO_RECENCY` constants until C reads them from the input | key gains `nameHash`, `recency`; `id` stays | `test/unit/domain/storage/delta-policy.test.ts:19-126` | unit green; both modes covered; pack bytes byte-identical to `main` |
| C | **`buildPack` input shape — breaking, `feat(pack)!:`** | `src/application/primitives/build-pack.ts` — `BuildPackInput`, new `PackObjectInput`, `resolveWriterPlan`, `emissionOrder` docblock; `src/application/primitives/internal/deltify.ts` — `deltifyEntries(ctx, oids, policy)`, `boundCarriedContent(oids, metas, budget)`, `EmissionEntry`, `DeltifiedEntry` docblock; `src/domain/storage/error.ts` — the union and `invalidPackInput`; **all six call sites**, each with `{ id }` wrappers and nothing else for now: `push.ts:353` → `{ objects: oids.map((id) => ({ id })) }` (base-only; gains nothing from this change, pays only the migration); `pack-objects.ts:87` → `closure.objects.map((o) => ({ id: o.id }))` (the pass-through arrives in H, once F has put the field on the closure object); `gc-pipeline.ts:484/:527/:560` and `bundle-create.ts:312` → `oids.map((id) => ({ id }))`; test call sites: `build-pack.test.ts` (25), `fetch-pack.test.ts` (3), `delta-pack-interop.test.ts` (2), `rev-write-interop.test.ts` (1) | `oids: ReadonlyArray<ObjectId>` → `objects: ReadonlyArray<PackObjectInput>`; `deltifyEntries` and `boundCarriedContent` take `objects` | `test/unit/application/primitives/build-pack.test.ts` (`:418-480` unchanged in substance), `deltify.test.ts` (`writeBlob`, `chainDepthOf`, `findEntry`, `DEFAULT_POLICY`); `reports/api.json` regenerated | **pack bytes byte-identical to `main` on every existing test** — no hash, no recency flows yet; mixed-recency refusal tested |
| D | Walker fold | `src/application/primitives/walk-tree.ts` — `WalkFrame`, `enterTree(maxDepth, tree, prefix, depth, ancestry)`, `nextFrameEntry(config, counter, frame)`; `src/application/primitives/types.ts:171-186` `WalkTreeEntry`, `WalkTreeOptions` | frame gains `hashState`; `enterTree` gains it as a parameter | `test/unit/application/primitives/walk-tree.test.ts` (`buildSeededContext` from `test/unit/application/primitives/fixtures.ts:156`) | unit green; `toStrictEqual` shape test |
| E | Walker `pathBytes` (ADR-828, second half) | same files — `WalkFrame.prefixBytes`, `WalkTreeOptions.pathBytes`, `WalkTreeEntry.pathBytes` | frame gains `prefixBytes`; `enterTree` gains it | same test file; a tree fixture with an invalid-UTF-8 name (the `tree-bytes` fixtures from 30.3 are the precedent) | unit green; ships with no production caller — the test is the consumer |
| F | Closure engine | `src/application/primitives/internal/closure-engine.ts` — `ClosureObject`, `Emit` (`:86`), `emitTree`, `resolveWants`, `walkClosure` | `Emit = (id, type, path?) => void` gains `nameHash` | `test/unit/application/primitives/internal/closure-engine.test.ts` (`buildLinearChain`, `writeBlob`, `writeCommit`, `writeTag`; path assertions at `:242-243`, `:325-326`, `:333-343`) | unit green; bitmap-tier absence asserted; no caller reads the field yet, so pack bytes still match `main` |
| G | Measurement driver + baseline | `tooling/pack-size-compare.ts` (new; dist import; add to biome's `files.includes`); `test/bench/support/fixture-generator.ts` exports it needs | — | `ensureScaledFixture`, `runGit`-style helpers from `test/integration/pack-fixture-helpers.ts` | **B0 row recorded** for all three corpora on the new peer |
| H | **Stage 1a — hashes flow** | `pack-objects.ts:86-87` → pass `closure.objects` through, the map deleted; `enumerate-bundle-objects.ts` — `BundleObjectClosure` (`:46`), `BundleEmitState` (`:63`), `emitTreeObjects` (`:116`), `enumerateBundleObjects` (`:183`); `bundle-create.ts:312`; `gc-pipeline.ts` — `computeReachableSet` (`:284`) → `computeReachable`, `partitionOwned` (`:379`), `toPackInput` helper, promisor lookup (`:859`), sort at `:419` removed, sorted roots; `pack-objects.ts:46-56` docblock qualified | `emitTreeObjects(ctx, treeId, uninteresting, state, seenTrees, maxDepth, depth)` gains `hashState`; `partitionOwned(owned, reachable: ReadonlySet, keptOids, ownedPromisor)` takes the closure objects and the ordinal map, returns `toNormalPack: PackObjectInput[]` | `maintenance.test.ts` (`vi.spyOn(buildPackMod, 'buildPack')` at `:1919` — assert the captured `objects`: order and per-object `nameHash`), `pack-objects.test.ts` (`:289` inverts), `bundle-create.test.ts` (`buildPack` spy at `:305`); `closure-engine.test.ts` imports `enumerateBundleObjects` | **S1a row recorded**; `DELTA_CHAIN` must not move |
| I | **Stage 1b — gc supplies recency** | `gc-pipeline.ts` — `toPackInput` gains the ordinal; promisor unreachable-member ordinal; the multi-object resurrection case; `test/integration/delta-pack-interop.test.ts` — `buildSameSizeVersionsRepo` (new, beside `buildTextChurnRepo` `:111`), the cap oracle (R13), X7 re-peered (`:417-437`) | — | `parseChainDepths` (`:186`), `runGit`, `tmp`, `solePackIdx`, `trackedNodeContext` in the interop file; `maintenance-interop.test.ts:1399-1455` must stay green untouched | **S1b row recorded**; cap oracle green |
| J | **Stage 2 — depth-scaled bound** | `deltify.ts` — `searchBound` (new, exported for the unit), `tryCandidate(member, content, type, policy, searchBound, best)`, `selectBestCandidate(content, window, type, policy)`; `delta-policy.ts` — `DELTA_ACCEPT_RATIO` **removed**: its only use is the flat bound at `deltify.ts:163`, and `acceptsDeltaEntry` never read it despite the docblock | `selectBestCandidate` gains `hashSize`; `tryCandidate`'s bound argument becomes the incumbent-aware computation | `deltify.test.ts` — bound vectors from §1f (sha1 50/51/52, sha256 50/63/64/76 as `hashSize` 20/32 cases), the shallower-larger-delta case, the same-size rule; interop R13 oracle becomes the band | **S2 row recorded**; `DELTA_CHAIN` ratio must rise |
| K | **Stage 3 — promotion + non-admission** (DC-8) | `deltify.ts` — `deltifyEntries` admission step, new `without` / `readmit`, `WindowState` | `admitToWindow(window, residentBytes, policy, pending)` unchanged; a new `readmit(window, residentBytes, policy, member)` | `deltify.test.ts` — the scan-order test (§Test strategy), the max-depth non-admission test, the ADR-777-rejection no-promotion test, the budget-accounting invariant | **S3 row recorded**; must read exactly zero on both fixtures |
| L | **Stage 4 — 50-byte floor** — *ratified (ADR-834)* | `deltify.ts` — `buildEmissionOrder` / the emission loop: objects under `DELTA_FLOOR_BYTES = 50` are emitted as bases and never admitted | — | `deltify.test.ts` (49/50-byte pair), interop tree readout | **S4 row recorded**; tree readout matches git's |
| M | Docs + ticks | `docs/BACKLOG.md:568`; `docs/use/commands/maintenance.md:215-236`; `test/bench/maintenance.bench.ts` docblock; `docs/use/` page for `buildPack` if one lists `oids` (`rg -n "oids" docs/use` at plan time); `reports/api.json` | — | — | cspell on every touched doc; the stage table published with all rows |

Barrel note: `src/application/primitives/index.ts` is an `export type *` barrel; only serena's
`find_referencing_symbols` resolves references through it. `BuildPackInput`, `PackObjectInput`,
`WalkTreeEntry` and `WalkTreeOptions` are re-exported there.

Mutation-gate note (from the memory hints): `vitest.stryker.config.ts` runs `test/unit/**`
only, so the wiring in H and I is invisible to Stryker unless a unit test asserts the callee's
**captured argument**. The plan must require a `buildPack` spy assertion on the captured
`objects` — element order, per-object `nameHash`, and presence or absence of `recency` (a
`toStrictEqual` on one element, since `toEqual` ignores an `undefined` property) — at each of
the six sites, and a `deltifyEntries` spy on the `objects` argument in `build-pack.test.ts`;
an integration assertion alone leaves those mutants alive with correct-looking coverage. For
J and K the hazards are arithmetic and order (§Test strategy §Mutation) and are all
unit-reachable.

---

## Decision candidates

Six load-bearing choices were put to the user and **ratified as ADRs 826–831**; the §Ratified
decisions block at the top of this document is authoritative and the body already reflects
it. The six rows are kept as the record of what was weighed, each with its ratified outcome in
the last column so this table and the ADRs cannot be read as disagreeing. Three new
candidates the revision surfaced follow; nothing in that second table is decided here.

| # | Choice | Alternatives (≤3) | Recommendation (as first drafted) | Why (as first drafted) | **Ratified** |
|---|---|---|---|---|---|
| **DC-1** | **The final tiebreak** — what separates objects that tie on `(type, nameHash, size)` | (a) **`sourceIndex ASC`** — the caller's input position; walk callers pass traversal order, gc sorts its path-less inputs. (b) **Keep `oid ASC`** — order-independent, set-keyed identity survives, but the deep-chain tie is left unbroken: the name hash alone cannot separate 300 same-path same-size versions (§Context). (c) **An explicit per-object recency, absent by default** — set-keyed identity survives when absent; callers that opt in must produce it. | (a) | It is git's own semantics (first-seen, §1b) reduced to the one form tsgit can reproduce; it is the only key that fixes the corpus this entry exists for; and the "callers pass a deterministic sequence" discipline already governs the base-only path. Its cost: three order-independence statements invert, and gc must sort cruft survivors. (b) ships half the fix. (c) keeps a property no caller relies on at the price of a second input and a second absence arm. | **(c) — ADR-826.** Against the recommendation. The property (c) keeps turned out to be one every caller but gc relies on: the three statements do not invert (§6), and the cruft sort is withdrawn (§4c) |
| **DC-2** | **How the hash reaches `buildPack`** | (a) **`nameHashes?: Uint32Array` aligned to `oids`** — 4 B/object; the typed-array slab shape ADR-790 chose for the result side. (b) **`paths?: ReadonlyArray<Uint8Array \| undefined>`** — the packer hashes, as git's `add_object_entry` does; N path byte-arrays resident across the sort. (c) **`objects: ReadonlyArray<{ id, nameHash? }>` replacing `oids`** — one array, no alignment to validate; breaks the published `BuildPackInput`. | (a) | Smallest residency, additive, and the callers that have paths already hold them as the walk's strings. (c) is cleaner in isolation but breaks a published input for no capability (a) lacks. | **(c) — ADR-827.** Against the recommendation. With DC-1(c) there are two optional per-object values, not one, and two aligned slabs reintroduce on the input side exactly the convention-held alignment ADR-769 deleted on the result side. Breaking; six call sites (§12 C) |
| **DC-3** | **Where the path bytes are folded** | (a) **`walkTree` folds per frame through an optional `PathHasher`** and yields `nameHash` — byte-exact over `nameBytes`, allocation-free, opt-in. (b) **The closure engine re-encodes `entry.path`** — no walker change, one allocation per entry, and **lossy**: invalid UTF-8 decodes to U+FFFD, so two such names collide and neither matches git. (c) **`walkTree` yields `pathBytes`** — byte-exact, one allocation per entry for every consumer unless gated behind another option. | (a) | ADR-748 rules that tree-name decisions are made on bytes, which excludes (b) on principle. (c) is (a) with an allocation and a wider public field. | **(a) + (c) as a separate opt-in — ADR-828.** Hybrid, against the recommendation's "(a) alone". The fold is the packer's path (§4a); `pathBytes` is an independent, default-off capability closing the walker's byte gap (§4g), shipped without a caller |
| **DC-4** | **Which name-hash version** | (a) **v1 only**. (b) **v1 + v2 behind a tsgit-only option**. (c) **v2 only**. | (a) | Faithfulness has one default here and it is v1; there is no repository setting a v2 port would be honouring. v2's vectors are recorded so adoption later is a port, not a re-pin. | **(a) — ADR-829.** As recommended |
| **DC-5** | **Name hashes on the bitmap tier** | (a) **Walk tier only** — bitmap-tier packs hash everything to `0`. (b) **Read the `.bitmap` name-hash cache** (`BITMAP_OPT_HASH_CACHE`, flag `0x4`). (c) **Force the walk tier when delta emission is on**. | (a) | The gc path — the one this entry measures — is walk-tier by pin. (b) is a contained parser extension with no corpus here. (c) trades a documented default for a size gain on one command. | **(a) — ADR-830.** As recommended. Consequence taken in §6: `pack-objects.test.ts:289` inverts because of this asymmetry, not because of DC-1 |
| **DC-6** | **Scope of git's other selection heuristics** (§1f) | (a) **Ordering only**. (b) **Also the depth-scaled search bound**. (c) **(b) plus best-base promotion**, as separately measured stages. | (a) | One variable per measurement; on the deep-chain corpus the depth-scaled bound *shortens* chains, so it cannot be what closes the gap. | **(c) — ADR-831.** Against the recommendation. Faithfulness over size on the bound; three measured stages keep every variable attributable (§11); §4h/§4i design the two heuristics; §1f pins them from source and from real git |

### New candidates surfaced by the revision — not decided here

| # | Choice | Alternatives (≤3) | Recommendation | Why | **Ratified** |
|---|---|---|---|---|---|
| **DC-7** | **Mixed recency presence in one `buildPack` input.** ADR-826 defines the recency-present and recency-absent modes; it does not say what an input where *some* objects carry `recency` does. It is not hypothetical — gc's promisor pack mixes reachable members (which have an ordinal) with unreachable ones (which do not). A comparator that literally skips the recency compare for a mixed pair is **not transitive**: `A(recency 1, oid z) < B(recency 2, oid a)` by recency, `B < C(no recency, oid m)` by oid, `C < A` by oid — a cycle, so the sort is undefined. Mixed input must be normalised or refused | (a) **Refuse it** — `buildPack` throws `INVALID_PACK_INPUT` `{ reason: 'mixed-recency', present, absent }` before any I/O; gc synthesises an ordinal for unreachable promisor members (`reachable.size + i` over the oid-sorted array). (b) **Absent sorts last** — `deltify.ts` normalises absence to a sort-last sentinel; no guard; gc leaves unreachable members bare. (c) **Absent sorts first** — the mirror sentinel. | **(a)** | Keeps ADR-826's two modes literally two, so every ordering test has exactly a present arm and an absent arm; the comparator stays unconditional; and the guard replaces the slab-length check DC-2(c) removed, so `buildPack` still has one input-shape refusal with named data. gc's bytes are identical under (a) and (b) — the unreachable members land after every reachable one in oid order either way — so (b) buys only the absence of a guard, at the cost of a third, implicit mode a test must name. (c) has no git analogue: git's unreachable objects are added *after* the traversal, i.e. last | **(a)** — refuse mixed input; ADR-832 |
| **DC-8** | **Max-depth non-admission** — `find_deltas` `:3079-3080`: an object that just became a delta at `max_depth` is not admitted to the window and no promotion runs. A window mechanic the first draft did not list; a real divergence under stage 1 alone (a depth-50 member holds a slot it can never use); byte-neutral once stage 2 lands, because no chain reaches 50 on either fixture | (a) **Fold into stage 3** with promotion — same admission step in `deltifyEntries`, one commit, one measured zero. (b) **Named residual** — leave it, record it in §1f's residual row. (c) **A fourth stage of its own**. | **(a)** | It is three lines in the function stage 3 already rewrites; measuring it separately would record a zero twice; leaving it keeps a known window divergence open and falsifies ADR-831's "nothing that moves bytes remains" consequence for a mechanic that *can* move bytes under a flat bound | **(a)** — folded into stage 3; ADR-833 |
| **DC-9** | **git's 50-byte delta floor** — `should_attempt_deltas` `:3384-3386` never offers an object under 50 bytes as a target or a base; tsgit offers every object. Pinned empirically in §1f. It moves structure on every corpus (`DELTA_CHAIN`'s 300 root trees are 40 bytes: git writes 300 tree bases, tsgit today writes tree deltas) and moves bytes slightly in tsgit's favour. It also hides git's unsigned-wrap bound under sha1 (§1f) | (a) **A fourth measured stage in this change** — `DELTA_FLOOR_BYTES = 50`; under-floor objects are emitted as bases and never admitted; its own commit and §11 row. (b) **Named residual** with its own backlog entry; the tree-readout mismatch against git is documented on every §11 row. (c) **Fold into stage 2** as another size filter. | **(a)** | The same reasoning that ratified DC-6(c): a known, cheap, byte-moving divergence with a faithfulness argument, landed as its own attributable stage. It is also what makes the §11 structural readouts comparable — without it every tree-line comparison against git carries a known 300-object discrepancy on the deep-chain corpus. (c) is the one option the staging discipline forbids. The cost is a fifth measurement point and a few KiB given back on each fixture | **(a)** — fourth measured stage; ADR-834 |
| **DC-10** | **git's unsigned underflow in the search bound.** `max_size = size / 2 - hashSize` is unsigned, so any object below `2 × hashSize` wraps to near the unsigned maximum and searches unbounded — the opposite of the bound's purpose. Reachable: under sha256 every object below 64 bytes, and 50-to-63-byte objects sit above the delta floor and still reach it; under sha1 the floor hides it entirely. Pinned empirically across a sha1/sha256 matrix | (a) **Replicate the wrap** — port the arithmetic as git writes it. (b) **Clamp a negative bound to zero** and diverge with a record. (c) **Replicate under sha1, clamp under sha256**. | **(a)** | The prime directive takes git's observable behaviour as the default and nothing here argues strongly enough to diverge; replicating a quirk is cheaper to justify than owning a divergence, and it keeps one formula honest across both hash widths. (b) diverges on a size-affecting path in a band no fixture covers. (c) is two code paths and two vector sets for one formula, diverging precisely in the likelier case | **(a)** — replicate; ADR-835 |

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
| v2 vectors | recorded as data in the same file, in a `describe` that asserts only their shape (ADR-829) — the port later runs them |

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
- size precedes recency; recency precedes id;
- recency is ASC: two keys differing only in recency → the smaller sorts first (kills the flip);
- **recency-absent mode**: two keys at `NO_RECENCY` differing only in id → id decides, exactly
  today's order (the existing id cases stay as they are);
- strict total order over distinct ids in both modes; the existing "duplicate oid compares
  equal" case (`:109-125`) unchanged.

### Unit — `test/unit/application/primitives/walk-tree.test.ts` (extended)

Fold (§4a):

- no hasher → no `nameHash` field on any entry (`toStrictEqual` on the exact object shape —
  `toEqual` ignores an `undefined` property and would not see it);
- hasher → root-level entry hashes `name` (not `/name`) — the empty-prefix guard in isolation;
- nested entry hashes the full path with `/` folded; a two-level path matches §1a's
  `deep/er/churn.txt` row;
- a name containing bytes that are not valid UTF-8 hashes those bytes (spy-free: compare to
  `packNameHash` over the same `nameBytes`).

`pathBytes` (§4g), its own `describe` block:

- option off → no `pathBytes` field (`toStrictEqual`), and the fold alone adds none;
- option on, root-level entry → `pathBytes` equals `nameBytes` and is **not the same
  object** (`slice`, not a view);
- nested entry → the byte concatenation with `0x2f`, no trailing separator; a two-level path
  round-trips to `path` through `decodePreservingBom` for a plain-ASCII name;
- **the gap it closes**: two entries whose names are an invalid-UTF-8 byte sequence and its
  U+FFFD encoding (`EF BF BD`) yield equal `path` and unequal `pathBytes`;
- `recursive: false` → root-level `pathBytes` only, no frame entered;
- `maxDepth` → the depth refusal fires before any bytes are built (spy on the `concat`
  helper or assert the thrown error's `depth` with no entry yielded past it);
- both options on → both fields, and the hash equals `packNameHash(pathBytes)` for every
  entry — the cheapest cross-check of the two mechanisms against each other;
- mutating a yielded `pathBytes` does not change a later sibling's or child's bytes (the
  private-copy rule).

### Unit — `test/unit/application/primitives/internal/closure-engine.test.ts` (extended)

- walk tier, `objects: true`: root tree `0`; `file.txt` and `sub/deep.txt` carry
  `packNameHash` of their paths (extend the assertions at `:242-243`, `:325-326`);
- commits, tags, a directly-wanted blob: `nameHash` is `0` (extend `:333-343`, `:401`, `:464`);
- bitmap tier: `nameHash` absent (`toStrictEqual`; extend `bitmap-binding.closure.test.ts` or
  the tier tests);
- an object reachable under two paths keeps the first (arrange two commits whose trees place
  the same blob at different names; assert the first commit's hash).

### Unit — `test/unit/application/primitives/build-pack.test.ts` (extended)

- `objects` threaded: `vi.spyOn` on the deltify module's `deltifyEntries`, assert the
  captured second argument is the very array (identity) — the mutation-gate requirement;
- absent `nameHash` → every key hashes `0`: two same-size blobs under different hashes reorder
  when hashes are supplied and do not when absent;
- **mixed recency refused**: try/catch, assert `code === 'INVALID_PACK_INPUT'`,
  `reason === 'mixed-recency'`, `present`, `absent`; assert `readConfig`/`readObject` were not
  called (spy) — refused before I/O; two cases, one object bare among many with recency and
  one with recency among many bare, so the count arithmetic is tested from both sides;
- `:418-437` (same input twice → same bytes) and `:441-480` (shuffled / permuted, no
  recency → same bytes) **unchanged** beyond the `objects` migration;
- **the recency-present mirror pair**: the same sequence with the same ordinals twice → equal
  bytes; a tie-dense trio (same type, same size, same hash) under two different ordinal
  assignments → different bytes with the same object set read back — the test that shows the
  mode is sequence-keyed, placed beside the one that shows the other mode is not;
- an empty `objects` builds the empty pack; a single object is a base whatever its fields.

### Unit — `test/unit/application/primitives/internal/deltify.test.ts` (extended)

Stage 1:

- **the tie-dense chain**: eight same-size blobs of one lineage, all `nameHash` equal, with
  `recency` newest-first → each is a delta on its predecessor, chain depth 7 (via
  `chainDepthOf`); the same eight with no recency → strictly fewer deltas. This is the corpus-
  in-miniature and the test that kills the recency direction mutant;
- **hash grouping beats size adjacency**: two lineages with interleaved sizes and distinct
  hashes → every delta's base shares its target's hash.

Stage 2 (§4h) — `searchBound` is exported for the unit and pinned against §1f's matrix:

- no incumbent, `hashSize` 20: target 50 → 5, 51 → 5, 52 → 6 (`floor(size/2) − 20`); a
  6-byte delta is refused at 51 and accepted at 52 — the inclusive bound;
- no incumbent, `hashSize` 32: target 50 → `undefined` (unbounded), 63 → `undefined`, 64 →
  `0` (refused before encoding — assert `encodeDeltaFromIndex` not called), 66 → `1`, 76 → `6`;
- depth scaling: budget 2 028, `maxDepth` 50, base depth 0 → 2 028; 25 → 1 014; 49 → 40;
  50 → refused by the depth guard, not by the bound (a spy proves the bound was never
  computed — the guard is live on the unbounded arm);
- incumbent rule: incumbent delta 100 at base depth 3 (`refDepth` 4); a candidate at depth 3
  → bound `floor(100 × 47 / 47)` = 100; at depth 10 → `floor(100 × 40 / 47)` = 85; at depth 1
  → `floor(100 × 49 / 47)` = 104 — **a shallower base may win with a larger delta**, asserted
  end-to-end with two window members whose deltas are 100 and 102 bytes;
- same-size rule: two members at equal depth producing equal-size deltas → the first scanned
  stays; the same pair with the second strictly shallower → the second wins;
- `hashSize` is `ctx.hash.digestLength`: a sha256 context changes the bound on a 60-byte
  target from bounded to unbounded.

Stage 3 (§4i):

- **promotion changes scan order**: window `[a, b, c]` (c newest); target picks `b` → the next
  target is offered `b` first. Arranged with a next target for which `b` and `c` yield equal-size
  deltas at equal depth, so "first scanned wins" makes the winner observable: with promotion
  the base is `b`, without it `c`;
- the just-emitted object sits behind the promoted base (a third target that ties on `n` and
  `b` picks `b`);
- **max-depth non-admission** (DC-8): a delta emitted at `maxDepth` is absent from the window
  for the next target, and the base it used was **not** promoted;
- **no promotion on an ADR-777 rejection**: a candidate found in the search but rejected by
  the deflate-size acceptance leaves the window exactly as a no-hit admission would — the
  would-be base keeps its slot and the emitted base object is admitted last;
- budget invariant: `residentBytes` after `without` + `admitToWindow` + `readmit` equals the
  sum of `memberWeight` over the window (kills an accounting drift in any of the three);
- `readmit` keeps the member's `DeltaIndex` identity (`toBe` on `index`) — never rebuilt.

Stage 4: a 49-byte pair stays two bases and neither enters the window; a
50-byte pair deltas; the floor applies to bases too (a 49-byte object never serves as a base
for a 4 096-byte target).

### Unit — command tests

- `maintenance.test.ts`: with the existing `buildPack` spy, assert the normal-pack call
  receives `objects` in the closure's traversal order (not sorted) with each object's
  `nameHash` equal to `packNameHash` of its path and `recency` equal to its ordinal; the
  cruft call receives `{ id }` objects with **no** `nameHash` and **no** `recency`
  (`toStrictEqual`); the promisor call receives oid-sorted objects with `nameHash: 0` and a
  post-traversal ordinal for an unreachable member. `toPackInput` is tested directly with a
  hash-less object so its `?? 0` arm is a covered branch. The existing "second gc with nothing
  changed does not call buildPack for cruft" (`:1915-1929`) must stay green — it is the
  set-keyed cruft identity's test. The single-blob resurrection pin (`:2098-2150`) stays green
  untouched; a **new multi-object resurrection** case (a commit, its tree and two blobs
  crufted, then re-referenced) asserts the ordinary route of §4c — a normal pack under a new
  sha, `declassifyCruftPack` not called, the cruft pack handled by its fate;
- `pack-objects.test.ts`: the captured `objects` **is** `closure.objects` (identity); walk
  tier carries non-zero hashes; bitmap tier carries no `nameHash` field; `:289` inverts as
  §6 states — same object set read back from both `.idx` files, different `packId`;
- `bundle-create.test.ts`: the `buildPack` spy at `:305` sees `{ id, nameHash }` objects with
  `0` for commits and the fold result for a nested blob, and no `recency`;
- `push.test.ts` (or wherever `push` is unit-tested): the captured `objects` are `{ id }`
  each — the migration is the only change.

### Integration — `test/integration/delta-pack-interop.test.ts` (extended)

- **New corpus builder** `buildSameSizeVersionsRepo(slug, versions)`: one path, `versions`
  revisions of a fixed-length file mutated in place through real `git commit`s (the `evolving`
  shape at interop scale). Oracles read **blob lines only** from `git verify-pack -v` (the
  `maxChainDepthOid` filter in `fixture-generator.ts` is the precedent; trees and commits are
  excluded because their deltas are decided by the deflate-size acceptance rule, not by
  ordering) and are structural by construction. They land with stage 1b and are **re-set by
  stage 2**, in that stage's commit:
  - after stage 1b: 45 versions — below the cap, so it never interferes: exactly **1** blob
    base, 44 blob deltas, max blob chain **44** = `versions − 1`; 60 versions — the cap binds:
    max blob chain **exactly 50**, blob bases ≤ 4; histogram and per-object counts agree
    (`parseChainDepths`) — R13;
  - after stage 2: the same two repos, max blob chain in a band `[git's max − k, 50]` and
    blob bases in a band, both set from the stage-2 readout with git's own `verify-pack`
    readout of the same repo recorded in the test file's comment. The design refuses to
    guess `k`; the plan fills it from the run and the reviewer checks it against the row.
  The same repos repacked by git `-f` at `pack.threads=1` give the structural comparison —
  recorded, not asserted equal, because the two codecs produce different delta sizes and the
  chain ends where the step stops fitting;
- **X7 band** (`:417-437`): the peer becomes `repack -a -d -f -q` at `pack.threads=1
  pack.window=10 pack.depth=50`, object counts asserted equal first, and the upper band is
  set from the **shipped** §11 row with 15 % headroom (the plan fills the number; the design
  refuses to guess it);
- every existing oracle (index-pack, fsck, verify-pack, corruption, bundle, pack-objects,
  push) unchanged and green.

### Integration — `test/integration/maintenance-interop.test.ts`

Unchanged; `:1399-1455` (gc twice → same three checksums) is R4's gate for the
recency-present mode and must pass without edits.

### Bench

No new timing scenario. `maintenance.bench.ts`'s delta-chain docblock is rewritten: it now
measures a search that finds deltas under git's bound rather than one that mostly fails.
Published timing numbers come from the nightly artifact only; the size table comes from
`tooling/pack-size-compare.ts` (§11).

### Mutation

Target 0 survivors. Hazards, each with a named kill:

- the `GIT_SPACE` table entries (six byte cases above); `>>> 2` vs `>> 2` (a high-bit vector);
  `<< 24` (any vector); the final `>>> 0` (the `\xff` vector, which sets bit 31);
- `frame.prefix === ''` in the walker (root-level entry test); `prefixBytes.length === 0`
  (root-level `pathBytes` test); the `slice` on entering a tree (the mutation-of-yielded-bytes
  test);
- `nameHash` DESC vs ASC; `recency` ASC vs DESC (the deltify chain test); the term order
  (size before recency, recency before id — one test each);
- `object.nameHash ?? 0` and `object.recency ?? NO_RECENCY` in `boundCarriedContent`
  (absent-field tests); the mixed-recency count (`present === 0 || absent === 0` — both
  sides, and the off-by-one at one bare object);
- `searchBound`: `Math.floor(size / 2)` (odd sizes 51 vs 52); `- hashSize` (20 vs 32);
  `< 0` vs `<= 0` (the 64-byte sha256 case is `0`, refused, not unbounded); `refDepth + 1`
  and `incumbent.chainDepth + 1` (the 47-vs-48 denominator case); `=== 0` refuse;
  `>=` in the same-size rule (equal depth keeps the incumbent);
- promotion: the order of `[…, n, base]` (scan-order test); `without` removing the right
  member (`emissionIndex` equality, not identity); `readmit` not rebuilding the index;
  `chainDepth >= maxDepth` in the non-admission guard (49 admits, 50 does not);
- gc: `toPackInput`'s `?? 0` (the direct helper test); the root sort (a fixture whose refs
  enumerate in non-sorted order twice, asserting equal packs — kills "sort removed"); the
  promisor ordinal `reachable.size + i` (an unreachable member's recency asserted numerically).

---

## Out of scope

- **The v2 hash** (ADR-829), `--path-walk` packing, delta islands, `pack.island*`.
- **Preferred bases and thin packs** — structurally absent under ADR-774; the term is constant.
- **git's two CPU-only selection heuristics** — the size pre-filters (size difference at or above the bound,
  target under 1/32 of the source) and the cross-type scan `break` (§1f, last row). The 1/32
  rule can in principle refuse a delta tsgit takes; it was not measured and is the named
  residual if a later re-measure lands short. The bound, promotion and max-depth
  non-admission are **in** scope (ADR-831, DC-8); the 50-byte floor is DC-9.
- **The `.bitmap` name-hash cache** (ADR-830's contained follow-on) and any bitmap writing.
- **git's write order** (`compute_write_order`) — emission stays search order.
- **ADR-777's acceptance rule** — tsgit decides on deflated size after git's search; git
  decides on raw delta size. Pre-existing, documented, untouched; the §1f small-object pins
  are about the bound for that reason.
- **`-delta` gitattributes** (`no_try_delta`, `should_attempt_deltas` `:3388`) — git skips
  delta selection for matching paths; tsgit reads no attributes on this path. A faithfulness
  gap recorded for a later entry.
- **Path hints for directly wanted objects** — the `resolveWants` `0` (§1c) is accepted; giving
  index-entry roots their index path would mean `collectRetentionRoots` carrying names.
- **A first consumer for `walkTree`'s `pathBytes`** — the option ships tested and unused
  (ADR-828); adopting it in a byte-deciding consumer is that consumer's change.
- **Pruning re-walked subtrees in `closure-engine.ts`'s `emitTree`** — a pre-existing cost,
  independent of this change.
- **Timing claims of any kind** — the nightly bench owns them.
