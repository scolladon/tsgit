# Plan: Phase 12.1 — Clone Pack Fetch

**Status: Ready (at `1c23aae`)** — derived from [docs/design/phase-12-1-clone-pack-fetch.md](../design/phase-12-1-clone-pack-fetch.md) and ADRs [005](../adr/005-clone-protocol-v1.md), [006](../adr/006-clone-pack-storage-layout.md), [007](../adr/007-clone-resume-semantics.md), [008](../adr/008-clone-defer-shallow.md).

### Review notes

Three self-review passes were applied. Each pass tightened ordering and shrank the per-step delta rather than adding scope.

**Pass 1 — ordering + atomicity:**

- Step 1 (depth-guard) is first because it's a public-API contract change that needs zero supporting infrastructure. Shipping it first means the ADR-008 commitment is honored before any other code lands, and the rest of the branch can be reviewed without the spectre of "but what if depth is set?".
- The fetch-pack primitive lands BEFORE the clone-side wiring so the primitive's tests can fail / pass independently of clone changes. Inverting this order would force the clone integration test to either be the first thing landed (huge, hard to bisect) or to lag behind the primitive (already-shipped primitive with no consumer).
- The integration test (step 7) lands last. It's the slowest test in the suite and the one most likely to fail intermittently in CI. Decoupling it from the unit-test steps means earlier failures land on smaller diffs.

**Pass 2 — test-first discipline:**

- Every implementation step has its tests written first, in a separate commit if the diff exceeds ~150 LOC. The test commit must FAIL the CI before the impl commit makes it pass.
- The pack-walker tests (step 4) cover every entry-type combination AND every error variant the walker can raise. Per CLAUDE.md, each guard clause is exercised by an isolated test — not a combined "throws on bad input" test.
- Boundary tests for `maxResponseBytes` pin three points: just-under, exact, just-over. This kills `<` vs `<=` mutants.

**Pass 3 — review-friendliness:**

- Step 5 (fetch-pack wire-up) and step 6 (clone composition) are intentionally separate commits even though they could be one. A reviewer who wants to see "what does the primitive do?" reads step 5; one who wants "what changed in clone?" reads step 6. Bundling would hide the API choice inside the clone diff.
- Documentation updates (step 8) are last so the BACKLOG tick (per CLAUDE.md step 8 rule) happens in the same PR but after every implementation commit is in place. Earlier ticks would land green and then re-flip if a later step needed to be reworked.

---

## File inventory

### Net-new files

| Path | Purpose |
|------|---------|
| `src/application/primitives/fetch-pack.ts` | Pack-fetch primitive (~250 LOC). Shared with future fetch / push primitives. |
| `test/unit/application/primitives/fetch-pack.test.ts` | Unit tests with a fake HttpTransport (~600 LOC including fixtures and helpers). |
| `test/integration/network/clone-http-backend.test.ts` | End-to-end test against a local git-http-backend (~180 LOC). |
| `test/fixtures/clone-source/source.git/**` | Pre-built bare repo (1 commit, 1 blob). ~1 KB. |
| `test/fixtures/clone-source/HEAD-oid.txt` | Asserted HEAD oid of the fixture. |
| `scripts/regenerate-clone-fixtures.sh` | Idempotent rebuilder for the fixture. |

### Modified files

| Path | Change |
|------|--------|
| `src/application/commands/clone.ts` | Discover → fetchPack → write refs → set HEAD. Reject `depth`. |
| `src/application/primitives/index.ts` | Export `fetchPack`. |
| `test/unit/application/commands/clone.test.ts` | Extend with full-clone happy path + depth-rejected + bootstrap-rollback. |
| `docs/BACKLOG.md` | Flip `[ ] 12.1` → `[x] 12.1`. |
| `README.md` | Update the "what works" section: clone is no longer a stub. |
| `RUNBOOK.md` | Add a "cloning a remote" section pointing at the integration test as a worked example. |

No public-API surface change beyond the side-effect of `CloneOptions.depth` now throwing.

---

## Step sequence

Each step lists what to test FIRST, what to implement, what to verify before moving on. Commits use conventional-commit subjects.

