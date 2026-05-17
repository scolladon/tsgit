# Design: Phase 12.3 — Push (Network Completion)

**Status: Draft (at `d7ecbac`)** — Phase 12.3 of the [backlog](../BACKLOG.md).

### Review notes

Three self-review passes shaped this draft. Each pass tightened scope rather
than widened it.

**Pass 1 — composition + scope:**

- `push` reuses the Phase 12.1/12.2 `discoverRefs` helper (renamed and
  parameterised by service in `internal/refs-discovery.ts`) and reuses every
  Phase 9 protocol primitive (`buildReceivePackRequest`, `parseReceivePackResponse`,
  `parseSideBand`). The phase introduces one new pack-write primitive
  (`buildPack`), one new traversal primitive (`enumeratePushObjects`), and a
  refspec parser. The push command body itself is the orchestrator.
- We send a **non-thin, no-delta v1 pack**. Every object is encoded as a
  base entry (type 1–4) with `deflate`-compressed canonical content. Delta
  compression is deferred (see [ADR-013](../adr/013-push-pack-encoding.md)).
- Refspec parsing supports the v1 subset: `src:dst`, `+src:dst`, `:dst`
  (delete), `HEAD`, and a short branch name resolving to `refs/heads/<name>:refs/heads/<name>`.
  Globs (`refs/heads/*:refs/heads/*`) are deferred. See
  [ADR-014](../adr/014-push-refspec-scope.md).
- Force-with-lease accepts `ObjectId | 'auto'`. `'auto'` reads the cached
  remote-tracking ref (`refs/remotes/<remote>/<branch>`). The lease is
  compared against the server's advertised current oid before the pack is
  sent. See [ADR-015](../adr/015-push-force-with-lease.md).
- Ref-update transaction: send the `atomic` capability when advertised; if
  the server reports a per-ref `ng` line in atomic mode every update is
  rolled back server-side. Without `atomic`, partial success is possible.
  See [ADR-016](../adr/016-push-atomic-tx.md).

**Pass 2 — security + correctness:**

- Path traversal on advertised ref names: `discoverReceivePackRefs` returns
  raw strings. The push command does **not** write these to disk except for
  the explicit cache-update at the end (`refs/remotes/<remote>/<branch>`),
  which goes through `validateRefName` first. Any ref name received from
  the server is *only* consulted as a key in a `Map<string, ObjectId>`; the
  string never reaches a filesystem path without `validateRefName`.
- `HEAD` resolution on the local side: when the user supplies no refspecs,
  `push` reads `.git/HEAD`. If detached → throw `INVALID_OPTION` with
  reason `'no-default-refspec'` so the caller knows to supply explicit
  refspecs. If symbolic to `refs/heads/<branch>` → default refspec is
  `refs/heads/<branch>:refs/heads/<branch>`.
- Annotated tags: a tag object's oid in a refspec dst causes the closure
  to include the tag object, then follow its `object` field to the
  commit, then walk that commit's tree. Lightweight tags reduce to a
  commit refspec and need no special handling.
- Tree closure pragmatism: we walk every new commit's tree without
  subtracting "trees already present on the server". The server's
  `receive-pack` accepts duplicate objects without error (canonical
  behaviour); the wasted bytes are bounded by the closure of the new
  commits' trees. Worst case: a clean rebase that rewrites every commit
  but keeps the same trees re-sends those trees. Acceptable for v1; a
  smart-pack walker that intersects the haves closure is deferred.
- Force-with-lease for tag pushes: `'auto'` resolves only when dst is
  under `refs/heads/`. For `refs/tags/*` the user MUST supply an explicit
  oid; otherwise `INVALID_OPTION` with reason `'lease-on-non-branch'`.
- Pack-output cap: `buildPack` enforces `ctx.config?.maxPushObjects ??
  DEFAULT_MAX_PUSH_OBJECTS` (1_000_000). Pre-flight the count, throw
  `PACK_TOO_LARGE` if exceeded. Aborting before pack assembly avoids a
  client-side OOM when the user accidentally pushes from a giant
  enumeration window.
- SSRF: the transport port already wraps validation via
  `wrapTransportValidator` at the facade tier. `push` reuses the wrapped
  transport — no re-validation, no bypass surface.
- Pack body hash: `buildPack` computes the SHA-1 trailer the same way
  `fetchPack` verifies it on receipt. Both client and server checksum the
  pack body so a flipped bit yields a hard fail rather than a silent
  corruption.
