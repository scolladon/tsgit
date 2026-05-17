# Plan: Phase 12.3 — Push (TDD step sequence)

Backlog entry: [§12.3](../BACKLOG.md). Design: [`phase-12-3-push.md`](../design/phase-12-3-push.md).
ADRs: [013](../adr/013-push-pack-encoding.md), [014](../adr/014-push-refspec-scope.md),
[015](../adr/015-push-force-with-lease.md), [016](../adr/016-push-atomic-tx.md).

### Plan-review notes (×3)

Three self-review passes were applied; each pass tightened the sequence.

**Pass 1 — dependency ordering.**
`buildPack` and `enumeratePushObjects` are independent primitives; either
can land first. `parseRefspec` is independent of both. The push command
body is the LAST commit because it consumes everything. The
`refs-discovery` rename (parameterising `discoverRefs` over service) lands
before the push command body so the receive-pack client helper has a
home.

**Pass 2 — atomic-commit cohesion.**
Every commit must build + green-test independently. The two
"refactor-first" commits — receive-pack-client extraction and the
upload-pack-client rename — are gated by their own tests staying green.
The pack-build commit imports a small canonical-git pack fixture for the
round-trip assertion; that fixture is checked in once and re-used.

**Pass 3 — test coverage progression + mutation density.**
Each guard in `parseRefspec` (delete, force, short-form, qualified) gets
an isolated test. `buildPack`'s "empty pack" trailer is asserted
byte-exact, not just by length. `enumeratePushObjects` cap-overflow has
its own test. The non-FF guard and lease-mismatch path have separate
integration assertions in the final integration test.

---

## Files modified or created

### Created

```
docs/adr/013-push-pack-encoding.md           (done — commit 2)
docs/adr/014-push-refspec-scope.md           (done — commit 2)
docs/adr/015-push-force-with-lease.md        (done — commit 2)
docs/adr/016-push-atomic-tx.md               (done — commit 2)
docs/design/phase-12-3-push.md               (done — commit 1)
docs/plan/phase-12-3-push.md                 (this file — commit 3)

src/application/commands/internal/refspec.ts
src/application/commands/internal/refs-discovery.ts        (renamed)
src/application/commands/internal/receive-pack-client.ts
src/application/primitives/enumerate-push-objects.ts
src/application/primitives/build-pack.ts

test/unit/application/commands/internal/refspec.test.ts
test/unit/application/commands/internal/refs-discovery.test.ts
test/unit/application/commands/internal/receive-pack-client.test.ts
test/unit/application/primitives/enumerate-push-objects.test.ts
test/unit/application/primitives/build-pack.test.ts
test/integration/network/push-http-backend.test.ts
test/fixtures/push-source/                                 (bare repo seed)
```

### Modified

```
src/application/commands/internal/upload-pack-client.ts    # thin re-export from refs-discovery
src/application/primitives/index.ts                        # re-export buildPack, enumeratePushObjects
src/application/commands/push.ts                           # real body
src/domain/error.ts                                        # PUSH_REJECTED reason variants if needed

test/unit/application/commands/push.test.ts                # rewritten
test/unit/application/primitives/index.test.ts             # barrel additions

docs/BACKLOG.md                                            # tick §12.3 (final commit)
README.md, MIGRATION.md                                    # docs refresh (final commit)
```

---

## TDD sequence

### Commit 1 — design (already landed)

`docs/design/phase-12-3-push.md`.

### Commit 2 — ADRs 013–016 (already landed)

`docs/adr/013-016`.

### Commit 3 — plan (this file)

`docs/plan/phase-12-3-push.md`.

### Commit 4 — refactor: parameterise `discoverRefs` over service

**Step 4a — Refactor (test-stable):** rename
`src/application/commands/internal/upload-pack-client.ts` to
`src/application/commands/internal/refs-discovery.ts`. Extract:
- `discoverRefs(ctx, transport, url, service)` — service is
  `'git-upload-pack' | 'git-receive-pack'`. The body parameterises the
  discovery URL, accept header, and the call to `parseAdvertisedRefs`.
- Leave `upload-pack-client.ts` as a thin re-export that calls the new
  helper with `'git-upload-pack'` (no caller-site changes required).

Every test that imports from `upload-pack-client.ts` stays green.

