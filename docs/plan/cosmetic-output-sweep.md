# Plan — Cosmetic-output sweep (`show` + `diff`)

Design: `docs/design/cosmetic-output-sweep.md` · ADRs 250–253.

TDD per slice (Red → Green → Refactor), `npm run validate` before every commit,
one atomic conventional commit per slice. No ignore directives, no phase/ADR refs in
code.

## Typing decision (settled here, per ADR-252)

Counts attach via a generic over the diff type, so `withStat` callers get
guaranteed-present counts and the default path stays count-free:

```ts
// domain/diff
interface StatFields { readonly added: number; readonly deleted: number; readonly binary: boolean; }
type StatDiffChange = DiffChange & StatFields;
interface TreeDiff     { readonly changes: ReadonlyArray<DiffChange>; }
interface StatTreeDiff { readonly changes: ReadonlyArray<StatDiffChange>; }
const computeStatFields = (old: Uint8Array, next: Uint8Array): StatFields => …; // diffLines + isBinary
```

`diff` and `show` overload on `withStat: true` to return the `StatTreeDiff` variant.
`show`'s result union is made generic — `ShowResult<D = TreeDiff>` — so the stat path
is `ShowResult<StatTreeDiff>` without duplicating the union.

The graph/numstat **sizes** (`oldSize`/`newSize`) are NOT part of `StatFields` (they
only feed the `Bin … bytes` graph line); they live in the test reconstruction's own
richer stat record.

---

## Slice 1 — `withStat` counts foundation (additive, domain + primitive)

**Red**
- `test/unit/domain/diff/stat-fields.test.ts` — `computeStatFields(old, next)`:
  text → `{ added, deleted, binary:false }`; binary either side →
  `{ added:0, deleted:0, binary:true }`; identical → `{0,0,false}`.
- Extend `test/unit/application/primitives/diff-trees.test.ts` — `diffTrees(…, { withStat:true })`
  attaches counts on each change (add = all-added, delete = all-deleted, pure rename =
  `{0,0,false}`, mode-only modify = `{0,0,false}`); `withStat` omitted → no count fields,
  no `readBlob` calls (spy the FS / assert tree-level only).

**Green**
- `src/domain/diff/stat-fields.ts` — `StatFields`, `StatDiffChange`, `StatTreeDiff`,
  `computeStatFields` (extract `countLines` + binary check; reuse `diffLines`/`isBinary`).
  Export from `domain/diff/index.ts`.
- `src/application/primitives/types.ts` — add `withStat?: boolean` to `DiffTreesOptions`.
- `src/application/primitives/diff-trees.ts` — when `withStat`, after the domain diff,
  `materialisePatchFiles(changes)` → map each `PatchFile` through `computeStatFields`
  → return `StatTreeDiff` (changes carry counts). Overload the signature on `withStat`.

**Refactor**
- Point `domain/show/diff-stat.ts`'s `countLines` at `computeStatFields` (kill the
  duplication now; `diff-stat.ts` is deleted in slice 3 regardless).

Commit: `feat(diff): opt-in withStat line counts on tree diff`.

---

## Slice 2 — `diff` command → `TreeDiff` only

**Red**
- Rewrite `test/unit/application/commands/diff.test.ts` — `diff()` returns `TreeDiff`;
  `diff({ withStat:true })` returns counts on changes; assert the removed options
  (`format`/`contextLines`/`pathPrefix`) are gone (type-level — the test simply stops
  using them; a compile error would catch a stray reference).
- Rewrite `test/integration/diff-patch-git-parity.test.ts` + `diff-patch.test.ts` —
  reconstruct the patch from the returned `TreeDiff` via
  `renderPatch(await materialisePatchFiles(ctx, sut.changes), opts)` and assert
  byte-parity vs live `git diff` + the frozen golden (assertion moves off `sut.text`).

**Green**
- `src/application/commands/diff.ts` — drop `DiffFormat`, `PatchResult`, the overloads,
  `format`/`contextLines`/`pathPrefix`; add `withStat`; `diff()` returns `TreeDiff`
  (overload → `StatTreeDiff` when `withStat:true`). Keep `from`/`to`/`detectRenames`/
  `recursive`.
- `src/repository.ts` — simplify the `diff` binding to the new (non-format) overloads.
- `src/application/commands/index.ts` + `src/index.ts` — drop the `DiffFormat` export;
  add `StatTreeDiff`/`StatDiffChange`/`StatFields` if surfaced. **Keep the `PatchResult`
  export** — `show`'s `ShowCommitResult.patch` still surfaces it until slice 3, so
  removing it now would leave a public type referencing an unexported one.

> `renderPatch` + `materialisePatchFiles` stay in `src` (rebase/patch-id). `PatchResult`
> the *type* is still referenced by `show.ts`; its definition + export stay until slice 3
> reshapes `show` and removes the last use.

