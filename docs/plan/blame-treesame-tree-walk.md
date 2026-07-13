# Plan — blame TREESAME skip + path-scoped tree descent

> Source: design doc `docs/design/blame-treesame-tree-walk.md` · ADRs `none` (DC-9 → no ADR)
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

All four code changes are **behaviour-preserving, byte-identical** perf work (pure
waste-elimination — the current code is already TREESAME-correct, verified against
git 2.55.0 in the design's scenario matrix A/B/C/D). No git-observable change, no
public surface moves (DC-4 → descent core stays in `primitives/internal/`; DC-7 →
`lookupPackIndex` signature unchanged). **No barrel export, no `reports/api.json`
change, no doc-coverage page, no README count, no browser scenario** for any part —
re-confirmed against `.claude/workflow/surface-gates.md`: every new symbol is
`internal` (an `internal/` helper, a local `blame.ts` interface field, or a domain
implementation shave).

**Dependency order:** Part 1 (descent core, foundational) → Part 2 (blame
`blobAtPath` rewire, needs the core) → Part 3 (TREESAME skip, needs the descent to
supply the entry oid). Part 4 (`lookupPackIndex` shave) is independent — may run in
parallel or any order. Part 5 (baseline + bench artifact) is last (measures the
landed state). Parts 1–3 share one working tree and build on each other.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone.
- Parts 1–4 each land behaviour + its tests as one atomic TDD slice. Part 5 is a
  docs/artifact-only part (no `src/` delta) — legitimately standalone.

## Part 1 — Extract the `find`-returning tree-path descent core (DC-2 → A)

### Context

**Goal (foundational — do first).** Refactor `descendTreePath` into an internal
`find`-returning core that returns `TreeEntry | undefined` (never throws on an
absent/non-tree-intermediate path), plus keep `descendTreePath` as a thin throwing
wrapper mapping `undefined → pathNotInTree(rev, path)`. The core must also accept an
`ObjectId | Tree` root (blame holds a tree oid) — the same `ObjectId | Tree` shape
`walkTree`/`flattenTree` already take. This is pure reuse of the existing descent
loop, sliced into two entry points. Byte-for-byte preservation of `readFileAt` and
`rev-parse` is the acceptance bar.

**File to change:** `src/application/primitives/internal/resolve-tree-path.ts`
(full current contents below — 39 lines).

```ts
import { pathNotInTree } from '../../../domain/commands/error.js';
import type { Tree, TreeEntry } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

export const descendTreePath = async (
  ctx: Context,
  rootTree: Tree,
  path: string,
  rev: string,
): Promise<TreeEntry> => {
  const segments = path.split('/');
  const lastIndex = segments.length - 1;
  let current: Tree = rootTree;
  for (let i = 0; i < lastIndex; i += 1) {
    const entry = findEntry(current, segments[i] as string, rev, path);   // throws
    const object = await readObject(ctx, entry.id);
    if (object.type !== 'tree') throw pathNotInTree(rev, path);            // throws
    current = object;
  }
  return findEntry(current, segments[lastIndex] as string, rev, path);     // throws
};

const findEntry = (tree: Tree, name: string, rev: string, path: string): TreeEntry => {
  const entry = tree.entries.find((candidate) => candidate.name === name);
  if (entry === undefined) throw pathNotInTree(rev, path);
  return entry;
};
```

**Target shape.** Introduce (export from the same `internal/` file — internal, no
barrel):

```ts
export const findTreeEntry = async (
  ctx: Context,
  root: ObjectId | Tree,          // NEW: accepts a tree oid OR a resolved Tree
  path: string,
): Promise<TreeEntry | undefined> => { … }   // undefined on absent / non-tree-intermediate
```

- Add `ObjectId` to the existing type import (currently
  `import type { Tree, TreeEntry } from '../../../domain/objects/index.js';` — extend
  to `{ ObjectId, Tree, TreeEntry }`) and add
  `import { readTree } from '../read-tree.js';` (resolve-tree-path is at
  `primitives/internal/`, so `../read-tree.js` reaches `primitives/read-tree.ts`;
  same `../` depth as the existing `import { readObject } from '../read-object.js';`).
- Resolve `root`: if it is a string oid, `readTree(ctx, root)` (signature
  `readTree(ctx, ref: RefName | ObjectId): Promise<Tree>`); if it is already a
  `Tree` (`root.type === 'tree'`), use it directly. Mirror how `walkTree`/
  `flattenTree` accept `ObjectId | Tree` — check `flatten-tree.ts` if you want the
  reference pattern, but here the root read is `readTree`, not `walkTree`.
- The descent loop is verbatim the current one, except each `findEntry` returns
  `undefined` (not throws) on absent, and the non-tree intermediate returns
  `undefined` (not throws). Use an inline `find` (`current.entries.find(c => c.name === name)`)
  or a private `undefined`-returning helper — no `rev`/`path` needed by the core
  (it carries no refusal).
- Keep `descendTreePath` as a **one-line-body wrapper**:
  ```ts
  export const descendTreePath = async (ctx, rootTree: Tree, path, rev): Promise<TreeEntry> => {
    const entry = await findTreeEntry(ctx, rootTree, path);
    if (entry === undefined) throw pathNotInTree(rev, path);
    return entry;
  };
  ```
  This preserves `descendTreePath`'s exact signature `(ctx, rootTree: Tree, path, rev)`
  and its exact `PATH_NOT_IN_TREE` refusal (carrying `rev`+`path`) for its two
  existing callers.

**Existing callers that must stay byte-identical (do not touch):**
- `src/application/commands/read-file-at.ts` L50 — `await descendTreePath(ctx, rootTree, path, rev)`
  then `readBlob(ctx, entry.id, options)`.
- `src/application/commands/rev-parse.ts` L214 — verify it still calls
  `descendTreePath(...)` with the same 4 args (grep to confirm the exact call).

**Edge table the core must carry** (design "Edge behaviour the descent must carry"):

| Input | `descendTreePath` (wrapper, unchanged) | `findTreeEntry` (core, NEW) |
|-------|----------------------------------------|-----------------------------|
| leaf present (blob/dir/gitlink) | returns `TreeEntry` | returns `TreeEntry` |
| final segment absent | `throw PATH_NOT_IN_TREE` | `undefined` |
| intermediate segment absent | `throw PATH_NOT_IN_TREE` | `undefined` |
| non-tree intermediate (blob used as dir) | `throw PATH_NOT_IN_TREE` | `undefined` |

No cycle guard, no depth cap (DC-5 → none; bounded by `path.split('/')` length, no
fan-out — inherits `descendTreePath`'s existing shipped behaviour).

**Test file:** `test/unit/application/primitives/internal/resolve-tree-path.test.ts`
(full current contents already exercise `descendTreePath`: the happy top-level and
`a/b/c` nested returns, the three throwing branches — absent final `→ PATH_NOT_IN_TREE`
with `rev`/`path` data, absent intermediate, blob-as-intermediate — and executable
mode preservation). These stay verbatim (they pin the wrapper's throw — a
carry-forward mutation kill for "drop the throw"). Fixtures: `buildSeededContext`
from `../fixtures.js`, `writeObject`, `blobOf(byte)` helper, `FILE_MODE`. Add a new
top-level `describe('findTreeEntry')` block mirroring the structure.

### TDD steps

**RED (add `findTreeEntry` tests to `resolve-tree-path.test.ts`):**
1. `Given a root tree oid with a top-level file / When findTreeEntry walks the file
   name / Then returns that entry` — write a blob + a tree via `writeObject`, pass
   the **tree oid** (not the Tree object) as `root`; assert `sut.id` / `sut.mode`.
   Expected failure: `findTreeEntry` does not exist / not exported.
2. `Given an already-resolved root Tree / When findTreeEntry walks it / Then returns
   the entry` — pass a `Tree` object as `root` (proves the `ObjectId | Tree` union).
3. `Given a nested tree a/b/c oid / When findTreeEntry walks the deep path / Then
   returns the deep entry`.
4. `Given a path whose final segment is absent / When findTreeEntry walks it / Then
   returns undefined` (isolated — mutation kill for the absent-final branch).
5. `Given a path whose intermediate segment is absent / When findTreeEntry walks it /
   Then returns undefined` (isolated — absent-intermediate branch).
6. `Given an intermediate segment that is a blob / When findTreeEntry descends into
   it / Then returns undefined` (isolated — non-tree-intermediate `object.type !== 'tree'`
   branch). These three `undefined` tests are the design's mutation-plan kills for
   the new decision points.
Run — all fail (symbol absent).

**GREEN:** extract `findTreeEntry` per the target shape; re-express `descendTreePath`
as the throwing wrapper. Run the full `resolve-tree-path.test.ts` — the new
`findTreeEntry` block passes AND the existing `descendTreePath` block (happy +
throwing) stays green unchanged.

**REFACTOR:** collapse any duplicated `find`; ensure the core has no `rev`/`path`
params. Confirm `read-file-at` + `rev-parse` still type-check and their tests pass
(they call the unchanged wrapper).

### Gate

`npx vitest run test/unit/application/primitives/internal/resolve-tree-path.test.ts test/unit/application/commands/read-file-at.test.ts test/unit/application/commands/rev-parse.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/resolve-tree-path.ts test/unit/application/primitives/internal/resolve-tree-path.test.ts`

### Commit

`refactor(primitives): extract a find-returning tree-path descent core`

## Part 2 — Rewire blame's `blobAtPath` onto the O(path-depth) descent (finding 4)

### Context

**Goal.** Replace the whole-tree flatten in blame's `blobAtPath` with the
Part-1 `findTreeEntry` descent — O(path-depth) reads instead of O(tree-size) — and
map a non-blob leaf to `undefined` (DC-3). Byte-identical output; the existing
`blame-interop` suite is the pin.

**File to change:** `src/application/commands/blame.ts`. Current `blobAtPath`
(L365–374):

```ts
const blobAtPath = async (
  ctx: Context,
  tree: ObjectId,
  path: FilePath,
): Promise<Uint8Array | undefined> => {
  const flat = await flattenTree(ctx, tree);           // (!) flattens the ENTIRE tree
  const entry = flat.entries.get(path);
  if (entry === undefined) return undefined;
  return (await readBlob(ctx, entry.id)).content;
};
```

**Target shape:**
```ts
const blobAtPath = async (ctx, tree: ObjectId, path: FilePath): Promise<Uint8Array | undefined> => {
  const entry = await findTreeEntry(ctx, tree, path);
  if (entry === undefined) return undefined;
  if (entry.mode === FILE_MODE.DIRECTORY || entry.mode === FILE_MODE.GITLINK) return undefined;
  return (await readBlob(ctx, entry.id)).content;
};
```

- Import `findTreeEntry` from `../primitives/internal/resolve-tree-path.js`
  (blame is a command; importing from `primitives/internal/` is the established
  pattern — `read-file-at`/`rev-parse` do it). Import `FILE_MODE` from
  `../../domain/objects/index.js` (or `../../domain/objects/file-mode.js`) —
  `FILE_MODE.DIRECTORY === '40000'`, `FILE_MODE.GITLINK === '160000'`.
- **Why the non-blob check (DC-3):** the old `flattenTree` **skipped** `DIRECTORY`
  entries (`flatten-tree.ts` L26: `if (entry.mode === FILE_MODE.DIRECTORY) continue`),
  so `flat.entries.get(path)` returned `undefined` for a directory-at-path →
  `blobAtPath` returned `undefined`. The descent returns the entry regardless, so
  blame must reproduce the `undefined` by rejecting a non-blob leaf. A gitlink leaf
  is likewise not a file. This drives `seed`'s existing `pathNotInTree` refusal for
  a directory path (scenario D) and `resolveInParent`'s rename path for a parent
  lacking the file.
- **Remove the now-unused `flattenTree` import** if blame no longer references it
  anywhere else (grep `flattenTree` in `blame.ts` — `renamedSource` uses `diffTrees`,
  not `flattenTree`, so the import likely becomes dead; biome flags unused imports).

**Callers of `blobAtPath` (unchanged — they consume `Uint8Array | undefined`):**
- `seedWorkingTree` L162 (`const headBlob = await blobAtPath(sb.ctx, data.tree, path)`).
- `seed` L227 (`const blob = await blobAtPath(sb.ctx, data.tree, path)`).
- `resolveInParent` L319 (`const direct = await blobAtPath(ctx, data.tree, path)`).

**Pinned bytes:** `test/integration/blame-interop.test.ts` (10 tests: linear,
prepend, clean-merge, followed-rename, -L range, worktree modified/appended/staged/
symlink/range) must stay byte-identical — they reconstruct `git blame --porcelain`
via `renderPorcelain` and compare to real git. `test/unit/application/commands/blame.test.ts`
(all committed-rev + worktree + subtree-rename + range cases) must stay green
unchanged. In particular the existing `blame.test.ts` case "Given a rename of a file
inside a subdirectory" (L295, `dir/a.txt → dir/b.txt`) already exercises a nested
path through the descent — it must stay green.

### TDD steps

**RED — write the non-blob-leaf test FIRST, then rewire so it drives the mode
guard.** Add to `blame.test.ts`: `Given a path that names a directory / When blaming
it / Then it refuses with PATH_NOT_IN_TREE`. Commit two files under `dir/` (so `dir`
is a tree entry in HEAD — e.g. `commitFile(ctx, 'c1', 'dir/a.txt', 'x\n')` and
`dir/b.txt`), then `await blame(ctx, 'dir')`; assert `PATH_NOT_IN_TREE` with
`path: 'dir'` (matches scenario D — blame refuses a directory).
- This test passes on `main` (the old `flattenTree` skips `DIRECTORY`, so
  `blobAtPath('dir')` already returns `undefined` → `seed` throws `PATH_NOT_IN_TREE`).
  It is the **behaviour it pins**, so the strict RED is on the *rewire's naive form*:
  do the GREEN rewire of `blobAtPath` **without** the `DIRECTORY`/`GITLINK` guard
  first — `findTreeEntry('dir')` now returns the directory `TreeEntry`, `readBlob` on
  a tree oid throws `UNEXPECTED_OBJECT_TYPE` (wrong code), so the test goes RED with
  the wrong error. That RED is the design's non-blob-leaf mutation kill.

**GREEN:** rewire `blobAtPath` per the target shape WITH the
`entry.mode === FILE_MODE.DIRECTORY || entry.mode === FILE_MODE.GITLINK → undefined`
guard (add `findTreeEntry` + `FILE_MODE` imports, drop `flattenTree` if unused). The
directory test flips to `PATH_NOT_IN_TREE` (green); run `blame.test.ts` +
`blame-interop.test.ts` — all green, byte-identical.

**REFACTOR:** confirm no dead `flattenTree` import remains; keep `blobAtPath` under
20 lines, early returns.

### Gate

`npx vitest run test/unit/application/commands/blame.test.ts test/integration/blame-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/blame.ts test/unit/application/commands/blame.test.ts`

### Commit

`perf(blame): read one path's blob via O(path-depth) descent, not a whole-tree flatten`

## Part 3 — TREESAME skip: thread the blob oid + skip the redundant parent read+diff (finding 2)

### Context

**Goal.** Elide the parent-blob read + `diffLines` when a parent's tree-entry oid at
the path equals the suspect's blob oid (the blobs are byte-identical ⇒ the diff is
all-common ⇒ all lines pass to the parent). Short-circuit the parent loop once no
lines remain. Byte-for-byte identical porcelain (the current all-parents loop is
already TREESAME-correct — this is waste-elimination). New deep-ancestry + first-
parent-TREESAME goldens pin that the bytes did not change.

**File to change:** `src/application/commands/blame.ts`. Three edits:

**(a) Thread `blobId` through `Suspect` (DC-6 → A).** Current `Suspect` (L99–105):
```ts
interface Suspect {
  readonly commit: ObjectId;
  readonly path: FilePath;
  readonly blob: Uint8Array;
  readonly entries: ReadonlyArray<BlameEntry>;
}
```
Add `readonly blobId: ObjectId;`. `Suspect` is a **local, non-exported** interface —
no surface gate. `schedule` (L350–363) currently takes
`(sb, commit, path, date, blob, entries)` and pushes `{ commit, path, blob, entries }`.
Add a `blobId: ObjectId` param — **new signature**
`schedule(sb, commit, path, date, blob, blobId, entries)` — and include `blobId` in
the pushed `{ commit, path, blob, blobId, entries }`. Update all three call sites to
pass the oid.

**Two distinct descent helpers (keep the read deferred where it matters):**
- Seed sites need the blob **bytes** AND its oid together (they `splitLines` the
  bytes unconditionally). Introduce
  `const blobEntryAtPath = async (ctx, tree, path): Promise<{ id: ObjectId; content: Uint8Array } | undefined>`
  built on `findTreeEntry` (descend → non-blob leaf → `undefined` → `readBlob(entry.id)`;
  return `{ id: entry.id, content }`). Refactor `blobAtPath` (Part 2) to project
  `blobEntryAtPath(...)?.content` — one descent helper, DRY. `seed` (L227) and
  `seedWorkingTree` (L162) switch to `blobEntryAtPath`, using `.content` for the
  diff/split and `.id` for the `schedule` `blobId`.
- The ancestry loop must NOT read the parent blob before the oid compare. So
  `resolveInParent` does **not** call `blobEntryAtPath` (which reads eagerly) — it
  calls `findTreeEntry` (entry-only, no `readBlob`), compares `entry.id` to
  `suspect.blobId`, and reads the blob (`readBlob(entry.id)`) only on the `changed`
  branch. This is the whole point of the TREESAME skip: defer `readBlob` past the
  oid compare. (For an ABSENT parent entry, the rename path reads
  `renamedSource`'s `blobId`.)

`schedule` call-site oids:
- `seed` (L233) — `blobEntryAtPath(...).id`.
- `seedWorkingTree` (L165) — the HEAD `blobEntryAtPath(...).id`.
- `processSuspect` (L255) — `treesame` → `suspect.blobId` (identical); `changed` →
  the parent entry's id (direct) or the renamed source's `blobId`, threaded out of
  `resolveInParent` via the `changed` variant's `readonly blobId: ObjectId`.

**(b) Discriminated `resolveInParent` (design "Shape of the `resolveInParent` return").**
Current (L305–325):
```ts
interface ResolvedParent {
  readonly blob: Uint8Array;
  readonly sourcePath: FilePath;
  readonly date: number;
}
const resolveInParent = async (ctx, parent, childTree, path): Promise<ResolvedParent | undefined> => {
  const data = await readCommitData(ctx, parent);
  const date = data.committer.timestamp;
  const direct = await blobAtPath(ctx, data.tree, path);
  if (direct !== undefined) return { blob: direct, sourcePath: path, date };
  const renamed = await renamedSource(ctx, data.tree, childTree, path);
  if (renamed === undefined) return undefined;
  const blob = (await readBlob(ctx, renamed.blobId)).content;
  return { blob, sourcePath: renamed.sourcePath, date };
};
```
Rework to a discriminated union return:
```ts
type ResolvedParent =
  | { readonly kind: 'treesame'; readonly sourcePath: FilePath; readonly date: number }
  | { readonly kind: 'changed'; readonly blob: Uint8Array; readonly blobId: ObjectId; readonly sourcePath: FilePath; readonly date: number };
```
`resolveInParent`'s signature gains the suspect's blob oid — change it from
`(ctx, parent, childTree, path)` to `(ctx, parent, childTree, path, suspectBlobId: ObjectId)`
(pass `suspect.blobId` from `processSuspect`). Logic:
1. `readCommitData(parent)` → `date`, `data.tree` (unchanged — git reads every
   ancestor commit too; the TREESAME skip elides the **blob** read + diff, not the
   commit read).
2. `findTreeEntry(ctx, data.tree, path)` → the parent's leaf `TreeEntry | undefined`
   (entry-only — NO `readBlob` yet; that is the deferral the skip depends on). Reject
   a non-blob leaf (`DIRECTORY`/`GITLINK`) to `undefined` here too (same DC-3 rule as
   `blobAtPath` — factor the "descend → blob entry or undefined" into a shared inline
   helper if it reads cleaner, but do NOT eagerly `readBlob`).
3. Blob leaf present and `entry.id === suspectBlobId` → **`{ kind: 'treesame', sourcePath: path, date }`**
   (no `readBlob`, no diff).
4. Blob leaf present and `entry.id !== suspectBlobId` → **`{ kind: 'changed', blob: (await readBlob(ctx, entry.id)).content, blobId: entry.id, sourcePath: path, date }`**.
5. Leaf absent / non-blob (`undefined`) → the rename path: `renamedSource` → if found,
   `{ kind: 'changed', blob: (await readBlob(ctx, renamed.blobId)).content, blobId: renamed.blobId, sourcePath: renamed.sourcePath, date }`;
   else `undefined`. (Rename hits are ALWAYS `changed` — a renamed source is a
   different path/blob.)

**(c) `processSuspect` branch + short-circuit.** Current (L245–259):
```ts
const processSuspect = async (sb, suspect): Promise<void> => {
  const data = await readCommitData(sb.ctx, suspect.commit);
  const childLines = splitLines(suspect.blob);
  let remaining = suspect.entries;
  let previous: BlameLine['previous'];
  for (const parent of data.parents) {
    const resolved = await resolveInParent(sb.ctx, parent, data.tree, suspect.path);
    if (resolved === undefined) continue;
    previous ??= { commit: parent, path: resolved.sourcePath };
    const { passed, kept } = splitAgainstParent(remaining, diffLines(resolved.blob, suspect.blob));
    schedule(sb, parent, resolved.sourcePath, resolved.date, resolved.blob, passed);
    remaining = kept;
  }
  finalize(sb, suspect, data, childLines, remaining, previous);
};
```
Rework the loop body:
- `resolved === undefined` → `continue` (unchanged).
- `previous ??= { commit: parent, path: resolved.sourcePath }` (unchanged — set on
  **any** resolved parent, including TREESAME; a `treesame` hit has `sourcePath === path`,
  a direct hit, matching git's `previous <oid> <path>`).
- `resolved.kind === 'treesame'` → `passed = remaining`, `kept = []`, and the
  scheduled parent blob is `suspect.blob` (identical), scheduled oid is
  `suspect.blobId`. i.e. `schedule(sb, parent, resolved.sourcePath, resolved.date, suspect.blob, suspect.blobId, remaining)`;
  `remaining = []`.
- `resolved.kind === 'changed'` → today's path: `splitAgainstParent(remaining, diffLines(resolved.blob, suspect.blob))`,
  `schedule(sb, parent, resolved.sourcePath, resolved.date, resolved.blob, resolved.blobId, passed)`,
  `remaining = kept`. (`resolved.blobId` is the `changed` variant's threaded oid from
  step 4/5 above — parent-entry id for a direct hit, renamed-source `blobId` for a
  rename.)
- Call `resolveInParent(sb.ctx, parent, data.tree, suspect.path, suspect.blobId)`
  (the suspect blob oid is the new 5th arg).
- **Short-circuit:** after updating `remaining`, `if (remaining.length === 0) break;`
  — scenario C's decisive pin (a first-parent TREESAME consumes all lines; the SIDE
  parent is never descended). This is **behaviour-preserving**: `splitAgainstParent([], anyDiff)`
  is `{ passed: [], kept: [] }` and `schedule(…, [])` is a documented no-op (L361:
  empty entries → return). The `break` is a **timing-only equivalent mutant** (see
  mutation notes).

**Behaviour-preservation (design "Behaviour-preservation argument"):** on a TREESAME
parent, `diffLines(identical, identical)` yields one all-common hunk;
`splitAgainstParent(remaining, allCommon)` returns `{ passed: remaining, kept: [] }`
with `sourceStart` unchanged (identity remap). The skip computes the same
`passed`/`kept`, schedules the same suspect with the same blob + date, sets the same
`previous`. Identical scoreboard ⇒ identical porcelain.

**Existing equivalent-mutant comments to CARRY FORWARD VERBATIM** (do not renumber
or reword): the `count === 0` guards in `seedWorkingTree` (L157-159) and `seed`
(L230-231), and the empty-entries guard in `schedule` (L359-360). Add a NEW
equivalent-mutant comment for the short-circuit `break` (see below).

**New interop goldens** (`test/integration/blame-interop.test.ts`) — the harness:
`makeRepo(slug)` (git init, deterministic identity), `commitContent(dir, file, content)`
(bumps `clock`, writes, `git add -A`, `git commit` with `datedEnv`), `git(dir, ...)`
raw-git spawn, `renderPorcelain(result)`, `gitPorcelain(dir, file, ...flags)` =
`git blame --porcelain HEAD -- <file>`. Repos are built once in `beforeAll` (60s
`SETUP_TIMEOUT`); add two new repos to the `beforeAll` block + two new fixture holders
alongside `linear`/`prepend`/`merged`/`renamed`/`worktree`, and register them in the
`afterAll` `rm` list.
1. **Deep-ancestry unchanged file (scenario A):** build a repo where `stable.txt` is
   committed once, then a **sibling** file (`churn.txt`) is committed ~6+ times (so
   `stable.txt` is unchanged across a deep span). Assert
   `renderPorcelain(await blame(ctx, 'stable.txt'))` equals
   `gitPorcelain(dir, 'stable.txt')`. Pins: all `stable.txt` lines blame the deep
   root; `previous` correct; content survives unchanged to the root.
2. **`-s ours` first-parent-TREESAME merge (scenario C):** base commits `f.txt`;
   branch `side` edits `f.txt`; back on `main` edit `f.txt`; merge `side` with
   `git merge -s ours -q --no-edit` (raw `git(dir, 'merge', '-s', 'ours', '-q', '--no-edit', 'side')`
   under `datedEnv(clock)` — mirror the existing `merged` repo's `runGit([... 'merge' ...], { env: datedEnv(clock) })`).
   The merge tree == main tree (so `f.txt` is TREESAME to the first parent; the SIDE
   edit is invisible). Assert bytes == `gitPorcelain(dir, 'f.txt')`.

**Focused unit kills** (`blame.test.ts`) — two isolated tests for the `entry.id === suspect.blobId`
`===` (the whole skip):
- **Changed-file** (kills `=== → !==`, and "skip fires on a non-equal oid"): a suspect
  whose parent blob **differs** must go through the diff and keep the differing line
  at the child. The existing "modifies one line" linear case (L60) already covers
  this end-to-end (line2 blamed at c2, not passed to c1) — confirm it stays green;
  optionally add a sharper assertion.
- **TREESAME** (kills "skip does not fire"): a suspect whose parent entry oid is
  **equal** passes all lines to the ancestor. The existing "file first added by a
  non-root commit" (L228) + linear unchanged-line-1/3 cases cover this; the new
  deep-ancestry golden is the decisive end-to-end kill.

### TDD steps

This is waste-elimination on already-TREESAME-correct code, so no test can go RED on
**output** before the change (the output is already correct). The genuine RED is the
**type system** (incomplete oid threading + non-exhaustive `kind` switch); the new
goldens + kill-tests are the pins that keep the bytes byte-identical AND prove the
`===` direction survives the mutation phase.

**RED:**
1. Add the `Suspect.blobId` field and the discriminated `ResolvedParent` union +
   the reworked `resolveInParent`/`processSuspect` skeleton. `npm run check:types`
   goes RED: `blobId` missing at the three `schedule` sites, `resolveInParent`'s new
   5th param unpassed, the `resolved.kind` switch non-exhaustive. This is the driving
   RED — the type errors enumerate every site the threading must reach.
2. Add the two interop goldens (deep-ancestry + `-s ours`) to `blame-interop.test.ts`
   and the changed-file + TREESAME focused unit assertions to `blame.test.ts` (see
   Context "Focused unit kills"). These pass on the finished GREEN; they are
   **regression pins** (bytes unchanged) and **mutation kills** (the changed-file test
   fails if `=== → !==` makes a differing parent wrongly skip; the deep-ancestry
   golden fails if the skip never fires and content is corrupted at the root).

**GREEN:** implement (a) `blobId` threading + `blobEntryAtPath`, (b) discriminated
`resolveInParent` (pass the suspect blob oid in), (c) `processSuspect` branch +
short-circuit + the carried-forward + new equivalent-mutant comments. `check:types`
green; run `blame.test.ts` + `blame-interop.test.ts` (incl. the two new goldens) —
all byte-identical green.

**REFACTOR:** keep functions <20 lines (extract the `treesame`/`changed` branch if
`processSuspect` grows); ensure the `kind` switch is exhaustive; confirm the new
`break` carries an equivalent-mutant comment worded as: removing it re-reads
remaining parents but `schedule([])` is a no-op → identical bytes (timing-only). Do
NOT write a contrived kill for the `break` (design mutation plan: accept equivalent).

### Gate

`npx vitest run test/unit/application/commands/blame.test.ts test/integration/blame-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/blame.ts test/unit/application/commands/blame.test.ts test/integration/blame-interop.test.ts`

### Commit

`perf(blame): skip the parent blob read and diff on a TREESAME tree entry`

## Part 4 — `lookupPackIndex` inner-loop allocation shave (finding 4, log)

### Context

**Goal.** Replace `compareShaAtIndex`'s per-iteration `subarray` + `compareBytes`
with an in-place byte comparison over `index._bytes`, returning the identical
comparison sign — removing the heap allocation on every binary-search step. Identical
converged index ⇒ identical offset (or `undefined`) for every id. Independent of
Parts 1–3.

**File to change:** `src/domain/storage/pack-index.ts`. Current `compareShaAtIndex`
(L85–89):
```ts
function compareShaAtIndex(index: PackIndex, i: number, targetBytes: Uint8Array): number {
  const offset = IDX_SHA_TABLE_OFFSET + i * IDX_SHA_LENGTH;
  const sha = index._bytes.subarray(offset, offset + IDX_SHA_LENGTH);   // (!) allocates a view per call
  return compareBytes(sha, targetBytes);
}
```
Constants in scope: `IDX_SHA_TABLE_OFFSET = 1032`, `IDX_SHA_LENGTH = 20`.
`compareBytes` (`../objects/encoding.js`) is the total-order byte compare being
reproduced.

**Target shape** (in-place, identical sign — mirror `compareBytes`'s ordering:
first differing byte's `a[k] - b[k]`, else 0):
```ts
function compareShaAtIndex(index: PackIndex, i: number, targetBytes: Uint8Array): number {
  const base = IDX_SHA_TABLE_OFFSET + i * IDX_SHA_LENGTH;
  const bytes = index._bytes;
  for (let k = 0; k < IDX_SHA_LENGTH; k += 1) {
    const diff = bytes[base + k]! - targetBytes[k]!;
    if (diff !== 0) return diff;
  }
  return 0;
}
```
Verify `compareBytes`'s exact ordering first (read `src/domain/objects/encoding.ts`
L37+) and reproduce its sign convention (byte-value subtraction is the standard —
confirm it does not do length-first or a different tie-break; the two operands here
are both length-20 so length is equal).

**Guard-rails (design "Two guard-rails"):**
1. **Do NOT touch L120-121** (the `lo` fanout-narrowing `Stryker disable next-line
   ConditionalExpression` equivalent-mutant comment on `lookupPackIndex`) nor
   **L161-162** (the twin comment on `findByPrefix`). The shave is inside the
   comparison, not the `lo`/`hi` window — those proofs stay verbatim.
2. **Scope: only `compareShaAtIndex`.** `findLowerBound` (L190) / `findUpperBound`
   (L204) also call it (via `findByPrefix`); they inherit the in-place compare as a
   drop-in with the identical contract — no behaviour change, no new branch, no new
   refusal.

**Pinned tests (stay green, UNCHANGED assertions):**
`test/unit/domain/storage/pack-index.test.ts` — `lookupPackIndex` cases: existing-id
(L214), non-existent-id (L230), 0x00 fanout edge (L249), 0xFF fanout edge (L265),
large-offset MSB (L281); `findByPrefix` cases (L299+); the **property tests**
(L972–1008): "build index → look up each entry → identical offset" (L975) and
"any ObjectId not in the index → undefined" (L992). These already fully exercise the
in-place loop's decision points (deep binary search → many `cmp<0` iters,
non-existent → `cmp` never 0, fanout edges). Also `test/unit/domain/storage/arbitraries.ts`
provides `buildTestIndex`, `arbObjectId`, `TestIndexEntry`.

### TDD steps

**RED:** the existing `pack-index.test.ts` lookup + property tests are the pin. To
get a strict RED, hand-apply a wrong-sign mutant (e.g. `return -diff`) mentally /
temporarily and confirm the deep-bucket + property tests catch it (a wrong sign
mislands the search → wrong/`undefined` offset). The honest framing: this is a
behaviour-preserving shave, so the acceptance is "existing suite stays green with
unchanged assertions". No NEW test is needed — the property test already asserts the
exact identical-offset invariant the shave must preserve.

**GREEN:** replace `compareShaAtIndex`'s body with the in-place loop. Run
`pack-index.test.ts` — all green, unchanged.

**REFACTOR:** confirm no `subarray`/`compareBytes` reference remains in
`compareShaAtIndex`; confirm the `compareBytes` import is still used elsewhere in the
file (`findByPrefix`/`allObjectIds` use `bytesToHex`, not `compareBytes` — grep: if
`compareBytes` is now unused, remove the import; biome flags unused imports). Confirm
L120-121 / L161-162 comments are byte-identical to `main`.

### Gate

`npx vitest run test/unit/domain/storage/pack-index.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/pack-index.ts`

### Commit

`perf(pack-index): compare index SHAs in place to drop the per-iteration subarray`

## Part 5 — Regenerate the perf baseline + add a deep-ancestry blame bench (DC-8)

### Context

**Goal (docs/artifact-only — no `src/` delta, legitimately standalone).** After
Parts 1–4 land, regenerate the committed perf baseline so blame's shares reflect the
new state (ADR-475 moving-baseline policy — **direction, not magnitude**, is the
gate; using the existing policy, no new ADR), and add a `test/bench` deep-ancestry
blame scenario whose before(main)/after(branch) wall-clock ms goes in the PR body
(the self-share drop is Amdahl-fragile — confirm the win with absolute wall-clock).

**Baseline regeneration.** `npm run profile` (mechanism: `tooling/profile.ts` +
`tooling/profile-registry.ts`; `blame` is already a registered read workload at
`profile-registry.ts` L199–206 — `MEDIUM_FIXTURE`, `HEAVY_READ_ITERATIONS = 2`,
`repo.blame(BLAME_TARGET)`). Regenerate and commit `docs/perf/baseline.json` +
`docs/perf/baseline.md` (both exist). Expected shifts (design "Perf pinning plan"):
- `blame`: `flattenTree`/`walkTree`/`walkInternal` **collapse** (no whole-tree
  flatten); `parseTreeContent` drops sharply; share moves onto
  `parseRequiredFields`/commit reads (irreducible O(depth) ancestry).
- `log`: `lookupPackIndex` share **drops** (no per-iteration `subarray`).
- `show`: `walkInternal` + `parseTreeContent` **unchanged** (no lever ships there —
  a moved `show` share would signal an unintended shared-parser edit → treat as a
  regression, investigate before committing the baseline).
The `generatedOn` banner is metadata, never compared (ADR-475).

**Deep-ancestry bench.** Add `test/bench/blame-deep-ancestry.bench.ts` following the
existing bench pattern (`test/bench/log.bench.ts` is the reference):
`benchScenario(given, whenThen, build)` from `./support/bench-dsl.js`; `build`
returns `{ sut }` (tsgit-only — no isomorphic-git baseline needed; the DSL's
`baseline` is optional, and this bench measures tsgit-vs-tsgit across branches, not
vs isomorphic-git). Build a fixture repo where a `stable.txt` is committed once then
a sibling file churns for N commits (the O(depth) unchanged-file case — the brief's
15-min scenario in miniature). `sut = async () => { await repo.blame('stable.txt'); }`.
Reuse the fixture style in `test/bench/fixtures.ts` (`openRepository`, `repo.init`,
`repo.add`, `repo.commit` with the deterministic `AUTHOR`; write a new
`setupDeepAncestryRepo` helper there, or inline the loop in the bench's `build`).
The before/after run is a manual two-branch comparison (checkout main → run bench →
checkout branch → run bench → quote both ms in the PR body); the bench file itself is
committed as the reusable measurement harness.

**Fold-or-split decision (DC-8):** this is its own `chore(perf)` / `test(bench)`
commit — it is a real artifact update (regenerated baseline + a new bench file) with
no `src/` delta, so it does not fold into a code part. Land it LAST (it measures the
landed state of Parts 1–4).

### TDD steps

This is a docs/artifact part — no RED/GREEN/REFACTOR feature cycle. Steps:
1. Run `npm run profile` (all commands, or at least `blame`/`log`/`show`) after
   Parts 1–4 are on the branch; regenerate `docs/perf/baseline.json` + `.md`.
2. Sanity-check the direction: `blame` tree-walk shares down, `log`
   `lookupPackIndex` down, `show` unchanged. If `show`'s `parseTreeContent` moved,
   STOP and investigate (an unintended shared-parser edit) before committing.
3. Add `test/bench/blame-deep-ancestry.bench.ts`; run
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/blame-deep-ancestry.bench.ts`
   (the project's bench runner is `npm run test:bench` → `vitest bench --run --config
   vitest.bench.config.ts`) to confirm it executes and produces a tsgit timing (bench
   files are not part of `validate`'s test run — verify it runs standalone).
4. Capture before(main)/after(branch) ms for the PR body (manual two-checkout run).

### Gate

`npx vitest bench --run --config vitest.bench.config.ts test/bench/blame-deep-ancestry.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/blame-deep-ancestry.bench.ts`
(`docs/perf/baseline.{json,md}` are generated artifacts — no lint; the phase-boundary
`npm run validate` covers the full tree.)

### Commit

`chore(perf): regenerate the blame baseline and add a deep-ancestry blame bench`