Commit message: `refactor(commands): parameterise discoverRefs over service`.

### Commit 5 — `parseRefspec` parser

**Step 5a — Red:** add `test/unit/application/commands/internal/refspec.test.ts`:
- `'main'` → `{src: 'refs/heads/main', dst: 'refs/heads/main', force: 'normal', isDelete: false}`.
- `'+main'` → `force: 'force'`.
- `':refs/heads/feature'` → `isDelete: true, src: '', dst: 'refs/heads/feature'`.
- `'main:other'` → src/dst short-expanded.
- `'refs/heads/main:refs/heads/main'` → no expansion.
- `'refs/tags/v1.0:refs/tags/v1.0'` → tag refspec unchanged.
- `'HEAD'` → fail to expand here; the resolver layer handles HEAD.
- `''` → throws `REFSPEC_INVALID`.
- `'+'` → throws `REFSPEC_INVALID` (empty after force prefix).
- `':'` → throws `REFSPEC_INVALID` (empty dst).
- `'a:'` → throws `REFSPEC_INVALID` (empty dst).
- `'a:b:c'` → throws `REFSPEC_INVALID` (multiple colons).

**Step 5b — Green:** implement `parseRefspec` in
`src/application/commands/internal/refspec.ts`. Function returns
`ParsedRefspec`; no async; pure data transform.

Commit message: `feat(commands): parseRefspec parser (v1 scope)`.

### Commit 6 — `build-pack` primitive

**Step 6a — Red:** add `test/unit/application/primitives/build-pack.test.ts`:
- Empty oid list → bytes are 32 bytes (12 header + 20 trailer). Trailer
  hash matches `ctx.hash.hashHex(headerBytes)`. Asserted byte-by-byte.
- Single blob oid → 12 header + 1 entry header + deflated content + 20
  trailer. Reading back via `parsePackHeader` reports `objectCount = 1`.
- Three mixed types (commit + tree + blob) → `walkPackEntries` from the
  fetch-pack primitive can decode every entry, oids match what
  `enumeratePushObjects` would emit.
- Round-trip against a canonical-git-produced pack: read the canonical
  pack's oids via the fetch-pack walker, feed them to `buildPack`, assert
  the new pack's object count + every entry id round-trips through the
  walker.

**Step 6b — Green:** implement `buildPack` in
`src/application/primitives/build-pack.ts`. Uses `readObject`,
`serializeObject`, strips the loose header, deflates, calls
`serializePackfile`, appends the SHA-1 trailer. Re-export from
`src/application/primitives/index.ts`.

Commit message: `feat(primitives): buildPack non-delta packfile assembler`.

### Commit 7 — `enumeratePushObjects` primitive

**Step 7a — Red:** add `test/unit/application/primitives/enumerate-push-objects.test.ts`:
- Empty haves, single want (head of a 3-commit chain) → yields 3 commits +
  3 trees + N blobs. Order is commits-before-their-tree-before-their-blobs.