### Step 1 — `depth: N` rejected with `UNSUPPORTED_OPERATION`

**Test first:** `test/unit/application/commands/clone.test.ts` — new test `Given depth: 1, When clone, Then throws UNSUPPORTED_OPERATION`. Asserts `err.data.code === 'UNSUPPORTED_OPERATION'` AND `err.data.reason` contains `depth` AND `Phase 12.2`. (Three asserts on `.data` to kill StringLiteral mutants.)

**Implement:** add a 3-line guard to `clone.ts` right after the URL-empty check. Throw `unsupportedOperation('clone-shallow', 'depth: N is supported in Phase 12.2 (fetch)')`.

**Verify:** `npm run test:unit -- clone` green. `npm run check:types` green.

**Commit:** `feat(clone): reject depth: N until Phase 12.2 (ADR-008)`.

### Step 2 — fetch-pack primitive scaffold + happy-path test

**Test first:** `test/unit/application/primitives/fetch-pack.test.ts` — `Given an advertised single-base-commit pack, When fetchPack runs, Then writes pack-<sha>.pack and pack-<sha>.idx and returns the result`. Uses `buildUploadPackResponseBody` to construct the fake response. Asserts:

- `result.packPath === '<gitDir>/objects/pack/pack-<sha>.pack'`.
- `result.idxPath === '<gitDir>/objects/pack/pack-<sha>.idx'`.
- `result.objectCount === 1`.
- `result.packSha === <computed trailer>`.
- Both files exist on disk via `ctx.fs.exists`.
- `parsePackHeader(<file bytes>)` parses successfully.
- `parsePackIndex(<idx bytes>)` parses successfully.

**Implement:** `src/application/primitives/fetch-pack.ts`. Functions in the order they execute:

```
fetchPack(ctx, transport, input) →
  buildAndPostUploadPack(...) →
    buildUploadPackRequest(...)  // domain
    transport.request(...)        // port
  parseUploadPackResponse(...)    // domain
  drainPackBody(packBodyIterable, maxResponseBytes) → Uint8Array
  verifyTrailer(buffer, ctx.hash) → packSha
  walkPackEntries(buffer, ctx) → entries[]
  serializePackIndex(entries, packShaBytes) → idxBytes  // domain (existing)
  writeExclusive(packPath, buffer)
  writeExclusive(idxPath, idxBytes)
```

Helpers go in module-private functions; only `fetchPack` and the two interfaces (`FetchPackInput`, `FetchPackResult`) are exported.

**Verify:** new test passes. Existing protocol tests still green.

**Commit:** `feat(primitives): fetch-pack — single-base happy path`.

### Step 3 — pack walker: OFS_DELTA + REF_DELTA resolution (including out-of-order)

**Test first** (add to fetch-pack.test.ts):

- OFS_DELTA: server pack contains base + OFS_DELTA. Assert both entries appear in the written `.idx` with the correct ids.
- REF_DELTA: server pack contains base + REF_DELTA. Same assertion.
- REF_DELTA out-of-order: server pack contains REF_DELTA before its base. Assert the walker resolves it via the deferred pass.
- REF_DELTA unresolvable: pack contains a REF_DELTA whose base is not in the pack. Assert `INVALID_PACK_HEADER` with `reason` containing `unresolved REF_DELTA`. (Two `.data` field asserts.)
- Max-depth chain: 50-deep OFS_DELTA chain. Asserts no `DELTA_CHAIN_TOO_DEEP` since we're under the limit; 51-deep asserts the error.

**Implement:** extend `walkPackEntries` (and its helpers) in `fetch-pack.ts`. The walker maintains `byOffset: Map<number, ResolvedEntry>` and `byId: Map<ObjectId, ResolvedEntry>`. The deferred queue is `Array<{ offset, header }>` processed after the first sweep.

Resolution logic reuses `applyDelta` from `domain/storage/delta.ts`. Object id is computed via `hash.hashHex(serializeObject(parseObject(typeName, payload, hashConfig), hashConfig))`.

