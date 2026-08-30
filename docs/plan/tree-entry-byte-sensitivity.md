# Plan — tree entry-name byte-sensitivity unification

> Source: design doc `docs/design/tree-entry-byte-sensitivity.md` · ADRs `748`–`759`
> (twelve, all accepted and binding) · `723` superseded for the duplicate refusal only.
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

## Sequencing rationale — the brand sweep

**The brand ships in its own part, ahead of `nameBytes`, and the tree stays green
throughout.** This is the single riskiest sequencing choice in this change and it was
measured, not guessed.

Measurement (throwaway `mktemp` copy of `src/` + `test/` + `tooling/` with `node_modules`
symlinked, never this worktree; `tsc --noEmit -p tsconfig.json` and
`vitest run test/unit` on the copy; copy destroyed afterwards):

| probe | result |
|---|---|
| brand `TreeEntry` alone (no `nameBytes`), typecheck | **85 files**, ~800 `TS2322`/`TS2345` — 6 in `src/`, 79 under `test/` |
| brand `TreeEntry` alone, `vitest run test/unit` after fixing constructions | **0 behaviour failures** — the factory returns the identical runtime object |
| add `nameBytes` + parse tier + refusal drops, with constructions already routed through the factory | **9 test failures in 3 files** (`tree.test.ts` ×6, `tree.properties.test.ts` ×1, `resolve-tree-path.test.ts` ×2) |
| swap `cursorName`'s decoder to `decodePreservingBom` on top of that | **1 further failure in 1 file** (`diff-trees.test.ts:706`, a `decode` call-count assertion) |

So the sweep and the semantics are separable, and the seam is exact:

- **Part 1** brands the type and rewrites all 85 construction sites to `treeEntry(mode,
  name, id)`. The factory returns today's `{ mode, name, id }`, so *no runtime value
  changes* — the whole unit tier stays green with zero test-expectation edits, and the
  compiler is the worklist (each `TS2322` line is a construction site). The gate is
  unambiguous and never red mid-part.
- **Part 2** flips the factory's body (`nameBytes`, `string | Uint8Array`, ADR-758's
  copy) and the parse tier. **No call site changes** — they already go through the
  factory. The measured blast radius is 3 test files.

The rejected alternative — one atomic part carrying brand + `nameBytes` + refusal drops
+ 85-file sweep — is the 96-file / 6600-second outlier shape *with* semantics riding on
top of it. A part-implementer would be staring at ~800 type errors and 9 behaviour
failures at once, with no green intermediate to fall back to if the agent dies; the
artifact-handoff rule then restarts it onto a broken tree rather than a green commit.
The split costs one extra `reports/api.json` regeneration (a generated file) and buys a
green base at every boundary.

**Both Part 1 and Part 2 carry the `!` breaking marker.** Part 1 breaks the public type
(`{ name, mode, id }` literals stop compiling — ADR-749). Part 2 removes two producible
`INVALID_TREE_ENTRY` `data.reason` values (§5a). The PR title carries `!` too, because
this repo merges by squash and release-please reads the squashed subject.

**The interop suite (ADR-756) lands as one part at the end**, not row-by-row. Reasons:
(i) ADR-756 makes it one file with one `@proves` header claiming the `tree` surface, so
six agents would be editing one file's header-governed body; (ii) several rows are
inherently cross-part — case 5 (duplicates) spans parse, descent, flatten and fsck, so a
row-by-row split would land half-rows that assert nothing; (iii) it spawns real `git` and
is slow, so it belongs to one gate; (iv) §1b already carries every measured value, so no
part needs to probe git to know the expected answer. Each implementation part still
carries its own unit-level parity assertions taken from §1b, so a parity bug surfaces in
its own part rather than only at the end.

## Decision candidates

Every load-bearing choice in the design is pre-decided. The map, so no part re-opens one:

| design DC | ruled by | outcome the plan implements |
|---|---|---|
| DC-A (shape of the shared byte module) | ADR-750's *Re-derivation* section | option (a): `src/domain/objects/tree-entry-bytes.ts` exports `hasNonOctalByte` + `entryNameKey`; the name-shape comparisons stay private to `validate-tree.ts` |
| DC-B (spread hole in the brand) | ADR-749 *Consequences · Negative* | option (a): accepted and recorded next to the type; no lint rule |
| DC-C (merge worktree-write refusal) | ADR-753 *Correction* | option (a): the merge conflict writers adopt `validateIndexPath` |
| DC-D (factory copies its bytes) | ADR-758 | option (a): always copy |
| DC-E (descent over an embedded separator) | ADR-759 | option 1: on a segment miss, also try the whole remaining path; hit path untouched |

One genuinely new choice the codebase reading surfaced, not ruled by any ADR:

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-P1** | **`cursorName` has four production consumers, not one — the design's §4c says "the merge-join never calls it", and it does.** Measured: `cursorName` is called by `flatten-raw.ts:195`, `walk-raw-subtree.ts:174`, `raw-tree-diff.ts:70/79/88` and (until Part 2) `resolve-tree-path.ts`. `raw-tree-diff.ts` uses it only to *emit* `newPath`/`oldPath`, never to decide — so no verdict changes — but swapping its decoder to `decodePreservingBom` changes the `FilePath` string `diffTrees(recursive)` and `walkTree`'s raw subtree walk emit for a BOM-bearing name, on two surfaces ADR-723 §6 declares "unchanged". | (a) Swap the decoder once in `cursorName`, accept the wider emit-surface change as required by ADR-749 §4c, and pin the new path on all three consumers (flatten, walk, recursive diff). (b) Leave `cursorName` on `decode` and give flatten its own BOM-preserving emit helper, so only flatten's paths change. (c) Leave `cursorName` on `decode` entirely and accept that flatten still drops the BOM from a path. | **(a)** | (c) contradicts requirement 1 and ADR-748 outright — flatten would keep producing `sub/` for a bare-BOM entry git materialises as `sub/<U+FEFF>`. (b) buys a second decode helper to keep two consumers *wrong*: a BOM-stripped `FilePath` out of `diffTrees` is the same defect, one surface over, and it would need its own ADR to justify. (a) is verdict-preserving (ADR-723 forbids adding a *check* to the cursor's scan; this changes no scan and no refusal), it is what §4c intends, and its whole measured cost is one call-count assertion (`diff-trees.test.ts:706`) plus three new pinning tests. Recorded here because the design's stated justification for (a) is factually wrong even though (a) is still right. |

---

## Part 1 — Brand `TreeEntry` and mint it only through `treeEntry`

### Context

**What changes:** `TreeEntry` becomes a branded object type; every construction site in
the repo becomes a `treeEntry(mode, name, id)` call. **No runtime value changes** — the
factory returns the same `{ mode, name, id }` shape. `nameBytes` arrives in Part 2.

**File to edit first — `src/domain/objects/tree.ts`, lines 19–23:**

```ts
export interface TreeEntry {
  readonly mode: FileMode;
  readonly name: string;
  readonly id: ObjectId;
}
```

becomes

```ts
export type TreeEntry = {
  readonly mode: FileMode;
  readonly name: string;
  readonly id: ObjectId;
} & { readonly __brand: unique symbol };

export function treeEntry(mode: FileMode, name: string, id: ObjectId): TreeEntry {
  return { mode, name, id } as TreeEntry;
}
```

- The brand idiom is the repo's own, one file over: `src/domain/objects/object-id.ts:39`
  `export type ObjectId = string & { readonly __brand: unique symbol };`, minted only by
  `ObjectId.from` / `.fromRaw` / `.fromTrustedHex`, each of which uses a single
  `as ObjectId` cast. **Measured with this repo's `typescript@6`: a single
  `as TreeEntry` cast on the object literal compiles** — `as unknown as` is not needed.
- `parseTreeContent`'s own `entries.push({ mode, name, id: entryId })`
  (`tree.ts:66`) becomes `entries.push(treeEntry(mode, name, entryId))`. Nothing else in
  `parseTreeContent` moves in this part — the `name === '' || '.' || '..' ||
  includes('/')` guard, the `names` Set and the check order all stay exactly as they are.
- `serializeTreeContent`, `sortTreeEntries`, `treeEntryCompare` and the private
  `encodeEntryName(name: string, isDir: boolean)` are **untouched** in this part.

**The construction worklist is the compiler.** After the type flips, `npm run
check:types` reports every site as `TS2322` (`Property '__brand' is missing…`) or
`TS2345`. Measured today: **85 files**, ~800 errors. The full file list, so no discovery
pass is needed:

`src/` (6 files, 10 sites):

| file | site |
|---|---|
| `src/domain/objects/tree.ts` | `entries.push({ mode, name, id: entryId })` in `parseTreeContent` (L66) |
| `src/application/commands/commit.ts` | L437 `const treeEntries: TreeEntry[] = []`; L439 `treeEntries.push({ mode: leaf.mode as TreeEntry['mode'], name, id: leaf.id })`; L453 `treeEntries.push({ mode: '40000', name, id })` |
| `src/application/commands/merge.ts` | L486–487 `leavesToTreeEntries` — `files.map((f) => ({ name: f.path, id: f.id, mode: f.mode }))` |
| `src/application/primitives/write-notes-tree.ts` | L53 `const direct: TreeEntry[] = []`; L59 `direct.push({ id: entry.oid, mode: entry.mode, name: entry.name })`; L69 `const subtreeEntries: TreeEntry[] = []`; L72 `subtreeEntries.push({ id: subtreeOid, mode: FILE_MODE.DIRECTORY, name: prefix })` |
| `src/application/primitives/synthesize-tree-from-index.ts` | L174–175 `filesToTreeEntries` — `files.map((file) => ({ name: file.path as FilePath, id: file.id, mode: file.mode }))` |
| `src/application/primitives/internal/resolve-tree-path.ts` | L218 `return { mode, name: cursorName(cursor), id: cursorOid(cursor) }` |

`test/` (79 files) — full list, in `check:types` order:

```
test/bench/fixtures.ts
test/integration/bare-repo-custom-gitdir-interop.test.ts
test/integration/commit-interop.test.ts
test/integration/network/push-http-backend.test.ts
test/integration/ssh-transport.test.ts
test/integration/submodules.test.ts
test/integration/tree-interop.test.ts
test/parity/scenarios/bitmap-closure.scenario.ts
test/parity/scenarios/write-pipeline.scenario.ts
test/unit/adapters/snapshot-resolvers/caching-tree-resolver.test.ts
test/unit/adapters/snapshot-resolvers/raw-tree-resolver.test.ts
test/unit/application/commands/archive.test.ts
test/unit/application/commands/blame.test.ts
test/unit/application/commands/bundle-create.test.ts
test/unit/application/commands/bundle-list-heads.test.ts
test/unit/application/commands/bundle-verify.test.ts
test/unit/application/commands/cherry-pick.test.ts
test/unit/application/commands/fsck.properties.test.ts
test/unit/application/commands/fsck.test.ts
test/unit/application/commands/maintenance.test.ts
test/unit/application/commands/merge.properties.test.ts
test/unit/application/commands/merge.test.ts
test/unit/application/commands/notes.test.ts
test/unit/application/commands/push.test.ts
test/unit/application/commands/read-file-at.test.ts
test/unit/application/commands/rebase.test.ts
test/unit/application/commands/rev-list.test.ts
test/unit/application/commands/rev-parse.test.ts
test/unit/application/commands/stash.test.ts
test/unit/application/commands/submodule-add.test.ts
test/unit/application/commands/submodule-network-fixture.ts
test/unit/application/commands/submodule-update.test.ts
test/unit/application/commands/submodule.test.ts
test/unit/application/commands/whatchanged.test.ts
test/unit/application/primitives/apply-merge-to-worktree.test.ts
test/unit/application/primitives/build-index-from-tree.test.ts
test/unit/application/primitives/build-pack.test.ts
test/unit/application/primitives/cat-file-batch.test.ts
test/unit/application/primitives/diff-trees.test.ts
test/unit/application/primitives/enumerate-bundle-objects.test.ts
test/unit/application/primitives/enumerate-push-objects.test.ts
test/unit/application/primitives/fixtures.ts
test/unit/application/primitives/flatten-tree.test.ts
test/unit/application/primitives/internal/bitmap-binding.closure.test.ts
test/unit/application/primitives/internal/bitmap-binding.test.ts
test/unit/application/primitives/internal/closure-engine.test.ts
test/unit/application/primitives/internal/flatten-raw.test.ts
test/unit/application/primitives/internal/raw-subtree-prefetch.test.ts
test/unit/application/primitives/internal/resolve-tree-path.properties.test.ts
test/unit/application/primitives/internal/resolve-tree-path.test.ts
test/unit/application/primitives/internal/walk-raw-subtree.test.ts
test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts
test/unit/application/primitives/laws.test.ts
test/unit/application/primitives/load-notes-tree.test.ts
test/unit/application/primitives/materialize-tree.test.ts
test/unit/application/primitives/materialize-worktree-from-head.test.ts
test/unit/application/primitives/patch-id.test.ts
test/unit/application/primitives/read-head-tree.test.ts
test/unit/application/primitives/snapshot/snapshot-factory.test.ts
test/unit/application/primitives/snapshot/tree-snapshot.mutation.test.ts
test/unit/application/primitives/snapshot/tree-snapshot.test.ts
test/unit/application/primitives/synthesize-tree-from-index.properties.test.ts
test/unit/application/primitives/synthesize-tree-from-index.test.ts
test/unit/application/primitives/walk-submodules.test.ts
test/unit/application/primitives/walk-tree.properties.test.ts
test/unit/application/primitives/walk-tree.test.ts
test/unit/application/primitives/write-notes-tree.test.ts
test/unit/application/primitives/write-tree.test.ts
test/unit/domain/diff/arbitraries.ts
test/unit/domain/diff/raw-tree-diff.test.ts
test/unit/domain/diff/tree-diff.test.ts
test/unit/domain/notes/arbitraries.ts
test/unit/domain/notes/load.test.ts
test/unit/domain/notes/mutate.test.ts
test/unit/domain/notes/write-plan.test.ts
test/unit/domain/objects/arbitraries.ts
test/unit/domain/objects/size.test.ts
test/unit/domain/objects/tree.test.ts
test/unit/repository/repository.test.ts
```

