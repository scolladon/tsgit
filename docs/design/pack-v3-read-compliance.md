# Design — pack format v3 read compliance

> Brief: canonical git accepts pack header version **2 or 3** on read (v3 is reserved; the
> on-disk format is byte-identical to v2) and refuses every other version at first pack open.
> tsgit diverges in **both** directions — its ingest guard refuses v3, and its local read path
> never inspects the pack header at all, so it silently reads packs of any version. Widen the
> guard to `2 | 3`, validate the 12-byte header when the pack registry first opens a local
> `.pack`, keep generating v2, and pin both directions with twin git/tsgit interop tests.
> Status: draft → self-reviewed ×3 → awaiting ADR decisions

## Context

### The two divergences

Both are recorded in `docs/spike/pack-v3-read-compliance.md` and **re-pinned from scratch for
this document** against git 2.55.0 (§Pinned matrices). They point in opposite directions:

1. **Ingest too strict.** `parsePackHeader` (`src/domain/storage/pack-entry.ts:69-72`) throws
   `INVALID_PACK_HEADER` for anything but version 2. Real git indexes a v3-stamped pack
   without complaint (Pin A).
2. **Local open too lax.** The local read path is `.idx`-driven end to end
   (`pack-registry.ts` scans `*.idx`, `lookup` answers from the parsed index, `readSlice`
   seeks straight to an entry offset). Nothing ever reads the pack's own 12-byte header, so a
   pack stamped version 99 — or any future format with a different layout — is parsed as if it
   were v2. Git refuses it at first open (Pin B).

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
| B-3 | implicit: the registry is the single choke point for local pack reads | correct. Every local pack read starts at `PackRegistry.lookup` — `object-resolver.ts:73`, `blob-source.ts:99`, `fetch-missing.ts:57`. `enumerateObjects` (`enumerate-objects.ts:42-45`) is the one consumer that reads `registry.all()` **without** a lookup, and it touches only `pack.index`, never the `.pack` file. That asymmetry is load-bearing for DC-1. |
| B-4 | *"keep generating v2 … confirm and state why"* | confirmed empirically, not from memory: Pin F. |
| B-5 | implicit: the pack subsystem is hash-generic | **false, pre-existing.** `IDX_SHA_LENGTH = 20` is hard-coded in **both** the idx reader (`pack-index.ts:10`, used at `:46`, `:52`, `:86-88`, `:176-188`) and the idx writer (`pack-writer.ts:63`). tsgit's pack subsystem is SHA-1-only today. This bounds the test matrix (§D5) and is out of scope. |

### Subsystems this touches

| Part | File / symbol | Tier |
|------|---------------|------|
| P1 | `src/domain/storage/pack-entry.ts` → `parsePackHeader`'s version guard; `SUPPORTED_PACK_VERSIONS` + `GENERATED_PACK_VERSION` added, `PACK_HEADER_SIZE` (`:56`) promoted to an `export` — **none added to `src/domain/storage/index.ts`** (§D1) | domain |
| P2 | `src/domain/storage/pack-writer.ts` → `serializePackfile`'s literal `2` (`:45`) becomes `GENERATED_PACK_VERSION` (zero byte change; §D4) | domain |
| P3 | `src/application/primitives/pack-registry.ts` → new memoised `RegisteredPack.header()` in `loadPack`; the gate + `isSkippablePackFault` discriminator inside `createPackRegistry().lookup`; deep-imports `parsePackHeader` / `PACK_HEADER_SIZE` from `../../domain/storage/pack-entry.js` (the file already deep-imports `../../domain/storage/error.js` at `:7`) | primitive |
| P4 | `test/unit/domain/storage/pack-entry.test.ts` → the existing *"an unsupported version (3)"* refusal row **inverts** (`:54-58`); version sweep added | test |
| P5 | `test/unit/application/primitives/pack-registry.test.ts` → skip/serve matrix over synthetic packs | test |
| P6 | **new** `test/integration/pack-version-interop.test.ts` → the twin git/tsgit pins | test |

### Constraining prior decisions

