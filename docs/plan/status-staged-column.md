# Plan — `status` staged column (index-vs-HEAD)

TDD, one slice = one atomic commit. `npm run validate` green before each commit.
Reads `docs/design/status-staged-column.md` + ADR-254. Structured-only: `status`
returns data, no rendered line. LSP for navigation (absolute worktree paths);
edits via `Edit`/`Write`.

The domain function `diffIndexAgainstTree(index, tree)` is already built and
unit-tested — these slices wire it into `status` and feed the staged column into
`describe --dirty`.

## Slice 1 — `readHeadTree` primitive

`feat(status): readHeadTree primitive (HEAD tree as FlatTree)`

New `src/application/primitives/read-head-tree.ts`:

```ts
export const readHeadTree = async (ctx: Context): Promise<FlatTree | undefined>
```

- `resolveRef(ctx, 'HEAD')`; `.catch` → if `TsgitError` with
  `err.data.code === 'REF_NOT_FOUND'` return `undefined` (unborn HEAD), else
  rethrow.
- `undefined` → return `undefined`.
- `readObject(ctx, commitId)`; if `type !== 'commit'` throw
  `unexpectedObjectType('commit', obj.type, commitId)`.
- return `flattenTree(ctx, commit.data.tree)`.

Export from `src/application/primitives/index.ts` (alongside `flattenTree`).

**Red** `test/unit/application/primitives/read-head-tree.test.ts`:
- *Given an unborn HEAD* → `readHeadTree` returns `undefined`.
- *Given a committed HEAD with a nested tree* → returns a `FlatTree` whose
  `entries` map holds every leaf blob by full path (directory entry flattened
  away), each with `(id, mode)`.
- *Given HEAD resolving to a non-commit object* (write a blob, point a ref at it,
  symref HEAD→that ref) → throws; assert `err.data.code` is the
  unexpected-object-type code, `.data.expected === 'commit'`, `.data.actual`
  matches, isolated from the unborn guard.

Mutation-resistant: `try/catch` + direct `.data` assertions; trigger the
unborn-HEAD guard and the type guard in separate tests.

## Slice 2 — `status` staged column

`feat(status): populate staged column (index-vs-HEAD)`

Edit `src/application/commands/status.ts`:

1. Imports: `diffIndexAgainstTree` + `DiffChange` from `domain/diff`,
   `readHeadTree` from primitives.
2. Make the `readIndex` fallback a full `GitIndex` (so it types as `GitIndex` for
   `diffIndexAgainstTree`):
   `.catch(() => ({ version: 2, entries: [], extensions: [], trailerSha: new Uint8Array(0) }))`.
3. After computing `workingTreeChanges`, add the staged pass:
   ```ts
   const headTree = await readHeadTree(ctx);
   const indexChanges = diffIndexAgainstTree(index, headTree).changes.map(toStagedChange);
   ```
   (Outside the progress `try`/`finally` is fine — the staged pass does no lstat
   fan-out; keep it inside the existing `try` so a single `end` pairs the `start`.)
   Place it inside the `try` block, before building the return object.
4. `toStagedChange(change: DiffChange): ChangeEntry` — pure module-level helper.
   Two explicit guards + a residual arm (no dead `rename`/`default` branch, since
   `diffIndexAgainstTree` emits only add/delete/modify/type-change, and
   `modify`+`type-change` collapse identically per ADR-254):
   ```ts
   const toStagedChange = (change: DiffChange): ChangeEntry => {
     if (change.type === 'add') return { kind: 'added', path: change.newPath };
     if (change.type === 'delete') return { kind: 'deleted', path: change.oldPath };
     return { kind: 'modified', path: primaryPath(change) }; // modify | type-change
   };
   ```
   `primaryPath` (from `domain/diff/change-path.js`, the canonical accessor) keeps
   TS happy for the residual union without re-narrowing. Every arm is reachable:
   add/delete/modify tests below cover all three; no coverage hole, no ignore
   directive.
5. Return `indexChanges` (was `[]`) and
   `clean = indexChanges.length === 0 && workingTreeChanges.length === 0`.
