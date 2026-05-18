# Plan — Phase 13.8 — Bounded object reads + parallel merge blob fetch

Design: `docs/design/phase-13-8-bounded-object-reads.md`.
ADRs: `docs/adr/024-bounded-reads-where-cap-fires.md`,
`docs/adr/025-merge-parallel-blob-reads.md`.

Branch: `feat/bounded-object-reads`.

Atomic conventional-commit per step. `npm run validate` green before
committing.

## Step 1 — Error variant `OBJECT_TOO_LARGE`

**Files touched**:

- `src/domain/objects/error.ts` — add variant + factory `objectTooLarge(id, actualSize, limit)`.
- `src/domain/error.ts` — add `extractDetail` case
  `"object too large: id=<id> size=<actualSize> limit=<limit>"`.

**Test first** (`test/unit/domain/objects/error.test.ts`, append):

- `objectTooLarge('<id>', 100, 50)` produces error with `code='OBJECT_TOO_LARGE'`,
  `id`, `actualSize=100`, `limit=50`, and the formatted message above.

**Commit**: `feat(error): add OBJECT_TOO_LARGE variant`.

## Step 2 — `ReadObjectOptions.maxBytes` plumbing

**Files touched**:

- `src/application/primitives/types.ts` — extend `ReadObjectOptions`.
- `src/application/primitives/read-object.ts` — pass `maxBytes` to
  `resolveObject`.
- `src/application/primitives/object-resolver.ts` — new
  `maxBytes` parameter on `resolveObject`. Cap fires:
  - In `finalize` (loose path) right BEFORE `parseObject` is called.
    Compare inflated buffer header's `<size>` field. To keep the
    parse free of policy, we precompute size by scanning the
    header: `<type> <size>\0`. Helper `parseLooseObjectSize(bytes)`.
  - In `collectDeltaChain`'s `isBase(header)` branch, BEFORE
    `streamInflate`: throw if `header.length > maxBytes`.
  - In `resolvePackChain`, after the apply loop, BEFORE
    `prependHeader`: throw if `current.length > maxBytes`.
- `src/application/primitives/read-blob.ts` — no change (already
  forwards options).

**Test first** (`test/unit/application/primitives/read-object.test.ts`, append):

For each branch (loose / pack base / pack delta-resolved):

- "Given a blob within the cap, When readObject is called with
  maxBytes, Then returns the Blob".
- "Given a blob one byte over the cap, When readObject is called
  with maxBytes, Then throws OBJECT_TOO_LARGE with id, actualSize, limit".
- "Given maxBytes undefined, When readObject is called, Then no
  cap applies" (regression for default behaviour).
- "Given maxBytes=0 on a non-empty blob, When readObject is called,
  Then throws OBJECT_TOO_LARGE".
- "Given maxBytes equal to size, When readObject is called, Then
  returns the Blob" (boundary).

Pack base + delta fixtures already exist in
`test/unit/application/primitives/pack-fixture.ts`; add helpers if
they don't cover an oversized base. The pack-delta-resolved fixture
needs a delta whose target size exceeds the cap — reuse the existing
delta-chain helper with a base of just over the cap.

**Helpers added** (in-file or `pack-fixture.ts`):

- Build a loose blob whose content is `n` bytes, write to ctx,
  return its `id`.
- Build a pack containing a base entry of `n` bytes.
- Build a pack containing a delta whose applied output is `n` bytes
  (base + instructions that grow the content).

**Test first** (`test/unit/application/primitives/read-blob.test.ts`, append):

- "Given maxBytes option, When readBlob is called on an oversized
  blob, Then throws OBJECT_TOO_LARGE" (passthrough).
- "Given maxBytes within bounds, When readBlob is called, Then
  returns the Blob".

**Commit**: `feat(read-object): cap with maxBytes option (Phase 13.8)`.

## Step 3 — `buildContentMerger` parallel + capped

**Files touched**:

- `src/application/commands/merge.ts` — rewrite `buildContentMerger`
  to `Promise.all` with `maxBytes: MAX_CONFLICT_OUTPUT_BYTES`.
  Import `MAX_CONFLICT_OUTPUT_BYTES` from `domain/merge`.
- Add `// equivalent-mutant: Promise.all → for-await yields the
  same output; merge is order-independent at content level.` on
  the destructure.

**Test first** (`test/unit/application/commands/merge.test.ts`, append):

