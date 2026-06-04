# Plan — `readFileAt(rev, path)`

Per **ADR-262**: a Tier-1 command over the full `revParse` grammar, returning
`{ id, mode, content }`, built on a shared `<rev>:<path>` segment descent lifted
out of `rev-parse`. Two slices: a behaviour-preserving extraction (refactor),
then the additive command (feature).

## Pre-flight (facts pinned during design)

- `rev-parse.ts`'s `resolveTreePath` / `lookupTreeEntry` already implement the
  faithful segment descent; only `rev-parse` consumes it today.
- `rev-parse`'s `peel(baseId, 'tree')` throws `OBJECT_NOT_FOUND` for a
  `<tag→blob>:path` peel; `readTree` throws `UNEXPECTED_OBJECT_TYPE`. The peel
  must **stay** in `rev-parse` (swapping it would change an observable error).
- Commands may import commands (`show` → `revParse`) and primitives
  (`commands → primitives`). `descendTreePath` lives in
  `primitives/internal/` (the `read-commit.ts` precedent — a shared internal
  primitive helper, not barrel-exported, not bound on `repo.primitives`).
- `application/commands/index.ts` **is** a typedoc entry point → adding
  `readFileAt` + `ReadFileAtResult` regenerates `reports/api.json` (commit it).
- `TreeEntry` is `{ id: ObjectId; mode: FileMode; name: string }`; `readBlob`
  already type-guards (`UNEXPECTED_OBJECT_TYPE`) and honours `ReadObjectOptions`
  (`maxBytes` → `OBJECT_TOO_LARGE`, `verifyHash`).
- New public symbols need TSDoc (`check:doc-coverage`).

## Slice 1 — extract `descendTreePath` (refactor, behaviour-preserving)

New module `src/application/primitives/internal/resolve-tree-path.ts`:

```ts
export const descendTreePath = async (
  ctx: Context,
  rootTree: Tree,
  path: string,        // split on '/'; the final segment's entry is returned verbatim
  rev: string,         // carried only for the PATH_NOT_IN_TREE display fields
): Promise<TreeEntry> => { /* walk segments; non-tree/missing intermediate → pathNotInTree */ };
```

Semantics (lifted verbatim from `lookupTreeEntry` + the `resolveTreePath` loop):
walk `segments[0..n-2]` as intermediates — each must be present and a `tree`
(else `pathNotInTree(rev, path)`); look up `segments[n-1]` in the final tree and
return that `TreeEntry` (no blob-guard, no read of the final entry). `''.split`
yields `['']`, so an empty path looks up a missing `''` → `pathNotInTree`.

### Red

Create `test/unit/application/primitives/internal/resolve-tree-path.test.ts`
(GWT/AAA, `sut`, `buildSeededContext` + `writeObject` to build raw trees/blobs):

- `Given a root tree with a top-level file` › `When descendTreePath walks the
  name` › `Then returns the entry's { id, mode }`.
- `Given a nested tree a/b/c` › `…` › `Then returns the deep entry` (intermediate
  recursion).
- `Given a missing final segment` › `Then throws PATH_NOT_IN_TREE { rev, path }`
  (assert `data.rev` + `data.path`, not just the code — kills StringLiteral/field
  mutants).
- `Given a missing intermediate segment` › `Then throws PATH_NOT_IN_TREE`
  (**isolated** from the final-segment case — guard-isolation rule).
- `Given an intermediate segment that is a blob (file-as-directory)` › `Then
  throws PATH_NOT_IN_TREE` (the `type !== 'tree'` guard, tested independently of
  the missing-segment guard).
- `Given an executable entry` › `Then the returned mode is 100755` (mode
  passthrough).

Run `npx vitest run test/unit/application/primitives/internal/resolve-tree-path.test.ts`
→ **fails RED** (module absent).

### Green

1. Create `resolve-tree-path.ts` with `descendTreePath` as above (imports
   `readObject`, `pathNotInTree`, `Tree`/`TreeEntry` types).
2. Re-run the new test file → green.

### Refactor — rewire `rev-parse.ts`

Replace `resolveTreePath`'s inline loop + `lookupTreeEntry` with a delegation,
**keeping** `peel` and the `path === ''` shortcut:

```ts
const resolveTreePath = async (ctx, rev, path): Promise<ObjectId> => {
  const baseId = await evaluate(ctx, parseExpression(rev), rev);
  const treeId = await peel(ctx, baseId, 'tree');
  if (path === '') return treeId;
  const rootTree = await readTree(ctx, treeId);          // peeled oid is a tree → loads, no extra peel, no dead guard
  return (await descendTreePath(ctx, rootTree, path, rev)).id;
};
```

Delete `lookupTreeEntry` (now in `descendTreePath`). Confirm reads are unchanged
(`peel` reads the commit/tag chain; `readTree(treeId)` reads the root tree —
exactly what the old first `lookupTreeEntry` iteration did).

