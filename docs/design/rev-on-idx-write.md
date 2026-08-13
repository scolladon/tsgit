# Design — write the pack reverse index (`.rev`) beside every `.idx`

> Brief: write `pack-<sha>.rev` alongside every `.pack`/`.idx` tsgit writes, as canonical git
> does since 2.41, gated by `pack.writeReverseIndex`.
> Status: draft → self-reviewed ×3
> Backlog: **28.4** (new) · Spike: `docs/spike/pack-aux-write-side.md` · git pinned: **2.55.0**, darwin 25.5.0

## Context

### The one divergence this closes

28.3 (`design/rev-index-bitmap-read-support.md`) gave tsgit a full `.rev` **read** side: a domain
parser (`src/domain/storage/rev-index.ts`), an artefact loader
(`src/application/primitives/internal/pack-artefact-source.ts`), a live accelerator in the pack
offset table (ADR-604), and an `fsck` pass (exit bit 64). That design's §D17 **W-1** recorded the
write side as *"a live cross-tool asymmetry, pre-existing and now permanent"*, and ADR-614 spelled
it out: *"Writing `.rev` and `.bitmap` is excluded permanently, not deferred."*

`docs/spike/pack-aux-write-side.md` (2026-08-13) re-opened exactly half of that. Its finding, pinned
against git 2.55.0:

- `.rev` is the **only** auxiliary artefact git writes at pack-receive time. Every `.idx` write —
  `index-pack` on clone/fetch, `pack-objects` — emits a sibling `.rev`, because
  `pack.writeReverseIndex` has defaulted to true since git 2.41.
- `.bitmap`, the multi-pack-index and the commit-graph are born **exclusively** in
  repack/gc/maintenance, surfaces tsgit does not have. Writing them at fetch/clone time would
  itself be unfaithful.
- The `.rev` format is fully deterministic, so — unlike a bitmap, whose contents follow git's
  commit-selection heuristics — **byte identity is an available contract**, not an aspiration.

So ADR-614's blanket exclusion was right about `.bitmap` and wrong about `.rev`: it grouped a
deterministic, everyday-path artefact with a heuristic, maintenance-only one. This design revises
**W-1 for `.rev` only**. `.bitmap`/midx/commit-graph writing stays excluded, on ADR-614's own reason,
and is re-stated in Out of scope.

### What tsgit writes today

One artefact pair, from one module:

| site | file | today |
|---|---|---|
| `src/application/primitives/internal/write-pack-artifacts.ts` | `buildIdx` → `.idx` body + second trailer; `writePackArtifacts` → `.pack`, `.idx`, optional `.promisor` | the whole write surface |
| `src/application/primitives/fetch-pack.ts` `materializePack` (~L155–186) | clone / fetch / partial-clone lazy fetch | calls `buildIdx` then `writePackArtifacts`, then `refreshPackRegistry(ctx)` |
| `src/application/commands/pack-objects.ts` (~L86–100) | Tier-1 `packObjects`, optionally into `opts.outputDirectory` **outside** the repo | same pair; `refreshPackRegistry` only when writing into the repo's own pack dir |
| `src/application/commands/push.ts`, `bundle create` | pack stays in memory, no `.idx` | nothing on disk — correct, git behaves the same (Pin J) |

`src/domain/storage/pack-writer.ts` holds the two serializers and the file-header annotation
`@writes surface: packfile, kind: equivalent-under-readback, format: git-packfile-v2` — the pack
bytes are not bit-exact across writers (deflate level, delta selection), so its contract is
acceptance + readback.

### Subsystems this touches

| area | files |
|---|---|
| domain serializer | `src/domain/storage/rev-index.ts` (parser today), `src/domain/storage/pack-writer.ts` (`serializePackIndex`, `IDX_SHA_LENGTH`, `compareBytes` sort), `src/domain/storage/index.ts` (barrel) |
| application write path | `src/application/primitives/internal/write-pack-artifacts.ts`, `fetch-pack.ts`, `src/application/commands/pack-objects.ts` |
| config | `src/application/primitives/config-read.ts` — `ParsedConfig`, `dispatchSection` (L1057), `parseGitBoolean` (L1622) |
| read side (verify only, no change) | `internal/pack-offset-table.ts` (`REV_INDEX_MIN_OBJECTS = 5_000`, `resolveSortedOffsets`), `internal/pack-positions.ts` (`packPositionMap`, `gatherByRevIndex`), `pack-registry.ts` `scanPacks` (`fileNames` set, ~L494) |
| audit | `tooling/audit-write-surfaces.ts`, `tooling/audit-write-surfaces.allowlist.json` (currently `{"surfaces": []}`) |
| tests | `test/unit/domain/storage/{rev-index,pack-writer}.test.ts`, `rev-index.properties.test.ts`, `arbitraries.ts` (`RevIndexSpec`/`buildRevIndex`/`arbRevIndexSpec`, L396–458), `test/parity/scenarios/pack-objects.scenario.ts` (**asserts `packDirEntryCount: 2` with the comment "no `.rev`, no bitmap"**), `test/integration/interop-helpers.ts`, `test/integration/rev-bitmap-fixture-helpers.ts` |

### Constraining prior decisions

| decision | binding effect here |
|---|---|
| **ADR-226** (git-faithfulness prime directive) | the whole reason this entry exists; the `.rev` bytes are on-disk state, so byte-for-byte binds |
| **ADR-249** (structured data only) | `.rev` writing is on-disk state, not rendered output — untouched, but it forbids adding a "print what we wrote" surface |
| **ADR-140** (`@writes` grammar) | one `@writes` block per file; `kind` ∈ `byte-identical` \| `equivalent-under-readback` \| `readback-only`; every annotated surface needs a `cross-tool-interop` test naming it in `interopSurface:` |
| **ADR-604** (`.rev` is a live accelerator) | the freshly written file is *consumed* by tsgit's own next open — but only above `REV_INDEX_MIN_OBJECTS = 5_000` objects; below it the artefact is deliberately never opened |
| **ADR-606** (body trusted on the read path) | tsgit never verifies a `.rev` body on read; correctness of what we write is therefore proven by the interop byte-compare, not by a later self-check |
| **ADR-614** (`pack-objects` ships closure-to-pack only) | **revised for `.rev` by this design**; its `.bitmap`/delta-compression exclusions stand |
| **ADR-602 / ADR-592** (midx read) | a new pack the midx does not name is outside the midx's universe; a new `.rev` changes nothing there |

### House patterns this must follow

1. **Body/trailer split.** `serializePackIndex` (domain, pure, sync) emits everything up to and
   including the embedded pack checksum; `buildIdx` (application, async, has `ctx.hash`) appends the
   file's own digest. The `.rev` has the identical two-digest tail and gets the identical split.
