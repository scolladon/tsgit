# Design — pack format v3 read compliance

> Brief: canonical git accepts pack header version **2 or 3** on read (v3 is reserved; the
> on-disk format is byte-identical to v2) and refuses every other version at first pack open.
> tsgit diverges in **both** directions — its ingest guard refuses v3, and its local read path
> never inspects the pack header at all, so it silently reads packs of any version. Widen the
> guard to `2 | 3`, validate the 12-byte header when the pack registry first opens a local
> `.pack`, keep generating v2, and pin both directions with twin git/tsgit interop tests.
>
> **Revision against ADRs 572–578.** ADR-575 ratified DC-4 as option **(c)**, deviating from
> this document's recommendation (b): **full per-pack registry degradation** is now first-class
> scope, not a deferral. A `.idx` that cannot be read or parsed excludes *that pack* from the
> generation instead of rejecting the whole memoised scan; a `.pack` that cannot be opened for
> the header probe skips at lookup; and ADR-577 adds the header's `objectCount` cross-check
> against the paired index. The widened arm has its own empirical pins (§Pin H, §Pin I) —
> Pin H's tsgit column was previously read off the code, and its git column is now executed
> row by row because those rows became requirements.
> Status: ratified — §Ratified decisions.

## Context

### The divergences

The first two are recorded in `docs/spike/pack-v3-read-compliance.md` and **re-pinned from
scratch for this document** against git 2.55.0 (§Pinned matrices). They point in opposite
directions; the third was pulled into scope by ADR-575 and is pinned in §Pin H / §Pin I:

1. **Ingest too strict.** `parsePackHeader` (`src/domain/storage/pack-entry.ts:69-72`) throws
   `INVALID_PACK_HEADER` for anything but version 2. Real git indexes a v3-stamped pack
   without complaint (Pin A).
2. **Local open too lax.** The local read path is `.idx`-driven end to end
   (`pack-registry.ts` scans `*.idx`, `lookup` answers from the parsed index, `readSlice`
   seeks straight to an entry offset). Nothing ever reads the pack's own 12-byte header, so a
   pack stamped version 99 — or any future format with a different layout — is parsed as if it
   were v2. Git refuses it at first open (Pin B).
3. **Registry degradation is all-or-nothing.** `scanPacks` (`pack-registry.ts:209-219`) has no
   fault arm: one unreadable or unparseable `.idx` rejects the whole memoised scan, so **every**
   read through that `Context` fails — loose objects included. git degrades per pack: that pack
   leaves the pack set, everything else is served, exit 0 (Pin H6, H7). ADR-575 makes closing
   this part of the same change, because it is the same "treat this pack as absent" arm the
   version gate needs, one layer up.

Generation is already faithful: `serializePackfile` stamps 2, and git 2.55.0 also emits only 2
(Pin F). No write-side change (§D4).

**The two fixes are coupled, and that is why they ship together.** `materializePack`
(`fetch-pack.ts:158-175`) writes `download.packBytes` **verbatim** to `pack-<sha>.pack`, so a v3
pack accepted over the wire lands on disk *still stamped 3*. Widening ingest without widening
local open would create repositories tsgit can populate and then refuse to read. The accept-set
must be one set, and it is: both paths call the same `parsePackHeader` (requirement 3a).

### Premises of the brief, checked against the code

| # | brief premise | verdict |
|---|---|---|
| B-1 | *"its only production caller is the network-ingest path (`fetch-pack.ts:307`)"* | **incomplete.** `parsePackHeader` is called once, in `inflateAllEntries` (`fetch-pack.ts:307`), which is reached from **two** production entry points: `fetchPack` (`fetch-pack.ts:163`, clone/fetch/pull) **and** the exported `walkPackEntries` (`fetch-pack.ts:286`), whose other caller is `bundleVerify` (`bundle-verify.ts:46`). So widening the guard also widens **bundle** ingest — and git accepts a v3-carrying bundle (Pin G). The interop matrix must cover it. |
| B-2 | *"`readSlice(offset, length)` exists on the handle (`pack-registry.ts:131`)"* | correct. It is the **only** byte-level pack reader; `object-resolver.ts:411` (`readEntryHeaderWithChunk`) is its single production caller, reached from `resolvePackChain` and from `blob-source.ts:104`. |
| B-3 | implicit: the registry is the single choke point for local pack reads | correct. Every local pack read starts at `PackRegistry.lookup` — `object-resolver.ts:73`, `blob-source.ts:99`, `fetch-missing.ts:57`. `enumerateObjects` (`enumerate-objects.ts:42-45`) is the one consumer that reads `registry.all()` **without** a lookup, and it touches only `pack.index`, never the `.pack` file. That asymmetry is load-bearing for ADR-572 (lookup-layer gate, ungated `all()`) and for ADR-575's *other* layer, which excludes an idx-fault pack from `all()` too. |
| B-4 | *"keep generating v2 … confirm and state why"* | confirmed empirically, not from memory: Pin F. |
| B-5 | implicit: the pack subsystem is hash-generic | **false, pre-existing.** `IDX_SHA_LENGTH = 20` is hard-coded in **both** the idx reader (`pack-index.ts:10`, used at `:46`, `:52`, `:86-88`, `:176-188`) and the idx writer (`pack-writer.ts:63`). tsgit's pack subsystem is SHA-1-only today. This bounds the test matrix (§D5) and is out of scope. |

### Subsystems this touches

