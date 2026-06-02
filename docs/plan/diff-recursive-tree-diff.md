# Plan — recursive tree-diff (shared patch path)

TDD sequence, one atomic commit per slice. `npm run validate` green before every
commit. Per ADR-243: patch always recurses; public `DiffOptions.recursive` opts
the `tree` format in.

## Slice 1 — `flattenTree` accepts `ObjectId | Tree`

The primitive must flatten an already-resolved `Tree` without re-reading it.

- **Red** — `test/unit/application/primitives/flatten-tree.test.ts`: passing a
  `Tree` object yields the same `FlatTree` as passing its oid (nested fixture).
  (New test file if absent; otherwise add a `describe`.)
- **Green** — widen `flattenTree(ctx, treeIdOrObject: ObjectId | Tree)`; forward to
  `walkTree` (already `ObjectId | Tree`). Update the doc comment.
- **Refactor** — none expected.
- Commit: `refactor(flatten-tree): accept a resolved Tree as well as an oid`.

## Slice 2 — `diffTrees` primitive gains `recursive`

- **Red** — `test/unit/application/primitives/diff-trees.test.ts`: with
  `recursive: true`, a tree containing a sub-directory surfaces nested blobs as
  full-path `DiffChange`s (add / modify / delete / type-change, isolated tests);
  `recursive` composes with `detectRenames`; default path unchanged (sub-dir →
  single tree-entry change). Assert nested-dir patch no longer needs flattening at
  the call site.
- **Green** — add `recursive?: boolean` to `DiffTreesOptions` (`types.ts`); in the
  primitive, when set, build a full-path blob projection of each resolved side and
  run `domainDiffTrees` over the projections:
  ```ts
  const raw = options?.recursive === true
    ? domainDiffTrees(await projectBlobs(ctx, treeA), await projectBlobs(ctx, treeB))
    : domainDiffTrees(treeA, treeB);
  ```
  `projectBlobs(ctx, tree?)`: `undefined` → `undefined`; else `flattenTree` →
  `Tree` of `{ name: fullPath, mode, id }`. Keep it local to `diff-trees.ts`.
- **Refactor** — early returns, ≤20-line functions.
- Commit: `feat(diff-trees): recursive option flattens sub-trees to per-file changes`.

## Slice 3 — `diff` patch path recurses + public `recursive` flag

- **Red** — `test/unit/application/commands/diff.test.ts`: `format: 'patch'` over a
  nested directory no longer throws and renders per-file hunks; `recursive: false`
  with patch is still recursive (inert); `format: 'tree'` default → single
  tree-entry change; `format: 'tree', recursive: true` → per-file changes.
- **Green** — add `recursive?: boolean` to `DiffOptions` (documented inert-for-patch);
  `const recursive = opts.format === 'patch' || opts.recursive === true;` thread
  `recursive` into the single `diffTrees` call alongside `detectRenames`.
- **Refactor** — keep `buildPatchOptions` untouched; small option-assembly helper if
  the inline object grows.
- Commit: `feat(diff): recurse patch into sub-trees; public recursive flag (ADR semantics)`.

  (Commit subject carries no ADR/phase ref per project rule — reword to
  `feat(diff): recurse patch into sub-trees and add recursive flag`.)

## Slice 4 — `show` adopts the shared recursion

- **Red** — `show-interop` already pins the bytes; add/confirm a unit assertion in
  `test/unit/application/commands/show.test.ts` that a commit modifying a nested
  file renders per-file hunks (guards the refactor).
- **Green** — in `show.ts`, replace `commitPatch`'s local `flattenedTree` +
  `flattenTree` import with
  `diffTrees(ctx, parentTreeId?, commit.tree, { recursive: true, detectRenames: true })`;
  delete the now-dead `flattenedTree` helper.
- **Refactor** — drop unused imports (`flattenTree`, `Tree` if newly unused).
- Commit: `refactor(show): use the shared recursive tree-diff for commit patches`.

## Slice 5 — `computePatchId` recurses (latent rebase fix)

- **Red** — `test/unit/application/primitives/patch-id.test.ts`: a commit changing a
  nested file yields a stable patch-id (previously threw); two commits introducing
  the same nested change on different first-parents collide.
- **Green** — `diffTrees(ctx, parentTree, cData.tree, { recursive: true })` in
  `computePatchId` (no rename detection — raw patch-id).
- **Refactor** — none.
- Commit: `fix(patch-id): recurse into sub-trees so nested-file commits drop correctly`.

## Slice 6 — nested-directory diff interop (double-pin)

- **Red/Green** — `test/integration/diff-recursive-interop.test.ts`: build a
  nested history in real `git` + tsgit (`add a/b.txt`, modify `a/b.txt`, delete
  `a/b.txt`, deep `a/b/c.txt`); assert `diff({ format: 'patch' })` bytes equal
  `git diff --no-ext-diff --no-color` **and** a frozen golden under
  `fixtures/diff-patch/`. Skip when `git` absent (`describe.skipIf(!GIT_AVAILABLE)`).
- Generate goldens from real git output; commit the `.golden.patch` files.
- Commit: `test(diff): nested-directory patch parity against git + golden`.

## Slice 7 — API report regen

- `npm run build` then regen `reports/api.json` (the prepush gate) for the additive
  `DiffOptions.recursive` + `DiffTreesOptions.recursive` exports.
- Commit: `chore(api): regenerate api.json for diff recursive flag`.

## Validation gates (each commit)

`npm run validate` green (lint, types, unit, 100% coverage). Mutation testing in
Step 8 after the architecture pass.

## Notes / risks

- **No property-test sibling** for the recursive primitive — justified in design
  §5.1 (I/O composition over the already-property-tested `domainDiffTrees`).
- The blob projection builds a `Tree` with slash-bearing names that the serializer
  would reject; it is diff-only and never serialised (documented at the helper).
- Slice ordering puts `show` adoption (slice 4) after the primitive (slice 2) so
  `show-interop` is a live regression guard for the shared path.