2. **`writeExclusive` for pack artefacts** — `.pack`, `.idx`, `.promisor` all use it today.
3. **Branded/typed inputs, no primitive obsession**, no boolean parameters (the existing
   `promisor: boolean` positional is already a smell; do not add a second).
4. **Positive allow-list error classification**, never a bare `catch`.
5. **Property test beside the example test** when a parse/serialize pair exists — it now does.

## Pinned matrices — git 2.55.0, darwin 25.5.0

All probes ran in a `mktemp -d` throwaway with `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, `GIT_*`
scrubbed and signing off. Fixture **F1**: 5 blobs + 1 tree + 1 commit = **7 objects**, SHA-1.

### Pin A — which surfaces write a `.rev`

| # | surface | command | `.rev`? |
|---|---|---|---|
| A1 | clone (`index-pack`) | `git clone --no-local repo clone1` | **yes** — `pack-<sha>.rev` beside the pair |
| A2 | fetch that keeps a pack | `git -c fetch.unpackLimit=1 fetch origin` | **yes**, for the new pack |
| A3 | fetch below `unpackLimit` | `git fetch origin` (default 100) | no pack at all → no `.rev` (not a divergence) |
| A4 | raw index-pack to an arbitrary dir | `git index-pack -o p.idx p.pack` | **yes** — `p.rev`; note it runs **outside any repository**, which is what makes it usable as the interop oracle |
| A5 | `pack-objects` with a prefix | `… \| git pack-objects <dir>/prefix` | **yes** — `prefix-<sha>.rev` |
| A6 | `repack -adq` / `gc` | (spike §Results) | **yes**, plus auto-heal on a `.rev`-less repo |
| A7 | `bundle create` | `git bundle create b.bundle --all` | **no** `.rev` anywhere |
| A8 | `push` (client side) | `git push <bare> --all` | no local pack written → no `.rev` |

**Rule for A4/A5:** the `.rev` path is the **`.idx` path with the suffix replaced**, not a name
derived from the pack checksum. `p.idx` → `p.rev`; `prefix-<sha>.idx` →
`prefix-<sha>.rev`. tsgit always names its idx `pack-<sha>.idx`, so the same rule yields
`pack-<sha>.rev` in both the repo pack dir and an `outputDirectory`.

### Pin B — `pack-<sha>.rev`, byte for byte (F1, SHA-1, 80 bytes)

```
00000000: 5249 4458 | 0000 0001 | 0000 0001    R I D X | version=1 | hashId=1
0000000c: 0000 0003 0000 0004 0000 0005        body: 7 × u32BE
          0000 0001 0000 0006 0000 0002
          0000 0000                            … ends at 0x28
