# Plan — Partial Clone (Phase 17.4)

Derived from `docs/design/partial-clone.md` and ADR-078…082. Each slice is one
atomic commit, TDD (Red → Green → Refactor), `npm run validate` green before
commit. Slices are ordered by dependency; the parallelism note marks slices
with no ordering constraint between them.

## Dependency graph

```
A object-filter      |
B protocol           |
C config             |  wave 1 — mutually independent
E registry.refresh   |
F PromisorRemote port |
L advertisesFilter   |
        │
D fetchPack (filter+promisor)        needs B
H readObject lazy-fetch              needs E, F
        │
G fetch-missing command              needs C, D, E, F
        │
I clone --filter                     needs A, C, D, L
J fetch partial-aware                needs A, C, D, L
        │
K facade (repository + barrels)      needs G, I
        │
M integration test                   needs K
N docs + backlog                      needs all
```

Wave-1 slices (A, B, C, E, F, L) are mutually independent and could be done by
parallel agents in sub-worktrees; in practice they are implemented
sequentially because the barrels (`protocol/index.ts`, `ports/index.ts`) are
shared edit points and the suite must stay green per commit.

---

## Slice A — domain object filter

Files: `src/domain/protocol/object-filter.ts` (new),
`src/domain/protocol/error.ts`, `src/domain/protocol/index.ts`,
`test/unit/domain/protocol/object-filter.test.ts` (new).

1. **Test first** — `object-filter.test.ts`: `parseObjectFilter` accepts
   `blob:none`, `blob:limit=0`, `blob:limit=100`, `blob:limit=1k`,
   `blob:limit=2M`, `blob:limit=3g`, `tree:0`, `tree:5`; rejects ``,
   `blob:limit=`, `blob:limit=-1`, `blob:limit=1x`, `blob:limit=1.5`,
   `tree:-1`, `tree:1.5`, `tree:`, `unknown:x`, `sparse:oid=HEAD`,
   `combine:blob:none`. Each rejection asserts `.data.code` ===
   `INVALID_FILTER_SPEC` **and** `.data.reason`. `formatObjectFilter`
   round-trips every accepted value to canonical form.
2. **Implement** — the `ObjectFilter` ADT, `parseObjectFilter`,
   `formatObjectFilter`. Add `INVALID_FILTER_SPEC` and
   `REMOTE_FILTER_UNSUPPORTED` to `ProtocolError` + constructor helpers.
   Export from `protocol/index.ts`.
3. **Verify** — `npm run validate`; 100 % coverage on the new file.

## Slice B — protocol filter line + capability

Files: `src/domain/protocol/upload-pack.ts`,
`src/domain/protocol/capabilities.ts`, their unit tests.

1. **Test first** — `buildUploadPackRequest` with `filter` set emits a single
   `filter <spec>\n` pkt-line positioned after `deepen`, before flush;
   without `filter` no such line; `filter` coexists with `deepen` and `have`.
   `CLIENT_CAPABILITIES_FETCH` includes `filter`; `negotiateCapabilities`
   keeps `filter` iff advertised.
2. **Implement** — `WantHaveRequest.filter?: string`; append the filter line
   in `buildUploadPackRequest`; add `'filter'` to `CLIENT_CAPABILITIES_FETCH`.
3. **Verify** — `npm run validate`.

## Slice C — config read + generalised writer

Files: `src/application/primitives/config-read.ts`,
`src/application/primitives/update-config.ts`,
`src/application/primitives/index.ts`, their unit tests.

1. **Test first** —
   - `config-read`: `[extensions] partialClone = origin` →
     `config.extensions.partialClone`; `[remote "origin"] promisor = true` /
     `partialclonefilter = blob:none` parsed onto the remote entry;
     case-insensitive keys.
   - `update-config`: `setConfigEntry` for a new section, an existing section
     without the key, an existing key (replace); subsection match is
     case-sensitive while section match is case-insensitive; control chars in
     key / value / subsection rejected. `updateConfigEntries` folds a batch.