- "Given two conflicting blobs each one byte over MAX_CONFLICT_OUTPUT_BYTES,
  When merge is invoked, Then throws OBJECT_TOO_LARGE before
  computing line diffs" — verify by stubbing `mergeContent` to
  throw a sentinel and asserting `OBJECT_TOO_LARGE` (not the
  sentinel) is the propagated error. Setting up 256 MiB+ blobs
  in a memory adapter is expensive; use a smaller test cap by
  injecting via a wrapper if needed, BUT the BACKLOG acceptance
  asks for the property test at MAX_CONFLICT_OUTPUT_BYTES — use
  it.
- "Given a clean three-way merge fixture, When merge runs, Then
  the three readBlob calls are issued before any resolves"
  (parallelism check). Implementation: wrap `ctx.fs.read` to
  record the order of issuance vs. resolution; assert that all
  three issue events precede the first resolve event.
- Regression: every existing merge test continues to pass.

**Commit**: `perf(merge): parallel-capped blob reads (Phase 13.8)`.

## Step 4 — Docs + BACKLOG tick

**Files touched**:

- `docs/BACKLOG.md` — flip `[ ]` to `[x]` on §13.7 (correction)
  and §13.8 (new).
- `README.md` — if the `readObject` option is publicly surfaced
  (it is — `repo.readBlob` is on the public Tier-1 surface), add
  a one-line note. Check `MIGRATION.md` for option-additivity
  language.

**Commit**: `docs: tick BACKLOG §13.7 + §13.8, document maxBytes`.

## Step 5 — Reviews × 3

Four parallel reviewers per pass: typescript-reviewer, security-reviewer,
perf review (general-purpose), test-quality review (general-purpose).
Fix every HIGH each pass. Re-run after each fix round.

## Step 6 — Harness + mutation

- `npm run validate` (14/14 gates).
- `npx stryker run` scoped to:
  - `src/application/primitives/object-resolver.ts`
  - `src/application/primitives/read-object.ts`
  - `src/application/primitives/types.ts`
  - `src/application/commands/merge.ts`
  - `src/domain/objects/error.ts`
- Kill every killable mutant; mark equivalent inline with
  `// equivalent-mutant: <why>`.

## Step 7 — Push + PR

- `git push -u origin feat/bounded-object-reads`
- `gh pr create` with summary covering:
  - readObject({ maxBytes }) addition + OBJECT_TOO_LARGE
  - buildContentMerger parallel + capped
  - §13.7 BACKLOG tick correction
- Squash-merge on green.

## Sequencing rationale

- Step 1 first: every later step needs the error variant.
- Step 2 before Step 3: the merger relies on `maxBytes`. Wiring it
  first makes Step 3 a tiny, focused commit.
- Step 4 in the same PR (not as a follow-up).
- Reviews after implementation lock in but BEFORE harness so we don't
  waste mutation cycles on doomed code.
- Mutation last: it's the most expensive gate and the most likely
  to surface late edits.

## Self-review log

### Pass 1 → Pass 2

- Step 2 originally proposed extending `parseObject` with a size
  cap. ADR-024 rejects this; pulled the cap into the resolver as
  three distinct sites. The plan now matches the design.
- Step 3 originally lumped the parallelisation and the cap together
  in one commit. Split: Step 2 lands the cap (and the unit tests
  prove it), Step 3 wires it into the merger. Atomic-commit
  discipline.

### Pass 2 → Pass 3

- Added the "boundary" tests at `size === maxBytes` and
  `maxBytes === 0`. Without them, off-by-one mutants in the `>`
  comparator survive.
- Step 4 added — without an explicit BACKLOG-tick step, the
  squash-merge could drop it (see §13.7 history).
- Step 3 clarifies the parallelism assertion. A naïve "the three
  calls fire concurrently" test that only checks return order
  doesn't distinguish parallel from sequential when reads are
  near-instant. The issuance-before-first-resolve assertion is
  precise.

### Pass 3 → final

- The 256 MiB property test (BACKLOG acceptance) is named
  explicitly in Step 3. Without it, a reviewer or future
  maintainer would assume the cap test is implicit in the unit
  cases and never validate end-to-end.
- `pack-fixture.ts` helper additions called out as a sub-task in
  Step 2; without explicit scope they'd be invisible to the diff
  and confuse PR review.