00000028: 3c60 3ae3 …13e0                      embedded pack checksum (= .pack trailer)
0000003c: cf48 51b5 …71a7                      the .rev's own digest over [0, len − 20)
```

| field | rule |
|---|---|
| magic | `{'R','I','D','X'}` = `0x52494458` |
| version | u32BE `1` |
| hash id | u32BE — `1` = SHA-1, `2` = SHA-256 (Pin F) |
| body | `objectCount` × u32BE; `body[p]` = **index position** of the object at **pack position** `p` |
| embedded checksum | `digestLength` bytes, a copy of the `.pack` trailer |
| trailer | `digestLength` bytes = digest of **everything before it** — verified: `head -c 60 … \| shasum -a1` = `cf4851b5…71a7`; the alternative "over the header+body only" hypothesis gives `670507ad…`, ≠ |
| total size | exactly `12 + 4·N + 2·digestLength` (matches `parsePackRevIndex`'s existing rule) |

**Body derivation, confirmed against `git verify-pack -v`.** The `.idx` order (oid-ascending) is
`035f9b74, 4d4bc1c7, 75db9909, 7ee14440, 9a554c2e, a0054e49, f1f36270` with offsets
`333, 276, 314, 94, 106, 257, 295`. Sorting index positions by ascending offset gives
`[3, 4, 5, 1, 6, 2, 0]` — **exactly the bytes on disk**. The body is a permutation of `[0, N)` and
is strictly offset-ascending by construction.

### Pin C — the file is a pure function of the pack

| # | probe | result |
|---|---|---|
| C1 | `git index-pack -o p.idx p.pack` on a copy of a git-written pack | regenerated `.rev` digest `ca698775…b17e` = the original's, byte for byte |
| C2 | same, `.idx` | also byte-identical (`a79206c2…5410`) |
| C3 | run it a second time | identical again |

**Byte identity is therefore a sound contract**, and it gives the interop test its method: copy a
tsgit-written `.pack` into a scratch dir, run `git index-pack -o <stem>.idx <stem>.pack`, compare
`<stem>.rev` to tsgit's byte for byte.

### Pin D — the `pack.writeReverseIndex` gate

| # | config | surface | outcome |
|---|---|---|---|
| D1 | unset | clone | `.rev` written (default true) |
| D2 | `pack.writeReverseIndex=false` | clone | **absent** — only `.pack` + `.idx` |
| D3 | `=false` | fetch (`fetch.unpackLimit=1`) | **absent** for the new pack |
| D4 | `=false` | `index-pack -o` | **absent** |
| D5 | `=false` | `pack-objects <prefix>` | **absent** |
| D6 | valueless key (`writeReverseIndex` with no `=`) | `index-pack -o` | `.rev` **written** ⇒ valueless boolean is **true** (matches tsgit's `parseGitBoolean(null) === true`) |
| D7 | `=maybe` | `index-pack -o` | **refused**: `fatal: bad boolean config value 'maybe' for …` (git names the key lower-cased), **exit 128**, no `.idx`, no `.rev` |
| D8 | another non-boolean string | `clone` | the same `bad boolean config value` fatal, then `fatal: fetch-pack: invalid index-pack output`; the target's pack dir is empty — the clone does not complete |
| D9 | `=false` **plus** `index-pack --rev-index` | `index-pack -o` | `.rev` written — the CLI flag overrides the config |

D7/D8 are the strict-refusal behaviour tsgit does **not** have for any boolean today (see DC-4).
D9 concerns a CLI flag on a plumbing command tsgit does not expose (see DC-9).

### Pin E — degenerate object counts

| # | pack | `.rev` size | body |
|---|---|---|---|
| E1 | 0 objects (`: \| git pack-objects <prefix>`) | **52** = 12 + 0 + 40 | empty — **git still writes the file** |
| E2 | 1 object | 56 = 12 + 4 + 40 | `[0]` |
| E3 | 7 objects (F1) | 80 | Pin B |

E1 matters: `packObjects` with an empty closure writes a `.pack` + `.idx` today, so tsgit must write
the header-only `.rev` too. (`fetchPack` suppresses the whole artefact set at zero entries and keeps
doing so — no `.idx` means no `.rev`, consistent with A3.)

### Pin F — hash width

| repo `--object-format` | `hashId` | fixture | size |
|---|---|---|---|
| sha1 | `1` | 7 objects | 80 = 12 + 28 + 20 + 20 |
| sha256 | `2` | 3 objects | 88 = 12 + 12 + 32 + 32 |

`hashId` follows the **repository's** object format; both digests are that width. Nothing else in
the format branches on width. (Consistent with 28.3's Pin G.)

### Pin G — overwrite semantics and file mode

| # | probe | result |
|---|---|---|
| G1 | `.rev` exists holding 7 bytes of `GARBAGE`, mode `0444`, `.idx` deleted, re-run `index-pack -o` | exit 0, the file is **replaced** with the correct 80 bytes — git writes a temp file and renames over, so a read-only target is no obstacle |
| G2 | mode of git-written artefacts | `.pack`, `.idx`, `.rev` are all **`-r--r--r--` (0444)** |

G2 is a **pre-existing, unrelated divergence**: tsgit's `writeExclusive` creates 0644 artefacts for
`.pack`/`.idx` today. The `.rev` inherits whatever the pack/idx do — this design does not change
permission behaviour for any artefact, and does not open the question (see §D14 blind spot 3).

### Pin H — git tolerates the states we can produce

| # | state | git |
|---|---|---|
| H1 | `.pack` + `.idx`, **no** `.rev` | `fsck --strict` clean, `verify-pack` ok, `gc` auto-heals by writing one (spike) |
| H2 | corrupt `.rev` body | `verify-pack` still **ok** — it does not read the `.rev` |
| H3 | truncated `.rev` | `cat-file --batch-all-objects --batch-check` prints `error: reverse-index file … is too small` and **falls back**, exit 0 |

H1 is why a `pack.writeReverseIndex=false` repo stays healthy, and H2/H3 bound the blast radius of a
writer bug: git degrades, it does not corrupt. They do **not** license a sloppy writer — the byte
compare is the contract.

## Requirements

1. Every `.idx` tsgit writes to disk is accompanied by a sibling `.rev` at the same path with the
   suffix replaced (`pack-<sha>.idx` → `pack-<sha>.rev`), in the repository pack dir **and** in
   `packObjects`' `outputDirectory` (Pin A4/A5).
2. The `.rev` bytes are **byte-identical** to what `git index-pack` produces for the same `.pack`
   (Pin B, Pin C) — magic, version, hashId, offset-ordered index positions, embedded pack checksum,
   and the file's own digest over everything preceding it.
3. A pack of **zero** objects still gets a 52-byte (SHA-1) header-only `.rev` when its `.idx` is
   written (Pin E1). A pack whose artefacts are suppressed entirely (`fetchPack`, zero entries) gets
   nothing, as today.
4. `pack.writeReverseIndex = false` in the repository config suppresses the `.rev` and only the
   `.rev` (Pin D2–D5). Absent key ⇒ written. Valueless key ⇒ written (Pin D6).
5. `serializePackRevIndex` is hash-width generic: `digestLength` comes from the pack checksum's
   length and every size/offset expression is written in terms of it. The only literal widths in the
   function are the accepted-width guard and the `hashId` mapping (Pin F) — the format's own
   enumeration, not arithmetic.
6. `parsePackRevIndex(serialize(x)) ≡ x` for every spec in the writer's declared domain, and the
   file tsgit writes is loadable by tsgit's own `loadPackRevIndex` as `kind: 'usable'`.
7. The read path is **unchanged**: `scanPacks`' `fileNames` set picks the new sibling up after the
   existing `refreshPackRegistry(ctx)`, and `resolveSortedOffsets` consumes it for packs at or above
   `REV_INDEX_MIN_OBJECTS`. Verified, not assumed.
8. `git verify-pack` and `git fsck --strict` accept a pack directory tsgit wrote, `.rev` included.
9. `push` and `bundle create` write no `.rev` — they write no `.idx` (Pin A7/A8).
10. No `.bitmap`, no multi-pack-index, no commit-graph is written.
11. The `.rev` write surface carries a `@writes` block with `kind: byte-identical` and is covered by
    a `cross-tool-interop` test naming its surface, so `audit-write-surfaces` stays green with an
    **empty allowlist**.
12. A failure to write the `.rev` is never swallowed: it propagates with context, exactly as a
    failed `.idx` write does today.
13. `test/parity/scenarios/pack-objects.scenario.ts`'s `packDirEntryCount` expectation moves from
    `2` to `3` — one shared expectation that every parity driver must now satisfy — and its
    "no `.rev`" comment is corrected.

## Design

### §D1 — shape of the change

Three layers, mirroring what already exists for the `.idx`:

```
domain      serializePackRevIndex(entries, packChecksum) -> Uint8Array   [whole file, trailer region reserved and zeroed]
application buildRev(ctx, entries, packSha)              -> Uint8Array   [same buffer, trailer filled from ctx.hash]
application writePackArtifacts(...)                      -> writes .pack, .idx, [.promisor], .rev
```

Nothing else moves. The read path, the registry, `fsck`, the closure engine and the bitmap code are
untouched.

### §D2 — the domain serializer

```ts
export function serializePackRevIndex(
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packChecksum: Uint8Array,
): Uint8Array
```

`PackIndexWriterEntry` is the existing `{ id, crc32, offset }` shape `serializePackIndex` consumes,
so both serializers take the same input and cannot disagree about the entry set.

Body, in order:

1. Refuse a `packChecksum` whose length is neither 20 nor 32 —
   `invalidPackRevIndex('hash-id', …)`, reusing the parser's closed `RevIndexCheck` union rather
   than widening it. This mirrors `serializePackIndex`'s `IDX_SHA_LENGTH` guard and is the only
   refusal the writer has.
2. `digestLength = packChecksum.length`; `hashId = digestLength === 32 ? 2 : 1`.
3. Obtain **index positions in pack-offset order** (§D3).
4. Allocate exactly `12 + 4·N + 2·digestLength`, write magic / `1` / `hashId` / the N u32BE body
   words / `packChecksum` at `12 + 4·N`. The final `digestLength` bytes are left zero — the caller
   fills them.
5. Return the whole buffer (trailer region included, zeroed) so the caller hashes
   `bytes.subarray(0, len − digestLength)` and writes into the tail in place — one allocation, no
   concat. (`buildIdx` concatenates today because `serializePackIndex` does not reserve the tail;
   the `.rev` writer does, and the difference is deliberate, not an inconsistency to "fix".) The
   in-place fill is not a violation of the immutability rule: the buffer is freshly allocated and
   exclusively owned by `buildRev`, which has not published it — the same discipline
   `serializePackIndex` already uses inside its own body.

The guard in step 1 is unreachable from every production call site (`packSha` is always a verified
pack trailer), which makes it a mutation-testing hazard: it needs its own unit cases per rejected
width, or the mutant that deletes it survives.

Everything is `DataView`/`Uint8Array` arithmetic over a length the function itself computed — no
input-declared length is ever trusted, because there is no input length.

### §D3 — where the ordering comes from

The body needs *"for each pack position `p` (rank by ascending offset), the index position (rank by
ascending oid)"*. `serializePackIndex` already computes the oid-sorted array
(`withBytes.sort(compareBytes)`); the `.rev` needs that same array re-ranked by offset.

The recommended shape (DC-2) extracts the shared step out of `serializePackIndex`:

```ts
export function sortPackIndexEntries(
  entries: ReadonlyArray<PackIndexWriterEntry>,
): ReadonlyArray<SortedEntry>   // { shaBytes, entry }, oid-ascending
```

Sub-choice inside DC-2(a): the helper (and the `SortedEntry` shape) can live in `pack-writer.ts`
and be imported directly by the `.rev` writer, or in a small `src/domain/storage/pack-order.ts` that
both import. The second keeps the dependency arrow out of a parser-bearing file and into a leaf;
either way the helper is **not** added to `src/domain/storage/index.ts` — only
`serializePackRevIndex` is (which is itself a public-surface change; see Gates).

`serializePackIndex` keeps using it verbatim; `serializePackRevIndex` calls it, then builds a
`Uint32Array` of `[0, N)` and sorts it by `sorted[a].entry.offset − sorted[b].entry.offset` — the
same shape `packPositionMap` (`internal/pack-positions.ts`) uses on the read side, which stays the
independent oracle the interop and `fsck` paths compare against. Two implementations of one
computation is deliberate here: `packPositionMap` consumes a **parsed** `PackIndex`, this one
consumes writer entries, and collapsing them would make the `fsck` cross-check tautological.

`Uint32Array.prototype.sort` with a comparator is used (not the comparator-free numeric sort of
`resolveSortedOffsets`) because the values being sorted are positions, not the offsets they are
keyed by. `N < 2³²` by format definition, so `Uint32Array` is exact.

**Offsets are unique by construction** — each pack entry begins where the previous one ends, and
both producers (`walkPackEntries`, `serializePackfile`) emit strictly increasing offsets. Tie
behaviour is therefore undefined *because ties cannot occur*, not because it was overlooked; no
tie-break rule is invented, and no test pretends to cover one.

### §D4 — the application assembler

```ts
export const buildRev = async (
  ctx: Context,
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packSha: string,
): Promise<Uint8Array>
```

`hexToBytes(packSha)` → `serializePackRevIndex` → `ctx.hash.hash(bytes.subarray(0, len − d))` →
`bytes.set(digest, len − d)`. Exactly `buildIdx`'s role and exactly its file
(`internal/write-pack-artifacts.ts`), so the module keeps its single responsibility: "assemble the
byte images of a pack's sibling files".

`ctx.hash` (not `ctx.hashConfig`) supplies the digest; `digestLength` is derived from the checksum
bytes, so a mismatch between `packSha`'s width and the hash service is structurally impossible —
`packSha` **is** the pack trailer.

### §D5 — the gate and the write

`writePackArtifacts` becomes the single place that knows a pack has three files. Recommended shape
(DC-3), which also retires the existing `promisor: boolean` positional smell:

```ts
export interface WritePackArtifactsInput {
  readonly packDir: string;
  readonly packBytes: Uint8Array;
  readonly entries: ReadonlyArray<PackIndexWriterEntry>;
  readonly packSha: string;
  readonly promisor: boolean;      // stays a field of an options object, not a positional flag
}

