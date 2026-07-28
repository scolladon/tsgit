# Plan — raw byte-cursor tree diff

> Source: design doc `docs/design/raw-tree-cursor-diff.md` · ADRs `518–524`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise.
- Parts run **sequentially in one working tree** and build on each other. Dependencies
  are stated per part; do not reorder.

## Repo-wide invariants every part must honour

Read these once; they apply to all seven parts.

- **Serena is ALREADY ACTIVATED** on this worktree. Do NOT call `activate_project`. Use
  `find_symbol` / `get_symbols_overview` / `replace_symbol_body` / `insert_after_symbol`
  as the default for TypeScript; `Read`/`Grep` only for markdown/JSON. Run
  `get_diagnostics_for_file` after each source edit. Diagnostics are advisory — ground
  truth is `npm run check:types`.
- **TDD, strictly.** RED test first (run it, see the stated failure), then minimal GREEN,
  then refactor. Never write production code before its failing test.
- **Test conventions.** `describe('Given …')` > `describe('When …')` > `it('Then …')`
  (2-level `describe('Given …, When …')` allowed when one expectation lives under the
  When). Body is AAA with `// Arrange` / `// Act` / `// Assert` section comments (no
  empty section — `emptyAaaSection` is a gating detector; a combined `// Arrange + Act`
  marker is accepted).
- **`sut` is the FUNCTION under test, never a result.** `const sut = openTreeCursor(buf, h)`
  inside an `it` **fails the `sutBindsResult` gate** (bare non-allowlisted call bound to
  `sut`). Write `const sut = openTreeCursor;` then `const cursor = sut(buf, hash);`.
  Results go in `result` / a domain-named variable.
- **No `toThrow(ErrorClass)`** — the `bareClassToThrow` detector gates on it. Assert error
  data via `try { … expect.unreachable(); } catch (error) { const { data } = error as { data: … }; expect(data.code).toBe(…); expect(data.reason).toBe(…); }`.
  Guard clauses get **isolated** tests (one fixture per condition).
- **No suppression directives** of any flavour (`@ts-ignore`, `v8 ignore`, `stryker-disable`,
  `biome-ignore`, `secretlint-disable`). No `any` — use `unknown` + narrowing.
- **No provenance refs in source or test code** — never write `ADR-518`, `Pin A`,
  `§P2`, `24.x`, `backlog` inside a `.ts` file. Comments explain *why*, never cite
  documents or phase numbers.
- **Biome `noExcessiveCognitiveComplexity` max = 15.** The cursor scanner and the raw
  merge-join must be decomposed into small named helpers, not one long function.
- **Coverage gate is 100 % statements/branches/functions/lines on `src/domain/**`**
  (`vitest.config.ts` → `coverage.include`). `src/application/**` is NOT coverage-gated
  but IS mutated by Stryker with a **99 break threshold for `src/domain/**`** and **95
  for `src/application/**`** (`mutation-budgets.json`) — every boundary/`-1` sentinel/
  `<` vs `<=` in the new code needs an explicit killing test, not a documented equivalence.
- **NO new domain-barrel exports.** `src/domain/index.ts` does `export * from './objects/index.js'`
  and `'./diff/index.js'`, and `src/domain/index.ts` is a **typedoc entry point**
  (`typedoc.json`) — adding a symbol to `src/domain/objects/index.ts` or
  `src/domain/diff/index.ts` makes `reports/api.json` stale and **fails the `check:doc-typedoc`
  prepush hook**. Every new symbol in this change is imported **by module path**
  (`../../domain/objects/tree-cursor.js`, `../../domain/diff/raw-tree-diff.js`). Same for
  `readRawObject`: exported from `read-object.ts`, **not** from
  `src/application/primitives/index.ts`, **not** bound on `repo.primitives`. Net effect:
  **zero surface gates trip** — no `api.json` regeneration, no `docs/use/` page, no
  browser scenario, no README count, no `repository.test.ts` key list change.
- **Every new export needs a production consumer** (`knip` runs as `check:dead-code`).
  Do not export a helper solely for a test.
- **kebab-case filenames** (`ls-lint`). New test files: `<module>.test.ts` and
  `<module>.properties.test.ts` siblings.
- **British spellings** already in the tree (`canonicalise`, `materialise`, `normalise`) —
  reuse the exact forms found nearby; the cspell dictionary lags on some `-ising/-ised`
  forms and `npm run check:spelling` is the authority.

## Empirically pinned git behaviour the parts must reproduce

From the design's probe against **git 2.55.0** (`mktemp -d`, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, all `GIT_*` scrubbed, signing off; malformed trees written with
`git hash-object -t tree -w --stdin --literally`).

**Pin A — structural refusals (`git diff-tree`/`ls-tree` both `fatal`, exit 128).** These
are the ONLY per-entry checks the raw walk performs:
empty name · truncated hash · trailing junk · no space after mode · non-octal mode digit ·
leading space (empty mode).

**Pin B — accepted by `git diff-tree`, caught only by `git fsck --strict`:**
unsorted entries (`b.txt` then `a.txt`) → vs a canonical tree, git emits `D a.txt` **then**
`A a.txt` (same oid both sides) · duplicate name · name `a/b` · name `.` · name `..`.
Git's merge-join **never re-sorts**; it streams both sides in on-disk order. tsgit today
emits *nothing* for the unsorted pair (`entriesOf` re-sorts) — already divergent, which is
why there is no "change nothing" option.

**Pin C — mode canonicalisation.** `40000` vs `040000` → empty diff; `100644` vs `0100644`
→ empty diff; `40000` vs `40644` → empty diff (git); `100644` vs `100664` → empty diff
(git); `100644` vs `100777` → `M` with `100755` (git).

**Pin D — the virtual trailing slash.** `git write-tree` over `d/f`, `d.txt`, `d-dash`, `d0`
orders them `d-dash` (0x2d) < `d.txt` (0x2e) < `d` (tree, sorts as `d/`, 0x2f) < `d0` (0x30).

## Plan-level corrections to the design (verified against the code — follow the plan)

1. **The five tree `fsck` checks already exist.** The design and ADR-518 state that tsgit's
   `fsck` implements none of `treeNotSorted`, `duplicateEntries`, `hasDot`, `hasDotdot`,
   `fullPathname`. **False:** all five are implemented in
   `src/domain/fsck/validate-tree.ts` (`checkNameFaults` → `hasDot`/`hasDotdot`/
   `fullPathname`; `checkEntryFaults` → `duplicateEntries` via `seenNames`, `treeNotSorted`
   via `treeEntrySortKey` + `compareBytes`) and unit-tested in
   `test/unit/domain/fsck/validate-object.test.ts`; `treeNotSorted` is already interop-pinned
   in `test/integration/fsck-interop.test.ts`. ADR-518's rider is therefore discharged as
   **Part 7 = pin the four unpinned checks against `git fsck --strict` + close the one real
   gap** (packed objects, below), not as new check implementations.
2. **`resolveRawInput` must preserve the commit/tag peel.** Today `resolveInput` sends an
   `ObjectId` through `readTree`, which **peels commit → tree and tag → tree** with a
   `MAX_PEEL_DEPTH` bound (`refChainTooDeep`). The design's sketch (`ObjectId → readRawTree`)
   would silently start refusing a commit oid, breaking requirement 1. Part 4 keeps the peel.