- Force protection: when `force: false` and the refspec is non-additive
  (i.e. `oldId !== ancestor of newId`), `push` rejects the update before
  send. The ancestor check uses `walkCommits({ until: [oldId] })` — if we
  reach the empty queue without yielding `oldId`, the update is
  non-fast-forward, throw `NON_FAST_FORWARD`.
- Force-with-lease: every refspec carrying a `forceWithLease` is checked
  against the server's advertisement *before* the pack send. A lease
  mismatch throws `PUSH_REJECTED` with reason `'lease-mismatch'` and the
  pack is not transmitted.
- Capability filtering: only intersect the supported subset
  (`report-status`, `side-band-64k`, `ofs-delta`, `atomic`, `delete-refs`,
  `agent`). Unrecognised server-advertised capabilities are dropped before
  echoing back, so a malicious server cannot trick us into echoing a
  capability we don't honour.

**Pass 3 — testability + mutation resistance:**

Pass 3 deltas pulled in from the second self-review pass:

- The `isAncestor(needle, haystack)` predicate is a thin wrapper around
  `walkCommits({ from: [haystack], until: [needle] })`. The walker stops at
  `needle` (without yielding it), so we observe ancestry by re-checking:
  if a fresh `walkCommits({ from: [haystack] })` would have yielded
  `needle` but the bounded walk does not, then `needle` is an ancestor.
  Implementation: `for await (c of walkCommits({ from: [haystack] })) if
  (c.id === needle) return true; return false`. Linear in haystack-side
  reachability — bounded by the closure of the local branch tip, which is
  the only path that needs the answer.
- Per-ref `ng` is reported as `PushedRef.status = 'rejected'`. It does
  **not** throw. `unpackOk: false`, by contrast, does throw because no
  per-ref state survives an unpack failure — the entire push is rolled
  back server-side. This contract is pinned by two separate integration
  tests: one with a pre-receive hook that says `ng`, one with a malformed
  pack body that triggers `unpack`.
- `parseRefspec` exhaustiveness: every malformed input (empty input,
  double `+`, empty `dst`, empty after `:`, `HEAD` on the wrong side)
  has a one-line `it.each` case. The mutant target is the conditional
  ordering inside the parser; isolated tests pin each branch.

- Every wire-format builder/parser has a round-trip test:
  `parseRefspec('+main:refs/heads/main')` round-trips byte-equal through
  `formatRefspec`. The non-trivial branches (force/delete/short) are
  parametrised so Stryker mutation cannot silently flip them.
- `buildPack` has a corpus test against a sample pack produced by canonical
  git: read the canonical pack, decode entries, build them back the same
  way, assert the SHA-1 trailer matches. This single test pins the entire
  encoding pipeline (header → entry headers → deflate-content → trailer).
- `enumeratePushObjects` has separated tests for: empty haves (full
  closure), single haves intersection, multiple haves, stop-at-haves
  boundary, tag (annotated) inclusion. The "stop at haves" branch needs
  a dedicated test because the `walkCommits.until` parameter and the
  tree-closure traversal both need to honour the boundary independently.
- Force-with-lease: three tests pin (a) `force: true` skips the lease
  check; (b) `forceWithLease: 'auto'` reads the remote-tracking ref
  correctly; (c) lease mismatch throws before the POST is issued.
- Sideband sanitization: `progress.update` receives only sanitized text
  (the same `sanitize()` helper used by fetchPack). A test feeds a
  malicious progress payload (`\x1b[2J`) and asserts the reporter receives
  the sanitised form.
- The push integration test against a real `git-http-backend` is the
  single source of truth that the wire format matches reality. It pushes a
  3-commit branch, asserts the server's `refs/heads/main` now points at
  the new head, then pushes again with no new objects and asserts the
  zero-objects path (`pushedRefs[0].status === 'ok'`).

---

## 1. Context

The Phase 11 stub for `push` resolves the remote URL and returns an empty
`pushedRefs` array. Phase 12.3 replaces that body with the real
upload+receive-pack loop:

1. Resolve remote URL via `.git/config`.
2. Parse user-supplied refspecs (or default to the current branch).
3. Discover the remote's refs via `git-receive-pack` info/refs.
4. For each refspec: resolve the local source oid; validate against the
   server's advertised remote oid (force-with-lease, non-FF guard).