The heavy files, so effort is not a surprise: `diff-trees.test.ts` (188 errors),
`apply-merge-to-worktree.test.ts` (64), `closure-engine.test.ts` (57),
`enumerate-bundle-objects.test.ts` (50), `walk-raw-subtree.test.ts` (43),
`resolve-tree-path.test.ts` (39), `fsck.test.ts` (35), `flatten-raw.test.ts` (34).
Most of them concentrate in one or two local helpers per file (a `makeTree([...])` /
`entry(...)` / `writeTree(ctx, [...])` shape) — rewrite the helper, not each call.

**Two mechanical rules for the sweep:**

1. Import `treeEntry` from `'…/domain/objects/tree.js'` (the deep path). Existing code
   already deep-imports into `domain/objects` (`resolve-tree-path.ts` imports
   `encoding.js` and `tree-cursor.js` directly), and `.dependency-cruiser.cjs` has no
   deep-import rule.
2. Spreads keep compiling under the brand (measured: `{ ...entry, id: newId }` type-checks
   because the spread copies `__brand`). The two that exist —
   `test/bench/diff-recursive.bench.ts` L57 and the `writeTree` call above it — override
   `id` only and stay as they are. **Do not introduce new spreads.**

**Two runtime-only sites the compiler will NOT flag** (they are `toEqual` expectations,
not typed constructions). Leave them alone in this part; they are Part 2's:
`test/unit/application/primitives/internal/resolve-tree-path.test.ts:793`
(`entry: { mode: FILE_MODE.REGULAR, name: 'file', id: leafId }`) and the same file's
`cursorName` spy assertion at L363–386.

**Public-surface gates this part owes** (from `.claude/workflow/surface-gates.md` —
`treeEntry` is a **public** export: it is the only way a consumer can build the type
`writeTree` takes):

1. `src/domain/objects/index.ts` — add `treeEntry` to the existing value re-export block
   at L53–58 (`export { parseTreeContent, serializeTreeContent, sortTreeEntries,
   treeEntryCompare } from './tree.js';`), alphabetical: `treeEntry` before
   `treeEntryCompare`.
2. `src/public-types.ts` — a **value** export line. `export type * from
   './domain/objects/index.js'` (L86) drops values, and a `.d.ts` that declares a
   function the runtime bundle omits compiles green and crashes at runtime (the file's
   own L33–37 comment says so for the diff values). Add, next to the
   "Branded-id value carve-out" at L112:
   `export { treeEntry } from './domain/objects/tree.js';`
   All three runtime entries (`src/index.node.ts:353`, `src/index.browser.ts:117`,
   `src/index.default.ts:114`) do `export * from './public-types.js'`, so this reaches
   every entry. No name clash: `src/public-types.ts:25`'s `TreeEntry` is the *snapshot*
   type from `application/primitives/snapshot/tree-entry.js` and stays the explicit
   winner; `treeEntry` (lower-case) is a new name.
3. `reports/api.json` — **regenerate with `npm run docs:json` and stage the result in
   this part's commit**. Two reasons: `src/domain/index.ts` `export *`s
   `./objects/index.js` and is a typedoc entry point (`typedoc.json`), and `TreeEntry`
   itself appears ~110 times in api.json and changes shape. `check:doc-typedoc` is
   `git diff --exit-code -- reports/api.json` after `docs:json`, and it runs at
   **prepush**, not in `validate` — a green local `validate` can still be rejected by the
   push hook. Pre-pay it here. (The typedoc-id churn in the diff is normal and expected.)
4. Not applicable, checked: `check:doc-coverage` reads `src/repository.ts` only (no new
   Tier-1 command); `audit-browser-surface` gates `repo.<cmd>(…)` scenarios only;
   `test/unit/api-surface/*.test.ts` assert named absences/presences, not an exhaustive
   export set — none of them names `treeEntry`.

