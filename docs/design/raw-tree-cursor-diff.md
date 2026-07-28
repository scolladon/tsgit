# Design — raw byte-cursor tree diff

> Brief: eliminate the **tree-entry representation tax** in the recursive diff and
> in `flattenTree`. A validated spike (prototype output verified change-for-change
> identical to the current implementation at 16k-file scale) measured the warm
> 16k-file recursive diff spending **~19 ms of its ~31 ms** in entry
> representation: eager `bytesToHex` per parsed entry (19.3 % self-time), eager
> name decode at parse plus a name **re-encode** in `entriesOf` to build merge-join
> sort keys (~19 % combined), a redundant re-sort of entries already in canonical
> on-disk order, a `Set<string>` duplicate check per tree, and the resulting GC
> (10.6 %). ~29k of ~32k entries are TREESAME and never need a string. A raw
> byte-cursor merge-join measured **4.9× faster** on the walk phase (3.7× with full
> current validation kept), projecting the warm diff to ~16–18 ms against native
> git's ~15 ms.
> Status: designed & self-reviewed to convergence; **decisions open** — DC-1 is a
> user decision (it moves the refusal-condition surface), DC-2…DC-7 carry
> recommendations.

## Context

### Subsystems this touches

| Part | File / symbol | Tier |
|------|---------------|------|
| P1 | `src/application/primitives/object-resolver.ts` → `resolveObject` (split into a bytes core + parse tail); `src/application/primitives/read-object.ts` → `readObject`, **new** `readRawObject`; `src/domain/objects/git-object.ts` → `parseObject` (shared header split) | primitive + domain |
| P2 | **new** `src/domain/objects/tree-cursor.ts` → `TreeCursor`, `openTreeCursor`, `advanceCursor`, `compareCursorNames`, `cursorsSame`, `cursorName`/`cursorOid`/`cursorMode`; `src/domain/objects/file-mode.ts` → **new** byte-level mode matcher | domain |
| P3 | **new** `src/domain/diff/raw-tree-diff.ts` → `diffRawTrees`; `src/domain/diff/tree-diff.ts` → unchanged (still serves the non-recursive path) | domain |
| P4 | `src/application/primitives/diff-trees.ts` → `diffRecursive`, `diffRecursiveLevel`, `diffChangedSubtree`, `expandAddedSubtree`, `expandDeletedSubtree`, `resolveInput` | primitive |
| P5 | `src/application/primitives/flatten-tree.ts` → `flattenTree` (reimplemented over the cursor); `src/application/primitives/walk-tree.ts` → unchanged | primitive |

Everything here is a **read path**. Browser and memory adapters inherit the win
through the shared `Context`/port surfaces — no per-adapter fork. The load-bearing
shared state is unchanged: `Context.deltaCache` (the 16 MiB `LruCache<Uint8Array>`
of loose-format bytes, which the raw read consults through the *same*
`resolveObject` core) and the per-`Context` `PackRegistry`. There is **no
parsed-object cache** anywhere, so exposing the pre-parse product cannot desync a
cache with the parsed one.

### Prior decisions that constrain this design

- **ADR-226 — git-faithfulness prime directive.** Refusal conditions are part of
  the observable surface. DC-1 below is precisely a refusal-surface question, so it
  needs an ADR either way; §"Empirically pinned matrices" is the evidence base.
- **ADR-514 — `diffTrees`-local byte comparison, not a global oid representation
  change.** This design is the *completion* of ADR-514's Option 1: 514 moved the
  comparison to bytes but left `parseTreeContent` materialising every entry
  upstream of it. The end-to-end `Uint8Array` `ObjectId` remains **foreclosed**;
  `ObjectId` stays a branded hex string and `ObjectId.fromRaw`'s trusted path stays
  the only hex-conversion route.
- **ADR-515 — `flattenTree` is the bulk traversal path.** P5 optimises exactly the
  path 515 blessed; `walkTree` keeps its per-entry streaming shape untouched.
- **ADR-243 / `design/diff-recursive-tree-diff.md`.** `recursive` is a public
  `DiffOptions` flag; `format: 'patch'` always recurses. P4 optimises that path's
  hot loop and must not reshape it.
- **ADR-249 — structured data, not cosmetics.** The raw walk emits the same
  `DiffChange` shapes as today. No new option, no rendered string, no API reshape.
- **ADR-505 / `docs/perf/hot-paths.json`.** `pack-read` and `blame` are registered
  hot operations that both traverse trees; P5 lifts them alongside the diff.

### Current code shape (the tax being removed)

Per level, today's recursive diff runs **three** full passes over every entry, plus
a fourth allocation wave:

```ts
// domain/objects/tree.ts — parseTreeContent, once per tree, per entry:
const modeStr = decode(content.subarray(offset, spaceIndex));   // string alloc
const name    = decode(content.subarray(spaceIndex + 1, nullIndex)); // string alloc
if (name === '' || name === '.' || name === '..' || name.includes('/')) throw …
const entryId = ObjectIdFactory.fromRaw(rawHash);               // bytesToHex — 40-char string
const mode    = normalizeFileMode(modeStr);                     // Map + Set lookup
if (names.has(name)) throw …; names.add(name);                  // Set<string> per tree
entries.push({ mode, name, id: entryId });                      // object alloc

// domain/diff/tree-diff.ts — entriesOf, per entry, again:
const nameBytes = encode(entry.name);        // RE-ENCODE the name we just decoded
… withSlash = new Uint8Array(len + 1)        // second alloc for directories
decorated.sort(…)                            // re-sort of already-canonical data
```

For a 16k-file megarepo that is ~32k `TreeEntry` objects, ~32k 40-char hex strings,
~64k name strings/byte arrays and one `Set<string>` per tree — of which **~29k
entries are TREESAME** and are discarded without ever being read. The emitted
change list needs strings for ~3k entries; the other ~29k pay for nothing.

`flattenTree` pays the same parse tax plus `walkTree`'s async-generator machinery
(one promise per entry) and one intermediate `Tree` per directory level.

