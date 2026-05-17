# Design: Phase 12.2 — Fetch (Network Completion)

**Status: Draft (at `22f0594`)** — Phase 12.2 of the [backlog](../BACKLOG.md).

### Review notes

Three self-review passes were applied to this draft. Each pass tightened the
design instead of adding scope.

**Pass 1 — composition + scope:**

- `fetch` reuses the Phase 12.1 `fetchPack` primitive end-to-end. The new code
  in this phase is: ref discovery, want/have negotiation, shallow handling,
  ref-update transaction, prune. None of those belongs inside `fetchPack` — it
  stays a pure pack-write primitive. See ADR-009 for the location decision on
  shallow.
- `clone({ url, depth })` delegates to the same shallow negotiation code via
  the `fetchPack` extension introduced here. The depth-rejection guard in
  `clone.ts` opens. ADR-008's reopening clause is honored.
- `parseUploadPackResponse` grows a single, additive, opt-in extension:
  consume `shallow <oid>` / `unshallow <oid>` pkt-lines emitted by the server
  BEFORE the ACK/NAK block. The extension is gated on `expectShallow` so the
  Phase 12.1 happy path is unchanged for callers that did not request `deepen`.
- `walkCommits` grows one option, `shallow?: ReadonlySet<ObjectId>`, that
  short-circuits parent enqueue when a commit's id is in the set. The walker
  still emits the shallow commit itself (canonical git behavior: the shallow
  commit is observable but parents past it are not walked).

**Pass 2 — security + correctness:**

- The shallow file `.git/shallow` is written via `atomicWriteRef` (rename
  semantics), not direct write. A partial write that races with a concurrent
  reader (`status`, `log`) would either see the previous content or the new
  content — never a half-written line.
- Ref updates are written through `updateRef` (atomic per-ref). The
  decision in ADR-011 is to write each ref atomically as it is processed
  rather than stage every ref and flip them in one batch — see ADR-011 for
  the trade-off analysis.
- `validateRefName` rejects every path-traversal vector before the loose ref
  hits disk (Phase 3 invariant). No new sanitization is required.
- The SSRF guards already wrap `ctx.transport` via the facade's
  `wrapTransportValidator`. `fetch` does NOT re-validate; the validator runs
  on every `transport.request()`. The integration test passes a resolver
  through `openRepository({ config.dnsResolver: ... })`, matching how clone
  is exercised today.
- `parseShallowResponse` enforces the same `SHA_ANY_RE` (40 or 64 hex chars)
  that `parseAdvertisedRefs` uses, so a malicious server cannot smuggle a
  non-oid token through `shallow <line>`.
- Prune (ADR-012) honors `opts.prune === true` ONLY for remote-tracking refs
  under `refs/remotes/<remote>/*`. Local refs (`refs/heads/*`,
  `refs/tags/*`) are never deleted — the wrong remote advertising fewer refs
  must not lose local work.

**Pass 3 — testability + mutation resistance:**

- `parseShallowResponse` has isolated tests for every guard (no shallow line,
  one shallow + one unshallow, malformed oid, malformed verb, server sends
  shallow after ACK — must be a no-op for that pass).
- The shallow file primitive has isolated read/write/missing-file tests.
- `walkCommits` shallow tests assert: (a) the shallow commit is yielded;
  (b) its parents are NOT yielded; (c) when `shallow` is empty the walker
  behaves exactly as today (regression guard).
- `fetch` happy path uses the same memory-context + fake-transport pattern
  as `clone`. The integration test in `test/integration/network/` mirrors
  `clone-http-backend.test.ts` but seeds an initial pack via `clone` first,
  then runs `fetch` against a 5-commit fixture and asserts:
  - `result.updatedRefs` contains the advanced HEAD branch ref.
  - `refs/remotes/origin/main` now points at the new head.
  - `walkCommits` from the new head yields all 5 commits.
- The shallow integration test sibling clones with `depth: 1`, asserts
  `.git/shallow` exists and contains the shallow commit oid, then walks from
  HEAD and asserts the walker stops at the shallow boundary (one commit
  yielded, no `OBJECT_NOT_FOUND` raised).