Commit: `feat(diff)!: return TreeDiff only, drop patch-text surface`.

---

## Slice 3 — `show` structured-only + `domain/show` relocation (ONE atomic commit)

`show` is the sole consumer of `domain/show/*`, so the surface change, the subsystem
deletion, the reconstruction relocation, and the interop rewrite are inseparable — any
split leaves dead rendering code and a red `validate`. This is a large but single
atomic commit.

**Red / test moves**
- New test reconstruction module `test/integration/show-render/` — `git mv` the
  rendering files out of `src/domain/show/` (pretty-*, date-*, decoration, combined-diff,
  diff-stat **graph** renderers, render-commit/tag/tree, show-stream, identity-header,
  message-indent, safe-path, strftime, git-date) into it. Also relocate the blob/ref
  *reading* logic the reconstruction needs: `internal/show-combined.ts`
  (`buildCombinedFiles` — reads parent blobs to build the combined diff) and
  `internal/show-decoration.ts` (`buildDecorationMap` — reads refs for `%d`/`%D`) move
  here too, since their output is now observable only through reconstruction. Add a
  `reconstruct(ctx, result): Uint8Array` driver mapping a structured `ShowResult` → the
  `git show` byte stream (the orchestration currently in `show.ts`'s
  `buildResult`/`toStreamNode`, incl. merge combined-diff + multi-rev de-dup +
  separators). Only `internal/show-options.ts` (option parsing for the removed flags) is
  a pure delete — the sole surviving option is `withStat`.
- Rewrite `test/integration/show-interop.test.ts` — assert `reconstruct(result)` is
  byte-identical to live `git show` across the existing matrix (commit/tag/tree/blob,
  non-trivial + octopus merges, every former format/date/decoration case becomes a
  reconstruction case).
- Rewrite `test/unit/application/commands/show.test.ts` — structured assertions only
  (commit→`commit`+`patch`/`perParent`, tag→`target`, tree→`entries`, blob→`content`,
  `withStat` counts).
- Delete `test/unit/domain/show/*` and `test/unit/application/commands/internal/show-{options,decoration}.test.ts`
  (their subjects move to `test/integration/show-render/` reconstruction coverage).
- Co-locate reconstruction unit coverage so the moved renderers keep their mutation
  score (the relocated files keep their behavior; tests follow them into `test/`).

**Green**
- Rewrite `src/application/commands/show.ts` — resolve rev(s) → `readObject` → build
  `ShowResult<D>` (commit: `CommitData` + `patch?`/`perParent` via the `diffTrees`
  primitive with `detectRenames` default-on, recursive, `withStat` threaded; tag:
  `TagData` + recursive `target`; tree: `entries`; blob: `content`). Overload on
  `withStat`. String input → `ShowResult`; array input → `ReadonlyArray<ShowResult>`.
  No `text`, no `bytes`, no `ShowOutput`.
- Delete `src/domain/show/*` remnants + `src/domain/show/index.ts` (the renderers were
  relocated to test in the prior step — ensure none remain imported by `src`).
- Delete `src/application/commands/internal/show-options.ts`; `show-combined.ts` /
  `show-decoration.ts` were relocated to the test reconstruction above.
- Remove the now-unused `PatchResult` type from `diff.ts` and its exports.
- `src/repository.ts` — new `show` binding/overloads; drop `ShowOutput`.
- `src/application/commands/index.ts` + `src/index.ts` — reshape `ShowResult` exports;
  drop `ShowOutput`/`ShowStatOptions`/`MergeDiffMode`.

**Refactor**
- Confirm zero `src` imports of `domain/show`; run knip/ts-prune (part of validate) to
  prove no dead code.

Commit: `feat(show)!: structured-only result, relocate rendering to interop tests`.

---

## Post-implementation (workflow Steps 6–9, not slices)

- **Review ×3** (typescript / security / tests) — fix-until-converged.
- **Architecture refactor** — seeded by the diff; e.g. is the diff/stat counting now
  the right home, does `materialisePatchFiles` belong beside it. May no-op (justify).
- **Mutation** — focus the relocated counting (`computeStatFields`, `diffTrees` withStat
  branch) and the reshaped `show`/`diff` commands; 0 killable.
- **Docs + PR** — `docs/use/commands/show.md`, `…/diff.md`, `docs/understand/design-decisions.md`
  (add ADRs 250–253), README "structured output" framing; regenerate + commit
  `reports/api.json` (prepush `check:doc-typedoc`); flip `BACKLOG` 23.2a `[ ]`→`[x]`;
  push `-u`; `gh pr create`.

## Validate-green invariant per slice

Slice 1 additive (green trivially). Slice 2 keeps `renderPatch`/`materialise` alive for
rebase/patch-id and reconstructs diff parity in-test. Slice 3 is atomic precisely so no
commit boundary exposes dead `domain/show` code. `npm run validate` must pass before
each commit; never `--no-verify`.
