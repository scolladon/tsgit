# Plan — `bundle` (create / verify / list-heads)

> Source: design doc `docs/design/bundle.md` · ADRs 420–428
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Plan-wide notes (read before any part)

- **Layering is strict** (`check:architecture` gate): `domain/bundle/*` is pure (it
  may import only other `domain/*`); the new primitive lives in
  `src/application/primitives/` (may import `domain` + `ports` + sibling primitives);
  the commands live in `src/application/commands/` (may import primitives + domain);
  the facade is `src/repository.ts`. Domain never imports outward.
- **Per-part gate is the light triple** below — `npm run validate` (which includes
  `check:dead-code`, `check:exports`, `check:architecture`, `test:coverage`,
  `test:integration`, `test:parity`, `check:doc-coverage`, browser-surface) runs only at
  the **phase boundary**. Because `check:dead-code` is in validate, an export with no
  in-`src` consumer is only red at phase end, not at a part boundary — so a foundation
  part (P1/P2) may carry exports whose consumer lands in a later part. By P6 every
  export is wired, so phase-boundary validate is green.
- **`reports/api.json` is a `prepush` gate, not a validate gate** — it is regenerated
  **once**, in P5 (the part that makes the public surface final), via `npm run docs:json`
  and committed. Earlier parts that touch the exported `CommandError` union do NOT
  regenerate it (the shared sequential tree means one regen at P5 captures everything).
