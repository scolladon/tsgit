# Design — `status` staged column (index-vs-HEAD)

> Tier-1 `repo.status()` currently surfaces only the **working-tree** column
> (index-vs-worktree) plus untracked files; `indexChanges` is always returned
> empty. This adds the real **staged** column — git's "Changes to be committed",
> i.e. `git diff-index --cached HEAD` — by diffing the index against HEAD's tree.
> `clean` becomes true only when both columns and the untracked set are empty.
> `describe --dirty`/`--broken`, which delegate to `status`, then detect
> **staged-only** changes faithfully (`git diff-index HEAD` over both columns).

## 1. What git computes

`git status` reports two independent columns per tracked path (porcelain `XY`):

- **X — staged**: HEAD-tree vs index (`git diff-index --cached HEAD`).
- **Y — working tree**: index vs working tree.

Plus untracked files (`??`) and unmerged paths (stage > 0).

Grounded against real `git` (isolated env, signing off) — a repo with HEAD
committing `a.txt`/`b.txt`, tag `v1.0`, then `a.txt` modified+staged, `b.txt`
removed from the index (still on disk), `c.txt` added+staged:

| plumbing | output |
|----------|--------|
| `status --porcelain` | `M  a.txt` / `D  b.txt` / `A  c.txt` / `?? b.txt` |
| `status --porcelain=v2` | `1 M. …a.txt` / `1 D. …b.txt` / `1 A. …c.txt` / `? b.txt` |
| `diff-index --cached --name-status HEAD` | `M a.txt` / `D b.txt` / `A c.txt` |
| `describe --dirty` | `v1.0-dirty` |

Observations that fix the design:

- The staged column is **exactly** `diff-index --cached HEAD`: per path, compare
  HEAD-tree `(oid, mode)` to the stage-0 index entry → add / delete / modify.
- The two columns are **orthogonal**: `a.txt` is `M.` (staged only — worktree
  matches index), and `b.txt` appears in *both* the staged column (`D`, gone from
  the index) **and** the untracked set (`??`, still on disk). Each column is an
  independent pass; no cross-talk is needed.
- `describe --dirty` flips to `-dirty` for a **staged-only** change → describe's
  dirtiness must consider both columns, matching `git diff-index HEAD`.

## 2. What exists already

The domain function that computes this column is **already written and
unit-tested** but never wired into a command:

```ts
// src/domain/diff/index-diff.ts
export function diffIndexAgainstTree(index: GitIndex, tree: FlatTree | undefined): TreeDiff
```

It unions stage-0 index paths with the (flattened) HEAD tree paths and classifies
each: present-both → `modify`/`type-change` (or unchanged → dropped), index-only →
`add`, tree-only → `delete`. Output is `sortByPath`-ordered (git's byte order).
`tree === undefined` (unborn HEAD) makes every index entry an `add`. This is the
plumbing; 23.2b is the wiring.

What is missing is the application glue to obtain HEAD's tree as a `FlatTree`. The
exact pattern already lives in `rm.ts` (`headTreeEntries`): resolve `HEAD`,
tolerate an unborn HEAD (`REF_NOT_FOUND` → undefined), read the commit, flatten
its tree. That duplication is the seed for the Step-7 architecture pass (§6).

## 3. Design

### 3.1 New primitive — `readHeadTree`

`src/application/primitives/read-head-tree.ts`:

```ts
export const readHeadTree = async (ctx: Context): Promise<FlatTree | undefined>
```

Resolve `HEAD`; on `REF_NOT_FOUND` (unborn HEAD) return `undefined`; otherwise
read the commit (asserting `commit` type, else `unexpectedObjectType`) and
`flattenTree(commit.data.tree)`. Read-only w.r.t. the working tree — only reads
git objects. Returns the full `FlatTree` (`{ entries }`) so callers needing the
bare map use `.entries`. This is `rm.ts`'s `headTreeEntries` generalised one notch
(map → `FlatTree`); `rm` migrates onto it in Step 7 (behaviour-preserving).

Exported from the primitives barrel (Tier-2 composable op, same tier as
`flattenTree`/`readIndex`).

### 3.2 `status` — the staged pass

`status` gains a third pass alongside the existing working-tree (pass 1) and
untracked (pass 2) passes:

```ts
const headTree = await readHeadTree(ctx);
const indexChanges = toChangeEntries(diffIndexAgainstTree(index, headTree));
```

`diffIndexAgainstTree` takes the parsed `GitIndex` (`status` already reads it).
The result's `DiffChange[]` maps to the existing coarse `ChangeKind`:

| `DiffChange.type` | `ChangeKind` | git porcelain X |
|-------------------|--------------|-----------------|
| `add` | `added` | `A` |
| `delete` | `deleted` | `D` |
| `modify` | `modified` | `M` |
| `type-change` | `modified` | `T` |

`type-change` collapses to `modified` deliberately: the **working-tree** column
already collapses mode/type/content differences into `modified`
(`compareWorkingTreeEntry`), so both columns share one coarse projection. `T` is
not separately representable in today's `ChangeKind`; introducing it would be a
*cross-column* enrichment (both passes) and is out of 23.2b scope — logged as a
follow-up (§7), not done here (YAGNI). Renames never arise: `diffIndexAgainstTree`
runs no rename detection.

`indexChanges` inherits `diffIndexAgainstTree`'s `sortByPath` ordering (git's diff
order) — no re-sort in `status`.