- Haves overlap fully (`haves = [want]`) → yields nothing.
- Haves cover the parent commit → yields only the tip commit + its tree
  closure (one commit's-worth of objects, not the chain).
- Disjoint haves (haves not reachable from wants) → yields the full
  wants closure.
- Gitlink entry in a tree → entry's id is NOT in the emitted set.
- Cap overflow (`maxObjects: 2`, real closure is 6) → throws
  `PACK_TOO_LARGE` mid-stream.

**Step 7b — Green:** implement `enumeratePushObjects` in
`src/application/primitives/enumerate-push-objects.ts`. Async iterable;
uses `walkCommits({ until })` for commits and `walkTree({ recursive })`
for trees. `Set<ObjectId>` dedups across the whole stream. Re-export
from primitives index.

Commit message: `feat(primitives): enumeratePushObjects closure walker`.

### Commit 8 — `receive-pack-client` helper

**Step 8a — Red:** add `test/unit/application/commands/internal/receive-pack-client.test.ts`:
- `discoverReceivePackRefs` happy path → calls transport with
  `service=git-receive-pack`, returns Advertisement. Asserted via fake
  transport recording request URL.
- Non-200 from discovery → `HTTP_ERROR`.
- `selectPushCapabilities` keeps `report-status`, `side-band-64k`,
  `ofs-delta`, `atomic`, `delete-refs`, `agent` — drops everything else.
- `selectPushCapabilities` always appends `AGENT` after intersection,
  even if the server did not advertise it.
- `selectPushCapabilities` deduplicates `agent` (server-advertised
  `agent=...` shouldn't double-up).

**Step 8b — Green:** implement
`src/application/commands/internal/receive-pack-client.ts`:
- `discoverReceivePackRefs` is a thin wrapper around `discoverRefs(...,
  'git-receive-pack')`.
- `selectPushCapabilities` filters `CLIENT_CAPABILITIES_PUSH` against
  the server's advertisement; the agent dedup matches the pattern in
  `upload-pack-client`.

Commit message: `feat(commands): receive-pack client helpers`.

### Commit 9 — `push.ts` happy path (single-refspec, non-delete, non-force)

**Step 9a — Red:** rewrite `test/unit/application/commands/push.test.ts`.
The existing `REMOTE_NOT_CONFIGURED` test stays. New tests:
- Happy single-ref push: fake transport advertises `refs/heads/main` at
  old oid; client has a 3-commit branch ahead. Assert request body
  contains the ref-update pkt-line + a non-zero pack. Assert
  `pushedRefs[0].status === 'ok'`.
- No new commits to push (local at server's oid) → `pushedRefs` is
  empty; transport is NOT invoked after discovery (no POST).
- `unpack ok` + per-ref `ng` → status `'rejected'`, reason from server.
- `unpack err` → throws `PUSH_REJECTED` with `unpackError` reason.
- Discovery non-200 → throws `HTTP_ERROR`.
- Refspec `'main'` resolves via the parser; current branch on detached
  HEAD with no refspec → `INVALID_OPTION` with `'no-default-refspec'`.
- Default `'origin'` remote when `opts.remote` is unset.

**Step 9b — Green:** rewrite `src/application/commands/push.ts`:
- Resolve remote URL.
- Parse refspecs (default = current branch).
- Discover refs (receive-pack).
- Resolve each refspec against server adv → ResolvedRefspec.
- Enumerate objects → build pack.
- Build receive-pack request → POST.
- Demux side-band if advertised; parse `report-status`.
- Surface per-ref status; throw on `unpack` failure.
- Update `refs/remotes/<remote>/<branch>` cache for accepted refs.

Commit message: `feat(push): real receive-pack negotiation + pack send`.

### Commit 10 — force + non-FF guard

**Step 10a — Red:** extend `push.test.ts`:
- Non-FF without `force` + without `+` prefix → `NON_FAST_FORWARD`.
- Same setup with `force: true` → push succeeds.
- Same setup with refspec `'+main:refs/heads/main'` → push succeeds.

**Step 10b — Green:** add the ancestor-check helper (private to
`push.ts`):
```ts
const isAncestor = async (ctx, ancestor, descendant) => {
  for await (const c of walkCommits({ from: [descendant], ignoreMissing: true })) {
    if (c.id === ancestor) return true;
  }
  return false;
};
```
Wire into refspec resolution: `if (!force && !isDelete && remoteOid !==
ZERO && !await isAncestor(remoteOid, localOid)) throw nonFastForward(dst)`.

Commit message: `feat(push): non-fast-forward guard with force override`.

### Commit 11 — force-with-lease (`'auto'` + explicit oid)

**Step 11a — Red:** extend `push.test.ts`:
- `forceWithLease: 'auto'`, cached `refs/remotes/origin/main` matches
  server adv → push succeeds.
- `forceWithLease: 'auto'`, mismatch → `PUSH_REJECTED` reason
  `'lease-mismatch'`. POST is NOT issued.
- `forceWithLease: 'auto'` with no cached remote-tracking ref →
  `REF_NOT_FOUND`.
- `forceWithLease: '<explicit-oid>'`, matches server adv → push succeeds.
- `forceWithLease: 'auto'` with dst under `refs/tags/` →
  `INVALID_OPTION` reason `'lease-on-non-branch'`.

**Step 11b — Green:** add `resolveLease(opts, dst, ctx)` returning the
expected oid. In refspec resolution, compare against `remoteOid`; throw
on mismatch. Skip the non-FF guard when lease matches (lease implies
force).

Commit message: `feat(push): force-with-lease (auto + explicit)`.

### Commit 12 — delete refspec

**Step 12a — Red:** extend `push.test.ts`:
- Refspec `':refs/heads/feature'`, server advertises that ref → request
  contains `<oldId> 0000000000000000000000000000000000000000
  refs/heads/feature\n`. Pack body is the 32-byte empty pack.
- Delete refspec for a ref the server does NOT advertise →
  `REF_NOT_FOUND`.
- Delete-only push (no non-delete refspecs) does NOT call
  `enumeratePushObjects` (it bypasses object enumeration).

**Step 12b — Green:** in `push.ts`, branch on
`refspecs.every(r => r.isDelete)`. If true, skip enumeration and call
`buildPack` with empty oids. Otherwise the standard path.

Commit message: `feat(push): delete refspec produces empty-pack request`.

### Commit 13 — side-band demuxing on response

**Step 13a — Red:** extend `push.test.ts`:
- Server response wraps `report-status` in side-band channel 1 → parsed
  correctly.
- Channel 2 progress text → forwarded to `ctx.progress.update(...,
  sanitize(text))`. Verify with a stub reporter.
- Channel 3 fatal → throws `SIDEBAND_FATAL`.

**Step 13b — Green:** when capabilities include `side-band-64k`, demux
the response stream via `parseSideBand` before feeding to
`parseReceivePackResponse`. Sanitize channel-2 text the same way
`fetchPack` does.

Commit message: `feat(push): side-band-64k response demux`.

### Commit 14 — remote-tracking cache update

**Step 14a — Red:** extend `push.test.ts`:
- After a successful push, `refs/remotes/<remote>/<branch>` is updated
  to the new oid via `updateRef`.
- A rejected ref does NOT update the cache.
- Tag dst (`refs/tags/v1.0`) does NOT update remote-tracking (tags map
  1:1 to `refs/tags/*` server-side; tsgit's cache is branch-only).

**Step 14b — Green:** post-success loop in `push.ts`. For each
`pushedRefs[i].status === 'ok'`:
- If dst starts with `refs/heads/`: derive `<branch>`, call
  `updateRef(refs/remotes/<remote>/<branch>, newId)`.
- Otherwise: skip (no cache update for tag dsts in v1).

Commit message: `feat(push): update remote-tracking cache on accepted refs`.

### Commit 15 — push integration test

**Step 15a — Red:** add `test/integration/network/push-http-backend.test.ts`.
Setup:
- Spin up a bare-repo with one commit on `main` via real `git init
  --bare` + `git push` from a seed working tree. (Reuse the
  `clone-source` pattern.)
- Run real `git-http-backend` over that bare repo via CGI through Node's
  `http.createServer`. Reuse the `clone-http-backend` helper if
  available; otherwise factor it out.
- Build a local tsgit repo: `clone` from the bare, add two commits via
  primitives, then `push` back.
- Assert `pushedRefs[0].status === 'ok'`.
- Read the bare's `refs/heads/main` via `fs.readFile` (it's a loose
  ref under `<bare>/refs/heads/main`). Assert it equals the new tip.
- Second push (no changes) → `pushedRefs.length === 0`. No POST issued
  (transport call count, or HTTP server hit count, asserted ≤ 1 — just
  the discovery GET).

**Step 15b — Green:** the previous commits should make this pass.

Commit message: `test(integration): push against real git-http-backend`.

### Commit 16 — docs refresh, BACKLOG tick

**Step 16a — Update docs:**
- `README.md` — mention push surface, status enum, default refspec.
- `MIGRATION.md` — note push moved from stub to real.
- `docs/BACKLOG.md` — tick §12.3 (`[ ]` → `[x]`).
- Touch `docs/design/phase-12-3-push.md`'s status line.

Commit message: `docs(backlog): close phase 12.3 — push implemented`.

---

## Acceptance check

After commit 16:

1. `npm run validate` — green (lint, types, dead-code, 100% coverage,
   integration tests including push).
2. `stryker run` on the new code — every killable mutant in this
   branch's diff is killed. Pre-existing Phase 12.x mutant survivors
   are deferred per CLAUDE.md "v2 broad sweep" policy.
3. `gh pr create` for the branch.
4. Squash-merge on green CI.