- All boundary conditions are pinned by separate tests so Stryker cannot
  silently downgrade them. The depth-N branching ("happy path with shallow
  vs without") is covered by parametrized `it.each` to keep mutation
  signal density high.

---

## 1. Overview

Phase 12.2 closes the fetch-side of the network surface. Today,
`repo.fetch({ remote })`:

1. Looks up the remote URL in `.git/config`.
2. Returns `{ remote, url, updatedRefs: [] }` (stub body).

After Phase 12.2, the same call:

1. Looks up the remote URL.
2. Validates the URL via SSRF guards (facade-tier wrapper — no in-`fetch`
   call).
3. Discovers refs over `git-upload-pack` (smart-HTTP v1).
4. Computes `haves` from the local object graph (every commit reachable from
   `refs/remotes/<remote>/*`, see ADR-010).
5. Sends a `want / have / done` request for the advertised refs that differ
   from `haves`, plus `deepen N` when `opts.depth` is set.
6. Receives the packfile (via the Phase 12.1 `fetchPack` primitive), verifies
   it, writes it under `.git/objects/pack/`.
7. Parses `shallow <oid>` / `unshallow <oid>` pkt-lines if `deepen` was sent
   and writes `.git/shallow` accordingly.
8. Writes each fetched ref under `refs/remotes/<remote>/*` (atomically, one
   `updateRef` per ref — ADR-011).
9. When `opts.prune === true`, deletes any `refs/remotes/<remote>/*` ref the
   server no longer advertises (ADR-012).
10. Returns `FetchResult` with the resolved remote, URL, and a list of every
    ref that was created, advanced, or deleted.

`clone({ url, depth })` re-opens by delegating shallow handling to the same
`fetchPack` extension. The `UNSUPPORTED_OPERATION` guard in `clone.ts`
disappears.

Working-tree materialization remains Phase 13.1 — out of scope.

## 2. Module structure

```
src/
├── application/
│   ├── commands/
│   │   ├── fetch.ts                       # rewritten — stub → real implementation
│   │   └── clone.ts                       # extended — depth delegates to fetchPack
│   └── primitives/
│       ├── fetch-pack.ts                  # extended — shallow params + return
│       ├── shallow-file.ts                # NEW — read/write `.git/shallow`
│       └── walk-commits.ts                # extended — `shallow` option terminates parent walk
├── domain/
│   └── protocol/
│       └── upload-pack.ts                 # extended — parseShallowResponse + opt-in path
test/
├── unit/
│   ├── application/
│   │   ├── commands/fetch.test.ts         # extended — happy path, shallow, prune, ref tx
│   │   └── primitives/
│   │       ├── fetch-pack.test.ts         # extended — deepen + shallow extension
│   │       ├── shallow-file.test.ts       # NEW — read/write
│   │       └── walk-commits.test.ts       # extended — shallow boundary
│   └── domain/protocol/
│       └── upload-pack.test.ts            # extended — parseShallowResponse cases
├── integration/
│   └── network/
│       ├── fetch-http-backend.test.ts     # NEW — fetch happy path over real backend
│       └── fetch-shallow-http-backend.test.ts # NEW — depth:1 leaves valid .git/shallow
└── fixtures/
    └── clone-source/                      # extended — 5-commit chain (was 1 commit)
scripts/
└── regenerate-clone-fixtures.sh           # extended — emit 5 commits + record per-commit oids
docs/
├── adr/
│   ├── 009-fetch-shallow-where.md         # NEW — shallow lives in fetchPack
│   ├── 010-fetch-haves-strategy.md        # NEW — full graph walk, one-round
│   ├── 011-fetch-ref-update-tx.md         # NEW — per-ref atomic write
│   └── 012-fetch-prune-semantics.md       # NEW — prune scoped to refs/remotes/<remote>/*
└── plan/
    └── phase-12-2-fetch.md                # NEW — TDD step sequence
```

No new ports. No new error variants — the new failure modes reuse
`INVALID_REF_LINE` (shallow line malformed) and `UNSUPPORTED_OPERATION`
(server rejects `deepen` — surfaced as a protocol-level error already).

## 3. Types and signatures

### 3.1 `application/primitives/fetch-pack.ts` — extended

```ts
export interface FetchPackInput {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly haves: ReadonlyArray<ObjectId>;
  readonly capabilities: ReadonlyArray<string>;
  readonly url: string;
  readonly progressOp: string;
  /** Shallow clone depth. When set, sends `deepen N` and consumes shallow/unshallow lines. */
  readonly depth?: number;
}

export interface FetchPackResult {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  readonly packSha: string;
  /** Commits the server advertised as new shallow boundaries. Empty when depth is unset. */
  readonly shallow: ReadonlyArray<ObjectId>;
  /** Commits the server advertised as no-longer-shallow (caller deepened past them). */
  readonly unshallow: ReadonlyArray<ObjectId>;
}
```

The Phase 12.1 callers (`clone.ts` without `depth`) see no behavioral change:
`shallow` and `unshallow` are empty arrays when `depth` is undefined. The
`deepen` line is appended to the upload-pack request body by the existing
`buildUploadPackRequest({ depth })` path (which already emits `deepen N` when
`req.depth` is set). The response-parsing side gets the extension below.

### 3.2 `domain/protocol/upload-pack.ts` — `parseShallowResponse`

```ts
export interface ShallowUpdates {
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
}

/**
 * Consume `shallow <oid>` / `unshallow <oid>` pkt-lines emitted by the server
 * BEFORE the ACK/NAK block. The iterator is advanced past every shallow line;
 * the next consumer sees the first non-shallow pkt-line.
 *
 * Returns empty arrays when the next pkt-line is not a shallow update.
 */
export const parseShallowResponse: (iter: AsyncIterator<PktLine>) => Promise<ShallowUpdates>;
```

Wire format:

```
000Cshallow <40-hex-oid>\n
000Eunshallow <40-hex-oid>\n
...
0000               <- delim end of shallow block
<ack/nak block follows>
```

`parseShallowResponse` reads pkt-lines until it sees a non-`shallow` /
non-`unshallow` data line, OR a flush. The protocol spec puts a flush-pkt
at the end of the shallow-response section even when no shallow lines were
emitted; the parser MUST consume that flush so `splitMeta` sees the
ACK/NAK block starting fresh.

When the first non-shallow line is a *data* line (not a flush — protocol
violation on the server side), the parser returns it as a buffered peek so
`splitMeta` resumes correctly. The cleanest way to wire this is to thread
an optional `peeked?: PktLine` argument through `splitMeta` (or to wrap the
iterator in a "one-line pushback" adapter). The implementation step picks
whichever is smaller; both produce identical observable behavior.

The `parseUploadPackResponse` signature grows one optional flag:

```ts
export const parseUploadPackResponse = async (
  source: AsyncIterable<PktLine>,
  options: {
    readonly sideBand: boolean;
    readonly onProgress?: (text: string) => void;
    readonly expectShallow?: boolean;  // NEW
  },
): Promise<UploadPackResponse & { readonly shallow: ReadonlyArray<ObjectId>; readonly unshallow: ReadonlyArray<ObjectId> }>;
```

When `expectShallow === true`, the parser calls `parseShallowResponse` before
`splitMeta`. When `false` or unset, the previous behavior is preserved
exactly. The return shape is widened with optional empty arrays so callers
that don't pass `expectShallow` see the same surface (compile-time
compatible).

