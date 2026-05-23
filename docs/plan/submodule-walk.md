# Plan — Submodule Walk (Phase 17.5)

Derived from `docs/design/submodule-walk.md` and ADRs 083–086. TDD throughout:
each step writes the failing test first (RED), the minimal code to pass
(GREEN), then refactors. `npm run validate` before every commit.

## Slice graph

```
A (INI export) ─┐
                ├─► C (walkSubmodules primitive) ─► D (submodules command) ─► E (facade) ─► F (integration)
B (types)     ──┘
```

A and B are independent and may land in either order / in parallel. C depends
on both. D depends on C; E on C+D; F on E. C is the bulk of the work.

## Step A — export the INI tokenizer (`refactor`)

**Files:** `src/application/primitives/config-read.ts`,
`test/unit/application/primitives/config-read.test.ts`.

1. **RED.** Add to `config-read.test.ts` a `describe('parseIniSections')` with
   a case asserting the public shape: given a text with a `[section
   "sub"]` + entries + a comment + a continuation line, `parseIniSections`
   returns `ReadonlyArray<IniSection>` with the expected sections. Import
   `parseIniSections` — fails to compile (not yet exported).
2. **GREEN.** In `config-read.ts`: rename `collectSections` →
   `parseIniSections`; add and export `interface IniSection` (readonly
   `section` / `subsection` / `entries`); type `parseIniSections`'s return as
   `ReadonlyArray<IniSection>`; `export` it. Keep `MutableSection` as the
   internal builder type. `parseConfigText` keeps calling `parseIniSections`.
3. **Verify.** `config-read.test.ts` green (behaviour unchanged);
   `npm run validate` green. The `// Stryker disable` annotations move with
   their lines unchanged.

**Commit:** `refactor: export parseIniSections from config-read`.

## Step B — types and constants

**Files:** `src/application/primitives/types.ts`.

Add (no standalone test — exercised by C/D):

- `interface SubmoduleEntry` — `name`, `path` (`FilePath`), `url?`, `branch?`,
  `commit` (`ObjectId`), `depth`, `parent?` (`FilePath`).
- `interface WalkSubmodulesOptions` — `ref?: RefName | ObjectId`,
  `recursive?: boolean`.
- `const MAX_GITMODULES_BYTES = 1 * 1024 * 1024` — with a comment mirroring
  `MAX_GITIGNORE_BYTES`'s rationale.
- `const MAX_SUBMODULE_DEPTH = 100` — recursion backstop.

Folded into Step C's commit (types + their first consumer are one concept).

## Step C — `walkSubmodules` primitive (`feat`)

**Files:** `src/application/primitives/walk-submodules.ts` (new),
`src/application/primitives/index.ts`,
`test/unit/application/primitives/walk-submodules.test.ts` (new).

Internal structure of `walk-submodules.ts`:

- `isUnsafeSubmoduleName(name: string): boolean` — pure guard. Rejects empty,
  `.`, `..`, any `..` path segment, backslash, absolute (`/`-prefixed or
  drive-prefixed), leading `-`.
- `readGitmodules(ctx, tree): Promise<ReadonlyMap<string, GitmodulesRow>>` —
  find the root `.gitmodules` entry; require mode `100644`/`100755`; bounded
  `readObject` (`maxBytes: MAX_GITMODULES_BYTES`), require `blob`; decode;
  `parseIniSections`; keep `submodule` sections with a defined, *safe*
  subsection; reduce to rows (case-insensitive `path`/`url`/`branch`); index by
  `path`, last-wins.
- `deriveChildContext(ctx, name, treeRelPath, visited): Promise<Context |
  undefined>` — per ADR-085 (unsafe/undefined name, absorbed gitdir, `HEAD`
  existence probe, cycle check, frozen child spread with `promisor` dropped).
- `tryReadTree(ctx, commitId): Promise<Tree | undefined>` — `readTree`, catch
  only `TsgitError` with code `OBJECT_NOT_FOUND`/`FILE_NOT_FOUND`, else rethrow.
- `walkInTree(...)` — async generator, pre-order DFS.
- `walkSubmodules(ctx, options?)` — public async generator: `readTree` the ref
  (default `HEAD`), delegate to `walkInTree`.

### TDD order

Write `walk-submodules.test.ts` incrementally; each bullet is RED→GREEN.

1. **`isUnsafeSubmoduleName`** — one isolated case per rejected form (empty,
   `.`, `..`, `a/../b`, `a\b`, `/abs`, `C:\x`, `-flag`) and one accepting a
   normal name and a slash-containing name (`libs/foo`). Guard-clause
   isolation per the mutation-resistant patterns.
2. **Non-recursive, single gitlink + matching `.gitmodules`** — seed (memory
   adapter) a commit whose tree has a `.gitmodules` blob and a mode-`160000`
   entry; assert one `SubmoduleEntry` with name/url/branch/commit/`depth: 0`/
   `parent: undefined`.
3. **Gitlink with no `.gitmodules` row** — `name` falls back to `path`,
   `url`/`branch` absent.
4. **`.gitmodules` row with no gitlink** — not yielded.
5. **Gitlink nested in a subdirectory** (`libs/foo`) — found, `path` is the
   full path; `.gitmodules` `path = libs/foo` matched.
6. **Multiple gitlinks** — yielded in tree (sorted) order.
7. **No `.gitmodules` at all** — gitlinks still yielded.
8. **`.gitmodules` is a symlink / a directory** — ignored (no rows).
9. **`.gitmodules` parsing** — comments, quoted subsection, continuation
   lines, case-varied keys (`URL`, `Path`).