### Validate + commit

- `npm run validate` — `rev-parse`'s existing tests + the new descent tests green;
  `check:duplicates` / `check:dead-code` happy (duplication removed, no orphan).
- Commit: `refactor(primitives): extract the tree-path segment descent`.

## Slice 2 — `readFileAt` command (feature, additive)

New module `src/application/commands/read-file-at.ts`:

```ts
/** Structured result of reading a file's bytes as of a revision. */
export interface ReadFileAtResult {
  /** The addressed blob's object id. */
  readonly id: ObjectId;
  /** The file's tree-entry mode (100644 | 100755 | 120000). */
  readonly mode: FileMode;
  /** The blob's raw, verbatim committed bytes. */
  readonly content: Uint8Array;
}

/** Read a file's bytes as of a revision: `git show <rev>:<path>`, structured. */
export const readFileAt = async (
  ctx: Context,
  rev: string,
  path: string,
  options?: ReadObjectOptions,
): Promise<ReadFileAtResult> => {
  await assertRepository(ctx);
  const commitish = await revParse(ctx, rev);
  const rootTree = await readTree(ctx, commitish);
  const entry = await descendTreePath(ctx, rootTree, path, rev);
  const blob = await readBlob(ctx, entry.id, options);
  return { id: entry.id, mode: entry.mode, content: blob.content };
};
```

### Red

Create `test/unit/application/commands/read-file-at.test.ts` (seeded repo with a
real commit→tree→blobs; reuse the command fixtures / a `commit` helper):

- file at `HEAD` → `{ id, mode: '100644', content }`, `content` equals the blob;
- nested path `dir/file` → the deep blob;
- `rev` as a **short branch name** and as a **tag** → resolves (pins the
  `revParse` grammar path — the ADR-262 D1 justification a primitive would miss);
- `rev` as `HEAD~1` → the file at the parent commit;
- **directory** path → `UNEXPECTED_OBJECT_TYPE { expected:'blob', actual:'tree' }`;
- **missing** path → `PATH_NOT_IN_TREE`;
- `maxBytes` below the file size → `OBJECT_TOO_LARGE` (forwarded to `readBlob`);
- a **symlink** entry → `mode: '120000'`, `content` is the link-target bytes;
- a **gitlink** entry (submodule commit) → `UNEXPECTED_OBJECT_TYPE actual:'commit'`.

Run the file → **fails RED** (module absent).

### Green

1. Implement `read-file-at.ts` (imports `revParse`, `readTree`, `readBlob`,
   `descendTreePath`, `assertRepository`, `ReadObjectOptions`, `FileMode`,
   `ObjectId`).
2. Export from `application/commands/index.ts`:
   `export { type ReadFileAtResult, readFileAt } from './read-file-at.js';`.
3. Bind on the facade in `src/repository.ts`: add
   `readonly readFileAt: BindCtx<typeof commands.readFileAt>;` to `Repository`
   and the guarded binding
   `readFileAt: ((rev, path, opts) => { guard(); return commands.readFileAt(ctx, rev, path, opts); })`.
4. Re-run the test file → green.

### Interop — faithfulness pin

Create `test/integration/read-file-at-interop.test.ts` (cross-tool,
`skipIf(!GIT_AVAILABLE)`, scrubbed `GIT_*`, signing off — follow
`history-interop.test.ts`'s shared-`beforeAll` repo + 60s timeout shape). Build a
repo with `git`: a nested file, an executable file, a symlink, two commits. Assert:

- `readFileAt('HEAD', '<file>').content` byte-equals `git cat-file blob HEAD:<file>`;
- a nested path and a `HEAD~1`-addressed file match `git cat-file blob` too;
- `readFileAt('HEAD', '<exec>').mode === '100755'`; the symlink entry's
  `mode === '120000'` with content equal to the link target (parity via
  `git ls-tree` / `readlink`);
- a **directory** path and a **missing** path both throw where `git cat-file
  blob <rev>:<path>` exits non-zero (co-refusal).

### Validate + commit

- Regenerate the API report: run the typedoc JSON task so `reports/api.json`
  picks up `readFileAt` + `ReadFileAtResult` (huge typedoc-id diff is normal);
  stage it.
- `npm run validate` (and confirm `prepush`'s `check:doc-typedoc` would pass —
  `reports/api.json` committed).
- Commit: `feat(read-model): readFileAt(rev, path)` — command + unit + interop +
  `reports/api.json`, atomic.

## Step-9 docs touchpoints (handled in the workflow docs phase, not here)

- Flip `docs/BACKLOG.md` **23.4c** `[ ]` → `[x]` with a one-line outcome.
- `README` / `docs/use` / `docs/understand`: add `readFileAt` to the command/API
  surface listing where `show`/`catFile`/`blame` appear (read side).