### 3.3 `application/primitives/shallow-file.ts`

```ts
/** Read `.git/shallow`. Returns an empty set when the file does not exist. */
export const readShallow: (ctx: Context) => Promise<ReadonlySet<ObjectId>>;

/**
 * Apply a set of shallow / unshallow updates to `.git/shallow`. Writes
 * atomically (rename), deletes the file when the resulting set is empty.
 */
export const updateShallow: (
  ctx: Context,
  updates: { readonly shallow: ReadonlyArray<ObjectId>; readonly unshallow: ReadonlyArray<ObjectId> },
) => Promise<void>;
```

File format: one oid per line, LF-terminated, sorted lexicographically so a
re-read produces a deterministic file. Matches canonical git's `.git/shallow`
exactly.

Atomic write strategy: write to `${gitDir}/shallow.lock` via
`fs.writeExclusive` (rejects if a lock is already held), then `fs.rename`
onto `${gitDir}/shallow`. Mirrors the lock-rename pattern in
`atomicWriteRef` without depending on it (that helper takes a `RefName`,
which `.git/shallow` is not). When the resulting set is empty we `fs.rm`
the file instead of writing an empty payload — matches canonical git.

### 3.4 `application/primitives/walk-commits.ts` — extended

```ts
export interface WalkCommitsOptions {
  readonly from: ReadonlyArray<ObjectId>;
  readonly until?: ReadonlyArray<ObjectId>;
  readonly order?: 'topo' | 'first-parent';
  readonly ignoreMissing?: boolean;
  readonly verifyHash?: boolean;
  /** Commits whose parents must NOT be enqueued. Used for shallow boundaries. */
  readonly shallow?: ReadonlySet<ObjectId>;  // NEW
}
```