10. **`.gitmodules` over `MAX_GITMODULES_BYTES`** — assert the thrown error's
    `.data.code` (try/catch + direct assertion).
11. **Unsafe section name** — row dropped; gitlink yields `name === path`.
12. **`ref` selection** — default `HEAD`, explicit branch `RefName`, explicit
    `ObjectId`.
13. **Recursion — absorbed nested submodule** — seed a child store at
    `${gitDir}/modules/<name>` (objects + `HEAD`); `recursive: true` yields the
    nested entry with `depth: 1`, correct `parent`, full `path`.
14. **Recursion off by default** — only `depth: 0` entries.
15. **Nested uninitialised** (no `modules/<name>`) — parent yielded, no
    children, no throw.
16. **Nested initialised, pinned commit absent** — parent yielded, no
    children (exercises `tryReadTree`'s `OBJECT_NOT_FOUND` branch).
17. **Cycle** — a submodule whose gitdir is reachable twice — terminates,
    each gitdir entered once.
18. **`MAX_SUBMODULE_DEPTH`** — recursion stops at the cap (use a shallow
    constant override only if the production constant makes the test
    impractical; otherwise build to the real depth — prefer the real
    constant).
19. **Rethrow** — a child read raising a `TsgitError` with an unrelated code,
    or a non-`TsgitError`, propagates out of `walkSubmodules`.

**Verify.** `npm run validate` green; 100% coverage on `walk-submodules.ts`.

**Commit:** `feat: walkSubmodules primitive` (includes Step B's `types.ts`).

## Step D — `submodules` command (`feat`)

**Files:** `src/application/commands/submodules.ts` (new),
`src/application/commands/index.ts`,
`test/unit/application/commands/submodules.test.ts` (new).

`submodules.ts`: `SubmodulesAction` / `SubmodulesResult` types; `coerceRef`
(`looksLikeObjectId` → `ObjectId.from`, else `validateRefName`); `submodules`
calls `assertRepository`, materialises `walkSubmodules` into an array, returns
`{ kind: 'list', entries }`. Re-export `SubmoduleEntry`.

### TDD order

1. **`submodules()` on a repo with submodules** → `{ kind: 'list', entries }`.
2. **Non-repository** → `assertRepository` throws `NOT_A_REPOSITORY` (assert
   `.data`).
3. **`recursive` forwarded** — `recursive: true` yields nested entries;
   default does not.
4. **`ref` forwarded** — explicit branch.
5. **`coerceRef`** — an object-id-shaped `ref` string and a ref-name `ref`
   string, both branches; a bad ref name surfaces the validation error.

**Verify.** `npm run validate` green; 100% coverage on `submodules.ts`.

**Commit:** `feat: submodules command`.

## Step E — facade wiring (`feat`)

**Files:** `src/repository.ts`, the repository facade test
(`test/unit/repository/*` — the file asserting the bound command/primitive
set).

In `repository.ts`: add `submodules: BindCtx<typeof commands.submodules>` to
`interface Repository`; add `walkSubmodules: BindCtx<typeof
primitives.walkSubmodules>` to `Repository['primitives']`; bind both with the
`guard()` wrapper, in alphabetical position.

### TDD order

1. **RED.** Extend the facade test: `repo.submodules` and
   `repo.primitives.walkSubmodules` are functions; `repo.submodules()` returns
   a list result; after `dispose()` both throw `REPOSITORY_DISPOSED` (assert
   `.data`).
2. **GREEN.** Wire the bindings.

**Verify.** `npm run validate` green.

**Commit:** `feat: wire submodules onto the repository facade`.

## Step F — integration test (`test`)

**Files:** `test/integration/submodules.test.ts` (new).

Node adapter, real temp directory. Build a superproject and a nested
submodule with the absorbed gitdir layout (`.git/modules/<name>` with seeded
loose objects + `HEAD`) — no network. Assert `repo.submodules({ recursive:
true })` surfaces the nested entry, confirming child-`Context` gitdir
resolution against a real filesystem.

**Verify.** `npm run validate` green; `stryker run` kills every killable
mutant across the new files.

**Commit:** `test: submodule walk integration`.

## Post-implementation

- Review ×3 (code / perf / security / tests), fixing every finding each pass.
- `npm run validate` + `stryker run` green.
- Docs refresh: `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md`, `DESIGN.md` as
  applicable; flip `docs/BACKLOG.md` 17.5 `[ ]` → `[x]` with an `_Accepted:_`
  summary, inside the PR's commits.
- Push, open PR.

## Risks

- **`config-read` mutation drift.** Renaming `collectSections` could disturb a
  `// Stryker disable` line. Mitigation: the rename is a pure identifier
  change; re-run `stryker` on `config-read.ts` in Step A.
- **Memory-adapter child store.** The recursion tests need a child object
  store at `${gitDir}/modules/<name>` inside the memory FS. The memory FS is a
  flat path map shared by parent and child `Context`s, so seeding via a
  manually-built child `Context` + `writeObject` works; confirm early in
  Step C (test 13).
- **Pack registry per `Context`.** Step C assumes a child `Context` reads its
  own packs. If the pack registry is memoised per-`Context` identity, a fresh
  child object gets a fresh registry — confirm when wiring `deriveChildContext`.
</content>
</invoke>