## Empirically pinned matrices (git 2.55.0, macOS)

Probed in a `mktemp -d` throwaway repo — isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`,
all `GIT_*` scrubbed, signing off. Malformed trees were written with
`git hash-object -t tree -w --stdin --literally`. **Never** in the worktree.

Blobs: `B1 = 5626abf0…` (`one\n`), `B2 = f719efd4…` (`two\n`). Canonical reference
tree `T_OK = 6640fb01…` = `a.txt→B1, b.txt→B2`. Empty tree `E = 4b825dc6…`.

### Pin A — `decode_tree_entry` structural refusals (hard `fatal`, exit 128)

These fire in **every** tree-reading command, `diff-tree` included. They are the
whole of git's per-entry validation.

| Malformed tree content | `git ls-tree` / `git diff-tree -r` stderr | exit |
|---|---|---|
| `100644 \0<20 bytes>` (empty name) | `fatal: empty filename in tree entry` | 128 |
| `100644 a.txt\0<10 bytes>` (truncated hash) | `fatal: too-short tree object` | 128 |
| `100644 a.txt\0<20 bytes>xx` (trailing junk) | `fatal: too-short tree object` | 128 |
| `100644a.txt\0<20>` (no space after mode) | `fatal: malformed mode in tree entry` | 128 |
| `100648 a.txt\0<20>` (non-octal mode digit) | `fatal: malformed mode in tree entry` | 128 |
| `` ` 100644 a.txt\0<20>` `` (leading space ⇒ empty mode) | `fatal: malformed mode in tree entry` | 128 |

### Pin B — what `git diff-tree` does **not** refuse (fsck-only)

Every one of these is accepted, walked **in on-disk order**, and reported. `git
fsck --strict` is where they are caught.

| Malformed tree | `git ls-tree` | `git diff-tree -r <ref> <malformed>` | `git fsck --strict` |
|---|---|---|---|
| unsorted (`b.txt` then `a.txt`) | both, on-disk order, exit 0 | vs `T_OK`: `D a.txt` **then** `A a.txt` — same oid on both sides, exit 0 | `treeNotSorted: not properly sorted` |
| duplicate name (`a.txt`→B1, `a.txt`→B2) | both, exit 0 | vs `T_OK`: `A a.txt`(B2) + `D b.txt`, exit 0 | `duplicateEntries: contains duplicate file entries` |
| name `a/b` | `a/b`, exit 0 | vs `E`: `A a/b`, exit 0 | `fullPathname: contains full pathnames` |
| name `.` | `.`, exit 0 | vs `E`: `A .`, exit 0 | `hasDot: contains '.'` |
| name `..` | `..`, exit 0 | vs `E`: `A ..`, exit 0 | `hasDotdot: contains '..'` |

The unsorted row is the load-bearing one. Git's merge-join **never re-sorts**; it
streams both sides in on-disk order, so an out-of-order pair produces a
delete/add of the *same* path with the *same* oid. Non-recursive `git diff-tree`
(no `-r`) produces byte-identical output — git has one walker for both.

**tsgit today emits nothing at all for that pair** (`entriesOf` re-sorts, so the
two trees are set-equal). Today's behaviour is a divergence in the *opposite*
direction from a refusal. There is therefore **no "change nothing" option** in
DC-1: any raw walk changes observable behaviour on fsck-invalid trees.

### Pin C — mode canonicalisation (`canon_mode`), diff-tree verdicts

| Old tree mode | New tree mode | `git diff-tree -r` | Meaning |
|---|---|---|---|
| `40000 d` | `040000 d` | *(empty, exit 0)* | leading zero is not a change |
| `40000 d` | `40644 d` | *(empty, exit 0)* | any `S_ISDIR` mode canonicalises to `40000` |
| `100644 a.txt` | `100664 a.txt` | *(empty, exit 0)* | `ce_permissions`: no exec bit ⇒ `100644` |
| `100644 a.txt` | `0100644 a.txt` | *(empty, exit 0)* | leading zero is not a change |
| `100644 a.txt` | `100777 a.txt` | `:100644 100755 … M a.txt` | exec bit set ⇒ `100755` |

`git ls-tree` renders `040000`/`40644` both as `040000 tree`, and `100664` as
`100644 blob` — canonicalisation happens at decode, not at render.

**Pre-existing tsgit divergence (unchanged by this design, in scope for neither
option):** `normalizeFileMode` maps only `040000 → 40000` and *rejects* every mode
outside the five-value `FILE_MODE` set, so `100664`, `0100644` and `40644` throw
`INVALID_FILE_MODE` where git silently canonicalises. This design does not widen
that (see DC-2) and does not narrow it.

### Pin D — the virtual trailing slash, from real git

`git write-tree` over a worktree containing `d/f`, `d.txt`, `d-dash`, `d0`:

```
100644 blob …	d-dash     0x2d
100644 blob …	d.txt      0x2e
040000 tree …	d          0x2f  ← sorts as "d/"
100644 blob …	d0         0x30
```

The directory `d` sits between `d.txt` and `d0` — exactly where `d/` sorts. This is
the empirical ground for `compareCursorNames`' virtual `/`.

## Requirements

1. **Byte-identical change lists on well-formed input.** For every tree pair in the
   bench fixtures and for arbitrary **canonical** trees (sorted, unique names, the
   five accepted modes), the raw walk emits the *same* `DiffChange[]`, in the *same*
   order, as the current implementation. On **fsck-invalid** trees behaviour changes
   by construction — that is the whole of DC-1, and Pin B shows today's behaviour is
   already divergent there. This requirement deliberately does not extend to them.
2. **No public API reshape.** `DiffChange`, `TreeDiff`, `DiffOptions`, `FlatTree`
   are untouched (ADR-249).
3. **Zero string allocation for TREESAME entries.** No `bytesToHex`, no
   `TextDecoder`, no `Set<string>`, no `TreeEntry` object on the unchanged path.
4. **Zero per-entry allocation in the merge-join.** Two cursors per level, advanced
   in place.
5. **Guards preserved.** `treeCycleDetected`, `treeDepthExceeded`
   (`MAX_DIFF_RECURSION_DEPTH = 1024`), `treeEntryLimitExceeded`
   (`MAX_FLAT_TREE_ENTRIES = 1_000_000`), `unexpectedObjectType`, and abort-signal
   checks fire on exactly the same inputs, at the same counts, as today.
6. **SHA-256 clean.** The oid slice width comes from `HashConfig.digestLength`
   (20 or 32), never a literal.
7. **The flatten path keeps name validation.** `flattenTree` feeds worktree
   materialisation (`apply-merge-to-worktree`, `repo.primitives.flattenTree`), so
   `''`/`.`/`..`/embedded-`/` names stay refused there regardless of what DC-1
   settles for the diff walk (§P5, §DC-6).
8. **Refusal surface pinned.** Whatever DC-1 settles, each accepted-vs-refused row
   of Pins A/B becomes a corrupt-tree interop case against real `git`.
9. **Measured, not asserted.** `test/bench/diff-recursive.bench.ts` before(`main`)
   / after(branch) absolute wall-clock in the PR body; the nightly `bench.yml`
   artifact is the published authority.

## Design

### P1 — `readRawObject`: expose the pre-parse product

`resolveObject` already produces `(type, content)` before its final `parseObject`.
Split it, do not duplicate it:

```ts
// object-resolver.ts
export async function resolveObjectBytes(ctx, registry, id, verifyHash, maxBytes): Promise<Uint8Array>
// ↑ today's resolveObject body verbatim, minus the trailing parseObject.
//   Empty-tree virtual object, deltaCache hit, loose-first, pack chain,
//   every cap and every checkAborted stay exactly where they are.