`enqueueParents` short-circuits when `commit.id` is in `shallow`. The
commit itself is still yielded — the walker only skips the parent-enqueue.
Callers that want to also skip the shallow commit pass it in `until`.

### 3.5 `application/commands/fetch.ts` — real body

```ts
export interface FetchOptions {
  readonly remote?: string;
  readonly refspecs?: ReadonlyArray<string>;
  readonly prune?: boolean;
  /** Shallow clone depth. Delegates to fetchPack's deepen path. */
  readonly depth?: number;
}

export interface FetchUpdate {
  readonly name: RefName;
  readonly oldId: ObjectId | undefined;
  readonly newId: ObjectId;
}

export interface FetchResult {
  readonly remote: string;
  readonly url: string;
  readonly updatedRefs: ReadonlyArray<FetchUpdate>;
  /** Refs deleted because the server no longer advertises them (prune semantics). */
  readonly prunedRefs: ReadonlyArray<RefName>;
  /** New shallow boundaries written to .git/shallow during this fetch. */
  readonly shallow: ReadonlyArray<ObjectId>;
  /** Commits that crossed the shallow → non-shallow boundary during this fetch. */
  readonly unshallow: ReadonlyArray<ObjectId>;
}
```

Flow:

```ts
export const fetch = async (ctx: Context, opts: FetchOptions = {}): Promise<FetchResult> => {
  await assertRepository(ctx);
  const remoteName = opts.remote ?? 'origin';
  const config = await readConfig(ctx);
  const remote = config.remote?.get(remoteName);
  if (remote?.url === undefined) throw remoteNotConfigured(remoteName);

  ctx.progress.start(FETCH_NEGOTIATE_OP);
  try {
    const transport = withDefaults(ctx, ctx.config?.auth !== undefined ? { auth: ctx.config.auth } : {});
    const advertisement = await discoverRefs(ctx, transport, remote.url);
    if (advertisement.refs.length === 0) throw remoteAdvertisesNoRefs();

    const capabilities = selectCapabilities(advertisement.capabilities);
    const wants = uniqueOids(advertisement.refs);
    const haves = await deriveHaves(ctx, remoteName);

    const packResult = await fetchPack(ctx, transport, {
      wants,
      haves,
      capabilities,
      url: remote.url,
      progressOp: FETCH_WRITE_OBJECTS_OP,
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
    });

    if (packResult.shallow.length > 0 || packResult.unshallow.length > 0) {
      await updateShallow(ctx, {
        shallow: packResult.shallow,
        unshallow: packResult.unshallow,
      });
    }

    const updatedRefs = await applyRemoteRefs(ctx, remoteName, advertisement);
    const prunedRefs = opts.prune === true
      ? await prune(ctx, remoteName, advertisement)
      : [];

    return {
      remote: remoteName,
      url: remote.url,
      updatedRefs,
      prunedRefs,
      shallow: packResult.shallow,
      unshallow: packResult.unshallow,
    };
  } finally {
    ctx.progress.end(FETCH_NEGOTIATE_OP);
  }
};
```

Helpers (private):

- `discoverRefs` — identical body to `clone.ts`'s helper. Extracted in the
  implementation step to `commands/internal/discover-refs.ts` so both
  callers share one copy (avoids the jscpd duplicate-detector tripping).
- `selectCapabilities` — same shape as `clone.ts`'s helper; also extracted
  into the shared internal module.
