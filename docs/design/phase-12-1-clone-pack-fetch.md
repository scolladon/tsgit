# Design: Phase 12.1 — Clone Pack Fetch

**Status: Draft (at `1c23aae`)** — Phase 12.1 of the [backlog](../BACKLOG.md).

### Review notes

Three self-review passes were applied to this draft. Each pass tightened the design rather than adding scope.

**Pass 1 — composition + scope:**

- Discovery is already implemented in `domain/protocol/upload-pack.ts` (`buildDiscoveryUrl`, `parseAdvertisedRefs`). The new primitive composes those; it does NOT re-implement them.
- The pack-write loop reuses `serializePackfile` / `serializePackIndex` from `domain/storage/pack-writer.ts`, which were built in Phase 2.8 explicitly so received packs could be written back to disk without going loose-first. The lookup path via `pack-registry` already covers reading these back, so no `readObject` changes are needed.
- The four ADR-worthy choices below are captured separately under `docs/adr/005…008`. The design refers to them; it does not re-litigate.
- `fetch-pack` lives at `application/primitives/` (Tier 2) — clone composes it with discovery, and Phase 12.2 `fetch` will compose it with ls-refs / want-have negotiation. Push uses a separate primitive (`send-pack`, Phase 12.3) — different verb, different request shape.
- The `clone:write-objects` progress site emits per-object ticks but the *update granularity* is byte-bounded (≥ 64 KiB) so a clone of 100 K small objects does not spam the reporter. The site is `pack-write`'s responsibility — `fetch-pack` only emits `clone:negotiate` / `clone:download` (mapped from the existing `clone:discover` op chain).

**Pass 2 — security + transport correctness:**

- SSRF guards (`validateUrl` from `internal/url-validate.ts`) MUST run BEFORE the bootstrap step. The current `clone.ts` already enforces this; the new flow keeps the order: validate → bootstrap → discovery → fetch-pack → write objects → update refs. A malformed URL must not create a `.git` skeleton.
- The pack body is consumed via `parseUploadPackResponse(..., { sideBand: true })`. Side-band channel-1 carries the pack; channel-2 emits progress lines (sanitized by `progress.ts` before reaching the reporter); channel-3 is fatal-by-protocol and surfaces as `SIDEBAND_FATAL`. No new sanitization is needed — the existing pipeline is reused.
- The pack body is **buffered in memory** before validation (see ADR-007). The buffer is bounded by `config.maxResponseBytes` (already in `RepositoryConfig`) with a default of 512 MiB. Beyond that, `PACK_TOO_LARGE` is raised. This matches the existing pack-size cap and avoids unbounded heap growth from a malicious server.
- SHA-1 verification on every received base object: we write the `.pack` + `.idx` to disk, then probe each declared ref via `readObject(verifyHash: true)`. This catches a pack whose entries individually parse but whose object content does not hash to the advertised ref oids. Cheap — only the refs are verified (typically ≤ 30 entries for a small clone), and the loose-vs-pack code path under `readObject` is already integration-tested.
- The pack's own SHA-1 trailer (last 20 bytes of the `.pack` file) is verified before write: the in-memory buffer's last 20 bytes must equal `hash.hashBytes(buffer[0..-20])`. A trailer mismatch throws `INVALID_PACK_HEADER` with a `trailer mismatch` reason (no new error code; reuses the existing storage variant).

**Pass 3 — testability + mutation resistance:**