| ADR / rule | What it binds | How this design stands to it |
|---|---|---|
| **ADR-226** (git-faithfulness prime directive) | observable behaviour byte-for-byte unless an ADR diverges | this change *is* the prime directive applied to a read gate; every accept/refuse cell comes from §Pinned matrices, none from memory |
| **ADR-249** (structured data, not cosmetics) | refusal *conditions* must match git; the rendered wording is ours | git's `error: packfile … is version 99 …` is stderr text tsgit never emits. What binds is: which objects become resolvable, and with which structured error. §D6 |
| **ADR-510** (persistent per-pack `FileHandle`s owned by the registry) | the registry owns one lazily-opened handle per pack | the header gate deliberately sits **outside** the handle lifecycle (§D7) |
| **ADR-566 … ADR-571** (pack-registry single-flight, PR #263) | every lazy initializer that crosses an `await` is a `createPromiseMemo`; no handle may become unreachable; `dispose()` is terminal | the new `header()` is another `createPromiseMemo`, and it opens **no** disposable — so it adds no orphaning surface. Requirement 9 |
| **ADR-359** (exact-slice pack reads via next-offset) + **ADR-360** (remove pack slice hint) | `offsetTable` / `readSlice` consumer contract | unchanged — the header probe is a fixed `[0, 12)` slice, not an entry read |
| **ADR-050** (cache-invalidation policy) | event-driven invalidation for caches that can go stale | the header memo is scoped to a `RegisteredPack`, so `refresh()` discards it with the pack — no separate invalidation |

### House patterns this must follow

- **Promise-memo, clear-on-reject** — `src/application/primitives/internal/promise-memo.ts`
  (`get` / `peek` / `clear`). Already used twice inside `loadPack` (`offsetTable`, `handleMemo`).
- **Bounded read before parse** — `readBoundedIdx` (`pack-registry.ts:80-93`) stats, then reads,
  then re-checks. The header read needs no bound: it is a fixed 12 bytes.
- **`ctx.logger?.warn?.(message, context)` for a skipped-but-not-fatal condition** — precedents
  `fetch.ts:445` (*"fetch.prune: skipping unsafe ref name"*), `fetch.ts:461`,
  `read-sparse-checkout.ts:69`. The Logger port sanitises and never throws.
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

### Pin H — adjacent per-pack degradation (context for DC-2 and DC-4)

git's "treat this pack as absent" arm is not specific to the version check. Two neighbours,
pinned; the tsgit column is **read off the code, not executed**:

| shape | git 2.55.0 | tsgit today |
|---|---|---|
| `.idx` present, `.pack` **deleted** | `warning: no corresponding .pack: …`, `count-objects -v` reports `packs: 0`, that idx's objects are `missing`, loose reads fine, exit 0 | `loadPack` never touches the `.pack`, so `lookup` returns a hit and the later `offsetTable()`'s `ctx.fs.stat` (`pack-registry.ts:103`) surfaces the adapter's ENOENT mapping to the caller |
| `.idx` filled with garbage | `error: index file … is too small`, loose object still served, exit 0 | `parsePackIndex` throws `INVALID_PACK_INDEX` out of `loadPack` → `scanPacks` → the memoised scan rejects, so **every** read through that `Context` fails |

Neither is caused by this change. Both are the same family, and DC-4 asks how far the new skip
arm should reach.

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
   verbatim. This is not a nicety: under DC-2(a) a divergence between the two sets would not
   raise — it would make every object in a just-fetched pack report as **missing**, which is the
   worst available failure mode. I-8 is the test that forbids it.
4. **Local-open parity with Pin B and Pin C.** A v3 pack in `.git/objects/pack/` reads
   normally. A v99 pack yields git's observable outcome for every row of Pin C: C1 (untouched,
   silent, succeeds), C2 (the good pack serves it), C3/C4 (the object is *missing*, not a
   corrupt-store failure), C5 (no negative cache) — subject to DC-2.
5. **A refused pack never poisons an unrelated read.** Loose objects, other packs, refs, index
   and worktree operations are unaffected (Pin C1, C2).
6. **Generation is unchanged, byte for byte.** `serializePackfile` still emits version 2; the
   `@writes` annotation stays `format: git-packfile-v2`; every existing packfile golden,
   interop and parity expectation passes untouched.
7. **Hash-agnostic in the gate.** No branch on `ctx.hashConfig`; `PACK_HEADER_SIZE = 12` holds
   for SHA-1 and SHA-256 alike, because the header carries no digest (Pin E). The pack
   subsystem's pre-existing SHA-1-only limit (B-5) is neither widened nor narrowed.