- `uniqueOids` — already extracted, ditto.
- `deriveHaves` — walks every `refs/remotes/<remote>/*` ref and collects
  every commit reachable from those tips. Capped at `MAX_HAVES = 256`
  recent commits (BFS topo order from the tips, so the cap takes the most
  recent N). The cap keeps the request body bounded for repos with very
  long histories and matches the order-of-magnitude that canonical git
  sends in a single-round negotiation. Duplicates are deduplicated via the
  visited set. See ADR-010.
- `applyRemoteRefs` — for each branch the server advertises, writes a
  remote-tracking ref via `updateRef` (atomic per-ref, ADR-011). Tags are
  written under `refs/tags/<tag>`. Returns the list of `FetchUpdate` rows
  with old and new ids.
- `prune` — diffs `refs/remotes/<remote>/*` on disk against the
  advertisement; deletes refs the server no longer carries via
  `updateRef(..., { delete: true })`. See ADR-012.

### 3.6 `application/commands/clone.ts` — depth re-enabled

The depth-rejection guard becomes:

```ts
// (removed)
// if (opts.depth !== undefined) {
//   throw unsupportedOperation('clone-shallow', ...);
// }
```

The `fetchPack` call grows the `depth` parameter:

```ts
const packResult = await fetchPack(ctx, transport, {
  wants,
  haves: [],
  capabilities,
  url: opts.url,
  progressOp: CLONE_WRITE_OBJECTS_OP,
  ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
});

if (packResult.shallow.length > 0) {
  await updateShallow(ctx, { shallow: packResult.shallow, unshallow: [] });
}
```

Clone never sees `unshallow` (the local repo is empty at this point), so
the `unshallow` list is ignored from clone's caller side — `updateShallow`
still handles a populated `unshallow` correctly, the empty-array clause is
just an optimization.

### 3.7 Capability negotiation policy (fetch)

Mirrors clone exactly per ADR-005:

| Capability            | Behavior                                                            |
|-----------------------|---------------------------------------------------------------------|
| `multi_ack_detailed`  | NOT requested. One-round negotiation (`done: true` first request). |
| `side-band-64k`       | Requested when advertised. Falls back to `side-band`.              |
| `ofs-delta`           | Always requested when advertised.                                  |
| `agent=tsgit/<ver>`   | Always sent.                                                       |
| `no-progress`         | NOT requested.                                                     |
| `include-tag`         | Requested when advertised.                                         |
| `thin-pack`           | NOT requested.                                                     |
| `shallow` / `deepen-*`| Requested when `opts.depth !== undefined`.                         |

### 3.8 Ref layout after a successful fetch

| Server-side ref            | Written under                                       |
|----------------------------|-----------------------------------------------------|
| `refs/heads/<branch>`      | `refs/remotes/<remote>/<branch>`                    |
| `refs/tags/<tag>`          | `refs/tags/<tag>`                                   |
| `HEAD` (advertisement)     | Not propagated. Local HEAD is untouched on fetch.  |

The HEAD-tracked branch (`refs/heads/<branch>`) is NOT advanced — that is
`pull`'s job (out of scope until Phase 17.x). Fetch only updates the
remote-tracking refs and tags, exactly like canonical `git fetch`.

### 3.9 Progress sites and ops

| Op label             | Emitted by         | When                                                |
|----------------------|--------------------|-----------------------------------------------------|
| `fetch:negotiate`    | `fetch.ts`         | Brackets the whole call (start at top, end in finally). |
| `fetch:write-objects`| `fetch-pack.ts`    | Brackets pack draining + on-disk write. Tick every ≥ 64 KiB. |

## 4. Wire format details

Two additions on top of Phase 8's parsing:

### 4.1 The `deepen` request line

Already implemented — `buildUploadPackRequest({ depth: N })` emits
`deepen N\n` after the `want` lines. No change.

### 4.2 Shallow / unshallow response lines

When the request carries `deepen N`, the server's response prefix becomes:

```
000Cshallow <oid>\n         <- one per cut-point in the new shallow set
000Eunshallow <oid>\n       <- one per commit that is no longer shallow
0000                        <- flush, signals end of shallow block
<ack/nak block follows>
<pack body follows>
```

`parseShallowResponse` consumes the lines until the first non-`shallow` /
non-`unshallow` data line, or a flush. The pack-body iterator picks up from
the existing `splitMeta` + `packBodyStream` machinery — no new sideband
path is needed.