- Each pack-write step has an isolated test: trailer-mismatch test, oversize-pack test, empty-pack test (server returns `NAK` then a 12-byte header with `0` objects — must still write a valid `.idx`), single-base-only test, ref-delta-only test, ofs-delta-only test, mixed-types test. Per CLAUDE.md "isolated tests for every guard clause".
- The integration test uses a real `git-http-backend` fixture spun from `test/fixtures/clone-source/` (a tiny repo with 1 commit, 1 file). The fixture itself is built once via `scripts/regenerate-clone-fixtures.sh` (matches the Phase 8 fixture pattern). The server is a Node `http.createServer` wrapper that exec's `git-http-backend` and is torn down in `afterAll`. Network operations never reach a third-party host.
- The trailer-mismatch test asserts on `error.data.reason` containing `'trailer'`, not just `toThrow(TsgitError)` (mutation rule).
- The `maxResponseBytes` boundary is pinned by three tests: exactly equal succeeds, one byte over throws `PACK_TOO_LARGE`, one byte under succeeds. Kills `<` vs `<=` mutants.
- Memory tests use the in-memory adapter for fast feedback. The integration test uses the node adapter with a real socket so the transport pipeline (including `withRetry`, sideband, pkt-line decode) is exercised end-to-end.
- Pack-fetch primitive tests use a fake `HttpTransport` that returns a pre-built byte stream (built with the helpers in `test/fixtures/transport/builders.ts`) so they run with zero IO.

---

## 1. Overview

Phase 12.1 closes the clone-side of the network surface. Today, `repo.clone({ url })`:

1. Validates the URL (SSRF guards).
2. Bootstraps an empty `.git` skeleton.
3. Returns a `CloneResult` with `fetchedRefs: []`.

After Phase 12.1, the same call:

1. Validates the URL.
2. Bootstraps the skeleton.
3. Discovers refs over `git-upload-pack` (smart-HTTP v1).
4. Sends a `want / have / done` request for every advertised ref.
5. Receives the packfile, verifies its trailer, writes `.pack` + `.idx` under `.git/objects/pack/`.
6. Writes loose-refs for each fetched ref under `refs/remotes/origin/` (mirror layout for `clone --mirror`-equivalent semantics is deferred; default layout writes under `refs/heads/<branch>` for the HEAD-tracked branch and under `refs/remotes/origin/<branch>` for every other branch).
7. Updates `HEAD` to point at the remote's HEAD (symbolic if the remote reports `symref=HEAD:<ref>`, direct otherwise).
8. Returns `CloneResult` with `head` set to the remote's HEAD ref and `fetchedRefs` populated.

Working-tree materialization (`checkout:materialize`) is Phase 13.1 — out of scope. After clone, the repo is a valid `.git` directory whose `git log` matches the remote's HEAD line, which is exactly the acceptance criterion in `docs/BACKLOG.md` §12.1.

## 2. Module structure

```
src/
├── application/
│   ├── commands/
│   │   └── clone.ts                     # extended — calls fetchPack, writes refs/HEAD
│   └── primitives/
│       └── fetch-pack.ts                # NEW — pack-fetch primitive, shared with Phase 12.2 fetch
test/
├── unit/
│   └── application/
│       ├── commands/clone.test.ts       # extended — pack-fetch happy path + failure modes
│       └── primitives/fetch-pack.test.ts # NEW — unit tests with fake HttpTransport
├── integration/
│   └── network/
│       └── clone-http-backend.test.ts   # NEW — end-to-end against local git-http-backend
└── fixtures/
    └── clone-source/                    # NEW — minimal repo (1 commit, 1 blob) used by the fixture
scripts/
└── regenerate-clone-fixtures.sh         # NEW — rebuilds test/fixtures/clone-source via real git
docs/
├── adr/
│   ├── 005-clone-protocol-v1.md         # NEW — protocol v1 vs v2
│   ├── 006-clone-pack-storage-layout.md # NEW — keep-as-pack vs loose-unpack
│   ├── 007-clone-resume-semantics.md    # NEW — restart-only via withRetry
│   └── 008-clone-defer-shallow.md       # NEW — defer depth: N to Phase 12.2
└── plan/
    └── phase-12-1-clone-pack-fetch.md   # NEW — TDD step sequence
```

No new ports. No new domain types. No new error variants (the new failure modes reuse `INVALID_PACK_HEADER` and `PACK_TOO_LARGE`).