3. **`flattenTree`'s bounds need an injectable seam.** The design inlines
   `maxEntries: MAX_FLAT_TREE_ENTRIES` (1 000 000) into `flattenTree`; that throw branch is
   then unreachable from any test, leaving a guaranteed surviving mutant. Part 5 puts the
   descent in `src/application/primitives/internal/flatten-raw.ts` with an explicit bounds
   parameter (mirroring `walkTree`'s `WalkConfig`), and `flattenTree` delegates with the
   defaults — signature unchanged, bounds testable.
4. **`readRawTree` stays private to `diff-trees.ts`.** `flatten-raw.ts` must NOT import from
   `diff-trees.ts` (`diff-trees.ts` → `flatten-tree.ts` → `flatten-raw.ts` would be a
   runtime cycle, and `no-circular` is a dependency-cruiser error). Flatten implements its
   own strict-root / tolerant-descent reads directly on `readRawObject`, exactly mirroring
   today's `walk-tree.ts` (`resolveTree` throws; the descent silently skips a non-tree).
5. **Three of Pin C's five rows are a pre-existing tsgit divergence** and stay one:
   `normalizeFileMode` rejects `40644`, `100664`, `100777`, so the raw path throws
   `INVALID_FILE_MODE` at **emission** where git canonicalises. Part 6 pins that divergence
   explicitly (co-existing with the two rows that do match). Do NOT "fix" it — a faithful
   `canon_mode` fix must move `normalizeFileMode` itself and re-pin every write surface.

---

## Part 1 — `readRawObject`: expose the pre-parse product

**Depends on:** nothing. **Design section:** P1. **ADR:** 521 (internal-only).

### Context

**Goal:** split the object read so the raw `(type, content)` pair is reachable without
parsing, with a single shared header split so the two paths cannot drift. No behaviour
change to any existing caller.

**Files to change**

1. `src/domain/objects/git-object.ts` — current shape:
   ```ts
   export function parseObject(id: ObjectId, rawBytes: Uint8Array, hash: HashConfig): GitObject {
     const { type, size, contentOffset } = parseHeader(rawBytes);
     const content = rawBytes.subarray(contentOffset);
     if (content.length !== size) {
       throw invalidObjectHeader(`size mismatch: header says ${size}, actual content is ${content.length}`);
     }
     switch (type) { case 'blob': … case 'tree': return parseTreeContent(id, content, hash); … }
   }
   ```
   Extract, in the same file:
   ```ts
   export function splitObject(rawBytes: Uint8Array): { readonly type: ObjectType; readonly content: Uint8Array }
   ```
   carrying `parseHeader` + the size-mismatch `invalidObjectHeader` throw **verbatim**
   (same reason string — a StringLiteral mutant on it must stay killed by the existing
   `git-object.test.ts` case). `parseObject` then calls `splitObject` and switches on type.
   `ObjectType` is already exported from `./header.js`. Do **not** add `splitObject` to
   `src/domain/objects/index.ts`.

2. `src/application/primitives/object-resolver.ts` — current entry point:
   ```ts
   export async function resolveObject(ctx: Context, registry: PackRegistry, id: ObjectId,
     verifyHash: boolean, maxBytes?: number): Promise<GitObject>
   ```
   Its body (lines ~56–81) does: `checkAborted` → empty-tree special case
   (`return parseObject(id, EMPTY_TREE_BYTES, ctx.hashConfig)`) → `ctx.deltaCache.get(id)`
   + `enforceCachedCap` → `tryLoose` + `enforceLooseCap` → `registry.lookup` (miss →
   `objectNotFound`) → `resolvePackChain`, each step separated by `checkAborted`. The private
   `finalize(ctx, id, bytes, verifyHash)` does the `hashHex` verify (+ `checkAborted`) and
   then `parseObject`.

   Split into:
   ```ts
   export async function resolveObjectBytes(ctx: Context, registry: PackRegistry, id: ObjectId,
     verifyHash: boolean, maxBytes?: number): Promise<Uint8Array>   // today's body, minus the parse
   export async function resolveObject(…same signature…): Promise<GitObject> {
     return parseObject(id, await resolveObjectBytes(ctx, registry, id, verifyHash, maxBytes), ctx.hashConfig);
   }
   ```
   - The empty-tree branch returns `EMPTY_TREE_BYTES` (the module constant, `tree 0\0`).
   - `finalize` loses its `parseObject` tail and returns the verified `Uint8Array`; every
     `checkAborted`, every cap call, and the loose-before-pack order stay **exactly** where
     they are (moving one is a behaviour change).
   - `resolveBaseForRefDelta` (line ~423) calls `resolveObject(…)` then `serializeObject` to
     get bytes back. Leave it as-is — do not opportunistically re-point it at
     `resolveObjectBytes`; the round-trip is what re-canonicalises a pack base and changing
     it is out of scope.

3. `src/application/primitives/types.ts` — add next to `ReadObjectOptions` (line 66):
   ```ts
   export interface RawObject { readonly type: ObjectType; readonly content: Uint8Array }
   ```
   `ObjectType` comes from `../../domain/objects/index.js` (already imported there for other
   shapes — check and extend the existing import, do not add a second one).

4. `src/application/primitives/read-object.ts` — current `readObject` (line 93) wraps
   `resolveObject` in a promisor lazy-fetch retry: catch → `ctx.promisor === undefined ||
   !isObjectNotFound(err)` rethrow → `lazyFetchOnce` → `if (!attempted) throw err` →
   `registry.refresh()` → one retry. Extract that control flow **once** so both reads behave
   identically on a partial clone:
   ```ts
   async function withLazyFetchRetry<T>(ctx: Context, id: ObjectId, registry: PackRegistry,
     run: () => Promise<T>): Promise<T>
   export async function readObject(ctx, id, options?): Promise<GitObject>
   export async function readRawObject(ctx: Context, id: ObjectId, options?: ReadObjectOptions): Promise<RawObject>
   ```
   `readRawObject` resolves `verifyHash = options?.verifyHash ?? true` the same way, calls
   `resolveObjectBytes`, and returns `splitObject(bytes)`. `ReadObjectOptions` is reused
   unchanged so a future caller cannot get a weaker `maxBytes` cap by picking the raw read.

**Tests to extend (do not create new files)**

- `test/unit/domain/objects/git-object.test.ts` (278 lines) — add a `describe('Given a
  loose-format buffer …')` block for `splitObject`: returns `{ type, content }` for each of
  the four types; throws `INVALID_OBJECT_HEADER` with the exact size-mismatch reason (assert
  `data.reason` via try/catch); the same buffer through `parseObject` throws the identical
  reason (proves the shared split).
- `test/unit/application/primitives/read-object.test.ts` (664 lines) — top-level
  `describe('readObject', …)` at line 12 and `describe('readObject — lazy-fetch (partial
  clone)', …)` at line 375. Add a sibling `describe('readRawObject', …)`. Context helpers:
  `buildSeededContext` from `./fixtures.js`; blobs/trees are written with `writeObject` /
  `writeTree`; the lazy-fetch suite builds `ctx = { ...base, promisor }` with a
  `supplyingPromisor` local helper (line ~382) — reuse it verbatim for the raw retry case.
- `test/unit/application/primitives/object-resolver.test.ts` (1822 lines, single top-level
  `describe('object-resolver', …)` at line 115) — add `resolveObjectBytes` cases only if a
  branch is otherwise unreached; prefer covering through `readRawObject`.

**Pinned behaviour this part must reproduce**

- `readRawObject` on the virtual empty-tree oid (SHA-1 `4b825dc6…`, SHA-256 `6ef19b41…`)
  yields `{ type: 'tree', content }` with `content.length === 0`.
- For loose, packed, delta-chain and `deltaCache`-hit sources, `readRawObject(ctx, id).content`
  is byte-identical to what `readObject` parsed from.
- `maxBytes` and `verifyHash` fire identically on both reads (`OBJECT_TOO_LARGE` with
  `actualSize`/`limit`; `OBJECT_HASH_MISMATCH` with `expected`/`actual`).
- A partial-clone miss lazy-fetches **once** and retries **once** on both reads; a promisor
  reporting `attempted: false` rethrows the original `OBJECT_NOT_FOUND` without a re-resolve.

### TDD steps

1. **RED** — `git-object.test.ts`: `splitObject` returns `{ type: 'blob', content }` for
   `blob 5\0hello`. Fails: `splitObject is not exported` (TS2305 / runtime undefined).
2. **GREEN** — extract `splitObject` in `git-object.ts`; re-point `parseObject` at it.
3. **RED** — `splitObject` on `blob 9\0hello` throws `INVALID_OBJECT_HEADER` with
   `reason === 'size mismatch: header says 9, actual content is 5'`; the same buffer through
   `parseObject` throws the identical reason. Fails only if the extraction dropped the check.
4. **RED** — `read-object.test.ts`: `readRawObject(ctx, blobId)` returns
   `{ type: 'blob', content: <bytes> }`. Fails: `readRawObject is not a function`.
5. **GREEN** — add `RawObject` to `types.ts`; split `resolveObjectBytes` out of
   `resolveObject`; add `readRawObject` + the shared `withLazyFetchRetry` wrapper.
6. **RED→GREEN** — one isolated test each: empty-tree virtual object; packed object;
   delta-chain object; second read served from `ctx.deltaCache`; `maxBytes` exceeded
   (`data.code === 'OBJECT_TOO_LARGE'`, assert `actualSize` + `limit`); `verifyHash: true`
   on a corrupted loose file (`OBJECT_HASH_MISMATCH`, assert `expected`/`actual`);
   `verifyHash: false` on the same file succeeds; promisor supplies the object (assert the
   fetch was called exactly once, then the raw content); promisor `attempted: false`
   rethrows `OBJECT_NOT_FOUND`.
7. **REFACTOR** — confirm `readObject`'s own suite is untouched and still green (proves the
   retry extraction is behaviour-preserving). Remove any now-unused import.

### Gate

```
npx vitest run test/unit/domain/objects/git-object.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/object-resolver.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/objects/git-object.ts src/application/primitives/object-resolver.ts src/application/primitives/read-object.ts src/application/primitives/types.ts test/unit/domain/objects/git-object.test.ts test/unit/application/primitives/read-object.test.ts
```
`src/domain/objects/git-object.ts` is coverage-gated at 100 %, so also run
`npx vitest run test/unit/domain/objects/` before committing; the full
`npx vitest run --project unit --coverage` is deferred to the phase gate.

### Commit

`perf: expose pre-parse object bytes through readRawObject`

---

## Part 2 — the raw tree cursor

**Depends on:** Part 1 (nothing structural — sequencing only). **Design section:** P2.
**ADRs:** 519 (mode equality), 520 (module home), 524 (property proof).

### Context

**Goal:** a mutable, zero-allocation-per-entry scanner over raw tree bytes, plus a
byte-level mode matcher. Pure domain: **zero** outward imports, no `Context`.

**New file:** `src/domain/objects/tree-cursor.ts` (ADR-520 — it is a parser over the tree
grammar, which `domain/objects` owns, and both `domain/diff/raw-tree-diff.ts` and the
application-tier flatten consume it; a `domain/diff/` home would make flatten depend on the
diff module).

```ts
export interface TreeCursor {
  readonly buf: Uint8Array;
  readonly digestLength: number;   // from HashConfig — 20 or 32, never a literal
  offset: number;                  // start of the current entry
  modeStart: number; modeEnd: number;   // [start, end) — end is the space
  nameStart: number; nameEnd: number;   // [start, end) — end is the NUL
  oidStart: number;                     // oid occupies [oidStart, oidStart + digestLength)
  isDir: boolean;
  done: boolean;
}
export function openTreeCursor(buf: Uint8Array, hash: HashConfig): TreeCursor
export function advanceCursor(c: TreeCursor): void
export function compareCursorNames(a: TreeCursor, b: TreeCursor): number
export function cursorsSame(a: TreeCursor, b: TreeCursor): boolean
export function cursorName(c: TreeCursor): string
export function cursorOid(c: TreeCursor): ObjectId
export function cursorMode(c: TreeCursor): FileMode
```

**The `done` contract — get this exactly right or every loop is off by one.** `done === true`
means *there is no current entry*; while `done === false` the struct's `mode*`/`name*`/
`oidStart`/`isDir` fields describe a **valid current entry**. Therefore:

```ts
function scanEntryAt(c: TreeCursor, start: number): void   // sets c.offset = start, then runs the Pin A checks below
export function openTreeCursor(buf, hash) {
  // zero-length buf (the empty tree, virtual or stored) → { …, done: true }
  // otherwise → done: false, then scanEntryAt(cursor, 0)
}
export function advanceCursor(c: TreeCursor): void {
  const next = c.oidStart + c.digestLength;   // step past the entry just consumed
  if (next >= c.buf.length) { c.done = true; return; }
  scanEntryAt(c, next);
}
```
A freshly opened non-empty cursor is positioned on entry 0. `advanceCursor` is called at the
**end** of a loop body, so `while (!c.done) { …use fields…; advanceCursor(c); }` visits every
entry including the last. Do **not** set `done` inside `scanEntryAt` — that would make the
last entry invisible. `openTreeCursor(buf, hash)` mirrors `parseTreeContent`'s arg shape; a
zero-length buffer yields the same shape `parseTreeContent` produces today
(`{ entries: [] }`), so the merge-join treats it exactly like an absent side.

**Mutability is deliberate and scoped.** The house rule is immutable-by-default; this struct
is the documented exception, precedented in-tree by `walk-tree.ts`'s
`interface Counter { value: number }` and the commit priority-queue heap. It never escapes
its consumers; every value that *does* escape (`DiffChange`, `FlatTreeEntry`) is a fresh
immutable object literal. Write the *why* in a file-header comment (no document refs).

**Scanning one entry (`scanEntryAt(c, start)`) — Pin A checks, in this order.** `indexOf` and
`decode` come from `./encoding.js`; `invalidTreeEntry(offset, reason)` from `./error.js`
(`{ code: 'INVALID_TREE_ENTRY', offset, reason }`). Set `c.offset = start` and
`c.modeStart = start` first, so every error offset below is the **entry's start offset** —
the same value `parseTreeContent` reports today.