6. Update the stale doc comment on `status` (drop "approximated via
   index-vs-working-tree" wording; describe the real two-column model).

**Red** additions to the status unit test (`test/unit/application/commands/status.test.ts`
— create if absent, mirroring an existing command test):
- *staged add* (file added to index, committed HEAD without it) →
  `indexChanges` has `{ kind:'added', path }`, `workingTreeChanges` empty.
- *staged modify* (HEAD has file, index has new blob, worktree == index) →
  `indexChanges` `modified`; `workingTreeChanges` empty (`M ` shape).
- *staged delete* (HEAD has file, `rm(ctx, ['a.txt'])` removes from index + disk)
  → `indexChanges` `deleted`; not untracked.
- *staged delete, still on disk* (`rm(ctx, ['a.txt'], { cached: true })`) →
  `indexChanges` `deleted` **and** `workingTreeChanges` `untracked` for the same
  path (git's `D ` + `??`).
- *ordering* — `rm(ctx,['a.txt'])` (HEAD `{a}`) then stage `z.txt`: union
  insertion order is `[z, a]` (index-only first, then tree-only), so a dropped
  `sortByPath` would yield `[z, a]`; assert `indexChanges` paths are `['a.txt','z.txt']`
  (a=deleted, z=added) — documents byte order (sort itself is domain-tested).
- *staged + worktree modify* (`MM`) → both columns carry the path.
- *unborn HEAD with staged entries* → every `indexChanges` kind is `added`.
- *clean tree* → both columns empty, `clean === true`.
- *staged-only change* → `clean === false`.

(type-change → modified is covered by the domain `diffIndexAgainstTree` test +
the `toStagedChange` mapping; add a focused mapping test if `toStagedChange` is
testable in isolation, else assert via a staged symlink-over-file scenario in the
command test if cheap; otherwise rely on the interop exclusion note in the design.)

## Slice 3 — `describe --dirty` over both columns

`fix(describe): dirty detects staged-only changes`

Edit `src/application/commands/describe.ts` `computeDirty`:

```ts
const state = await status(ctx);
return state.indexChanges.length > 0
  || state.workingTreeChanges.some((change) => change.kind !== 'untracked');
```

Remove the stale "`status` does not yet surface the staged column …" comment;
replace with a one-line note that dirtiness is `git diff-index HEAD` over both
columns, untracked excluded. Leave the `--broken` catch branch untouched.

**Red** additions to the describe unit test:
- *tagged HEAD, staged-only tracked change* → `describe({ dirty: true }).dirty === true`.
- *tagged HEAD, clean* → `dirty === false`.
- *staged change + `broken: true`* → still `dirty === true` (both flags route
  through `computeDirty`).

Trigger the staged guard (`indexChanges.length > 0`) and the working-tree guard
(`some(non-untracked)`) in **separate** tests so each `||` arm is proven alone.

## Slice 4 — cross-tool interop

`test(status): cross-tool interop for the staged column`

New `test/integration/status-interop.test.ts` (mirror `describe-interop.test.ts`:
`beforeAll` builds repos with real `git`, isolated env via `runGitEnv`, signing
off; `describe.skipIf(!GIT_AVAILABLE)`; `@proves` header).

Reconstruct `git status --porcelain` from tsgit's two columns:

```ts
const X = { added:'A', modified:'M', deleted:'D' };       // staged kinds
const Y = { added:'A', modified:'M', deleted:'D' };       // worktree kinds
// per tracked path (union of indexChanges + non-untracked workingTreeChanges,
// sorted): `${X[staged]??' '}${Y[worktree]??' '} ${path}`
// then per untracked path (sorted): `?? ${path}`
```

Assert equality with `git -C dir status --porcelain` for:
- staged add / modify / delete;
- staged-only (`M `) vs staged+worktree (`MM`);
- delete-from-index-still-on-disk (`D ` + `?? `);
- unborn HEAD (all `A`);
- clean tree (empty).

Also extend `describe-interop.test.ts`: a tagged HEAD with a **staged-only**
change reconstructs `git describe --dirty` (`-dirty`).

## Notes / order

- Slices land 1→4; each is independently green. Slice 1 has no consumer until
  Slice 2 — its unit test stands alone.
- `rm.ts` migration onto `readHeadTree` is **Step 7** (architecture pass),
  behaviour-preserving — not in these feature slices.
- No `ChangeKind` widening (ADR-254); type-change folds into `modified`.
- Backlog follow-ups (logged in Step 9): first-class `type-change`/mode `ChangeKind`
  across both columns; "Unmerged paths" reporting.