**Do not touch in this part:** `docs/use/primitives/write-tree.md` and
`read-tree.md` (they are wrong today on three counts each — numeric `0o100644` modes, a
`type` field that does not exist, `tree.data.entries`, and a false sort claim — and the
documentation phase rewrites them, per the design's *Consumer migration*).

### TDD steps

This part is behaviour-preserving, so the second RED signal is the **type checker**, not
a test. That is the honest oracle here: the sweep changes no runtime value, so a test
asserting one would be asserting that nothing happened.

1. **RED (test).** Add to `test/unit/domain/objects/tree.test.ts`, in a new
   `describe('treeEntry')` block sibling to `describe('parseTreeContent')`:
   `describe('Given a mode, a name and an id') > describe('When treeEntry mints an entry')
   > it('Then the entry carries them verbatim')` — `const sut = treeEntry;` (`sut` is the
   function, `result` holds the result), asserting `result.mode`, `result.name` and
   `result.id` individually. Expected failure: `treeEntry is not a function` /
   `TS2305: Module … has no exported member 'treeEntry'`.
2. **RED (compiler).** Flip `TreeEntry` to the branded type and add `treeEntry`. Run
   `npm run check:types`. Expected failure: ~800 `TS2322: Property '__brand' is missing
   in type '{ mode: …; name: …; id: … }' but required in type 'TreeEntry'` across the 85
   files listed above. Capture the file list — it is the worklist.
3. **GREEN.** Work the 85-file list to zero type errors. `src/` first (6 files), then
   `test/`. Per file: find the local helper that builds entry-shaped literals, convert it
   to call `treeEntry(...)`, re-run `check:types` scoped by eye to that file's errors.
4. **GREEN — verify no behaviour moved.** `npx vitest run test/unit` must be green with
   **zero test-expectation edits**. If any test fails on a *value*, you changed a value:
   revert that site and re-do it as a pure `{a,b,c}` → `treeEntry(a,b,c)` rewrite. This
   is the part's central invariant and it was measured to hold.
5. **REFACTOR.** Delete now-unused `TreeEntry` type-only imports the compiler flags
   (`noUnusedLocals`). Land the three surface gates (barrel, `public-types.ts`,
   `npm run docs:json`). Run `./node_modules/.bin/biome check --write src test` for the
   import ordering the sweep disturbs.

### Gate

```
npx vitest run test/unit \
  && npx vitest run test/integration/tree-interop.test.ts test/integration/commit-interop.test.ts test/integration/submodules.test.ts test/integration/bare-repo-custom-gitdir-interop.test.ts \
  && npm run check:types \
  && npm run docs:json \
  && ./node_modules/.bin/biome check src test
```

(Run `npm run docs:json` **before** staging, then include `reports/api.json` in the
commit; `git diff --exit-code -- reports/api.json` is only clean once it is staged.)

(`test/integration/ssh-transport.test.ts` and `test/integration/network/push-http-backend.test.ts`
are compile-only touches here — `check:types` covers them; they ride the phase-boundary
`npm run validate`.)

### Commit

```
feat(tree)!: brand TreeEntry and mint it only through the treeEntry factory
```

---

## Part 2 — `TreeEntry` carries its raw name bytes; the parse tier separates malformed from bad

### Context

**What changes, in one sentence:** the factory becomes byte-authoritative,
`parseTreeContent` stops decoding to decide and stops refusing name shapes and
duplicates, and its mode/empty-name faults move to the parse tier with the cursor's exact
strings.

**Measured breakage of this part** (probe, with Part 1 already applied): 9 tests in 3
files — `test/unit/domain/objects/tree.test.ts` ×6,
`test/unit/domain/objects/tree.properties.test.ts` ×1,
`test/unit/application/primitives/internal/resolve-tree-path.test.ts` ×2. Nothing else in
the unit tier moves.

#### `src/domain/objects/tree.ts`

Target type and factory (ADR-749, ADR-758):

```ts
export type TreeEntry = {
  readonly mode: FileMode;
  readonly name: string;          // derived display view
  readonly nameBytes: Uint8Array; // authoritative — the on-disk bytes
  readonly id: ObjectId;
} & { readonly __brand: unique symbol };

export function treeEntry(mode: FileMode, name: string | Uint8Array, id: ObjectId): TreeEntry {
  const nameBytes = typeof name === 'string' ? encode(name) : new Uint8Array(name);
  return { mode, name: decodePreservingBom(nameBytes), nameBytes, id } as TreeEntry;
}
```

- **`name` is always derived from `nameBytes`**, never taken from the caller's string.
  That makes `name === decodePreservingBom(nameBytes)` true by construction — the
  invariant ADR-749 asks for, with no second code path.
- **ADR-758: always copy.** `encode(name)` already returns a fresh array;
  `new Uint8Array(name)` copies the elements of a caller-supplied view. A `TreeEntry`
  must never alias the object body — `fsck`'s `CachedGitObject` holds parsed trees.
- `decodePreservingBom` already exists at `src/domain/objects/encoding.ts:88–92`
  (`new TextDecoder('utf-8', { ignoreBOM: true })`), added for commit/tag headers with a
  comment explaining git stores those bytes verbatim. Add it to `tree.ts`'s existing
  `import { compareBytes, decode, encode, hexToBytes, indexOf } from './encoding.js';`.
- Record DC-B's limit in a comment on the type: the brand stops an object *literal*, not
  `{ ...entry, name: 'x' }` — TypeScript's spread copies the brand. Measured; accepted
  by ADR-749's *Negative*. Nothing reads `name` to make a decision, so a stale `name` is
  a wrong display string, never wrong on-disk bytes.
- **Leave `tree.ts`'s module `@writes` header alone.** It reads
  `kind: equivalent-under-readback` (L1–10) and it stays that way: ADR-749 makes it
  honest about *name bytes*, but `serializeTreeContent` still re-sorts, so a tree parsed
  from on-disk-unsorted bytes still re-serializes to a different oid. Upgrading the
  header to a byte-identical claim would be false and would trip
  `check:write-surfaces`' contract with the interop suites.

`parseTreeContent`'s new per-entry order (§5b — mirrors `tree-cursor.ts`'s
`scanMode → scanName → scanOid`, and after this part the two produce **identical error
data for every parse-tier fault**, which is what keeps `parseTreeContent` usable as the
cursor's differential oracle, ADR-520):

```
1. spaceIndex = indexOf(content, 0x20, offset); -1        -> 'missing space after mode'
2. spaceIndex === offset || hasNonOctalByte(content, offset, spaceIndex)
                                                          -> 'malformed mode'   (NEW, ADR-754)
3. nullIndex  = indexOf(content, 0x00, spaceIndex + 1); -1 -> 'missing null after name'
4. nullIndex === spaceIndex + 1                           -> 'empty filename'   (NEW reason, ADR-754)
5. hashEnd > content.length                               -> 'truncated hash'
6. normalizeFileMode(decode(mode span))                   -> INVALID_FILE_MODE  (check tier, unchanged)
7. entries.push(treeEntry(mode, content.subarray(spaceIndex + 1, nullIndex), entryId))
```

**Deleted outright** (not relocated): the `name === '' || name === '.' || name === '..'
|| name.includes('/')` line and its `invalid entry name: …` reason (ADR-753); the
`const names = new Set<string>()`, the `names.has(name)` throw and `names.add(name)` and
the `duplicate entry name: …` reason (ADR-752). After this part neither reason string is
producible anywhere in the codebase — that is the §5a breaking change.

§3d: keeping `decode(modeStr)` at step 6 is **correct and deliberate**. Once step 2
short-circuits, every mode span reaching step 6 is pure ASCII octal, so decoding it is
lossless by construction. A reviewer will otherwise read it as a missed site.

Three helpers stop reading `name`:

- `serializeTreeContent` (L79): `name: encode(entry.name)` → `name: entry.nameBytes`.
- `sortTreeEntries` (L106): `sortKey: encodeEntryName(entry.name, …)` →
  `encodeEntryName(entry.nameBytes, …)`.
- `treeEntryCompare` (L114–115): same, both sides.
- the private `encodeEntryName(name: string, isDir: boolean)` (L120) becomes
  `encodeEntryName(nameBytes: Uint8Array, isDir: boolean)` and drops its internal
  `encode(name)` call.

That quartet is what makes requirement 3 true: `serializeTreeContent(parseTreeContent(b))
=== b` for BOM-bearing and invalid-UTF-8 names. The predicate work alone would not.

#### `src/domain/diff/tree-diff.ts` — a fifth decoded-name byte key the design misses

**Found while reading the code; not in the design's four-site table and not in any ADR's
subject list, but requirement 1 binds it directly** ("no … sort key … is derived from a
decoded string"). `entryKey` (L61–67) does `const nameBytes = encode(entry.name);` and
that key is the merge-join's ordering *and* equality oracle for the non-recursive
`diffTrees(oldTree, newTree)`:

```ts
function entryKey(entry: TreeEntry): Uint8Array {
  const nameBytes = encode(entry.name);            // -> entry.nameBytes
  if (!isDirectory(entry.mode)) return nameBytes;
  const withSlash = new Uint8Array(nameBytes.length + 1);
  withSlash.set(nameBytes);
  withSlash[nameBytes.length] = 0x2f;
  return withSlash;
}
```

Today two entries named by the raw bytes `FE` and `FF` both key to `EF BF BD`, so the
merge-join treats them as the same path — the same collapse the duplicate `Set` had.
Change `encode(entry.name)` to `entry.nameBytes`; `encode` then becomes an unused import
in that file (`compareBytes` stays). `addFrom` / `deleteFrom` / `classifySamePath` keep
their `entry.name as FilePath` casts — that is ADR-757's string boundary, deliberately
unchanged.

Test: `test/unit/domain/diff/tree-diff.test.ts` — a two-entry tree named `FE` and `FF`
produces **two** changes against the empty tree, not one, and their `newPath`s differ at
the `FilePath` level only in that both decode to U+FFFD (assert the change *count* and
the two `newId`s, which is the collapse-proof assertion; the paths themselves collide by
ADR-757 and must not be the oracle).

#### Two comparisons that become byte-exact for free, and are more git-faithful for it

Neither needs a code change; both change behaviour because `entry.name` is now
BOM-preserving. Note them in the part's commit body-free world by pinning each with a test:

- `src/application/primitives/walk-submodules.ts:111` —
  `tree.entries.find((e) => e.name === '.gitmodules')`. A `EF BB BF .gitmodules` entry
  matches today (the decoder ate the BOM) and stops matching. git compares bytes, so this
  is the faithful direction.
- `src/domain/notes/load.ts:18` — `TWO_HEX.test(entry.name)` for the notes fanout. A
  BOM-prefixed two-hex name stops being classified as a fanout directory. Same direction.

Add one test each (`test/unit/application/primitives/walk-submodules.test.ts`,
`test/unit/domain/notes/load.test.ts`) so the narrowing is pinned rather than discovered.

#### `src/domain/objects/tree-entry-bytes.ts` (new)

DC-A(a) / ADR-750's re-derivation. In this part it exports exactly one symbol;
`entryNameKey` arrives in Part 5 with its only consumer.

```ts
/** Parse-tier mode scan, moved out of tree-cursor.ts (ADR-754). */
export function hasNonOctalByte(buf: Uint8Array, start: number, end: number): boolean;
```

Move the body verbatim from `src/domain/objects/tree-cursor.ts:77–83` (with its
`OCTAL_ZERO = 0x30` / `OCTAL_SEVEN = 0x37` constants) and have `tree-cursor.ts` import it
back. **This changes no verdict on any path**: the cursor runs the same code at the same
point in the same order, so every ADR-723 pin in
`test/integration/tree-diff-corrupt-interop.test.ts` stays green without edits. Do not
export anything else and do not add a name-shape classifier — after ADRs 752/753 its only
caller would be `validate-tree.ts`, and the repo's 100 % branch gate would then have to
cover arms one caller can reach.

`.dependency-cruiser.cjs` has a `no-circular` rule: `tree-entry-bytes.ts` must import
nothing from `tree.ts` or `tree-cursor.ts`.

#### `src/domain/objects/tree-cursor.ts`

Exactly one edit in this part: delete the local `hasNonOctalByte` (L77–83) and import it
from `./tree-entry-bytes.js`. **Nothing else.** No new check in `scanEntryAt`, `scanMode`,
`scanName`, `scanOid`, `computeIsDir`, `compareCursorNames` or `cursorNameEquals`
(ADR-723, carried forward by ADR-752). The two existing `Stryker disable` comments
(`computeIsDir`'s `ArithmeticOperator`, `skipLeadingZeros`'s `ArithmeticOperator`) are
untouched. The `cursorName` decoder swap is **Part 3**.

#### `src/application/primitives/internal/resolve-tree-path.ts` — one line

L218 currently `return { mode, name: cursorName(cursor), id: cursorOid(cursor) };`
(after Part 1: `return treeEntry(mode, cursorName(cursor), cursorOid(cursor));`). It must
become

```ts
return treeEntry(mode, cursor.buf.subarray(cursor.nameStart, cursor.nameEnd), cursorOid(cursor));
```

This is **not optional and cannot wait for Part 4**: passing the decoded string would
round-trip an invalid-UTF-8 name through U+FFFD (`encode(decodePreservingBom([0xFF]))`
is `EF BF BD`, not `FF`), which is the exact corruption ADR-749 exists to stop. The
factory copies, so the object body is not aliased. Everything else in this file — the
shape check, the duplicate check, `matched = … ?? matched`, the root-level string
compare — stays until Part 4.

#### Test surface

- **`test/unit/domain/objects/tree.test.ts`** (443 lines). Helpers already present:
  `buildTreeEntry(mode, name, sha)` (L16) and `concatBytes(...arrays)` (L28);
  `DUMMY_ID = ObjectId.from('a'.repeat(40))`.
  - The `it.each` guard table at **L140–210** loses **four** rows —
    `"an entry name of '.'"`, `"an entry name of '..'"`,
    `"an entry name containing '/'"`, `'duplicate entry names'` — and gains **two**:
    `'a non-octal mode byte'` (`10064a`) → reason `'malformed mode'`, and `'an empty
    mode'` (a leading space before `100644`) → `'malformed mode'`. The
    `'an empty entry name'` row **stays**; only its reason changes from
    `'invalid entry name: '` to `'empty filename'`.
    The table asserts `data.code` + `data.reason` via `expect.objectContaining` today;
    keep that shape but add `data.offset` (mutation-resistance: the offset is what a
    loop-bound mutant moves).
  - The test at **L226–262** (`'Given a NUL byte inside the mode region (before the
    space)'`) currently asserts `INVALID_FILE_MODE` with `data.value === '\x00'`. Under
    ADR-754 a NUL is a non-octal mode byte, so it now refuses at the parse tier with
    `INVALID_TREE_ENTRY` / `'malformed mode'`. Rewrite the assertion and the comment; the
    fixture and the *intent* (the NUL search starts after the space) survive.
  - **New accept-and-assert-the-entries tests**, one per §1b class that flips from refuse
    to accept — rows 2 (`EF BB BF 61`), 3 (bare `EF BB BF`), 4 (`FE` and `FF` in one
    tree), 5 (`EF BB BF 2E`), 6 (`EF BB BF 2E 2E`), 7 (`a` + `EF BB BF 61`), 9 (`.`),
    10 (`..`), 11 (`a/b`), 14 (duplicate `a`,`a`). Each asserts `entries.length` **and**
    every entry's `nameBytes` (`toEqual` on the `Uint8Array`) **and** `name`. "It did not
    throw" would survive a mutant returning the wrong entry set. Row 14 asserting
    `entries.length === 2` with both oids is the assertion that kills a surviving
    `names` Set; row 4 asserting two distinct `nameBytes` kills a key-collapse mutant.
  - **Round-trip**: `serializeTreeContent(parseTreeContent(b), SHA1_CONFIG)` `toEqual` `b`
    for a tree built from rows 2, 3, 4 and 7 bytes. This is the only assertion that
    catches a `nameBytes`-dropping mutant.
  - **`treeEntry` factory tests** (extend Part 1's block): a `string` name and a
    `Uint8Array` name producing the same entry for ASCII input; a `Uint8Array` carrying
    `EF BB BF` producing `name` **with** the BOM (proves the factory does not use plain
    `decode`); a `Uint8Array` carrying `FF` producing `name === '�'` and
    `nameBytes` `toEqual` `Uint8Array.of(0xFF)`; and — ADR-758 — **mutating the caller's
    array after construction does not change the entry** (this is the only test that
    kills a "store the caller's array by reference" mutant; the parse path never mutates
    the buffer afterwards, so every parse test passes with the bug).
- **`test/unit/domain/objects/tree-entry-bytes.test.ts`** (new). `hasNonOctalByte`
  boundary sweep: `'0'` (0x30) accepted, `'7'` (0x37) accepted, `'8'` (0x38) refused,
  `'/'` (0x2f) refused, `0x00` refused, an empty span (`start === end`) returns `false`,
  and a mixed span where the non-octal byte is last (kills a loop-bound mutant).
- **`test/unit/domain/objects/arbitraries.ts`** (L112–135):
  - `arbTreeEntryAnyMode()` (L112) — its `.map(([mode, name, id]) => ({ mode, name, id }))`
    is already a `treeEntry(...)` call after Part 1. **Keep its filter**
    (`!s.includes('\0') && !s.includes('/') && s !== '.' && s !== '..'`) — it is the
    canonical arbitrary.
  - **Add `arbTreeEntryRawName()`**: same modes and oids, but the name is an arbitrary
    NUL-free **byte** sequence (`fc.uint8Array({ minLength: 1, maxLength: 50 }).filter((b)
    => !b.includes(0))`), fed to `treeEntry(mode, bytes, id)`. It must be able to emit
    `EF BB BF`, lone `0x80`–`0xFF` bytes and multi-byte sequences — `fc.string()` **cannot
    generate the defect**, which is why the existing round-trip property never caught it.
  - `dedupeTreeEntriesByName` (L127): its comment "Git trees cannot contain duplicate
    entry names" is now **false**. Rewrite the comment to say the dedupe stays because a
    *generated canonical* tree should still be canonical, not because git forbids it.
    Re-key it on `entryNameKey`-equivalent bytes is **not** needed here (its inputs are
    the ASCII-only canonical arbitrary).
- **`test/unit/domain/objects/tree.properties.test.ts`** (122 lines):
  - The round-trip property at L59–72 fails today under the change because it dedupes on
    decoded names. Re-point it at `arbTreeEntryRawName()`, keep `dedupeTreeEntriesByName`
    for the canonical arbitrary's property and add a **byte-name** round trip:
    `parseTreeContent(serializeTreeContent(t))` ≡ `sortTreeEntries(t)` compared on
    `(mode, nameBytes, id)`. `numRuns: 200` (lens 1, cheap round trip).
  - **New counting invariant** (lens 4, `numRuns: 100`): for any tree built from
    `fc.array(arbTreeEntryRawName())` — **no dedupe** — `parseTreeContent(...).entries.length`
    equals the array's own length. ADR-752 removed the old "whenever no name is
    byte-duplicated" caveat; the count comes from the arbitrary's generation, so the
    property does not re-implement the parse loop.
- **`test/unit/domain/objects/tree-cursor.properties.test.ts`** (108 lines). Its
  `WalkedEntry` (L28–32) and `walkAll` (L33–41) compare `(mode, name, oid)` against
  `parsed.entries.map(({ mode, name, id }) => …)`. Under ADR-749 that must widen to name
  **bytes**, or it silently stops being a differential oracle for the field this change is
  about: add `nameBytes: c.buf.slice(c.nameStart, c.nameEnd)` to `WalkedEntry` and
  compare against `parsed.entries.map(({ mode, name, nameBytes, id }) => …)`. Feed it
  `arbTreeEntryRawName()`.
- **`test/unit/application/primitives/internal/resolve-tree-path.test.ts`** — two tests
  break and are the direct consequence of the one-line change above:
  - **L363–387** (`'Then decodes at most the matched entry …'`) spies
    `vi.spyOn(treeCursorMod, 'cursorName')` and expects 1 call. The descent no longer
    calls `cursorName` at all on the hit path. Re-base to: the spy is called **0** times,
    plus `expect(result?.name).toBe('ab')` and `expect(result?.nameBytes).toEqual(encode('ab'))`.
    Update the comment to say the only decode now happens inside the factory, once, for
    the entry that is actually returned.
  - **L778–796** asserts `toEqual({ kind: 'changed', entry: { mode, name, id }, oidChain })`.
    Build the expected entry with `treeEntry(FILE_MODE.REGULAR, 'file', leafId)`.
- **Newly-reachable materialisation refusals** (§5c) — these become reachable *in this
  part*, because both routes go through `parseTreeContent` (`walkTree` → `readTree`), and
  a `.`-named entry that used to die there now reaches `verifyPath`. Without them,
  ADR-753's refusal is asserted nowhere once the parse-layer tests are inverted:
  - `test/unit/application/primitives/build-index-from-tree.test.ts` — a tree with a
    `.`-named entry now throws `INVALID_INDEX_ENTRY` with
    `data.reason === "'.' segment rejected"` and `data.offset === -1` (`NO_PARSER_OFFSET`).
    Same for `..` → `"'..' segment rejected"`. The refusal comes from
    `build-index-from-tree.ts:114` `projectLeaf` → `validateIndexPath(leaf.path,
    NO_PARSER_OFFSET, leaf.mode)`; **no new src code**, the branch just became reachable.
    The reason strings live in `src/domain/git-index/path-validator.ts`'s
    `VERIFY_PATH_REASON` table.
  - `test/unit/application/primitives/materialize-tree.test.ts` — the same two, through
    `materializeTree` → `applyChangeset` → `validateChangesetEntry`
    (`apply-changeset.ts:152`).
  - Assert `data.code`, `data.reason` **and** `data.offset` in a `try`/`catch`, never
    `toThrow(TsgitError)` — `audit-assert-tier`'s `bareClassToThrow` heuristic is
    **gating**.

#### Surface gates

`reports/api.json` changes again (`TreeEntry` gains `nameBytes`, `treeEntry`'s signature
widens to `string | Uint8Array`). Regenerate with `npm run docs:json` and commit.

#### Mutation notes (`.claude/workflow/mutation.md` runs later; size the tests now)

- `hasNonOctalByte`'s `byte < OCTAL_ZERO || byte > OCTAL_SEVEN` needs both boundary
  bytes tested independently — a single test triggering both proves neither guard.
- `treeEntry`'s copy: only the "mutate the caller's array afterwards" test kills a
  by-reference mutant.
- ADR-754's reordering is invisible to any test that triggers one fault at a time. The
  doubly-malformed fixture (non-octal mode **and** name `.`, expecting the **mode**
  fault) is its only killer — add it here as well as in the interop suite.
- Coverage: `src/domain/**` is gated at 100 % line/branch/function/statement
  (`vitest.config.ts` L82–95), so `tree-entry-bytes.ts` and every new branch in `tree.ts`
  and `tree-diff.ts` must be fully covered in this part.
- Mutation budget (`mutation-budgets.json`, glob-based, no per-file rows): everything this
  part touches under `src/domain/**` sits in the **domain** bucket —
  `high 100 / low 100 / break 99`. There is no slack; a single killable survivor in
  `tree.ts`, `tree-entry-bytes.ts` or `tree-diff.ts` fails the PR gate.
  `src/application/**` (Parts 3 and 4) is `high 100 / low 98 / break 95`.
- `check:dead-code` (knip): `tree-entry-bytes.ts`'s `hasNonOctalByte` has two `src`
  consumers on landing (`tree-cursor.ts`, `tree.ts`), so it is not flagged. Do **not**
  add `entryNameKey` here — it has no consumer until Part 5 and knip would reject it.

### TDD steps

1. **RED — factory bytes.** Add the `treeEntry` byte tests (BOM `Uint8Array`, `FF`
   `Uint8Array`, string/bytes equivalence, caller-array mutation) to
   `tree.test.ts`. Failure: `Property 'nameBytes' does not exist on type 'TreeEntry'`
   (type) and `undefined` at runtime.
2. **RED — round trip.** Add the `serializeTreeContent(parseTreeContent(b))` `toEqual` `b`
   test for a BOM-bearing tree. Failure: re-emitted bytes are `61`, not `EF BB BF 61` —
   the BOM was eaten by `decode()`.
3. **GREEN.** Land the type, the factory, the four `nameBytes` readers and
   `encodeEntryName`'s signature change.
4. **RED — parse tier.** Add the two new guard rows (`'malformed mode'` for `10064a` and
   for an empty mode) and re-point the empty-name row to `'empty filename'`, plus the
   doubly-malformed fixture. Failure: today they surface as `INVALID_FILE_MODE`
   (`value: '10064a'` / `value: ''`) and `'invalid entry name: '`.
5. **GREEN.** Create `tree-entry-bytes.ts` with `hasNonOctalByte`, import it back into
   `tree-cursor.ts`, and insert steps 2 and 4 of the new order into `parseTreeContent`.
6. **RED — acceptance.** Add the ten accept-and-assert tests (§1b rows 2–7, 9, 10, 11,
   14) **and**, in the same red run, the four newly-reachable materialisation tests
   (`build-index-from-tree` and `materializeTree`, `.` and `..`, each isolated). The first
   ten fail with `INVALID_TREE_ENTRY` `'invalid entry name: …'` / `'duplicate entry
   name: …'`; the last four fail with `INVALID_TREE_ENTRY` where they expect
   `INVALID_INDEX_ENTRY { offset: -1, reason: "'.' segment rejected" }` — i.e. the refusal
   is still at the wrong layer. That is exactly ADR-753's "the refusal moves layer" made
   observable, and it is why these tests belong in this part and not a later one.
7. **GREEN.** Delete the name-shape line, the `names` Set and the two reason strings. All
   fourteen tests from step 6 go green together — no new src code is needed for the last
   four; `build-index-from-tree.ts:114` and `apply-changeset.ts:152` already carry
   `validateIndexPath`, the branch merely became reachable.
8. **RED — descent construction.** Fix the two `resolve-tree-path.test.ts` expectations
   to the new shape; they fail against the string-fed factory.
9. **GREEN.** Change `resolve-tree-path.ts:218` to hand the factory the raw name slice.
10. **RED — the fifth key.** Add the `FE`/`FF` `diffTrees` change-count test, plus the
    `walk-submodules` and `notes/load` narrowing tests. Failure: one change instead of
    two, and the BOM-prefixed names still matching.
11. **GREEN.** Point `tree-diff.ts`'s `entryKey` at `entry.nameBytes` and drop its now
    unused `encode` import.
12. **REFACTOR.** Widen `tree-cursor.properties.test.ts` to bytes; add
    `arbTreeEntryRawName` and the two properties; fix `dedupeTreeEntriesByName`'s comment;
    add `tree-entry-bytes.test.ts`; run `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run \
  test/unit/domain/objects/tree.test.ts \
  test/unit/domain/objects/tree.properties.test.ts \
  test/unit/domain/objects/tree-entry-bytes.test.ts \
  test/unit/domain/objects/tree-cursor.test.ts \
  test/unit/domain/objects/tree-cursor.properties.test.ts \
  test/unit/application/primitives/internal/resolve-tree-path.test.ts \
  test/unit/application/primitives/build-index-from-tree.test.ts \
  test/unit/application/primitives/materialize-tree.test.ts \
  test/unit/application/primitives/walk-submodules.test.ts \
  test/unit/domain/diff/tree-diff.test.ts \
  test/unit/domain/notes/load.test.ts \
  && npx vitest run test/unit \
  && npm run check:types \
  && npm run docs:json \
  && ./node_modules/.bin/biome check src/domain/objects src/domain/diff/tree-diff.ts src/application/primitives/internal/resolve-tree-path.ts test/unit/domain test/unit/application/primitives
```

(As in Part 1: regenerate `reports/api.json` and stage it in this part's commit.)

### Commit

```
feat(tree)!: preserve tree entry name bytes and split the parse tier
```

---

## Part 3 — Flatten accepts every name git accepts, and emitted paths keep their bytes

### Context

**What changes:** `flatten-raw.ts` drops its name-shape refusal (ADR-753); `cursorName`
switches to the BOM-preserving decoder (§4c, DC-P1); the merge worktree writers gain the
`validateIndexPath` call that closes the hole ADR-753 opens (ADR-753 *Correction*,
design DC-C(a)).

#### `src/application/primitives/internal/flatten-raw.ts`

- Delete `validatedName(cursor)` (L188–200) **and its comment block**. `flattenEntry`
  (L167) becomes `const path = joinPath(prefix, cursorName(cursor));`.
- Remove `invalidTreeEntry` from the `'../../../domain/objects/error.js'` import (L28–33)
  — it becomes unused and `noUnusedLocals` is on. `treeCycleDetected`,
  `treeDepthExceeded` and `treeEntryLimitExceeded` stay.
- Nothing else in this file moves: the cycle stack, depth cap, entry counter, abort check
  and prefetch window are untouched.

#### `src/domain/objects/tree-cursor.ts` — the decoder swap (DC-P1)

`cursorName` (L200–202) currently `return decode(c.buf.subarray(c.nameStart, c.nameEnd));`
→ `decodePreservingBom(...)`; update the module import (`import { decode, indexOf } from
'./encoding.js';` → `decodePreservingBom`; `decode` becomes unused in this module —
verify and drop it).

**Its four production consumers, measured — the design's §4c under-counts them:**

| consumer | line | what changes |
|---|---|---|
| `src/application/primitives/internal/flatten-raw.ts` | 195 | a bare-BOM entry's path goes from `prefix/` (empty final segment) to `prefix/<U+FEFF>` |
| `src/application/primitives/internal/walk-raw-subtree.ts` | 174 | same, on `walkTree`'s raw subtree walk |
| `src/domain/diff/raw-tree-diff.ts` | 70, 79, 88 | emitted `newPath`/`oldPath` keep the BOM. **Emit only — no verdict, no refusal, no comparison changes** (`compareCursorNames` / `cursorNameEquals` are already byte-level and are untouched), so every ADR-723 pin in `test/integration/tree-diff-corrupt-interop.test.ts` stays green |
| `src/application/primitives/internal/resolve-tree-path.ts` | 211, 214 | refusal-message text only; both messages are deleted in Part 4 |

**A second behaviour change lands here and it is a fix (§5c).** Today a *nested* bare-BOM
entry (`40000 sub` → an entry named exactly `EF BB BF`) yields the path `sub/` on both
the flatten and the `walkTree` route, and `verifyPath` then refuses it as
`'empty-segment'`. After the swap the path is `sub/<U+FEFF>`, `verifyPath` accepts it,
and the entry materialises — which is what git does (§1b row 3). **One
`INVALID_INDEX_ENTRY` that fires today stops firing.** It needs its own before/after test
rather than being noticed as a missing refusal.

#### DC-C — the merge worktree writers (ADR-753's one piece of genuinely new enforcement)

Today `flatten-raw.ts`'s `validatedName` is the only thing between a `.`-named entry in a
merged tree and a working-tree write. Once it is gone, two writers have no check in front
of them (`build-index-from-tree` and `apply-changeset` already have one — measured; do not
add a second):

1. **`src/application/primitives/apply-merge-to-worktree.ts`**, `writeConflictWorktree`
   (the `for (const outcome of outcomes)` and `for (const conflict of conflicts)` loops).
2. **`src/application/commands/merge.ts`**, exported `writeOutcomeToTree` (L~673) and
   `writeConflictToTree` (L~697).

Add, mirroring `apply-changeset.ts:152`'s exact shape:

```ts
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
…
validateIndexPath(path, NO_PARSER_OFFSET, mode);
```

- **`MergeOutcome`'s shape decides where the call goes**
  (`src/domain/merge/merge-types.ts:38–58`): `unchanged`, `resolved-known` and
  `resolved-merged` carry `path` **and** `mode`; `resolved-deleted` carries only `path`;
  `conflict` carries a `MergeConflict` and no path of its own. So the call cannot sit
  unguarded at the top of `writeOutcomeToTree` — `outcome.mode` does not exist on two
  arms. Write it as one narrowing guard, first statement:

  ```ts
  if (outcome.status !== 'resolved-deleted' && outcome.status !== 'conflict') {
    validateIndexPath(outcome.path, NO_PARSER_OFFSET, outcome.mode);
  }
  ```

  **Skipping `resolved-deleted` is deliberate**, mirroring `validateChangesetEntry`'s
  documented rule ("`delete`/`noop` entries are skipped: their path already passed this
  same check when the CURRENT index was parsed") — and a delete creates no file. Say so
  in a comment, or a reviewer reads it as a hole.
- For conflicts, validate **after** the mode is resolved
  (`const mode = conflict.mergedMode ?? conflict.ourMode ?? conflict.theirMode;` followed
  by the existing `if (mode === undefined) return;`), so the call always has a real mode.
- `writeDistinctTypesSides` is reached from the conflict branch of both writers **before**
  that mode resolution (`writeConflictToTree` L~701, `writeConflictWorktree`'s conflict
  loop). Put the conflict-path validation ahead of the `distinct-types` dispatch, using
  the same `mergedMode ?? ourMode ?? theirMode` fallback, so one call covers both routes.
- In `apply-merge-to-worktree.ts::writeConflictWorktree`, the outcome loop's first
  statement is `if (outcome.status === 'conflict' || !changed.has(outcome.path)) continue;`
  — put the validation **after** that guard, so an unchanged path the merge never writes
  is not newly refused.
- Error shape: `INVALID_INDEX_ENTRY { offset: -1, reason: "'.' segment rejected" }` /
  `"'..' segment rejected"`, from
  `src/domain/git-index/path-validator.ts`'s `VERIFY_PATH_REASON`.
- §5c's equivalence, worth keeping in a comment: `verifyPath` splits a `FilePath`
  *string* on `/` and compares segments to `'.'` / `'..'`. That is byte-exact for this
  predicate — UTF-8 decoding produces `"."` only from `0x2E`, `".."` only from
  `0x2E 0x2E`, and after the decoder swap `EF BB BF 2E` decodes to `"﻿."`, which is
  not `"."`. Invalid UTF-8 decodes to U+FFFD, also not `"."`.

#### Test surface

- **`test/unit/application/primitives/flatten-tree.test.ts`** (629 lines). Helpers in
  file: `rawEntry(mode, name, id)`, `concatBytes`, `writeRawObjectBytes`,
  `buildSeededContext`, `writeBlob`.
  - **Invert four refusal blocks** into acceptance, asserting the produced path:
    L388–408 (`'.'`), L412–432 (`'..'`), L436–458 (DIRECTORY-mode `'..'`), L460–480
    (`'a/b'` — assert the path is the two-segment `a/b`, which is what git's index
    stores). Each becomes `Given a tree entry named X` / `When flattenTree runs` /
    `Then the entry is flattened at path X`.
  - **Keep unchanged**: the empty-name block at L362–385 (the cursor's own
    `'empty filename'` refusal survives — ADR-753 explicitly does not cover empty names)
    and the last-wins duplicate test at L482+ (add §1b row 14 as its named oracle in the
    comment: `git read-tree` keeps the **last**).
  - **New — bare-BOM regression, with a failing baseline.** A tree whose sole entry is
    named exactly `EF BB BF` flattens to the path `"﻿"`, not `""`. Today it yields
    an entry keyed on the empty string. Build the fixture with a raw byte name, not a
    source literal.
  - **New — nested bare-BOM (§5c before/after).** `40000 sub` → a tree whose sole entry is
    named `EF BB BF`: `flattenTree` yields `sub/﻿`. Today it yields `sub/`.
  - **New — ADR-757's asserted limit.** Two sibling entries named `FE` and `FF`: the
    `FlatTree` carries **one** entry (the string `FilePath` collapses them), and the test
    says so explicitly, citing that git's index carries two. Assert at the `FlatTree`
    level only — never by comparing worktree contents (`checkout-index` itself fails on
    those names on APFS).
- **`test/unit/application/primitives/internal/flatten-raw.test.ts`** — the `'..'`
  refusal row at ~L590–618 asserts `'invalid entry name: ..'`. Re-base to acceptance; the
  fixture's second, truncated entry means the *tail* must still refuse with
  `'truncated hash'`, so the test keeps its point (a later structural fault still fires)
  with a different oracle. Sweep the file for other `invalid entry name` assertions.
- **`test/unit/application/primitives/diff-trees.test.ts:704–708`** — measured to fail:
  `expect(decodeSpy.mock.calls.length).toBe(3)` becomes `2` because `cursorName` no longer
  goes through `decode`. Add a `decodePreservingBom` spy and assert the pair
  (`decode` 2, `decodePreservingBom` 1), so the "calls scale with entries actually read"
  intent survives instead of being weakened to a smaller number.
- **`test/unit/application/primitives/internal/walk-raw-subtree.test.ts`** — new: a
  bare-BOM entry name reaches `walkTree` as `﻿`, not `''`.
- **`test/unit/domain/diff/raw-tree-diff.test.ts`** — new: a BOM-bearing name is emitted
  as a `FilePath` carrying the BOM. This is DC-P1's pin.
- **`test/unit/application/primitives/apply-merge-to-worktree.test.ts`** and
  **`test/unit/application/commands/merge.test.ts`** — DC-C: a merge whose merged tree
  carries a `.`-named (and a `..`-named) path refuses with `INVALID_INDEX_ENTRY` and the
  matching `reason`, **before any working-tree write happens** (assert the file was not
  created, or that the write port was never called). `writeOutcomeToTree` and
  `writeConflictToTree` are exported specifically for direct unit testing — use them.
  Isolated cases for `.` and `..` separately: one test triggering both proves neither
  guard.
- Assertion tier: `try`/`catch` + direct `.data` assertions, never `toThrow(TsgitError)`
  (`bareClassToThrow` is gating).

### TDD steps

1. **RED — bare-BOM path.** Add the flatten bare-BOM test (single-level and nested).
   Failure: path is `''` / `'sub/'`, the BOM was eaten.
2. **GREEN.** Swap `cursorName`'s decoder in `tree-cursor.ts`.
3. **GREEN — fix the call-count fallout.** Update `diff-trees.test.ts:706` to the
   `decode` + `decodePreservingBom` pair.
4. **RED — emit-surface pins (DC-P1).** Add the `walk-raw-subtree` and `raw-tree-diff`
   BOM-path tests; they pass immediately after step 2 — write them **before** step 2 in
   the same red run so the baseline is observed.
5. **RED — flatten acceptance.** Invert the four shape blocks in `flatten-tree.test.ts`
   and the `'..'` row in `flatten-raw.test.ts`. Failure: `INVALID_TREE_ENTRY`
   `'invalid entry name: …'`.
6. **GREEN.** Delete `validatedName` and drop the now-unused `invalidTreeEntry` import.
7. **RED — DC-C.** Add the four merge-writer refusal tests (`.` / `..` × two writers).
   Failure: no throw, and a file gets written.
8. **GREEN.** Add `validateIndexPath` to `writeOutcomeToTree`, `writeConflictToTree` and
   `writeConflictWorktree`'s two loops.
9. **RED — ADR-757.** Add the `FE`/`FF` sibling-collapse assertion. It passes on landing;
   its value is that it fails the day someone claims otherwise. Comment it as the
   asserted limit, citing that git's index carries two entries.
10. **REFACTOR.** Re-read `flatten-raw.ts`'s module header — its "with the same guards …
    name validation" claim is now stale; update the sentence.

### Gate

```
npx vitest run \
  test/unit/application/primitives/flatten-tree.test.ts \
  test/unit/application/primitives/internal/flatten-raw.test.ts \
  test/unit/application/primitives/internal/walk-raw-subtree.test.ts \
  test/unit/application/primitives/diff-trees.test.ts \
  test/unit/application/primitives/apply-merge-to-worktree.test.ts \
  test/unit/application/commands/merge.test.ts \
  test/unit/domain/diff/raw-tree-diff.test.ts \
  test/unit/domain/objects/tree-cursor.test.ts \
  && npx vitest run test/unit \
  && npx vitest run test/integration/tree-diff-corrupt-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/objects/tree-cursor.ts src/application/primitives src/application/commands/merge.ts test/unit/application test/unit/domain/diff
```

### Commit

```
fix(tree): flatten every name git accepts and keep entry-name bytes in paths
```

---

## Part 4 — Path descent goes byte-level, first-wins, and matches the whole remaining path

### Context

**Subject file:** `src/application/primitives/internal/resolve-tree-path.ts` (818-line
test, 250-line source). Four changes, all ruled: drop the refusals (ADRs 752, 753),
first-wins tie-break (ADR-752), root-level byte comparison (ADR-749), whole-remaining-path
match (ADR-759).

#### 1. Deletions (ADRs 752, 753)

- `isInvalidEntryNameBytes` (L222–250) — **deleted with its `Stryker disable next-line
  EqualityOperator` comment** (L243). The proof in that comment cites that loop's bound
  and that covering set; neither survives. **Never relocate it onto a surviving loop.**
  Its `DOT = 0x2e` / `SLASH = 0x2f` constants go too.
- `type NameSpan` (L204) and the `seenNames: NameSpan[]` array and its `.some(...)`
  duplicate check (L213–216).
- Both reason strings: `invalid entry name: ${cursorName(cursor)}` (L211) and
  `duplicate entry name: ${cursorName(cursor)}` (L214). After this part neither exists
  anywhere in the codebase.
- `invalidTreeEntry` and `cursorName` become unused imports — drop them
  (`noUnusedLocals`).
- **Keep** `const mode = cursorMode(cursor);` as the **first** statement of `scanEntry`.
  ADR-723's carried-forward ruling is that mode validation stays eager per visited entry;
  removing it would change the refusal set.

`scanEntry` reduces to: read the mode (eager), byte-compare the name, return
`treeEntry(mode, cursor.buf.subarray(cursor.nameStart, cursor.nameEnd), cursorOid(cursor))`
on a match (that construction already landed in Part 2), `undefined` otherwise.

#### 2. First-wins descent (ADR-752, §4b)

`scanRawTreeFor` (L186–201) currently:

```ts
let matched: TreeEntry | undefined;
while (!cursor.done) {
  matched = scanEntry(cursor, seenNames, target) ?? matched;   // keeps the LAST
  advanceCursor(cursor);
}
```

becomes `matched ??= scanEntry(cursor, target);` — **first**-wins, matching
`git rev-parse <tree>:a` → the first blob (§1b re-pin). The last-wins behaviour was
unreachable until now because the duplicate check threw first.

**The loop still runs to the end of the directory.** Breaking out on the first match
would be faster, but `scanEntry` calls `cursorMode` on every visited entry, so an early
break would silently stop raising `INVALID_FILE_MODE` for a malformed mode *after* the
match — a refusal-set change ADR-723's carried-forward ruling does not permit. Put that
in a comment; the module's existing doc-comment (L176–184) says the opposite today
("the duplicate name refusal … has to fire identically here") and must be rewritten.

#### 3. Root-level byte comparison (ADR-749, §4b)

`findTreeEntry` (L52–63) does
`rootTree.entries.find((candidate) => candidate.name === segments[0])` — a **string**
compare, where every deeper level uses `cursorNameEquals` on bytes. `Array.find` is
already first-wins so the tie-break is right; the *comparison* is not. It becomes a byte
comparison against `candidate.nameBytes` (use `bytesEqual` from
`src/domain/objects/encoding.ts:59`, already exported), with the target encoded once.
Otherwise `<tree>:<U+FFFD>` resolves against an `FF`-named entry where git resolves
against nothing.

#### 4. Whole-remaining-path match (ADR-759)

Measured, git 2.55.0, on a tree whose sole entry is literally named `a/b`:
`git rev-parse <tree>:a/b` → `c1b0730e…` (resolves); `git rev-parse <tree>:a` →
`fatal: path 'a' does not exist`. git's tree walk compares entry names against a prefix
of the **whole remaining path**.

ADR-759 rules option 1: **on a segment miss, also try the whole remaining path**; the
**hit path stays untouched** (it is a measured hot path with its own benchmarks). Shape
to implement:

```ts
interface LevelMatch { readonly entry: TreeEntry; readonly consumedAll: boolean; }
```

At level `i` over `segments`:

1. scan for `segments[i]` — on a hit, `{ entry, consumedAll: i === segments.length - 1 }`;
2. on a miss, **and only when `i < segments.length - 1`**, re-scan the level's
   already-read content for `segments.slice(i).join('/')` — on a hit,
   `{ entry, consumedAll: true }`;
3. otherwise `undefined`.

The loop stops when `consumedAll` is true or the match is `undefined`. The re-scan reuses
the buffer `readRawObject` already returned — no second read. Re-running `cursorMode` over
the directory on the miss path is idempotent (it throws the same refusal or nothing), so
no verdict changes.

Three call sites need it:

- `findTreeEntry` (L52–63) — root level (`rootTree.entries`, parsed) and every deeper
  level (`descendOneLevel`).
- `descendMatchingTreeChain` (L104–120) — `scanRootLevel` for the root, `descendOneLevel`
  below. A whole-remaining-path match simply ends the descent with a shorter `chain`;
  the TREESAME comparison is position-wise, so a shorter accurate chain stays valid.
- `findTreeEntryChain` (L131–137) delegates to `descendMatchingTreeChain` — no separate
  change.

`descendOneLevel` (L163–170) and `scanRootLevel` (L145–153) take a `name: string` today;
give them the remaining-path argument (or pre-encoded targets) rather than re-splitting.

`<tree>:.` and `<tree>:..` need no special case: git resolves both, and tsgit's split
yields the single segment `.` / `..`, matches the entry by name and resolves too. No path
validation sits in front of `findTreeEntry` — verified by reading the file: it splits and
descends, nothing more.

#### Test surface

- **`test/unit/application/primitives/internal/resolve-tree-path.test.ts`** (818 lines).
  Helpers in file: `rawEntry(mode, name, oid?)`, `rawEntryByteLength(mode, name)`,
  `concatBytes`, `writeRawObjectBytes`, `writeTree`, `buildSeededContext`, `blobOf(n)`,
  `ARBITRARY_OID`, and `vi.spyOn(treeCursorMod, 'cursorName')`.
  - **Invert two `it.each` blocks to acceptance** — L~420–458 ("a shape-invalid entry in
    an intermediate raw-scanned directory") and L~460–500 ("at the tree ROOT
    (chain-descent scan)"). Both sweep `'.'`, `'..'`, `'a/b'`, `'/'`, `'a/'`, `'/a'`,
    `'//'`, `'./'`, `'/.'` alongside a `'good'` sibling and expect
    `invalid entry name: <name>`. They become: the sibling `'good'` still resolves, and
    the odd-named entry resolves under its own literal name.
  - **Keep unchanged**: the empty-name sibling block at L~502–530 (the cursor's
    `'empty filename'` refusal survives) and the malformed-mode sibling block at
    L~560+ (eager `INVALID_FILE_MODE` survives — it is the reason the loop cannot break
    early).
  - **Replace the duplicate-refusal block at L~532–558** with the **first-wins**
    assertion: two `dup` entries with oids `a…a` and `b…b`; `findTreeEntry(ctx, rootId,
    'dir/dup')` returns the **first** (`a…a`). This is the *only* test that kills the
    `matched ??= …` → `matched = … ?? matched` mutant — every test with a unique target
    name is blind to it. Name it so in a comment.
  - **New — root-level byte comparison.** A directory whose entry is named by the raw
    byte `FF`; `findTreeEntry(ctx, rootTree, '�')` (the decoded replacement
    character) must **not** resolve, while a query encoded to the raw `FF` byte does.
    Build the query through the `Tree` overload so the root branch is the one under test.
  - **New — ADR-759.** (a) a tree whose sole entry is literally named `a/b`:
    `findTreeEntry(ctx, rootId, 'a/b')` resolves it; (b) the same tree,
    `findTreeEntry(ctx, rootId, 'a')` returns `undefined`; (c) a two-level tree where
    `a/b` exists as a real subtree path **and** a sibling entry is literally named `a/b` —
    the real path wins (segment match is tried first); (d) the same through
    `findTreeEntryChain` / `descendMatchingTreeChain`, asserting the `oidChain`;
    (e) `<tree>:.` and `<tree>:..` resolve.
- **`test/unit/application/primitives/internal/resolve-tree-path.properties.test.ts`**
  (175 lines). The property at L~123–172 ("Given a tree whose directory holds a duplicate
  entry name … Then it always refuses") uses `duplicateDirectoryArb()` from
  `test/unit/application/primitives/internal/arbitraries.ts`. Re-point it: for an
  arbitrary directory with a duplicated target name, the descent returns the **first**
  matching entry's oid. Keep `numRuns: 100`. The differential-oracle property at L~100–122
  (`findTreeEntryOracle`, a verbatim copy of the pre-rewrite parsed-tree descent) must be
  checked: the oracle uses `current.entries.find(e => e.name === segment)` and now
  disagrees on byte-distinct names and on the whole-remaining-path case. Constrain that
  property's arbitrary to names the oracle still models, or update the oracle in step
  with the production change and say in the comment which git behaviour it now models.
- **Consumers to smoke-test** (`blame`, `read-file-at`, `rev-parse <tree-ish>:<path>`):
  `test/unit/application/commands/read-file-at.test.ts` and
  `test/unit/application/commands/rev-parse.test.ts` get one case each for the `a/b`
  literal-entry resolution, so ADR-759's stated consequence is asserted at the command
  surface and not only at the internal.

#### Mutation notes

- `matched ??=` — see above; only the duplicate-name descent test kills it.
- The whole-remaining-path guard `i < segments.length - 1` is an off-by-one magnet: case
  (b) above (single-segment path, no fallback) is what separates `<` from `<=`.
- `resolve-tree-path.ts` is **not** coverage-gated (`vitest.config.ts` covers
  `src/domain/**`, `src/ports/**`, node/memory adapters and `src/operators/**` only) but
  it **is** mutation-gated. Every new branch needs an observable test.

### TDD steps

1. **RED — first-wins.** Replace the duplicate-refusal test with the first-wins
   assertion. Failure: `INVALID_TREE_ENTRY 'duplicate entry name: dup'`.
2. **RED — shape acceptance.** Invert the two `it.each` blocks. Failure:
   `invalid entry name: …`.
3. **GREEN.** Delete `isInvalidEntryNameBytes` + its Stryker comment + `NameSpan` +
   `seenNames`; change the accumulate to `matched ??=`; drop the dead imports; rewrite the
   `scanRawTreeFor` doc comment.
4. **RED — root byte comparison.** Add the `FF` vs `U+FFFD` root-level test. Failure: the
   `U+FFFD` query resolves against the `FF` entry.
5. **GREEN.** Swap `rootTree.entries.find(c => c.name === …)` for a `bytesEqual` compare
   on `candidate.nameBytes`.
6. **RED — ADR-759.** Add cases (a)–(e). Failure: `PATH_NOT_IN_TREE` / `undefined`
   for the literal `a/b` entry.
7. **GREEN.** Introduce `LevelMatch` and the miss-path whole-remaining-path re-scan in
   `findTreeEntry` and `descendMatchingTreeChain`.
8. **REFACTOR.** Re-point the duplicate property; reconcile `findTreeEntryOracle`; add the
   two command-surface cases.

### Gate

```
npx vitest run \
  test/unit/application/primitives/internal/resolve-tree-path.test.ts \
  test/unit/application/primitives/internal/resolve-tree-path.properties.test.ts \
  test/unit/application/commands/read-file-at.test.ts \
  test/unit/application/commands/rev-parse.test.ts \
  test/unit/application/commands/blame.test.ts \
  && npx vitest run test/unit \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/resolve-tree-path.ts test/unit/application/primitives/internal test/unit/application/commands
```

### Commit

```
fix(tree): descend tree paths on bytes, first-wins, matching the whole remaining path
```

---

## Part 5 — fsck decides on raw bytes and adopts git's parse tier

### Context

**Subject files:** `src/domain/fsck/validate-tree.ts` (the worst of the four sites — one
decoder defect producing four wrong verdicts plus the mode-tier collapse),
`src/domain/fsck/msg-ids.ts`, `src/domain/fsck/severity.ts`, and
`src/domain/objects/tree-entry-bytes.ts` (gains `entryNameKey`).

`validateTree(raw, strict, digestLength)` has exactly one caller,
`validateObject` (`src/domain/fsck/validate-object.ts:59–70`), whose contract is
documented as "NEVER throws — it classifies faults and returns them". Keep that true.

#### `src/domain/objects/tree-entry-bytes.ts` — add `entryNameKey`

```ts
/**
 * Lossless byte→string key for fsck's duplicate set and its name comparisons
 * (ADR-751). One code unit per byte, accumulated in bounded chunks — never a
 * spread over a whole 4096-byte name.
 */
export function entryNameKey(buf: Uint8Array, start: number, end: number): string;
```

Implementation: walk in chunks (e.g. 1024) and `String.fromCharCode(...)` per chunk.
`TextDecoder('latin1')` is **not** an option — ADR-751 records why (it is injective, so
it would work as a key, but it is not reversible to the original byte, which makes any
later use of the key as a name silently wrong).

There is deliberately **no** `entryNameByteLength` export: git's `largePathname` counts
`end - start`, and wrapping a subtraction buys nothing.

**The key is one-code-unit-per-byte, so for an ASCII literal the key *is* the string.**
That makes every fsck name comparison byte-exact for free — no per-byte helpers needed:

| check | byte-exact form |
|---|---|
| `hasDot` | `key === '.'` |
| `hasDotdot` | `key === '..'` |
| `hasDotgit` | `key === '.git'` |
| `fullPathname` | `key.includes('/')` — `0x2f` never appears as a UTF-8 continuation byte |
| `largePathname` | `nameEnd - nameStart > MAX_NAME_BYTES` (**raw** bytes) |
| `checkSpecialFileName` | `key === '.gitmodules'` / `'.gitattributes'` / `'.gitignore'` / `'.mailmap'` |

A non-ASCII byte maps to a code unit ≥ 0x80 and can never equal an ASCII one, so no
byte sequence other than the intended one reaches a finding, and none that should can
escape it. Keep these comparisons **private to `validate-tree.ts`** (DC-A(a)).

#### `src/domain/fsck/validate-tree.ts`

- **Local `interface TreeEntry` (L30–35)** — unrelated to the published one — becomes
  `{ mode: string; nameStart: number; nameEnd: number; sha: Uint8Array; offset: number }`,
  spans over the shared `raw` buffer (§5d). `validateTree` threads `raw` into
  `checkEntryFaults` / `checkNameFaults` / `checkSpecialFileName` / `treeEntrySortKey`.
- **`const DECODER = new TextDecoder()` (L37) is deleted for names.** The **mode** decode
  stays (§3d): once the parse tier rejects a non-octal mode, every mode span reaching the
  check tier is pure ASCII octal, so `mode.startsWith('0')` and `VALID_MODES.has(normMode)`
  keep working on a decoded string. That is the one place a decode survives on purpose —
  comment it, or a reviewer reads it as a missed site.
- **`parseTreeEntriesTolerant` (L52–86) gains the parse tier** (ADR-754), in this order:
  1. `spaceIdx === -1 || spaceIdx === offset` → `badTree` (already there)
  2. **`hasNonOctalByte(raw, offset, spaceIdx)` → `badTree`** (NEW — today a `10064a`
     mode falls through to `VALID_MODES` and is reported `badFilemode:info` where git
     reports `badTree:error`)
  3. `nullIdx === -1` → `badTree` (already there)
  4. **`nullIdx === spaceIdx + 1` (empty name) → `badTree`** (NEW — today `emptyName:warning`)
  5. `shaEnd > raw.length` → `badTree` (already there)
- **`checkNameFaults` (L100–130)** loses its `if (name === '') { … MSG_EMPTY_NAME … }`
  early return entirely (the case can no longer reach it) and switches its four
  comparisons plus the length check to the byte forms above.
- **`treeEntrySortKey` (L90–98)** builds from the raw name span plus the virtual trailing
  `/` for directories — no `ENCODER.encode(entry.name)`. `ENCODER` is then unused; delete
  it. `compareBytes` stays.
- **`checkEntryFaults`'s `seenNames: Set<string>` (L182–186, 240–246)** is re-keyed on
  `entryNameKey`, so `FE` and `FF` stop colliding.
- **`ENCODER`/`DECODER` removal** must leave `import { compareBytes, indexOf } from
  '../objects/encoding.js';` intact.

#### ADR-755 — delete `emptyName`

Three referents, all measured:

- `src/domain/fsck/msg-ids.ts:12` — `export const MSG_EMPTY_NAME = 'emptyName' as const;`
- `src/domain/fsck/severity.ts:74` — the `DEFAULT_SEVERITY` row `[MSG_EMPTY_NAME, 'warning']`
- `src/domain/fsck/severity.ts:143` — its membership in `STRICT_UPGRADE_SET`

plus the import in `severity.ts:16` and in `validate-tree.ts:6`.

Severity follows the msg-id, so `badTree`'s `error` replaces `emptyName`'s `warning`,
which changes fsck's **exit code** from 0 to 1 on an empty-name tree without `--strict` —
matching §1b row 13.

`docs/use/commands/fsck.md:208` lists `emptyName` in a msg-id enumeration. Remove it
there in this part: it names a constant that no longer exists, which is a correctness
fact, not a prose refresh. (The `read-tree.md` / `write-tree.md` rewrites stay with the
documentation phase.)

#### The two-pass agreement comes free (§1d)

`src/application/commands/fsck.ts` runs two passes: the content-validation pass
(`validateObject` → `validateTree`, raw bytes) and the object-cache pass
(`internal/fsck/object-cache.ts` → `readObject` → `parseObject` → `parseTreeContent`,
where a throw yields `CachedGitObject = null` — the "unreadable object" value that feeds
connectivity and `buildBlobFilenameMap`). Today a BOM-name tree that real git reports
clean produces `emptyName` from one pass and "unreadable" from the other. Part 2 fixed
the second pass; this part fixes the first. **No code change in `fsck.ts` or
`object-cache.ts`** — assert the agreement instead (the interop row is case 7 in Part 6;
add the unit-level version here).

#### Test surface

- **`test/unit/domain/fsck/validate-object.test.ts`** (644 lines; helpers `buildTree`,
  `buildTreeEntry`, `BLOB_SHA`). This is where `validateTree` is tested — there is no
  `validate-tree.test.ts`.
  - **L361–398 rewritten**: the two `emptyName` cases (warning / error under strict)
    become one `badTree:error` case that is identical in both `strict` modes.
  - **§1c false positives become "no finding" assertions**: bare BOM, `EF BB BF 2E`,
    `EF BB BF 2E 2E`, `FE` + `FF`, `a` + `EF BB BF 61`.
  - **§1c false negatives become "the right finding"**: `EF BB BF` + 4095 × `x`
    (4098 raw bytes) → `largePathname`; 1400 × `FF` (1400 raw bytes) → **no** finding.
  - **The 4096/4097 boundary in both encodings** (rows 21–24): 4096 × `x` accepted,
    4097 × `x` → `largePathname`, 2048 × `C3 A9` (4096 bytes) accepted, 1366 × `E2 82 AC`
    (4098 bytes) → `largePathname`. The 4096/4097 pair is the only thing that separates
    `>` from `>=`.
  - **The four sort orders** (rows 25–28): `a` then `EF BB BF 61` → no `treeNotSorted`;
    reversed → `treeNotSorted`; `FE` then `FF` → none; reversed → `treeNotSorted`. **The
    absent half is what catches a sort-key regression.**
  - **The tier split** (rows 18–20): `10064a` → `badTree:error` (today `badFilemode:info`);
    empty mode → `badTree:error` (already agrees); `777777` → `badFilemode` at `info`,
    not upgraded by `--strict`.
  - **Guard isolation** — `validate-tree.ts` is now the only site with per-fault name
    branches, so the isolation tests live here: separate cases for `.`, `..`, `.git`, a
    lone `/`, a leading `/`, a trailing `/`, `//`, and the 4096/4097 boundary, each
    triggering **only** its own finding; plus the near-miss whose *decoded* form is `.`
    but whose bytes are not (`EF BB BF 2E`). A single test triggering two faults proves
    neither guard alone.
  - **`checkSpecialFileName`'s narrowing must be pinned, not discovered later** (the
    design's *Out of scope* entry makes this an explicit obligation): a `120000` entry
    named `EF BB BF .gitmodules` is flagged `gitmodulesSymlink` today **by accident** (the
    decoder eats the BOM); after the byte-exact comparison it is **not** flagged, while
    real git still flags it (git catches it because U+FEFF is HFS-ignorable). Write the
    test asserting the new, narrower behaviour with a comment naming the exclusion. The
    repo already owns the full matcher (`src/domain/path/verify-path.ts` implements
    `is_hfs_dotgit` / `is_ntfs_dotgit` including U+FEFF) but it is wired to the index-path
    boundary, not to fsck — pointing fsck at it is a separate item with its own parity
    matrix, deliberately out of scope here.
- **`test/unit/domain/objects/tree-entry-bytes.test.ts`** — extend with `entryNameKey`:
  distinct keys for `[0xFF]`, `[0xFE]`, `[0x81]`, `[0x8D]`, `[0x90]`, `[0x9D]` (the six
  bytes §3c re-measured — `TextDecoder('latin1')` maps 27 bytes in `0x80`–`0x9F` to a
  *different* code point but collides on none, and is rejected for non-reversibility, not
  collision); a 4097-byte name producing a 4097-code-unit key **without a stack overflow**
  (this is the only test that kills an `entryNameKey` chunk-loop off-by-one — the key
  stays unique for short names either way); and an empty span returning `''`.
- **`test/unit/application/commands/fsck.test.ts:6731`** — "a dangling loose tree with a
  duplicate entry name (full decode fails, stored header still recovers)". A duplicate no
  longer makes the decode fail, so the fixture must switch to a **parse-tier fault** (a
  non-octal mode, e.g. `10064a`) to keep exercising the header-recovery path it exists
  for. Rename the `describe` accordingly. The two `makeTree([{ mode, name, id }])`
  fixtures are already factory calls after Part 1.
- **`test/unit/application/commands/internal/fsck/content-validation.test.ts:113–136`** —
  "Given a packed tree with a duplicate entry name … Then emits a duplicateEntries finding
  instead of badType". `duplicateEntries` **still fires** here (fsck remains the sole
  detector), so this test survives as-is; verify it, and add its sibling for a
  parse-tier fault → `badTree`.
- **The `.`-named packed-tree case at ~L138+** ("Then emits a hasDot finding instead of
  badType") also survives — fsck is now the *only* place `hasDot` exists.
- **Two-pass agreement (unit)** — in `fsck.test.ts`: a repo whose only object graph
  contains a BOM-named tree produces **no finding at all**, neither from the content pass
  nor as an unreadable object from the cache pass, and `exitCode === 0`.
- **`test/unit/application/commands/fsck.properties.test.ts`** — lens 3, weak but worth
  keeping: `validateTree(anyBytes, strict, 20)` never throws for arbitrary byte input.
  `numRuns: 100`. Its contract already says so; the byte-level rewrite is where it could
  regress.
- **No lens-2 property is written**, and say so in a comment if a reviewer asks: ADR-753
  deleted the aggregation this lens covered; fsck's remaining checks are independent
  single-predicate findings with no composition (no negation, no identity, no append), so
  a property over them would restate the implementation.
- **No property for the mode tiers** — a mode is a small enum plus a non-octal-byte scan;
  a parameterised example sweep is clearer (CLAUDE.md's "small enum" exclusion).

#### Coverage and mutation

`src/domain/fsck/**` is inside the 100 % coverage gate. Every deleted branch must go (no
unreachable arms left behind), and every new branch needs a test. Mutation watch-list:
`> MAX_NAME_BYTES` (the 4096/4097 pair separates `>` from `>=`), the `key === '.'` /
`key === '..'` arms, and the `entryNameKey` chunk bound.

### TDD steps

1. **RED — tier.** Add the `10064a` → `badTree` and empty-name → `badTree` cases (both
   `strict` values) to `validate-object.test.ts`. Failure: `badFilemode:info` and
   `emptyName:warning`.
2. **GREEN.** Add steps 2 and 4 of the tolerant parser's parse tier, importing
   `hasNonOctalByte` from `../objects/tree-entry-bytes.js`.
3. **GREEN — ADR-755.** Delete `MSG_EMPTY_NAME`, its `DEFAULT_SEVERITY` row, its
   `STRICT_UPGRADE_SET` membership, the two imports, and the `docs/use/commands/fsck.md`
   list entry. `check:types` + `check:dead-code` confirm no referent survives.
4. **RED — byte keys.** Add `entryNameKey`'s tests (six distinguishing bytes, 4097-byte
   name, empty span). Failure: the export does not exist.
5. **GREEN.** Add `entryNameKey` to `tree-entry-bytes.ts`.
6. **RED — the six false positives and two false negatives.** Add the §1c rows as
   no-finding / right-finding assertions, plus the four sort orders and the 4096/4097
   boundary in both encodings. Failure: `duplicateEntries` / `emptyName` / `hasDot` fire
   where git is silent; `largePathname` fires and fails to fire in the wrong places;
   `treeNotSorted` never fires.
7. **GREEN.** Re-type the local `TreeEntry` to spans, thread `raw` through, re-key
   `seenNames` on `entryNameKey`, switch `checkNameFaults` / `checkSpecialFileName` /
   `treeEntrySortKey` to the byte forms, delete `DECODER` (names) and `ENCODER`.
8. **RED — the narrowing.** Add the `EF BB BF .gitmodules` case asserting **no**
   `gitmodulesSymlink`. It fails before step 7 (the decoder eats the BOM and it *is*
   flagged) — that is the point.
9. **RED — the recovery fixtures.** Re-base `fsck.test.ts:6731` onto a non-octal mode.
   Failure: the tree now decodes fine, so the cache entry is not `null` and the findings
   array differs.
10. **GREEN + REFACTOR.** Land the fixture change, add the two-pass agreement test and
    the `never throws` property, and re-read `validate-tree.ts`'s remaining comments for
    stale claims.

### Gate

```
npx vitest run \
  test/unit/domain/fsck/validate-object.test.ts \
  test/unit/domain/objects/tree-entry-bytes.test.ts \
  test/unit/application/commands/fsck.test.ts \
  test/unit/application/commands/fsck.properties.test.ts \
  test/unit/application/commands/internal/fsck/content-validation.test.ts \
  && npx vitest run test/unit \
  && npm run check:types \
  && npm run check:doc-links \
  && ./node_modules/.bin/biome check src/domain/fsck src/domain/objects/tree-entry-bytes.ts test/unit/domain/fsck test/unit/application/commands
```

### Commit

```
fix(fsck): classify tree entry names on raw bytes and adopt git's parse tier
```

---

## Part 6 — Pin the whole parity matrix in one interop suite

### Context

**This part has no `src/` delta** — it is the test-infra/harness exception the sizing
rules allow. One new file, per ADR-756:
`test/integration/tree-entry-bytes-interop.test.ts`.

**Header** (`audit-test-pyramid`'s `integrationProof` buckets and
`audit-write-surfaces`'s `interopSurface` key both read this):

```
@proves
  surface:        tree
  bucket:         cross-tool-interop
  unique:         exotic entry-name bytes and mode tiers match canonical git across every tsgit read path
  interopSurface: tree
```

`tooling/audit-write-surfaces.ts` treats surface coverage as a **list**, so claiming
`tree` alongside `test/integration/tree-interop.test.ts` aggregates rather than
conflicts. `bucket: cross-tool-interop` must live at the `test/integration/` **root**
(directory rule), which it does.

**Harness.** Import `GIT_AVAILABLE`, `runGit`, `tryRunGitWithExit` from
`./interop-helpers.js` — `GIT_*` is already scrubbed there, `HOME`/`XDG_CONFIG_HOME` are
isolated and `GIT_CONFIG_NOSYSTEM=1` is set. `merge.conflictStyle` is irrelevant here and
is **not** pinned.

**Two mechanics copied, deliberately, from
`test/integration/tree-diff-corrupt-interop.test.ts`** (ADR-756 rules copying over
sharing, so that suite's declared `diff` surface stays what it says):

```ts
function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array   // its L58-66
function rawEntry(mode: string, name: string, oidHex: string): Uint8Array // its L72-74
function buildLiteralTree(body: Uint8Array): string                     // its L84-86
```

`rawEntry` takes a `string` name; this suite needs **raw bytes**, so add a
`rawEntryBytes(mode: string, nameBytes: Uint8Array, oidHex: string)` built from
`concatBytes(encode(`${mode} `), nameBytes, Uint8Array.of(0), hexToBytes(oidHex))`. Never
put an exotic name in a source-code string literal — build it from byte arrays, and keep
`cspell` and `secretlint` out of it.

`buildLiteralTree` uses `git hash-object -t tree -w --stdin --literally`, which is what
lets fixtures git's own write-side fsck refuses exist as real loose objects at all. Rows
that must be **accepted** by write-side fsck (2–7, 21, 23, 25, 27) should be written
*without* `--literally` so the acceptance itself is a measured assertion.

**Two structural rules copied from the same file's header, both load-bearing:**

- One shared `beforeAll` builds the base repo with a **60 s timeout**
  (`const SETUP_TIMEOUT = 60_000`) — the 10 s default flakes under full-`validate`
  concurrency.
- **Each case builds a fresh `Context` after its own git-external writes**
  (`createNodeContext({ workDir: dir })`). tsgit's loose-object read path caches a fanout
  directory's membership per `Context` and only self-invalidates on tsgit's own
  `writeObject`; objects here land via a real `git` subprocess, so a shared `Context`
  would serve a stale membership set.

**Fixtures** (§1a): two blobs, `one\n` → `5626abf0f72e58d7a153368ba57db4c673c0e171` and
`two\n` → `f719efd430d52bcfc8566a43b2eb655688d38871`.

**ADR-249 governs every comparison.** The library emits no display string. Reconstruct
git's line from tsgit's structured fields *inside the test* and compare that to real git
output — `<mode> <type> <oid>\t<name>` for `ls-tree`, `error in tree <oid>: <msgId>:
<text>` for fsck. Never assert on a rendered string the library produced.

**Every expected value is already measured in the design's §1b — no part needs to
re-probe git.** The eleven cases:

1. **Parse-tier co-refusal** — rows 13, 19, 20. `git ls-tree` exits **128** with
   `fatal: empty filename in tree entry` / `fatal: malformed mode in tree entry`; tsgit
   refuses with `INVALID_TREE_ENTRY` and the matching reason on **all three** parse sites
   (`readTree`, `flattenTree`, `revParse('<tree>:<name>')`). Assert the error `.data`
   **and** git's exit code — a co-refusal case with only one side asserted is a vacuous
   pass.
2. **Byte-class acceptance** — rows 2–7. `git ls-tree -z` (raw bytes, no octal quoting)
   and tsgit agree on the entry set. Row 4 through `readTree` must yield **two**
   `Tree.entries` — the assertion that kills a key-collapse mutant.
3. **Round-trip bytes** — rows 2, 3, 4, 7: read the tree with tsgit, re-serialize with
   `serializeTreeContent`, compare to the on-disk object body **byte for byte**. This is
   ADR-749's only direct oracle.
4. **Name-shape parity, on both layers.**
   - *Read layer, now parity:* `.`, `..` and `a/b` are accepted by `git ls-tree`,
     `git rev-parse <tree>:<name>` and by tsgit's `readTree` / `flattenTree` / `revParse`.
     Three former divergences become three parity rows.
   - *Materialisation layer, co-refusal:* `git read-tree` exits **128** with
     `error: invalid path '.'` / `'..'`; tsgit's `buildIndexFromTree` throws
     `INVALID_INDEX_ENTRY`. Include the **nested** fixture (`40000 sub` → a tree whose
     sole entry is `.`) so the full-path form `sub/.` is pinned on both sides.
   - *And `a/b` is accepted at the materialisation layer too:* `git read-tree` exits 0
     with an index entry at `a/b`; tsgit's flattened path is the two-segment `a/b` and
     `verifyPath` does not refuse it. **This row is the one that proves the separator
     refusal is gone rather than merely relocated.**
5. **Duplicate behaviour, per surface** — rows 14–15, three parity assertions:
   `git ls-tree` lists both / tsgit's `readTree` returns two entries;
   `git rev-parse <tree>:a` resolves the **first** (`5626abf0…`) / tsgit's descent
   (`revParse`, `readFileAt`) returns the **first**; `git read-tree` + `ls-files -s` keeps
   the **last** (`f719efd4…`) / tsgit's `flattenTree` keeps the **last**. `git fsck`
   reports `duplicateEntries` and tsgit's fsck reports the same msg-id at the same
   severity.
6. **fsck parity** — rows 13, 18–28. Reconstruct git's `error in tree <oid>: <msgId>:
   <text>` from tsgit's structured `FsckFinding` fields and compare, plus the exact exit
   code, with and without `--strict`. Rows 21–24 pin the 4096/4097 boundary in **both**
   encodings; rows 25–28 pin `treeNotSorted` present in two orders and **absent** in the
   other two. Row 18 pins that `badFilemode` stays exit 0 even under `--strict`. The
   `hasDot` / `hasDotdot` / `fullPathname` rows live here: fsck is now the *only* place
   those findings exist.
7. **The fsck two-pass agreement (§1d)** — one BOM-name tree, one `fsck` run: git reports
   nothing and exits 0, and tsgit reports **no finding at all**, neither from the content
   pass nor as an unreadable object from the cache pass.
8. **The `FilePath` limit (ADR-757)** — row 4 through `flattenTree`: git's index carries
   **two** entries (`git ls-files -s -z`), tsgit's `FlatTree` carries **one**. Asserted as
   a divergence at the `FlatTree` level, **never** by comparing worktree contents —
   `checkout-index` itself fails on those names on APFS (`Illegal byte sequence`), so a
   worktree comparison would pass for the wrong reason on macOS and fail on Linux.
9. **The check-order row (ADR-754's rider)** — one fixture faulty twice over: a non-octal
   mode **and** a name of `.`. Both git and tsgit must report the **mode** fault. A mutant
   restoring the old check order is invisible to every test that triggers one fault at a
   time; this is its only killer.
10. **Descent over an embedded separator (ADR-759)** — `git rev-parse <tree>:a/b` against
    an entry literally named `a/b` resolves (measured: exit 0, `5626abf0…`), and tsgit's
    descent now resolves it too: a **parity** row, not a divergence. Plus `<tree>:.` and
    `<tree>:..` against those entries — both parity.
11. **SHA-256** — at least one acceptance row and one parse-tier refusal row re-run on
    `git init --object-format=sha256`, so hash-width independence stays **measured**
    rather than inferred. Both the cursor and `parseTreeContent` take `digestLength` from
    `ctx.hashConfig`; nothing in the change is SHA-1-specific, and this is what proves it.

**Deliberately not asserted here** (the design's *Out of scope*, restate in the header so
the silence is not mistaken for ignorance): `git canon_mode`'s mode masking (row 18's
`777777` → `160000`, already pinned as a divergence in
`tree-diff-corrupt-interop.test.ts`); `badFilemode`'s severity **label**
(git prints `warning`, tsgit records `info` — the behaviour agrees); a directory mode
pointing at a non-tree (row 8, a *type* question); `checkout-index`'s APFS
`Illegal byte sequence`; and `git fsck`'s `broken links` / `dangling` reporting around a
malformed tree.

**Conventions the gate enforces**: GWT describe/it split, AAA body with `Arrange` and
`Assert` section comments, `sut` naming (and `sut` is the function under test, never the
result — `result` holds the result), at least one assertion per test, and no bare
`.toThrow(SomeClass)` — all of these are **gating** heuristics in
`test-pyramid-budgets.json`. The integration tier budget is target 15 %, warn above 25 %;
one added file will not move it, but `npm run check:test-pyramid` is part of `validate`.

### TDD steps

The RED signal for an interop suite is the **live `git` comparison**: each case is
written to compare tsgit against a freshly spawned `git`, so a case is red until both
sides are asserted and agree. Work the eleven cases in order; each is its own red→green.

1. **RED.** Scaffold the file with its `@proves` header, the
   `describe.skipIf(!GIT_AVAILABLE)('tree entry-name bytes interop', …)` guard (the exact
   form `tree-diff-corrupt-interop.test.ts:145` uses), the `beforeAll` base repo
   (60 s timeout), the copied `concatBytes` / `rawEntry`
   / `buildLiteralTree` / new `rawEntryBytes` helpers, and case 1's first row asserting
   **only git's** exit code and stderr. It fails until the fixture is built correctly —
   that is the fixture being validated against reality.
2. **GREEN.** Add the tsgit half of case 1 (all three parse sites, `.data` asserted).
3. Repeat 1–2 for cases 2 → 11, one case per red/green cycle. Whenever a case's tsgit
   half disagrees with the measured §1b value, **the implementation is wrong, not the
   table** — the table is git's behaviour, re-pinned 2026-08-30 against git 2.55.0. Raise
   a blocker rather than editing the expectation.
4. **REFACTOR.** Collapse rows that share an oracle shape into `it.each` **only** where
   the oracle is genuinely identical (per the repo's `it.each`-collapse rule: `label`, not
   `then`; keep the AAA markers; never collapse different oracle shapes). Keep case 4's
   two layers separate — they assert different things.

### Gate

```
npx vitest run test/integration/tree-entry-bytes-interop.test.ts \
  && npx vitest run test/integration/tree-interop.test.ts test/integration/tree-diff-corrupt-interop.test.ts \
  && npm run check:types \
  && npm run check:write-surfaces \
  && npm run check:test-pyramid \
  && npm run check:assert-tier \
  && ./node_modules/.bin/biome check test/integration/tree-entry-bytes-interop.test.ts
```

### Commit

```
test(tree): pin entry-name byte and mode-tier parity against canonical git
```
