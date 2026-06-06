# Plan — `UnmergedEntry` worktree mode

TDD sequence. One slice = one atomic commit. `npm run validate` green before each
commit. Governed by ADR-269 (extends `worktree` from `ChangedPath` to
`UnmergedEntry`); see `design/unmerged-entry-worktree-mode.md`.

## Slice 1 — `worktree` mode on `UnmergedEntry` (feat)

**Red**

In `test/unit/application/commands/status.test.ts`, extend the `status — unmerged
column` describe with two cases under a `Given a conflicted index` context:

1. `When the conflicted file is present on disk / Then the entry carries a
   worktree side with the on-disk mode` — reuse `seedConflict()` (leaves
   `file.txt` with conflict markers on disk). Assert
   `sut.unmerged[0]?.worktree?.mode === '100644'`, and the stages
   (`base`/`ours`/`theirs`) still present.
2. `When the conflicted file is absent on disk / Then the worktree side is
   omitted` — `seedConflict()`, then
   `await ctx.fs.rm(`${ctx.layout.workDir}/file.txt`)`, then `status`. Assert
   `sut.unmerged[0]?.worktree` is `undefined`, `base`/`ours`/`theirs` still
   present, `path === 'file.txt'`.

Run: `npx vitest run test/unit/application/commands/status.test.ts` → both fail
(`worktree` not on the type / always undefined).

**Green** — in `src/application/commands/status.ts`:

- Add `import { deriveWorkingMode } from '../../domain/objects/index.js';`
  (merge into the existing objects import; `FileMode` already imported).
- Add `readonly worktree?: WorktreeSide;` to `interface UnmergedEntry` with a
  doc comment (`mW — on-disk mode, omitted when absent`).
- Add the lean helper:
  ```ts
  const readWorktreeMode = async (
    ctx: Context,
    path: FilePath,
  ): Promise<FileMode | undefined> => {
    const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${path}`).catch(() => undefined);
    return stat === undefined ? undefined : deriveWorkingMode(stat);
  };
  ```
- Add the scan pass (mirrors `scanWorkingTree`'s `Promise.all` fan-out, no
  tracker):
  ```ts
  const scanUnmergedWorktree = async (
    ctx: Context,
    unmerged: ReadonlyMap<FilePath, UnmergedEntryGroup>,
  ): Promise<Map<FilePath, FileMode>> => {
    const map = new Map<FilePath, FileMode>();
    await Promise.all(
      [...unmerged.keys()].map(async (path) => {
        const mode = await readWorktreeMode(ctx, path);
        if (mode !== undefined) map.set(path, mode);
      }),
    );
    return map;
  };
  ```
- Thread it through `status()`:
  ```ts
  const unmergedWorktreeModes = await scanUnmergedWorktree(ctx, grouped.unmerged);
  ...
  const unmerged = toUnmergedEntries(grouped.unmerged, unmergedWorktreeModes);
  ```
- Extend `toUnmergedEntries`'s signature with
  `worktreeModes: ReadonlyMap<FilePath, FileMode>`; inside the loop bind
  `const worktreeMode = worktreeModes.get(path);` once and spread (no `!`
  escape):
  ```ts
  ...(worktreeMode !== undefined && { worktree: { mode: worktreeMode } }),
  ```

Run the test file → green. Then `npm run validate` → green.

**Commit:** `feat(status): carry conflicted-path worktree mode on UnmergedEntry`

## Slice 2 — full v2 `u`-line interop reconstruction (test)

**Red/extend** — in `test/integration/status-interop.test.ts`:

- Add a `u`-line emitter and fold unmerged lines into the v2 tracked section,
  sorted with ordinary lines by path:
  ```ts
  const unmergedV2Line = (u: UnmergedEntry): string => {
    const m1 = u.base?.mode ?? '000000';
    const m2 = u.ours?.mode ?? '000000';
    const m3 = u.theirs?.mode ?? '000000';
    const mW = u.worktree?.mode ?? '000000';
    const h1 = u.base?.id ?? ZERO_OID;
    const h2 = u.ours?.id ?? ZERO_OID;
    const h3 = u.theirs?.id ?? ZERO_OID;
    return `u ${CONFLICT_XY[u.kind]} N... ${m1} ${m2} ${m3} ${mW} ${h1} ${h2} ${h3} ${u.path}`;
  };
  ```
  Restructure `reconstructV2` to build tracked `{ path, line }` for **both**
  `s.changes` (ordinary `1` lines) and `s.unmerged` (`u` lines), sort by path
  (byte order — `comparePaths` or default ASCII sort), then append untracked
  `?` lines. The existing `v2-mixed` (no conflicts) output is unchanged.
- Import `UnmergedEntry` type into the test.
- Add two tests under a new `describe('status interop — porcelain v2 unmerged')`:
  1. `Then a conflicted merge reconstructs git status --porcelain=v2 (u-lines, mW present)`
     — `conflictRepo('v2-unmerged')`; assert
     `reconstructV2(await statusCmd(ctx)) === gitPorcelainV2(dir)`.
  2. `Then a conflicted file removed from disk reconstructs git v2 (mW=000000)`
     — `conflictRepo('v2-unmerged-absent')`, `await rm(path.join(dir, 'both-mod.txt'))`,
     then assert byte-equality. Exercises the absent-`mW` path.

Run: `npx vitest run test/integration/status-interop.test.ts` → the new tests
fail before Slice 1 lands (they're added after, so they should pass; if authored
first, they fail on missing `worktree`). Since Slice 1 already shipped, these
pass immediately — this slice is the byte-faithfulness pin.

Then `npm run validate` → green.

**Commit:** `test(status): pin full porcelain-v2 u-line reconstruction`

> Note: Slices 1 and 2 may be squashed if validate is run once; kept separate so
> the feature commit and the interop pin are atomic and can be reverted on their
> own.

## Slice 3 — docs (docs)

- `docs/use/commands/status.md`: add `readonly worktree?: WorktreeSide;` to the
  `UnmergedEntry` block (comment `// mW — on-disk mode (no oid)`), and update the
  **Unmerged paths** bullet to note the full v2 `u`-line now reconstructs
  (stages + `mW`).
- `docs/BACKLOG.md`: flip `[ ] **23.4m**` → `[x] **23.4m**`, append the
  `· ADR-269 (extends) · design/unmerged-entry-worktree-mode.md` annotation and a
  one-line summary.

`npm run validate` (covers `check:doc-typedoc` → regenerates `reports/api.json`;
commit the regenerated file).

**Commit:** `docs(status): document UnmergedEntry worktree mode; close 23.4m`
(api.json regen folded into the feat or docs commit per the prepush gate).

## Review / refactor / mutation (workflow steps 6–8)

- **Review ×3** — typescript / security / tests over `git diff main...HEAD`.
- **Architecture pass** — candidate: is `readWorktreeMode` (lstat +
  `deriveWorkingMode`, undefined if absent) a rule-of-three extraction? Survey
  `blame.ts`, `add.ts`, `compareWorkingTreeDelta` — they need the **raw stat**
  (content read, symlink branch), not just the mode, so likely a no-op with
  written justification. Decide in the pass.
- **Mutation** — `./node_modules/.bin/stryker run --mutate src/application/commands/status.ts`;
  kill survivors on the new lines or document provable equivalents inline.