export interface WrittenPackArtifacts {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  readonly indexBytes: number;            // pack-objects needs it; no longer recomputed by callers
  readonly packSha: string;
}
```

No `revPath` is returned: no production caller needs it, and a field only tests read is dead code by
the repo's own guardrail. Tests compose `${packDir}/pack-${packSha}.rev` or read the directory.

Order of operations:

1. `mkdir(packDir)`.
2. `buildIdx` → `writeExclusive(.pack)` → `writeExclusive(.idx)` (unchanged).
3. `.promisor` sentinel — **kept immediately after the `.idx`**, exactly where it is today, so the
   window in which a promisor pack is visible without its sentinel does not widen.
4. `writeReverseIndex(ctx)` → if false, return.
5. `buildRev` → `writeExclusive(.rev)`.

**`.rev` last** is load-bearing: pack discovery keys on the `.pack`/`.idx` pair
(`pack-registry.ts` `scanPacks`, which registers a pack only when its `.pack` exists by name), so a
concurrent reader that observes the pair before the `.rev` lands simply takes the absent-artefact
arm and sorts — the correct answer, and the state git itself leaves behind under
`pack.writeReverseIndex=false` (Pin H1). The reverse order would create a window in which a `.rev`
exists for a pack with no `.idx`, which nothing reads but which an `fsck` orphan check could one day
notice.

**All adapters, not just node.** `writeExclusive` is a `FileSystem` port method implemented by the
node, memory and browser (OPFS) adapters, and `ctx.hash` is a port too — so the `.rev` lands
wherever the `.pack`/`.idx` land, with no adapter-specific branch and no new port method. The parity
suite (which runs every scenario across all drivers) is what proves it.

The gate helper lives beside the writer:

```ts
const writeReverseIndex = async (ctx: Context): Promise<boolean> =>
  (await readConfig(ctx)).pack?.writeReverseIndex ?? true;