2. **Implement** — extend `ParsedConfig` + `assembleParsed` + `mergeRemote`;
   generalise `setConfigEntry`, keep `setCoreConfigEntry` wrapper, add
   `updateConfigEntries`. Export the additions.
3. **Verify** — `npm run validate`; existing sparse-checkout config tests
   still green (regression guard on the `setCoreConfigEntry` wrapper).

## Slice E — pack-registry refresh

Files: `src/application/primitives/pack-registry.ts`, its unit test.

1. **Test first** — after `lookup` caches the scan, write a new `.idx`/`.pack`
   pair, call `refresh()`, assert the next `lookup` finds the new pack.
2. **Implement** — add `refresh(): void` to `PackRegistry`, clearing `cache`.
3. **Verify** — `npm run validate`.

## Slice F — PromisorRemote port

Files: `src/ports/promisor.ts` (new), `src/ports/context.ts`,
`src/ports/index.ts`.

1. **Test first** — type-level only; covered transitively by H and G tests.
   No standalone runtime test (a bare interface).
2. **Implement** — `PromisorRemote` + `PromisorFetchOutcome`; add
   `Context.promisor?`; export from `ports/index.ts`.
3. **Verify** — `npm run check:types`, `npm run validate`.

## Slice L — `advertisesFilter` helper

Files: `src/application/commands/internal/upload-pack-client.ts`, its test.

1. **Test first** — `advertisesFilter(['filter','ofs-delta'])` true;
   `advertisesFilter(['ofs-delta'])` false; an empty list false.
2. **Implement** — the helper (keyed token scan).
3. **Verify** — `npm run validate`.

## Slice D — fetchPack filter + promisor marker

Files: `src/application/primitives/fetch-pack.ts`, its unit test. Needs B.

1. **Test first** — `FetchPackInput.filter` reaches the request body
   (assert the captured POST body contains `filter <spec>`); `promisor: true`
   writes a zero-byte `pack-<sha>.promisor`; `promisor` unset writes none;
   the empty-pack early-return writes no `.promisor`.
2. **Implement** — add `filter?` / `promisor?` to `FetchPackInput`; thread
   `filter` into `buildUploadPackRequest`; write the sentinel in
   `writePackArtifacts`.
3. **Verify** — `npm run validate`; existing clone/fetch fetchPack tests green.

## Slice H — readObject lazy-fetch

Files: `src/application/primitives/read-object.ts`, its unit test. Needs E, F.

1. **Test first** — with a fake `ctx.promisor`:
   - miss + promisor whose `fetch` makes the object resolvable on retry ⇒
     `readObject` returns it; `registry.refresh` was used.
   - `ctx.promisor` undefined ⇒ original `OBJECT_NOT_FOUND` rethrown.
   - `promisor.fetch` reports `attempted: false` ⇒ original `OBJECT_NOT_FOUND`.
   - object still missing after retry ⇒ `OBJECT_NOT_FOUND`.
   - two concurrent `readObject` of the same missing oid ⇒ `promisor.fetch`
     invoked once (in-flight de-dup).
   - a hit (no miss) never calls `promisor.fetch`.
2. **Implement** — the try/catch retry wrapper, the per-`Context` in-flight
   `Map<ObjectId, Promise<void>>`, `registry.refresh()` before retry. Only
   retry when the error is `OBJECT_NOT_FOUND` for the requested `id`.
3. **Verify** — `npm run validate`.

## Slice G — fetch-missing command

Files: `src/application/commands/fetch-missing.ts` (new),
`src/application/commands/index.ts`,
`test/unit/application/commands/fetch-missing.test.ts` (new).
Needs C, D, E, F.

1. **Test first** —
   - no `extensions.partialClone` ⇒ `fetchMissing` throws `NO_PROMISOR_REMOTE`;
     `createPromisorRemote(ctx).fetch` returns `attempted: false`.
   - promisor configured but no `remote.<name>.url` ⇒ `REMOTE_NOT_CONFIGURED`.
   - oids already present locally are filtered out — no network call.
   - empty oid list ⇒ no-op (`fetched: 0`), no network call.
   - happy path against `MemoryHttpTransport`: missing oids fetched, pack +
     `.promisor` written, result counts correct.
   - a `FILE_EXISTS` from `fetchPack` is swallowed (concurrent identical pack).
