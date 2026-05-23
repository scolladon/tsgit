# Plan — `cat-file --batch` equivalent (Phase 17.6)

Derived from `docs/design/cat-file-batch.md` and ADRs 087–090. TDD
throughout: every step writes the failing test first (RED), the
minimal code to pass (GREEN), then refactors. `npm run validate`
before every commit.

## Slice graph

```
A (payloadByteLength) ─┐
                       ├─► C (catFileBatch primitive) ─► D (catFile command) ─► E (facade) ─► F (integration)
B (CatFileBatchEntry) ─┘                                                                       │
                                                                                              G (docs + BACKLOG flip)
```

A and B are independent. C depends on both. D depends on C; E on
C+D; F on E. G follows the implementation.

## Step A — `payloadByteLength` helper (`feat`)

**Files:** `src/domain/objects/size.ts` (new),
`src/domain/objects/index.ts`,
`test/unit/domain/objects/size.test.ts` (new).

1. **RED.** `size.test.ts` covers each of the four object types:
   blob → `content.byteLength`; tree (with at least one entry) →
   length of `serializeTreeContent(tree, hash)`; commit → length of
   `serializeCommitContent(commit)`; tag → length of
   `serializeTagContent(tag)`. Import `payloadByteLength` — fails to
   compile.
2. **GREEN.** `size.ts` exports
   `payloadByteLength(object: GitObject, hash: HashConfig): number`
   with a `switch (object.type)` over the four branches, each
   delegating to the existing serializer. Add the export to
   `src/domain/objects/index.ts`.
3. **Verify.** `npm run test:unit -- size` green; `npm run validate`
   green.

**Commit:** `feat(domain): payloadByteLength helper for object body size`.

## Step B — `CatFileBatchEntry` type

**Files:** `src/application/primitives/types.ts`.

Add (no standalone test — exercised by C):

```ts
export type CatFileBatchEntry =
  | {
      readonly ok: true;
      readonly id: ObjectId;
      readonly type: GitObject['type'];
      readonly size: number;
      readonly object: GitObject;
    }
  | {
      readonly ok: false;
      readonly id: ObjectId;
      readonly reason: 'missing';
    };
```

Folded into Step C's commit.

## Step C — `catFileBatch` primitive (`feat`)

**Files:** `src/application/primitives/cat-file-batch.ts` (new),
`src/application/primitives/index.ts`,
`src/application/primitives/types.ts`,
`test/unit/application/primitives/cat-file-batch.test.ts` (new).

Internal structure of `cat-file-batch.ts`:

- `async function* catFileBatch(ctx, ids): AsyncIterable<CatFileBatchEntry>`
  — public generator. Loops `for await (const id of ids …)`, checks
  `ctx.signal?.aborted` before the read and after the yield, calls
  `readOne(ctx, id)`, yields the result.
- `readOne(ctx, id): Promise<CatFileBatchEntry>` — `try { … }
  catch (err) { … }`. On success builds the `ok: true` entry using
  `payloadByteLength(object, ctx.hashConfig)`. On
  `TsgitError(OBJECT_NOT_FOUND)` returns the `ok: false` entry; any
  other thrown error rethrows.

Tests (each named `Given … When … Then …`, AAA body, `sut`
variable):

1. _Given an empty input iterable, When iterated, Then yields no
   entries._
2. _Given one stored blob id, When iterated, Then yields one entry
   with `ok: true`, the correct `type`/`size`/`object`._
3. _Given a stored tree id, Then `size` equals the serialised tree
   body length._
4. _Given a stored commit id, Then `size` equals the serialised
   commit body length._
5. _Given a stored tag id, Then `size` equals the serialised tag
   body length._
6. _Given a missing id, Then yields `{ ok: false, reason: 'missing'
   }`._
7. _Given a missing id followed by a stored id, Then yields both
   entries in input order._
8. _Given several ids with mixed hits and misses, Then `entries
   .map(e => e.id)` equals the input id sequence._
9. _Given a signal already aborted, When iterated, Then throws
   `OPERATION_ABORTED` on the first `next()`._
10. _Given a signal aborted between yields, When iteration continues,
    Then throws on the next `next()` after the abort._
11. _Given a stored object whose stored bytes do not hash to the id,
    Then propagates the resolver error (not swallowed as missing)._
12. _Given a sync `Iterable<ObjectId>`, When iterated, Then produces
    the same entries as an async one._