### 3.3 `clean`

```ts
const clean = indexChanges.length === 0 && workingTreeChanges.length === 0;
```

`workingTreeChanges` already includes untracked, so this is git's "nothing to
commit, working tree clean" (no staged, no unstaged, no untracked).

### 3.4 `describe` dirtiness

`computeDirty` widens from the working-tree column only to both columns —
faithful `git diff-index HEAD` (untracked still never counts):

```ts
return state.indexChanges.length > 0
  || state.workingTreeChanges.some((c) => c.kind !== 'untracked');
```

The stale comment in `describe.ts` ("`status` does not yet surface the staged
column …") is removed. `--broken`'s throw-tolerance branch is untouched (it is
about an unreadable tree, not staged content).

### 3.5 Out of scope (unchanged)

- **Unmerged paths** (stage > 0): `diffIndexAgainstTree` is stage-0-only;
  `StatusResult` has no `unmerged` field today. Reporting "Unmerged paths" is a
  separate, larger surface — untouched, not regressed.
- **type-change / mode-only distinction**: see §3.2. Both columns stay coarse.

## 4. Faithfulness pinning

A new `status-interop` cross-tool test builds repos with canonical `git`
(isolated env, signing off) and reconstructs `git status --porcelain` from tsgit's
two structured columns, asserting equality with real `git status --porcelain`.

Reconstruction (mirrors git's observed porcelain order): one `XY␠path` line per
tracked path (union of `indexChanges` and non-untracked `workingTreeChanges`,
sorted by path; `X` from the staged kind, `Y` from the working-tree kind, space
when absent), then one `??␠path` line per untracked path (sorted by path). A path
can emit both a tracked line and a `??` line (delete-from-index-still-on-disk),
matching git.

Cases: staged add/modify/delete; staged-only vs staged+worktree (`M ` vs `MM`);
delete-from-index-still-on-disk (`D ` + `??`); unborn HEAD (all `A`); clean tree.
**`type-change` is excluded from the parity cases** — the coarse `ChangeKind`
maps `T`→`M` by design (§3.2), so it is pinned by a unit test, not XY
reconstruction. `describe`'s existing dirty interop gains a **staged-only** case
asserting `-dirty` reconstruction.

This refines, not violates, the prime directive: faithfulness binds the **data**
(which paths, which column, which kind) — the `XY` letters are reconstructed *in
the test* from the structured fields; `status` itself emits no string.

## 5. Tests (TDD)

- `read-head-tree.test.ts` (primitive): unborn HEAD → `undefined`; committed HEAD
  → `FlatTree` of leaf blobs (nested tree flattened); non-commit at the resolved
  id → `unexpectedObjectType`. Mutation-resistant: assert the error `.data`
  (`code`, expected/actual type), trigger guards independently.
- `status.test.ts` additions: staged add/modify/delete populate `indexChanges`
  with the right `kind`+`path`; staged-only leaves `workingTreeChanges` empty;
  `type-change` → `modified`; unborn HEAD → all `added`; `clean` reflects both
  columns (staged-only ⇒ not clean); ordering is byte-sorted.
- `describe.test.ts`: staged-only change ⇒ `dirty: true`; clean ⇒ `false`;
  staged + `--broken` unaffected.
- Interop (§4).

## 6. Architecture pass (Step 7 seed)

`readHeadTree` generalises `rm.ts`'s `headTreeEntries`. After the feature lands,
migrate `rm` onto the shared primitive (`(await readHeadTree(ctx))?.entries ??
new Map()`), deleting its private copy — behaviour-preserving, two proven
consumers (status + rm), within the feature's blast radius. Evaluated, executed
in Step 7; if anything resists clean extraction it becomes a follow-up, not a
forced refactor.

## 7. Follow-ups (deferred, logged to backlog)

- `T` (type-change) and mode-only changes as first-class `ChangeKind` values
  across **both** columns — a cross-column faithfulness enrichment, larger than
  23.2b.
- "Unmerged paths" (stage 1/2/3) reporting on `StatusResult`.

## 8. Non-goals

- No rename detection in `status` (git doesn't rename-detect status by default
  beyond porcelain heuristics we don't model).
- No cosmetic/rendering surface — `status` stays structured-data-only (ADR-249).