A flush pkt before the shallow block is unusual but legal (server advertises
no new shallow boundaries). The parser treats this as
`{ shallow: [], unshallow: [] }` and the caller proceeds to read the
ACK/NAK block.

### 4.3 `.git/shallow` file format

```
<oid>\n
<oid>\n
...
```

Sorted lexicographically. LF-terminated. Empty file ≡ delete the file.

## 5. Failure modes and error mapping

| Failure                                                  | Code                          | Where           |
|----------------------------------------------------------|-------------------------------|-----------------|
| Remote name not in `.git/config`                         | `REMOTE_NOT_CONFIGURED`       | `fetch.ts` (existing) |
| Server returns no refs                                   | `REMOTE_ADVERTISES_NO_REFS`   | `fetch.ts`      |
| Pack failures (trailer, oversize, headers, etc.)         | (Phase 12.1 variants)         | `fetch-pack.ts` |
| Shallow line with non-oid token                          | `INVALID_REF_LINE` (reuse)    | `upload-pack.ts`|
| Shallow line with unknown verb                           | `INVALID_REF_LINE` (reuse)    | `upload-pack.ts`|
| Server ignores `deepen` (no shallow block returned)      | Empty `shallow`/`unshallow`; no error; `.git/shallow` not written. | `fetch-pack.ts` |
| `updateRef` fails partway through                        | Surfaces as-is; partial refs already written remain (ADR-011). | `fetch.ts` |
| Network error / non-2xx HTTP                             | `NETWORK_ERROR` / `HTTP_ERROR`| (existing)      |

No new error variants are added.

## 6. Testing strategy

### 6.1 Unit tests — `test/unit/domain/protocol/upload-pack.test.ts` (extended)

- **No shallow lines:** iterator yields a data line that does not start with
  `shallow ` / `unshallow ` → returns `{ shallow: [], unshallow: [] }` and
  the first line is the next thing the caller reads.
- **One shallow line + one unshallow line + flush:** returns one oid in each
  array. Asserts the iterator advanced past both lines AND past the flush.
- **Flush immediately:** returns empty arrays. Asserts iterator advanced past
  the flush.
- **Malformed oid (`shallow xyz`):** throws `INVALID_REF_LINE` whose `line`
  field matches the raw text.