5. Enumerate the object closure to send (commits + trees + blobs that the
   server does NOT already have).
6. Build a packfile (non-delta v1, see ADR-013).
7. POST to `git-receive-pack` with the packfile + ref-update commands.
8. Parse the response (`unpack ok` + per-ref `ok`/`ng`).
9. On success, update the local `refs/remotes/<remote>/*` cache so the next
   `push --force-with-lease=auto` has the new value.

This is symmetric to the Phase 12.2 fetch flow but reverses every direction:
client builds the pack, server receives it.

## 2. Module Layout

New files:

```
src/application/commands/internal/receive-pack-client.ts
    discoverReceivePackRefs(ctx, transport, url) → Advertisement
    selectPushCapabilities(advertised) → ReadonlyArray<string>

src/application/commands/internal/refspec.ts
    parseRefspec(input) → ParsedRefspec
    resolveRefspecs(input, ctx, defaults) → ReadonlyArray<ResolvedRefspec>

src/application/primitives/enumerate-push-objects.ts
    enumeratePushObjects(ctx, wants, haves) → ReadonlyArray<ObjectId>

src/application/primitives/build-pack.ts
    buildPack(ctx, oids) → { bytes: Uint8Array; sha: string; objectCount }
```

Refactored files:

```
src/application/commands/internal/upload-pack-client.ts
    → src/application/commands/internal/refs-discovery.ts
      (parameterised: takes 'git-upload-pack' | 'git-receive-pack')
      Re-exported from upload-pack-client.ts for the existing call sites.

src/application/commands/push.ts
    Full body rewrite per §1.
```

No domain changes — Phase 9 protocol primitives are sufficient.

## 3. Types

### 3.1 Refspec parsing

```ts
export type Force = 'force' | 'normal';

export interface ParsedRefspec {
  readonly force: Force;
  /** Source ref name (local). Empty string for delete-only refspecs. */
  readonly src: string;
  /** Destination ref name (remote). MUST be non-empty. */
  readonly dst: string;
  /** True iff src is empty (delete). */
  readonly isDelete: boolean;
}

export interface ResolvedRefspec {
  readonly parsed: ParsedRefspec;
  /** Local oid currently at `src` (zero oid for delete). */
  readonly localOid: ObjectId;
  /** Remote oid currently at `dst` per server advertisement (zero oid if absent). */
  readonly remoteOid: ObjectId;
  /** Force-with-lease expected value (undefined when not set). */
  readonly expectedRemoteOid?: ObjectId;
}
```

### 3.2 Enumeration

```ts
export interface EnumeratePushObjectsInput {
  /** Commit oids the caller wants on the remote (local heads of pushed branches). */
  readonly wants: ReadonlyArray<ObjectId>;
  /** Commit oids the remote already has (server's current ref tips). */
  readonly haves: ReadonlyArray<ObjectId>;
  /** Hard cap on objects collected (DoS guard). */
  readonly maxObjects?: number;
}

export function enumeratePushObjects(
  ctx: Context,
  input: EnumeratePushObjectsInput,
): AsyncIterable<ObjectId>;
```

Yields a deduplicated, topologically-ordered (commits before their trees,
trees before their blobs) stream of object oids missing from the remote.
Annotated tags pointing at a wanted commit are included; lightweight tags
(directly pointing at a commit) are NOT auto-added — they must appear as a
refspec to be pushed.

### 3.3 Pack building

```ts
export interface BuildPackInput {
  readonly oids: ReadonlyArray<ObjectId>;
}

export interface BuildPackResult {
  readonly bytes: Uint8Array;
  /** Hex SHA-1 of the pack body (without the trailer). */
  readonly sha: string;
  readonly objectCount: number;
}

export function buildPack(ctx: Context, input: BuildPackInput): Promise<BuildPackResult>;
```

Implementation: for each oid, `readObject` → `serializeObject` → strip the
`<type> <size>\0` header → `deflate` → `encodePackEntryHeader(type, size)
|| deflated`. Concatenate (`serializePackHeader` || entries || trailer).
Trailer is `ctx.hash.hashBytes(body)`.

### 3.4 Push API (already public on `PushOptions`)

The public surface stays as today. We tighten the `PushResult` shape:

```ts
export interface PushedRef {
  readonly name: RefName;
  readonly oldId: ObjectId; // zero for create
  readonly newId: ObjectId; // zero for delete
  readonly status: 'ok' | 'rejected';
  readonly reason?: string;
}

export interface PushResult {
  readonly remote: string;
  readonly url: string;
  readonly pushedRefs: ReadonlyArray<PushedRef>;
}
```

`oldId`/`newId` were not on the v1 stub. Adding them is a non-breaking
extension — the public type was `readonly pushedRefs: ReadonlyArray<{...}>`
with `{ name, newId, status }`. Existing consumers destructure those three;
the addition of `oldId` and `reason` is additive.

## 4. Wire Format

### 4.1 Discovery (GET)

```
GET <baseUrl>/info/refs?service=git-receive-pack
```

Response (200): pkt-line stream
```
001f# service=git-receive-pack
0000
<adv-line-1>
<adv-line-2>
...
0000
```

Identical to upload-pack discovery except for the `service=` token. We
reuse `parseAdvertisedRefs` with `'git-receive-pack'` as the service.

### 4.2 Push request (POST)

```
POST <baseUrl>/git-receive-pack
Content-Type: application/x-git-receive-pack-request
Accept: application/x-git-receive-pack-result

<pkt-line> <oldId> <newId> <ref>\0<caps>\n
<pkt-line> <oldId> <newId> <ref>\n          (additional refs — no caps)
...
0000
<packfile bytes — PACK header, entries, SHA-1 trailer>
```

`buildReceivePackRequest` in the Phase 9 protocol module already produces
this format. The pack bytes are concatenated raw after the flush packet.

For delete-only pushes (every ref has `newId = 0000...0000`), the
spec mandates an empty pack (0 entries) with valid header + trailer:

```
PACK\0\0\0\2\0\0\0\0
<SHA-1 of the 12 header bytes>
```

`buildPack({ oids: [] })` produces exactly this. The empty-pack case is
NOT optional — the server expects a pack body even when no objects move.

### 4.3 Response

With `side-band-64k` capability: multiplexed sideband stream where the
report-status protocol is on channel 1.

Without sideband: response body is the report-status pkt-line stream
directly.

```
unpack ok\n
ok refs/heads/main\n
ng refs/heads/feature pre-receive hook declined\n
0000
```

`parseReceivePackResponse` already returns `{ unpackOk, refUpdates }`.

## 5. Algorithm Details

### 5.1 Refspec resolution

```
parseRefspec(input):
  if input starts with '+', set force = 'force', strip it
  split on ':'; lhs = src, rhs = dst
  if input has no ':':
    src = dst = input (short form)
  if src === '': isDelete = true
  if dst === '': error (REFSPEC_INVALID)
  if src qualified with refs/, leave as-is
  if src is a short branch name (no slash), expand to refs/heads/<src>
  if dst is a short branch name, expand to refs/heads/<dst>
  same for tag short-forms
```

Resolution:
```
resolveRefspecs(refspecs, ctx, remoteAdv):
  remoteByName = Map of {dst → oid} from remoteAdv
  for each parsed refspec:
    localOid = parsed.isDelete ? ZERO : resolveRef(parsed.src)
    remoteOid = remoteByName.get(parsed.dst) ?? ZERO
    expectedRemoteOid = options.forceWithLease // resolved 'auto' → cached remote-tracking ref
    if !parsed.force && !parsed.isDelete && remoteOid !== ZERO:
      if !isAncestor(remoteOid, localOid): throw NON_FAST_FORWARD(parsed.dst)
    if expectedRemoteOid !== undefined && expectedRemoteOid !== remoteOid:
      throw PUSH_REJECTED(parsed.dst, 'lease-mismatch')
    yield { parsed, localOid, remoteOid, expectedRemoteOid }
```

### 5.2 Enumeration

```
enumeratePushObjects(wants, haves):
  // 1. Commit walk: every commit reachable from wants and NOT reachable from haves.
  //    walkCommits short-circuits at `until` boundaries without yielding them —
  //    exactly the semantics we want (haves stay on the server side; we yield
  //    only commits the server is missing).
  emitted = new Set<ObjectId>()
  emit(id): if (!emitted.has(id)) { capCheck(); emitted.add(id); yield id }
  for await (commit of walkCommits({ from: wants, until: haves, ignoreMissing: true })):
    emit(commit.id)
    // 2. Tree closure for this commit. emit() dedups across all commits so
    //    a tree shared by N commits is sent once. We do NOT subtract trees
    //    reachable from haves — receive-pack tolerates duplicates and the
    //    haves-closure intersection is deferred (see Pass 2 above).
    emit(commit.tree)
    for await (entry of walkTree(commit.tree, { recursive: true })):
      if (isGitlink(entry.mode)) continue   // submodule commit; not in our store
      emit(entry.id)
```

