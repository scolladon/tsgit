# Design — Submodule Walk

## Goal

Expose a repository's submodules. A submodule appears in a git tree as a
**gitlink** — a tree entry with mode `160000` whose object id is the *commit*
the superproject pins. Human-readable metadata (name, url, branch) lives in a
tracked `.gitmodules` file at the tree root, in `.git/config` INI format.

This phase joins the two: walk a tree-ish, find every gitlink, attach its
`.gitmodules` metadata, and — recursively — descend into each submodule's own
tree to surface nested submodules.

Surface:

- `repo.submodules(opts?)` — tier-1 command, returns a materialised list.
- `repo.primitives.walkSubmodules(opts?)` — tier-2 primitive, the
  `AsyncIterable` the command consumes. Mirrors the `log` / `walkCommits`
  command-over-iterator pairing.

Non-goals: cloning, initialising, updating, or syncing submodules; reading the
working tree; network access. This phase is pure inspection of objects already
present on disk.

## Decisions (see ADRs)

| # | Decision |
|---|----------|
| [083](../adr/083-submodule-api-surface.md) | `submodules` tier-1 command + `walkSubmodules` primitive iterator |
| [084](../adr/084-submodule-data-source.md) | Data source is a tree-ish (default `HEAD`), not the working tree / index |
| [085](../adr/085-nested-submodule-recursion.md) | Recursion derives a child `Context` per nested submodule; gitdir at `${gitDir}/modules/<name>`; uninitialised → skipped; cycle + depth guarded; `recursive` opt-in |
| [086](../adr/086-gitmodules-ini-reuse.md) | `.gitmodules` reuses the exported `.git/config` INI section tokenizer |

## Types

### Domain-facing value — `SubmoduleEntry`

```ts
/** One submodule surfaced by a walk — a gitlink joined with its .gitmodules row. */
export interface SubmoduleEntry {
  /**
   * The `[submodule "<name>"]` subsection name from the .gitmodules of the
   * tree that contains this gitlink. Falls back to `path` when no .gitmodules
   * section matches the gitlink (a gitlink with no committed config row).
   */
  readonly name: string;
  /** Slash-joined path from the *superproject* root to the gitlink. Branded FilePath. */
  readonly path: FilePath;
  /** `submodule.<name>.url` — absent when no .gitmodules section matched. */
  readonly url?: string;
  /** `submodule.<name>.branch` — absent when the key is unset. */
  readonly branch?: string;
  /** The commit object id the gitlink pins (the tree entry's id). */
  readonly commit: ObjectId;
  /** Recursion depth: 0 for a direct submodule of the superproject. */
  readonly depth: number;
  /** Path of the containing submodule; absent for `depth === 0` entries. */
  readonly parent?: FilePath;
}
```

`name`, `url`, `branch` are plain `string` — `.gitmodules` values are free-form
and not branded. `path` and `parent` are branded `FilePath` (they name real
tree locations). `commit` is a branded `ObjectId`.

### Primitive options — `WalkSubmodulesOptions`

```ts
export interface WalkSubmodulesOptions {
  /** Tree-ish to walk. RefName or ObjectId. Default: HEAD. */
  readonly ref?: RefName | ObjectId;
  /** Descend into nested submodules' own .gitmodules. Default: false. */
  readonly recursive?: boolean;
  /**
   * Cap on recursion depth. Default: MAX_SUBMODULE_DEPTH (100). Entries at
   * exactly this depth are yielded but not recursed into; lets callers (and
   * tests) tighten the backstop without changing the constant.
   */
  readonly maxDepth?: number;
}
```

### Command shapes — `SubmodulesAction` / `SubmodulesResult`

```ts
export type SubmodulesAction = {
  readonly action?: 'list';
  /** Tree-ish, as a string. Default: 'HEAD'. */
  readonly ref?: string;
  readonly recursive?: boolean;
  /** Forwarded to `walkSubmodules.maxDepth`. Default: MAX_SUBMODULE_DEPTH. */
  readonly maxDepth?: number;
};

export type SubmodulesResult = {
  readonly kind: 'list';
  readonly entries: ReadonlyArray<SubmoduleEntry>;
};
```

A discriminated `action` (single member `'list'` today) and a `kind`-tagged
result match `reflog` / `sparseCheckout`, leaving room for future verbs
(`status`, `summary`) without a breaking signature change.