- **Unknown verb (`shallowish <oid>`):** treats the line as non-shallow and
  returns empty arrays (it's the first data line for the next consumer).
- **Sideband shouldn't affect parsing:** the shallow block is on the
  pkt-line stream BEFORE side-band wrapping. Test asserts that calling
  `parseUploadPackResponse({ sideBand: true, expectShallow: true })` on a
  server response with shallow + side-banded pack returns both shallow oids
  AND the pack body via side-band channel-1.

### 6.2 Unit tests — `test/unit/application/primitives/shallow-file.test.ts`

- **`readShallow` when file missing:** returns an empty Set.
- **`readShallow` with two oids:** returns a Set of the two oids.
- **`readShallow` with trailing newline only:** returns empty Set (parses
  cleanly).
- **`updateShallow` adds new oids:** writes file with sorted lines.
- **`updateShallow` removes via unshallow:** existing oid removed.
- **`updateShallow` removes all → file deleted:** asserts file no longer
  exists.
- **`updateShallow` atomic:** uses `atomicWriteRef`-style rename (asserted
  by inspecting the temp-file behavior via the memory adapter's tracker).
- **Round-trip:** write then read returns the same set.

### 6.3 Unit tests — `test/unit/application/primitives/walk-commits.test.ts` (extended)

- **`shallow` empty → identical to today:** regression guard.
- **Single shallow boundary:** seed = commit B, B.parent = A, `shallow = {B}`.
  Walker yields only B, never reads A.
- **Shallow seed when ignoreMissing=false:** with `shallow = {B}` and A's
  object NOT present on disk, the walker yields B without raising
  `OBJECT_NOT_FOUND` (the parent walk never fires).
- **Shallow set with multiple boundaries:** two seeds, each shallow at its
  own commit; assert both seeds appear and no parents are walked.

### 6.4 Unit tests — `test/unit/application/primitives/fetch-pack.test.ts` (extended)

- **`depth` set, server responds with shallow block:** assert the result's
  `shallow` and `unshallow` arrays match; pack still validates.
- **`depth` set, server omits the shallow block:** assert `shallow` and
  `unshallow` are empty (server refused to deepen).
- **`depth` set with bogus shallow oid:** assert `INVALID_REF_LINE`
  propagates.
- **`depth` unset → no shallow read attempt:** assert the request body does
  NOT contain `deepen` and the parser is called WITHOUT `expectShallow`
  (regression — the Phase 12.1 happy path stays identical).

### 6.5 Unit tests — `test/unit/application/commands/fetch.test.ts` (rewritten)

Existing stub tests stay green:
- `REMOTE_NOT_CONFIGURED` when no remote.
- Resolved URL surfaced on success.

New tests with a fake transport:

- **Happy fetch (no shallow):** seed local repo with two existing commits,
  fake transport advertises a 5-commit chain. Assert:
  - `result.updatedRefs` contains a row whose `name === 'refs/remotes/origin/main'`, `oldId` matches the old tip, `newId` matches the advertised tip.
  - `refs/remotes/origin/main` on disk holds the new tip.
  - The received pack is on disk (`pack-<sha>.pack` + `.idx`).
- **Empty advertisement:** transport returns zero refs. Assert
  `REMOTE_ADVERTISES_NO_REFS`.
- **`haves` derivation:** fake transport echoes the request body back to the
  test. Assert the request contains `have <commit-id>` for every commit
  reachable from `refs/remotes/origin/main` at fetch time. Specifically
  three haves for a 3-commit local history.
- **Prune semantics (`prune: true`):** seed local
  `refs/remotes/origin/feature-x` pointing at a stale oid. Server
  advertises only `main`. Assert `prunedRefs` contains
  `refs/remotes/origin/feature-x` and the loose ref is removed from disk.
- **Prune off (`prune: false` or unset):** same setup as above; assert the
  stale ref is preserved.
- **Shallow fetch (`depth: 1`):** server response carries one shallow oid;
  assert `result.shallow` matches and `.git/shallow` contains that oid.
- **Ref-update transaction (ADR-011):** mock `updateRef` to throw on the
  second of three ref updates. Assert refs already written are NOT rolled
  back; the throw propagates; `result` is undefined.
- **Local refs untouched:** seed `refs/heads/main` and `refs/tags/v0` with
  arbitrary oids. Run fetch. Assert both refs are unchanged after fetch
  completes.
- **`fetch:write-objects` progress:** assert at least one `start` /
  `update`(>0) / `end` triple is emitted with `op === 'fetch:write-objects'`.

### 6.6 Unit tests — `test/unit/application/commands/clone.test.ts` (extended)

- **`depth: 1` accepted:** server advertises 5 commits + sends a shallow
  block; assert clone succeeds and `.git/shallow` contains the shallow oid.
- **No `UNSUPPORTED_OPERATION`:** the prior test that asserted
  `UNSUPPORTED_OPERATION` for `depth` is **deleted** (replaced by the
  shallow-success test above).

### 6.7 Integration tests

- **`test/integration/network/fetch-http-backend.test.ts`:**
  spins a `git-http-backend` over the 5-commit fixture. Clones via the
  Phase 12.1 path, then advances the fixture by appending a commit, then
  runs `fetch`. Asserts:
  - `result.updatedRefs` lists the advanced `refs/remotes/origin/main`.
  - `walkCommits` from the new tip yields 6 commits.
- **`test/integration/network/fetch-shallow-http-backend.test.ts`:**
  spins the same backend, calls `clone({ url, depth: 1 })`. Asserts:
  - `.git/shallow` exists and contains exactly one oid (the HEAD oid).
  - `walkCommits` from HEAD yields exactly one commit (the shallow boundary).
  - No `OBJECT_NOT_FOUND` raised during the walk.

### 6.8 Fixture regeneration

`scripts/regenerate-clone-fixtures.sh` grows to emit a 5-commit chain:

```sh
for i in 1 2 3 4 5; do
  echo "commit-${i}" > "file-${i}.txt"
  git add "file-${i}.txt"
  GIT_AUTHOR_DATE="2026-05-0${i}T00:00:00Z" \
  GIT_COMMITTER_DATE="2026-05-0${i}T00:00:00Z" \
    git commit -m "commit ${i}" --quiet
done
```

`HEAD-oid.txt` continues to record the final HEAD. A new
`HEAD-history.txt` records every commit oid in chronological order so the
integration tests can assert on intermediate boundaries without re-running
the fixture script.

### 6.9 Mutation testing focus

The dense new control flow:

- `parseShallowResponse` — the verb-recognition switch is exactly the kind
  of code Stryker shreds. Each verb gets its own isolated test (CLAUDE.md
  rule).
- `walkCommits` shallow guard — the `if (shallow.has(commit.id)) return;`
  in `enqueueParents` gets two isolated tests (with and without the guard
  hit).
- `updateShallow` — sort order, empty-set-deletes, atomic write all pinned
  by tests.
- `fetch.applyRemoteRefs` — each refspec category (heads, tags, others) has
  its own test.
- `fetch.prune` — the on/off branch plus the "only refs/remotes/<remote>/*"
  scope check.

## 7. Key design decisions (ADR pointers)

Four user-facing choices are settled in dedicated ADRs:

- **ADR-009** — Shallow handling lives in `fetchPack` (generalized) rather
  than in a fetch-specific wrapper. Clone reuses the same code path.
- **ADR-010** — `haves` are derived from a full graph walk over
  `refs/remotes/<remote>/*` tips. One-round negotiation per ADR-005;
  multi-round (`multi_ack_detailed`) is deferred.
- **ADR-011** — Each ref is written atomically as it is processed
  (per-ref `updateRef`). No staging + flip-all transaction; partial state
  on mid-flight failure is the trade-off.
- **ADR-012** — Prune scoped to `refs/remotes/<remote>/*` only. Local
  branches and tags are NEVER deleted by fetch, regardless of `prune`.

## 8. Cross-cutting impact

### 8.1 Dependency-cruiser

No new violations expected. `application/primitives/shallow-file.ts` imports
from `domain/objects/*` and `ports/*` — both allowed. `walk-commits.ts`
already imports from the same surface.

### 8.2 Size-limit

Net new code is ~150 LOC in `fetch.ts`, ~60 LOC in `shallow-file.ts`,
~40 LOC in `parseShallowResponse`, ~30 LOC in `walk-commits.ts` extension,
~30 LOC in `fetch-pack.ts` shallow extension. ~310 LOC total. Gzipped,
~2 KiB. The Core 50 KiB budget absorbs this; no `.size-limit.json` change.

### 8.3 Bundling

`shallow-file` is re-exported via `application/primitives/index.ts`. No
change to the public `index.ts` exports — the primitive is internal.

### 8.4 Spell-check

`unshallow` and `deepen` are added to `cspell.json` if not already present
(likely already there from the Phase 8 transport design).

### 8.5 Internal helper extraction

`discoverRefs`, `selectCapabilities`, `uniqueOids`, and the
`readableStreamToAsyncIterable` helper currently live in both `clone.ts` and
(conceptually) `fetch.ts`. The implementation phase extracts them into
`commands/internal/upload-pack-client.ts` to avoid jscpd flagging the
duplication. Each helper stays <20 lines; the extraction is purely
mechanical.

## 9. Out of scope (explicitly deferred)

- **Working-tree checkout** after fetch — Phase 13.1.
- **`pull` (fetch + merge)** — out of scope; v1.x or v2.0.
- **`refspecs` honored when set** — the `FetchOptions.refspecs` field stays
  on the type but the implementation ignores it (default refspec
  `+refs/heads/*:refs/remotes/<remote>/*` is hardcoded). A future phase
  parses refspecs properly.
- **Multi-round negotiation (`multi_ack_detailed`)** — see ADR-010.
- **Staging + flip-all transactions** — see ADR-011.
- **`fetch.prune.<remote>` config knob** — only the `opts.prune` boolean
  is honored; config-driven prune is deferred.

## 10. Acceptance — back-link to BACKLOG §12.2

> shallow + non-shallow fetch updates `refs/remotes/<remote>/*` and writes
> received objects.

- The non-shallow path is verified by §6.5 happy path + §6.7 fetch
  integration test.
- The shallow path is verified by §6.5 shallow-fetch unit test + §6.7
  shallow integration test (which observes `.git/shallow` on disk and
  the walker terminating at the boundary).