```

Reading the config **inside** `writePackArtifacts` (rather than at each call site) means a future
third caller cannot forget it, and adds no parameter. `readConfig` is memoised per `Context`, so on
the fetch path the read is almost always already paid.

### §D6 — the config surface

`config-read.ts` gains, following the `[commit]`/`[tag]` precedent exactly:

- `ParsedConfig.pack?: { readonly writeReverseIndex?: boolean }` with a doc comment naming git's
  default;
- a `mergePack(acc, sec)` merger using the existing private `parseGitBoolean` (so `null` ⇒ `true`,
  matching Pin D6);
- one `else if (sec.section === 'pack')` arm in `dispatchSection` (L1057);
- the matching `MutableParsedConfig` field.

Key comparison is on the lower-cased key, as every sibling merger does — git lower-cases config keys
(Pin D7's error message names the key in lower case).

**Known, pre-existing divergence, stated not fixed:** `readConfig` reads only
`${commonGitDir}/config`. A `pack.writeReverseIndex=false` in `~/.gitconfig` or `/etc/gitconfig` is
invisible to tsgit, where git honours it. This is systemic (it applies equally to `core.*`,
`commit.gpgSign`, …), it is not made worse here, and the interop test therefore sets the key in the
**local** repo config. A corollary: during `clone`, `writeCloneConfig` runs *after* `fetchPack`
(`clone.ts` — `fetchPack` ~L133, `writeCloneConfig` ~L162), so a clone always sees the default and
always writes the `.rev`. That is faithful: git's clone also cannot read a config the new repository
does not have yet, and reaches the same default.

### §D7 — call sites

| site | change |
|---|---|
| `fetch-pack.ts` `materializePack` | passes `entries` instead of pre-built `idxBytes`; the `buildIdx` call moves inside `writePackArtifacts`. It currently returns `{ ...written, shallow, unshallow }` — that spread must become an **explicit construction** of the four `FetchPackResult` fields, or `indexBytes` silently rides along at runtime on a type that does not declare it (TypeScript's excess-property check does not fire on spreads) |
| `pack-objects.ts` | same; `indexBytes` now comes from `written.indexBytes` rather than a local `idxBytes.length`. `PackObjectsResult` is unchanged — no `revPath` is exposed (ADR-249: ship data the caller asked for, and no caller asked for a path) |
| `push`, `bundle create` | untouched — no `.idx`, no `.rev` (Pin A7/A8) |

`packObjects`' `outputDirectory` mode writes the `.rev` there too, because git does (Pin A5) and
because the artefact is a property of the `.idx`, not of the directory it lands in.

### §D8 — read-side pickup (verification, no change)

`refreshPackRegistry(ctx)` already drops the generation after a write, so the next `scanPacks`
`readdir` builds a `fileNames` set containing `pack-<sha>.rev`, and `loadPackRevIndex` is handed
`present: true`. `resolveSortedOffsets` then reads it **only** when the pack carries at least
`REV_INDEX_MIN_OBJECTS = 5_000` objects (ADR-604) — below that the accelerator is deliberately
skipped and the file is never opened. Two consequences to state plainly:

- For ordinary test-sized packs the newly written `.rev` is **never read by tsgit**. A test that
  "proves the accelerator now fires" on a 7-object pack would prove nothing.
- Verification is therefore split (DC-8): a cheap, direct assertion that
  `loadPackRevIndex(ctx, <written path>, true, digestLength, objectCount)` returns
  `kind: 'usable'` and that `revIndexPositions` reproduces `packPositionMap(parsedIdx)`, plus a
  single scaled case at or above the threshold.

### §D9 — error semantics

| failure | behaviour |
|---|---|
| `packChecksum` width neither 20 nor 32 | `invalidPackRevIndex('hash-id', …)` from the domain writer — a defect signal, unreachable from production call sites |
| `.rev` `writeExclusive` fails (already exists, out of space, permission denied, containment refusal) | **propagates**, exactly as a failed `.idx` write does; the fetch/pack-objects call fails. This matches git, which `die`s when it cannot write the rev file (Pin D8 shows the whole clone failing on the config error). See DC-7 |
| config file unreadable | `readConfig` already propagates non-`FILE_NOT_FOUND` faults; absent file ⇒ `{}` ⇒ default true |

No new `catch` is introduced anywhere. Requirement 12 forbids a "best effort, warn and continue"
arm, and §D14 blind spot 1 records what that costs.

### §D10 — the `@writes` annotation and the audit

The file that emits the `.rev` bytes carries (ADR-140 grammar):

```
 * @writes
 *   surface: packRevIndex
 *   kind:    byte-identical
 *   format:  pack-rev-index-v1