- **Two faithfulness corrections the implementer must honour over the design prose**
  (prime directive — verify against real `git`, pin in the P6 interop test):
  1. **Prerequisite comment uses `subjectLine`, not `foldSubject`.** `git bundle` writes
     the prerequisite subject via `find_commit_subject` = the first line of the commit
     body (terminated by a single `\n`), which is `subjectLine` in
     `src/domain/objects/commit-message.ts` (NOT `foldSubject`, which is `%s`/
     `format_subject` and folds the whole leading paragraph). The §4.1b goldens use
     single-line subjects so both agree; P6 adds a multi-line-subject prerequisite golden
     to disambiguate, and the implementer uses `subjectLine`. If real `git` disagrees,
     follow real `git`.
  2. **`create` cannot reuse `enumeratePushObjects` for the object closure.**
     `enumeratePushObjects` walks the FULL tree of every interesting commit and emits all
     blobs/trees, with NO exclusion of objects reachable from `haves` — it over-includes
     any unchanged blob/subtree that is also reachable from a prerequisite. `git bundle`
     EXCLUDES those (§4.1: "Blobs reachable from the prerequisite are absent"), and the
     object-set parity pin (§10 #3) compares oid SETS. So P2 introduces a NEW primitive
     that performs a faithful `rev-list --objects --boundary --not <haves>` (mark the
     uninteresting object+commit closure reachable from `haves`, then emit interesting
     objects minus that set AND collect boundary commits). This is ADR-424's ratified
     "compute the packed object set and the prerequisites in one traversal".

## Part 1 — Domain bundle-header codec + bundle error codes

### Context

Pure-domain serialize/parse pair plus the four discriminated error codes. No
application/ports imports.

New files under `src/domain/bundle/`:
- `types.ts` — domain types reused by the codec and (later) the commands:
  - `export type BundleVersion = 2 | 3;`
  - `export type BundleHashAlgorithm = 'sha1';`
  - `export interface BundleRef { readonly oid: ObjectId; readonly name: RefName; }`
    (`ObjectId`/`RefName` from `../objects/object-id.js`; `name` may be the `'HEAD'`
    literal cast to `RefName`).
  - `export interface BundlePrerequisite { readonly oid: ObjectId; readonly comment: string; }`
  - `export interface ParsedBundleHeader { readonly version: BundleVersion; readonly hashAlgorithm: BundleHashAlgorithm; readonly prerequisites: ReadonlyArray<BundlePrerequisite>; readonly refs: ReadonlyArray<BundleRef>; readonly packOffset: number; }`
- `serialize-bundle-header.ts` —
  `export const serializeBundleHeader = (input: { readonly version: BundleVersion; readonly prerequisites: ReadonlyArray<BundlePrerequisite>; readonly refs: ReadonlyArray<BundleRef> }): Uint8Array`.
  Emits, as UTF-8: `# v2 git bundle\n`; then one `-<40-hex-oid> <comment>\n` per
  prerequisite **sorted by oid ascending** (sort here so callers cannot forget — §3,
  §4.1b); then one `<40-hex-oid> <name>\n` per ref **in the order given** (the command
  pre-orders them); then a single `\n`. Refs/prereqs serialise oids verbatim (already
  40-hex) and names/comments verbatim. (This slice only ever serialises v2; reject a v3
  input here is unnecessary — `create` never builds v3.)
- `parse-bundle-header.ts` —
  `export const parseBundleHeader = (bytes: Uint8Array, path: string): ParsedBundleHeader`.
  Pure parse; `path` is **error-context data only** (precedent: `configParseError(line,
  source)` threads a source label into a domain parser). Decode the leading text up to
  and including the blank-line `\n`; `packOffset` = byte index immediately after that
  blank-line `\n`. Magic-line rules (§3, §4.3):
  - `# v2 git bundle` → `version: 2`, `hashAlgorithm: 'sha1'`.
  - `# v3 git bundle` (any v3) → throw `bundleUnsupportedVersion(path, 3)` (the one
    sanctioned divergence — ADR-423; git 2.54.0 reads forced v3-sha1, tsgit refuses).
  - anything else (not `# v<n> git bundle`), or structurally malformed (no blank line, a
    `-`/ref line that is not `<40-hex>( <rest>)?`) → throw `bundleBadHeader(path, reason)`
    with `reason` a short tag (`'not-a-bundle' | 'malformed-header'`).
  Prereq lines: leading `-`, then 40-hex oid, then a space, then the (possibly empty)
  comment to end-of-line. Ref lines: 40-hex oid, space, full refname (or `HEAD`) to
  end-of-line. v2 carries no `@`-capability lines (those are v3 only) — a `@`-line under
  a v2 magic is `malformed-header`.
- `index.ts` — barrel re-exporting the types + `serializeBundleHeader` +
  `parseBundleHeader` (internal barrel; NOT wired into the package entry — these codec
  functions stay library-internal).

Error codes — edit `src/domain/commands/error.ts` (the `CommandError` union + factories,
`TsgitError` from `../error.js`):
- Add four union members (place near the other read/refusal members):
  - `{ readonly code: 'BUNDLE_EMPTY'; readonly reason: 'no-refs' | 'no-objects' }`
  - `{ readonly code: 'BUNDLE_READ_FAILED'; readonly path: string }`
  - `{ readonly code: 'BUNDLE_BAD_HEADER'; readonly path: string; readonly reason: string }`
  - `{ readonly code: 'BUNDLE_UNSUPPORTED_VERSION'; readonly path: string; readonly version: number }`
- Add factories (mirror existing one-liners; `path`/`reason` sanitised via the existing
  `sanitizeForDisplay` where they carry caller-influenced text — `path` is caller data,
  sanitise it):
  - `export const bundleEmpty = (reason: 'no-refs' | 'no-objects'): TsgitError`
  - `export const bundleReadFailed = (path: string): TsgitError` (sanitise `path`)
  - `export const bundleBadHeader = (path: string, reason: string): TsgitError`
  - `export const bundleUnsupportedVersion = (path: string, version: number): TsgitError`

Exhaustiveness — edit `test/unit/domain/exhaustiveness.ts`: add the four new codes as
`case` arms before the `return;` (the `assertExhaustiveSwitch(data: TsgitErrorData)`
switch is the single type-level gate over the whole union; omitting one is a compile
error in `check:types`).

**Public-surface decision.** The four error codes are PUBLIC (members of the exported
`CommandError`/`TsgitErrorData` union) → they trip the exhaustiveness switch (pre-paid
here) and will change `reports/api.json` (regenerated once in P5 — not here). The
`domain/bundle` types are library-INTERNAL here (they become public only when P5's
command barrel re-exports them). The codec functions stay internal forever.

Tests (fold in):
- `src/domain/bundle/serialize-bundle-header.test.ts` + `parse-bundle-header.test.ts`
  (example/literal-byte): hand-built `BundleRef`/`BundlePrerequisite` arrays with fixed
  40-hex oids → assert EXACT serialized bytes (magic, oid-sorted `-` lines, ref lines in
  given order, blank line); `parseBundleHeader` of those bytes → the structure +
  `packOffset` at the post-blank index; bad magic → `bundleBadHeader` (assert
  `.data.code` AND `.data.reason`); `# v3 git bundle…` → `bundleUnsupportedVersion`
  (assert `.data.version === 3`); a `-`/ref line with a non-hex oid → `bundleBadHeader`.
  Use try/catch + direct `.data` assertions (not bare `toThrow(Class)`) per the
  mutation-resistant convention.
- `src/domain/bundle/bundle-header.properties.test.ts` (round-trip lens, ADRs 134–136):
  arbitrary well-formed header `{ version: 2, prerequisites, refs }` over the ASCII
  40-hex-oid / refname grammar (shared `arbitraries.ts` in the same dir) →
  `parseBundleHeader(serializeBundleHeader(h), 'x.bundle')` ≡ `h` modulo
  prerequisite oid-sort canonicalisation; plus the count invariant: number of `-` lines
  === `prerequisites.length`. `numRuns: 200` (cheap round-trip).
- `test/unit/domain/commands/error.test.ts`: add per-factory `.data`-shape tests for the
  four new factories (mirror the existing `Given the <factory> error helper` blocks),
  asserting the full `.data` object.

`Given/When/Then` describe tree, AAA body, `sut` = the function under test.

### TDD steps

- RED: write the serialize example test with fixed inputs and the exact expected bytes →
  fails (`serializeBundleHeader` undefined / module missing).
- RED: write the parse example tests (round of bad-magic, v3, malformed) → fail
  (`parseBundleHeader`/factories undefined).
- RED: add the four factory `.data` tests + the four exhaustiveness `case` arms → factory
  tests fail (undefined factories) and `check:types` fails until the union members exist.
- GREEN: add the union members + factories in `error.ts`; implement `types.ts`,
  `serialize-bundle-header.ts`, `parse-bundle-header.ts`, `index.ts`; add the
  exhaustiveness arms.
- RED→GREEN: add the property + count-invariant test; make it pass.
- REFACTOR: extract a small `decodeHeaderLines` / `splitAtBlankLine` helper if
  `parseBundleHeader` exceeds ~20 lines or nests >2; keep functions pure and early-return;
  ensure no magic numbers (name `HEX_OID_LENGTH = 40`).

### Gate

`npx vitest run src/domain/bundle test/unit/domain/commands/error.test.ts test/unit/domain/exhaustiveness.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/bundle src/domain/commands/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/commands/error.test.ts`

### Commit

`feat: bundle header codec and error codes`

## Part 2 — Primitive: faithful bundle object + boundary enumeration

### Context

The ADR-424 primitive: a single traversal that returns BOTH the exact pack object set
AND the boundary (prerequisite) commits, implementing
`git rev-list --objects --boundary <wants> --not <haves>`. **Do NOT reuse
`enumeratePushObjects`** — it over-includes objects reachable from `haves` (see plan-wide
note 2); object-set parity (§10 #3) requires exact exclusion.

New file `src/application/primitives/enumerate-bundle-objects.ts` (INTERNAL — imported
directly by P3's `bundle-create.ts`, like `archive.ts` imports `../primitives/read-blob.js`;
no primitives-barrel entry, no facade, no public gate):

```ts
export interface EnumerateBundleObjectsInput {
  readonly wants: ReadonlyArray<ObjectId>;   // positive endpoints (commit or annotated-tag oid)
  readonly haves: ReadonlyArray<ObjectId>;   // exclude/merge-base oids (commits)
  readonly maxObjects?: number;              // default MAX_PUSH_OBJECTS from ./types.js
}
export interface BundleObjectClosure {
  readonly objects: ReadonlyArray<ObjectId>;   // exact pack set: tags + commits + trees + blobs
  readonly boundary: ReadonlyArray<ObjectId>;  // boundary commit oids (prerequisites, UNSORTED — caller sorts)
}
export const enumerateBundleObjects = (
  ctx: Context, input: EnumerateBundleObjectsInput,
): Promise<BundleObjectClosure>;
```

Algorithm (faithful):
1. **Uninteresting closure from `haves`.** Walk commits reachable from `haves` to their
   full ancestor closure via `walkCommits(ctx, { from: haves, ignoreMissing: true })`
   (from `./walk-commits.js`, `WalkCommitsOptions` from `./types.js`); collect those
   commit oids into `uninterestingCommits: Set<ObjectId>`. For each, walk its tree via
   `walkTree(ctx, commit.data.tree, { recursive: true })` (from `./walk-tree.js`),
   collecting the tree oid + every entry oid (skip gitlinks via `isGitlink` from
   `./validators.js`) into `uninterestingObjects: Set<ObjectId>`; also add each commit oid
   and its tree oid to `uninterestingObjects`. (If `haves` is empty, both sets are empty —
   the whole-history case, e.g. `--all`.)
2. **Interesting walk.** For each `want`, follow the annotated-tag chain (tag → tag → …
   → commit), emitting each tag oid as an interesting object (mirror
   `enumeratePushObjects`'s `resolveTagChain`/`readObject` pattern — extract the helper
   into a shared internal module if convenient, else re-derive; cap the chain at 16 like
   the original), yielding the terminal commit oid as the commit-walk seed.
   `walkCommits(ctx, { from: seeds, until: [...uninterestingCommits], ignoreMissing: true })`
   — note `until` is the FULL uninteresting commit closure (not just the exclude tips), so
   the walk stops correctly even across criss-cross merges. For each yielded interesting
   commit: emit the commit oid, its tree oid, and every non-gitlink tree-entry oid (via
   `walkTree`) **iff not in `uninterestingObjects`**. **Boundary collection:** for each
   parent of an interesting commit, if the parent ∈ `uninterestingCommits`, record it in
   `boundary` (dedup). Enforce the `maxObjects` cap exactly like `enumeratePushObjects`
   (throw `PACK_TOO_LARGE` before exceeding).
3. Return `{ objects: [...emitted], boundary: [...boundarySet] }`.

Reused symbols (verified): `walkCommits` (`./walk-commits.js`), `walkTree`
(`./walk-tree.js`), `readObject` (`./read-object.js`), `isGitlink` (`./validators.js`),
`MAX_PUSH_OBJECTS` + `WalkCommitsOptions` (`./types.js`), `TsgitError` / `PACK_TOO_LARGE`
shape (`../../domain/error.js`), `ObjectId` (`../../domain/objects/index.js`).

Faithfulness pins this part owns (unit-level, in-memory repos — no `git` spawn here; real
`git` parity is P6):
- **Exclusion discriminator** (the test that proves this is NOT `enumeratePushObjects`):
  a repo `first(f0=A) → second(f0=A, f1=B) → third(f0=A, f1=B, f2=C)`, `wants=[third]`,
  `haves=[first]` → `objects` set is exactly `{commit3, commit2, tree3, tree2, blobB,
  blobC}` and **excludes `blobA`** (reachable from `first`); `boundary === [first]`.
- **Whole history**: `haves=[]` → `objects` = full closure of `wants` (commits+trees+
  blobs+any tag objects), `boundary === []`.
- **Three-dot single merge-base**: build `first → {second-on-main, feature}`; call with
  `wants=[main, feature]`, `haves=[mergeBase]` → boundary `=== [first]`; objects exclude
  `first`'s objects.
- **Criss-cross two merge-bases**: build the criss-cross (O → A, B; M1=merge(A,B);
  M2=merge(A,B)); `wants=[M1]`, `haves=[A, M2]` → `boundary` set `=== {A, B}` (B is
  uninteresting via M2 even though only A and M2 were passed) — this is the case the
  naive exclude-tips approach gets wrong; objects exclude everything reachable from A and
  M2.
- **Annotated tag want**: `wants=[tagOid]` (annotated tag → commit), `haves=[]` → objects
  include the tag object oid AND the commit/tree/blobs.

Tests live in `src/application/primitives/enumerate-bundle-objects.test.ts`. (App-layer
code is outside the 100%-line-coverage gate — domain/adapters only — but IS under Stryker
mutation in CI; write isolated, data-asserting tests per the mutation-resistant
conventions: separate tests per boundary/exclusion case, assert oid sets via sorted
arrays, kill loop/guard mutants.) A property sibling is OPTIONAL here and likely a
tautology (the oracle would re-implement the walk) — skip it (lens 4's "oracle = verbatim
SUT" exclusion); the example topologies above are the right coverage.

### TDD steps

- RED: write the exclusion-discriminator test (in-memory repo seeded via existing object/
  commit write helpers used by sibling primitive tests) → fails (module missing).
- RED: add whole-history, three-dot, criss-cross, and annotated-tag tests → fail.
- GREEN: implement the two-phase algorithm; make all pass. Keep each phase a small named
  helper (`collectUninteresting`, `walkInteresting`) under 20 lines; early returns.
- REFACTOR: dedupe the tag-chain helper against `enumerate-push-objects.ts` if a clean
  shared extraction exists; otherwise leave a focused local. No mutable shared state
  beyond the local Sets; no magic numbers.

### Gate

`npx vitest run src/application/primitives/enumerate-bundle-objects.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/enumerate-bundle-objects.ts src/application/primitives/enumerate-bundle-objects.test.ts`

### Commit

`feat: faithful bundle object and boundary enumeration`

## Part 3 — Command: `bundleCreate`

### Context

The producer (ADR-422): resolve the full rev grammar (ADR-421) by composing existing rev
machinery (NO new rev-string parser), compute the object closure + boundary via P2,
assemble header ++ pack, return bytes + metadata.

New file `src/application/commands/bundle-create.ts` (INTERNAL until P5 barrels it):

```ts
export type BundleRevArg =
  | { readonly tip: string }
  | { readonly exclude: string }
  | { readonly range: readonly [string, string] }
  | { readonly symmetricRange: readonly [string, string] };
export interface BundleCreateOptions {
  readonly revs?: ReadonlyArray<BundleRevArg>;
  readonly all?: boolean;
  readonly branches?: boolean;
  readonly tags?: boolean;
}
export interface BundleCreateResult {
  readonly version: BundleVersion;            // always 2
  readonly bytes: Uint8Array;                 // header ++ packfile
  readonly refs: ReadonlyArray<BundleRef>;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;  // oid-sorted
  readonly objectCount: number;
  readonly packSha: string;
}
export const bundleCreate = (ctx: Context, opts: BundleCreateOptions): Promise<BundleCreateResult>;
```

Imports: `serializeBundleHeader`, types from `../../domain/bundle/index.js`;
`bundleEmpty` from `../../domain/commands/error.js`; `buildPack` from
`../primitives/build-pack.js` (`buildPack(ctx, { oids }) → { bytes, sha, objectCount }`);
`enumerateBundleObjects` from `../primitives/enumerate-bundle-objects.js` (P2);
`enumerateRefs` from `../primitives/enumerate-refs.js` (`(ctx) → ReadonlyArray<RefName>`,
includes HEAD + loose + packed); `resolveRef` from `../primitives/resolve-ref.js`
(resolves a full ref to its DIRECT oid — tag-object oid for an annotated tag, unpeeled);
`revParse` from `./rev-parse.js`; `refCandidates` from `../../domain/refs/index.js` (the
DWIM candidate list — same precedence `revParse`'s `resolveBase` uses); `peel` from
`../primitives/internal/peel.js` (`peel(ctx, oid, 'commit')`); `mergeBase` from
`../primitives/merge-base.js` (`mergeBase(ctx, [a, b], { all: true }) → readonly
ObjectId[]`); `subjectLine` from `../../domain/objects/commit-message.js`; `readObject`
(`../primitives/read-object.js`) to fetch a boundary commit's message; `assertRepository`
from `./internal/repo-state.js` (the `archive` repo-state gate precedent).

Resolution algorithm (faithful to §4, §8.2; preserve ordering exactly):
1. `await assertRepository(ctx)`.
2. **Ref-line + want/have accumulation, in list order.** Maintain ordered `refLines:
   BundleRef[]`, `wants: ObjectId[]`, `haves: ObjectId[]`.
   - **Ref DWIM helper** `resolveTipRef(expr) → { name: RefName; oid: ObjectId } | undefined`:
     for `candidate` of `refCandidates(expr)`, `try { oid = await resolveRef(ctx,
     candidate); return { name: candidate, oid } } catch {}`; return `undefined` if none
     resolves. (`'HEAD'` is a candidate → `repo.bundle.create` of `HEAD` yields a `HEAD`
     ref line, §4.1.)
   - `{ tip }`: `ref = resolveTipRef(tip)`. If `ref` → push `{ oid: ref.oid, name:
     ref.name }` to `refLines` and `ref.oid` to `wants`. Else (bare rev/oid) → `oid =
     await revParse(ctx, tip)`; push `oid` to `wants`; **no ref line** (§4.2 middle row).
   - `{ exclude }`: `oid = await revParse(ctx, exclude)`; `haves.push(await peel(ctx, oid,
     'commit'))`; no ref line.
   - `{ range: [a, b] }`: `aOid = await revParse(ctx, a)`; `haves.push(peel(aOid,
     'commit'))`. `b` handled exactly like `{ tip: b }` (ref line iff `b` DWIMs to a ref).
     (`A..B ≡ ^A B`, §4.1.)
   - `{ symmetricRange: [a, b] }`: handle `a` then `b` each like `{ tip }` (ref lines in
     argument order a-then-b iff each DWIMs to a ref; their oids → `wants`). Compute
     `bases = await mergeBase(ctx, [peel(aOid,'commit'), peel(bOid,'commit')], { all: true
     })` and push every base into `haves` (the merge-base frontier, §4.1b).
3. **Pseudo-ref flags** (after `revs`; expansions sorted, HEAD last only for `--all`):
   from `enumerateRefs(ctx)`, partition HEAD vs the `refs/*` names. `all` → every
   `refs/*` name sorted by full refname, each `resolveRef`'d (annotated tags keep the
   tag-object oid) → ref lines + wants; then append a `HEAD` ref line + want LAST.
   `branches` → the sorted `refs/heads/*` subset (no HEAD). `tags` → the sorted
   `refs/tags/*` subset (no HEAD). (Confirm against §4.1 whether `enumerateRefs` already
   yields `HEAD`; if so, exclude it from the `refs/*` partition and re-add per `--all`
   only.)
4. **Refuse no-refs FIRST:** if `refLines.length === 0` → `throw bundleEmpty('no-refs')`
   (§8.2 step 4 — even when objects exist; covers "no rev args" and "bare-rev-only tip").
5. `{ objects, boundary } = await enumerateBundleObjects(ctx, { wants, haves })`.
6. **Refuse no-objects:** if `objects.length === 0` → `throw bundleEmpty('no-objects')`
   (§8.2 step 5; e.g. `main..main`).
7. **Prerequisites:** for each boundary commit oid, read its commit
   (`readObject`), `comment = subjectLine(commit.data.message)` (plan-wide note 1).
   Build `BundlePrerequisite[]` **sorted by oid ascending** (§3, §4.1b).
   (`serializeBundleHeader` also sorts — sorting here keeps the returned `prerequisites`
   field consistent with the bytes.)
8. `pack = await buildPack(ctx, { oids: objects })`.
9. `header = serializeBundleHeader({ version: 2, prerequisites, refs: refLines })`;
   `bytes = concat(header, pack.bytes)`. Return `{ version: 2, bytes, refs: refLines,
   prerequisites, objectCount: pack.objectCount, packSha: pack.sha }`.

An unknown `tip`/`exclude`/range endpoint propagates `revParse`'s `REVPARSE_UNRESOLVED` /
`REVPARSE_AMBIGUOUS` (matches git `fatal: ambiguous argument …`, §4.2) — do NOT catch it.
No file is ever written (producer-returns-bytes; "no output on refusal" is automatic).

**Public-surface decision.** `bundleCreate` + its types are PUBLIC (P5 barrels them);
nothing public lands HERE (no barrel/facade yet) so no surface gate fires in this part —
the api.json regen is deferred to P5.

Tests (fold in) — `src/application/commands/bundle-create.test.ts`, in-memory repos,
structural/ordering assertions (literal real-`git` byte goldens are P6):
- `--all` on a repo with branches + a lightweight tag + an annotated tag: assert the
  header (slice `bytes` up to the `PACK` signature, parse via `parseBundleHeader`) has ref
  lines sorted by refname with `HEAD` last, the annotated tag's ref line carries the
  **tag-object** oid (resolve it independently and compare), `prerequisites === []`,
  `objectCount === pack`.
- Explicit `{ revs: [{ tip: 'refs/heads/main' }, { tip: 'refs/heads/feature' }] }`: ref
  lines in argument order (main then feature), no sort.
- `{ revs: [{ tip: 'HEAD' }] }` → exactly one `HEAD` ref line.
- Two-dot `{ revs: [{ range: ['main~2', 'main'] }] }`: one `refs/heads/main` ref line, one
  oid-sorted prerequisite (= `main~2`) whose `comment === subjectLine` of that commit; the
  pack excludes the prerequisite's blobs (assert `objectCount` matches the P2 closure).
- `^`-exclusion `{ revs: [{ tip: 'main' }, { exclude: 'main~2' }] }` → header byte-equal to
  the two-dot case (`A..B ≡ ^A B`).
- Three-dot `{ revs: [{ symmetricRange: ['main', 'feature'] }] }` (diverging at a base):
  both `main` and `feature` ref lines (argument order), prerequisite = the merge-base,
  oid-sorted.
- Refusals (try/catch + `.data` assertions, isolated per guard): no args → `BUNDLE_EMPTY`
  `reason: 'no-refs'`; `{ revs: [{ tip: 'main~1' }] }` (bare rev, names no ref) →
  `'no-refs'`; `{ revs: [{ range: ['main', 'main'] }] }` → `'no-objects'`; `{ revs: [{ tip:
  'nonexistent' }] }` → propagated `REVPARSE_*` (assert its `.data.code`).

### TDD steps

- RED: write the `--all` ordering + annotated-tag-oid test → fails (module missing).
- RED: explicit-order, HEAD, two-dot, `^`-equivalence, three-dot tests → fail.
- RED: the four refusal tests (isolated) → fail.
- GREEN: implement `resolveTipRef`, the per-arg desugar, the pseudo-ref expansion, the two
  ordered refusals, prerequisite build, and the assemble step.
- REFACTOR: extract `resolveSelection(ctx, opts) → { refLines, wants, haves }` and
  `buildPrerequisites(ctx, boundary)` so `bundleCreate` stays a thin orchestrator (<20
  lines); early returns; no boolean params; named constants.

### Gate

`npx vitest run src/application/commands/bundle-create.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/bundle-create.ts src/application/commands/bundle-create.test.ts`

### Commit

`feat: bundle create command`

## Part 4 — Commands: `bundleVerify` + `bundleListHeads` (path-reading consumers)

### Context

The consumers (ADR-428): take `{ path }`, the library opens/reads via `ctx.fs` and owns
the open/read refusal; `verify` additionally does a FULL embedded-pack parse (ADR-427);
`listHeads` is header-only.

**Export the pack-parse helpers** — edit `src/application/primitives/fetch-pack.ts`: add
the `export` keyword to the two existing module-internal helpers `verifyPackTrailer`
(`(packBytes: Uint8Array, ctx: Context) => Promise<string>`) and `walkPackEntries`
(`(ctx: Context, packBytes: Uint8Array) => Promise<ReadonlyArray<{ id; crc32; offset }>>`).
No logic change (behaviour-preserving — `fetchPack`'s existing tests stay green);
`walkPackEntries` internally inflates AND resolves every entry, so the two together are
the "full parse". They become cross-module-internal (consumed by `bundle-verify.ts`); no
barrel/public gate.

New file `src/application/commands/internal/read-bundle.ts` — shared open/parse helper:
```ts
export interface OpenedBundle { readonly header: ParsedBundleHeader; readonly packBytes: Uint8Array; }
export const readBundle = (ctx: Context, path: string): Promise<OpenedBundle>;
```
- `let bytes; try { bytes = await ctx.fs.read(path); } catch (err) { … }` — map the
  read-failure KIND (§4.3, §9): `FILE_NOT_FOUND` → `throw bundleReadFailed(path)`;
  `PERMISSION_DENIED` is AMBIGUOUS because the Node adapter maps **both** `EACCES` and
  `EISDIR` to `PERMISSION_DENIED` (verified in `src/adapters/node/node-file-system.ts`) —
  so on `PERMISSION_DENIED`, `stat` the path: `(await ctx.fs.stat(path)).isDirectory` →
  `throw bundleBadHeader(path, 'not-a-bundle')` (git: a directory "does not look like a v2
  or v3 bundle file"); else (a genuinely unreadable file) → `throw bundleReadFailed(path)`
  (git "could not open"). Re-throw any non-`TsgitError`/unexpected code unchanged (no
  swallowing). This reproduces git's split: missing/unreadable → `could not open`;
  directory/non-bundle → `does not look like…`.
- `header = parseBundleHeader(bytes, path)` (throws `bundleBadHeader` on bad/short magic,
  `bundleUnsupportedVersion` on v3 — already path-bearing).
- `packBytes = bytes.subarray(header.packOffset)`; return `{ header, packBytes }`.

New file `src/application/commands/bundle-verify.ts`:
```ts
export interface BundleVerifyInput { readonly path: string; }
export interface BundleVerifyResult {
  readonly version: BundleVersion;
  readonly hashAlgorithm: BundleHashAlgorithm;
  readonly refs: ReadonlyArray<BundleRef>;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;
  readonly missingPrerequisites: ReadonlyArray<ObjectId>;
  readonly prerequisitesPresent: boolean;
  readonly recordsCompleteHistory: boolean;
}
export const bundleVerify = (ctx: Context, input: BundleVerifyInput): Promise<BundleVerifyResult>;
```
- `{ header, packBytes } = await readBundle(ctx, input.path)`.
- **Full pack parse (ADR-427):** `await verifyPackTrailer(packBytes, ctx)` then `await
  walkPackEntries(ctx, packBytes)`; discard the results — a corrupt entry body or a bad
  trailer throws a pack-malformation `TsgitError` (`INVALID_PACK_*` / `INVALID_DELTA`),
  which propagates as the verify failure (§9 "distinct from a malformed header"). Do NOT
  wrap it in a `BUNDLE_` code; do NOT swallow.
- **Prerequisite presence (CQS query, ADR-425):** for each `header.prerequisites[i].oid`,
  probe local presence (`readObject` from `../primitives/read-object.js`, catching only
  `OBJECT_NOT_FOUND` → missing; rethrow other errors); collect `missingPrerequisites`.
  `prerequisitesPresent = missingPrerequisites.length === 0`; `recordsCompleteHistory =
  header.prerequisites.length === 0`. Missing prereqs are NOT a thrown error.
- Return the structured result (oids/refs from the HEADER; the pack parse is only the
  well-formedness gate, §4.3).

New file `src/application/commands/bundle-list-heads.ts`:
```ts
export interface BundleListHeadsInput { readonly path: string; readonly names?: ReadonlyArray<RefName>; }
export interface BundleListHeadsResult { readonly version: BundleVersion; readonly refs: ReadonlyArray<BundleRef>; }
export const bundleListHeads = (ctx: Context, input: BundleListHeadsInput): Promise<BundleListHeadsResult>;
```
- `{ header } = await readBundle(ctx, input.path)` — **header-only; the pack is never
  touched** (§4.4).
- Filter `header.refs` by **exact full-name string equality** against `input.names` when
  provided (`strcmp(ref.name, pattern)`; §4.4 — `refs/tags/v1.0` matches, `v1.0`/
  `tags/v1.0`/`main` do not). No filter → all refs in header order. Return `{ version,
  refs }`.

Imports recap: `readBundle` + the codec types from `../../domain/bundle/index.js`;
`bundleReadFailed`/`bundleBadHeader` from `../../domain/commands/error.js`;
`verifyPackTrailer`/`walkPackEntries` from `../primitives/fetch-pack.js`; `readObject`
from `../primitives/read-object.js`; `ObjectId`/`RefName` from
`../../domain/objects/object-id.js`; `OBJECT_NOT_FOUND` shape from
`../../domain/objects/error.js`. `ctx.fs.read`/`ctx.fs.stat` per `src/ports/file-system.ts`
(`stat` returns `FileStat` with `isDirectory`).

**Public-surface decision.** `bundleVerify`/`bundleListHeads` + their types are PUBLIC (P5
barrels them); the exported `verifyPackTrailer`/`walkPackEntries` are internal-only. No
surface gate fires in this part.

Tests (fold in) — in-memory repos; round-trip against P3's `bundleCreate` output (write
the bytes to a memory path, then read):
- `bundle-verify.test.ts`: create an `--all` bundle, write bytes to a memory fs path,
  `verify` → `recordsCompleteHistory === true`, `prerequisitesPresent === true`,
  `missingPrerequisites === []`, `hashAlgorithm === 'sha1'`, refs match. A range bundle
  verified in a repo that HAS the prerequisite → `prerequisitesPresent true`; the SAME
  bundle bytes verified in a fresh empty repo → `prerequisitesPresent false` +
  `missingPrerequisites` contains the boundary oid (CQS, no throw). A bytes buffer whose
  pack region has a flipped post-magic byte (trailer left stale) → `verify` THROWS a
  pack-malformation (assert it is NOT a `BUNDLE_` code). Refusals via `readBundle`:
  missing path → `BUNDLE_READ_FAILED` (`.data.path`); a directory path → `BUNDLE_BAD_HEADER`;
  a plain-text non-bundle file → `BUNDLE_BAD_HEADER`; a `# v3 git bundle` file →
  `BUNDLE_UNSUPPORTED_VERSION` (`.data.version === 3`). (Isolate each guard.)
- `bundle-list-heads.test.ts`: no filter → all header refs in order; exact-name filter
  `['refs/tags/v1.0']` → only that ref; near-miss filters `['v1.0']`, `['tags/v1.0']`,
  `['main']` → empty. Confirm the pack is never read (a bundle with a deliberately corrupt
  pack body still `list-heads` successfully).
- `read-bundle` refusal-kind unit coverage as above (folded via the verify tests).

### TDD steps

- RED: write the export-driven verify happy-path test (create → write → verify) → fails
  (modules missing; `walkPackEntries`/`verifyPackTrailer` not exported).
- RED: the prerequisite present/missing CQS tests, the corrupt-pack throw test, the four
  refusal-kind tests, and the list-heads filter tests → fail.
- GREEN: add `export` to the two fetch-pack helpers; implement `read-bundle.ts`,
  `bundle-verify.ts`, `bundle-list-heads.ts`; make all pass. Re-run `fetchPack`'s own
  tests to confirm the export change is behaviour-preserving.
- REFACTOR: keep `readBundle`'s errno-kind mapping a small early-return switch (no nesting
  >2); factor the prereq-presence probe into `findMissingPrerequisites(ctx, prereqs)`.

### Gate

`npx vitest run src/application/commands/bundle-verify.test.ts src/application/commands/bundle-list-heads.test.ts test/unit/application/primitives/fetch-pack.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/bundle-verify.ts src/application/commands/bundle-list-heads.ts src/application/commands/internal/read-bundle.ts src/application/primitives/fetch-pack.ts`

### Commit

`feat: bundle verify and list-heads commands`

## Part 5 — Surface: `repo.bundle` namespace, facade, barrel, docs, parity scenario

### Context

Wire the three commands into the single public `repo.bundle` Tier-1 namespace (ADR-420)
and pre-pay every Tier-1 surface gate in-slice.

New file `src/application/commands/internal/bundle-namespace.ts` (mirror
`internal/cherry-pick-namespace.ts` exactly — `guard()` first, forward to the
Context-aware command, `Object.freeze`):
```ts
export interface BundleNamespace {
  readonly create: (opts: BundleCreateOptions) => Promise<BundleCreateResult>;
  readonly verify: (input: BundleVerifyInput) => Promise<BundleVerifyResult>;
  readonly listHeads: (input: BundleListHeadsInput) => Promise<BundleListHeadsResult>;
}
export const bindBundleNamespace = (ctx: Context, guard: () => void): BundleNamespace;
```
Imports `bundleCreate`/`bundleVerify`/`bundleListHeads` + their option/result types from
`../bundle-create.js`, `../bundle-verify.js`, `../bundle-list-heads.js`.

**Barrel** — `src/application/commands/index.ts`: add an alphabetically-placed export
block (between the `blame` block and the `branch` block) re-exporting from the three
command files the value functions + ALL option/result types, AND from
`./internal/bundle-namespace.js` `bindBundleNamespace` + `BundleNamespace`; also re-export
the domain bundle types (`BundleRef`, `BundlePrerequisite`, `BundleVersion`,
`BundleHashAlgorithm`) — sourced from the command files which re-export them from
`../../domain/bundle/index.js`, OR added directly. (These now become PUBLIC API.)

**Facade** — `src/repository.ts`:
- `Repository` interface: insert `readonly bundle: commands.BundleNamespace;` between
  `branch` and `catFile` (alphabetical), with a doc comment
  `/** Nested repo.bundle.{create,verify,listHeads} namespace. */`.
- In the frozen `repo` object: add `bundle: commands.bindBundleNamespace(ctx, guard),`
  next to the `branch:` binding.

**Repository surface-snapshot test** — `test/unit/repository/repository.test.ts`:
- Add `'bundle'` to the sorted top-level-keys array (the `Object.keys(sut).sort()`
  assertion, between `'branch'` and `'catFile'`).
- Add `'bundle'` to the `namespaceKeys` `Set` (the "typeof every binding" test treats
  namespaces as frozen objects, not functions — omitting it makes the `typeof === 'function'`
  assertion fail for `bundle`).

**`check:doc-coverage`** — add `docs/use/commands/bundle.md` (follow `docs/use/commands/
archive.md` shape: what it returns as structured data, the three sub-ops, the
producer-returns-bytes / readers-take-a-path split, the rev grammar, the refusal codes —
NO rendered-output examples beyond reconstructing from fields). Add the alphabetical index
row to `docs/use/commands/README.md` (between the `blame` and `branch` rows) and bump its
header count `40 entries` → `41 entries`.

**Count + api.json** — `README.md` line 46: `41 Tier-1 commands` → `42 Tier-1 commands`.
Then regenerate `reports/api.json` via `npm run docs:json` and commit it (the large
typedoc-id diff is expected; this is the single regen for the whole feature — it captures
the four new error codes from P1 and all bundle exports). `check:doc-typedoc` (prepush)
then passes.

**`audit-browser-surface`** — new `test/parity/scenarios/bundle.scenario.ts` (follow
`archive.scenario.ts` + `types.ts`): `run()` seeds a tiny repo, `repo.bundle.create({ all:
true })`, **writes `result.bytes` to a temp path on the same adapter's `repo.ctx.fs`**,
then `repo.bundle.verify({ path })` and `repo.bundle.listHeads({ path })` on that path
(ADR-428). Project to counts/booleans only (`refCount`, `prerequisitesPresent`,
`recordsCompleteHistory`, `headCount`) — NO oids in assertions; runnable on Node/memory/
browser. Register it in `test/parity/scenarios/index.ts`. (This closes the
browser-surface gate for `repo.bundle.create/verify/listHeads`.)

**`cspell`** — add any new prose terms (`sneakernet`, `prereq`, `listHeads` is camelCase
so fine) to the project dictionary if `check:spelling` flags them; run `cspell` fresh
before finishing (cached runs can mask new words).

**Public-surface decision.** This part makes the entire bundle surface PUBLIC and pays ALL
gates here: barrel, facade (interface + binding + the two repository.test snapshots),
doc-coverage page + index row + index count, README count, parity/browser-surface
scenario, and the one `reports/api.json` regen.

Tests (fold in): the two `repository.test.ts` snapshot edits ARE the facade tests; the
`bundle.scenario.ts` is the parity/browser-surface test. No new behavioural logic lands
here, so these surface tests are the right coverage (not a test-only part — `src/`
delta = the namespace binder + facade binding).

### TDD steps

- RED: add `'bundle'` to the two `repository.test.ts` snapshots → fails (key absent /
  binding missing) and `check:types` fails (`commands.bundle*` undefined).
- GREEN: implement `bundle-namespace.ts`; add the barrel block; add the interface field +
  binding in `repository.ts` → snapshots pass.
- RED→GREEN: write `bundle.scenario.ts`, register it, run the parity suite → green on
  Node/memory.
- GREEN (gates): create `bundle.md` + index row + bump both counts; `npm run docs:json`;
  commit `reports/api.json`.
- REFACTOR: none expected (pure wiring); confirm alphabetical placement everywhere.

### Gate

`npx vitest run test/unit/repository/repository.test.ts test/parity && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/bundle-namespace.ts src/application/commands/index.ts src/repository.ts test/parity/scenarios/bundle.scenario.ts`

### Commit

`feat: bundle namespace, facade and docs`

## Part 6 — Faithfulness interop suite (real `git` 2.54.0 parity)

### Context

Test-infra-only, standalone (NO `src/` delta — it has no implementation part to fold
into). New file `test/integration/bundle-interop.test.ts`, modelled on
`test/integration/archive-interop.test.ts`: one shared seeded repo in `beforeAll`, real
`git` spawned with `GIT_*` scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing
OFF, 60s timeout. Pin `-c merge.conflictStyle=merge` defensively on any compare-bytes
peer invocation (the local global git may set `conflictStyle=diff3`). Compute goldens
with signing OFF. The library emits NO rendered strings — reconstruct git's human output
from the structured fields and diff (structured-output directive).

Seed a repo exercising all pins: linear `first→second→third→fourth` with unchanged AND
changed files (so the object-set exclusion is real), an annotated tag `v1.0`, a
lightweight tag `light`, a `feature` branch diverging at `first`, plus a criss-cross
sub-repo for the two-merge-base case, plus a commit whose message has a **multi-line
subject** (to disambiguate `subjectLine` vs `foldSubject`, plan-wide note 1).

Pinned assertions (from design §10, each a `git`-parity test):
1. **create header parity** — `repo.bundle.create(...)` header bytes (up to `PACK`) are
   byte-identical to `git bundle create`'s for: `{ all: true }` (sorted refs, `HEAD`
   last, annotated tag → tag-object oid), `{ revs: [{ tip: 'refs/heads/main' }] }`,
   `{ branches: true }`, `{ tags: true }`, two-dot `{ revs: [{ range: ['main~2', 'main']
   }] }`, three-dot `{ revs: [{ symmetricRange: ['main', 'feature'] }] }`, and `^`-exclusion
   `{ revs: [{ tip: 'main' }, { exclude: 'main~2' }] }`. Each header's `-<sha> <subject>`
   prerequisite lines are oid-sorted and the subject matches git (incl. the multi-line
   case → first body line).
2. **three-dot / merge-base prerequisite parity** — single merge-base and criss-cross
   (two merge-bases) prerequisites match git AND are oid-sorted (§4.1b); the `main ^X ^side`
   explicit-exclude form yields the same oid-sorted set as `tipA...tipB`.
3. **create object-closure parity** — parse tsgit's pack and git's pack (both via a pack
   walker) and assert EQUAL oid SETS for `--all`, the two-dot range (proves prereq-blob
   exclusion), and the criss-cross selection.
4. **create → real git consumes** — write tsgit's bytes to a temp file; `git bundle
   verify` and `git clone <file>` both succeed; the clone's refs/objects match.
5. **real git → tsgit reads** — `bundle.verify`/`listHeads` on a `git bundle create`
   output (passed by PATH) return refs/prerequisites/`hashAlgorithm` matching git's
   `list-heads`/`verify`; reconstruct git's stdout (pluralised `this ref` / `these N
   refs`, the trailing-space prereq line, `records a complete history`, the
   `uses this hash algorithm: sha1` line, the stderr `is okay`) from the structured fields
   and diff.
6. **verify full-pack parse (ADR-427)** — take a valid bundle, corrupt a byte inside an
   inflated pack entry **and recompute the 20-byte trailer to match** (so a trailer-only
   check would pass); `bundle.verify` THROWS — proving it inflates every entry, not just
   the trailer.
7. **refusal parity** — empty rev-list and bare-rev-only tip and unknown ref (`create`,
   reconstruct `Refusing to create empty bundle.` / `ambiguous argument …`); missing file
   AND unreadable (chmod 000) file → `BUNDLE_READ_FAILED` reconstructing `could not open
   '<path>'`; a directory AND a plain-text file → `BUNDLE_BAD_HEADER` reconstructing `does
   not look like a v2 or v3 bundle file`; a hand-forced `# v3 git bundle` +
   `@object-format=sha1` file → `BUNDLE_UNSUPPORTED_VERSION` (document the sanctioned
   divergence: git 2.54.0 reads it, tsgit refuses); a missing prerequisite (`verify` in a
   fresh empty repo) → reconstructed from `missingPrerequisites` (git `Repository lacks
   these prerequisite commits:`).
8. **list-heads filter parity** — exact-full-name matching only: `['refs/tags/v1.0']`
   matches; `['v1.0']`/`['tags/v1.0']`/`['main']` return nothing (match git).
9. **hash-algorithm line** — `verify` reconstructs `The bundle uses this hash algorithm:
   sha1`.

Use a shared `beforeAll` repo + 60s timeout (heavy git-spawning interop tests time out
hook concurrency otherwise). Same `Given/When/Then`, AAA, `sut` conventions.

### TDD steps

- RED: scaffold `beforeAll` seeding + the first header-parity assertion; it fails only if
  a P3 ordering/byte bug exists (the goldens are live-`git`-derived, so this is the true
  faithfulness gate — fix `create` if it diverges, never the test).
- RED→GREEN: add assertions 2–9 incrementally; each either passes against the P1–P4
  implementation or surfaces a faithfulness bug to fix in the owning command/primitive
  (escalate as `{ slice, reason, ≤3 options }` if a pinned `git` behaviour cannot be
  reproduced — e.g. an object-set divergence from `enumerateBundleObjects`).
- REFACTOR: extract `gitBundle(args)` / `readPackOids(bytes)` / `reconstructVerifyStdout
  (result)` helpers so each `it` is a thin Arrange/Act/Assert.

### Gate

`npx vitest run test/integration/bundle-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/bundle-interop.test.ts`

### Commit

`test: bundle real-git faithfulness interop suite`