8. **No unintended public API change.** `PackHeader`, `parsePackHeader`, `serializePackHeader`
   and `serializePackfile` are public exports recorded in `reports/api.json`; the only permitted
   movement is whatever DC-5 ratifies, and `api.json` is regenerated in the same commit.
9. **The #263 handle lifecycle is untouched.** After `dispose()`, opened-minus-closed handles
   stay 0 for every row of that design's lifecycle matrix; the header gate opens no disposable
   (§D7); `refresh()` and `dispose()` keep their current semantics.
10. **Structured data only.** Nothing in this change returns or composes a rendered line. git's
    stderr text is reconstructed *inside the interop test* from structured fields, per ADR-249.
11. **No swallowed reason.** Wherever the design declines to propagate an error (DC-2(a)), the
    reason reaches `ctx.logger?.warn?.` with the pack name — a decision to not fail, not a
    decision to not know.

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
packfile* (Pin D).

### §D2 — the local-open gate: where it sits

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
      await pack.header();                       // ← git's is_pack_valid (Pin C2/C3/C4)
    } catch (err) {
      if (!isSkippablePackFault(err)) throw err; // ← breadth is DC-4; NOT a blanket catch
      ctx.logger?.warn?.('packRegistry: skipping unusable pack', { pack: pack.name, … });
      continue;                                  // ← DC-2(a)
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
 *  Rejects with INVALID_PACK_HEADER for a bad signature, a short file, or a
 *  version outside 2|3. One read per pack per successful validation. */
readonly header: () => Promise<PackHeader>;
```

built inside `loadPack` as a third `createPromiseMemo`, beside `offsetTable` and `handleMemo`:

```ts
const headerMemo = createPromiseMemo(async () =>
  parsePackHeader(await ctx.fs.readSlice(packPath, 0, PACK_HEADER_SIZE)),
);
```

`ctx.fs.readSlice` — **not** the pack's own `readSlice` — is deliberate; §D7. A short file
returns fewer than 12 bytes and `parsePackHeader`'s existing truncation guard fires, so Pin D's
third row needs no extra code.

**`isSkippablePackFault` is a discriminator, not a blanket catch.** The house precedent is
`isUnsupportedOperation` (`pack-registry.ts:24-30`), whose comment already spells out the rule:
recognise the *expected* fault and let everything else surface, or an `EMFILE` silently becomes
"this pack has no objects". Under DC-4(a) it recognises `INVALID_PACK_HEADER` only; under (b) it
also recognises a failure to open the file. Whatever it does not recognise is re-thrown —
otherwise the guardrail against swallowed errors is broken by exactly the shape it exists to
prevent.

### §D3 — refusal propagation

Under DC-2(a) — the recommendation — `lookup` catches the header rejection, logs, and continues.
That is the `fetch.prune` pattern (`fetch.ts:445`): a condition that must be *known* but must not
*fail*. It is not a swallowed error (requirement 11) — the structured reason is handed to the
Logger port, which sanitises it and cannot throw.

Four interactions to state rather than discover:

- **Partial clone.** A skipped pack turns into `OBJECT_NOT_FOUND`, which `withLazyFetchRetry`
  (`read-object.ts:107-121`) converts into one promisor fetch + one retry. That mirrors what git
  does when an object it cannot reach locally is promised by a remote; and the retry's
  `registry.refresh()` discards the header memos with the pack set, so a re-fetched good pack is
  re-probed rather than remembered as bad.
- **`fetch-missing.ts:57`** uses `registry.lookup` purely as an existence probe. A skipped pack
  therefore makes its objects look absent to `fetchMissing`, which will try to fetch them — the
  same conclusion git reaches (Pin C3), reached the same way.
- **`enumerateObjects` / `fsck --full`.** `enumerate-objects.ts:42-45` reads `registry.all()` and
  walks `pack.index` without ever calling `lookup`, so under DC-1(a) it still *lists* a refused
  pack's object ids; each subsequent `readObject` then misses. git's `fsck` instead reports
  `packfile … cannot be accessed` and sets exit bit 4 (Pin B). Closing that requires the gate to
  also run for `all()` — DC-1's second axis.
- **Log volume.** Because there is no negative cache (C5), a walk over a repo containing a
  refused pack emits one warn per object lookup that hits that pack's index. git prints one
  `error:` line per request for the same reason. Faithful, and loud — named here so it is a
  ratified consequence rather than a surprise.

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

### §D5 — hash-width genericity (explicit checklist)

| question | answer |
|---|---|
| Does the 12-byte header contain a digest? | No — signature(4) + version(4) + count(4). `PACK_HEADER_SIZE = 12` is correct for SHA-1 and SHA-256 alike. |
| Does any part of the gate branch on hash width? | No, and it must not (Pin E: SHA-256 repos also stamp version 2, and git accepts a v3 SHA-256 pack). A reader who assumes "v3 = SHA-256" would write exactly that branch; Pin E exists to forbid it. |
| Where *is* hash width load-bearing? | Only in the **fixtures**. Re-stamping a pack's trailer means digesting `pack[0 .. len − digestLength)` — the tests must take `digestLength` from `ctx.hashConfig` (as `pack-registry.ts:109` already does for `trailerStart`), never a literal 20. |
| Can the matrix include a SHA-256 leg? | **No, and not because of this change.** `IDX_SHA_LENGTH = 20` is hard-coded in the idx **reader** (`pack-index.ts:10`) as well as the writer (`pack-writer.ts:63`), so tsgit's pack subsystem is SHA-1-only end to end (B-5). Pin E is therefore a *constraint on the design* — do not branch on hash — not a test row. Widening the subsystem to SHA-256 is out of scope and would be its own backlog item. |

### §D6 — error semantics

| input, local path | structured outcome (DC-2(a)) | git's observable outcome |
|---|---|---|
| pack v2 / v3, object present | object returned | object returned (Pin B) |
| pack v99, object also elsewhere | object returned from the other source; one logger warn | object returned, one `error:` line (Pin C2) |
| pack v99, object nowhere else | `OBJECT_NOT_FOUND { id }`; one logger warn | `missing` / `fatal: Not a valid object name` (Pin C3, C4) |
| pack v99, object not in its index | nothing happens; pack never opened | nothing happens (Pin C1) |
| pack v99, N lookups hitting its index | N probes, N warns | N `error:` lines (Pin C5) |

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
reason the gate lives in `lookup` rather than wrapping `readSlice` (DC-1(c)). The residual is one
extra microtask per object lookup on a settled memo; if a bench ever attributes anything to it,
the mitigation is a synchronous `validated` flag consulted before the `await` — deliberately not
designed in now, because it trades a measurable nothing for mutable state on a hot path.

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
remote over fetch/clone, a bundle handed to `bundleVerify`, or a `.pack` written into
`.git/objects/pack/` by anything with write access to the repo.

| # | concern | assessment |
|---|---|---|
| T-1 | Widening 2 → 3 admits packs previously refused | **No new parsing surface.** v3 is format-identical to v2 and *no* entry parser branches on version (requirement 1), so the same bytes reach the same `parsePackEntryHeader` / inflate / trailer-verify code that already handles them under version 2. The widening relabels, it does not unlock. Existing ingest bounds are untouched: `maxObjectsPerPack` (`fetch-pack.ts:308-315`), `maxResponseBytes`, `MAX_SIZE_EXTENSION_BYTES`, `MAX_OFS_DISTANCE_BYTES`, `MAX_DELTA_CHAIN_DEPTH`, the compressor's `maxOutputLength`. |
| T-2 | The local gate is a *hardening* | Today a pack stamped with any version is parsed as v2. The value of the gate is exactly the case that does not exist yet: a future real format sharing the `PACK` signature would be **mis-parsed** as v2 rather than refused. Closing that is the security content of this change. |
| T-3 | The gate itself parses hostile bytes | Fixed 12-byte read, fixed-offset `DataView` reads, no allocation keyed off content, no loop. `objectCount` is read but, on the local path, never used to size anything — the `.idx` drives every allocation. (DC-6 would compare it against the idx; a comparison, still no allocation.) |
| T-4 | Skipping a pack is a denial vector | An attacker who can flip one byte in a pack header makes that pack's objects invisible. They could equally corrupt the pack body, and git has the identical property (Pin C3). No new exposure; the logger warn is what keeps it diagnosable. |
| T-5 | Log injection via the pack name | `RegisteredPack.name` is already constrained by `isSafePackName` (no `/`, `\`, `..`) and the Logger wrapper sanitises every string it forwards (`wrapLoggerSanitizer`). |
| T-6 | Symlinked `.pack` | Unchanged: the persistent-handle path uses `openWithNoFollow`; the 12-byte probe uses `ctx.fs.readSlice`, whose node adapter enforces the same root containment as every other read. No new path is constructed — `packPath` is the existing derived value. |

### §D9 — blind spots, named

1. **`registry.all()` consumers bypass the gate** (§D3). Deliberate under DC-1(a), divergent for
   `fsck --full`; DC-1 is where it gets decided.
2. **Browser / memory adapters.** `ctx.fs.readSlice` is a `FileSystem` port method every adapter
   implements — it is already the registry's fallback reader (`pack-registry.ts:132`, `:145`) —
   so the gate needs no adapter work. Worth one parity scenario, not a design branch.
3. **`refresh()` re-probes.** Each refresh discards the header memos with the pack set, so a
   long-lived Context that refreshes N times pays N × 12 bytes per touched pack. Bounded and
   correct: a pack file can be replaced between generations.
4. **The inverted test row.** `pack-entry.test.ts:54-58` currently asserts that version 3 is
   refused. It must flip, not be deleted — the same table gains rows 1 and 4 so the widened
   guard is pinned on both sides (§Test strategy).
5. **Probe order differs from git's.** tsgit checks the delta cache, then loose, then packs
   (`object-resolver.ts:60-73`); git checks packs, then loose. For every row of Pin C the
   observable outcome is the same, but a unit test that "proves laziness" by reading a loose
   object would prove nothing about the gate — it would never reach the registry. §Test strategy
   arranges around this.
6. **The gate's completeness rests on an unenforced invariant.** Under DC-1(a) the gate covers
   every pack-byte read *because* every such read passes through `lookup` first — verified
   today: `offsetTable()` and `readSlice()` are only ever reached from a `PackLookupHit`
   (`object-resolver.ts:265`, `:411`; `blob-source.ts:102`, `:104`; REF_DELTA bases recurse back
   through `resolveObjectBytes` → `lookup`). Nothing *forces* that to stay true. The cheap
   durability measure is a doc-comment on `RegisteredPack.readSlice` / `offsetTable` stating
   that callers must hold a hit from `lookup`; the expensive one is DC-1(c). Naming it here so
   the ADR chooses rather than inherits.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-1** | **Where the local-open gate sits, and whether `all()` is gated too** | **(a)** In `lookup()`, between the `.idx` hit and the returned hit — git's `is_pack_valid` position; `all()` stays ungated. **(b)** Eagerly in `loadPack()` during the `.idx` scan — every pack in the directory validated once per generation, `all()` and `lookup()` consistent. **(c)** At the pack-file touch points — inside `offsetTable()` and the handle memo — so the gate fires on the first byte actually read | **(a)** | (a) reproduces Pin C exactly, including C1 (a bad pack whose index does not claim the object is *never opened* and produces *no* output) — the only alternative that does. (b) diverges from C1 by probing packs git never touches and costs one extra read per pack per scan, but it is the only option that also closes the `fsck --full` gap in §D3 without a second mechanism, so it is a real contender if enumeration parity is valued over open-time parity. (c) is strictly worse than (a): the refusal arrives *after* `lookup` has answered, so converting it into git's "missing" (Pin C3/C4) needs a catch in `object-resolver` too, spreading one policy across two files |
| **DC-2** | **How a refused pack propagates** | **(a) Pack-scoped skip** — `lookup` continues to the next pack; the object resolves as `OBJECT_NOT_FOUND`; the reason goes to `ctx.logger?.warn?.`. **(b) Propagate** the typed `INVALID_PACK_HEADER` out of the read path to the caller. **(c) Hybrid** — skip while another source can serve the object, throw when nothing can | **(a)** | Pin C is unambiguous: git degrades **per pack** and reports the object as *missing*, with the process alive and every other source intact (C2, C3, C4). (b) is a straightforward prime-directive violation — one byte in one pack would turn every unrelated read into a hard failure, which is exactly the shape §Pin H row 2 already shows is wrong for the `.idx` case. (c) has no git analogue: git says `missing` in precisely the case (c) would throw. The cost of (a) is that the reason stops at the logger; requirement 11 and the `fetch.prune` precedent are the mitigation |
| **DC-3** | **Error shape for the local refusal** | **(a)** Reuse `INVALID_PACK_HEADER { reason }` **verbatim** — identical to the ingest path — plus the logger warn. **(b)** Extend the variant to `INVALID_PACK_HEADER { reason, version? }` so the version is machine-readable. **(c)** New `StorageError` variant `UNSUPPORTED_PACK_VERSION { version, packName }` | **(a)** | Under DC-2(a) the error never reaches a caller — it is a log line — so a machine-readable field has no consumer to serve. (a) also keeps one condition with one representation across both paths, which is what makes the twin interop assertions symmetrical. (b) is cheap but adds an optional field nothing reads. (c) is the most expressive and the most expensive: a new code touches `domain/error.ts:187`'s switch, `test/unit/domain/exhaustiveness.ts`, the public `StorageError` union and `reports/api.json` — worth it only if DC-2 lands on (b) or (c), where a caller can actually discriminate |
| **DC-4** | **How wide the skip arm is** | **(a) Header-invalid only** — bad signature, short file, version outside 2\|3. **(b) (a) + pack-file unopenable** — ENOENT/EACCES on the 12-byte probe, which closes §Pin H row 1 (`.idx` with no `.pack`) in the same change. **(c) (b) + corrupt `.idx`** — `parsePackIndex` failures skip the pack instead of rejecting the whole scan, making the registry degrade per-pack like git everywhere | **(b)** | git's `is_pack_valid` returns 0 for *any* failure to open or validate, so (a) leaves a known divergence standing one line away from its fix, and (b) costs a `catch` clause that is already being written. (c) is the honest end state and the largest blast radius: it moves a currently-fatal condition to non-fatal and existing unit tests assert today's reject-the-scan behaviour, so it wants its own ADR and its own commit. (a) is defensible purely on scope discipline |
| **DC-5** | **`PackHeader.version`'s type** | **(a)** Stays `number`. **(b)** Narrows to `2 \| 3`, making "read set = {2,3}" visible in the public type. **(c)** Drops `version` from the returned shape (nothing consumes it) | **(a)** | `PackHeader` is public and recorded in `reports/api.json`, so (b) and (c) are public type changes with report churn — (c) is outright breaking. (b) reads nicely but buys nothing: no consumer narrows on it, and it couples a public type to a git constant that would need a breaking change the day v4 is defined. (a) keeps the change to two lines of guard |
| **DC-6** | **Does the local gate also cross-check `objectCount` against the `.idx`?** | **(a) Header only** — signature + version, as the brief scopes it. **(b) + count** — compare the header's `objectCount` with `pack.index.objectCount`, git's very next check at the same site. **(c) + count + trailer** — also compare the pack's trailing digest with the checksum the `.idx` records, i.e. all of `open_packed_git_1` | **(b)** | The count is already in the 12 bytes being read and the idx count is already parsed (`PackIndex.objectCount`), so (b) is a comparison, not I/O — and a pack/idx count disagreement is exactly the corruption that later makes `nextOffsetForEntry` mis-bound an entry. (c) needs one more `digestLength`-byte read plus exposing the idx's recorded pack checksum (`PackIndex` has `trailerOffset` but no accessor), and its refusal has never been reported as a gap; it is a clean follow-on. (a) is the minimum that satisfies the brief |
| **DC-7** | **Provenance of the v3 / v99 fixtures** | **(a) Crafted in-test**, per tier, from whichever tool owns that tier's baseline — tsgit's `writeSyntheticPack` for unit, real `git repack` for interop — by flipping the u32 BE at offset 4 and re-hashing the trailer with `ctx.hash`. **(b) Committed binary fixtures** under `test/fixtures/`. **(c) Crafted in-test, always from real git**, including in the unit tier | **(a)** | (a) commits no opaque bytes, keeps the mutation visible in the test that depends on it, and keeps each tier's baseline honest — the unit tier proves tsgit's own writer round-trips through the widened guard, the interop tier proves the bytes git actually produces do. (b) freezes a SHA-1 pack into the repo and hides the one manipulation the reader needs to understand. (c) makes the unit tier depend on a git binary, which `GIT_AVAILABLE` then gates out of the default run — the wrong tier for a domain guard |

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
| handle ledger | any of the above | opened-minus-closed handles after `dispose()` is 0 (requirement 9) |

**Scan-order determinism.** C2 only exercises the skip arm if the bad pack is iterated first, and
`scanPacks` iterates raw `ctx.fs.readdir` order (`pack-registry.ts:213-218`). The fixture must
pin that order — name the packs so the bad one sorts first *and* assert the observed order in
the arrangement, rather than assuming the adapter sorts. A C2 that silently degrades into "the
good pack answered first" passes with the gate deleted.

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
| I-4 | local read v99, object nowhere else | `cat-file --batch-check` → `missing`, exit 0 | `OBJECT_NOT_FOUND` (DC-2(a)) |
| I-5 | local read v99 **+ good pack**, object in both | `cat-file -p` returns the payload, exit 0 | `readObject` returns the identical bytes |
| I-6 | v99 pack present, object in a **second good pack** and absent from the bad pack's index | `cat-file -p` succeeds with **no** stderr at all (Pin C1) | `readObject` succeeds. The "bad pack never opened" half of C1 is proved in the unit tier, where a ledger exists; here the assertion is the git-side silence plus tsgit's success |
| I-7 | bundle carrying a v3 pack | `git bundle verify` → `is okay`, exit 0 | `bundleVerify` accepts (B-1's surface) |
| I-8 | round trip | tsgit ingests the v3 pack, then reads an object back out of the repo it just wrote | `git cat-file -p` reads the same object from the same repo (requirement 3a) |

I-4 and I-5 are the pair that makes DC-2 falsifiable: under DC-2(b), I-5 fails. That is the point.

### Parity — cross-adapter

One scenario under `test/parity/scenarios`: read an object through a v3 pack on node, memory and
browser adapters and compare. Per ADR-226 this proves adapter agreement, **not** faithfulness —
the interop table above is the only faithfulness authority. It exists because the header read is
the registry's first use of `ctx.fs.readSlice` on a path that previously never ran on the browser
arm for this purpose.

### Mutation

The widened guard is a dense `EqualityOperator` / `ConditionalExpression` / `LogicalOperator`
target. The sweep above (rows 1 and 4, plus the exact-reason assertion) is designed to kill the
boundary and message mutants directly rather than through a generic `toThrow(TsgitError)`. The
`lookup` gate's `catch`-and-`continue` needs both an "another pack serves it" test (C2) and a
"nothing serves it" test (C3/C4), per the isolated-guard rule — one test exercising both arms
proves neither. The `continue` after the `catch` is its own mutant: C2 is the test that kills it.

### Gates

`npm run validate`. `reports/api.json` is expected to be **unchanged** — the two new constants
are module exports that never reach `src/domain/storage/index.ts` (§D1), so neither typedoc nor
`check:doc-coverage` sees them; the only thing that would move the report is DC-5 landing on (b)
or (c), in which case the regenerated report ships in the same commit.
`tooling/audit-write-surfaces.ts` must stay green with **no** annotation or allowlist edit
(requirement 6).

## Out of scope

- **Generating v3 packs.** Pin F: git never does. §D4.
- **`.idx` version 1**, multi-pack-index, and reverse indexes — none of which tsgit reads today.
- **SHA-256 pack support.** `IDX_SHA_LENGTH = 20` is hard-coded in the idx reader and writer
  (B-5), so the whole pack subsystem is SHA-1-only. Pin E constrains this design (never branch on
  hash) but widening the subsystem is a separate backlog item.
- **The pack-vs-index checksum comparison** (the last check in git's `open_packed_git_1`) unless
  DC-6 lands on (c).
- **Corrupt-`.idx` per-pack degradation** (§Pin H row 2) unless DC-4 lands on (c). It is a real,
  pre-existing divergence and deserves its own ADR — it converts a currently-fatal condition into
  a non-fatal one across the whole registry.
- **A `verifyPack` command surface.** tsgit has no analogue of `git verify-pack`; Pin A records
  its behaviour only to show that all three of git's ingest surfaces agree on 2\|3.
- **Stderr transcript parity.** Per ADR-249, git's `error: packfile … is version 99 …` line is
  presentation. tsgit emits no such line and is not expected to.