### Internal — `.gitmodules` row

```ts
/** A `[submodule "<name>"]` section reduced to the keys this phase consumes. */
interface GitmodulesRow {
  readonly name: string;
  readonly path?: string;
  readonly url?: string;
  readonly branch?: string;
}
```

## Module structure

```
src/
├── application/
│   ├── primitives/
│   │   ├── config-read.ts       (MODIFIED — rename collectSections → parseIniSections, export it + IniSection)
│   │   ├── walk-submodules.ts   (NEW — walkSubmodules primitive + .gitmodules join)
│   │   ├── types.ts             (MODIFIED — SubmoduleEntry, WalkSubmodulesOptions, MAX_GITMODULES_BYTES, MAX_SUBMODULE_DEPTH)
│   │   └── index.ts             (MODIFIED — export walkSubmodules)
│   └── commands/
│       ├── submodules.ts        (NEW — submodules command)
│       └── index.ts             (MODIFIED — export submodules)
└── repository.ts                (MODIFIED — bind submodules + walkSubmodules onto the facade)
```

No new domain module. `.gitmodules` parsing reuses the INI tokenizer already
living in the `config-read` primitive (ADR-086); `config-read` is a sibling
primitive, so `walk-submodules` importing it respects the layering
(`primitives → primitives` is allowed; `read-tree` already imports
`read-object`).

## INI tokenizer reuse (ADR-086)

`config-read.ts` already contains a complete, lenient git-config INI tokenizer:
`collectSections` joins backslash continuations, strips `#`/`;` comments
outside quotes, and emits `[section "subsection"]` headers with their
key/value entries. `.gitmodules` is byte-for-byte the same grammar.

Change: rename `collectSections` → `parseIniSections`, give it a `readonly`
public return type, and **export** it plus the section type:

```ts
export interface IniSection {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

export const parseIniSections: (text: string) => ReadonlyArray<IniSection>;
```

`parseConfigText` keeps calling it internally — behaviour and the existing
`config-read` test + mutation surface are unchanged (the function is the same
code under a new name with a wider-but-compatible export). `parseSectionHeader`
stays exported as it is today.

## `walk-submodules.ts` — contract

```ts
export async function* walkSubmodules(
  ctx: Context,
  options?: WalkSubmodulesOptions,
): AsyncIterable<SubmoduleEntry>;
```

### Algorithm — pre-order DFS

```
walkSubmodules(ctx, { ref = HEAD, recursive = false }):
  rootTree ← readTree(ctx, ref)            # peels commit/tag → tree
  yield* walkInTree(ctx, rootTree, depth=0, parent=undefined,
                    pathPrefix='', visited={ ctx.layout.gitDir }, recursive)

walkInTree(ctx, tree, depth, parent, pathPrefix, visited, recursive):
  rows ← readGitmodules(ctx, tree)         # Map<path, GitmodulesRow>, may be empty
  for entry in walkTree(ctx, tree, { recursive: true }):   # gitlinks at any depth
     if entry.mode ≠ '160000': continue
     fullPath ← join(pathPrefix, entry.path)
     row ← rows.get(entry.path)            # .gitmodules path is tree-root-relative
     yield {
       name:   row?.name ?? entry.path,
       path:   fullPath,
       url:    row?.url,
       branch: row?.branch,
       commit: entry.id,
       depth, parent,
     }
     if not recursive or depth ≥ MAX_SUBMODULE_DEPTH: continue
     childCtx ← deriveChildContext(ctx, row?.name, entry.path, visited)  # undefined ⇒ stop
     if childCtx is undefined: continue
     childTree ← tryReadTree(childCtx, entry.id)              # undefined ⇒ stop
     if childTree is undefined: continue
     yield* walkInTree(childCtx, childTree, depth+1, fullPath,
                       fullPath, visited ∪ { childCtx.layout.gitDir }, recursive)
```

`pathPrefix` and `entry.path` are both tree-root-relative: `entry.path` is the
gitlink's path *within the current tree*, `pathPrefix` the current tree's path
within the superproject. `fullPath = join(pathPrefix, entry.path)` is the
superproject-relative path; `entry.path` (not `fullPath`) is what
`deriveChildContext` joins onto the current `ctx`'s `workDir`.

