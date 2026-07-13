# Design — blame TREESAME skip + path-scoped tree descent: name an unchanged file without visiting every ancestor, and read one path's tree-entry in O(path-depth) instead of flattening the whole tree

> Brief: two behaviour-preserving, git-faithful perf findings deferred from 26.4
> (backlog **26.4c**), both from the 26.3 hot-path profile. **Finding (2)** —
> `blame` is O(history-depth): a file unchanged since a ~5000-commit-deep root
> takes ~15 min because blame reads and diffs the file's blob at *every* ancestor.
> Reproduce git's **TREESAME** skip: when a parent's tree-entry oid at the path
> equals the suspect's, all lines pass to that parent *without* reading the parent
> blob or diffing, and the loop stops once no lines remain. **Finding (4)** — tree
> walk + parse dominates tree-heavy reads (`blame`: `parseTreeContent 0.24 /
> walkInternal 0.22 / flattenTree 0.09 / walkTree 0.08`; `show`: `walkInternal
> 0.24 / parseTreeContent 0.18`): blame's `blobAtPath` flattens the **entire** tree
> into a Map to read **one** path's blob, O(tree-size), paid O(history-depth ×
> parents) times. Descend only the subtrees along the path — O(path-depth) — and, as
> a bonus, that descent yields the cheap tree-entry oid finding (2) needs. Both are
> **pure perf**: output byte-identical, pinned by the committed profile baseline's
> blame shares dropping + the `blame-interop` goldens staying byte-identical (the
> 26.4a/26.4b pattern — "share drop + byte-identical goldens"). **A path-scoped
> descent ALREADY EXISTS** — `descendTreePath` (`primitives/internal/resolve-tree-path.ts`,
> used by `readFileAt`/`rev-parse`) — so finding (4) is mostly *reuse*, not
> net-new: the only gap is that it **throws** `PATH_NOT_IN_TREE` where blame needs
> **`undefined`**. No git-observable change expected → **no ADR** (surfaced as a
> decision candidate if the gate disagrees on promoting an internal helper).
> Status: draft → self-reviewed ×3 → decision candidates open for the ADR conversation.

## Context

### The two hot frames, decomposed

`blame` (`src/application/commands/blame.ts`) walks history backwards. Its per-ancestor
cost concentrates in one helper, `blobAtPath` (L365–374):

```ts
const blobAtPath = async (ctx, tree, path): Promise<Uint8Array | undefined> => {
  const flat = await flattenTree(ctx, tree);        // (!) flattens the ENTIRE tree
  const entry = flat.entries.get(path);
  if (entry === undefined) return undefined;
  return (await readBlob(ctx, entry.id)).content;
};
```

`flattenTree` (`primitives/flatten-tree.ts`) drives `walkTree`/`walkInternal`
(`primitives/walk-tree.ts`) which recursively `readObject`s **every** subtree and
`parseTreeContent`s (`domain/objects/tree.ts` L31) **every** entry — O(tree-size) —
purely to look up one `path`. That is the `parseTreeContent 0.24 / walkInternal
0.22 / flattenTree 0.09 / walkTree 0.08` self-share on blame.

`blobAtPath` is called O(history-depth × parents) times:

- once per `seed` / `seedWorkingTree` (L162, L227),
- once **per parent per suspect** via `resolveInParent` (L319) inside `processSuspect`
  (L251) inside `walk` (L238) — the ancestry loop.

So the whole-tree flatten is paid on essentially every commit reachable from the
tip, and for an unchanged file the walk runs all the way back to the file's
introduction (finding 2). The `~175 ms/commit-of-depth` figure in the brief is
that flatten + the parent blob read + the `diffLines` at each ancestor.

### The TREESAME redundancy (finding 2)

`processSuspect` (L245–259), for each parent:

```ts
for (const parent of data.parents) {
  const resolved = await resolveInParent(sb.ctx, parent, data.tree, suspect.path);
  if (resolved === undefined) continue;
  previous ??= { commit: parent, path: resolved.sourcePath };
  const { passed, kept } = splitAgainstParent(remaining, diffLines(resolved.blob, suspect.blob));
  schedule(sb, parent, resolved.sourcePath, resolved.date, resolved.blob, passed);
  remaining = kept;
}
finalize(sb, suspect, data, childLines, remaining, previous);
```

`resolveInParent` (L311–325) reads the parent's blob at the path (`blobAtPath` →
whole-tree flatten again) and `diffLines(parentBlob, suspect.blob)`.

**When the parent's tree-entry oid at the path equals the suspect's blob oid, the
two blobs are byte-identical.** `diffLines(identical, identical)` yields one
all-`common` hunk, `splitAgainstParent(remaining, allCommon)` returns
`{ passed: remaining, kept: [] }` — **all lines pass to the parent, nothing is
kept.** The parent-blob read + `diffLines` are pure waste: the answer was already
determined by the oid equality. That is the TREESAME case.

`Suspect` (L99–105) carries `blob` but **not** its oid; `resolveInParent` returns
`{ blob, sourcePath, date }` with no oid. The oid comparison finding (2) needs is
exactly what the finding-(4) path-scoped descent already returns (`{ id, mode }`),
so the two findings compose: descend the path once, compare oids, skip the blob
read + diff on equality.