```

`kind: byte-identical` — justified by Pin C, and it is the first use of that value for a pack
artefact (`pack-writer.ts`'s `packfile` surface is `equivalent-under-readback` because deflate and
delta selection are implementation-defined; none of that applies here).

`tooling/audit-write-surfaces.ts` then requires a `cross-tool-interop` test whose `@proves` header
carries `interopSurface: packRevIndex`. §Test provides it, so
`tooling/audit-write-surfaces.allowlist.json` stays `{"surfaces": []}` — no allowlist entry is added
(requirement 11).

ADR-140 permits at most one `@writes` block per file, which is why the serializer cannot simply be
appended to `pack-writer.ts` (already annotated `packfile`, and a different `kind`). DC-1 chooses
between the two remaining homes.

### §D11 — hash-width genericity (explicit checklist)

| # | site | rule |
|---|---|---|
| H-1 | `serializePackRevIndex` | `digestLength` derived from `packChecksum.length`; no literal `20`/`32` in size or offset arithmetic |
| H-2 | `hashId` | `digestLength === 32 ? 2 : 1` — the only width→field mapping, pinned by Pin F, and the mirror of the parser's "record, never gate" rule |
| H-3 | size formula | `12 + 4·N + 2·digestLength` — **two** digests, symmetric with the parser's own rule |
| H-4 | trailer digest | `ctx.hash.hash(bytes.subarray(0, len − digestLength))` in `buildRev` — the repository's algorithm, exactly as `verifyMidxTrailer` and 28.3's H-5 |
| H-5 | `REV_HEADER_SIZE = 12` | reused from `rev-index.ts`, hash-independent |
| H-6 | surrounding subsystem | `IDX_SHA_LENGTH = 20` in `pack-writer.ts` stays a pre-existing SHA-1-only limit of the **`.idx`** writer. This design neither widens nor depends on it; the `.rev` writer's SHA-256 arm is proven by unit + property tests, not by an unreachable production path |
| H-7 | filenames | `pack-${packSha}.rev` composes from the hex the `.idx` already used — no width assumption |

### §D12 — write-path symmetry (explicit checklist)

| # | surface | verdict after this change |
|---|---|---|
| W-1 | `fetchPack` (clone / fetch / lazy fetch) | writes `.pack` + `.idx` + `.rev` — **28.3 §D17 W-1 is hereby revised for `.rev`**; the asymmetry closes |
| W-2 | `packObjects`, repo pack dir | same; `refreshPackRegistry` makes all three visible together |
| W-3 | `packObjects`, `outputDirectory` | same three files outside the repo (Pin A5). No registry refresh — correct, nothing was added to the repo |
| W-4 | `push` / `bundle create` | unchanged, and pinned as faithful (Pin A7/A8) |
| W-5 | overwriting a pack in place | structurally impossible — pack names are content-addressed, so a rewritten pack has a new name and its own artefacts. `writeExclusive` on all three keeps it that way |
| W-6 | a stale `.rev` from an older tsgit / from git | cannot arise for a *new* pack (content-addressed name). For an existing pack tsgit never rewrites artefacts, so nothing goes stale |
| W-7 | any future `gc`/`repack`/`prune` | must delete a pack's `.rev` with it. Orphans are harmless in both tools (Pin H1), so this stays hygiene — **but it is now tsgit's own hygiene**, where before it was only inherited. Recorded for the parked entry |
| W-8 | midx interaction | a new pack the midx does not name is outside the midx's universe (ADR-592). A new `.rev` is per-pack and changes nothing about the midx or its own reverse-index chunk |
| W-9 | `.bitmap`, midx, commit-graph | still never written (requirement 10, ADR-614's surviving half) |

### §D13 — threat model

The `.rev` is a **locally derived** artefact: no transport delivers one (a fetched pack arrives as
`.pack` bytes only), and its content is a pure function of a pack tsgit itself just verified.

| # | concern | assessment |
|---|---|---|
| T-1 | **Attacker-controlled input reaching the serializer** | The entries come from `walkPackEntries` (fetch) or `buildPack` (pack-objects), both already validated: the pack trailer is verified, the entry count is capped (`DEFAULT_MAX_OBJECT_COUNT`), and the body is bounded (`maxResponseBytes`). The serializer adds no new ingest point |
| T-2 | **Unbounded allocation** | The single allocation is `12 + 4·N + 2·d` with `N = entries.length` — a count that already survived the pack-header cap, and one whose memory cost is ~4 bytes/object against the `.idx`'s 28. No declared length from any file is consulted |
| T-3 | **A hostile server steering our `.rev` body** | It can only steer object offsets/oids, i.e. the same permutation the `.idx` already encodes. A malicious permutation written faithfully is still a faithful mirror of the pack we accepted; ADR-606 already accepts that the read path trusts this body, and the attacker who controls it controls the pack itself |
| T-4 | **Path traversal via the artefact name** | `pack-${packSha}.rev` — `packSha` is a verified hex trailer, and the directory is the caller's already-vetted `packDir`/`outputDirectory` (the same string the `.pack`/`.idx` used). No new path component is introduced |
| T-5 | **Symlink / containment escape on write** | `writeExclusive`'s port contract mandates the symlink-safe ancestor check and O_EXCL. Using it (not `write`) for the `.rev` inherits that guarantee unchanged — a reason beyond consistency to prefer it in DC-5 |
| T-6 | **TOCTOU between `.idx` and `.rev`** | A concurrent writer racing us loses the `.pack`/`.idx` exclusive create first, so it never reaches the `.rev`. Two tsgit processes writing the same pack cannot both proceed |
| T-7 | **Information disclosure** | The file contains integers and a checksum already present in the `.idx`/`.pack`. Nothing new is exposed; there is no text field, so no log-injection vector (28.3 T-10 remains satisfied) |
| T-8 | **Denial of service by write amplification** | One extra file per pack write, `4·N + 52` bytes — 0.4 MB for a 100k-object pack against a `.pack` of tens of MB. The extra CPU is one `Uint32Array` sort plus one digest over that buffer, both dominated by the pack's own inflate + hash |
| T-9 | **A wrong `.rev` silently degrading reads** | The write path is byte-pinned against git (requirement 2) and the read path range-validates every stored position before use (`gatherByRevIndex` returns `undefined` and falls back to the sort). A writer bug degrades to the sort; it cannot mis-read objects. Detection is not hypothetical: `fsck`'s `.rev` pass verifies our trailer and cross-checks the full permutation, so a wrong file we wrote makes tsgit's own `fsck` red (X4) |

### §D14 — blind spots, named

1. **A `.rev` write failure now fails an otherwise successful fetch.** Objects are already durably
   on disk when step 4 runs, so a full-disk condition turns "clone succeeded, accelerator missing"
   into "clone failed". This is git's own posture (Pin D8) and requirement 12 forbids swallowing it,
   but it is a genuine new failure mode on the everyday path, and DC-7 is where it gets decided.
2. **Strict-boolean refusal is not implemented anywhere in tsgit.** git dies on
   `pack.writeReverseIndex=maybe` (Pin D7); tsgit's `parseGitBoolean` silently reads it as false —
   i.e. tsgit would *skip* writing where git *refuses to run*. DC-4 decides; whichever way it goes,
   the gap is systemic and larger than this entry.
3. **File mode is not addressed.** git writes all three artefacts `0444` (Pin G2); tsgit writes
   `0644`. Pre-existing for `.pack`/`.idx`, now inherited by a third file. Not in scope, but the
   count of divergent files goes from two to three.
4. **git overwrites an existing `.rev`; `writeExclusive` will not (Pin G1).** Unreachable today —
   the `.pack` exclusive create fails first in every state that has a leftover `.rev` — so the
   divergence is latent, not live. It becomes live the moment any surface writes an `.idx` for a
   pack whose `.pack` is already present (a future `repack`, or an `index-pack`-style command).
5. **`index-pack --rev-index` / `--no-rev-index` has no tsgit equivalent** (Pin D9). Irrelevant
   while tsgit exposes no plumbing `index-pack`; DC-9 records the choice not to invent one.
6. **The parity scenario's `packDirEntryCount` is the only structural pack-dir assertion in the
   suite.** After it moves 2 → 3, nothing else counts pack-dir entries — a future artefact could
   land unnoticed by everything except the interop byte compare.
7. **Below `REV_INDEX_MIN_OBJECTS` tsgit writes a file it will never read** (§D8). That is
   deliberate — the artefact exists for *git* and for tsgit's large-pack path — but it means the
   common case pays a small write for no local benefit.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | Home of the domain serializer | (a) append to `src/domain/storage/rev-index.ts` (parser + serializer, one format, one file); (b) new `src/domain/storage/rev-index-writer.ts`; (c) `pack-writer.ts` | **(a)** | ADR-140 allows one `@writes` block per file and one format per block — `rev-index.ts` is exactly one format, stays ~150 lines, and co-locating parse+serialize makes the round-trip property a single-module subject (`midx.ts` is the precedent). (c) is blocked: `pack-writer.ts` already declares `packfile` with a different `kind` |
| DC-2 | How pack-offset ordering is derived | (a) extract `sortPackIndexEntries` into a shared helper (in `pack-writer.ts`, or a leaf `pack-order.ts`) consumed by both serializers; (b) independent re-sort inside the `.rev` writer; (c) re-parse the just-built `.idx` and reuse `packPositionMap` | **(a)** | One oid-sort definition for both files, so the `.idx` and the `.rev` can never disagree about index positions. (b) duplicates the comparator; (c) pays a full parse and would make `fsck`'s `.rev` cross-check compare a value against itself |
| DC-3 | Where the gate and artefact assembly live | (a) `writePackArtifacts` absorbs `buildIdx`/`buildRev` + the config read, taking an options object; (b) each caller builds `revBytes` and passes it, gate at call sites; (c) keep the positional signature, add `entries` beside `idxBytes` | **(a)** | A future third caller cannot forget the gate; it retires the `promisor: boolean` positional smell instead of adding a second flag; callers get `indexBytes` back rather than recomputing it. Cost: a wider internal refactor of two call sites |
| DC-4 | `pack.writeReverseIndex=<not a boolean>` | (a) lenient — existing `parseGitBoolean`, any non-true string ⇒ false ⇒ skip the `.rev`; (b) refuse for this key only, matching git's exit-128 `bad boolean config value` (Pin D7); (c) generalise strict boolean refusal across `ParsedConfig` | **(a), with the divergence recorded in the doc and an interop row asserting it** | tsgit is lenient for *every* boolean today (`core.bare`, `commit.gpgSign`, …); (b) would make one key behave unlike its neighbours, which is a worse kind of unfaithfulness. (c) is the honest fix and is a separate entry — sizeable (every bool key, every refusal message, an interop matrix) and orthogonal to writing `.rev` |
| DC-5 | `writeExclusive` vs `write` for the `.rev` | (a) `writeExclusive`, like `.pack`/`.idx`/`.promisor`; (b) `write` (overwrite), matching git's rename-over (Pin G1); (c) `writeExclusive` with an EEXIST→overwrite fallback | **(a)** | Consistent with all three sibling artefacts and inherits the port's mandated symlink-safe ancestor check (T-5). The divergence from (b) is unreachable today (§D14 blind spot 4) because the `.pack` create fails first in every state with a leftover `.rev`. (c) buys nothing and re-opens the containment question |
| DC-6 | Interop coverage shape | (a) a new `test/integration/rev-write-interop.test.ts` with `interopSurface: packRevIndex`; (b) extend `packfile-interop.test.ts` and fold `.rev` into the `packfile` surface; (c) extend `rev-bitmap-fsck-interop.test.ts` | **(a)** | One `@writes` surface ⇒ one interop file naming it, which is the audit's own contract and keeps the empty allowlist. (b) would conflate a `byte-identical` contract with an `equivalent-under-readback` one in a single surface name; (c) mixes a write pin into a read/`fsck` file whose fixtures are all mutation rows |
| DC-7 | Failure posture when the `.rev` write fails | (a) propagate — the fetch/`packObjects` call fails (git `die`s, requirement 12); (b) log a warning and return successfully, artefacts minus the `.rev`; (c) propagate, but write the `.rev` *before* the `.idx` so the failure precedes a visible pack | **(a)** | No swallowed errors is a repo guardrail, and git's posture is to die. (b) hides a disk/permission fault on the everyday path. (c) inverts the ordering §D5 argues for and buys atomicity the content-addressed naming already provides |
| DC-8 | How requirement 7 (read-side pickup) is proven | (a) integration test asserting `loadPackRevIndex` on the written file is `kind: 'usable'` **and** `revIndexPositions` ≡ `packPositionMap`; (b) build a ≥ 5,000-object pack and assert the accelerator arm actually fires; (c) both | **(c) — (a) as the always-on assertion, (b) as one scaled case** | (a) alone never exercises `resolveSortedOffsets`' gated arm, which is the thing "picks it up on next open" means; (b) alone is slow and coarse. Together they cost one fixture and close the requirement honestly. If (b) proves too slow for the integration tier, it belongs in the bench fixture family, not deleted |
| DC-9 | A per-call override (`writeReverseIndex?: boolean`) on `packObjects` / `fetchPack` | (a) none — config only; (b) add it to `PackObjectsOptions`; (c) add it to both | **(a)** | git's equivalent lives on `index-pack`, a plumbing command tsgit does not expose; the porcelain surfaces (`clone`, `fetch`) have no such flag either. Adding one pays the full public-surface tax (barrel, facade, `api.json`, docs page, browser scenario) for a knob no caller asked for |

## Test strategy

### Unit — `test/unit/domain/storage/rev-index.test.ts` (extend)

| case | assertion |
|---|---|
| the F1 fixture's 7 entries (oids + offsets from Pin B) | bytes `[0, 60)` equal **Pin B's literal** — magic, version, `hashId = 1`, body `[3,4,5,1,6,2,0]`, embedded checksum at `0x28` — and bytes `[60, 80)` are zero. The real trailer is `buildRev`'s test, since the domain function does not hash |
| offsets already ascending / descending / interleaved | body is offset-ordered regardless of input order |
| zero entries | 52 bytes, empty body, checksum at offset 12 (Pin E1) |
| one entry | 56 bytes, body `[0]` (Pin E2) |
| SHA-256 checksum (32 bytes) | `hashId = 2`, size `12 + 4N + 64` (Pin F) |
| checksum length 0 / 19 / 21 / 33 | throws `INVALID_PACK_REV_INDEX` with `check: 'hash-id'` — **each width tested separately** (isolated guard clauses), asserting `data.check` and `data.reason`, never bare `toThrow(Class)` |
| large offsets (> 0x7fffffff) | ordering still correct — the writer sorts real offsets, not their `.idx` encoding |

### Unit — `test/unit/application/primitives/internal/write-pack-artifacts.test.ts` (**new** — no such file exists today)

`buildRev`: trailer equals `ctx.hash.hash(bytes[0, len−20))`; `.rev` re-parses through
`parsePackRevIndex`; body matches `packPositionMap` over the `.idx` `buildIdx` produced for the same
entries (the independent oracle).

`writePackArtifacts` with a memory adapter: three files with the gate absent; two with
`pack.writeReverseIndex=false`; `revPath` `undefined` in that case; `.promisor` unaffected either
way; a `writeExclusive` rejection on the `.rev` propagates with its code.

### Unit — `test/unit/application/primitives/config-read.test.ts` (extend)

`[pack] writeReverseIndex` → `true`/`false`/valueless(⇒`true`, Pin D6)/mixed case key/absent section
(⇒ `undefined`), plus the DC-4 row (`= maybe` ⇒ `false`, recorded as a divergence in the test's own
comment — no phase or ADR reference in the code).

### Property — `test/unit/domain/storage/rev-index.properties.test.ts` (extend)

Lens 1 (round-trip pair) applies directly:

- **`parse(serialize(x)) ≡ x`**, `numRuns: 200`. Generate `ReadonlyArray<PackIndexWriterEntry>` with
  distinct offsets and distinct oids plus a `digestLength ∈ {20, 32}` checksum; assert `version`,
  `hashId`, `objectCount`, `packChecksum` and every `revIndexPositionAt(p)`; assert the body is a
  **permutation of `[0, N)`** and that mapping it through the entries yields strictly ascending
  offsets. The parser ignores the trailer's value, so the zeroed tail parses — the real digest is
  proven by the `buildRev` unit test and the interop compare.
- **`serialize` is total over its declared domain**, `numRuns: 100`: no input in the safe subset
  (any N, either width) throws or produces a size other than `12 + 4N + 2d`.

Keep `arbitraries.ts`' existing hand-rolled `buildRevIndex`/`arbRevIndexSpec` (L396–458) **as they
are**: they generate hostile specs (bad `hashId`, non-permutation bodies, width disagreement) that
the production serializer cannot emit and that the negative parser properties need. Replacing them
with the production writer would silently narrow the parser's input space.

### Integration / interop — `test/integration/rev-write-interop.test.ts` (new)

`@proves surface: packRevIndex · bucket: cross-tool-interop · interopSurface: packRevIndex`.
One shared `beforeAll` fixture, 60 s timeout, `GIT_*` scrubbed, signing off, every `Context`
disposed per row.

| # | row | assertion |
|---|---|---|
| X1 | tsgit `packObjects` writes a pack; copy the `.pack` to a scratch dir; `git index-pack -o <stem>.idx <stem>.pack` | tsgit's `.rev` bytes **equal** git's, byte for byte (Pin B/C) |
| X2 | same, SHA-1 fixture with ≥ 3 objects at non-monotonic oid/offset correlation | the permutation is non-trivial — a fixture whose body is the identity would pass for the wrong reason |
| X3 | `git verify-pack -v` and `git fsck --strict` over a repo whose pack dir tsgit wrote | exit 0, no `.rev` finding (requirement 8) |
| X4 | tsgit `fsck` over the same repo | no `.rev` finding, exit bit 64 clear. This is the **strongest cheap oracle available**: `internal/fsck/rev-index-health.ts` already verifies the trailer with `ctx.hash` over `[0, len − digestLength)` **and** cross-checks every body position against `packPositionMap`, so a green `fsck` proves the digest and the whole permutation against an independently written reader |
| X5 | `pack.writeReverseIndex=false` in the **local** repo config, then `packObjects` | no `.rev`; `git fsck --strict` still clean (Pin D2/H1) |
| X6 | `pack.writeReverseIndex` valueless in the local config | `.rev` written (Pin D6) |
| X7 | `pack.writeReverseIndex=maybe` | records DC-4's outcome against git's exit-128 refusal (Pin D7) — the divergence row |
| X8 | tsgit clone/fetch against a local `git` peer (whichever the existing helpers already support) | the fetched pack has all three files, and git reads objects out of it |
| X9 | `packObjects` into an `outputDirectory` outside the repo | `.rev` present there (Pin A5) |
| X10 | tsgit re-reads its own artefact: `loadPackRevIndex` ⇒ `kind: 'usable'` and `revIndexPositions` ≡ `packPositionMap(parsedIdx)` | requirement 6/7 (DC-8a) |

Reuse `test/integration/interop-helpers.ts` (`GIT_AVAILABLE`, `git`, `makePeerPair`,
`initBothRepos`) and `rev-bitmap-fixture-helpers.ts` (`DIGEST_LENGTH`, `packArtefactPaths`,
`packArtefactPathsNamed`) rather than adding a third fixture vocabulary.

### Integration — scaled read-side pickup (DC-8b)

One case building a pack at or above `REV_INDEX_MIN_OBJECTS` (5,000) so `resolveSortedOffsets`
takes the gathered arm on tsgit's own freshly written `.rev`; assert reads succeed and, if a seam
allows it without new production code, that the fallback warning never fires. If the build cost
proves incompatible with the integration tier, move it to `test/bench/support/fixture-generator.ts`'s
family rather than dropping the coverage.

### Parity

`test/parity/scenarios/pack-objects.scenario.ts`: `packDirEntryCount` `2 → 3`, and the interface
comment corrected from *"no `.rev`, no bitmap"* to *"`.pack` + `.idx` + `.rev`; no bitmap"*.
Regenerate the goldens for every driver — parity runs across node/memory/browser/workerd, so all
five drivers must agree (a stale parity bundle shows up as uniform e2e timeouts, not as a diff).

### Gates

- `npm run validate` green before any commit; `check:types`, biome, ls-lint, cspell.
- Coverage 100 % on `src/domain/**` and adapters; the new domain serializer is fully covered by the
  unit + property tests. Application-layer additions are gated by Stryker, not by the coverage tool.
- Mutation: the size/`hashId` arithmetic and the offset comparator are prime mutant sites — the
  exact-byte literal test (Pin B) and the permutation property are the intended killers. Expect to
  need an isolated test per guard-clause width in the checksum check.
- `audit-write-surfaces` must stay green with the allowlist untouched (requirement 11).
- `serializePackRevIndex` joins `src/domain/storage/index.ts`, which is a **public export** — the
  pre-push gate requires a regenerated `reports/api.json` in the same commit, and the `.d.ts`
  truthfulness checks must stay green.
- No bench gate: the added cost is one `Uint32Array` sort plus one digest over `4N + 52` bytes per
  pack write (T-8), invisible beside the pack's own inflate and hash. If a fetch bench moves, that
  is a defect, not a budget negotiation.

### Docs (for the documentation phase, not this design)

`docs/use/commands/pack-objects.md`, `docs/use/primitives/internals.md`,
`docs/understand/architecture.md`, `docs/understand/performance.md` all currently describe tsgit as
writing `.pack` + `.idx` only; `docs/use/commands/fsck.md` describes the `.rev` read side.
`docs/BACKLOG.md` gains **28.4** and 28.3's entry keeps its wording (it was accurate when written).

## Out of scope

- **`.bitmap` writing** — requires an EWAH *encoder* plus git's commit-selection policy, and git
  itself only writes bitmaps in repack/gc. ADR-614's exclusion stands unchanged.
- **Multi-pack-index and commit-graph writing** — likewise maintenance-only in git; writing them at
  fetch time would be the unfaithful choice.
- **`repack` / `gc` / `prune` / `maintenance`** — the parked entry (BACKLOG "gc / repack / prune",
  was 24.1). This design adds one hygiene constraint to it (§D12 W-7).
- **Global/system config reading** — `readConfig` stays local-only; systemic, pre-existing,
  unchanged (§D6).
- **Strict boolean refusal across `ParsedConfig`** — see DC-4; a separate entry if the user wants
  the divergence closed.
- **Artefact file mode (0444)** — pre-existing for `.pack`/`.idx` (Pin G2); this design does not
  change permission behaviour for any artefact.
- **Delta compression in the pack writer** — ADR-614's other permanent exclusion, untouched.
- **A plumbing `index-pack` command or a `--rev-index` style flag** — DC-9.