| Part | File / symbol | Tier |
|------|---------------|------|
| P1 | `src/domain/storage/pack-entry.ts` → `parsePackHeader`'s version guard; `SUPPORTED_PACK_VERSIONS` + `GENERATED_PACK_VERSION` added, `PACK_HEADER_SIZE` (`:56`) promoted to an `export` — **none added to `src/domain/storage/index.ts`** (§D1) | domain |
| P2 | `src/domain/storage/pack-writer.ts` → `serializePackfile`'s literal `2` (`:45`) becomes `GENERATED_PACK_VERSION` (zero byte change; §D4) | domain |
| P3 | `src/application/primitives/pack-registry.ts` → new memoised `RegisteredPack.header()` in `loadPack` (header validation + ADR-577's `objectCount` cross-check); the lookup-layer gate + `isSkippablePackFault`; **the scan-layer skip + `isSkippableIdxFault` inside `scanPacks`** (ADR-575); deep-imports `parsePackHeader` / `PACK_HEADER_SIZE` from `../../domain/storage/pack-entry.js` and widens the existing `../../domain/storage/error.js` import (`:7`) to `invalidPackHeader` | primitive |
| P4 | `test/unit/domain/storage/pack-entry.test.ts` → the existing *"an unsupported version (3)"* refusal row **inverts** (`:54-58`); version sweep added | test |
| P5 | `test/unit/application/primitives/pack-registry.test.ts` → skip/serve matrix over synthetic packs; **two existing reject-the-scan tests invert** (`:121-169` oversized `.idx`, `:220-262` TOCTOU) | test |
| P6 | **new** `test/integration/pack-version-interop.test.ts` → the twin git/tsgit pins, including the idx-fault rows ADR-575 pulls into scope | test |

### Constraining prior decisions

| ADR / rule | What it binds | How this design stands to it |
|---|---|---|
| **ADR-226** (git-faithfulness prime directive) | observable behaviour byte-for-byte unless an ADR diverges | this change *is* the prime directive applied to a read gate; every accept/refuse cell comes from §Pinned matrices, none from memory |
| **ADR-249** (structured data, not cosmetics) | refusal *conditions* must match git; the rendered wording is ours | git's `error: packfile … is version 99 …` is stderr text tsgit never emits. What binds is: which objects become resolvable, and with which structured error. §D6 |
| **ADR-510** (persistent per-pack `FileHandle`s owned by the registry) | the registry owns one lazily-opened handle per pack | the header gate deliberately sits **outside** the handle lifecycle (§D7) |
| **ADR-566 … ADR-571** (pack-registry single-flight, PR #263) | every lazy initializer that crosses an `await` is a `createPromiseMemo`; no handle may become unreachable; `dispose()` is terminal | the new `header()` is another `createPromiseMemo`, and it opens **no** disposable — so it adds no orphaning surface. Requirement 9 |
| **ADR-359** (exact-slice pack reads via next-offset) + **ADR-360** (remove pack slice hint) | `offsetTable` / `readSlice` consumer contract | unchanged — the header probe is a fixed `[0, 12)` slice, not an entry read |
| **ADR-050** (cache-invalidation policy) | event-driven invalidation for caches that can go stale | the header memo is scoped to a `RegisteredPack`, so `refresh()` discards it with the pack — no separate invalidation. The scan-layer skip is likewise generation-scoped: a repaired `.idx` re-enters on the next `refresh()`, and nothing remembers it as bad (§D9.8) |

### House patterns this must follow

- **Promise-memo, clear-on-reject** — `src/application/primitives/internal/promise-memo.ts`
  (`get` / `peek` / `clear`). Already used twice inside `loadPack` (`offsetTable`, `handleMemo`).
- **Bounded read before parse** — `readBoundedIdx` (`pack-registry.ts:80-93`) stats, then reads,
  then re-checks. The header read needs no bound: it is a fixed 12 bytes. ADR-575 changes the
  *disposition* of that guard's refusal, never its order or its thresholds (§D8 T-7).
- **`ctx.logger?.warn?.(message, context)` for a skipped-but-not-fatal condition** — precedents
  `fetch.ts:445` (*"fetch.prune: skipping unsafe ref name"*), `fetch.ts:461`,
  `read-sparse-checkout.ts:69`. The Logger port sanitises and never throws.
- **Narrow fault discriminators, never a blanket `catch`** — `isUnsupportedOperation`
  (`pack-registry.ts:24-30`) already states the rule this design inherits twice over: recognise
  the *expected* fault by code **and** by its discriminating field, and let everything else
  surface, because `mapErrno` folds unrecognised errnos (`EMFILE`, `EIO`, …) into
  `UNSUPPORTED_OPERATION { operation: 'filesystem' }` and a transient `EMFILE` must never be
  read as "this pack has no objects".
- **Named constants, no magic values** — `PACK_MAGIC`, `PACK_HEADER_SIZE` already exist in
  `pack-entry.ts`; `MAX_PACK_IDX_BYTES` / `REASON_PACK_IDX_EXCEEDS_MAX` in `validators.ts`.
- **`@writes` / `@proves` annotations** — `pack-writer.ts` carries
  `surface: packfile · format: git-packfile-v2`; interop tests carry a `@proves` block with
  `interopSurface:`. `tooling/audit-write-surfaces.ts` cross-checks the pair.

## Pinned matrices — git 2.55.0, this host (darwin 25.5.0)

Every cell below was executed, not recalled. Method: a `mktemp -d` throwaway per probe with an
isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed, `commit.gpgsign=false`. A
5-object pack was produced by `git repack -adq`, then mutated by rewriting the **u32 BE version
field at offset 4** and recomputing the trailer digest over `pack[0 .. len − digestLength)`;
where a matching `.idx` was needed, the pack checksum it records (`digestLength` bytes at
`idxLen − 2·digestLength`; for SHA-1, the 20 bytes at `idxLen − 40`) was re-stamped and the idx
trailer re-hashed. Probe scripts under the session scratchpad; the recipe is reproduced in
§Test strategy because the tests need it.

### Pin A — ingest surfaces

| pack version | `git index-pack -o out.idx p.pack` | `git verify-pack -s p.pack` | `git unpack-objects < p.pack` |
|---|---|---|---|
| 2 | **exit 0**, prints the pack checksum | **exit 0**, `non delta: 5 objects` | **exit 0** |
| **3** | **exit 0**, prints the pack checksum | **exit 0**, `non delta: 5 objects` | **exit 0** |
| 99 | exit 128, `fatal: pack version 99 unsupported` | exit 1, `fatal: pack version 99 unsupported` + `<path>: bad` | exit 128, `fatal: unknown pack file version 99` |

### Pin B — local open (pack + matching `.idx` dropped into `.git/objects/pack/`)

| pack version | `git cat-file -p <oid>` | `git cat-file -t <oid>` | `git fsck` |
|---|---|---|---|
| 2 | `content 1`, exit 0 | `blob`, exit 0 | exit 0 |
| **3** | `content 1`, **exit 0** | `blob`, **exit 0** | **exit 0** |
| 99 | `error: packfile … is version 99 and not supported (try upgrading GIT to a newer version)` then `fatal: Not a valid object name <oid>`, exit 128 | `fatal: git cat-file: could not get object info`, exit 128 | `error: packfile … is version 99 …` + `error: packfile … cannot be accessed`, **exit 4** |

### Pin C — *when* git opens a pack, and what a refused pack costs

The decisive matrix. `is_pack_valid` sits inside git's pack-lookup loop, after the `.idx` says
"I have this object" and before the answer is returned.

| # | repo shape | request | git result |
|---|---|---|---|
| C1 | v99 pack present; requested object is **loose** and absent from that pack | `cat-file -p` / `-t` / `--batch-check` | succeeds, **not one byte of error output**, exit 0 — the pack file is never opened |
| C2 | v99 pack **and** a good pack, object present in **both** | `cat-file -p` | one `error: … is version 99 …` line, then `content 1`, **exit 0** — served from the good pack |
| C3 | v99 pack only, object present only there | `cat-file --batch-check` | `<oid> missing`, **exit 0** |
| C4 | v99 pack only, object present only there | `cat-file -p` | `fatal: Not a valid object name <oid>`, exit 128 — the ordinary missing-object refusal |
| C5 | v99 pack only, **two** requests for the same oid in **one** process | `cat-file --batch-check` fed two lines | the refusal is re-emitted for **each** request — git keeps **no negative cache** for a pack that failed to open |

**Rule, as pinned.** A pack that fails the version check is treated as **absent**, per pack. Its
objects report *missing*, not *corrupt*; every other pack and every loose object stays fully
readable; the process does not die. The check is **lazy at the granularity of a lookup hit** — a
bad pack whose index does not claim the requested object is never opened at all (C1). And the
refusal is **re-evaluated per request**, not remembered (C5).

### Pin D — order of the checks at open

| pack mutation | git message |
|---|---|
| truncated to 8 bytes | `error: file … is far too short to be a packfile` |
| signature `PACX` (v2 otherwise) | `error: file … is not a GIT packfile` |
| version 99 **and** an `.idx` recording a stale pack checksum | `error: packfile … is version 99 and not supported …` — the version check fires **first**; the pack-vs-index checksum check never runs |

So the open-time order is: **length ≥ 12 → signature → version → (idx agreement)**. The spike's
upstream citation (`pack_version_ok(v) = htonl(2) || htonl(3)` in `packfile.h`, gated by
`open_packed_git_1` and `index-pack.c`) is consistent with all of the above; the ordering here is
observed, not read off the source.

### Pin E — hash width: **v3 is not SHA-256**

| repo `--object-format` | pack header version | `.idx` magic / version |
|---|---|---|
| `sha1` | **2** | `0xff744f63` / 2 |
| `sha256` | **2** | `0xff744f63` / 2 |

And a v3-stamped **SHA-256** pack (32-byte trailer, re-hashed with SHA-256) is accepted by
`git index-pack` inside a SHA-256 repo, exit 0.

**Pack version is orthogonal to the object format.** The reserved v3 does not mean, imply, or
select SHA-256. Nothing in this change may key off `ctx.hashConfig` (§D5).

### Pin F — the write side

Every pack git 2.55.0 produced across these probes — `repack -adq` (both object formats),
`bundle create`, `index-pack` output — stamps **version 2**. tsgit's `serializePackHeader(2, …)`
is already faithful and stays (§D4).

### Pin G — bundles

A `git bundle create --all` bundle whose embedded pack was re-stamped to v3 (trailer re-hashed
over `pack[start .. len − digestLength)`): `git bundle verify` reports `is okay` + a complete
history, exit 0; `git fetch <bundle>` succeeds and the objects read back. Ingest acceptance of v3
is not special to `index-pack` — which is why B-1 matters.

### Pin H — per-pack degradation: **which layer drops a pack** (all rows executed)

ADR-575 pulled this family into scope, so every cell is executed, not read off the code. Method
as above; each row is a fresh repo holding one loose blob (present only loose) and one packed
blob (present only in the probe pack), with the named mutation applied under
`.git/objects/pack/`. `count-objects -v` is used as git's *observable pack-set size*.

| # | repo shape | `count-objects -v` | packed blob: `cat-file -p` | loose blob | stderr on a read | `fsck` |
|---|---|---|---|---|---|---|
| H1 | good pack + good idx | `packs: 1`, `in-pack: 5` | `content 1`, exit 0 | served, exit 0 | — | exit 0 |
| H2 | pack **v99**, idx valid | **`packs: 1`, `in-pack: 5`** | `fatal: Not a valid object name`, exit 128 | served, exit 0 | `error: packfile … is version 99 …` | `packfile … cannot be accessed`, exit 4 |
| H3 | pack **header count 6 vs idx count 5** | **`packs: 1`, `in-pack: 5`** | `fatal: Not a valid object name`, exit 128 | served, exit 0 | `error: packfile … claims to have 6 objects while index indicates 5 objects` | `cannot be accessed`, exit 4 |
| H4 | `.pack` **unreadable** (`chmod 000`), idx valid | **`packs: 1`, `in-pack: 5`** | `fatal: Not a valid object name`, exit 128 | served, exit 0 | **silent** | — |
| H5 | `.idx` present, `.pack` **deleted** | **`packs: 0`**, `garbage: 1`, `warning: no corresponding .pack: …` | `fatal: Not a valid object name`, exit 128 | served, exit 0 | **silent** (the warning is `count-objects`-only) | exit 0, no error |
| H6 | `.idx` **corrupt** (any shape, Pin I) | **`packs: 0`, `in-pack: 0`** | `fatal: Not a valid object name`, exit 128 | served, exit 0 | `error: <shape-specific>` (Pin I) | `index not opened` + `unable to load rev-index`, exit 68 |
| H7 | `.idx` **unreadable** (`chmod 000`) | **`packs: 0`** | `fatal: Not a valid object name`, exit 128 | served, exit 0 | **silent** | — |

**Rule, as pinned — git degrades per pack at *two* layers, and the layer decides pack-set
membership.**

- **idx-layer faults** (H5, H6, H7 — no `.pack`, unparseable `.idx`, unreadable `.idx`) drop the
  pack out of the *generation*: `packs: 0`, `in-pack: 0`. git does not know how many objects it
  holds, so it counts none.
- **pack-open-layer faults** (H2, H3, H4 — bad version, count disagreement, unopenable `.pack`)
  leave the pack **in** the generation — `packs: 1`, `in-pack: 5`, counted straight off the still-
  readable `.idx` — but it never serves a byte.
- In **every** row: the loose object is served, exit 0; a sibling pack holding the same oid serves
  it (H5 and H6 re-run with a second good pack both returned `content 1`, exit 0); nothing but
  `fsck` reports non-zero; the process never dies.
- **Laziness extends to the idx layer.** In the sibling-pack arrangement, `cat-file -p <packed
  blob>` printed **no error at all** — git found the object in the good pack and never loaded the
  corrupt `.idx` — while the *same* repo's loose read, which must exhaust the pack list first,
  did print it. git loads an `.idx` on first consultation of that pack, not at directory scan.
- **No negative cache, at either layer.** Two `--batch-check` requests in one process re-emit the
  refusal for each (Pin C5 for the version gate; the same for a corrupt idx). Within one request
  the line appears **twice**, consistent with git re-preparing the pack list and retrying once
  on an object miss.

### Pin I — corrupt-`.idx` shapes: the message varies, the behaviour does not

| `.idx` mutation | git 2.55.0 message |
|---|---|
| 100 random bytes | `error: index file <path> is too small` |
| random bytes, **full valid length** | `error: non-monotonic index <path>` |
| truncated to 8 bytes (magic + version only) | `error: index file <path> is too small` |
| truncated mid object-name table (`8 + 256·4 + 10` bytes) | `error: index file <path> is too small` |
| valid header, `fanout[255]` inflated to 1 000 000 | `error: wrong index v2 file size in <path>` |
| valid header, `fanout[0] = 0xffff` (non-monotonic) | `error: non-monotonic index <path>` |

Every row produced the identical **observable** outcome — H6 exactly: that pack's objects
`missing`, `packs: 0`, loose objects and sibling packs served, exit 0 on `--batch-check` and
`count-objects`. Only the stderr wording differs, and per ADR-249 wording is presentation.

Two details the wording exposes. Full-length random bytes report *non-monotonic* rather than a
magic failure because git falls back to **idx v1** when the v2 magic is absent, and v1 begins
directly with the fanout — so a garbage idx is interpreted, then rejected on its fanout.
tsgit's `parsePackIndex` refuses a missing v2 magic outright (`pack-index.ts:31-35`), which is a
*different reason for the same refusal* — and, for a genuine legacy v1 index, a divergence that
this change softens rather than fixes (§D9.10).

## Requirements

Verifiable at ship time.

1. **`parsePackHeader` accepts version 2 and version 3 and treats them identically** — same
   return shape, same `objectCount`, no downstream branch on `version`. Structural, not
   asserted: no production code reads `PackHeader.version` (verified — `fetch-pack.ts` reads
   only `.objectCount`, at `:309`, `:313`, `:319`).
2. **Every other version is refused** with `INVALID_PACK_HEADER` whose `reason` names the
   observed version. Boundary rows 1 and 4 refuse, exactly like 0 and `0xffffffff`.
3. **Ingest parity with Pin A.** The bytes `git index-pack` accepts, `fetchPack` /
   `walkPackEntries` accept; the bytes it refuses, they refuse. This covers clone/fetch/pull
   **and** `bundleVerify` (B-1).
   **3a — one accept-set.** The version set honoured at ingest and the version set honoured at
   local open are the *same set*, structurally (one `parsePackHeader`). A pack tsgit fetches is
   a pack tsgit can subsequently read, because `materializePack` writes the received bytes
   verbatim. This is not a nicety: under ADR-573's pack-scoped skip a divergence between the two
   sets would not raise — it would make every object in a just-fetched pack report as **missing**,
   which is the worst available failure mode. I-8 is the test that forbids it.
4. **Local-open parity with Pin B and Pin C.** A v3 pack in `.git/objects/pack/` reads
   normally. A v99 pack yields git's observable outcome for every row of Pin C: C1 (untouched,
   silent, succeeds), C2 (the good pack serves it), C3/C4 (the object is *missing*, not a
   corrupt-store failure), C5 (no negative cache), per ADR-573.
5. **A refused pack never poisons an unrelated read.** Loose objects, other packs, refs, index
   and worktree operations are unaffected — for **every** recognised fault, not only the version
   one: bad header, count disagreement, unopenable `.pack`, missing `.pack`, unreadable or
   unparseable `.idx` (Pin C1, C2; Pin H rows H2–H7).
6. **Generation is unchanged, byte for byte.** `serializePackfile` still emits version 2; the
   `@writes` annotation stays `format: git-packfile-v2`; every existing packfile golden,
   interop and parity expectation passes untouched.
7. **Hash-agnostic in the gate.** No branch on `ctx.hashConfig`; `PACK_HEADER_SIZE = 12` holds
   for SHA-1 and SHA-256 alike, because the header carries no digest (Pin E). The pack
   subsystem's pre-existing SHA-1-only limit (B-5) is neither widened nor narrowed.
8. **No unintended public API change.** `PackHeader`, `parsePackHeader`, `serializePackHeader`
   and `serializePackfile` are public exports recorded in `reports/api.json`; the only permitted
   movement is none — ADR-576 keeps `version` at `number` — so `api.json` is byte-identical.
9. **The #263 handle lifecycle is untouched.** After `dispose()`, opened-minus-closed handles
   stay 0 for every row of that design's lifecycle matrix; the header gate opens no disposable
   (§D7); `refresh()` and `dispose()` keep their current semantics.
10. **Structured data only.** Nothing in this change returns or composes a rendered line. git's
    stderr text is reconstructed *inside the interop test* from structured fields, per ADR-249.
11. **No swallowed reason.** Wherever the design declines to propagate an error (ADR-573), the
    reason reaches `ctx.logger?.warn?.` with the pack name — a decision to not fail, not a
    decision to not know. This binds both layers: the lookup-layer skip and the scan-layer skip.
12. **Per-pack degradation is total** (ADR-575). Every *recognised* pack fault removes exactly
    that pack from service and nothing else: bad signature, short pack, version outside `2|3`,
    header/index `objectCount` disagreement, a `.pack` that cannot be opened, and a `.idx` that
    cannot be read or parsed. Every *unrecognised* fault still propagates unchanged — the
    discriminators are allow-lists over `TsgitError.data.code`, never `catch {}`.
13. **The skip layer matches git's pack-set semantics** (Pin H). An **idx-layer** fault excludes
    the pack from the generation, so `registry.all()` — and therefore `enumerateObjects`,
    `resolveOidPrefix`, `fsck --full` — does not list its objects, matching git's `packs: 0` /
    `in-pack: 0` (H6, H7). A **pack-open-layer** fault leaves the pack listed by `all()` with its
    index intact but unable to serve, matching git's `packs: 1` / `in-pack: 5` (H2–H4).
    **H5** (`.idx` present, `.pack` missing at scan) is covered at the **scan layer** per
    ADR-579: `scanPacks` registers a pack only when a sibling `<name>.pack` appears in the
    directory listing it already holds — git's own `prepare_packed_git` rule at zero extra
    I/O — and the exclusion warns once per generation per ADR-580. `all()` therefore never
    lists an orphaned `.idx`, matching git's `packs: 0` / `garbage: 1`. The lookup-layer
    `FILE_NOT_FOUND` arm (ADR-575) remains for the `.pack` deleted *after* the scan — the
    concurrent-repack race.
14. **The local gate cross-checks `objectCount`** (ADR-577). The header's count must equal the
    paired `PackIndex.objectCount`; a disagreement is a skippable pack fault under requirement
    12, reproducing H3. The comparison happens in the registry, never inside `parsePackHeader` —
    the domain parser has no index to compare against and stays context-free.
15. **A skipped pack can never silently corrupt a written artefact.** `buildPack`
    (`build-pack.ts:38`) sources every object through `readObject`, so an object made invisible
    by a skip fails push / `bundle create` loudly with `OBJECT_NOT_FOUND` rather than producing a
    short pack. tsgit has no `gc` / `repack` / `prune` surface, so no reachability-driven
    deletion can act on a degraded pack set (§D8 T-8).

## Design

### §D1 — the ingest guard

`pack-entry.ts` gains two named constants beside the existing `PACK_MAGIC` / `PACK_HEADER_SIZE`,
and the guard widens:

```ts
/** git's pack_version_ok — v3 is reserved and format-identical to v2. */
const SUPPORTED_PACK_VERSIONS: ReadonlySet<number> = new Set([2, 3]);
/** git's PACK_VERSION — the only version we ever emit (§D4). */
export const GENERATED_PACK_VERSION = 2;
```

**Module-exported, barrel-private.** `GENERATED_PACK_VERSION` is imported by its sibling
`pack-writer.ts`, and the registry needs `PACK_HEADER_SIZE` (today a module-private `const` at
`pack-entry.ts:56`), so both become `export`s of `pack-entry.ts` — but **neither is added to
`src/domain/storage/index.ts`**. That barrel is the public boundary typedoc walks into
`reports/api.json`; `pack-registry.ts` already deep-imports from a domain file
(`import { invalidPackIndex } from '../../domain/storage/error.js'`, `:7`), so it imports
`parsePackHeader` and `PACK_HEADER_SIZE` from `'../../domain/storage/pack-entry.js'` the same
way. Net public-surface delta: **zero** (requirement 8).

```ts
const version = view.getUint32(4);
if (!SUPPORTED_PACK_VERSIONS.has(version)) {
  throw invalidPackHeader(`unsupported version: expected 2 or 3, got ${version}`);
}
```

A `ReadonlySet<number>`, not a `readonly [2, 3]` tuple: a literal tuple's `.includes` argument
narrows to `2 | 3` and rejects the `number` under test (TS2345), which is exactly the kind of
detail that turns a two-line change into a half-hour.

`version` is returned verbatim — a v3 pack reports `version: 3`. "Treated identically" is a
property of the *absence* of any downstream branch (requirement 1), not of normalising 3 → 2;
normalising would destroy the caller's ability to observe what it read and would make the field
a lie.

Everything else in `parsePackHeader` is unchanged, including the `< PACK_HEADER_SIZE` truncation
guard, whose reason (`truncated: pack header requires 12 bytes`) already corresponds to git's
*far too short to be a packfile*, and the magic guard, which corresponds to *is not a GIT
packfile* (Pin D). ADR-577's `objectCount` cross-check is deliberately **not** added here: the
domain parser is handed 12 bytes and no index, so the comparison belongs to the registry, which
holds both (§D2). Keeping it out also leaves the ingest path's contract untouched — git's
`index-pack` builds the index *from* the pack and has nothing to disagree with.

### §D2 — the two skip layers

git degrades per pack at **two** layers (Pin H), and ADR-572 + ADR-575 place tsgit's arms at the
same two. Both must exist; neither subsumes the other:

| layer | tsgit site | recognises | effect | git counterpart |
|---|---|---|---|---|
| **scan** | `scanPacks`, around `loadPack` | `isSkippableIdxFault` — `INVALID_PACK_INDEX`, `FILE_NOT_FOUND`, `PERMISSION_DENIED` | the pack never becomes a `RegisteredPack`; excluded from the generation | H6, H7: `packs: 0`, `in-pack: 0` |
| **lookup** | `createPackRegistry().lookup`, around `pack.header()` | `isSkippablePackFault` — `INVALID_PACK_HEADER`, `FILE_NOT_FOUND`, `PERMISSION_DENIED` | the pack stays listed by `all()` with its index intact, but never serves | H2–H4: `packs: 1`, `in-pack: 5` |

H5 (`.idx` present, `.pack` missing at scan) sits at the **scan layer** like git: ADR-579's
sibling-`.pack` check excludes an orphaned `.idx` from the generation (`packs: 0`,
`garbage: 1`), warning once per generation (ADR-580). ADR-575's lookup-layer `FILE_NOT_FOUND`
arm now covers only the between-generations race (`.pack` deleted after the scan).

#### §D2.1 — the lookup layer (the version gate)

Pin C is the whole argument. git validates a pack **inside the lookup loop**, at the moment the
`.idx` claims the object and before that claim is honoured — not when the pack directory is
scanned. tsgit's `PackRegistry.lookup` has the identical shape, so the gate is one `await`
between the index hit and the returned hit:

```ts
async lookup(id: ObjectId): Promise<PackLookupHit | undefined> {
  for (const pack of await allPacks()) {
    const offset = lookupPackIndex(pack.index, id);
    if (offset === undefined) continue;          // ← pack never opened (Pin C1)
    try {
      await pack.header();                       // ← git's is_pack_valid (Pin C2/C3/C4, H2/H3/H4)
    } catch (err) {
      if (!isSkippablePackFault(err)) throw err; // ← allow-list, NOT a blanket catch
      ctx.logger?.warn?.('packRegistry: skipping unusable pack', { pack: pack.name, … });
      continue;                                  // ← ADR-573
    }
    return { pack, offset };
  }
  return undefined;
}
```

Consequences, each matching a Pin C row:

- **C1** — a pack whose index does not claim the object is never opened. Zero cost, zero output.
- **C2** — a refused pack is skipped and the loop continues, so a sibling pack still serves.
- **C3/C4** — when no pack survives, `lookup` returns `undefined` and `object-resolver.ts:74-75`
  raises the ordinary `objectNotFound(id)`. *Missing*, not *corrupt* — exactly git.
- **C5** — the promise-memo clears on rejection, so the next lookup that hits the same bad pack
  re-probes and re-warns. git's behaviour is identical: no negative cache. This is not an
  oversight to optimise away later; it is the pinned semantics.

`RegisteredPack` gains one member:

```ts
/** Memoised 12-byte header read + validation — git's open_packed_git_1 gate.
 *  Rejects with INVALID_PACK_HEADER for a bad signature, a short file, a
 *  version outside 2|3, or a header/index objectCount disagreement.
 *  One read per pack per successful validation. */
readonly header: () => Promise<PackHeader>;
```

built inside `loadPack` as a third `createPromiseMemo`, beside `offsetTable` and `handleMemo`:

```ts
const headerMemo = createPromiseMemo(async () => {
  const header = parsePackHeader(await ctx.fs.readSlice(packPath, 0, PACK_HEADER_SIZE));
  if (header.objectCount !== index.objectCount) {          // ← ADR-577, git's next check (H3)
    throw invalidPackHeader(
      `object count disagrees with index: pack ${header.objectCount}, index ${index.objectCount}`,
    );
  }
  return header;
});
```

`ctx.fs.readSlice` — **not** the pack's own `readSlice` — is deliberate; §D7. A short file
returns fewer than 12 bytes and `parsePackHeader`'s existing truncation guard fires, so Pin D's
third row needs no extra code. The count check reuses `INVALID_PACK_HEADER` rather than
`INVALID_PACK_INDEX`: ADR-574 settled that the gate's refusals get **one** condition with one
representation, and the disagreeing party this gate observes is the header (`index.objectCount`
parsed clean; the pack claims otherwise). The reason string names both counts so the log line is
diagnosable without a second field.

**Both discriminators are allow-lists, not blanket catches.** The house precedent is
`isUnsupportedOperation` (`pack-registry.ts:24-30`), whose comment already spells out the rule:
recognise the *expected* fault and let everything else surface, or an `EMFILE` silently becomes
"this pack has no objects".

```ts
const isSkippableIoFault = (err: unknown): boolean =>
  err instanceof TsgitError &&
  (err.data.code === 'FILE_NOT_FOUND' || err.data.code === 'PERMISSION_DENIED');

/** Lookup layer: the pack file itself is unusable (H2, H3, H4, H5). */
const isSkippablePackFault = (err: unknown): boolean =>
  (err instanceof TsgitError && err.data.code === 'INVALID_PACK_HEADER') ||
  isSkippableIoFault(err);

/** Scan layer: the .idx cannot be turned into a PackIndex (H6, H7). */
const isSkippableIdxFault = (err: unknown): boolean =>
  (err instanceof TsgitError && err.data.code === 'INVALID_PACK_INDEX') ||
  isSkippableIoFault(err);
```

The two are **not** one predicate. `INVALID_PACK_INDEX` must never be skippable at the lookup
layer: it is also what `nextOffsetForEntry` and `buildOffsetTable` throw for a *mid-read*
corruption (`pack-registry.ts:111`, `:198`), and folding those into "this pack has no objects"
would convert a detected corruption into a silent miss well after the gate has passed. Scoping by
layer keeps each arm exactly as wide as its call site.

What neither recognises, by construction:

- `UNSUPPORTED_OPERATION` — `mapErrno`'s fallback for `EMFILE`, `EIO` and every errno it does not
  name. A descriptor exhaustion under load must fail the read, not quietly empty the pack set.
- Anything that is not a `TsgitError` — a programming fault has no business being logged as a
  degraded pack.

Both are re-thrown, so the swallowed-error guardrail is not broken by the very shape it exists to
prevent.

#### §D2.2 — the scan layer (ADR-575's fold)

`scanPacks` today has no arm at all: one `loadPack` rejection rejects the whole memoised scan, so
one bad `.idx` fails **every** read through that `Context` (Pin H6's tsgit column, before). The
fold is a `try`/`catch` around the single `loadPack` call, inside the existing loop:

```ts
const scanPacks = async (): Promise<ReadonlyArray<RegisteredPack>> => {
  const dir = packsDir(commonGitDir(ctx));
  if (!(await ctx.fs.exists(dir))) return NO_PACKS;
  const packs: RegisteredPack[] = [];
  for (const entry of await ctx.fs.readdir(dir)) {
    if (!isCandidate(entry)) continue;
    try {
      packs.push(await loadPack(ctx, dir, entry.name));
    } catch (err) {
      if (!isSkippableIdxFault(err)) throw err;
      ctx.logger?.warn?.('packRegistry: skipping unreadable pack index', {
        idx: entry.name,
        reason: (err as TsgitError).data,
      });
    }
  }
  return packs;
};
```

Four things this placement settles.

- **Everything `loadPack` does is idx work.** It reads the `.idx` under the existing bound
  (`readBoundedIdx`), parses it, and derives paths; it never touches the `.pack`. So the whole
  body is inside the layer the catch is scoped to, and the catch cannot accidentally swallow a
  pack-file fault — there is none to swallow at that point.
- **The pre-allocation bound is untouched.** `readBoundedIdx`'s stat guard still runs *before*
  `ctx.fs.read`, and its post-read guard still runs before `parsePackIndex`. Only the
  **disposition** of their `INVALID_PACK_INDEX` changes: skip this pack instead of failing the
  store. No guard is relaxed, no allocation is widened (§D8 T-7).
- **`FILE_NOT_FOUND` is a real race, not just tidiness.** `readdir` lists the `.idx`; a
  concurrent repack can unlink it before `stat`/`read`. Today that rejects the whole scan; git
  skips a `.idx` it cannot open, silently and per pack (H7). The same arm covers both.
- **One warn per skipped idx per generation** — not per lookup. That is the honest divergence
  from git's per-consultation `error:` line, and it is a logging-channel difference only (§D3).

`enumerateObjects`, `resolveOidPrefix` and every other `all()` consumer inherit the exclusion for
free, which is precisely git's `packs: 0` / `in-pack: 0` on H6 and H7 (requirement 13).

### §D3 — refusal propagation

Under ADR-573, `lookup` catches the header rejection, logs, and continues; under ADR-575,
`scanPacks` does the same for an idx rejection. That is the `fetch.prune` pattern
(`fetch.ts:445`): a condition that must be *known* but must not *fail*. Neither is a swallowed
error (requirement 11) — the structured reason is handed to the Logger port, which sanitises it
and cannot throw.

What the fold changes, stated as a before/after over the Pin H rows:

| Pin H row | tsgit today | tsgit after |
|---|---|---|
| H2 v99 pack | pack silently parsed **as v2** | lookup-layer skip; object *missing*; one warn per lookup hit |
| H3 count disagreement | undetected; a wrong `nextOffsetForEntry` bound may surface later as `INVALID_PACK_ENTRY` | lookup-layer skip; object *missing*; one warn per lookup hit |
| H4 `.pack` unopenable | `lookup` hits, then `offsetTable()`'s `ctx.fs.stat` or the handle open surfaces the adapter fault to the caller | lookup-layer skip; object *missing* |
| H5 orphan `.idx` at scan | same as H4 — `loadPack` never touches the `.pack`, so the fault surfaces later from `offsetTable()`'s stat | scan-layer exclusion (the sibling-`.pack` check); `all()` omits it; one warn per generation |
| H5 race — `.pack` vanishes after the scan | as H4 | lookup-layer skip at the 12-byte probe; object *missing* |
| H6 `.idx` corrupt | `parsePackIndex` throws out of `loadPack` → the memoised scan rejects → **every** read through that `Context` fails | scan-layer skip; the pack leaves the generation; every other read unaffected |
| H7 `.idx` unreadable | as H6 | as H6 |

Six interactions to state rather than discover:

- **Partial clone.** A skipped pack turns into `OBJECT_NOT_FOUND`, which `withLazyFetchRetry`
  (`read-object.ts:107-121`) converts into one promisor fetch + one retry. That mirrors what git
  does when an object it cannot reach locally is promised by a remote; and the retry's
  `registry.refresh()` discards the header memos with the pack set, so a re-fetched good pack is
  re-probed rather than remembered as bad. The scan-layer skip joins that path: a repaired `.idx`
  is re-read on the next generation, never remembered as bad.
- **`fetch-missing.ts:57`** uses `registry.lookup` purely as an existence probe. A skipped pack
  therefore makes its objects look absent to `fetchMissing`, which will try to fetch them — the
  same conclusion git reaches (Pin C3), reached the same way.
- **`enumerateObjects` / `resolveOidPrefix` / `fsck --full`.** These read `registry.all()` and
  walk `pack.index` without ever calling `lookup` (`enumerate-objects.ts:42-45`,
  `resolve-oid-prefix.ts:40`). After the fold the two layers land on opposite sides of that
  boundary, and the enumeration surface matches git on **five of the six** fault rows: an
  idx-fault pack is gone from `all()`, exactly git's `packs: 0` / `in-pack: 0` (H6, H7); a
  version-, count- or open-refused pack is still listed with its index, exactly git's `packs: 1` /
  `in-pack: 5` (H2–H4) — git counts a v99 pack's objects off the readable `.idx` too. That is a
  narrower residue than ADR-572 had to assume when it deferred the gap: with ADR-579's
  scan-time orphan exclusion the enumeration axis is faithful on every Pin H row, and
  everything left over is *integrity reporting* —
  tsgit's `fsck` has no equivalent of git's `packfile … cannot be accessed` + exit bit 4 (Pin B).
- **Log volume, lookup layer.** Because there is no negative cache (C5), a walk over a repo
  containing a refused pack emits one warn per object lookup that hits that pack's index. git
  prints one `error:` line per request for the same reason. Faithful, and loud.
- **Log volume, scan layer — the one place tsgit is quieter than git.** git loads an `.idx` on
  first consultation of that pack and re-loads it per request, so a corrupt idx produces an
  `error:` line per consultation *and none at all* when a sibling pack answers first (Pin H,
  laziness bullet). tsgit parses every `.idx` eagerly in `scanPacks` — it must, because
  `pack.index` *is* the lookup key — so the warn fires **once per generation**, whether or not
  any lookup would have consulted that pack. No data row differs: the pack contributes nothing
  either way, loose objects and siblings are served either way, and `all()` agrees with git's
  `packs:` count in both directions. Only the logger channel differs, which ADR-249 puts outside
  the faithfulness boundary. Named because it is the honest cost of ADR-575's scan-layer
  placement, not an oversight.
- **The scan memo now resolves where it used to reject.** A repo whose every `.idx` is corrupt
  produced a rejecting, self-clearing memo (so each `all()` re-scanned and re-threw); it now
  resolves to `[]` and is memoised for the generation, i.e. it looks exactly like a repo with no
  packs — which is what git reports (`packs: 0`). A `.idx` repaired mid-process is picked up by
  `refresh()`, the same contract every other cached scan already has.

### §D4 — write-path symmetry (explicit checklist)

| question | answer |
|---|---|
| Does the read widening imply a write widening? | **No.** Pin F: git writes version 2 only, in both object formats. Writing 3 would be readable by git yet unfaithful on the *on-disk state* the prime directive binds. |
| Every site that stamps a pack version? | Exactly one: `serializePackfile` (`pack-writer.ts:45`), whose single caller is `build-pack.ts:41` (used by bundle create and push). `serializePackHeader` is the only writer primitive. |
| Every site that stamps an **idx** version? | `serializePackIndex` — idx v2, matching Pin E's `0xff744f63 / 2` for both hashes. Untouched. |
| Does `serializePackHeader(version: number, …)` need narrowing? | No. It is a public primitive and the test suite legitimately synthesises off-spec headers with it. The *policy* lives at the one call site, as the named `GENERATED_PACK_VERSION`. |
| `@writes` annotation churn? | None. `pack-writer.ts` keeps `surface: packfile · kind: equivalent-under-readback · format: git-packfile-v2`. `tooling/audit-write-surfaces.ts` stays green with no allowlist edit. |
| Asymmetry documented where a reader will find it? | Yes — the two constants sit adjacent in `pack-entry.ts`, one named for the read set and one for the generated value, so the asymmetry is visible in three lines. |
| Does a v3 pack ever *become* a written artefact? | Yes, and deliberately: `materializePack` persists received bytes verbatim, so a fetched v3 pack is stored as v3. tsgit does not rewrite it to v2 — rewriting would change the pack checksum, the `.idx` it is paired with, and the file name. git does not rewrite it either (Pin A: `index-pack` keeps the v3 stamp and builds an idx against it). |
| Can a *skipped* pack make a write emit a short/incomplete artefact? | **No.** `buildPack` sources every object through `readObject` (`build-pack.ts:38`), so an object hidden by either skip layer fails push / `bundle create` with `OBJECT_NOT_FOUND` before a byte is written. Degradation is loud on the write side and quiet on the read side — the correct asymmetry (requirement 15). |
| Can a skipped pack cause object *loss*? | **No.** tsgit exposes no `gc` / `repack` / `prune` surface, so nothing deletes objects on a reachability computation that a degraded pack set could bias. The hazard exists in git (which is why `git gc` bails on an unreadable pack) and would have to be re-examined the day tsgit grows one — recorded in §D8 T-8. |

### §D5 — hash-width genericity (explicit checklist)

| question | answer |
|---|---|
| Does the 12-byte header contain a digest? | No — signature(4) + version(4) + count(4). `PACK_HEADER_SIZE = 12` is correct for SHA-1 and SHA-256 alike. |
| Does any part of the gate branch on hash width? | No, and it must not (Pin E: SHA-256 repos also stamp version 2, and git accepts a v3 SHA-256 pack). A reader who assumes "v3 = SHA-256" would write exactly that branch; Pin E exists to forbid it. |
| Where *is* hash width load-bearing? | Only in the **fixtures**. Re-stamping a pack's trailer means digesting `pack[0 .. len − digestLength)` — the tests must take `digestLength` from `ctx.hashConfig` (as `pack-registry.ts:109` already does for `trailerStart`), never a literal 20. |
| Can the matrix include a SHA-256 leg? | **No, and not because of this change.** `IDX_SHA_LENGTH = 20` is hard-coded in the idx **reader** (`pack-index.ts:10`) as well as the writer (`pack-writer.ts:63`), so tsgit's pack subsystem is SHA-1-only end to end (B-5). Pin E is therefore a *constraint on the design* — do not branch on hash — not a test row. Widening the subsystem to SHA-256 is out of scope and would be its own backlog item. |

### §D6 — error semantics

| input, local path | structured outcome (ADR-573/575) | git's observable outcome |
|---|---|---|
| pack v2 / v3, object present | object returned | object returned (Pin B) |
| pack v99, object also elsewhere | object returned from the other source; one logger warn | object returned, one `error:` line (Pin C2) |
| pack v99, object nowhere else | `OBJECT_NOT_FOUND { id }`; one logger warn | `missing` / `fatal: Not a valid object name` (Pin C3, C4, H2) |
| pack v99, object not in its index | nothing happens; pack never opened | nothing happens (Pin C1) |
| pack v99, N lookups hitting its index | N probes, N warns | N `error:` lines (Pin C5) |
| pack v99, `all()` / `enumerateObjects` | pack listed; its index's ids enumerated | `packs: 1`, `in-pack: 5` (H2) |
| header count ≠ index count, object in that pack | `OBJECT_NOT_FOUND { id }`; one warn whose reason names both counts | `missing`; `error: … claims to have N objects while index indicates M objects` (H3) |
| `.pack` unopenable (ENOENT / EACCES), object in its index | `OBJECT_NOT_FOUND { id }`; one warn | `missing`, git silent (H4, H5) |
| `.idx` unparseable | that pack absent from `all()` and from every lookup; **one warn per generation**; all other reads normal | `packs: 0`, `in-pack: 0`, that pack's objects `missing`, loose + siblings served, exit 0 (H6, Pin I) |
| `.idx` unreadable (ENOENT / EACCES) | as above | as above, git silent (H7) |
| `.idx` over `MAX_PACK_IDX_BYTES` | that pack absent from `all()`; **no `ctx.fs.read` issued** for it; one warn | no direct analogue — git's own size sanity refuses the idx and skips the pack (H6 family) |
| every `.idx` in the directory faulty | `all()` resolves `[]`; N warns | `packs: 0`; the repo reads as loose-only (H6) |
| a fault outside both allow-lists (`EMFILE` → `UNSUPPORTED_OPERATION`, or a non-`TsgitError`) | propagates unchanged to the caller | n/a — tsgit-side guardrail, not a git behaviour |

| input, ingest path | structured outcome | git's observable outcome |
|---|---|---|
| v2 / v3 pack bytes | entries walked, idx written, pack stored verbatim | `index-pack` exit 0 (Pin A) |
| v99 pack bytes | `INVALID_PACK_HEADER { reason: 'unsupported version: expected 2 or 3, got 99' }` | `fatal: pack version 99 unsupported`, exit 128 (Pin A) |
| bad signature | `INVALID_PACK_HEADER { reason: 'invalid magic: …' }` (unchanged) | `is not a GIT packfile` (Pin D) |
| < 12 bytes | `INVALID_PACK_HEADER { reason: 'truncated: …' }` (unchanged) | `far too short to be a packfile` (Pin D) |

Per ADR-249 the *wording* is ours and the *condition* is git's. The interop tests assert the
condition on both sides and reconstruct git's line from the structured fields where a
transcript comparison is wanted.

### §D7 — performance, and why the gate avoids the `FileHandle`

Cost: **one 12-byte `readSlice` per pack per successful validation**, incurred only for a pack
whose index claims a requested object, memoised thereafter; a *refused* pack is re-probed per
lookup hit (C5). Against the `stat` + full `.idx` read + `parsePackIndex` that `loadPack` already
pays, and the `O(n log n)` offset sort `offsetTable` pays, it is noise.

The gate adds one `await` to `lookup`, which is already `async` and already awaits `allPacks()`.
It adds **nothing** to `readSlice`, so the delta-chain walk — the hot loop
`readEntryHeaderWithChunk` drives — is byte-for-byte the same code path as today. That is the
reason the gate lives in `lookup` rather than wrapping `readSlice` (ADR-572's rejected option 3).
The residual is one extra microtask per object lookup on a settled memo; if a bench ever
attributes anything to it, the mitigation is a synchronous `validated` flag consulted before the
`await` — deliberately not designed in now, because it trades a measurable nothing for mutable
state on a hot path.

**The scan layer costs nothing at all.** `scanPacks` already reads and parses every `.idx` in the
directory; ADR-575 wraps that existing work in a `try`/`catch` and, on the failing arm, does
*less* than today — it skips a `RegisteredPack` allocation and its two promise memos. The happy
path is byte-for-byte unchanged: one `try` block entered per pack, which V8 does not penalise
when nothing throws.

**Why `ctx.fs.readSlice` and not `pack.readSlice`.** Routing the header read through the pack's
own `readSlice` would open (and thereby memoise) the persistent `FileHandle` as a side effect of
a lookup, so a lookup that never reads an entry — `fetch-missing.ts:57` does exactly that — would
leave a handle open until `dispose()`. ADR-566…571 bought "no handle exists that nothing will
close"; the cheapest way to keep that is for the 12-byte probe to own no handle at all. It also
keeps `header()` independent of the `retired` / `inFlight` / `close()` state machine, which the
brief explicitly asks not to disturb, and avoids a recursive definition (`readSlice` awaiting
`header()` awaiting `readSlice`) for free.

### §D8 — threat model

The subject is a parser gate over bytes an attacker may fully control: a pack delivered by a
remote over fetch/clone, a bundle handed to `bundleVerify`, or a `.pack` — **or `.idx`** — written
into `.git/objects/pack/` by anything with write access to the repo. ADR-575 brings the second
parser (`parsePackIndex`) inside a `catch`, so T-7 states precisely what that does and does not
change.

| # | concern | assessment |
|---|---|---|
| T-1 | Widening 2 → 3 admits packs previously refused | **No new parsing surface.** v3 is format-identical to v2 and *no* entry parser branches on version (requirement 1), so the same bytes reach the same `parsePackEntryHeader` / inflate / trailer-verify code that already handles them under version 2. The widening relabels, it does not unlock. Existing ingest bounds are untouched: `maxObjectsPerPack` (`fetch-pack.ts:308-315`), `maxResponseBytes`, `MAX_SIZE_EXTENSION_BYTES`, `MAX_OFS_DISTANCE_BYTES`, `MAX_DELTA_CHAIN_DEPTH`, the compressor's `maxOutputLength`. |
| T-2 | The local gate is a *hardening* | Today a pack stamped with any version is parsed as v2. The value of the gate is exactly the case that does not exist yet: a future real format sharing the `PACK` signature would be **mis-parsed** as v2 rather than refused. Closing that is the security content of this change. |
| T-3 | The gate itself parses hostile bytes | Fixed 12-byte read, fixed-offset `DataView` reads, no allocation keyed off content, no loop. `objectCount` is read but, on the local path, never used to size anything — the `.idx` drives every allocation. ADR-577 compares it against `index.objectCount`: a comparison of two already-parsed integers, still no allocation. |
| T-4 | Skipping a pack is a denial vector | An attacker who can flip one byte in a pack header — or in an `.idx` — makes that pack's objects invisible. They could equally corrupt the pack body, and git has the identical property (Pin C3, H6). No new exposure; the logger warn is what keeps it diagnosable. What the fold *removes* is a denial vector pointing the other way: today one corrupt `.idx` denies **every** object in the repository, loose ones included, because the whole scan rejects. Per-pack degradation strictly narrows the blast radius. |
| T-5 | Log injection via the pack name | `RegisteredPack.name` is already constrained by `isSafePackName` (no `/`, `\`, `..`) and the Logger wrapper sanitises every string it forwards (`wrapLoggerSanitizer`). |
| T-6 | Symlinked `.pack` | Unchanged: the persistent-handle path uses `openWithNoFollow`; the 12-byte probe uses `ctx.fs.readSlice`, whose node adapter enforces the same root containment as every other read. No new path is constructed — `packPath` is the existing derived value. |
| T-7 | **The idx parser now runs inside a `catch`** | The `.idx` is attacker-controllable bytes, and ADR-575 moves its parse failure from fatal to skippable. What does **not** change: `readBoundedIdx`'s pre-`read` stat bound and post-`read` length bound still run, in that order, before any large allocation and before `parsePackIndex` sees a byte; `parsePackIndex`'s own guards (magic, version, fanout monotonicity, large-offset range, safe-integer offsets) are untouched; no additional bytes are parsed and no bound is widened. What *does* change is only the **disposition** of a refusal — this pack is dropped instead of the whole store failing. Two second-order effects, both named rather than assumed: (a) a refusal is now reported on a channel a caller may not be listening to (`ctx.logger?.warn?.`) instead of as a thrown error, so a corrupt `.idx` is quieter — mitigated by requirement 11 and by the fact that git is equally quiet on H7 and reports H6 only on stderr; (b) the catch is an **allow-list keyed on `INVALID_PACK_INDEX` / `FILE_NOT_FOUND` / `PERMISSION_DENIED`**, so a resource fault (`EMFILE` → `UNSUPPORTED_OPERATION`) or a programming fault still propagates and cannot be laundered into "this repository has fewer packs than it does" (§D2.1). |
| T-8 | A degraded pack set feeding a destructive computation | The classic hazard of "treat an unreadable pack as absent" is a reachability walk concluding objects are unreferenced and deleting them. tsgit has no `gc` / `repack` / `prune` surface, and the one artefact-producing consumer, `buildPack`, fails closed with `OBJECT_NOT_FOUND` (§D4). So the hazard is *structurally* absent today, not merely unobserved — and it becomes a design constraint on any future pruning surface, which must consult a non-degraded view (or refuse) exactly as `git gc` does. |

### §D9 — blind spots, named

1. **`registry.all()` consumers bypass the lookup gate** (§D3). Deliberate under ADR-572, and
   after the fold the enumeration axis is faithful on every Pin H row — H5 included, since
   ADR-579 excludes an orphaned `.idx` at scan exactly as git does. Two residues: tsgit's
   `fsck` lacking git's `packfile … cannot be accessed` + exit bit 4, an integrity-reporting
   gap deferred by ADR-572; and a **symlinked `.pack`**, which git registers (its sibling test
   is by name, with no file-type filter) but tsgit's regular-files-only listing drops at scan —
   a deliberate extension of the existing no-follow policy, noted in the sibling-check comment.
2. **Browser / memory adapters.** `ctx.fs.readSlice` is a `FileSystem` port method every adapter
   implements — it is already `RegisteredPack.readSlice`'s fallback reader on the retired path
   and on adapters that cannot open persistent handles — so the gate needs no adapter work.
   Worth one parity scenario, not a design branch.
3. **`refresh()` re-probes.** Each refresh discards the header memos with the pack set, so a
   long-lived Context that refreshes N times pays N × 12 bytes per touched pack. Bounded and
   correct: a pack file can be replaced between generations.
4. **The inverted tests — three of them, not one.** `pack-entry.test.ts:54-58` currently asserts
   that version 3 is refused; it must flip, not be deleted, and the same table gains rows 1 and 4
   so the widened guard is pinned on both sides. `pack-registry.test.ts:121-169` and `:220-262`
   currently assert that an oversized / TOCTOU-growing `.idx` makes `all()` **throw**; ADR-575
   turns both into per-pack skips. Inverting them carelessly would delete the anti-DoS pin they
   really carry — see §Test strategy for the exact assertions that must survive the inversion.
5. **Probe order differs from git's.** tsgit checks the delta cache, then loose, then packs
   (`object-resolver.ts:60-73`); git checks packs, then loose. For every row of Pin C the
   observable outcome is the same, but a unit test that "proves laziness" by reading a loose
   object would prove nothing about the gate — it would never reach the registry. §Test strategy
   arranges around this.
6. **The gate's completeness rests on an unenforced invariant.** Under ADR-572 the gate covers
   every pack-byte read *because* every such read passes through `lookup` first — verified
   today: `offsetTable()` and `readSlice()` are only ever reached from a `PackLookupHit`
   (`object-resolver.ts:265`, `:411`; `blob-source.ts:102`, `:104`; REF_DELTA bases recurse back
   through `resolveObjectBytes` → `lookup`). Nothing *forces* that to stay true. The cheap
   durability measure is a doc-comment on `RegisteredPack.readSlice` / `offsetTable` stating
   that callers must hold a hit from `lookup`. Ship the doc-comment; the structural alternative
   was considered and rejected in ADR-572.
7. **Eager idx parse vs git's lazy one** (§D3). tsgit warns once per generation for a corrupt
   `.idx` even when no lookup would have consulted that pack; git warns per consultation and not
   at all when a sibling answers first (Pin H). Data-identical, log-divergent. It is not
   removable without making `pack.index` itself a memo, which would push the idx parse into
   `lookup` and re-introduce a rejection path on the hot loop.
8. **The scan memo now resolves instead of rejecting.** A generation whose packs all fail is
   indistinguishable from a repo with no packs until `refresh()`. That matches git's `packs: 0`,
   but it means a caller can no longer learn "the store is damaged" by catching a read error —
   only by listening to the logger. Requirement 11 is the mitigation; ADR-575 records the
   consequence that registry-scan failure is no longer a store-integrity signal.
9. **The two allow-lists will drift if they are ever merged.** They deliberately differ by one
   code each (`INVALID_PACK_HEADER` vs `INVALID_PACK_INDEX`); a well-meaning DRY pass that unions
   them would make a mid-read `INVALID_PACK_INDEX` from `nextOffsetForEntry` skippable at the
   lookup layer, silently converting a detected corruption into a miss. The shared helper is
   `isSkippableIoFault` and nothing more (§D2.1).
10. **Legacy `.idx` version 1 is softened, not fixed.** git still reads idx v1; tsgit's
    `parsePackIndex` refuses anything but v2 (`pack-index.ts:31-40`). Today that refusal fails
    every read in the repository; after the fold it degrades to "that pack's objects are
    missing". Closer to git, still divergent — git serves them. Out of scope, and now a *smaller*
    divergence than before.
11. **`fetchMissing` builds its own registry** (`fetch-missing.ts:65`), so it gets its own
    generation and its own warns. Correct — it is a separate `Context` lifecycle — but it means a
    single corrupt `.idx` can be warned about twice in one command. Cosmetic, on the logger
    channel only.

## Ratified decisions

Every load-bearing choice this design raised was decided in the ADR conversation; the table of
candidates it used to carry is now the record below. Each ADR is authoritative for its row — the
design describes *how*, the ADR says *why that option*.

| # | Question | Outcome | ADR |
|---|---|---|---|
| DC-1 | Where the local-open gate sits; is `all()` gated too? | **(a)** In `lookup()`, between the idx hit and the returned hit; `all()` stays ungated. The `fsck --full` reporting gap is documented and deferred | [ADR-572](../adr/572-local-pack-gate-sits-in-lookup.md) |
| DC-2 | How a refused pack propagates | **(a)** Pack-scoped skip → `OBJECT_NOT_FOUND` + one `ctx.logger?.warn?.` | [ADR-573](../adr/573-refused-pack-degrades-per-pack.md) |
| DC-3 | Error shape for the local refusal | **(a)** Reuse `INVALID_PACK_HEADER { reason }` verbatim; zero public-surface delta | [ADR-574](../adr/574-local-refusal-reuses-invalid-pack-header.md) |
| DC-4 | How wide the skip arm is | **(c) FULL per-pack degradation — user-ratified deviation** from this design's recommendation (b). Header faults *and* unopenable `.pack` *and* unreadable/unparseable `.idx`; the idx arm sits at the scan layer and excludes the pack from the generation | [ADR-575](../adr/575-full-per-pack-registry-degradation.md) |
| DC-5 | `PackHeader.version`'s type | **(a)** Stays `number`, returned verbatim (a v3 pack reports `3`) | [ADR-576](../adr/576-pack-header-version-stays-number.md) |
| DC-6 | Does the gate cross-check `objectCount`? | **(b)** Yes — header count vs `PackIndex.objectCount`; a mismatch is a skippable pack fault. Trailer checksum stays out | [ADR-577](../adr/577-local-gate-cross-checks-object-count.md) |
| DC-7 | Provenance of the v3 / v99 fixtures | **(a)** Crafted in-test, per tier, digest length from the context's hash config | [ADR-578](../adr/578-pack-version-fixtures-crafted-in-test.md) |

**What DC-4(c) changed in this document.** It is the only deviation, and it is not a footnote:
the widened arm added a second skip layer (§D2.2), inverted a currently-fatal condition
(§D3 before/after table), pulled Pin H's rows from *context* into *requirements* — hence Pin H and
the new Pin I are executed rather than read off the code — added requirements 12–15, two
threat-model rows (T-7, T-8), five blind spots, two inverted unit tests and six interop rows, and
surfaced exactly one new question (DC-8). Everything already consistent with ADRs 572–574 and
576–578 is unchanged.

Two questions the fold raises are settled by the ratified text rather than left open, and are
recorded here so the reader can see they were asked. *Which error code the `objectCount` mismatch
throws* — `INVALID_PACK_HEADER`, because ADR-574 fixed one representation for the gate's refusals
and ADR-577 declares the mismatch a skippable pack fault under ADR-575 (§D2.1). *Whether the
scan-layer allow-list covers I/O faults as well as parse faults* — yes: ADR-575 says "a `.idx`
that fails to **read or** parse", and git skips an unreadable `.idx` exactly as it skips a corrupt
one (H6 vs H7), while the house rule in `isUnsupportedOperation` keeps `EMFILE`-class faults out
of the list.

### Ratified after the fold — DC-8 and DC-9

The fold surfaced two further choices, both since ratified:

- **DC-8 → ADR-579** (user-ratified, option (c)): `scanPacks` registers a pack only when a
  sibling `<name>.pack` entry appears in the `readdir` listing it already holds — git's own
  scan-time rule at zero extra I/O. The lookup-layer `FILE_NOT_FOUND` skip stays for the
  `.pack` deleted after the scan.
- **DC-9 → ADR-580** (adopted-as-recommended): the orphan exclusion emits one structured
  `ctx.logger?.warn?.` per generation — the anomaly git surfaces via `count-objects`'s
  `warning: no corresponding .pack` stays diagnosable without a faithfulness cost.

## Test strategy

### Unit — `test/unit/domain/storage/pack-entry.test.ts` (extend)

- **The inverted row.** The `it.each` malformed table's *"an unsupported version (3)"* entry
  (`:54-58`) leaves the refusal table and becomes an acceptance case asserting
  `{ version: 3, objectCount: n }` — the accepted value is returned, not normalised.
- **Version sweep**, parameterised: `0, 1` refuse · `2, 3` accept · `4, 99, 0xffffffff` refuse.
  Rows 1 and 4 are the mutation-critical ones: without them a `version < 2 || version > 3`
  boundary mutant survives against a table that only tests 2, 3 and 99.
- **Exact-reason assertion** for one refusal (`'unsupported version: expected 2 or 3, got 99'`),
  following the existing exact-reason precedent at `:104-107`, so the `StringLiteral` mutant on
  the new message dies.
- **Property lens (lens 1, round-trip pair).** `serializePackHeader` / `parsePackHeader` is a
  genuine encode/decode pair, so a `pack-entry.properties.test.ts` sibling is in scope:
  `parse(serialize(v, n)) ≡ { version: v, objectCount: n }` for `v ∈ {2,3}` and arbitrary uint32
  `n`, `numRuns: 200`; plus `parse(serialize(v, n))` throws `INVALID_PACK_HEADER` for arbitrary
  `v ∉ {2,3}` in `[0, 2³²)`. Counter-argument, stated honestly: the version domain is a 2-element
  set the example sweep already covers — the property earns its keep on the `objectCount` axis and
  on the *complement* of the version set, which no finite table can enumerate. There is no
  properties file in `test/unit/domain/storage/` today, so this creates the directory's first one
  plus its `arbitraries.ts`.

### Unit — `test/unit/application/primitives/pack-registry.test.ts` (extend)

Fixtures in place: `buildSeededContext` (`./fixtures.js`), `buildSyntheticPack` /
`writeSyntheticPack` (`./pack-fixture.js`, which already calls `serializePackHeader(2, …)` at
`:73`). Add a small helper that rewrites a written pack's version field in place and re-stamps
the trailer over `bytes[0 .. len − ctx.hashConfig.digestLength)`.

The matrix, one `it` per Pin C row (`sut` = the registry). Note §D9 blind spot 5: the loose probe
runs **before** the pack probe in tsgit, so the C1 arrangement must make the object absent
everywhere rather than loose — otherwise the test passes without the gate existing.

| case | arrangement | expectation |
|---|---|---|
| v3 pack | one pack, version 3 | `lookup` hits; `readObject` returns the object |
| C1 (laziness) | v99 pack only; request an oid present in **neither** the pack nor loose | `OBJECT_NOT_FOUND`; **`ctx.fs.readSlice` never called on the `.pack`** (ledger) and **no warn** — the index never claimed the oid |
| C2 | v99 pack + good pack, object in both, **bad pack scanned first** | object returned from the good pack; exactly one warn naming the bad pack |
| C3/C4 | v99 pack only, object present only there | `OBJECT_NOT_FOUND { id }` — asserted on `.data`, not on the error class; one warn |
| C5 (no negative cache) | v99 pack only, two lookups hitting its index | **two** header probes and **two** warns — the memo cleared on rejection |
| memoisation, positive | v2 pack, two lookups | **one** header probe — the memo held |
| bad signature | `PACX` | same skip path; warn reason contains `magic` |
| short pack | pack truncated to 8 bytes | same skip path; warn reason contains `truncated` |
| H3 count mismatch | v2 pack whose header count is `index.objectCount + 1`, trailer re-stamped | same skip path; warn reason names **both** counts. Its **own** `it`, per the isolated-guard rule — a test that also breaks the version would not prove the count check exists (ADR-577's consequence) |
| H4 `.pack` unopenable | valid `.idx`; `ctx.fs.readSlice` on the `.pack` rejects with `PERMISSION_DENIED` | skip; `OBJECT_NOT_FOUND`; one warn |
| H5 orphan at scan | valid `.idx` written, `.pack` never present | excluded from the generation (ADR-579); `all()` omits it; one warn per generation (ADR-580) |
| H5 race at lookup | `.idx` scanned with its `.pack` present; the `.pack` vanishes before the probe (`FILE_NOT_FOUND`) | skip; `OBJECT_NOT_FOUND`; one warn. Kills the "ENOENT is not skippable" mutant on `isSkippableIoFault` |
| unrecognised lookup fault | probe rejects with `UNSUPPORTED_OPERATION { operation: 'filesystem' }` | **propagates** — `lookup` rejects with that exact `.data`. The negative half of the allow-list; without it, widening `isSkippablePackFault` to `catch {}` survives |
| handle ledger | any of the above | opened-minus-closed handles after `dispose()` is 0 (requirement 9) |

**Scan-order determinism.** C2 only exercises the skip arm if the bad pack is iterated first, and
`scanPacks` iterates raw `ctx.fs.readdir` order (`pack-registry.ts:213-218`). The fixture must
pin that order — name the packs so the bad one sorts first *and* assert the observed order in
the arrangement, rather than assuming the adapter sorts. A C2 that silently degrades into "the
good pack answered first" passes with the gate deleted.

#### The scan layer (ADR-575) — new rows, and two inversions

New `it`s, `sut` = the registry:

| case | arrangement | expectation |
|---|---|---|
| H6 corrupt `.idx`, good sibling | garbage `.idx` + a good pack holding the requested oid | `readObject` **returns the object**; `all()` lists **only** the good pack; exactly one warn naming the skipped idx |
| H6 corrupt `.idx`, loose object | garbage `.idx`; the requested oid is loose | the loose object is returned — the row that pins "one bad idx no longer fails every read" |
| H6 corrupt `.idx`, nothing else | garbage `.idx` only | `OBJECT_NOT_FOUND { id }` on `.data`; `all()` returns `[]` |
| H7 unreadable `.idx` | `ctx.fs.read` on the `.idx` rejects `PERMISSION_DENIED` | same skip; one warn |
| `.idx` vanishes after `readdir` | `readdir` lists it, `stat` rejects `FILE_NOT_FOUND` | same skip; one warn — the concurrent-repack race (§D2.2) |
| every `.idx` faulty | two garbage idx files | `all()` resolves `[]` with **two** warns; no throw |
| unrecognised scan fault | `ctx.fs.read` rejects `UNSUPPORTED_OPERATION { operation: 'filesystem' }` | **propagates** out of `all()` — the `EMFILE` guardrail |
| warn cardinality | one garbage `.idx`, **three** lookups | exactly **one** warn — the scan memo holds; contrast with C5's per-lookup warn at the other layer |

The two **inversions**, spelled out because inverting them carelessly deletes the pin they carry:

- `:121-169` *"an `.idx` whose stat reports > MAX_PACK_IDX_BYTES … throws INVALID_PACK_INDEX
  without issuing a read"*. New shape: `all()` **resolves**, the oversized pack is **absent** from
  the result, and one warn carries `reason: REASON_PACK_IDX_EXCEEDS_MAX`. The assertion that must
  survive verbatim is `expect(reads).toEqual([])` — the whole point of that test is that the
  stat guard fires *before* a multi-GiB allocation, and that property is unchanged by ADR-575.
  The exact-reason assertion also survives, moved from the thrown error to the warn context;
  without it the pre-read guard is indistinguishable from `parsePackIndex` rejecting bad magic.
- `:220-262` (TOCTOU: stat lies small, `read` returns oversized bytes). Same inversion: `all()`
  resolves without that pack, one warn whose reason is exactly `REASON_PACK_IDX_EXCEEDS_MAX` —
  which is what distinguishes the post-read length guard from a downstream magic failure and
  kills the `ConditionalExpression -> false` / `BlockStatement -> {}` mutants the original
  comment names.

A third test is *not* inverted: `:72-119` (unsafe pack names) drives `read` to throw a plain
`Error`, which neither allow-list recognises, so it still propagates — its `try`/`catch` and its
`statsSeen` assertions stand unchanged. Worth stating: it doubles as free evidence that a
non-`TsgitError` is not skippable.

### Integration / interop — **new** `test/integration/pack-version-interop.test.ts`

`@proves` block with `interopSurface: packfile`, `bucket: cross-tool-interop`. Helpers:
`GIT_AVAILABLE`, `makePeerPair`, `initBothRepos`, `runGit` / `gitAsync` from
`./interop-helpers.js`. Per the interop-flake note, share one `beforeAll` repo and budget 60 s;
use the async git helper for anything that could block the event loop.

The crafting recipe, which every case below depends on:

```
buf.writeUInt32BE(version, 4);                                            // pack header, u32 BE @4
sha(buf.subarray(0, len - digestLength)).copy(buf, len - digestLength);   // re-fix the trailer
// when a matching .idx is needed WITHOUT running index-pack (the v99 cases):
packTrailer.copy(idx, idx.length - 2 * digestLength);       // idx's recorded pack checksum
sha(idx.subarray(0, idx.length - digestLength)).copy(idx, idx.length - digestLength);
```

For the **v3** cases the `.idx` is simply produced by `git index-pack`, which sidesteps the
re-stamp and doubles as the ingest assertion. The idx re-stamp is required only for v99, where
git refuses to build one — and Pin D proves it is not strictly *needed* for the version
assertion (the version check precedes the checksum check), but it is needed for the test to
prove the version is the **only** thing wrong.

| # | case | git side | tsgit side |
|---|---|---|---|
| I-1 | ingest v3 | `git index-pack -o out.idx v3.pack` exits 0 | `walkPackEntries` / `fetchPack` accept the same bytes and report the same object count |
| I-2 | ingest v99 | exits 128, `pack version 99 unsupported` | `INVALID_PACK_HEADER` with the version in `reason` |
| I-3 | local read v3 | `git cat-file -p` returns the payload | `readObject` returns the identical bytes |
| I-4 | local read v99, object nowhere else | `cat-file --batch-check` → `missing`, exit 0 | `OBJECT_NOT_FOUND` (ADR-573) |
| I-5 | local read v99 **+ good pack**, object in both | `cat-file -p` returns the payload, exit 0 | `readObject` returns the identical bytes |
| I-6 | v99 pack present, object in a **second good pack** and absent from the bad pack's index | `cat-file -p` succeeds with **no** stderr at all (Pin C1) | `readObject` succeeds. The "bad pack never opened" half of C1 is proved in the unit tier, where a ledger exists; here the assertion is the git-side silence plus tsgit's success |
| I-7 | bundle carrying a v3 pack | `git bundle verify` → `is okay`, exit 0 | `bundleVerify` accepts (B-1's surface) |
| I-8 | round trip | tsgit ingests the v3 pack, then reads an object back out of the repo it just wrote | `git cat-file -p` reads the same object from the same repo (requirement 3a) |
| I-9 | **corrupt `.idx`, object nowhere else** (H6) | `cat-file --batch-check` → `missing`, exit 0; `count-objects -v` → `packs: 0`, `in-pack: 0` | `readObject` → `OBJECT_NOT_FOUND`; `registry.all()` is empty — the pack-set assertion is the tsgit-side mirror of `packs: 0` |
| I-10 | **corrupt `.idx` + loose object** (H6) | `cat-file -p <loose>` → payload, **exit 0** | `readObject` returns the identical bytes. The row that proves one bad idx no longer fails the store |
| I-11 | **corrupt `.idx` + good sibling pack** (H6) | `cat-file -p <oid in sibling>` → payload, exit 0 | `readObject` returns the identical bytes; `all()` lists exactly one pack |
| I-12 | **`.idx` with no `.pack`** (H5) | `cat-file --batch-check` → `missing`, exit 0; `count-objects -v` → `packs: 0`, `garbage: 1`, `warning: no corresponding .pack` | `readObject` → `OBJECT_NOT_FOUND`; `all()` is empty (ADR-579's scan-time exclusion — the tsgit mirror of `packs: 0`); loose + sibling reads unaffected |
| I-13 | **pack/idx `objectCount` disagreement** (H3) | `cat-file --batch-check` → `missing`, exit 0, stderr `claims to have N objects while index indicates M objects`; `count-objects -v` → `packs: 1`, `in-pack: M` | `readObject` → `OBJECT_NOT_FOUND`; `all()` **still lists** the pack — the layer assertion (requirement 13) |
| I-14 | **enumeration parity across the two layers** | `count-objects -v` on the v99 repo (`packs: 1`, `in-pack: 5`) vs the corrupt-idx repo (`packs: 0`, `in-pack: 0`) | `all()` / `enumerateObjects` reproduce both counts. The single row that would fail if the two skip layers were collapsed into one |

I-4 and I-5 are the pair that makes ADR-573 falsifiable: had it chosen propagation, I-5 fails.
I-13 and I-14 are the pair that makes the **layer** placement falsifiable: move the idx arm to
`lookup` and I-9's `all()` assertion fails; move the header arm to `scanPacks` and I-13's does.

Two crafting notes the new rows need. The corrupt-`.idx` fixtures are made by overwriting the
idx with random bytes of the **same length** (Pin I row 2) — this is the shape that survives a
naive length check and forces the parser arm — and by truncating a real idx to 8 bytes for the
short arm. Neither needs the pack-checksum re-stamp; the idx never gets far enough to be
compared. For I-12 the `.pack` is simply deleted after `git repack`, leaving git's own `.idx`
untouched, so the fixture carries no manipulation at all.

### Parity — cross-adapter

One scenario under `test/parity/scenarios`: read an object through a v3 pack on node, memory and
browser adapters and compare. Per ADR-226 this proves adapter agreement, **not** faithfulness —
the interop table above is the only faithfulness authority. It exists because the header read is
the registry's first use of `ctx.fs.readSlice` on a path that previously never ran on the browser
arm for this purpose.

A second scenario earns its place with ADR-575, for a different reason: both discriminators key
on `FILE_NOT_FOUND` / `PERMISSION_DENIED`, which are **port-level** codes each adapter produces
independently — node via `mapErrno`, memory via an explicit `fileNotFound` throw
(`memory-file-system.ts:75`), browser via `resolveFileHandle`. A corrupt-`.idx` repo read on all
three must degrade identically; if one adapter surfaced a raw `Error` or a different code, the
skip would silently become a hard failure there and nowhere else. That is exactly the class of
bug the parity tier exists for.

### Mutation

The widened guard is a dense `EqualityOperator` / `ConditionalExpression` / `LogicalOperator`
target. The sweep above (rows 1 and 4, plus the exact-reason assertion) is designed to kill the
boundary and message mutants directly rather than through a generic `toThrow(TsgitError)`. The
`lookup` gate's `catch`-and-`continue` needs both an "another pack serves it" test (C2) and a
"nothing serves it" test (C3/C4), per the isolated-guard rule — one test exercising both arms
proves neither. The `continue` after the `catch` is its own mutant: C2 is the test that kills it.

The two discriminators are the fold's densest mutation surface, and each is a `LogicalOperator`
chain over `||`, so per the isolated-guard rule every recognised code needs a test that triggers
**it alone**: `INVALID_PACK_HEADER`, `INVALID_PACK_INDEX`, `FILE_NOT_FOUND`, `PERMISSION_DENIED`
— four arrangements, plus the two `UNSUPPORTED_OPERATION` propagation rows that kill
"force the predicate true". The `err instanceof TsgitError` operand is killed by the unsafe-name
test's plain `Error` (which must propagate). The scan-layer `continue`-after-warn has no
`continue` to mutate — the loop body simply ends — so its equivalent mutants are the warn call
itself; the "warn cardinality" row and the "corrupt idx, good sibling" row (which asserts the
*surviving* pack is still pushed) are what stop `BlockStatement -> {}` on the catch from
surviving. ADR-577's count check is one `EqualityOperator`: its dedicated `it` is mandatory,
because a test that mutates the version too would pass with the comparison deleted.

### Gates

`npm run validate`. `reports/api.json` is expected to be **unchanged** — the two new constants
are module exports that never reach `src/domain/storage/index.ts` (§D1), so neither typedoc nor
`check:doc-coverage` sees them, and ADR-576 keeps `PackHeader.version` at `number`, so no public
type moves. `tooling/audit-write-surfaces.ts` must stay green with **no** annotation or allowlist
edit (requirement 6).

## Out of scope

- **Generating v3 packs.** Pin F: git never does. §D4.
- **Reading `.idx` version 1**, multi-pack-index, and reverse indexes — none of which tsgit reads
  today. ADR-575 *softens* the v1 case (a legacy v1 index now skips its pack instead of failing
  every read, §D9.10) without closing it: git reads v1 and serves those objects, tsgit does not.
- **SHA-256 pack support.** `IDX_SHA_LENGTH = 20` is hard-coded in the idx reader and writer
  (B-5), so the whole pack subsystem is SHA-1-only. Pin E constrains this design (never branch on
  hash) but widening the subsystem is a separate backlog item.
- **The pack-vs-index trailer-checksum comparison** — the last check in git's
  `open_packed_git_1`. ADR-577 took the `objectCount` cross-check and explicitly left this one
  out: it costs a second `digestLength`-byte read plus an accessor `PackIndex` does not expose.
- **`fsck`-grade integrity reporting.** git's `fsck` distinguishes an inaccessible pack
  (`packfile … cannot be accessed`, exit bit 4) and an unopenable index (`index not opened`,
  exit 68) from a healthy repo; tsgit's degraded pack set is silent to `fsck` beyond the objects
  going missing. Deferred by ADR-572 and re-confirmed by ADR-575's consequence note — it is now
  the *only* residual divergence in this family (§D3).
- **A `verifyPack` command surface.** tsgit has no analogue of `git verify-pack`; Pin A records
  its behaviour only to show that all three of git's ingest surfaces agree on 2\|3.
- **Stderr transcript parity.** Per ADR-249, git's `error: packfile … is version 99 …` line is
  presentation. tsgit emits no such line and is not expected to.