Pre-order: a parent submodule is yielded before its children; siblings follow
`walkTree`'s tree order (git's sorted tree-entry order). Deterministic.

### `readGitmodules(ctx, tree)`

1. `tree.entries.find(e => e.name === '.gitmodules')`.
2. Ignore it unless `mode` is `100644` or `100755` — a `.gitmodules` that is a
   symlink, directory, or gitlink is **not** read (git's hardening against
   `.gitmodules`-as-symlink attacks). Missing entry → empty map.
3. `readObject(ctx, entry.id, { maxBytes: MAX_GITMODULES_BYTES })`; require
   `type === 'blob'`. The cap (`MAX_GITMODULES_BYTES = 1 MiB`) bounds memory
   before inflate — mirrors `MAX_GITIGNORE_BYTES`.
4. `new TextDecoder().decode(bytes)` → `parseIniSections`.
5. Keep sections with `section === 'submodule'` and a defined `subsection`.
   Reduce each to a `GitmodulesRow` (`path` / `url` / `branch`, case-insensitive
   keys — git config keys are case-insensitive). Drop rows whose `subsection`
   name is **unsafe** (see Security). Index by `row.path` into a `Map`; a row
   with no `path` key cannot be joined to a gitlink and is dropped. Two rows
   sharing one `path` (malformed `.gitmodules`) → last wins, the lenient
   `Map.set` default.

### `deriveChildContext(ctx, name, treeRelPath, visited)`

Returns a `Context` for the nested submodule's object store, or `undefined`
when recursion cannot proceed (uninitialised, cycle, unsafe name).

1. `name` undefined (gitlink with no `.gitmodules` row) → `undefined`: with no
   name there is no `modules/<name>` directory to open.
2. `name` unsafe → `undefined` (see Security).
3. `gitDir ← ${ctx.layout.gitDir}/modules/${name}` — git's "absorbed" submodule
   gitdir layout, uniform at every nesting level (a nested submodule of a
   submodule lives at `${parent.gitDir}/modules/<nested-name>`).