export async function resolveObject(ctx, registry, id, verifyHash, maxBytes): Promise<GitObject> {
  return parseObject(id, await resolveObjectBytes(...), ctx.hashConfig);
}
```

The empty-tree special case returns `EMPTY_TREE_BYTES` (`tree 0\0`) instead of a
parsed empty tree — the raw path then sees a zero-length content and yields an
empty cursor, which is the correct TREESAME-friendly shape.

`git-object.ts` gains a shared header split so the two paths cannot drift:

```ts
export function splitObject(rawBytes: Uint8Array): { type: ObjectType; content: Uint8Array }
// parseHeader + the `content.length !== size` → invalidObjectHeader check,
// extracted from parseObject; parseObject now calls it and switches on type.
```

`read-object.ts` gains `readRawObject` next to `readObject`, sharing the
promisor lazy-fetch retry (extracted into one wrapper so a partial clone behaves
identically on both):

```ts
// types.ts — alongside the other primitive result shapes
export interface RawObject { readonly type: ObjectType; readonly content: Uint8Array }
// read-object.ts
export function readRawObject(ctx, id, options?: ReadObjectOptions): Promise<RawObject>
```

`ReadObjectOptions` is reused unchanged (`verifyHash`, `maxBytes`), so the two
reads are option-compatible and a future caller cannot get a weaker cap by picking
the raw one.

A `readRawTree(ctx, id): Promise<Uint8Array>` helper in `diff-trees.ts` layers the
strict check on top (`type !== 'tree'` → `unexpectedObjectType('tree', type, id)`)
and returns the content, mirroring today's `readTreeStrict` **exactly** — including
which callers throw and which do not (§P4/P5). `readRawObject`'s visibility is DC-4
(recommendation: internal — no barrel export, no facade binding, therefore no
`api.json`/doc-coverage/browser-scenario/README churn).

### P2 — the raw tree cursor (`domain/objects/tree-cursor.ts`)

One mutable struct per side, advanced in place. Nothing allocates per entry.

```ts
interface TreeCursor {
  readonly buf: Uint8Array;
  readonly digestLength: number;        // from HashConfig — 20 or 32, never a literal
  offset: number;      // start of the current entry
  modeStart: number; modeEnd: number;   // [start, end) — end is the space
  nameStart: number; nameEnd: number;   // [start, end) — end is the NUL
  oidStart: number;                     // oid occupies [oidStart, oidStart + digestLength)
  isDir: boolean;
  done: boolean;
}