2. **Implement** — `fetchMissingInternal` (discriminated outcome),
   `fetchMissing` (command, throws), `createPromisorRemote` (port impl).
   Add `NO_PROMISOR_REMOTE` to `src/domain/commands/error.ts`. Local-existence
   probe via a fresh `PackRegistry` + loose path. Export from the barrel.
3. **Verify** — `npm run validate`.

## Slice I — clone --filter

Files: `src/application/commands/clone.ts`, its unit test. Needs A, C, D, L.

1. **Test first** —
   - `clone({ filter: 'not-a-filter' })` throws `INVALID_FILTER_SPEC` before
     any transport call (assert the transport was never invoked).
   - server advertises no `filter` ⇒ `REMOTE_FILTER_UNSUPPORTED`.
   - happy path: `fetchPack` receives the canonical filter + `promisor: true`;
     the promisor config block (§7.3) is written verbatim.
   - non-filtered `clone` writes no `[remote]` / `[extensions]` (regression).
2. **Implement** — `CloneOptions.filter`; the flow in design §9; the config
   writer call via `updateConfigEntries`.
3. **Verify** — `npm run validate`; existing clone tests green.

## Slice J — fetch partial-aware

Files: `src/application/commands/fetch.ts`, its unit test. Needs A, C, D, L.

1. **Test first** —
   - a partial repo (config has `partialclonefilter`) ⇒ `fetch` passes the
     re-validated canonical filter + `promisor: true` to `fetchPack`.
   - a non-partial repo ⇒ `fetch` unchanged (no filter, no promisor).
   - a corrupt stored filter ⇒ `INVALID_FILTER_SPEC`.
   - partial repo + server dropped `filter` ⇒ `REMOTE_FILTER_UNSUPPORTED`.
2. **Implement** — read `remote.<name>.partialclonefilter`; re-parse;
   `advertisesFilter` check; thread into `fetchPack`.
3. **Verify** — `npm run validate`.

## Slice K — facade

Files: `src/repository.ts`, `src/application/index.ts` /
`src/application/commands/index.ts` as needed, repository unit tests.
Needs G, I.

1. **Test first** — `repo.fetchMissing` is bound and guarded
   (`REPOSITORY_DISPOSED` after dispose); `ctx.promisor` is present on an
   opened repo; `repo.clone` accepts `filter`.
2. **Implement** — add `fetchMissing` to `Repository` + `openRepository`
   binding; wire `ctx.promisor` via the late-bound `Context` (design §10).
3. **Verify** — `npm run validate`.

## Slice M — integration test

Files: `test/integration/network/partial-clone-http-backend.test.ts` (new).
Needs K.

1. Copy the `clone-source` fixture to a temp dir; `git config`
   `uploadpack.allowfilter true` + `uploadpack.allowanysha1inwant true` on the
   copy. Boot `git-http-backend` via the shared helper.
2. Assert: `clone({ filter: 'blob:none' })` ⇒ commits/trees present, blobs
   absent, promisor config + `.promisor` file written; `readBlob` lazy-fetches
   correct content; a second read hits no network; `fetchMissing([...])`
   batches; canonical git reads the lazy-filled repo without missing-object
   errors (`git -C repo log`, `git cat-file -e` on present oids).
3. **Verify** — `npm run test:integration`.

## Slice N — docs + backlog

Files: `README.md`, `RUNBOOK.md`, `DESIGN.md`, `CONTRIBUTING.md` as touched,
`docs/BACKLOG.md` (flip **17.4** `[ ]` → `[x]` with an acceptance hint).
The backlog tick travels in this PR's commits.

---

## Harness gate (after all slices)

- `npm run validate` — full gate green.
- `stryker run` — kill every killable mutant on new/changed files; document
  equivalents inline.
- Three review passes (code / perf / security / tests) — parallel agents.
</content>