`isGitlink` skips submodule commits — those oids live in another
repository and we cannot resolve them locally. `walkTree` itself yields
gitlink entries but already declines to recurse into them; we additionally
filter them out of the emit stream.

Inputs that look "annotated" — i.e. a wanted oid that resolves to a tag
object rather than a commit — are detected up-front: each want is read
once; if it's a tag, the tag object oid is yielded, then the chain is
followed (`tag.target` → potentially another tag for tag-of-tag → commit),
and the commit becomes the walk seed. Lightweight tag refspecs reduce
to commit refspecs and need no special handling.

`enumeratePushObjects` enforces `MAX_PUSH_OBJECTS` (default 1_000_000)
inclusively — incrementing `emitted.size` past the cap throws
`PACK_TOO_LARGE` before the next `yield`. The cap exists primarily as a
DoS guard against pathological repositories where a single push would
blow up client memory.

### 5.3 Pack assembly

```
buildPack(oids):
  entries = []
  for oid in oids:
    raw = serializeObject(readObject(oid))
    // raw is "<type> <size>\0<content>"; strip header
    nul = raw.indexOf(0)
    typeName = decode(raw.subarray(0, raw.indexOf(0x20)))
    content = raw.subarray(nul + 1)
    type = typeNameToPackType(typeName)
    deflated = deflate(content)
    entries.push({ type, uncompressedSize: content.length, compressedData: deflated })
  packfile = serializePackfile(entries)
  trailer = hash(packfile.data)
  bytes = packfile.data || trailer
```

`serializePackfile` exists already in `domain/storage/pack-writer.ts`.

### 5.4 Force-with-lease 'auto'

```
resolveAutoLease(remote, branchName):
  cached = readRef(`refs/remotes/${remote}/${branchName}`)
  return cached.oid // throws REF_NOT_FOUND → propagate
```

The user-facing API accepts a single `forceWithLease?: ObjectId | 'auto'`
field at the push level. We extend it to per-refspec leases in a future
revision; v1 applies the lease to every refspec being force-pushed.

### 5.5 Push command body sketch

```
push(opts):
  assertRepository(ctx)
  remote = resolveRemoteUrl(opts.remote ?? 'origin')
  refspecs = parseRefspecs(opts.refspecs ?? defaultRefspec(ctx))
  adv = discoverReceivePackRefs(ctx, transport, remote.url)
  resolved = resolveRefspecs(refspecs, ctx, adv, opts)
  if every resolved is no-op (oldId === newId): return { ..., pushedRefs: [] }
  wantsCommits = resolved.filter(non-delete).map(r => r.localOid)
  havesCommits = adv.refs.map(r => r.id)
  if wantsCommits.length > 0:
    objects = collect(enumeratePushObjects({ wants, haves }))
  else:
    objects = [] // delete-only
  pack = buildPack(ctx, { oids: objects })
  request = buildReceivePackRequest({ updates, capabilities, packfile: pack.bytes })
  response = transport.request({ url: <baseUrl>/git-receive-pack, body: request, ...})
  parsed = parseReceivePackResponse(response.body via sideband demux if cap)
  if !parsed.unpackOk: throw PUSH_REJECTED('unpack', parsed.unpackError)
  // Update remote-tracking cache for accepted refs.
  for each accepted ref: updateRef(refs/remotes/<remote>/<branch>, newId)
  return { remote, url, pushedRefs: [...] }
```

## 6. Failure Modes