1. `modeEnd = indexOf(buf, 0x20, start)`; `-1` → `invalidTreeEntry(start, 'missing space after mode')`.
2. `modeEnd === start` (empty mode) **or** any byte in `[start, modeEnd)` outside
   `0x30..0x37` → `invalidTreeEntry(start, 'malformed mode')`.
3. `nameEnd = indexOf(buf, 0x00, modeEnd + 1)`; `-1` → `invalidTreeEntry(start, 'missing null after name')`.
4. `nameEnd === modeEnd + 1` (empty name) → `invalidTreeEntry(start, 'empty filename')`.
5. `oidStart = nameEnd + 1`; `oidStart + digestLength > buf.length` →
   `invalidTreeEntry(start, 'truncated hash')`.
6. `isDir` — git's `S_ISDIR` with **no mode decode**, read off the right-hand end of the
   mode field. With `L = modeEnd - modeStart` (`modeStart === start`):
   ```
   isDir ⟺ L >= 5
        && buf[modeEnd - 5] === 0x34                        // octal digit at 8^4 is exactly 4
        && (L === 5 || (buf[modeEnd - 6] - 0x30) % 2 === 0) // octal digit at 8^5 is even
   ```
   `S_ISDIR(mode)` is `(mode & 0o170000) === 0o40000`; the mask covers exactly the `8^4`
   digit (masked with 7 ⇒ must equal 4) and the `8^5` digit (masked with 1 ⇒ must be even);
   every higher digit is masked away, which is why arbitrarily long modes need no special
   case. Verify by hand: `40000`→dir, `040000`→dir, `40644`→dir, `1040000`→dir;
   `100644`/`100755`/`120000`/`160000`/`0100644`→not dir; `140000`→**not** dir
   (`0o140000 & 0o170000 === 0o140000`).

**Why the check ORDER is load-bearing (and provably safe):** step 1's `indexOf` scans the
whole buffer, so a name with no space (`100644a.txt\0<oid>`) can find a stray `0x20` inside
the oid or a later entry. Step 2 then rejects it, because any `modeEnd` past a NUL implies a
`0x00` byte inside `[start, modeEnd)` and `0x00 ∉ [0x30, 0x37]`. `parseTreeContent` has the
same `indexOf` semantics today, so this is not a behaviour change. Encode that reasoning as
a comment.

**Decompose to satisfy `noExcessiveCognitiveComplexity` (max 15):** private
`scanMode(c, start)`, `scanName(c)`, `scanOid(c)`, `computeIsDir(buf, modeStart, modeEnd)`
helpers, with `scanEntryAt` as the four-call sequence and `advanceCursor` as the two-line
step-and-dispatch above.

**`compareCursorNames(a, b)`** — `compareBytes` over the *virtual* names
`name + (isDir ? '/' : '')`, read straight off both buffers with **no key array**:
```
la = a.nameEnd - a.nameStart ; ea = la + (a.isDir ? 1 : 0)
byteAt(c, i, len) = i < len ? c.buf[c.nameStart + i] : 0x2f      // i === len ⇒ virtual '/'
for i in 0 .. min(ea, eb) - 1: if the bytes differ, return the difference
return ea - eb
```
This *is* `compareBytes` over the same virtual sequences (see `treeEntryCompare` +
`encodeEntryName` in `src/domain/objects/tree.ts` lines 113–126), only never materialised.

**`cursorsSame(a, b)`** — TREESAME test, no allocation:
- **oid first** (loop-exit-first: a changed file almost always changes its oid): compare
  `digestLength` bytes from `oidStart` on each side.
- **mode second**: leading-`0x30`-stripped byte-range equality (ADR-519). Advance each side's
  start index past every leading `0x30`, then compare the **stripped lengths first** and only
  then the bytes — comparing just the overlap would call `40000` and `140000` equal. Provably
  identical to `normalizeFileMode(a) === normalizeFileMode(b)` on every mode tsgit accepts,
  because `040000` is the only zero-prefixed valid form. Exact byte equality is **rejected**
  — it would report `040000` vs `40000` as a spurious modify git never emits.

**Emit helpers — the only place strings appear:**
- `cursorName(c)` → `decode(buf.subarray(nameStart, nameEnd))`.
- `cursorOid(c)` → `ObjectId.fromRaw(buf.subarray(oidStart, oidStart + digestLength))`
  (`src/domain/objects/object-id.ts` — the trusted, regex-free path; it throws
  `INVALID_OBJECT_ID` for a length that is neither 20 nor 32, unreachable here).
- `cursorMode(c)` → the new byte matcher in `file-mode.ts` (below).

**File to change:** `src/domain/objects/file-mode.ts` (46 lines; `FILE_MODE` =
`{REGULAR:'100644', EXECUTABLE:'100755', SYMLINK:'120000', DIRECTORY:'40000', GITLINK:'160000'}`;
`normalizeFileMode` maps only `'040000' → '40000'` and rejects everything else via
`validateFileMode` → `invalidFileMode(mode)`). Add:
```ts
export function matchFileModeBytes(buf: Uint8Array, start: number, end: number): FileMode
```
A length + byte switch over the five `FILE_MODE` values **plus `040000`**, returning the
interned constant with zero allocation. An unrecognised mode decodes **only on the error
path** and throws `invalidFileMode(modeStr)` — the same error, from the same input set, as
`normalizeFileMode` today. Keep it under the complexity cap (e.g. dispatch on
`end - start`, then compare bytes).

**Tests**

- **New:** `test/unit/domain/objects/tree-cursor.test.ts`.
- **New:** `test/unit/domain/objects/tree-cursor.properties.test.ts`.
- **Extend:** `test/unit/domain/objects/file-mode.test.ts` (5.0K) — add
  `matchFileModeBytes` cases.
- **Extend:** `test/unit/domain/objects/arbitraries.ts` (currently exports `arbObjectId`,
  `arbObjectType`, `arbFileModeEnum`, `arbAuthorIdentity`, `arbTagName`, `arbArmorBlock`,
  `arbCommitMessage`, `arbNonBlankLine`). Add, as the single home for the tree family
  (ADR-134):
  ```ts
  export function arbTreeEntryAnyMode(): fc.Arbitrary<TreeEntry>   // all five modes incl. DIRECTORY
  export function dedupeTreeEntriesByName(entries: ReadonlyArray<TreeEntry>): ReadonlyArray<TreeEntry>
  ```
  Copy the name filter **verbatim** from `test/unit/domain/objects/tree.properties.test.ts`
  lines 18–44 (`fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('\0')
  && !s.includes('/') && s !== '.' && s !== '..')` and the first-wins `dedupeByName`), then
  **re-point `tree.properties.test.ts` at the shared exports and delete its two locals** so
  there is one home. That file uses `arbTreeEntry` as a *value* (`fc.array(arbTreeEntry)`);
  the shared version is a **function**, so the call sites become
  `fc.array(arbTreeEntryAnyMode())`. Its five properties must stay green unchanged.

**Unit cases (each isolated — the guard-isolation rule)**

- One test per Pin A refusal, asserting `data.code === 'INVALID_TREE_ENTRY'` **and**
  `data.offset` **and** `data.reason` via try/catch: missing space · **empty mode**
  (leading space: `' 100644 a.txt\0<20>'`) · **non-octal mode byte** (`'100648 a.txt\0<20>'`)
  · missing NUL · empty name (`'100644 \0<20>'`) · truncated hash (10 oid bytes) · trailing
  junk (`'100644 a.txt\0<20>xx'` → second iteration, `'missing space after mode'`).
  Empty-mode and non-octal-mode get **separate fixtures** — one input triggering both proves
  neither operand alone.
- `isDir` table exercising all three operands: dir — `40000` (the `L === 5` branch),
  `040000`, `40644`, `1040000` (`L > 6`, even `8^5` digit); not dir — `100644`, `100755`,
  `120000`, `160000`, `0100644` (wrong `8^4` digit), **`140000`** (right `8^4` digit, **odd**
  `8^5` digit — the case that kills a mutant dropping the parity term).
- `compareCursorNames` reproduces Pin D: `d-dash` < `d.txt` < `d` (tree) < `d0`. Add
  shared-prefix pairs (`d` tree vs `d` blob; `ab` vs `abc`) and one equal pair (returns 0).
- `cursorsSame`: isolated oid-differs · mode-differs · `40000` vs `040000` (same) ·
  equal-both (same).
- `openTreeCursor` on a zero-length buffer → `done === true`.
- Both `SHA1_CONFIG` and `SHA256_CONFIG` (`src/domain/objects/hash-config.ts`) — a 32-byte
  fixture proves the width comes from `digestLength`.
- `matchFileModeBytes` returns the interned constant (`toBe`, identity) for all six accepted
  forms and throws `INVALID_FILE_MODE` with `data.value === '100664'` for an unknown mode.

**Property cases** (`tree-cursor.properties.test.ts`, ADR-524/134–136; no seed committed)

- (lens 1, `numRuns: 200`) walking the cursor over `serializeTreeContent(tree, SHA1_CONFIG)`
  yields the same `(mode, name, oid)` sequence as `parseTreeContent(id, content, SHA1_CONFIG)`
  — oracles are existing, independently-tested production code, not a re-implementation.
- (lens 1/3, `numRuns: 200`) `Math.sign(compareCursorNames(a, b)) === Math.sign(treeEntryCompare(a, b))`
  for arbitrary single-entry trees, including shared prefixes and directory/file collisions.
- (lens 3, `numRuns: 100`) totality over the safe subset: a cursor over any
  `serializeTreeContent` output never throws.

### TDD steps

1. **RED** — `tree-cursor.test.ts`: `openTreeCursor` over `100644 a.txt\0<20 bytes>` then
   `cursorName` returns `'a.txt'`. Fails: module `tree-cursor.ts` does not exist.
2. **GREEN** — create `tree-cursor.ts` with the struct, `openTreeCursor`, `advanceCursor`
   (steps 1–7) and `cursorName`; minimal but complete scan.
3. **RED→GREEN** ×7 — the Pin A refusal cases, one at a time; each must fail with the wrong
   code/reason before the corresponding guard exists.
4. **RED→GREEN** — the `isDir` table (12 rows, `it.each`-style rows carrying a `label`
   field — **not** `then`, which trips biome `noThenProperty`).
5. **RED** — `file-mode.test.ts`: `matchFileModeBytes(encode('040000'), 0, 6)` returns
   `FILE_MODE.DIRECTORY` by identity. Fails: not exported. **GREEN** — add the matcher.
6. **RED→GREEN** — `cursorOid` / `cursorMode`; then `compareCursorNames` (Pin D +
   prefixes); then `cursorsSame` (four isolated cases).
7. **RED→GREEN** — SHA-256 fixture; zero-length buffer.
8. **RED→GREEN** — the three properties; extend `arbitraries.ts` and re-point
   `tree.properties.test.ts`.