## 3. Types and signatures

### 3.1 `application/primitives/fetch-pack.ts`

```ts
export interface FetchPackInput {
  /** Advertised refs the caller wants. MUST be non-empty. */
  readonly wants: ReadonlyArray<ObjectId>;
  /** Objects the caller already has (negotiation). Empty for clone, populated for fetch. */
  readonly haves: ReadonlyArray<ObjectId>;
  /** Caller-supplied capabilities (intersection of advertised + supported). */
  readonly capabilities: ReadonlyArray<string>;
  /** Base URL of the remote (the same URL passed to clone). */
  readonly url: string;
  /** Progress op label — clone uses 'clone:write-objects', fetch uses 'fetch:write-objects'. */
  readonly progressOp: string;
}

export interface FetchPackResult {
  /** Path to the written `.pack` file inside `.git/objects/pack/`. */
  readonly packPath: string;
  /** Path to the written `.idx` file (same name, `.idx` extension). */
  readonly idxPath: string;
  /** Number of objects in the received pack (from the 12-byte pack header). */
  readonly objectCount: number;
  /** SHA-1 of the pack content (the trailer the server sent, also encoded into the filename). */
  readonly packSha: string;
}

export const fetchPack = async (
  ctx: Context,
  transport: HttpTransport,
  input: FetchPackInput,
): Promise<FetchPackResult>;
```

Internally `fetchPack` performs:

1. Build the upload-pack request via `buildUploadPackRequest({ wants, haves, capabilities, done: true })`.
2. POST it via `ctx.transport` (composed with the network pipeline middleware by the caller — the primitive does NOT re-wrap).
3. Parse the response via `parseUploadPackResponse({ sideBand: 'side-band-64k' ∈ capabilities, onProgress })`.
4. Drain the `packBody` async iterable into a single `Uint8Array`, bounded by `config.maxResponseBytes`.
5. Validate the trailer: last 20 bytes must equal `hash.hashBytes(buffer.subarray(0, -20))`.
6. Parse the 12-byte header to get `objectCount`.
7. Build the `.idx` via `buildPackIndex(buffer)` — see §3.2.
8. Write `pack-<sha>.pack` and `pack-<sha>.idx` to `.git/objects/pack/` via `writeExclusive`.
9. Return `FetchPackResult`.

Progress events:

- `start(progressOp, totalBytes?)` once the side-band header is detected (totalBytes unknown — server doesn't advertise pack size).
- `update(progressOp, currentBytes)` every ≥ 65 536 bytes received.
- `end(progressOp)` after the `.idx` is written.

The reporter's `text` field carries the sanitized channel-2 message when the server emits one ("Counting objects: 5, done.", etc.).

### 3.2 Pack index construction from a received pack

The received pack is a sequence of zlib-compressed entries. To build an `.idx`, we need each entry's `crc32` (over the on-disk bytes) and `offset` (from the start of the pack file). The existing `serializePackIndex` already accepts `PackIndexWriterEntry[]` — we just need to walk the pack and collect those entries plus each entry's resolved object-id.

Pack-walking is implemented as a single forward sweep starting at offset 12 (past the header). For each entry:

1. `parsePackEntryHeader(buffer, offset, hashConfig)` returns `{ type, size, dataOffset, ...delta-fields }`.
2. `compressor.streamInflate(buffer.subarray(dataOffset), 0)` returns the uncompressed payload plus the consumed compressed length. Entry's compressed end is `dataOffset + consumed`.
3. `crc32(buffer.subarray(offset, end))` is the entry CRC.
4. Resolve the object id:
   - For base entries (commit/tree/blob/tag): `id = hash.hashHex(serializeObject(parseObject(typeName, payload, hashConfig), hashConfig))`. The on-the-fly parse/serialize round-trips through the same code path that `writeObject` uses, so the computed id matches whatever a future `readObject` would compute.
   - For `OFS_DELTA`: resolve the base by following `baseDistance` back to a previously-walked offset, then `applyDelta(base, payload)` and hash.
   - For `REF_DELTA`: resolve the base by `baseId` from the running id→content map (or, if the base is not yet seen — out-of-order REF_DELTA — defer the entry, see §3.3).

A `Map<number, { id, content, type }>` tracks resolved entries by offset (for OFS_DELTA) and `Map<ObjectId, ...>` tracks them by id (for REF_DELTA).

### 3.3 Out-of-order REF_DELTA handling

Real packs sometimes ship REF_DELTA entries whose base appears later in the pack ("thin packs" are explicitly forbidden by `no-thin` capability, but legitimate packs may still have out-of-order entries). The walker handles this with a single deferred-entry queue:

1. First pass — walk every entry. If a REF_DELTA's base is not yet resolved, push the entry into `deferred[]` along with its byte offset and parsed header.
2. Second pass — repeat over `deferred[]` until it is empty or no progress is made. If no progress is made, throw `INVALID_PACK_HEADER` with reason `unresolved REF_DELTA: <oid>`.

The second pass terminates because each iteration either resolves at least one entry or exits, and the resolution map only grows.

### 3.4 Pack write to disk

Pack and idx files are named `pack-<packSha>.pack` and `pack-<packSha>.idx`, where `packSha` is the trailer SHA (the canonical name real git uses). Writing uses `writeExclusive` to refuse to overwrite an existing pack with the same SHA — a re-clone over an existing repo would have errored earlier at the `TARGET_DIRECTORY_NOT_EMPTY` gate, so a FILE_EXISTS here indicates an internal bug and surfaces as such.

Both writes go to `${gitDir}/objects/pack/` which `bootstrapRepository` already creates.

### 3.5 `application/commands/clone.ts` — extended

```ts
export const clone = async (ctx: Context, opts: CloneOptions): Promise<CloneResult> => {
  if (await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)) {
    throw targetDirectoryNotEmpty(ctx.layout.workDir as FilePath);
  }
  if (opts.url === '') throw remoteAdvertisesNoRefs();
  if (opts.depth !== undefined) {
    throw unsupportedOperation('clone-shallow', 'depth: N is supported in Phase 12.2 (fetch)');
  }

  ctx.progress.start(CLONE_DISCOVER_OP);
  try {
    if (opts.resolver !== undefined) {
      await validateUrl(opts.url, { /* same as today */ });
    }
    const bootstrap = await bootstrapRepository(ctx, { /* same as today */ });

    // The facade (Phase 10 §6.2) only wraps ctx.transport with the SSRF
    // validator. Auth/retry/logging are command-tier concerns, composed here.
    const transport = withDefaults(ctx, {
      auth: ctx.config?.auth,
      logger: ctx.logger,
    });
    const advertisement = await discoverRefs(ctx, transport, opts.url);
    if (advertisement.refs.length === 0) throw remoteAdvertisesNoRefs();

    const negotiated = negotiateCapabilities(advertisement.capabilities);
    const wants = advertisement.refs.map((r) => r.id);

    const packResult = await fetchPack(ctx, transport, {
      wants,
      haves: [],
      capabilities: negotiated,
      url: opts.url,
      progressOp: CLONE_WRITE_OBJECTS_OP,
    });

    const refUpdates = await writeFetchedRefs(ctx, advertisement, bootstrap.initialBranch);
    const head = await applyRemoteHead(ctx, advertisement, bootstrap.initialBranch);

    return { path: bootstrap.gitDir, head, fetchedRefs: refUpdates };
  } finally {
    ctx.progress.end(CLONE_DISCOVER_OP);
  }
};
```

`discoverRefs`, `negotiateCapabilities`, `writeFetchedRefs`, `applyRemoteHead` live inside `clone.ts` as small private helpers (each <20 lines). They are not exported because `fetch` (Phase 12.2) and `push` (Phase 12.3) want different ref-layout policies.

### 3.6 Capability negotiation policy

The intersection of server-advertised and tsgit-supported capabilities:

| Capability | Behavior |
|------------|----------|
| `multi_ack_detailed` | NOT requested. v1 single-round negotiation only — we send all wants and `done` in one POST. |
| `side-band-64k` | Requested when advertised. Falls back to `side-band` (4 KiB) if only that is advertised. Falls back to no side-band if neither. |
| `ofs-delta` | Always requested when advertised. Servers will emit OFS_DELTAs in the pack; the resolver already handles them. |
| `agent=tsgit/<version>` | Always sent (one slot; agent string is rebuilt at module load — see Phase 8 design). |
| `no-progress` | NOT requested. We want the channel-2 progress lines for the reporter. |
| `include-tag` | Requested when advertised so the server includes peeled tag objects. |
| `thin-pack` | NOT requested. Thin packs require post-fetch fix-up (write missing bases) which adds scope. v1.0 takes the bandwidth penalty. |
| `shallow` / `deepen-*` | NOT requested in Phase 12.1 (see ADR-008). |

### 3.7 Ref layout after a successful clone

| Server-side ref | Written under |
|-----------------|---------------|
| `HEAD` (symbolic, e.g., `ref: refs/heads/main`) | `${gitDir}/HEAD` (symbolic ref to `refs/heads/<branch>`) AND `${gitDir}/refs/heads/<branch>` (loose ref to the HEAD oid). The tracked branch matches the remote's HEAD line. |
| `HEAD` (direct, detached) | `${gitDir}/HEAD` (direct ref to the oid). The bootstrap's `initialBranch` is left untouched but not pointed at by any ref. |
| `refs/heads/<branch>` | `${gitDir}/refs/remotes/origin/<branch>` for every branch the remote advertises (including the HEAD-tracked branch — `refs/remotes/origin/<HEAD-branch>` is written in addition to `refs/heads/<HEAD-branch>`). |
| `refs/tags/<tag>` | `${gitDir}/refs/tags/<tag>` (always loose; no packed-refs writer in v1.0). |
| Any other ref (`refs/notes/*`, etc.) | Skipped. Logged via `ctx.logger` if present. |

This matches `git clone <url>`'s default behavior. `--mirror` and `--bare`-mode ref layouts are out of scope; the existing `opts.bare` flag still bootstraps a bare layout but the ref-writer policy is the same.

### 3.8 Progress sites and ops

| Op label | Emitted by | When |
|----------|------------|------|
| `clone:discover` | `clone.ts` (existing) | Brackets the whole call (start at top, end in finally). |
| `clone:negotiate` | `clone.ts` (new) | Brackets the upload-pack POST. `start` after building the request, `end` after the response headers are read. |
| `clone:write-objects` | `fetch-pack.ts` (new) | Brackets pack draining + on-disk write. `update` every ≥ 64 KiB received with `current = bytesReceived`. |
| `clone:checkout-files` | NOT emitted (Phase 13.1). |

## 4. Wire format details

No new wire-format parsing is introduced — Phase 8 already covers pkt-line, side-band, ack/nak, capabilities. The new code consumes the existing `UploadPackResponse.packBody` iterable and processes raw pack bytes.

The received pack bytes match the on-disk `.pack` format byte-for-byte:

```
[ 4 bytes magic "PACK" ]
[ 4 bytes version (== 2) ]
[ 4 bytes object count ]
[ N entries, each: variable-length header + zlib stream ]
[ 20 bytes SHA-1 of all bytes above ]
```

The trailer SHA is the canonical "pack id". Writing the pack to disk is `fs.writeExclusive('.git/objects/pack/pack-<trailer>.pack', buffer)`. The `.idx` is built from the walked entries (see §3.2) and written with the same prefix.

## 5. Failure modes and error mapping

| Failure | Code | Where |
|---------|------|-------|
| Server returns no refs in advertisement | `REMOTE_ADVERTISES_NO_REFS` | `clone.ts` (existing) |
| Pack body exceeds `maxResponseBytes` | `PACK_TOO_LARGE` | `fetch-pack.ts` (existing variant) |
| Pack trailer SHA mismatch | `INVALID_PACK_HEADER` (reason: `trailer mismatch`) | `fetch-pack.ts` (existing variant) |
| Pack header magic ≠ `PACK` | `INVALID_PACK_HEADER` (reason: existing message) | `pack-entry.ts` (existing) |
| REF_DELTA with no resolvable base | `INVALID_PACK_HEADER` (reason: `unresolved REF_DELTA: <oid>`) | `fetch-pack.ts` |
| Object oid mismatch on post-write verification of an advertised ref | `OBJECT_HASH_MISMATCH` | `readObject` (existing) |
| Network error / non-2xx HTTP | `NETWORK_ERROR` / `HTTP_ERROR` | `transport` (existing) |
| Caller requested `depth: N` | `UNSUPPORTED_OPERATION` (reason: `depth: N is supported in Phase 12.2`) | `clone.ts` |
| Mid-stream EOF | propagates as `PKT_TRUNCATED` from `pkt-line.ts` decoder, OR `INVALID_PACK_HEADER (truncated)` from the pack walker | `pkt-line.ts` / `pack-entry.ts` (existing) |

No new error variants are added in this phase.

## 6. Testing strategy

### 6.1 Unit tests — `test/unit/application/primitives/fetch-pack.test.ts`

The primitive is tested against a fake `HttpTransport` whose `request` returns a `Response` whose body is a `ReadableStream<Uint8Array>` built from the helpers in `test/fixtures/transport/builders.ts`.

Each test is one of:

- **Happy path:** server returns a side-band-1 pack of 3 entries (1 commit, 1 tree, 1 blob). Assert the `.pack` and `.idx` are written with the correct filenames; assert the trailer SHA matches the server's; assert `objectCount === 3`.
- **Trailer mismatch:** corrupt the last byte of the pack. Assert `INVALID_PACK_HEADER` with `reason` containing `trailer`.
- **Oversize pack:** caller's `config.maxResponseBytes = 100`. Server returns a 200-byte pack. Assert `PACK_TOO_LARGE` with `limit: 100`.
- **Boundary — exactly at the cap:** `maxResponseBytes` equal to the pack size succeeds.
- **Boundary — one over:** `maxResponseBytes` one byte less than the pack size throws `PACK_TOO_LARGE`.
- **OFS_DELTA chain:** server returns a pack with a base + an OFS_DELTA whose base is the prior entry. Assert the resolved object's oid matches expectations.
- **REF_DELTA out-of-order:** server returns a pack where a REF_DELTA precedes its base. Assert the resolver completes via the deferred-entry pass.
- **REF_DELTA unresolvable:** server returns a REF_DELTA whose base is not in the pack. Assert `INVALID_PACK_HEADER` with `unresolved REF_DELTA`.
- **No side-band:** server doesn't advertise side-band capability. Pack bytes arrive in raw pkt-lines. Assert the same `.pack` + `.idx` are produced.
- **Progress ticks:** assert that `update` fires at least once for a 200 KiB pack and that intervals are ≥ 64 KiB.
- **Progress text:** server emits channel-2 "Counting objects: 5, done." — assert reporter received the sanitized text in the `text` slot.
- **Empty pack:** server returns a 32-byte file (12-byte header with `objectCount = 0` + 20-byte trailer). Assert the `.idx` is written with zero entries. The expected trailer is computed inside the test from the header bytes (`hash.hashBytes(header)`); no hardcoded canonical SHA so SHA-256-mode runs trivially extend the same test.

### 6.2 Unit tests — `test/unit/application/commands/clone.test.ts` (extended)

The existing two tests (`bootstraps`, `targetDirectoryNotEmpty`) stay green. New tests:

- **Full clone happy path (mock transport):** fake transport returns canned discovery + upload-pack response. Assert:
  - `result.head === 'refs/heads/main'` (or whatever the fixture HEAD is).
  - `result.fetchedRefs` contains every advertised ref.
  - `.git/objects/pack/pack-<sha>.pack` and `.idx` exist.
  - `${gitDir}/HEAD` points at `refs/heads/main`.
  - `${gitDir}/refs/heads/main` contains the HEAD oid.
  - `${gitDir}/refs/remotes/origin/<branch>` contains the corresponding oid for every non-HEAD branch.
- **No refs advertised:** server returns a discovery with zero refs. Assert `REMOTE_ADVERTISES_NO_REFS`. (Already tested; extended to assert that the pack is NOT fetched.)
- **`depth: 1` rejected:** assert `UNSUPPORTED_OPERATION` with reason mentioning `depth`.
- **Bootstrap rollback on pack-fetch failure:** server returns an unparseable pack. Assert the partial `.git` skeleton is removed (matches the bootstrap rollback semantics).

### 6.3 Integration test — `test/integration/network/clone-http-backend.test.ts`

Spins a local `git-http-backend` over a Node `http.createServer` listening on `127.0.0.1:0` (ephemeral port). The server's `GIT_PROJECT_ROOT` is `test/fixtures/clone-source/`, which contains a tiny pre-built bare repo.

The test:

1. Starts the server in `beforeAll`.
2. Calls `clone({ url: 'http://127.0.0.1:<port>/source.git', allowInsecure: true, allowPrivateNetworks: true, resolver: () => Promise.resolve(['127.0.0.1']) })`.
3. Asserts `result.head === 'refs/heads/main'`.
4. Opens the resulting repo, walks commits, and asserts the first commit's oid matches the fixture's HEAD oid (computed once at fixture-generation time, stored in `test/fixtures/clone-source/HEAD-oid.txt`).
5. Tears down the server in `afterAll`.

The test is gated on `git --version` being available in `$PATH` (skipped otherwise with a clear `it.skipIf` reason). CI runners (Ubuntu, macOS) have git pre-installed; Windows runners are excluded from the integration matrix (already a known Phase 14.4 gap).

### 6.4 Fixture script — `scripts/regenerate-clone-fixtures.sh`

```sh
#!/usr/bin/env bash
set -euo pipefail
# Rebuild test/fixtures/clone-source/source.git from a deterministic commit.
ROOT="$(git rev-parse --show-toplevel)"
DEST="$ROOT/test/fixtures/clone-source"
rm -rf "$DEST"
mkdir -p "$DEST/work"
( cd "$DEST/work"
  git init --initial-branch=main --quiet
  git config user.email "fixture@tsgit.invalid"
  git config user.name  "tsgit fixture"
  echo "hello, clone fixture" > README.md
  git add README.md
  GIT_AUTHOR_DATE='2026-05-01T00:00:00Z' GIT_COMMITTER_DATE='2026-05-01T00:00:00Z' \
    git commit -m "initial" --quiet
)
git clone --bare "$DEST/work" "$DEST/source.git" --quiet
git -C "$DEST/source.git" rev-parse HEAD > "$DEST/HEAD-oid.txt"
rm -rf "$DEST/work"
echo "fixture rebuilt: $DEST/source.git, HEAD = $(cat "$DEST/HEAD-oid.txt")"
```

The script is committed; the generated `source.git` and `HEAD-oid.txt` are also committed (small — ~1 KB total) so CI doesn't need to regenerate.

### 6.5 Mutation testing focus

`fetch-pack.ts` is the densest control-flow per byte (pack walker, deferred queue, trailer check, oversize check). Target 100% killed mutants on it. The integration test does not contribute to mutation kills (Stryker excludes integration tests); the unit tests must carry the full kill burden.

Specific mutant-resistant patterns:

- Trailer comparison uses byte-by-byte equality, not `toString('hex')` comparison — kills the "swap === for !==" mutant directly on the byte array.
- Loop termination conditions are tested at the boundary: 0 entries, 1 entry, 2 entries (kills `< vs <=` mutants).
- `maxResponseBytes` boundary tests as listed in §6.1.

## 7. Key design decisions (ADR pointers)

The four user-facing choices are settled in dedicated ADRs:

- **ADR-005** — Smart-HTTP v1 (not v2). Keeps Phase 12.1 scoped; defers v2 to a later optimization.
- **ADR-006** — Keep received packs as-is (`.pack` + `.idx`) instead of unpacking to loose. Matches real git and the existing `pack-registry`.
- **ADR-007** — Restart on mid-stream failure via the existing `withRetry` middleware. No Range-resume. Pack body is buffered in memory bounded by `config.maxResponseBytes`.
- **ADR-008** — Defer `depth: N` (shallow clone) to Phase 12.2. The `CloneOptions.depth` field is preserved on the type but throws `UNSUPPORTED_OPERATION` in Phase 12.1.

Each ADR lives under `docs/adr/` and is committed before the implementation begins, per the CLAUDE.md rule.

## 8. Cross-cutting impact

### 8.1 Dependency-cruiser

No new violations expected. `application/primitives/fetch-pack.ts` may import from:

- `domain/protocol/*` (already allowed for upload-pack helpers)
- `domain/storage/*` (already allowed for pack writer / pack entry parser)
- `domain/objects/*` (already allowed)
- `ports/*` (already allowed)

The existing rule `application/primitives → !application/commands` keeps the primitive reusable from `fetch.ts` / `push.ts` later.

### 8.2 Size-limit

The pack walker uses existing helpers (`parsePackEntryHeader`, `applyDelta`, `serializePackIndex`). Net new code is ~250 LOC in `fetch-pack.ts` and ~80 LOC of helpers in `clone.ts`. Gzipped, ~1.5 KiB. The Core 50 KiB budget absorbs this; no `.size-limit.json` change needed.

### 8.3 Bundling

`fetch-pack` is re-exported from `application/primitives/index.ts` so the Phase 12.2 `fetch` command can import it. No change to public exports — the primitive is internal-only (per `package.json#exports` policy).

### 8.4 Spell-check

`cspell.json` may need entries for `OFS`, `pkt`, `upload-pack`, `git-upload-pack` if not already present (likely already there from Phase 8). Verified during implementation.

## 9. Out of scope (explicitly deferred)

- **Working-tree checkout** after clone — Phase 13.1.
- **Shallow clone** (`depth: N`) — Phase 12.2 (see ADR-008).
- **Smart-HTTP v2** — future optimization (see ADR-005).
- **Range-resume on mid-stream failure** — see ADR-007.
- **`--mirror` and `--single-branch` ref layouts** — out of scope; default layout only.
- **`--filter=blob:none` (partial clone)** — Phase 17.4 (v2.0).
- **`--recurse-submodules`** — Phase 17.5 (v2.0).
- **Streaming the received pack to a temp file instead of in-memory buffer** — future optimization for "medium" / "large" benchmark scenarios.

## 10. Acceptance — back-link to BACKLOG §12.1

> `repo.clone({ url })` against a real `git-upload-pack` endpoint produces a working repo whose `git log` matches the remote's HEAD line.

The integration test in §6.3 verifies exactly this property by walking the cloned repo's commit graph from `HEAD` and asserting the first commit oid matches the fixture's `HEAD-oid.txt`. The unit tests cover the negative space (failure modes, boundary conditions) that the integration test cannot reach without provisioning adversarial servers.