| Failure | Detection | Error code |
|---------|-----------|-----------|
| Remote not configured | `readConfig` returns no remote | `REMOTE_NOT_CONFIGURED` |
| Refspec syntax | `parseRefspec` | `REFSPEC_INVALID` |
| Non-FF without `force` | ancestor check | `NON_FAST_FORWARD` |
| Lease mismatch | pre-send compare | `PUSH_REJECTED` (reason `lease-mismatch`) |
| Remote ref absent for delete | `remoteByName.get(dst) === undefined` | `REF_NOT_FOUND` (well-typed) |
| Discovery HTTP non-200 | `discoverReceivePackRefs` | `HTTP_ERROR` |
| `unpack <err>` from server | `parseReceivePackResponse.unpackOk === false` | `PUSH_REJECTED` (reason from server) |
| Per-ref `ng` from server | response `refUpdates[i].accepted === false` | NOT thrown; surfaced as `status: 'rejected'` |
| Cap exceeded | enumeration count > `maxPushObjects` | `PACK_TOO_LARGE` |

A per-ref `ng` is **not** a thrown error — it is reported per-ref so the
caller can decide. The `unpackOk: false` server response IS thrown, since
the pack itself was rejected (a configuration problem on the client side,
typically); no useful per-ref state survives.

## 7. Defaults

| Option | Default | Source |
|--------|---------|--------|
| `remote` | `'origin'` | matches `fetch` / `clone` |
| `refspecs` | current branch as `refs/heads/<branch>:refs/heads/<branch>` | `HEAD` → branch lookup |
| `force` | `false` | safe default |
| `forceWithLease` | undefined | opt-in only |
| `maxPushObjects` | 1_000_000 | DoS guard, matches isomorphic-git defaults order-of-magnitude |

`HEAD` resolution: if `HEAD` is detached, no default refspec — caller must
supply explicit refspecs or push throws `INVALID_OPTION` (no branch to
push from).

## 8. Testing Strategy

### 8.1 Unit

- `refspec.ts`: 14 cases. Force prefix, delete, short branch, qualified
  refs, tag short-form, malformed (empty dst, double force prefix, no `:`),
  HEAD as src.
- `enumerate-push-objects.ts`: empty haves (full closure), single haves
  (incremental), multiple haves, no overlap, deep ancestor stop.
- `build-pack.ts`: empty pack (12-byte header + 20-byte trailer), single
  blob, mixed types (commit + tree + blob + tag), round-trip via
  `walkPackEntries` + SHA verification.
- `receive-pack-client.ts`: discovery happy path, non-200 → HTTP_ERROR,
  capability filtering keeps only the supported subset, agent dedup.
- `push.ts` (command): config guards, refspec resolution, lease check,
  non-FF guard, unpack failure, per-ref rejection, side-band parsing,
  delete-only (empty pack) path, remote-tracking cache update.

### 8.2 Integration

`test/integration/network/push-http-backend.test.ts`:
- Spin up `git-http-backend` over a temp bare repo seeded with one commit
  on `main`.
- Local repo has two commits on `main` ahead of the bare remote (set up
  via real `git` on the temp dir, then `tsgit clone` of the bare, then
  add commits).
- `repo.push({ remote: 'origin', refspecs: ['refs/heads/main:refs/heads/main'] })`.
- Assert `pushedRefs[0].status === 'ok'`.
- Read the bare remote's `refs/heads/main` via real `git show-ref` and
  assert it points at the new tip.
- Second push: no changes. Assert `pushedRefs` is empty (no-op) and no
  HTTP POST was issued (transport call count).

### 8.3 Mutation focus

Highest-risk mutants in this phase:
- `parseRefspec`'s `force` prefix detection (`startsWith('+')` vs `===
  '+'`).
- `isAncestor`'s reachability boundary (empty queue vs queue.length > 0).
- `enumeratePushObjects` dedup `Set` (drop the `Set` and the
  `walkTree`-emits-everything mutant survives).
- `buildPack`'s entry encoding (drop the `encodePackEntryHeader` and the
  pack stays parseable until the consumer counts entries).
- The "skip POST when no refs change" short-circuit — easy mutant target.

Each gets a dedicated test that fails on the corresponding mutant.

## 9. Out of Scope (deferred)

- Delta compression / thin packs (v1.x patch).
- Refspec globs (`refs/heads/*:refs/heads/*`) — explicit list only in v1.
- Multi-host atomic pushes (mirror push).
- `pre-push` hook execution (no hook surface in v1 anyway).
- `--no-verify` flag (no hooks to verify against).
- Force-with-lease per-refspec (single global value in v1; per-ref leases
  in a follow-up).
- Smart-HTTP v2 — same posture as Phase 12.1 (ADR-005).
- `--mirror` semantics.

These are tracked in BACKLOG §12.x under post-v1 minor patches.

---