9. **REFACTOR** — split `advanceCursor` into `scanMode`/`scanName`/`scanOid`/`computeIsDir`
   until biome is clean; confirm 100 % coverage on both new/changed domain files.

### Gate

```
npx vitest run test/unit/domain/objects/tree-cursor.test.ts test/unit/domain/objects/tree-cursor.properties.test.ts test/unit/domain/objects/file-mode.test.ts test/unit/domain/objects/file-mode.properties.test.ts test/unit/domain/objects/tree.properties.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/objects/tree-cursor.ts src/domain/objects/file-mode.ts test/unit/domain/objects/tree-cursor.test.ts test/unit/domain/objects/tree-cursor.properties.test.ts test/unit/domain/objects/file-mode.test.ts test/unit/domain/objects/arbitraries.ts test/unit/domain/objects/tree.properties.test.ts
```
Then, because domain coverage is gated at 100 % and this part is domain-only:
`npx vitest run --project unit --coverage` and confirm `src/domain/objects/tree-cursor.ts`
and `file-mode.ts` are at 100/100/100/100.

### Commit

`perf: add a raw byte cursor over tree object entries`

---

## Part 3 — the raw merge-join

**Depends on:** Part 2. **Design section:** P3. **ADRs:** 518 (validation surface), 524.

### Context

**Goal:** a merge-join over two cursors that emits the *same* `DiffChange` variants, in the
*same* order, as `src/domain/diff/tree-diff.ts` — with **only** Pin A structural checks.

**New file:** `src/domain/diff/raw-tree-diff.ts`
```ts
export function diffRawTrees(
  oldContent: Uint8Array | undefined,
  newContent: Uint8Array | undefined,
  hash: HashConfig,
): TreeDiff
```

**The shape to mirror** — `src/domain/diff/tree-diff.ts` (112 lines):
`entriesOf` decorates + **sorts**; the loop compares `compareBytes(oldEntry.key, newEntry.key)`:
`cmp < 0` → `deleteFrom` + `i++`; `cmp > 0` → `addFrom` + `j++`; equal →
`classifySamePath` (`undefined` when `id` and `mode` both match; `type-change` when
`!isSameKind(oldMode, newMode)`; else `modify`) + `i++; j++`; then two tail loops drain the
remainders. `DiffChange` field names are exact and must not change:
`add → { type, newPath, newId, newMode }`, `delete → { type, oldPath, oldId, oldMode }`,
`modify`/`type-change` → `{ type, path, oldId, newId, oldMode, newMode }`. Paths are
`entry.name as FilePath` (single segment — the recursion prefix is applied by the caller).

**The raw version:** two cursors in place of `KeyedEntry[]`; `compareCursorNames(a, b)` in
place of `compareBytes(key, key)`; `cursorsSame(a, b)` in place of `id === && mode ===`;
`advanceCursor` in place of `i++`/`j++`; **no sort, no `Set<string>`, no name validation, no
order check** (ADR-518 Option 1 — the raw walk enforces exactly git's `decode_tree_entry`
structural refusals and nothing else). Reuse `isSameKind` from `./mode-kind.js`. Both modes
are materialised via `cursorMode` only when an entry is actually emitted; a differing entry
is emitted anyway, so nothing is wasted — and a mode outside the five-value set is refused
only at **emission**, which makes mode refusal entry-dependent (accepted, documented).