Step C's commit also bumps `src/application/primitives/index.ts` to
export `catFileBatch` and re-exports `CatFileBatchEntry` via the
`types` barrel.

**Commit:** `feat(primitives): catFileBatch — streaming git cat-file --batch`.

## Step D — `catFile` Tier-1 command (`feat`)

**Files:** `src/application/commands/cat-file.ts` (new),
`src/application/commands/index.ts`,
`test/unit/application/commands/cat-file.test.ts` (new).

Internal structure:

- Public `catFile(ctx, opts): Promise<CatFileResult>` — calls
  `assertRepository(ctx)`, coerces each id (string → `ObjectId.from`,
  branded passes through), drains the primitive into an array,
  returns `{ kind: 'batch', entries }`.

Tests:

1. _Given a non-repository context, When invoked, Then throws
   `NOT_A_REPOSITORY`._
2. _Given a malformed string id, Then throws `INVALID_OBJECT_ID`
   before any read happens._
3. _Given an `ObjectId` and a hex string in the same call, Then both
   are accepted and yield entries._
4. _Given a mix of stored and missing ids, Then `entries` has one
   per input, ordered, with the `ok: false` shape on misses._
5. _Given an empty `ids` array, Then returns `{ kind: 'batch',
   entries: [] }`._

**Commit:** `feat(commands): catFile — Tier-1 wrapper for catFileBatch`.

## Step E — repository facade

**Files:** `src/repository.ts`, `test/unit/repository.test.ts`.

Add the two bindings:

```ts
readonly catFile: BindCtx<typeof commands.catFile>;
// inside primitives:
readonly catFileBatch: BindCtx<typeof primitives.catFileBatch>;
```

Plus their wiring in the `openRepository` factory.

Tests:

- _Given an opened repository with a stored object, When
  `repo.catFile({ ids: [id] })` is called, Then it returns the
  expected entry._ (Smoke — exercises the binding, not the primitive
  internals.)
- _Given an opened repository and a manual `AsyncIterable`, When
  fed to `repo.primitives.catFileBatch`, Then entries stream
  through._

**Commit:** `feat(repository): wire catFile / catFileBatch to the facade`.

## Step F — partial-clone integration

**File:** `test/integration/cat-file-batch-promisor.test.ts` (new).

1. **RED.** Spin up a fixture promisor remote (mirror
   `partial-clone-http-backend.test.ts` style or use the existing
   in-memory promisor fake). Clone with `--filter=blob:none`. Pick
   a known-omitted blob id. Call `repo.catFile({ ids: [blobOid] })`.
   Expect `ok: true` — lazy fetch must have happened.
2. **GREEN.** Should pass without code changes (the primitive uses
   `readObject` which already lazy-fetches).
3. _Given an id the promisor cannot serve, When invoked, Then yields
   `{ ok: false, reason: 'missing' }` (no exception)._

**Commit:** `test(integration): cat-file batch lazy-fetches on partial clones`.

## Step G — docs + BACKLOG flip

**Files:** `README.md`, `DESIGN.md`, `docs/BACKLOG.md`,
`RUNBOOK.md` _(only if anything changed for it; expected no-op)_.

- README: add a short "Streaming batch reader" subsection under the
  primitives section showing `repo.primitives.catFileBatch` and
  `repo.catFile({ ids })`.
- DESIGN: one paragraph in the primitives section pointing at
  `docs/design/cat-file-batch.md` and the ADR range 087–090.
- BACKLOG: flip `17.6` from `[ ]` to `[x]` with an `_Accepted:_`
  paragraph mirroring the prior items' style.

**Commit:** `docs: cat-file batch — README/DESIGN/BACKLOG refresh`.

## Order of work

A → B → C → D → E → F → G. Each step ends with a green
`npm run validate`. After G, run the three review passes (code +
security + tests + perf) per the workflow, then `stryker run` and
fix surviving mutants in a single follow-up commit (preferred — keeps
the mutation gate as one diff to review).

## Self-review log

- **Pass 1** — added Step B as an explicit (folded) step so the type
  contract is reviewed before the primitive is written. Without it,
  the primitive's tests would be written against an inferred shape.
- **Pass 2** — added test case 11 (corrupt object rethrows, not
  swallowed as missing) — the design's mutation hot-spot list calls
  it out; the plan must too.
- **Pass 3** — converged (no further changes).