4. `await ctx.fs.exists(`${gitDir}/HEAD`)` is false → `undefined`
   (submodule not initialised locally; git's `--recursive` likewise skips it).
   Probed with `exists`, not a caught exception.
5. `gitDir ∈ visited` → `undefined` (cycle).
6. Otherwise return a frozen child `Context`:

```ts
const childWorkDir = `${ctx.layout.workDir}/${treeRelPath}`;
{ ...ctx,
  layout: { workDir: childWorkDir,
            gitDir,
            bare: false,
            ...(ctx.layout.homeDir ? { homeDir: ctx.layout.homeDir } : {}) },
  cwd: childWorkDir,
  promisor: undefined }   // see below
```

`treeRelPath` is the gitlink path *within the current tree*, so the join
composes correctly at every nesting level (`ctx.layout.workDir` already carries
the parent submodule's path). `workDir` is informational — read primitives
select an object store by `gitDir` alone — but is kept accurate regardless.

The child reuses every **port** (`fs`, `hash`, `compressor`, …) — ports are
gitdir-agnostic; only `layout` selects which `objects/` directory primitives
read. The `deltaCache` is reused too: it is keyed by `ObjectId`, which is
content-addressed and therefore globally unique across object stores.

`promisor` is **dropped**: the parent's promisor closes over the *parent*
`Context` and would lazy-fetch a missing nested object from the
*superproject's* remote — wrong store. A genuinely missing nested object must
surface as a miss that stops recursion, not a cross-repo fetch.

`signal` and `config` are inherited (spread) so abort and parallelism settings
propagate.

### `tryReadTree(childCtx, commitId)`

`readTree` on the pinned commit, in the child store. The submodule may be
initialised yet not have *this* commit fetched. Catch **only** `TsgitError`
with code `OBJECT_NOT_FOUND` or `FILE_NOT_FOUND` → return `undefined` (skip
recursion). Any other error rethrows — this is the narrow, code-checked catch
the codebase already uses (`reflog.tryResolve`, `config-read.readRawConfig`),
not a swallow.

### Depth guard

`MAX_SUBMODULE_DEPTH = 100`. The `visited` gitdir set already breaks true
cycles; the depth cap is a backstop against a pathologically deep (acyclic)
nest. On reaching the cap `walkInTree` yields entries at that depth but does
not recurse further.

## `submodules.ts` — command

```ts
export const submodules = async (
  ctx: Context,
  opts: SubmodulesAction = {},
): Promise<SubmodulesResult> => {
  await assertRepository(ctx);
  const ref = coerceRef(opts.ref ?? 'HEAD');         // ObjectId | RefName
  const entries: SubmoduleEntry[] = [];
  for await (const e of walkSubmodules(ctx, { ref, recursive: opts.recursive === true })) {
    entries.push(e);
  }
  return { kind: 'list', entries };
};
```

`coerceRef`: `looksLikeObjectId(s)` → `ObjectId.from(s)`, else
`validateRefName(s)` — the same containment-checked validation `reflog` applies
to a user-supplied ref string. The command materialises the iterator into an
array; the unbounded streaming form stays available as the primitive.

`assertRepository` is the only gate. The command throws **no new error code**:
a bad `ref` surfaces the existing ref/object errors from `readTree`; malformed
`.gitmodules` parses leniently (git-faithful); recursion shortfalls are normal
control flow, not errors.

## Facade wiring

`repository.ts` gains, alongside the other 18 commands:

```ts
readonly submodules: BindCtx<typeof commands.submodules>;
```

bound as `submodules: ((opts) => { guard(); return commands.submodules(ctx, opts); })`,
and under `primitives`:

```ts
readonly walkSubmodules: BindCtx<typeof primitives.walkSubmodules>;
```

bound as `walkSubmodules: ((options) => { guard(); return primitives.walkSubmodules(ctx, options); })`.

## Security

- **`.gitmodules` as a non-regular file** — read only when the tree entry mode
  is `100644`/`100755`. A symlink `.gitmodules` is ignored, closing the
  classic `.gitmodules`-points-elsewhere class of attacks.
- **Unsafe submodule names** — `name` is the only `.gitmodules` value used to
  build a filesystem path (`modules/<name>`). Reject a name that: is empty;
  is `.` or `..`; contains a `..` path segment; contains a backslash; is
  absolute (`/`-prefixed or drive-prefixed); or begins with `-`. This mirrors
  git's `submodule-config` name validation (CVE-2018-17456 lineage). An unsafe
  name disables both the `.gitmodules` join (the row is dropped — the gitlink
  still yields, `name` falling back to `path`) and recursion.
- **Path containment** — even with a name validated above, the child
  `Context` reuses the parent's bounded `FileSystem` adapter, rooted at the
  superproject `workDir`. `${gitDir}/modules/<name>` resolves inside that root;
  any attempt to escape is rejected by the adapter, caught as
  `FILE_NOT_FOUND`/`PERMISSION_DENIED`, and recursion is skipped.
- **Bounded reads** — `.gitmodules` blobs are capped at `MAX_GITMODULES_BYTES`
  (1 MiB) before inflate. Tree size is bounded by `walkTree`'s existing
  `maxEntries` / `maxDepth` guards.
- **No network** — `url` is surfaced as opaque data; it is never fetched, so
  no SSRF surface is added. The child `Context` has its `promisor` removed,
  so a nested miss cannot trigger a lazy-fetch either.
- **DoS** — recursion is bounded by the `visited` gitdir set (cycles) and
  `MAX_SUBMODULE_DEPTH` (acyclic depth).

## Testing strategy

Conventions: `Given/When/Then` titles, AAA bodies, `sut` variable, 100%
line/branch/function/statement coverage, 0 surviving mutants.

### Unit — `test/unit/application/primitives/walk-submodules.test.ts`

Memory adapter; objects seeded via `writeObject` / `writeTree` / `createCommit`.

- gitlink + matching `.gitmodules` row → entry carries name/url/branch/commit.
- gitlink with **no** `.gitmodules` row → `name` falls back to `path`,
  `url`/`branch` absent.
- `.gitmodules` row with no matching gitlink → not yielded.
- gitlink nested under a subdirectory (`libs/foo`) → found, `path` is the full
  slash-joined path.
- multiple gitlinks → tree (sorted) order.
- `.gitmodules` absent entirely → gitlinks still yielded.
- `.gitmodules` is a symlink / directory → ignored.
- `.gitmodules` with comments, `[submodule "x"]` quoting, continuation lines,
  case-varied keys (`URL`, `Path`) → parsed.
- `.gitmodules` larger than `MAX_GITMODULES_BYTES` → bounded-read error
  surfaces (assert the error `.data.code`).
- unsafe section name (`..`, leading `-`, backslash) → row dropped; gitlink
  yields with `name === path`.
- `ref` defaulting to HEAD vs. an explicit branch / commit id.
- **recursion**: nested submodule with an absorbed `modules/<name>` gitdir →
  child entries with `depth: 1`, correct `parent`, full `path`.
- recursion off by default → only `depth: 0` entries.
- nested submodule **uninitialised** (no `modules/<name>`) → parent yielded,
  no children, no throw.
- nested submodule initialised but pinned commit absent → parent yielded, no
  children (assert `tryReadTree`'s `OBJECT_NOT_FOUND` path).
- recursion **cycle** (submodule's gitdir reachable twice) → terminates,
  each gitdir visited once.
- `MAX_SUBMODULE_DEPTH` backstop.
- a non-`TsgitError` (or a `TsgitError` with an unrelated code) from a child
  read rethrows — guard-clause isolation per the mutation-resistant patterns.

### Unit — `test/unit/application/commands/submodules.test.ts`

- `submodules()` on a repo with submodules → `{ kind: 'list', entries }`.
- `assertRepository` gate — non-repo throws `NOT_A_REPOSITORY` (assert `.data`).
- `ref` / `recursive` options forwarded.
- a bad `ref` string surfaces the `readTree` ref error.
- `coerceRef`: object-id-shaped string vs. ref name — both branches.

### Unit — `test/unit/application/primitives/config-read.test.ts` (extended)

- A focused case for the now-exported `parseIniSections` proving the public
  shape (`ReadonlyArray<IniSection>`), so the rename is covered directly and
  not only through `readConfig`.

### Integration — `test/integration/submodules.test.ts`

Node adapter, real temp dirs. Build a superproject with a real
`.git/modules/<name>` absorbed submodule (seed objects directly — no network),
then assert `repo.submodules({ recursive: true })` surfaces the nested entry.
Confirms the child-`Context` gitdir resolution against a real filesystem
layout.

### Repository facade

Extend the existing facade test that asserts the bound command/primitive set
so `submodules` and `walkSubmodules` are covered, including the post-`dispose`
`REPOSITORY_DISPOSED` guard.

## Key design decisions

1. **Tree-ish source, not the index** (ADR-084). Deterministic, works in bare
   repos, and `.gitmodules`-in-a-tree is exactly "recurse into `.gitmodules`".
   The cost — a full recursive `walkTree` to locate gitlinks — is accepted;
   gitlinks can exist without a `.gitmodules` row, so the walk cannot be pruned
   to known submodule paths.
2. **Command + primitive pair** (ADR-083). Every facade member is a function;
   a bare `AsyncIterable` property would break that. `log`/`walkCommits` is the
   precedent: the command materialises, the primitive streams.
3. **Child `Context` by `layout` swap** (ADR-085). Recursion needs the nested
   submodule's object store. Ports are gitdir-agnostic, so swapping `layout`
   on a spread `Context` is enough — no adapter re-composition, no call into
   `openRepository` from a primitive (which would invert the layering).
4. **Reuse the INI tokenizer** (ADR-086). `.gitmodules` is git-config INI;
   duplicating the tokenizer would trip the duplicate-code gate and violate
   DRY. Exporting it from the sibling `config-read` primitive is the minimal,
   layering-clean move.
5. **`recursive` is opt-in, default `false`**. `git submodule status` is
   non-recursive by default; `--recursive` opts in. Git-faithful. The phase
   "covers" recursion because the capability is built and tested, not because
   it is forced on every call.
6. **No new error code**. Recursion shortfalls (uninitialised, missing commit,
   cycle) are normal states, surfaced as the *absence* of child entries —
   exactly how `git submodule status --recursive` behaves. Only `readTree`'s
   existing ref/object errors and `assertRepository`'s `NOT_A_REPOSITORY` can
   throw. An unborn `HEAD` (empty repo) propagates `readTree`'s ref error —
   consistent with `log`, which resolves `HEAD` the same way.
</content>
</invoke>