The `previous` field (L64, set at L253) MUST be preserved on any skip path — it is
part of the pinned porcelain (`previous <oid> <path>`). Rename handling
(`renamedSource` L332, `diffTrees` with `detectRenames`) only fires when the path
is **absent** from the parent (`direct === undefined`, L320) — a same-oid direct
hit never collides with it.

### The path-scoped descent ALREADY EXISTS (finding 4)

`descendTreePath` (`src/application/primitives/internal/resolve-tree-path.ts`)
already descends only the subtrees along a path in O(path-depth), returning the
addressed `TreeEntry` (`{ mode, name, id }`):

```ts
export const descendTreePath = async (ctx, rootTree: Tree, path, rev): Promise<TreeEntry> => {
  const segments = path.split('/');
  const lastIndex = segments.length - 1;
  let current: Tree = rootTree;
  for (let i = 0; i < lastIndex; i += 1) {
    const entry = findEntry(current, segments[i], rev, path);      // throws PATH_NOT_IN_TREE if absent
    const object = await readObject(ctx, entry.id);
    if (object.type !== 'tree') throw pathNotInTree(rev, path);     // throws on non-tree intermediate
    current = object;
  }
  return findEntry(current, segments[lastIndex], rev, path);        // throws PATH_NOT_IN_TREE if absent
};
```

It is `internal/`, consumed by `readFileAt` (`commands/read-file-at.ts` L50) and
`rev-parse` (`commands/rev-parse.ts` L214), and covered by
`test/unit/application/primitives/internal/resolve-tree-path.test.ts`.

**The one gap for blame:** `descendTreePath` **throws `PATH_NOT_IN_TREE`** on a
missing segment, a missing intermediate, or a non-tree intermediate. Blame's
`blobAtPath` must return **`undefined`** in those cases — a parent that lacks the
path is not an error; it drives rename detection (`renamedSource`) and the
boundary/introduction logic. So blame cannot call `descendTreePath` as-is; it needs
an **`undefined`-returning** descent that shares the same O(path-depth) core.

It also takes an already-resolved `Tree`; blame has a tree **oid** (`data.tree`),
so a thin variant that resolves the root oid first (like `walkTree` /
`flattenTree` already accept `ObjectId | Tree`) is the ergonomic shape.

### Where else finding (4) applies (assessed)

`flattenTree` callers besides blame — `merge.ts`, `diff-trees.ts`,
`apply-merge-to-worktree.ts`, `read-head-tree.ts`, `stash.ts`,
`clean-work-tree.ts` — all genuinely consume the **whole** tree (a full flat map
for a 3-way merge, a full recursive projection for the diff, a full staged-change
scan). None is a single-path lookup. **`blame.blobAtPath` is the only whole-tree
flatten used to read one path.** The path-scoped descent is therefore a blame win
specifically; the general tree-walk callers are out of scope (they need the whole
tree by construction).

## Empirical faithfulness pin — git blame TREESAME (git 2.55.0)