**Verify:** new tests pass. The existing `object-resolver` tests still pass (the walker does NOT touch `object-resolver.ts` — it's a separate walker tuned for bulk-receive instead of single-id lookup).

**Commit:** `feat(primitives): fetch-pack — OFS/REF delta resolution with deferred queue`.

### Step 4 — failure modes and boundary tests for fetch-pack

**Test first** (add to fetch-pack.test.ts):

- Trailer mismatch: server returns a pack whose last byte is corrupted. Assert `INVALID_PACK_HEADER` with `reason` containing `trailer`.
- `maxResponseBytes` exact: caller sets `maxResponseBytes` equal to the pack size. Assert success.
- `maxResponseBytes` over (boundary): caller sets it one byte less. Assert `PACK_TOO_LARGE` with `limit` equal to the cap.
- `maxResponseBytes` under (boundary): caller sets it one byte more. Assert success.
- Empty pack: server returns a 32-byte file (12-byte header with 0 objects + 20-byte trailer). Assert `.idx` is written with zero entries; assert `result.objectCount === 0`; trailer computed in the test, not hardcoded.
- No side-band: server discovery did not advertise `side-band-64k` / `side-band`. Pack bytes arrive in raw pkt-lines. Assert the same outputs.
- Progress ticks: 200 KiB pack. Capture reporter events. Assert ≥ 3 update events fire; assert each consecutive delta is ≥ 65 536 bytes (one update for the final flush is allowed below the threshold).
- Channel-2 progress text: server emits `Counting objects: 5, done.`. Capture reporter events. Assert `text` slot contains the sanitized message on at least one update.

**Implement:** add the trailer check (`verifyTrailer`), the cap check inside `drainPackBody`, and the byte-bounded progress emission inside the drain loop.

**Verify:** all new tests pass. Mutation testing on `fetch-pack.ts` shows 100% killed (`stryker run --mutate src/application/primitives/fetch-pack.ts`).

**Commit:** `feat(primitives): fetch-pack — trailer, size cap, progress, no-sideband fallback`.

### Step 5 — export `fetchPack` from primitives index

**Test first:** no new tests — this is a re-export.

**Implement:** add `export { fetchPack } from './fetch-pack.js';` to `src/application/primitives/index.ts`. Run `npm run check:knip` to confirm no unused-export warning.

**Verify:** `npm run check` green.

**Commit:** `feat(primitives): export fetchPack from primitives/index`.

### Step 6 — clone composition: discover → fetchPack → write refs → set HEAD

**Test first:** `test/unit/application/commands/clone.test.ts` — `Given a discovery with one branch and a non-empty pack, When clone runs, Then writes the pack, refs/heads/main, refs/remotes/origin/main, and HEAD`.

Two more tests to follow:
- `Given a discovery with multiple branches, When clone runs, Then writes refs/remotes/origin/<branch> for every branch including the HEAD-tracked one`.
- `Given a fetchPack failure mid-write, When clone runs, Then the bootstrap rollback removes the partial .git skeleton`.

Each test composes a fake `HttpTransport` whose `request` returns either the discovery body or the upload-pack body depending on the URL.

**Implement:** extend `clone.ts`:

1. After bootstrap, compose `transport = withDefaults(ctx, { auth, logger })`.
2. `discoverRefs(ctx, transport, url)` — small helper that GETs the discovery URL and parses it.
3. `negotiateCapabilities(advertised)` — small helper returning the intersection (table from design §3.6).
4. `fetchPack(ctx, transport, { wants, haves: [], capabilities, url, progressOp: 'clone:write-objects' })`.
5. `writeFetchedRefs(ctx, advertisement, headBranch)` — writes `refs/heads/<HEAD-branch>` (loose), `refs/remotes/origin/<branch>` (loose) for every advertised branch, and `refs/tags/<tag>` (loose) for every advertised tag.
6. `applyRemoteHead(ctx, advertisement, headBranch)` — writes `HEAD` symbolic if remote's HEAD is symref'd, direct if detached.
7. Wrap fetchPack + ref writes in a try/catch that calls `ctx.fs.rmRecursive(gitDir)` on failure (matches the bootstrap rollback semantics already present).

Helpers live inside `clone.ts` as module-private functions; none are exported.

**Verify:** the three new clone tests pass. The existing clone tests still pass. `npm run check:types` green.

**Commit:** `feat(clone): wire pack fetch and ref propagation end-to-end`.

### Step 7 — integration test against local `git-http-backend`

**Test first:** the test IS the work for this step. Write `test/integration/network/clone-http-backend.test.ts`.

**Fixture generation:** create `scripts/regenerate-clone-fixtures.sh` exactly as specified in design §6.4. Run it once to populate `test/fixtures/clone-source/source.git/**` and `test/fixtures/clone-source/HEAD-oid.txt`. Both are committed.

**Server harness:** an `http.createServer` instance that spawns `git-http-backend` per request via `child_process.spawn`. The server runs on `127.0.0.1:0` (ephemeral port). Started in `beforeAll`, torn down in `afterAll`. The `it` block computes the URL `http://127.0.0.1:<port>/source.git` and calls `clone({ url, allowInsecure: true, allowPrivateNetworks: true, resolver: async () => ['127.0.0.1'] })`.

**Assertions:** `result.head === 'refs/heads/main'`. `result.fetchedRefs.length >= 1`. Opening the resulting repo with `openRepository` and walking commits from HEAD via `walkCommits` yields a first commit whose oid equals `await readFile('test/fixtures/clone-source/HEAD-oid.txt', 'utf8').trim()`.

**Skip guard:** the suite is skipped if `git --version` is not in `$PATH` (use `it.skipIf`). Document in the file header that CI runners have git pre-installed.

**Verify:** `npm run test:integration -- clone-http-backend` green. The full `npm run test` suite is green.

**Commit:** `test(integration): clone end-to-end against local git-http-backend`.

### Step 8 — docs refresh + BACKLOG tick

**Update `docs/BACKLOG.md`:** flip `- [ ] **12.1** ...` to `- [x] **12.1** ...` AND add a follow-up note: "Shallow / `depth: N` deferred to 12.2 per ADR-008. Streaming-to-temp-file deferred per ADR-007."

**Update `README.md`:** if the README has a "what works" or "status" section, update the clone bullet from "stub — discovery only" (or whatever it currently says) to "fully wired against smart-HTTP v1". Cross-reference the integration test.

**Update `RUNBOOK.md`:** add a "Cloning a remote" section pointing at the integration test as the runnable worked example.

**Update `MIGRATION.md`:** if it mentions clone as stubbed, fix the language.

Touch only the files that the implementation actually invalidates.

**Verify:** `npm run validate` runs every check end-to-end. Stryker run kills every killable mutant on `fetch-pack.ts` and the modified `clone.ts`.

**Commit:** `docs: phase 12.1 tick BACKLOG, refresh README/RUNBOOK for live clone`.

---

## Dependencies between steps

```
Step 1 (depth-guard)               ── independent
Step 2 (fetch-pack happy path)     ── independent
Step 3 (delta resolution)          ── needs step 2
Step 4 (failure modes)             ── needs step 3
Step 5 (re-export)                 ── needs step 2 (and re-checked after step 4)
Step 6 (clone composition)         ── needs step 5
Step 7 (integration test)          ── needs step 6
Step 8 (docs + BACKLOG)            ── needs step 7
```

Steps 1 and 2 can be done in parallel; steps 3+ are strictly sequential.

## Stop conditions / abort triggers

Any of the following blocks the branch:

- `npm run validate` fails after step 8 (the harness gate per CLAUDE.md §7).
- `stryker run --mutate src/application/primitives/fetch-pack.ts` reports surviving mutants without a documented `// equivalent-mutant:` justification.
- The integration test cannot be made stable on Ubuntu CI (intermittent failures > 1 in 20). In that case, gate it behind an opt-in env flag and document the deferral in BACKLOG.
- The pack-write trail leaves an orphan `.pack` without a matching `.idx` in any failure mode (verified by the bootstrap-rollback test).

## Time / scope estimate

Net new code: ~450 LOC (production) + ~900 LOC (tests + fixtures + scripts). Comparable in scope to a single Phase 9 command implementation (e.g., Phase 9.5 `log`).

Expected effort: 2–3 focused sessions for the implementation, one session for the integration test, one session for docs + review polish.