openTreeCursor(buf: Uint8Array, hash: HashConfig): TreeCursor   // mirrors parseTreeContent's arg shape
```

A zero-length `buf` (the empty tree, virtual or stored) opens a cursor with
`done: true` — the merge-join then treats it exactly like an absent side, which is
what `parseTreeContent` produces today (`{ entries: [] }`).

**Mutability is the point and is deliberately scoped.** The house rule is
immutable-by-default; this struct is the documented exception, justified by
requirement 4 and precedented in-tree by `walk-tree.ts`'s `interface Counter {
value: number }` and the commit priority-queue heap (ADR-465–467). The struct is
module-private in effect: it never escapes `diffRawTrees`/`flattenTree`, and every
value that *does* escape (`DiffChange`, `FlatTreeEntry`) is a fresh immutable
object literal built by an emit helper. No caller can observe a mutated cursor.

**Scanning one entry** (`advanceCursor`) — the structural checks are Pin A, and
they are the *only* checks that always run:

1. `modeEnd = indexOf(buf, 0x20, offset)`; `-1` → `invalidTreeEntry(offset,
   'missing space after mode')`.
2. `modeEnd === offset` (empty mode) or any byte outside `0x30..0x37` →
   `invalidTreeEntry(offset, 'malformed mode')`. *(git: `get_mode`.)*
3. `nameEnd = indexOf(buf, 0x00, modeEnd + 1)`; `-1` → `invalidTreeEntry(offset,
   'missing null after name')`.
4. `nameEnd === modeEnd + 1` (empty name) → `invalidTreeEntry(offset, 'empty
   filename')`. *(git: `!*path`.)*
5. `oidStart = nameEnd + 1`; `oidStart + digestLength > buf.length` →
   `invalidTreeEntry(offset, 'truncated hash')`. *(git: `too-short tree object`.)*
6. `isDir` — git's `S_ISDIR` **without decoding the mode**, read off the right-hand
   end of the mode field so no leading-zero strip is needed. With
   `L = modeEnd - modeStart`:

   ```
   isDir ⟺ L >= 5
        && buf[modeEnd - 5] === 0x34                        // octal digit at 8^4 is exactly 4
        && (L === 5 || (buf[modeEnd - 6] - 0x30) % 2 === 0) // octal digit at 8^5 is even
   ```

   `S_ISDIR(mode)` is `(mode & 0o170000) === 0o40000`. The mask covers exactly two
   octal digit positions — `8^4` masked with `7` (so that digit must equal `4`) and
   `8^5` masked with `1` (so that digit must be even); every higher digit is masked
   away entirely, which is why arbitrarily long modes need no special case. Check:
   `40000`→dir, `040000`→dir, `40644`→dir (Pin C row 2), `1040000`→dir,
   `100644`/`100755`/`120000`/`160000`/`0100644`→not dir, `140000`→not dir
   (`0o140000 & 0o170000 = 0o140000`). Three comparisons, exact parity at every
   mode length — no residual divergence to document.
   For the five modes tsgit accepts this degenerates to "five digits starting with
   `4`".
7. `offset = oidStart + digestLength`, `done` when `offset >= buf.length`.

The merge-join **drains both sides completely** (the two tail loops after the
paired loop), so every entry of both trees is advanced over on every diff. The
structural checks above are therefore exhaustive, never entry-dependent — only the
*emission-time* checks (mode matching, and under DC-1 Option B nothing else)
can be skipped for a TREESAME entry.

**`compareCursorNames(a, b)`** — a `compareBytes` over the *virtual* names
`name + (isDir ? '/' : '')`, read straight off both buffers with no key array:

```
la = a.nameEnd - a.nameStart ; ea = la + (a.isDir ? 1 : 0)   // effective lengths
byteAt(c, i) = i < len ? c.buf[c.nameStart + i] : 0x2f       // i === len ⇒ virtual '/'
for i in 0 .. min(ea, eb) - 1: if byteAt differs → return the difference
return ea - eb
```

This is provably `compareBytes(entryKey(a), entryKey(b))` for every input,
including the pathological embedded-`/` case, because it *is* `compareBytes` over
the same virtual sequences — the only difference is that the sequences are never
materialised. Pin D is its empirical anchor, and the property test (§Tests) uses
the existing, independently-tested `treeEntryCompare` as a differential oracle.

**`cursorsSame(a, b)`** — TREESAME test, no allocation:

- oid: `digestLength` byte comparison over `[oidStart, oidStart + digestLength)`.
  Loop-exit-first ordering: compare the oid *before* the mode, since a changed
  file almost always changes its oid.
- mode: leading-`0x30`-stripped byte-range equality (DC-2). On every mode tsgit
  accepts this is exactly `normalizeFileMode(a) === normalizeFileMode(b)` — the
  only zero-prefixed valid form is `040000`, whose stripped form is `40000`.

**Emit helpers** — the only place strings appear:

- `cursorName(c)` → `decode(buf.subarray(nameStart, nameEnd))`
- `cursorOid(c)` → `ObjectId.fromRaw(buf.subarray(oidStart, oidStart + digestLength))`
  (ADR-514's trusted no-regex path)
- `cursorMode(c)` → a **byte-level mode matcher** in `file-mode.ts`:
  a length + byte switch over the five `FILE_MODE` values plus `040000`, returning
  the interned constant with zero allocation; an unrecognised mode decodes *only on
  the error path* and throws `invalidFileMode(modeStr)` — the same error, from the
  same input set, as `normalizeFileMode` today. Under DC-1 Option A the matcher
  runs only at emission; under Option B it also runs per entry inside
  `advanceCursor` (that is the one Option-B check that is not free).

### P3 — the raw merge-join (`domain/diff/raw-tree-diff.ts`)

```ts
export function diffRawTrees(
  oldContent: Uint8Array | undefined,
  newContent: Uint8Array | undefined,
  hash: HashConfig,
): TreeDiff
```

Structurally identical to `domain/diff/tree-diff.ts`'s loop, with cursors in place
of `KeyedEntry[]` and `compareCursorNames`/`cursorsSame` in place of
`compareBytes(key)`/`id === && mode ===`. It emits the *same* `DiffChange`
variants through the *same* classification: `cmp < 0` → delete, `cmp > 0` → add,
equal → `undefined` when `cursorsSame`, else `type-change` when
`!isSameKind(oldMode, newMode)`, else `modify`. `classifySamePath`'s kind logic is
reused (both modes are already materialised at that point, since a differing entry
is emitted anyway).

`domain/diff/tree-diff.ts` is **not** modified: it still serves the non-recursive
`diffTrees`, `merge`, `stash`, `range-diff`'s per-level classification, and every
other `Tree` consumer. Its existing tests — including
`tree-diff.test.ts:256` ("entriesOf re-sorts, never trusts input array order") and
`:277` ("each entry name is encoded exactly once") — remain valid guards for that
path.

### P4 — recursive descent (`application/primitives/diff-trees.ts`)

`diffRecursiveLevel` changes its two tree parameters from `Tree | undefined` to
`Uint8Array | undefined` and swaps its one call. Nothing else moves:

```ts
- const levelChanges = domainDiffTrees(a, b).changes;
+ const levelChanges = diffRawTrees(aContent, bContent, ctx.hashConfig).changes;
```

`expandLevelChange` and `withPrefix` are untouched — they consume `DiffChange`,
which is unchanged. Consequently the three descent routes keep their exact current
semantics:

- **dir/dir modify** → `diffChangedSubtree`: depth guard, then the two
  `oldStack`/`newStack` cycle guards, then `readRawTree` on both child oids
  concurrently (the oids were hex-converted at emission because they are the read keys —
  no extra work), then recurse. `MAX_DIFF_RECURSION_DEPTH` and the per-side stacks
  are byte-identical, and `readRawTree` **throws** `unexpectedObjectType` on a
  non-tree exactly as `readTreeStrict` does today.
- **dir add / dir delete** → `expandAddedSubtree` / `expandDeletedSubtree`, which
  call `walkRawSubtree` (`internal/walk-raw-subtree.ts`) — a dedicated per-entry raw
  walker, not `flattenTree`: a whole-subtree add/delete must surface once per ENTRY,
  duplicates included (matching `git diff-tree -r`), and `flattenTree`'s
  de-duplicating `Map` is the wrong structure for that. `walkTree`'s semantics —
  which **silently skip** a directory-mode entry whose oid resolves to a non-tree,
  rather than throwing — are preserved on this route, same as `diffChangedSubtree`
  and `flattenTree` deliberately disagree on today; this design keeps that
  disagreement, it does not unify them.
- **leaf** → `withPrefix`, unchanged.

`diffRecursive` stays a module-level export from `diff-trees.ts` — not added to the
primitives barrel or facade-bound — purely for test-reachability: the entry-cap tests
call it directly with a small injected `maxEntries`. The same shape `flattenRawTree`'s
injectable `FlattenBounds` parameter already establishes for `internal/flatten-raw.ts`.

`diffRecursive`'s roots need bytes. `resolveInput` gains a raw sibling used only by
the recursive branch:

```ts
resolveRawInput(ctx, input: DiffTreesInput): Promise<Uint8Array | undefined>
//  undefined  → undefined
//  ObjectId   → readRawTree(ctx, id)
//  Tree       → readRawTree(ctx, input.id)   ← DC-5
```

The non-recursive branch keeps `resolveInput` verbatim. `buildPreimage`
(`copies: 'harder'`) takes the oid/`Tree` and calls `flattenRawTree` directly
(both accept an oid or a `Tree`) rather than the public `flattenTree` facade —
when `a` is a string, `peelToTree` has already read the terminal tree's raw
bytes as its last peel hop, and those are threaded straight into
`flattenRawTree` as its optional `preread` parameter, so the terminal tree is
read once, not twice.

### P5 — raw `flattenTree`

`flattenTree` is **reimplemented** over the cursor rather than duplicated (DC-6):
one implementation, one behaviour, and every consumer (`merge`, `rm`,
`apply-merge-to-worktree`, `buildPreimage` (via `flattenRawTree` directly, §P4),
`repo.primitives.flattenTree`) inherits the win. `expand*Subtree` is NOT a
`flattenTree` consumer — it walks the raw bytes itself via `walkRawSubtree`
(§P4), the per-entry twin of this section's descent.

```ts
export const flattenTree = async (ctx, treeIdOrObject: ObjectId | Tree): Promise<FlatTree> => {
  const entries = new Map<FilePath, FlatTreeEntry>();
  await descend(ctx, rootContentOf(treeIdOrObject), '', 0, [rootId], { value: 0 }, entries);
  return { entries };
};
```

Per level: open a cursor over the tree bytes; for each entry, increment the shared
counter (**including directories**, matching `walkTree` so
`treeEntryLimitExceeded` fires at the same entry index), check the abort signal,
then either recurse (directory) or `entries.set(joinPath(prefix, cursorName(c)),
{ id: cursorOid(c), mode: cursorMode(c) })`. The bounds are `walkTree`'s current
no-options defaults, now inlined: `recursive: true`, `maxDepth: 1024`,
`maxEntries: MAX_FLAT_TREE_ENTRIES` — `flattenTree` never passed `WalkTreeOptions`,
so no configurability is lost.

Guard ordering matches `walkInternal` exactly, because the counts are asserted:
the cycle check (`stack.includes(treeId)`) and the depth check fire **on entry to a
level, before iterating it**, against the level's own oid — which is the root oid
at the top and `cursorOid(c)` of the directory entry below, so a directory entry
converts its oid to hex on descent (it is the read key anyway). The entry counter
increments **before** the emit/recurse branch, so the limit trips at the same entry
index as today.

What drops out: the intermediate `Tree` per level, the `TreeEntry` per entry, the
`Set<string>` dup check, `walkTree`'s async generator (one promise per entry) and
its `yield`-then-`readObject` interleave. What stays: the per-branch cycle stack
(`treeCycleDetected`), `maxDepth` (`treeDepthExceeded`, 1024), the entry counter
(`treeEntryLimitExceeded`), the abort check, the directory-skip filter (only
`FILE_MODE.DIRECTORY` entries are omitted from the map — gitlinks and symlinks are
kept), and DFS pre-order insertion order into the `Map`. `expand*Subtree` does
**not** consume this `Map` — it walks the raw bytes directly via its own
per-entry walker, `walkRawSubtree`, which preserves duplicate-name entries
`flattenTree`'s last-name-wins `Map` would collapse (§P4).

**`flattenTree` keeps full name validation** (requirement 7) regardless of DC-1: it
feeds worktree materialisation, so `''`/`.`/`..`/embedded `/` stay refused there.
The cost is nil — every non-directory entry is emitted anyway, so its name is
decoded regardless; validation is one scan of an already-materialised string.
`walkTree` itself is untouched (ADR-515).

### Layering

```
diff / show / patch-id / rebase / blame / range-diff        (commands)
        │ recursive: true
        ▼
diff-trees primitive ── readRawTree ─┐        flatten-tree primitive
   diffRecursiveLevel                │             │  (bulk path, ADR-515)
        │                            ▼             ▼
        │                    read-object: readRawObject / readObject
        │                            │
        │                            ▼  object-resolver: resolveObjectBytes
        ▼
domain/diff/raw-tree-diff: diffRawTrees   ──uses──▶  domain/objects/tree-cursor
domain/diff/tree-diff: diffTrees (parsed) ──serves──▶ non-recursive diff, merge, stash

flatten-tree ──────────────────────────────uses──▶  domain/objects/tree-cursor
```

The dependency rule holds: the cursor and the raw merge-join are pure domain (zero
outward deps, no `Context`); all I/O and recursion stay in the primitive tier.

## Decision candidates

**DC-1 — validation surface of the raw merge-join (USER DECISION; ADR required
either way).** Pin B proves there is no zero-change option: today's re-sort already
diverges from git.

- **Option A — git parity (4.9× measured).** Structural checks only (Pin A: missing
  space, malformed/empty mode, empty name, truncated hash). Trust canonical sort
  order; no duplicate check, no name validation (`.`/`..`/`/`), no order check
  during the diff. Structural-integrity checks belong to `fsck`, which is where git
  puts them. Consequence: on an fsck-invalid tree tsgit's `diff` starts producing
  git's exact output (Pin B's `D a.txt` + `A a.txt`) instead of silently nothing;
  a mode outside the five-value set is refused only when the entry is *emitted*,
  making mode refusal entry-dependent. **No named inconsistency between the two
  diff traversal routes:** an *added*/*deleted* subtree is expanded via
  `walkRawSubtree` (`internal/walk-raw-subtree.ts`), a dedicated per-entry raw
  walker that deliberately does NOT validate names either — so a `..` entry
  inside an added subtree is exactly as unvalidated as the same entry inside a
  *modified* subtree's merge-join. Requirement 7's name validation still holds,
  but only for `flattenTree`'s OTHER callers (`merge`, `rm`,
  `apply-merge-to-worktree`, `buildPreimage`'s `copies:'harder'` preimage,
  `repo.primitives.flattenTree`) — the ones that feed worktree materialisation,
  not the diff's own traversal. Neither diff route is filesystem-blind, though:
  `diffTrees({ withStat: true })` and `{ ignoreWhitespace }` resolve `.gitattributes`
  sources per changed path (`diff`/whitespace attributes), so an unvalidated name
  still reaches the filesystem indirectly. The real containment is two independent
  gates — attribute-provider path containment (the directory-chain resolver treats
  any path that lexically escapes the worktree as carrying no attribute sources,
  never issuing the filesystem call) and the adapter's own containment check as a
  second, defence-in-depth gate — not an asymmetry between the two traversal paths.
- **Option B — keep tsgit's stricter checks (3.7× measured).** Structural, plus
  name validation (`''`/`.`/`..`/embedded `/`), plus mode-set matching, plus a
  strictly-ascending `compareCursorNames` check between consecutive entries (which
  subsumes duplicate detection on sorted trees, replacing the `Set<string>`).
  Consequence: trees git happily diffs are hard-refused, and the *ascending* check
  is a new refusal tsgit has never had — a repo whose trees were written unsorted
  by a third-party tool goes from "diffs, silently re-sorted" to "cannot be
  diffed". Every check is byte-level here (no decode, no `Set`), so the gap to 4.9×
  is smaller than the spike's prototype measured; the bench re-measures either way.

**Recommendation: Option A, with the five missing `fsck` checks landed in the same
PR.** The prime directive makes refusal conditions observable behaviour to match,
and Pin B shows git's tree-diff refuses none of these — git puts them in `fsck`.
Option A is the only choice that makes the recursive diff *more* faithful rather
than differently unfaithful, and it is the faster one. The defence-in-depth
argument for B is answered by requirement 7: the path that can actually reach the
filesystem (`flattenTree`) validates under both options, and the node adapter's
containment gate is an independent second gate.

**Deliberate over-block:** both lexical gates canonicalise a segment the way
Win32 does before comparing it to `..` (trailing dots/spaces stripped, drive
prefixes treated as absolute), because the platform behind a caller-supplied
`FileSystem` is unknown. On POSIX this fail-closed choice refuses legal names
like a directory literally called `...` (the wrapped-fs guard) or skips a
`.gitattributes` under one (the attribute resolver) where real git would
proceed — accepted: the guards protect unknown adapters, the built-in Node
adapter's realpath containment is unaffected, and failing closed beats a
Windows traversal.

**The rider is not optional, and it is verified, not assumed.** tsgit's `fsck`
(`src/application/commands/internal/fsck/content-validation.ts`) implements **none**
of git's five tree-structure checks — no `treeNotSorted`, `duplicateEntries`,
`hasDot`, `hasDotdot` or `fullPathname`. Today those malformations are caught only
as a side effect of `parseTreeContent` throwing during *any* read (and unsorted
trees are not caught at all). Option A removes that side effect from the recursive
diff, so without the `fsck` work it is a net loss of coverage, not a relocation of
it. Option B needs no rider. That is the real cost comparison:

| | walk speed | refusal surface vs git | in-PR scope |
|---|---|---|---|
| A | 4.9× | matches `diff-tree` exactly | + five `fsck` checks (new, pinned against `git fsck --strict` per Pin B) |
| B | 3.7× | stricter than git on 5 malformations, incl. one brand-new refusal | self-contained |

**DC-2 — mode-equality semantics in `cursorsSame`.**

1. **Leading-zero-stripped byte equality (recommended).** Provably identical to
   `normalizeFileMode(a) === normalizeFileMode(b)` on every mode tsgit accepts
   (`040000` is the only zero-prefixed valid form), so the recursive and parsed
   paths agree everywhere they both accept the input. Cost: a leading-`0x30` skip
   on each side plus a byte-range compare — no allocation, no decode.
2. **Full `canon_mode` byte-level equivalence.** Git-faithful for `100664`/`40644`
   (Pin C), but *widens* what the recursive path silently accepts relative to the
   parsed path used by non-recursive diff/merge/status — two answers inside one
   library for the same tree — and quietly fixes half of a divergence whose other
   half (`normalizeFileMode` rejecting those modes) stays. That divergence deserves
   its own change with its own ADR.
3. **Exact byte equality.** *Rejected, not a real candidate:* it reports
   `040000` vs `40000` as a modify — a spurious change git never emits.

**DC-3 — where the cursor lives.**

1. **`src/domain/objects/tree-cursor.ts` (recommended).** It is a parser over the
   tree grammar, which is what `domain/objects/tree.ts` already owns; both
   `domain/diff/raw-tree-diff.ts` and the application-tier `flatten-tree.ts`
   consume it, so any `domain/diff/` home would make the flatten path depend on
   the diff module. Sits next to `parseTreeContent`, its differential oracle.
2. `src/domain/diff/raw-tree-cursor.ts` — co-located with its heaviest consumer;
   creates the flatten → diff coupling above.
3. `src/application/primitives/internal/tree-cursor.ts` — keeps it out of the
   public domain surface, but it is pure logic with zero ports and belongs in the
   domain by the dependency rule; also loses the property test's domain siblings.

**DC-4 — `readRawObject` visibility.**

1. **Internal (recommended).** Exported from `read-object.ts` for in-tree
   consumers, **not** from `application/primitives/index.ts`, **not** bound on
   `repo.primitives`. No `reports/api.json` regeneration, no
   `docs/use/primitives/` page, no browser scenario, no README count bump, no new
   public contract to keep faithful forever. Users needing bytes already have
   `repo.primitives.catFileBatch` (yields `{ type, size, object }` per id) and
   `streamBlob`.
2. Exported from the primitives barrel but not facade-bound — half a commitment;
   `check:doc-coverage` audits facade bindings, so the gate cost is low, but the
   symbol becomes semver surface with no consumer.
3. Fully public (barrel + facade + doc page + browser scenario + README count +
   `api.json`) — six gates for a capability no user has asked for. YAGNI.

**DC-5 — `resolveRawInput` on a caller-supplied `Tree` object.**
`DiffTreesInput = Tree | ObjectId | undefined`, so `repo.primitives.diffTrees` can
be handed a `Tree`.

1. **Read raw by `tree.id` (recommended).** One extra object read, normally served
   from `ctx.deltaCache`. One walk implementation governs every level — no
   root-vs-descent split. Every in-tree recursive caller (`patch-id`, `rebase`,
   `blame`, `range-diff`, `commit-diff`, `diff`) already passes an `ObjectId`, and
   the only `Tree` producers are the parsers, whose `id` is by construction the
   object's own oid. Risk: a hand-forged `Tree` whose `id` is not in the store now
   throws `OBJECT_NOT_FOUND` where it previously worked.
2. `serializeTreeContent(tree, hash)` to synthesise bytes — no extra read and works
   for synthetic trees, but `serializeTreeContent` **re-sorts**, so the root level
   would canonicalise while every descended level does not: exactly the
   inconsistency DC-1 is trying to remove.
3. Keep the root level on the parsed merge-join when the input is a `Tree`, going
   raw from the first descent down — zero behaviour change and negligible perf cost
   (one tree out of thousands), at the price of two merge-join implementations
   reachable in one call.

**DC-6 — raw flatten shape.**

1. **Reimplement `flattenTree` itself (recommended).** One implementation, one
   behaviour; `merge`, `rm`, `apply-merge-to-worktree` and the bound
   `repo.primitives.flattenTree` all inherit the win. Requires requirement 7 (name validation stays)
   — which costs nothing because every emitted entry decodes its name anyway.
2. Add a parallel `flattenTreeRaw` used only by the diff and the Tier-1 facade —
   narrower blast radius, at the cost of two flatteners with two validation
   surfaces and a permanent "which one am I calling?" question.

**DC-7 — how requirement 1 (byte-identical change lists) is proven.**

1. **A permanent differential property test (recommended).** `diffRawTrees(
   serializeTreeContent(a), serializeTreeContent(b), SHA1_CONFIG) ≡ diffTrees(a, b)`
   over arbitrary name-deduplicated trees (ADR-134 lens 2; `serializeTreeContent`
   canonicalises the order, and the `diffTrees` oracle re-sorts, so the two sides
   are comparable by construction — reuse `tree.properties.test.ts`'s existing
   `dedupeByName` helper), plus `compareCursorNames ≡ treeEntryCompare` (lens 1/3).
   Both oracles are existing, independently-tested production code — not a
   re-implementation of the SUT, so not a tautology. Strongest available acceptance
   evidence, and it does not expire.
2. A throwaway scaffold that diffs both implementations over the bench fixtures,
   deleted before merge — proves it once for the fixtures only.
3. Manual one-shot verification recorded in the PR body — weakest; nothing guards
   the next change.

## Test strategy

- **P1 (unit).** `readRawObject` returns the same `(type, content)` that
  `readObject` parses, for loose, packed, delta-chain and `deltaCache`-hit sources;
  the empty-tree virtual object yields `{ type: 'tree', content: <0 bytes> }`; a
  size-mismatched header throws `INVALID_OBJECT_HEADER` from *both* paths (shared
  `splitObject`); `maxBytes` and `verifyHash` behave identically on both (assert
  `.data` code + size/limit via try/catch, not `toThrow(Class)`); a partial-clone
  miss lazy-fetches once and retries once on both.
- **P2 (unit).** `advanceCursor` — one **isolated** test per Pin A refusal (missing
  space, empty mode, non-octal mode byte, missing NUL, empty name, truncated hash),
  each asserting `INVALID_TREE_ENTRY` with the offset and reason in `.data`; the
  guard-clause isolation rule means the malformed-mode cases get separate
  fixtures for "empty" and "non-octal". `isDir` table, exercising all three
  operands of the rule: dir — `40000` (L=5 branch), `040000`, `40644`, `1040000`
  (L>6, even `8^5` digit); not dir — `100644`, `100755`, `120000`, `160000`,
  `0100644` (wrong `8^4` digit), `140000` (right `8^4` digit, **odd** `8^5` digit —
  the case that kills a mutant dropping the parity term).
  `compareCursorNames` reproduces Pin D's `d-dash < d.txt < d/ < d0`.
  `cursorsSame` — isolated cases for oid-differs, mode-differs,
  `40000`-vs-`040000` (same), and equal-both. The byte-level mode matcher
  returns the interned constant for all six accepted forms and throws
  `INVALID_FILE_MODE` carrying the decoded string for an unknown mode.
- **P2/P3 (property — `tree-cursor.properties.test.ts`, `raw-tree-diff.properties.test.ts`).**
  Per DC-7 and ADR-134/136: (lens 1, `numRuns: 200`) cursor-walk over
  `serializeTreeContent(t)` yields the same `(mode, name, oid)` sequence as
  `parseTreeContent`; (lens 1/3, 200) `sign(compareCursorNames(a, b)) ===
  sign(treeEntryCompare(a, b))` for arbitrary entries, including shared-prefix and
  directory/file collisions; (lens 2, 100) `diffRawTrees(ser(a), ser(b)) ≡
  diffTrees(a, b)` for arbitrary canonical trees; (lens 3, 100) the cursor is total
  over the safe subset (well-formed entries, ASCII no-NUL no-`/` names) — never
  throws. Generators extend `test/unit/domain/objects/arbitraries.ts`
  (`arbFileModeEnum`, `arbObjectId`) and `test/unit/domain/diff/arbitraries.ts`;
  no seed committed.
- **P3/P4 (unit).** Recursive diff over a nested fixture emits the identical
  `DiffChange[]` as today (order included) for add/modify/delete/type-change,
  nested adds and deletes, and a deep `a/b/c` nest; a TREESAME subtree is never
  read (spy `readRawObject` — asserts requirement 3 structurally); the emitted
  changes still carry hex oids and decoded paths. Guards, each isolated: cycle on
  the old side, cycle on the new side, depth `> 1024`, non-tree child oid →
  `UNEXPECTED_OBJECT_TYPE` (`.data` asserted). SHA-256: the same fixtures under a
  32-byte `HashConfig`.
- **P5 (unit).** `flattenTree` yields the same map (contents *and* insertion order)
  as a `walkTree` drain; directory entries omitted, gitlinks and symlinks kept;
  `treeEntryLimitExceeded` fires at the same entry index as today (directories
  counted); cycle and depth guards fire; a directory-mode entry resolving to a
  non-tree is **skipped, not thrown** (the deliberate `walkTree` asymmetry);
  invalid names still refused (requirement 7).
- **Interop — `test/integration/tree-diff-corrupt-interop.test.ts` (new).**
  One case per Pin A and Pin B row: build the malformed tree with `git hash-object
  -t tree -w --stdin --literally` in the harness's isolated repo, run real `git
  diff-tree -r` via `gitAsync` (scrubbed `GIT_*`, isolated `HOME`, signing off) and
  assert tsgit either reproduces git's change list *from the structured fields*
  (ADR-249: the test reconstructs git's raw line, the library emits none) or
  refuses with the documented code — per whatever DC-1 settles. Pin C's five mode
  rows and Pin D's ordering get cases in the same file. Reuse the shared
  `beforeAll` repo + 60 s timeout convention (heavy git-spawning interop under
  `validate` concurrency).
- **Interop — existing suites are the regression net.** `diff-recursive-interop`,
  `show-interop`, `blame-interop`, `range-diff-interop`, `merge-interop` and the
  patch-id/rebase paths must stay byte-identical; they are the proof that the
  raw walk did not move canonical behaviour.
- **Bench (requirement 9).** `test/bench/diff-recursive.bench.ts` before(`main`) /
  after(branch), absolute wall-clock, two runs each, recorded in the PR body;
  the nightly `bench.yml` artifact is the published authority (local runs are
  session-load biased). Non-regression watch on the existing tree-heavy benches
  that `flattenTree` now serves — `blame.bench.ts`, `merge.bench.ts`,
  `pack-read.bench.ts`, `show.bench.ts` — plus `diff.bench.ts` for the untouched
  non-recursive path.
- **Mutation.** The cursor's index arithmetic is mutation-dense (offset ±1,
  `<` vs `<=`, `-1` sentinels). Every boundary gets an explicit test rather than a
  documented equivalence; the leading-zero strip and the `significantLength === 5
  && byte === 0x34` directory test each get isolated true/false cases so neither
  operand survives alone.

## Out of scope

- **The whitespace-mode per-modify-pair stream setup.** A separate lever; re-profile
  after this lands (its share will move once the walk is 4–5× cheaper).
- **`bytesToHex` micro-optimisation.** The calls are *eliminated* on the TREESAME
  path, not accelerated; the ~3k emitted entries keep the existing `HEX_TABLE` join.
- **The end-to-end `Uint8Array` `ObjectId`.** Foreclosed by ADR-514; reopening it
  needs its own ADR and its own project.
- **`normalizeFileMode`'s `canon_mode` divergence** (Pin C: `100664`, `40644`,
  `0100644` refused where git canonicalises). Pre-existing, untouched here, and
  deliberately *not* half-fixed inside `cursorsSame` (DC-2 option 2). A faithful fix
  must move `normalizeFileMode` itself and re-pin every write surface — its own
  change.
- **`domain/diff/tree-diff.ts` (the parsed merge-join) and its re-sort.** Kept for
  the non-recursive diff, `merge`, `stash` and every other `Tree` consumer, per the
  brief's scope. **Known asymmetry this creates:** on an fsck-invalid unsorted tree,
  `diff({ recursive: true })` (raw) and `diff({ recursive: false })` (parsed) can
  disagree — and Pin B shows real git produces *identical* output for both, so the
  parsed path is the divergent one. Closing it is a three-line change (drop the sort
  in `entriesOf`) with a merge/stash blast radius; flagged here so the decision is
  taken knowingly rather than discovered later.
- **`walkTree`'s per-entry streaming shape.** ADR-515 settled it; `flattenTree` is
  the bulk path and the only one reworked.