Per `.claude/workflow/faithfulness.md`, pinned against **git 2.55.0** in `mktemp -d`
throwaways (scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`,
`commit.gpgsign false`, cleaned up after). NEVER from memory. Each row below is a
recorded run.

| # | Scenario | git blame result (porcelain, oid+summary) | Pins |
|---|----------|-------------------------------------------|------|
| **A** | File `stable.txt` unchanged since a 6-commit-deep root; a sibling file churns each commit | All 3 lines → **root** `405ce0f… (c0 root)`; single `1 1 3` run — the deep root is named directly, ancestors of `stable.txt` between root and tip are never blamed | An unchanged file is named at its *introduction*, not at every ancestor. This is the finding-(2) target: TREESAME must let blame reach the root without reading `stable.txt` at each intermediate commit. |
| **B** | Merge; `f.txt` **TREESAME to the second parent's ancestor line** (MERGE blob = MAIN blob `024e98e…`; SIDE left `f.txt` at BASE blob) | Line 2 → **MAIN** `98865865… (main edits f.txt line2)`, `previous 911c39c… f.txt`; lines 1,3 → **BASE** `911c39c… (base)` `boundary`. **MERGE itself blames nothing.** | When the merge's file blob equals a parent's blob, all lines pass through that parent; the merge is not blamed; `previous` points at that parent's parent. |
| **C** | `-s ours` merge (MERGE tree = MAIN tree exactly, so `f.txt` TREESAME to the **first** parent; SIDE independently edited `f.txt`) | Line 1 → **MAIN** `(main edits line1)`; lines 2,3 → **BASE** `(base)`. **The SIDE edit is invisible; MERGE blames nothing; the SIDE parent is never descended for `f.txt`.** | The TREESAME-to-a-parent rule means git does **not** walk *other* parents for a file once a parent is TREESAME — the whole file passes to the TREESAME parent. This is the decisive pin for the loop short-circuit. |
| **D** | `git blame HEAD -- <directory>` | `fatal: no such path sub in HEAD`, non-zero exit | Blame is file-only; a directory / non-blob leaf is a refusal, not a blame. The path-scoped descent returning `undefined` for a non-blob leaf → `pathNotInTree` in `seed` is faithful. |

### What the matrix proves about the current tsgit code

The current all-parents loop is **already behaviourally correct** for TREESAME
(scenarios B, C): on a TREESAME parent, `diffLines(identical, identical)` →
all-common → `passed = remaining`, `kept = []`; `remaining` becomes `[]`, so every
subsequent parent's `splitAgainstParent([], …)` is a no-op and `finalize` blames
nothing at the merge. **tsgit already produces git's bytes here** — verified by the
existing `blame-interop` clean-merge test staying green. The optimisation is
therefore **pure waste-elimination**, not a behaviour change:

1. **Skip the parent blob read + `diffLines`** when the parent's tree-entry oid at
   the path equals the suspect's blob oid (the blobs are identical ⇒ the diff is
   all-common ⇒ `passed = remaining`, `kept = []` — computed, not diffed).
2. **Short-circuit the parent loop** once `remaining` is empty (scenario C: after
   the TREESAME first parent consumes all lines, the SIDE parent need not be read).
3. **Replace the whole-tree flatten** in `blobAtPath` with the O(path-depth)
   descent (finding 4), which also *supplies* the oid for (1).

All three preserve the exact `{ passed, kept, previous }` the current code
computes — so the porcelain bytes are unchanged.

## Approach

### Finding (4) — path-scoped tree-entry lookup (foundational; do first)

Blame stops flattening the whole tree. Instead a path-scoped descent walks the
`/`-separated path, reading only the subtrees on the way, returning the leaf
**entry** `{ id, mode }` (or `undefined` when any segment is absent / a non-tree
intermediate / a non-blob leaf). This is O(path-depth) reads instead of
O(tree-size), and it hands blame the leaf oid finding (2) consumes.

**Two consumers, two needs.** The descent returns the **entry**, not the bytes,
because the two blame call sites diverge:

- **`blobAtPath` (seed sites — `seed` L227, `seedWorkingTree` L162)** need the blob
  **content** (they `splitLines` it). `blobAtPath` becomes: descend → entry (or
  `undefined`) → `readBlob(entry.id)` for the bytes. Same result as today
  (`flattenTree` + `get` + `readBlob`), one blob read, but O(path-depth) instead of
  O(tree-size) for the lookup. The seed does **not** get the TREESAME skip (it must
  read the file to split its lines — there is no parent to be TREESAME to).
- **`resolveInParent` (the ancestry loop)** needs the entry **oid first** to test
  TREESAME (finding 2), and reads the bytes only on a mismatch. It uses the descent
  entry directly, deferring `readBlob` past the oid compare.

So the descent's entry-returning shape serves both: seed reads unconditionally,
`resolveInParent` reads conditionally.

The shape reuses the **existing** `descendTreePath` core (its
`findEntry` + subtree-descent loop) rather than a net-new algorithm. Two shapes
are on the table (**DC-2** ★ — the load-bearing decision):

- **Option A — refactor `descendTreePath` into a `find`-returning core + a throwing
  wrapper.** Extract the descent into an internal `findTreeEntry(ctx, rootTree,
  path): Promise<TreeEntry | undefined>` that returns `undefined` on
  absent/non-tree-intermediate (no `rev` needed — it carries no refusal). Keep
  `descendTreePath` as a one-line wrapper that maps `undefined → pathNotInTree(rev,
  path)`, preserving `readFileAt`/`rev-parse` byte-for-byte. Blame calls the
  `find`-returning core with the tree **oid** (resolving the root first). One
  algorithm, two entry points — DRY, and `readFileAt`/`rev-parse` keep their exact
  refusal.
- **Option B — a standalone new primitive** (`treeEntryAtPath` / `blobEntryAtPath`)
  duplicating the descent, leaving `descendTreePath` untouched. Simpler diff to
  `read-file-at`/`rev-parse` (zero change there) but duplicates the descent loop
  and the non-tree-intermediate handling — a DRY violation the reviewer would flag.

**Recommendation: Option A** (extract the shared core). It is the honest model —
"descend a path, return the entry or nothing" is one operation; throwing vs
returning `undefined` is a caller policy layered on top.

**Return type & non-blob leaf (DC-3).** Blame needs a **blob** at the leaf; a
directory or gitlink leaf must read as "not a file here" → `undefined` (scenario D:
git refuses blame on a directory). Two placements:

- Return the raw `TreeEntry | undefined` from the core and let *blame* reject a
  non-blob leaf (mode is `DIRECTORY`/`GITLINK`) to `undefined`. Keeps the core
  policy-free; `descendTreePath`'s existing callers (`readFileAt` already rejects a
  directory/gitlink leaf with `UNEXPECTED_OBJECT_TYPE` downstream via `readBlob`;
  `rev-parse` *wants* any object) are unaffected.
- **Recommendation:** core returns `TreeEntry | undefined` on presence only (absent
  segment / non-tree intermediate → `undefined`); the **blob-ness** check for the
  leaf is blame's concern (`blobAtPath` returns `undefined` when the leaf mode is
  not a blob). This matches the current `blobAtPath` semantics exactly: today a
  directory at the path yields no `flat.entries` blob entry (flattenTree skips
  `DIRECTORY`, L26) → `undefined`; the descent must reproduce that `undefined`, not
  a throw.

**Siting (DC-4).** `descendTreePath` is `internal/`. If blame consumes the shared
core, either (a) blame imports from `internal/` (blame is a command; the
`primitives/internal/` folder is reachable — `read-file-at` and `rev-parse` are
commands importing it), or (b) promote the core to a **barrel primitive**. Option
(a) keeps it internal — no barrel export, **no surface gates** (`reports/api.json`,
doc-coverage untouched). Option (b) exposes a reusable path-lookup primitive to
library users, tripping the surface gates (barrel + api.json regenerate; see
`.claude/workflow/surface-gates.md` — no doc-coverage page unless it's a Tier-1
command, which it is not). **Recommendation: keep it internal (a)** — blame is the
only new consumer, the win is internal, and an internal helper is the minimal
surface. Promotion buys nothing this PR needs.

**Edge behaviour the descent must carry** (matching `descendTreePath` + blame's
`undefined` contract):

| Input | `descendTreePath` (throwing) | blame's core (undefined-returning) |
|-------|------------------------------|-------------------------------------|
| leaf present, is a blob | returns `TreeEntry` | returns `TreeEntry` (blame reads it) |
| leaf present, is a directory/gitlink | returns `TreeEntry` | returns `TreeEntry`; **blame** maps non-blob → `undefined` (DC-3) |
| final segment absent | `throw PATH_NOT_IN_TREE` | `undefined` |
| intermediate segment absent | `throw PATH_NOT_IN_TREE` | `undefined` |
| non-tree intermediate (blob used as dir) | `throw PATH_NOT_IN_TREE` | `undefined` |
| gitlink intermediate (submodule in the path) | `throw` (readObject on a gitlink oid absent from the repo → not a tree) | `undefined` (same: the submodule commit is not a tree in *this* repo) |

Cycle/depth/entry limits: `descendTreePath` has **no** cycle guard and **no**
depth/entry limit — it is bounded by `path.split('/')` length (the caller's path,
never adversarial for blame: the path came from a real tree entry originally). This
differs from `walkTree`'s `maxDepth 1024` / `maxEntries 1_000_000` / cycle-stack —
but `walkTree` recurses the *whole* tree (unbounded fan-out) whereas the descent
follows a *fixed* segment list (bounded by path depth, no fan-out, no revisiting).
So no new guard is needed; the descent inherits `descendTreePath`'s
already-shipped, already-tested bound. (Noted as DC-5 in case the gate wants an
explicit path-depth cap; recommendation: none — the path length is the bound.)

### Finding (2) — TREESAME skip: split the entry lookup from the blob read

**Where the split lives.** Today `resolveInParent` (L311–325) reads the parent
commit, then unconditionally `blobAtPath`s the parent (a flatten today, a descent
after finding 4) **and** reads the blob bytes. The TREESAME skip requires the oid
comparison to happen **between** the descent (which yields `{ id, mode }`) and the
blob **read** — so `resolveInParent` (or its caller) must:

1. Read the parent commit (`readCommitData` — needed for `data.tree` + `date`;
   O(depth), unchanged, git reads every ancestor commit too).
2. Descend the parent's `data.tree` at `suspect.path` → the parent's leaf
   `{ id, mode }` or `undefined` (finding 4, O(path-depth)).
3. **`undefined`** (path absent / non-blob leaf) → the existing rename path
   (`renamedSource` / `diffTrees` detectRenames) — unchanged.
4. **Present and `entry.id === suspect.blobId`** → **TREESAME**: return the
   parent's coordinates **without reading the parent blob**, signalling "identical".
   `processSuspect` then passes **all** `remaining` lines to this parent
   (`passed = remaining`, `kept = []`) reusing `suspect.blob` as the (identical)
   parent blob for `schedule`, and sets `previous ??= { commit: parent, path }`
   (a direct hit ⇒ `sourcePath === path`, L320 — matches git's `previous <oid>
   <path>`). No `readBlob`, no `diffLines`.
5. **Present and `entry.id !== suspect.blobId`** → the file changed: read the
   parent blob (`readBlob(entry.id)`) and `diffLines` as today.
6. **Short-circuit:** once `remaining` is empty (step 4 consumed all lines, or a
   change left nothing), `break` the parent loop (scenario C — remaining parents
   cannot be blamed for a file with no lines left).

**Shape of the `resolveInParent` return (implementation note, not a DC).**
`ResolvedParent` (L305) gains a discriminator so the caller knows whether to
diff or pass-through — e.g. `{ kind: 'treesame'; sourcePath; date }` (no blob) vs
`{ kind: 'changed'; blob; sourcePath; date }`. `processSuspect` branches on it:
`treesame` → `passed = remaining, kept = [], parentBlob = suspect.blob`; `changed`
→ today's `splitAgainstParent(remaining, diffLines(blob, suspect.blob))`. This
keeps the O(path-depth) descent + oid compare inside `resolveInParent` and the
line-partition logic in `processSuspect`, preserving the current separation of
concerns. (Rename hits are always `changed` — a renamed source is by definition a
different path, read via `readBlob(renamed.blobId)` as today.)

To compare oids, the suspect's blob oid must be known. `Suspect` (L99–105) carries
`blob` but not its oid (**DC-6** ★):

- **Option A — thread the blob oid through `Suspect`.** Add `readonly blobId:
  ObjectId` to `Suspect`; populate it at every `schedule` site (the descent /
  seed already read the entry, so the oid is in hand — `seed`/`seedWorkingTree`
  descend HEAD's tree; `processSuspect`/`resolveInParent` descend the parent's).
  The suspect's oid is then a field read at compare time — zero extra I/O.
- **Option B — recompute the suspect's blob oid** by hashing `suspect.blob` at
  compare time (`hashBlob`). No struct change, but re-hashes the whole blob once
  per parent — reintroduces an O(blob-size) cost the descent was removing.
- **Recommendation: Option A** (thread `blobId` through `Suspect`). The oid is
  already computed (it *is* the tree-entry id from the descent that scheduled the
  suspect); carrying it is free and turns the TREESAME test into a string compare.
  Object Calisthenics-clean: `Suspect` already models "(commit, path) with its blob
  and lines"; adding the blob's identity is a natural completion, not primitive
  obsession (it is a branded `ObjectId`).

**Behaviour-preservation argument (byte-for-byte).** On a TREESAME parent the
skip produces *exactly* what the current diff produces:

- `diffLines(parentBlob, suspect.blob)` where `parentBlob === suspect.blob`
  (byte-identical, since equal oids ⇒ equal content under git's content-addressing)
  yields a single `common` hunk spanning the whole file.
- `splitAgainstParent(remaining, thatCommonHunk)` returns `{ passed: remaining,
  kept: [] }` — every entry maps 1:1 to the same parent line (`childToParent` is
  the identity over `[0, count)`), `sourceStart` unchanged (identity remap).
- So `passed = remaining`, `kept = []`, and `schedule(parent, path,
  resolved.date, suspect.blob, remaining)` is what runs today. The skip computes
  the same `passed`/`kept` and schedules the same suspect with the same blob and
  date, setting the same `previous`. Identical scoreboard state ⇒ identical
  finalized lines ⇒ identical porcelain.

The **short-circuit** (step 6) is behaviour-preserving because
`splitAgainstParent([], anyDiff)` is `{ passed: [], kept: [] }` (empty entries in,
empty out) and `schedule(…, [])` is a documented no-op (L361: empty entry list →
return). So iterating the remaining parents after `remaining` empties schedules
nothing and changes no state — `break`ing is observably identical, and matches
scenario C (git does not descend the other parent).

**The `date` on a TREESAME schedule.** Today `schedule` uses `resolved.date` (the
parent's committer timestamp) as the priority-queue key. On the skip path the
parent's `date` is still `readCommitData(parent).committer.timestamp` —
`resolveInParent` reads the parent commit anyway (it needs `data.tree` to descend).
So the TREESAME skip avoids the *blob* read + diff, **not** the parent *commit*
read (which is needed for the tree oid + date + parents). This is correct: git also
reads each ancestor commit; the O(depth) blob read+diff is what TREESAME elides,
and the commit read is O(depth) regardless (bounded, cheap — `parseRequiredFields`,
not tree-walk). The win is real: scenario A's `stable.txt` now reads the *commit*
at each ancestor (cheap) but descends `stable.txt`'s subtree path only to compare
oids (O(path-depth), no blob read, no diff) — the flatten + blob read + diff per
ancestor is gone.

### Finding (4) for `show` / `log` — assessed, NOT in scope (recommend defer)

`show`'s `walkInternal 0.24 / parseTreeContent 0.18` come from `diffTrees`'s
**recursive** tree diff (`blobProjection` → `flattenTree` on both sides,
`diff-trees.ts` L166), which genuinely needs the **whole** tree on each side to
compute the change set. There is no single-path shortcut — a diff is inherently a
whole-tree comparison. The only lever there is a **parse-level constant-factor**
micro-opt (`parseTreeContent`: per-entry `TextDecoder.decode` of mode+name, a
`new Set` dup-check, `ObjectIdFactory.fromRaw` per entry) — riskier, lower value,
and it touches a domain hot-path shared by every tree read. `log`'s
`lookupPackIndex 0.11` (`domain/storage/pack-index.ts`) is fanout + binary search
per object — already the intended O(log n) design; shaving it is a separate
pack-index micro-opt.

**DC-1 (scope) recommendation: scope this PR to the high-value blame wins**
(findings 2 + 4-for-blame), and **defer** the `show`/`log` parse/pack-index
constant-factor micro-opts as a follow-up. Rationale: blame's findings are
algorithmic (O(tree-size)→O(path-depth), O(depth) blob-reads→0 on TREESAME) with a
large, safe, byte-identical win; the `show`/`log` levers are constant-factor, touch
a broadly-shared domain frame (`parseTreeContent` is on *every* tree read across
every command), and carry mutation/regression risk disproportionate to the share
they'd move. Chasing them here would widen the diff into the shared parser for a
low-value gain. (If the gate wants them in-PR, they are enumerated as DC-7 with the
specific micro-opts.)

## Faithfulness pinning matrix

No new git-behaviour is introduced (the current code is already TREESAME-correct —
see "What the matrix proves"). The matrix is **invariant-preservation** plus the
new **deep-ancestry / merge-TREESAME** goldens that pin the skip did not change
bytes:

| Property | Before | After (2+4) | Pinned by |
|----------|--------|-------------|-----------|
| Linear-history blame bytes | git-identical | git-identical | existing `blame-interop` linear test (unchanged) |
| Prepend-shift blame bytes | git-identical | git-identical | existing `blame-interop` prepend test (unchanged) |
| Clean-merge blame bytes (TREESAME merge, scenario B) | git-identical | git-identical | existing `blame-interop` merge test **+ NEW** deep-ancestry & first-parent-TREESAME goldens |
| Followed-rename blame bytes | git-identical | git-identical | existing `blame-interop` rename test (unchanged) — rename path (`direct === undefined`) untouched by the skip |
| `-L` range blame bytes | git-identical | git-identical | existing `blame-interop` -L test (unchanged) |
| Worktree / staged-new pseudo-commit bytes | git-identical | git-identical | existing `blame-interop` worktree tests (unchanged) |
| **File unchanged since a deep root → named at root** (scenario A) | git-identical (but O(depth) work) | git-identical (O(depth) commit reads, O(path-depth) descent, **0 blob reads on the unchanged span**) | **NEW** `blame-interop` deep-ancestry test: build a repo where `stable.txt` is untouched across N commits, assert `blame` bytes == `git blame --porcelain` |
| **Merge TREESAME to first parent → other parent invisible** (scenario C) | git-identical | git-identical | **NEW** `blame-interop` `-s ours` merge test: assert bytes == git |
| `previous` field on every line | present/correct | present/correct | porcelain reconstruction asserts `previous <oid> <path>`; skip sets `previous ??=` on the TREESAME parent (same as today) |
| Non-blob / directory leaf → refusal | `pathNotInTree` | `pathNotInTree` | descent → `undefined` → `seed`'s existing `pathNotInTree`; scenario D + a unit test |
| Absent path in parent → rename detection | fires | fires | descent → `undefined` → `renamedSource` (unchanged); existing rename test |
| `descendTreePath` callers (`readFileAt`, `rev-parse`) unchanged | git-identical | git-identical | Option-A wrapper preserves the throw; existing `resolve-tree-path` + `read-file-at` + `rev-parse` tests unchanged |

Each new golden reconstructs `git blame --porcelain` from the structured
`BlameResult` (per `blame-interop.test.ts`'s `renderPorcelain`) and asserts
byte-identity to real `git blame --porcelain HEAD -- <file>`, built in the existing
`beforeAll` harness (scrubbed env, deterministic dates). These are the finding-(2)
faithfulness pins: the skip is byte-for-byte the same output.

## Perf pinning plan

Mechanism: `npm run profile <cmd>` (26.3 / PR #224; `tooling/profile.ts` +
`tooling/profile-registry.ts`). `blame` is already in the registry.

| Command | Kind | Current blame-relevant self-shares | Expected after (2+4) |
|---------|------|-----------------------------------|----------------------|
| blame | read | `parseTreeContent 0.24 / walkInternal 0.22 / flattenTree 0.09 / walkTree 0.08` | **`flattenTree`/`walkTree`/`walkInternal` collapse** (no whole-tree flatten — path descent reads only subtrees on the path); `parseTreeContent` drops sharply (parses O(path-depth) trees, not O(tree-size)); share moves onto `parseRequiredFields`/commit reads (the irreducible O(depth) ancestry) |
| show | read | `walkInternal 0.24 / parseTreeContent 0.18` | **unchanged** (out of scope — recursive diff needs whole trees; DC-1) |
| log | read | `lookupPackIndex 0.11` | **unchanged** (out of scope; DC-1) |

Direction, not magnitude, is the gate (self-relative, host-portable — **ADR-475**).
The load-bearing shift: blame's tree-walk frames (`flattenTree`/`walkTree`/
`walkInternal`/`parseTreeContent`) drop as the whole-tree flatten is replaced by
O(path-depth) descent and TREESAME elides the per-ancestor blob read+diff.

**Baseline handling (DC-8) — recommend regenerate + commit.** Regenerate
`docs/perf/baseline.{json,md}` reflecting the new blame shares; quote before/after
`parseTreeContent` / `walkInternal` / `flattenTree` / `walkTree` for `blame` in the
PR body. **ADR-475** established the committed baseline as the moving
optimisation-license + regression reference the CI gate diffs against; 26.4c spends
that license for blame, so the artifact advances. `generatedOn` banner stays
metadata, never compared (ADR-475). This is *using* ADR-475's policy, not new
policy → no ADR for the baseline update.

An **absolute wall-clock** confirmation is also warranted here (per the
`checkcontainment-hot-path` precedent and the "perf self-share is Amdahl-fragile"
memory): the self-share drop is expected but could redistribute; a `test/bench`
before(main)/after(branch) run on a deep-ancestry blame (a file unchanged since a
deep root — the brief's 15-min case) should show the wall-clock collapse from
O(depth × tree-size) toward O(depth). Recommend running it and quoting the
before/after ms in the PR body alongside the share table.

## Mutation plan

New/changed code and how each surviving mutant is killed (per the
mutation-resistant-test rules — specific `.data` assertions, isolated guard tests,
try/catch over `toThrow`):

**Finding (4) — the `find`-returning descent core.**
- The `entry === undefined → undefined` (absent segment) and `object.type !==
  'tree' → undefined` (non-tree intermediate) branches are new decision points.
  Kill each with an **isolated** unit test (absent final, absent intermediate,
  blob-as-intermediate → each returns `undefined`), mirroring the existing
  `resolve-tree-path.test.ts` throwing tests but asserting `undefined`.
- The `descendTreePath` wrapper's `undefined → pathNotInTree(rev, path)` mapping:
  kill the "drop the throw" mutant with the existing `resolve-tree-path.test.ts`
  refusal tests (they assert `PATH_NOT_IN_TREE` with `rev`/`path` data) — carried
  forward verbatim, proving the wrapper still throws.
- Blame's non-blob-leaf → `undefined`: a unit test descending a path whose leaf is a
  directory asserts `blobAtPath` returns `undefined` (kills a mutant that returns
  the directory entry as a blob).

**Finding (2) — the TREESAME branch.**
- **`entry.id === suspectBlobId` StringLiteral / EqualityOperator mutants.** The
  `===` is the whole skip. `=== → !==` inverts it: an unchanged file would take the
  read+diff path (still correct output but wasteful) *and* a changed file would take
  the skip path (**wrong** — it would pass all lines to a parent whose blob differs,
  producing wrong blame). Kill with a **changed-file** test: a suspect whose parent
  blob **differs** must go through `diffLines` and keep the differing lines
  (assert the differing line is blamed at the child, not passed to the parent) —
  this fails if the skip fires on a non-equal oid. And a **TREESAME** test: a
  suspect whose parent blob is **equal** must pass all lines (assert every line
  blamed at the ancestor, `remaining` empties) — fails if the skip does not fire.
  Both are covered end-to-end by the new deep-ancestry + merge goldens, plus a
  focused unit test on `processSuspect` for the isolated kill.
- **The short-circuit `break` on empty `remaining`.** A mutant removing the `break`
  leaves the loop reading remaining parents — output identical (schedule([]) is a
  no-op), so this is a **timing-only equivalent mutant**. Document it as equivalent
  (removing the break re-reads parents but schedules nothing and finalizes the same
  bytes — no observable). Do **not** write a contrived test; per the
  "provably-equivalent" rule, record the justification. *(If a reviewer insists on
  a kill, a `readObject` call-count spy on the second parent of a first-parent-
  TREESAME merge would observe the break — noted as an option, but the recommend is
  to accept it equivalent, mirroring blame.ts's existing documented equivalent
  mutants at L157/L230/L359.)*
- **`previous ??= { commit: parent, path }` on the skip path.** A mutant dropping
  the `previous` assignment on the TREESAME branch drops the `previous <oid>` line
  from the porcelain. Killed by the merge golden (scenario B asserts `previous
  911c39c… f.txt`) and a focused assertion that a TREESAME-parent line carries
  `previous`.
- **Reusing `suspect.blob` as the parent blob on the skip.** A mutant substituting
  a different blob into `schedule` would change the scheduled suspect's content →
  wrong downstream diff. Killed by the deep-ancestry golden (the content must
  survive unchanged to the root).

**`Suspect.blobId` threading (DC-6 Option A).** Each `schedule` call site now
passes the blob oid. A mutant passing a wrong/empty oid makes the TREESAME compare
never match (unchanged file re-diffs — still correct but the *deep-ancestry perf
test* would regress) or always match (changed file wrongly skips — killed by the
changed-file test above). The functional kill is the changed-file test; the perf
regression is caught by the wall-clock bench, not a unit mutant.

**Carry-forward equivalent mutants.** blame.ts's existing documented equivalent
mutants (L157 `count===0` worktree, L230 `count===0` seed, L359 empty-entries
`schedule`) are **untouched** by this change — do not renumber or reword them.

## Surface gates

- **Finding (4) kept internal (DC-4 recommend):** the shared descent core stays in
  `primitives/internal/` — **no barrel export, no `reports/api.json` change, no
  doc-coverage page.** Blame imports from `internal/` (as `read-file-at`/`rev-parse`
  already do). If DC-4 chooses promotion to a barrel primitive, add the export to
  `src/application/primitives/index.ts` and regenerate `reports/api.json` via `npm
  run docs:json` (prepush `check:doc-typedoc` gate — pre-pay in the slice;
  `.claude/workflow/surface-gates.md`). No Tier-1 command is added → no
  `docs/use/commands/` page, no browser scenario, no README count change either way.
- **Finding (2):** internal to `blame.ts` + `Suspect` (a local interface, not
  exported) + `split-blame` (unchanged). No public surface.

## Non-goals / explicitly deferred

- **`show`/`log` finding-(4) constant-factor micro-opts** (`parseTreeContent`
  per-entry decode/Set/fromRaw; `lookupPackIndex` fanout search) — **deferred**
  (DC-1): low-value constant-factor on a broadly-shared domain frame, riskier than
  the blame algorithmic win. Enumerated as DC-7 if the gate wants them in-PR.
- **Finding (3)** (object-store `exists`-share) — explicitly out of scope; it was
  investigated and **reverted** in 26.4 for an inherent cold-read cost (see
  `checkcontainment-hot-path.md`).
- **Generalising the path-scoped descent to other single-path readers** — none
  exist (`blobAtPath` is the only whole-tree-flatten-for-one-path). `readFileAt`
  already uses `descendTreePath`. No other call site to migrate.

## Decision candidates

Every load-bearing choice below is for the ADR conversation — recommendations
stated, not decided here.

### DC-1 ★ — Scope: blame-only vs include `show`/`log` micro-opts
- **Option A (recommended):** ship findings **(2) TREESAME** + **(4) path-scoped
  descent for blame** only. High-value, algorithmic, byte-identical, contained diff.
- **Option B:** also chase the `show`/`log` constant-factor parse/pack-index
  micro-opts this PR.
- **Recommendation: A.** The `show`/`log` levers are low-value constant-factor on a
  shared domain hot-path (`parseTreeContent` runs on every tree read) with
  disproportionate mutation/regression risk. Defer.

### DC-2 ★ — Path-scoped lookup shape: refactor `descendTreePath` vs new primitive
- **Option A (recommended):** extract a `find`-returning core
  (`findTreeEntry → TreeEntry | undefined`) from `descendTreePath`; keep
  `descendTreePath` as a throwing wrapper (`undefined → pathNotInTree`). Blame calls
  the core. One algorithm, DRY, `readFileAt`/`rev-parse` byte-preserved.
- **Option B:** a standalone new primitive duplicating the descent, `descendTreePath`
  untouched.
- **Recommendation: A.** Throwing vs returning-`undefined` is a caller policy over
  one descent operation; duplicating the loop is a DRY smell.

### DC-3 — Non-blob leaf handling: core vs blame
- **Option A (recommended):** the core returns `TreeEntry | undefined` on
  **presence** (absent / non-tree-intermediate → `undefined`); **blame** maps a
  non-blob leaf (`DIRECTORY`/`GITLINK`) → `undefined`. Reproduces today's
  `flattenTree`-skips-directories semantics exactly; keeps the core policy-free.
- **Option B:** the core itself returns `undefined` for a non-blob leaf.
- **Recommendation: A.** The core is a generic path→entry resolver (`rev-parse`
  wants any object type at the leaf); blob-ness is blame's concern.

### DC-4 — Siting: keep the descent core internal vs promote to a barrel primitive
- **Option A (recommended):** keep it in `primitives/internal/`; blame imports it
  directly (like `read-file-at`/`rev-parse`). **No surface gates.**
- **Option B:** promote to `primitives/index.ts` (barrel) as a reusable primitive →
  `reports/api.json` regenerate (prepush gate).
- **Recommendation: A.** Blame is the only new consumer; the win is internal;
  minimal surface.

### DC-5 — Explicit path-depth cap on the descent
- **Option A (recommended):** none — the descent is bounded by `path.split('/')`
  length (fixed segment list, no fan-out, no revisiting), matching
  `descendTreePath`'s existing shipped behaviour (no cap, no cycle guard).
- **Option B:** add a `maxDepth` guard mirroring `walkTree`'s 1024.
- **Recommendation: A.** `walkTree`'s guards defend unbounded recursive fan-out; a
  fixed path descent has neither fan-out nor cycles. No new guard.

### DC-6 ★ — Suspect blob oid: thread through `Suspect` vs recompute
- **Option A (recommended):** add `readonly blobId: ObjectId` to `Suspect`, populated
  at each `schedule` site (the oid is already the tree-entry id from the descent
  that scheduled the suspect — free). TREESAME test becomes a string compare, zero
  extra I/O.
- **Option B:** recompute via `hashBlob(suspect.blob)` at compare time — O(blob-size)
  re-hash per parent, reintroducing the cost the descent removed.
- **Recommendation: A.** The oid is already in hand; carrying it is free and clean.

### DC-7 — (open only if DC-1 → B) which `show`/`log` micro-opts
- `parseTreeContent`: hoist the `new Set` dup-check, batch-decode, or defer
  `fromRaw` hex until an entry is used; `lookupPackIndex`: cache the fanout table.
- **Recommendation: not in this PR** (see DC-1). Listed for completeness.

### DC-8 — Baseline: regenerate + commit vs leave
- **Option A (recommended):** regenerate + commit `docs/perf/baseline.{json,md}`;
  quote before/after blame shares + a wall-clock deep-ancestry bench in the PR body.
  Uses ADR-475's moving-baseline policy — **no ADR**.
- **Option B:** leave the baseline; note the drop in the PR body only.
- **Recommendation: A.** 26.4c spends the optimisation license; the artifact must
  advance for the CI gate to diff against.

### DC-9 — ADR need
- **Recommendation: no ADR anywhere in this PR.** Both findings are
  behaviour-preserving (the current code is already TREESAME-correct — the change is
  waste-elimination proven byte-identical against real git in the matrix above); no
  git-observable change; no public-contract change (DC-4 → internal); the baseline
  update *uses* ADR-475's existing policy. The one thing that could bear an ADR —
  promoting an internal helper to public surface (DC-4 → B) — is recommended
  *against*. If the gate considers "the TREESAME skip" a policy choice, a
  ≤1-paragraph ADR noting "blame elides the parent blob read+diff when the tree-entry
  oid matches; behaviour pinned byte-identical against git 2.55.0" would suffice —
  but the recommendation is that the empirical matrix in this doc carries it and no
  ADR is warranted.