**Loop shape**, driven by `done` rather than indices (`advanceCursor` is called at the end of
each body — see Part 2's `done` contract):
```ts
while (!a.done && !b.done) { …compare, emit, advance one or both… }
while (!a.done) { emit delete; advanceCursor(a); }
while (!b.done) { emit add;    advanceCursor(b); }
```
Because both tails drain fully, **every entry of both trees is advanced over on every diff**
— the Pin A structural checks are therefore exhaustive, never entry-dependent.

`undefined` content (an absent side) opens as a `done: true` cursor via a zero-length buffer,
so the absent-side path needs no branch of its own: declare a module-level
`const EMPTY_CONTENT = new Uint8Array(0);` and open with `oldContent ?? EMPTY_CONTENT`.

**Do NOT modify `src/domain/diff/tree-diff.ts`.** It still serves the non-recursive
`diffTrees`, `merge`, `stash` and `range-diff`'s per-level classification. Its tests —
including `test/unit/domain/diff/tree-diff.test.ts` "entriesOf re-sorts, never trusts input
array order" and "each entry name is encoded exactly once" — remain valid guards for that
path and must stay green untouched.

**Duplication watch:** `jscpd` runs `jscpd src/` with `minLines: 5`, `minTokens: 50`,
`threshold: 5`. The cursor-shaped emit helpers differ enough in token sequence to be safe;
if `check:duplicates` does flag the pair, extract a shared
`buildSamePathChange(path, oldId, newId, oldMode, newMode): DiffChange` into
`src/domain/diff/diff-change.ts` and call it from **both** files — that is the only
sanctioned edit to `tree-diff.ts` in this part.

**Tests**

- **New:** `test/unit/domain/diff/raw-tree-diff.test.ts`.
- **New:** `test/unit/domain/diff/raw-tree-diff.properties.test.ts`.
- **Extend:** `test/unit/domain/diff/arbitraries.ts` (currently `arbBlobBytes`,
  `arbNonDirMode`, `arbEntryName`, `arbTreeEntry`, `arbTree` — note `arbTree` deliberately
  excludes DIRECTORY modes). Add `arbCanonicalTree()` that **includes** `FILE_MODE.DIRECTORY`
  (so the virtual-slash ordering is exercised) and dedupes by name; reuse
  `dedupeTreeEntriesByName` from `../objects/arbitraries.js` (added in Part 2).

Build tree bytes with `serializeTreeContent(tree, SHA1_CONFIG)` from
`src/domain/objects/tree.ts` (it canonicalises order, so both sides of the differential
property are comparable by construction).

**Unit cases**

- Empty vs empty · absent vs populated (all adds) · populated vs absent (all deletes) ·
  identical trees (no changes) · one add · one delete · one modify (oid differs) · one
  `type-change` (`100644` vs `40000`, and `100644` vs `160000`) · a directory entry whose
  oid and stripped mode match (TREESAME — no change) · `40000` vs `040000` on the same oid
  (**no change**, ADR-519).
- **Interleaving order:** a pair whose entries force `<`, `>` and `=` in one walk, asserting
  the exact `changes` array order.
- **Pin B parity:** an unsorted old tree (`b.txt` then `a.txt`, hand-built bytes — NOT via
  `serializeTreeContent`, which sorts) against a canonical `a.txt`/`b.txt` tree emits
  `delete a.txt` **then** `add a.txt` with the *same* oid on both sides. This is the
  behaviour change ADR-518 ratified; it is git's exact output.
- **Pin B parity:** a duplicate-name tree emits per-entry results with no refusal.
- Structural refusal propagates: malformed bytes on either side throw
  `INVALID_TREE_ENTRY` (assert `data.offset` + `data.reason`), one isolated test per side.
- SHA-256 (`SHA256_CONFIG`) over the same fixtures.

**Property cases**

- (lens 2, `numRuns: 100`) for two arbitrary deduped entry arrays `ea`, `eb` and
  `ta = { type: 'tree', id: DUMMY, entries: ea }` / `tb = …`:
  `diffRawTrees(serializeTreeContent(ta, SHA1_CONFIG), serializeTreeContent(tb, SHA1_CONFIG), SHA1_CONFIG).changes`
  deep-equals `diffTrees(ta, tb).changes`. No normalisation is needed on either side —
  `serializeTreeContent` sorts on the way out and `entriesOf` sorts on the way in, so both
  walks see canonical order by construction. The oracle (`diffTrees`) is existing,
  independently-tested production code, so this is not a tautology.
- (lens 2, `numRuns: 100`) invariants: `diffRawTrees(x, x)` is empty; removing exactly one
  entry from `b` surfaces exactly one `delete` for it.

### TDD steps

1. **RED** — `raw-tree-diff.test.ts`: `diffRawTrees(undefined, undefined, SHA1_CONFIG)`
   returns `{ changes: [] }`. Fails: module does not exist.
2. **GREEN** — create `raw-tree-diff.ts` with the paired loop + two tails + emit helpers.
3. **RED→GREEN** — add/delete/modify/type-change/TREESAME, one isolated case at a time.
4. **RED→GREEN** — the `40000` vs `040000` no-change case (kills a mutant dropping the
   leading-zero strip in `cursorsSame`).
5. **RED→GREEN** — the interleaving-order case; then the two Pin B parity cases (unsorted,
   duplicate) with hand-built byte fixtures.
6. **RED→GREEN** — structural refusal per side; SHA-256 sweep.
7. **RED→GREEN** — the differential + invariant properties; extend
   `test/unit/domain/diff/arbitraries.ts`.
8. **REFACTOR** — biome complexity; confirm 100 % coverage on `src/domain/diff/raw-tree-diff.ts`
   and that `tree-diff.test.ts` is untouched and green.

### Gate

```
npx vitest run test/unit/domain/diff/raw-tree-diff.test.ts test/unit/domain/diff/raw-tree-diff.properties.test.ts test/unit/domain/diff/tree-diff.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/diff/raw-tree-diff.ts test/unit/domain/diff/raw-tree-diff.test.ts test/unit/domain/diff/raw-tree-diff.properties.test.ts test/unit/domain/diff/arbitraries.ts
```
Then `npx vitest run --project unit --coverage` — `src/domain/diff/raw-tree-diff.ts` at
100/100/100/100 — and `npm run check:duplicates`.

### Commit

`perf: add a raw merge-join tree diff over byte cursors`

---

## Part 4 — recursive descent over raw bytes

**Depends on:** Parts 1–3. **Design section:** P4. **ADRs:** 518, 522.

### Context

**Goal:** point the recursive diff's hot loop at `diffRawTrees` while keeping every guard,
every descent route and every emitted change byte-identical.

**File to change:** `src/application/primitives/diff-trees.ts` (453 lines). Current shapes:

```ts
export async function diffTrees(ctx, a: DiffTreesInput, b: DiffTreesInput, options?): Promise<TreeDiff | StatTreeDiff>
//   line 60: const [treeA, treeB] = await Promise.all([resolveInput(ctx, a), resolveInput(ctx, b)]);
//   line 61-64: options?.recursive === true ? await diffRecursive(ctx, treeA, treeB) : domainDiffTrees(treeA, treeB)
//   line 71: await buildPreimage(ctx, treeA, options.renameOptions)
async function resolveInput(ctx, input: DiffTreesInput): Promise<Tree | undefined>   // line 305
async function diffRecursive(ctx, a: Tree | undefined, b: Tree | undefined): Promise<TreeDiff>            // 328
async function diffRecursiveLevel(ctx, a: Tree | undefined, b: Tree | undefined, cursor: DiffCursor)      // 345
  //   line 351: const levelChanges = domainDiffTrees(a, b).changes;
async function expandLevelChange(ctx, change: DiffChange, cursor: DiffCursor): Promise<DiffChange[]>      // 362
async function diffChangedSubtree(ctx, change: ModifyChange, cursor: DiffCursor): Promise<DiffChange[]>   // 399
async function readTreeStrict(ctx, id: ObjectId): Promise<Tree>                                          // 423
async function expandAddedSubtree(ctx, id: ObjectId, prefix: string): Promise<AddChange[]>                // 429
async function expandDeletedSubtree(ctx, id: ObjectId, prefix: string): Promise<DeleteChange[]>           // 438
async function buildPreimage(ctx, treeA: Tree | undefined, renameOptions): Promise<FlatTree['entries'] | undefined>  // 295
interface DiffCursor { prefix: string; depth: number; oldStack: ReadonlyArray<ObjectId>; newStack: ReadonlyArray<ObjectId> }
const ROOT_CURSOR = { prefix: '', depth: 0, oldStack: [], newStack: [] };  const MAX_DIFF_RECURSION_DEPTH = 1024;
```

**Edits**

1. `diffRecursiveLevel` / `diffRecursive`: change both tree parameters from
   `a, b: Tree | undefined` to `aContent, bContent: Uint8Array | undefined`, and swap the one
   call:
   ```ts
   -  const levelChanges = domainDiffTrees(a, b).changes;
   +  const levelChanges = diffRawTrees(aContent, bContent, ctx.hashConfig).changes;
   ```
   Import by **module path**, never the barrel (a barrel export here makes `reports/api.json`
   stale and fails the prepush hook):
   `import { diffRawTrees } from '../../domain/diff/raw-tree-diff.js';` and
   `import { readObject, readRawObject } from './read-object.js';`.
   `expandLevelChange`, `withPrefix`, `joinPath`, `addLeaf`, `deleteLeaf` and `DiffCursor`
   are **untouched** — they consume `DiffChange`, which is unchanged.
2. Add a module-private strict raw read, mirroring `readTreeStrict` **exactly** (same
   error, same callers throwing, same callers not):
   ```ts
   async function readRawTree(ctx: Context, id: ObjectId): Promise<Uint8Array> {
     const raw = await readRawObject(ctx, id);
     if (raw.type !== 'tree') throw unexpectedObjectType('tree', raw.type, id);
     return raw.content;
   }
   ```
   Keep it **private to this file** — `flatten-raw.ts` must not import it (that would create
   a `diff-trees → flatten-tree → flatten-raw → diff-trees` runtime cycle, which
   `check:architecture`'s `no-circular` rule rejects).
3. `diffChangedSubtree`: keep the guard order **verbatim** — depth (`exceedsMaxTreeDepth(cursor.depth,
   MAX_DIFF_RECURSION_DEPTH)` → `treeDepthExceeded(cursor.depth)`), then
   `cursor.oldStack.includes(change.oldId)` → `treeCycleDetected(change.oldId)`, then the
   new-side stack — then `Promise.all([readRawTree(ctx, change.oldId), readRawTree(ctx, change.newId)])`.
   The oids were already hex-converted at emission because they are the read keys, so this
   costs nothing extra.
4. Add the raw input resolver **with the peel preserved** (plan correction 2):
   ```ts
   async function resolveRawInput(ctx: Context, input: DiffTreesInput): Promise<Uint8Array | undefined> {
     if (input === undefined) return undefined;
     if (typeof input !== 'string') return readRawTree(ctx, input.id);   // caller-supplied Tree → raw by id
     const raw = await readRawObject(ctx, input);
     if (raw.type === 'tree') return raw.content;
     return readRawTree(ctx, (await readTree(ctx, input)).id);           // peel commit/tag, MAX_PEEL_DEPTH kept
   }
   ```
   `readTree` (already imported) peels commit → tree and tag → tree with `MAX_PEEL_DEPTH`
   (`refChainTooDeep`) and throws `unexpectedObjectType('tree', 'blob', id)` for a blob —
   all three behaviours preserved. The extra read only happens on the (rare) peel path and
   is normally served from `ctx.deltaCache`. Accepted consequence of resolving a
   caller-supplied `Tree` by its `id`: a hand-forged `Tree` whose `id` is not in the store
   now throws `OBJECT_NOT_FOUND`.
5. `diffTrees`: branch the resolution instead of resolving once. Use **named locals** (a
   tuple spread into a 3-parameter call fights TypeScript's inference for no gain), and keep
   both sides concurrent via `Promise.all`:
   ```ts
   let rawDiff: TreeDiff;
   if (options?.recursive === true) {
     const [aContent, bContent] = await Promise.all([resolveRawInput(ctx, a), resolveRawInput(ctx, b)]);
     rawDiff = await diffRecursive(ctx, aContent, bContent);
   } else {
     const [treeA, treeB] = await Promise.all([resolveInput(ctx, a), resolveInput(ctx, b)]);
     rawDiff = domainDiffTrees(treeA, treeB);
   }
   ```
   (Prefer a small `resolveAndDiff` helper if `diffTrees` trips the complexity cap.)
   `resolveInput` stays **verbatim** for the non-recursive branch.
6. `buildPreimage` takes the **unresolved input** so it no longer needs a parsed `Tree`:
   `buildPreimage(ctx, a: DiffTreesInput, renameOptions)` → `if (renameOptions?.copies !== 'harder' || a === undefined) return undefined;`
   then `flattenTree(ctx, a)` (which accepts `ObjectId | Tree`). Update the call site at
   line 71 to pass `a`.
7. **Delete `readTreeStrict`** — it becomes dead once `diffChangedSubtree` uses `readRawTree`
   (no-dead-code rule). Remove any import that biome's `noUnusedImports` then flags
   (`readObject`, and `Tree` if the `buildPreimage` change orphans it). `domainDiffTrees`
   stays — the non-recursive branch still uses it.

**Tests to change:** `test/unit/application/primitives/diff-trees.test.ts` (2184 lines).
Helpers at the top: `blob(ctx, content)`, `subTree(ctx, name, id, mode)`,
`buildSeededContext`/`instrumentedContext` from `./fixtures.js`. Module namespace imports
already present: `flattenTreeMod`, `readObjectMod`, `domainTreeDiffMod`, `encodingMod`,
`materialisePatchFilesMod`.

Five existing blocks need rework — they mock the parsed path:

- **line ~1922** `'Given recursive=true and the domain diff yields a change at the root (prefix is empty)'`
  spies `vi.spyOn(domainTreeDiffMod, 'diffTrees').mockReturnValue({ changes: [sentinelChange] })`
  to prove `withPrefix('')` returns the same object reference. Re-point at
  `vi.spyOn(rawTreeDiffMod, 'diffRawTrees')` (add
  `import * as rawTreeDiffMod from '../../../../src/domain/diff/raw-tree-diff.js'`).
- **lines ~1995, ~2040, ~2090, ~2145** — the four cycle tests
  (`old-side`, `new-side`, `both-sides`, `staggered`) mock
  `vi.spyOn(readObjectMod, 'readObject').mockImplementation(… id === LOOP_ID ? loopTree : realReadObject(…))`
  with hand-built `Tree` literals whose entry points back at the tree's own id. Re-point each
  to `vi.spyOn(readObjectMod, 'readRawObject')` returning
  `{ type: 'tree', content: serializeTreeContent(loopTree, SHA1_CONFIG) }` and delegating to
  the real `readRawObject` for every other id. The asserted outcomes
  (`TREE_CYCLE_DETECTED` + the exact `data.id`, and *which* side's guard fires) must not
  change — those distinctions are what isolate the old-side from the new-side guard.
- **line ~337** `'Then bytesToHex/decode calls scale with entries actually read, not the
  unchanged subtree size'` asserts `bytesToHexSpy.mock.calls.length <= 4` and
  `decodeSpy.mock.calls.length <= 10`. Both are **upper** bounds, so the test stays green —
  but the raw walk drops them sharply (only the emitted `root.txt` pair converts oids).
  **Tighten both bounds to the new observed counts** so the test becomes the structural proof
  of "zero string allocation for TREESAME entries": run it, read the actual numbers, pin
  them with `toBeLessThanOrEqual` at the observed value and a comment explaining what each
  remaining call is.
- **line ~315** `'Then no subtree was ever flattened'` (`flattenSpy` not called) needs no
  change and is a load-bearing regression guard — keep it green.

`expandDirectoryChanges` (line ~167, the **non-recursive** `withStat`/whitespace path) also
routes through `expandLevelChange` → `diffChangedSubtree`, so it now reads raw too. Its
existing `withStat` / `ignoreWhitespace` cases in the same file are the guard; no edit needed,
but they must be re-run.

**New tests to add in the same file**

- Recursive diff over a nested fixture emits the identical `DiffChange[]` (order included)
  for add / modify / delete / type-change, nested adds, nested deletes, and a deep `a/b/c`
  nest. Assert full arrays, not lengths.
- A **TREESAME subtree is never read**: `vi.spyOn(readObjectMod, 'readRawObject')` and assert
  it was not called with the unchanged subtree's oid (structural proof of requirement 3,
  alongside the tightened `bytesToHex` bound).
- A **commit oid** passed to `diffTrees(ctx, commitId, otherCommitId, { recursive: true })`
  still diffs (the peel), and a **blob oid** throws `UNEXPECTED_OBJECT_TYPE` with
  `data.expected === 'tree'` / `data.actual === 'blob'` (assert via try/catch). Neither path
  is covered today.
- A directory entry whose oid resolves to a **blob** on the modify route throws
  `UNEXPECTED_OBJECT_TYPE` (isolated). Note the deliberate asymmetry: the add/delete route
  goes through `flattenTree`, which **silently skips** such an entry. Keep both; do not
  unify them.
- The same nested fixtures under a 32-byte `HashConfig` (SHA-256 context).

### TDD steps

1. **RED** — add the commit-oid peel test first (it passes today, so assert it **before**
   touching `resolveInput`; it is the regression net for edit 4). Then add the
   nested-fixture array-equality tests — also green today, same purpose.
2. **RED** — re-point the sentinel spy to `rawTreeDiffMod.diffRawTrees`. Fails: the
   recursive path still calls `domainDiffTrees`, so the sentinel never appears.
3. **GREEN** — edits 1–7: `readRawTree`, `resolveRawInput`, the `diffRecursiveLevel`
   signature + call swap, `buildPreimage`'s input change, delete `readTreeStrict`.
4. **RED→GREEN** — re-point the four cycle spies to `readRawObject` one at a time; each fails
   with "cycle not detected"/timeout while still mocking the parsed read, then passes.
5. **RED→GREEN** — the TREESAME-not-read spy test; the non-tree-child throw; the blob-oid
   throw; the SHA-256 sweep.
6. **REFACTOR** — tighten the `bytesToHex`/`decode` bounds to the observed counts; remove
   orphaned imports; re-run the **whole** file (2184 lines) plus every downstream suite that
   consumes the recursive path: `test/unit/application/commands/diff.test.ts`,
   `blame.test.ts`, `rebase.test.ts`, `range-diff.test.ts`, `patch-id.test.ts`,
   `test/unit/application/primitives/detect-similarity-renames.test.ts`.

### Gate

```
npx vitest run test/unit/application/primitives/diff-trees.test.ts test/unit/application/commands/diff.test.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/rebase.test.ts test/unit/application/commands/range-diff.test.ts test/unit/application/primitives/patch-id.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/diff-trees.ts test/unit/application/primitives/diff-trees.test.ts
```
Then `npm run check:architecture` (the `no-circular` rule is the one this part can break).

### Commit

`perf: walk the recursive tree diff over raw bytes`

---

## Part 5 — raw `flattenTree`

**Depends on:** Parts 1–2. **Design section:** P5. **ADRs:** 523 (reimplement, no parallel
variant), 518 (flatten keeps name validation).

### Context

**Goal:** reimplement `flattenTree` over the cursor — one implementation, one behaviour — so
`merge`, `rm`, `apply-merge-to-worktree`, `buildPreimage`, `expandAddedSubtree`,
`expandDeletedSubtree` and the bound `repo.primitives.flattenTree` all inherit the win.
`walkTree` itself is **untouched**.

**Current implementation** — `src/application/primitives/flatten-tree.ts` (30 lines):
```ts
export const flattenTree = async (ctx: Context, treeIdOrObject: ObjectId | Tree): Promise<FlatTree> => {
  const entries = new Map<FilePath, FlatTreeEntry>();
  for await (const entry of walkTree(ctx, treeIdOrObject)) {
    if (entry.mode === FILE_MODE.DIRECTORY) continue;
    entries.set(entry.path, { id: entry.id, mode: entry.mode });
  }
  return { entries };
};
```
The signature is **unchanged**. It stays exported from `src/application/primitives/index.ts`
(line 36) and bound on the facade — no surface change.

**The semantics to reproduce, exactly** — `src/application/primitives/walk-tree.ts` (91
lines). `walkTree` with no options resolves to `recursive: true`, `maxDepth: 1024`,
`maxEntries: MAX_FLAT_TREE_ENTRIES` (1 000 000, from `src/domain/diff/flat-tree.ts`), a
shared `Counter { value: number }`, and for an oid root `resolveTree` (throws
`unexpectedObjectType('tree', obj.type, id)` for a non-tree). `walkInternal` per level:

1. `if (stack.includes(tree.id)) throw treeCycleDetected(tree.id)` — **on entry to the
   level, before iterating it**, against the level's own oid.
2. `if (exceedsMaxTreeDepth(depth, config.maxDepth)) throw treeDepthExceeded(depth)`.
3. `const descentStack = [...stack, tree.id]` — the root call passes `stack: []`.
4. Per entry, in this exact order: `if (config.ctx.signal?.aborted) throw operationAborted()`
   → build `path` (`prefix === '' ? entry.name : \`${prefix}/${entry.name}\``) →
   `counter.value += 1` (**directories included**) →
   `if (exceedsMaxTreeEntries(counter.value, config.maxEntries)) throw treeEntryLimitExceeded(counter.value, config.maxEntries)`
   → yield the entry → if the mode is a directory, `readObject` the child and **recurse only
   when `subtreeObj.type === 'tree'`** — a directory-mode entry whose oid resolves to a
   non-tree is **silently skipped, never thrown**.

**New file:** `src/application/primitives/internal/flatten-raw.ts` (plan correction 3 — the
bounds must be injectable or the `treeEntryLimitExceeded` throw is untestable and leaves a
guaranteed surviving mutant; `src/application/primitives/internal/` is an existing home for
exactly this kind of module, e.g. `bounded-map.ts`, `loose-oid-cache.ts`).

```ts
export interface FlattenBounds { readonly maxDepth: number; readonly maxEntries: number }
export const DEFAULT_FLATTEN_BOUNDS: FlattenBounds = { maxDepth: 1024, maxEntries: MAX_FLAT_TREE_ENTRIES };
export async function flattenRawTree(ctx: Context, root: ObjectId | Tree, bounds: FlattenBounds): Promise<FlatTree>
```
`flatten-tree.ts` becomes `flattenRawTree(ctx, treeIdOrObject, DEFAULT_FLATTEN_BOUNDS)` and
keeps its doc comment (updated: it no longer bridges `walkTree`).

**Implementation shape**

- Root bytes: for an `ObjectId`, `readRawObject` + `type !== 'tree'` →
  `unexpectedObjectType('tree', raw.type, id)` (mirrors `resolveTree`). For a `Tree` object,
  read raw by `tree.id` (same rule as the recursive diff's `Tree` input) — the accepted
  consequence is that a hand-forged `Tree` whose `id` is absent now throws `OBJECT_NOT_FOUND`.
- Per level: `openTreeCursor(content, ctx.hashConfig)`, then `while (!cursor.done)` with
  `advanceCursor` at the end of the body. Guard order and counter placement **identical** to
  `walkInternal` above (the counts are asserted).
- **Per entry, decode the name first, then the mode** — that is `parseTreeContent`'s order
  (name check at `src/domain/objects/tree.ts` line 50, `normalizeFileMode` at line 62), so an
  entry that is bad in both ways keeps reporting the *name* error.
- **Name validation stays** (requirement 7 — this path feeds worktree materialisation via
  `apply-merge-to-worktree` and `repo.primitives.flattenTree`): after `cursorName`, refuse
  `''`, `'.'`, `'..'` and any name containing `'/'` with
  `invalidTreeEntry(c.offset, \`invalid entry name: ${name}\`)` — the **exact** reason string
  `parseTreeContent` uses today (line 51), so no error message moves. The cost is nil: every
  emitted entry decodes its name anyway. Validate **every** entry's name, directories
  included (that is what `parseTreeContent` did).
- **Call `cursorMode(c)` for every entry**, and branch on `mode === FILE_MODE.DIRECTORY` —
  **not** on the free `c.isDir`. `c.isDir` is git's `S_ISDIR`, which accepts `40644`;
  `cursorMode` refuses it exactly as `normalizeFileMode` does today. Branching on `isDir`
  would silently start descending into modes tsgit has always refused on this path — a
  behaviour change no ADR sanctions. Matching one interned constant per entry is cheap and
  allocation-free. Say *why* in a comment.
- Leaf: `entries.set(joinPath(prefix, name), { id: cursorOid(c), mode })`.
- Directory: read raw by `cursorOid(c)` and recurse **only** when `type === 'tree'`;
  otherwise skip silently. The directory entry itself is **not** added to the map (only
  `FILE_MODE.DIRECTORY` entries are omitted — gitlinks and symlinks are kept).
- **No duplicate-name check.** `parseTreeContent`'s `Set<string>` is deliberately dropped —
  duplicate detection now lives only in `fsck` (git's own home for it). A duplicate name
  therefore resolves last-wins in the Map. Pin that with a test and a *why* comment; do not
  re-add a `Set`.
- Uses `FILE_MODE` and `joinPath`-style path building; import `operationAborted` from
  `src/domain/error.js`, the tree guards from `src/domain/objects/error.js`, and
  `exceedsMaxTreeDepth` / `exceedsMaxTreeEntries` from `../validators.js`.
- Must not import from `diff-trees.ts` (cycle) — see plan correction 4.

**What drops out:** the intermediate `Tree` per level, the `TreeEntry` per entry, the
`Set<string>`, `walkTree`'s async generator (one promise per entry) and its
yield-then-`readObject` interleave. **What stays:** the per-branch cycle stack, `maxDepth`,
the entry counter, the abort check, the directory-skip filter, the silent non-tree skip, and
DFS pre-order insertion order (so `Array.from(flat.entries, …)` in `expandAddedSubtree` /
`expandDeletedSubtree` yields the same sequence).

**Tests**

- **Extend:** `test/unit/application/primitives/flatten-tree.test.ts` (247 lines). Existing
  blocks to keep green: empty tree · single file · nested `/`-keyed paths · exec+symlink
  modes · two-level nest · `Tree` object vs oid produce identical results (**update its
  stale comment** "no redundant root read needed" — the root is now read raw) · gitlink
  preserved · same entry set as a `walkTree` drain (contents **and** insertion order via
  `expect([...result.entries]).toEqual([...walked])`) · same `fs.read` count as a `walkTree`
  drain (via `instrumentedContext`).
  Add: a non-tree oid root throws `UNEXPECTED_OBJECT_TYPE` (assert `expected`/`actual`) ·
  a directory-mode entry whose oid is a blob is **skipped, not thrown** (build it with
  `writeTree(ctx, [{ name: 'd', mode: FILE_MODE.DIRECTORY, id: <blobId> }])`) ·
  invalid names still refused, one isolated test each for `''`, `'.'`, `'..'`, `'a/b'`
  (hand-build the tree bytes and `writeObject` them raw, since `writeTree` may canonicalise)
  · a duplicate-name tree yields the last entry · an aborted signal throws
  `OPERATION_ABORTED`.
- **New:** `test/unit/application/primitives/internal/flatten-raw.test.ts` — the bounds
  guards, using small explicit bounds so they are reachable:
  `{ maxEntries: 2 }` on a 3-entry tree throws `TREE_ENTRY_LIMIT_EXCEEDED` with
  `data.count === 3` and `data.limit === 2` (just-over) · `{ maxEntries: 3 }` on the same
  tree succeeds (at-cap) · **directories count toward the limit** (a tree whose first entry
  is a directory trips the cap at the same index `walkTree` would) · `{ maxDepth: 1 }` on a
  two-level nest throws `TREE_DEPTH_EXCEEDED` with `data.depth` · a self-referential tree
  throws `TREE_CYCLE_DETECTED` with `data.id` (mirror `walk-tree.test.ts` line ~233's
  arrangement, adapted to raw bytes). Note the `sutBindsResult` rule:
  `const sut = flattenRawTree;`.

### TDD steps

1. **RED** — `flatten-tree.test.ts`: add the two behaviour tests that are **already true
   today** but uncovered — a non-tree oid root throws `UNEXPECTED_OBJECT_TYPE`, and a
   directory-mode entry whose oid is a blob is skipped rather than thrown. They pass on the
   first run; that is the point — they are the regression net for the rewrite. Do **not**
   write the duplicate-name case yet (its behaviour intentionally changes in step 4).
2. **RED** — `internal/flatten-raw.test.ts`: `flattenRawTree(ctx, treeId, { maxDepth: 1024,
   maxEntries: 2 })` throws `TREE_ENTRY_LIMIT_EXCEEDED`. Fails: module does not exist.
3. **GREEN** — create `internal/flatten-raw.ts` with the descent, guards in `walkInternal`'s
   exact order, name validation, and the leaf/directory branch; re-point `flatten-tree.ts` at
   it and drop the `walkTree` import.
4. **RED→GREEN** — the remaining bounds cases (at-cap, directories counted, depth, cycle),
   one at a time; then the four invalid-name refusals, isolated; then the abort case.
   Finally add the duplicate-name case as a **pin of the intentional behaviour change**: it threw `INVALID_TREE_ENTRY` before this part and now resolves last-wins,
   because duplicate detection moved to `fsck` where git keeps it. Write the `it` title as
   the new behaviour and put the reason in a `// Arrange` comment (no document refs).
5. **REFACTOR** — biome complexity on the descent; update the file doc comment and the stale
   "no redundant root read" comment; re-run every flatten consumer:
   `test/unit/application/commands/merge.test.ts`, `rm.test.ts`,
   `test/unit/application/primitives/apply-merge-to-worktree.test.ts`,
   `materialize-tree.test.ts`, `test/unit/application/primitives/diff-trees.test.ts`,
   `test/unit/application/primitives/walk-tree.test.ts` (must be untouched and green).

### Gate

```
npx vitest run test/unit/application/primitives/flatten-tree.test.ts test/unit/application/primitives/internal/flatten-raw.test.ts test/unit/application/primitives/walk-tree.test.ts test/unit/application/primitives/diff-trees.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/rm.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/flatten-tree.ts src/application/primitives/internal/flatten-raw.ts test/unit/application/primitives/flatten-tree.test.ts test/unit/application/primitives/internal/flatten-raw.test.ts
```
Then `npm run check:architecture` and `npm run check:dead-code`.

### Commit

`perf: flatten trees over the raw byte cursor`

---

## Part 6 — corrupt-tree interop pins against real git

**Depends on:** Parts 4–5 (the raw walk must be live to observe parity). **Design section:**
Test strategy → Interop. **ADR:** 518 (refusal surface), 249 (structured data, not cosmetics).

### Context

**Goal:** pin every accepted-vs-refused row of Pins A–D against real `git`, so the ratified
refusal surface is mechanically guarded (requirement 8).

**Why this is a standalone part.** It has **no `src/` delta** — one additive test helper plus
a new interop suite. The sizing rule's "no standalone test-only parts" applies to *feature*
code; test-infra/harness parts with no `src/` delta are the stated exception, and there is no
implementation part to fold 18 git-spawning cases into without making Part 4 too big to land.

**New file:** `test/integration/tree-diff-corrupt-interop.test.ts`.

**Harness rules (all load-bearing — see `test/integration/interop-helpers.ts`, 216 lines)**

- Import `GIT_AVAILABLE`, `runGit`, `git`, `gitAsync`, `runGitEnv`, `makePeerPair` from
  `./interop-helpers.js`. Gate the whole file with `describe.skipIf(!GIT_AVAILABLE)(…)`.
- **Never** spawn git any other way: `runGit` scrubs every `GIT_*` var from the env (a husky
  pre-push hook exports `GIT_DIR`, and `git -C <tmp>` does **not** override it), points
  `HOME`/`XDG_CONFIG_HOME` at a never-created path under `os.tmpdir()`, and sets
  `GIT_CONFIG_NOSYSTEM=1` so no ambient config can move git's bytes.
- **One shared `beforeAll` repo with an explicit 60 s timeout** — `beforeAll(async () => { … },
  60_000)`. Heavy git-spawning interop under `validate`'s concurrency blows the default 10 s
  hook timeout. Dispose in `afterAll`.
- Two additive changes to `interop-helpers.ts` (both reuse `SAFE_ENV`; do not restructure the
  file):
  1. ```ts
     export const tryRunGitWithExit = (args: ReadonlyArray<string>, options?: { readonly env?: NodeJS.ProcessEnv })
       : { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
     ```
     built on `spawnSync` (mirror `test/integration/fsck-interop.test.ts` lines ~43–56, which
     has a local copy). Leave that local copy alone — refactoring it is out of scope.
  2. **Widen `runGit`'s `input` option from `string` to `string | Uint8Array`** and pass it
     through unchanged (line ~78: `options: { readonly input?: string; … }`, line ~82:
     `opts.input = options.input`). This is **required**, not cosmetic: raw oid bytes are
     arbitrary, and `execFileSync` writes a *string* `input` as UTF-8, silently mangling every
     byte ≥ 0x80. Malformed tree bodies must be handed over as a `Buffer`/`Uint8Array`.
     Existing string callers are unaffected.
- `@proves` header block is the file convention (the `integrationProof` detector reads it;
  gating is `false` but the `unique` string must be ≥12 chars and distinct across the suite):
  ```
  * @proves
  *   surface:        diff.recursive
  *   bucket:         cross-tool-interop
  *   unique:         corrupt-tree diff refusals and fsck-class acceptances match canonical git
  *   interopSurface: diff
  ```
- **`overMockedIntegration` is not gating but is reported** — write zero `vi.spyOn`/`vi.mock`
  in this file.

**Fixture construction.** In the shared `beforeAll`, `runGit(['init', '-q', '-b', 'main', dir])`,
then write blobs `B1` (`one\n`) and `B2` (`two\n`) with `git hash-object -w --stdin`, build
the canonical reference tree `T_OK` (`a.txt→B1`, `b.txt→B2`) and each malformed tree with
```
runGit(['-C', dir, 'hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], { input: <Buffer> })
```
Build each body as a `Buffer` (`Buffer.concat([Buffer.from('100644 a.txt\0', 'latin1'), rawOidBytes])`)
and pass the **Buffer**, never a string — see the `runGit` widening above. `--literally`
bypasses git's write-side validity checks and writes the object loose. The empty tree
`E = 4b825dc6…` needs no write — it is virtual on both sides.

**tsgit side.** `createNodeContext` from `src/adapters/node/node-adapter.js` against the same
directory, then call the primitive directly with tree oids:
`diffTrees(ctx, oldTreeOid, newTreeOid, { recursive: true })` from
`src/application/primitives/diff-trees.js`. No commits needed.

**Comparison rule (ADR-249).** The library emits **no display string**. Reconstruct git's
`diff-tree -r` raw line **inside the test** from the structured fields —
`:<oldMode> <newMode> <oldId> <newId> <status>\t<path>`, with `000000` and the 40-zero oid on
the absent side — and compare to
`gitAsync(dir, 'diff-tree', '-r', '--no-ext-diff', oldTree, newTree)`. Two things to confirm
against the *captured* output rather than assume: whether oids are abbreviated (pass
`--no-abbrev` if the live output is short) and that comparing two **tree** oids emits only
raw lines (no leading commit line). Shape the reconstruction to the captured bytes; do not
hand-derive it. For refusals assert **co-refusal**: tsgit throws the documented code (with
`.data` asserted via try/catch) **and** `tryRunGitWithExit` reports `exitCode === 128`. Do
**not** assert tsgit reproduces git's `fatal:` message text — tsgit is a library and its
reason strings are its own.

**Cases**

- **Pin A (6 rows, one `it` each, co-refusal):** empty name · truncated hash (10 oid bytes) ·
  trailing junk after a complete entry · no space after the mode · non-octal mode digit
  (`100648`) · leading space (empty mode). tsgit: `INVALID_TREE_ENTRY` with the reason from
  Part 2's scanner; git: exit 128.
- **Pin B (5 rows, one `it` each, parity):** unsorted (`b.txt` then `a.txt`) vs `T_OK` →
  reconstructed lines equal git's `D a.txt` then `A a.txt`, **same oid on both sides**, exit
  0 · duplicate name (`a.txt→B1`, `a.txt→B2`) vs `T_OK` · name `a/b` vs `E` · name `.` vs
  `E` · name `..` vs `E`. This is the ratified behaviour change: tsgit used to emit *nothing*
  for the unsorted pair.
- **Pin B, non-recursive cross-check (1 `it`):** git's `diff-tree` **without** `-r` produces
  byte-identical output for the unsorted pair (one walker for both). Record tsgit's
  `{ recursive: false }` result for the same pair and note in a comment that the parsed path
  still re-sorts — a known, out-of-scope asymmetry. Assert what tsgit actually does so the
  asymmetry is pinned rather than discovered later; do **not** change `tree-diff.ts` here.
- **Pin C (5 rows):** `40000 d` vs `040000 d` → tsgit emits nothing, git emits nothing ·
  `100644 a.txt` vs `0100644 a.txt` → both empty · `40000 d` vs `40644 d` → git empty,
  **tsgit throws `INVALID_FILE_MODE` with `data.value === '40644'`** · `100644` vs `100664`
  → git empty, tsgit throws with `data.value === '100664'` · `100644` vs `100777` → git
  emits `M` with `100755`, tsgit throws with `data.value === '100777'`. The three refusals
  are the pre-existing mode-canonicalisation divergence (plan correction 5) — pin them with a
  comment saying *why* they are refused (tsgit accepts a five-value mode set) and that a
  faithful fix must move mode normalisation itself. **No document or phase references in the
  comment.**
- **Pin D (1 `it`):** create `d/f`, `d.txt`, `d-dash`, `d0` in a worktree,
  `git add -A && git write-tree`, and assert the recursive diff of `E` vs that tree emits the
  adds in git's order — `d-dash`, `d.txt`, `d/f`, `d0` — reconstructed against
  `git diff-tree -r`.

**Regression net (do not modify, but run them):** `diff-recursive-interop.test.ts`,
`diff-tree-oid-modify-interop.test.ts`, `diff-type-change-interop.test.ts`,
`empty-tree-diff-interop.test.ts`, `show-interop.test.ts`, `blame-interop.test.ts`,
`range-diff-interop.test.ts`, `merge-interop.test.ts` must stay byte-identical — they are
the proof that the raw walk did not move canonical behaviour.

### TDD steps

1. **RED** — scaffold the file with the `@proves` header, the shared `beforeAll(…, 60_000)`
   repo, the blob/tree builders and the line-reconstruction helper, plus the **first Pin B
   unsorted case**. It fails today only if run before Part 4 — after Part 4 it should pass;
   if it does not, the raw walk is wrong, which is exactly what this case is for. Write it
   first for that reason.
2. **GREEN** — add `tryRunGitWithExit` to `interop-helpers.ts`; fix the reconstruction helper
   until the unsorted case matches git byte-for-byte.
3. **RED→GREEN** — the remaining Pin B rows, one at a time.
4. **RED→GREEN** — the six Pin A co-refusal rows, one `it` each.
5. **RED→GREEN** — the five Pin C rows (two parity, three pinned refusals), then Pin D, then
   the non-recursive cross-check.
6. **REFACTOR** — collapse only rows with an identical oracle shape into `it.each` (row field
   `label`, never `then` — biome `noThenProperty`); keep refusal rows separate from parity
   rows. Re-run the full integration project.

### Gate

```
npx vitest run test/integration/tree-diff-corrupt-interop.test.ts test/integration/diff-recursive-interop.test.ts test/integration/diff-tree-oid-modify-interop.test.ts test/integration/diff-type-change-interop.test.ts test/integration/empty-tree-diff-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/integration/tree-diff-corrupt-interop.test.ts test/integration/interop-helpers.ts
```
Then `npm run check:test-pyramid` and `npm run check:spelling`.

### Commit

`test: pin corrupt-tree diff behaviour against canonical git`

---

## Part 7 — tree structure faults on packed objects, and the `fsck --strict` pins

**Depends on:** Part 1 (`readRawObject`). **ADR:** 518 (the fsck rider).
**Read plan correction 1 before starting.**

### Context

**Goal:** discharge ADR-518's rider honestly. The five tree-structure checks
(`treeNotSorted`, `duplicateEntries`, `hasDot`, `hasDotdot`, `fullPathname`) **already
exist** — this part (a) closes the one place they do not fire, and (b) pins the four that are
not yet cross-tool-pinned against `git fsck --strict`.

**What already exists (verify, do not rewrite)**

- `src/domain/fsck/validate-tree.ts` (245 lines) — `parseTreeEntriesTolerant` (tolerant,
  never throws), `checkNameFaults` → `MSG_EMPTY_NAME` / `MSG_HAS_DOT` / `MSG_HAS_DOTDOT` /
  `MSG_HAS_DOTGIT` / `MSG_FULL_PATHNAME` / `MSG_LARGE_PATHNAME`, `checkEntryFaults` →
  `MSG_ZERO_PADDED_FILEMODE`, `MSG_BAD_FILEMODE`, `MSG_NULL_SHA1`,
  `MSG_DUPLICATE_ENTRIES` (via `seenNames`), `MSG_TREE_NOT_SORTED` (via `treeEntrySortKey`
  + `compareBytes`), and the special-file mode checks. Msg-id constants live in
  `src/domain/fsck/msg-ids.ts`; severities in `severity.ts`; dispatch in `validate-object.ts`.
- Unit coverage: `test/unit/domain/fsck/validate-object.test.ts` (126 K) already asserts
  `treeNotSorted`, `hasDotdot`, `fullPathname`, `duplicateEntries` with severities.
- Interop: `test/integration/fsck-interop.test.ts` (1242 lines) already pins
  `zeroPaddedFilemode` (both default and `--strict`), `treeNotSorted` (ERROR, exit 1),
  corrupt/hash-mismatch/connectivity/`gitmodules*` scenarios. It hand-writes loose objects
  with a local `writeLooseObject(workDir, type, body)` helper (`zlib.deflateSync` +
  `sha1Hex`, line ~99), has its own `buildSafeEnv`/`tryRunGitWithExit`, uses
  `createNodeContext` + the `fsck` command, and reconstructs git's stderr lines from the
  structured findings. `const SETUP_TIMEOUT = 60_000` is already defined and used.

**The one real gap (fix it)** —
`src/application/commands/internal/fsck/content-validation.ts`, private
`tryGetRawObjectBody(ctx, id): Promise<RawObjectResult>` (line 35):

- **Loose branch** (`looseCompressedBytes` returns bytes): inflates, `parseHeader`, returns
  the raw body — tolerant, so all five checks fire. Correct; leave it.
- **Pack branch** (line ~67): `readObject(ctx, id, { verifyHash: false })` then
  `serializeObject(obj, ctx.hashConfig)`. Two defects:
  1. `readObject` → `parseTreeContent`, which **throws** on a duplicate name, `''`, `'.'`,
     `'..'` or an embedded `/` — the catch turns every such packed tree into
     `{ ok: false, msgId: 'badType' }`, so real git's `duplicateEntries` / `hasDot` /
     `hasDotdot` / `fullPathname` are never reported for a packed object (and `git gc` /
     `git repack` packs malformed trees readily).
  2. `serializeObject` **re-sorts** tree entries, so `hashBytes` for an unsorted packed tree
     is the canonicalised form — producing a **false `hash-mismatch` finding**.

  Fix both with the symbol Part 1 introduced:
  ```ts
  const raw = await readRawObject(ctx, id, { verifyHash: false });
  const header = serializeHeader(raw.type, raw.content.length);
  const hashBytes = new Uint8Array(header.length + raw.content.length);   // header + ORIGINAL bytes
  hashBytes.set(header, 0); hashBytes.set(raw.content, header.length);
  return { ok: true, kind: raw.type, rawBody: raw.content, hashBytes };
  ```
  `serializeHeader(type, contentSize)` is already exported from
  `src/domain/objects/index.js` (`header.ts`) and `parseHeader` is already imported in this
  file. Keep the surrounding `try { … } catch { return { ok: false, msgId: 'badType' } }`
  so a genuinely missing/corrupt object still reports `badType` — the existing unit test
  `test/unit/application/commands/internal/fsck/content-validation.test.ts` (a universe
  containing an unreadable id → `badType`, exit bit 1) must stay green unchanged.
  `readRawObject` is imported from `../../../primitives/read-object.js` (this file already
  imports `readObject` from there — replace or extend the import as needed and drop
  `serializeObject` if it becomes unused).

**Do NOT touch** `validate-tree.ts`'s hardcoded `SHA_LENGTH = 20` (a SHA-256 fsck gap,
pre-existing and out of scope) or its `VALID_MODES` set.

**Tests**

- **Extend:** `test/unit/application/commands/internal/fsck/content-validation.test.ts`
  (31 lines, `const sut = runContentValidationPass`). Add a `describe` per fault, each
  writing the malformed tree **into a pack** so the pack branch is exercised: build the raw
  tree body, `writeObject` it, then pack it — or, simpler and sufficient, seed a
  `createMemoryContext` whose loose probe misses and whose pack carries the object (reuse
  `test/unit/application/primitives/pack-fixture.ts` if it fits; otherwise use
  `buildSeededContext` + `buildPack`). Assert the finding set contains
  `duplicateEntries` / `hasDot` / `hasDotdot` / `fullPathname` / `treeNotSorted` and **not**
  `badType`, and that no spurious `hash-mismatch` is reported for the unsorted case.
  If packing inside a unit test proves disproportionate, move these four assertions into the
  interop file below instead and keep the unit test focused on the `hashBytes` shape.
- **Extend:** `test/integration/fsck-interop.test.ts` — add one scenario per unpinned check,
  reusing the file's existing `writeLooseObject`, `tryRunGitWithExit`, shared-`beforeAll` +
  `SETUP_TIMEOUT` conventions and its reconstruct-git's-stderr comparison style:
  `duplicateEntries` (ERROR) · `hasDot` (WARN → ERROR under `--strict`) · `hasDotdot`
  (WARN → ERROR under `--strict`) · `fullPathname` (WARN → ERROR under `--strict`). Each
  asserts the msg-id, the severity in **both** default and `--strict` mode, and the exit
  code, against `git fsck --strict`'s real output. A malformed tree needs a reachable ref to
  enter git's universe — follow the file's existing pattern (write a commit object pointing
  at the tree and point a ref at it).
- Do not add a new interop file: `fsck-interop.test.ts` already owns the `fsck`
  `interopSurface`, and a second file claiming it would collide with the
  `integrationProof` detector's uniqueness rule.

### TDD steps

1. **RED** — `fsck-interop.test.ts`: add the `duplicateEntries` scenario (loose). It should
   **pass** immediately (the check exists) — that is the point: it converts an unpinned
   implementation into a pinned one. If it fails, the severity or exit-code mapping in
   `severity.ts` is wrong for that msg-id; fix `severity.ts`, not the test's expectation of
   git's output.
2. **RED→GREEN** — the `hasDot`, `hasDotdot`, `fullPathname` scenarios, one at a time, each
   in both default and `--strict` mode.
3. **RED** — `content-validation.test.ts`: a **packed** duplicate-name tree yields a
   `duplicateEntries` finding. Fails today with `msgId: 'badType'` (the parse throws and is
   swallowed).
4. **GREEN** — swap the pack branch of `tryGetRawObjectBody` to `readRawObject` +
   `serializeHeader`.
5. **RED→GREEN** — packed `hasDot` / `hasDotdot` / `fullPathname`; then the unsorted packed
   tree reports `treeNotSorted` and **no** `hash-mismatch`.
6. **REFACTOR** — drop the now-unused `serializeObject` import if orphaned; re-run
   `test/unit/application/commands/fsck.test.ts` (which asserts `treeNotSorted` findings and
   exit bits at lines ~839–970 and ~1688) and the whole fsck unit surface.

### Gate

```
npx vitest run test/unit/application/commands/internal/fsck/content-validation.test.ts test/unit/application/commands/fsck.test.ts test/unit/domain/fsck/validate-object.test.ts test/integration/fsck-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/internal/fsck/content-validation.ts test/unit/application/commands/internal/fsck/content-validation.test.ts test/integration/fsck-interop.test.ts
```
Then `npm run check:spelling`.

### Commit

`fix: report tree structure faults for packed objects`

---

## Phase-boundary gate (after Part 7)

```
npm run validate
```

Known traps for this change:

- **`check:size`** — a green run can be spoofed by stale hashed chunks in the wireit cache.
  If it fails, `rm -rf dist .wireit && npm run build` before believing the number.
- **`reports/api.json`** — must be **unchanged**. If `check:doc-typedoc` (prepush, not
  validate) flags it, a new symbol leaked into `src/domain/objects/index.ts`,
  `src/domain/diff/index.ts` or `src/application/primitives/index.ts`. Remove the barrel
  export rather than regenerating the report.
- **`check:spelling`** — run it fresh at the end; wireit caches it early and later-phase
  comment edits can slip past.
- **Integration broken-pipe flake** — `filter-clean-smudge-interop.test.ts` can report all
  tests passing yet exit 1 with a serialized broken-pipe error from spawned git. Not a real
  failure: re-run `npm run test:integration` to clear it and cache it green.

**Bench is NOT part of any implementation part.** The session runs
`test/bench/diff-recursive.bench.ts` before (`main`) / after (branch), absolute wall-clock,
two runs each, at review/propose time, and records the numbers in the PR body; the nightly
`bench.yml` artifact is the published authority (local runs are session-load biased).
Non-regression watch on the tree-heavy benches `flattenTree` now serves —
`blame.bench.ts`, `merge.bench.ts`, `pack-read.bench.ts`, `show.bench.ts` — plus
`diff.bench.ts` for the untouched non-recursive path.
