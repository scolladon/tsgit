# Phase 14.3 — `.gitignore` evaluation + `status` untracked enumeration

## 1. Goal

Replace the §14.1 ignore stub with a real `.gitignore` evaluator and
plumb it through both `add --all` and `status`. After this phase:

- `repo.add([], { all: true })` skips paths that match the ignore
  ruleset (and prunes entire ignored directories at walk-time).
- `repo.status()` enumerates working-tree files that are **not** in
  the index — emitting them as `{ kind: 'untracked' }` ChangeEntries
  if they aren't ignored.
- Tracked-but-ignored paths (already in the index) stay tracked
  (Git's invariant).

BACKLOG §14.3 acceptance:

> `.gitignore` evaluation in `add --all` and `status` untracked-file
> enumeration.

Confirmed scope (from ADRs):

- **Sources honoured (in evaluation order, last-match-wins):**
  1. `core.excludesFile` from git config (global excludes).
  2. `.git/info/exclude` (per-clone excludes).
  3. Repo-root `.gitignore`.
  4. Nested `.gitignore` in every ancestor directory of the path.
- **Walk pruning:** `walkWorkingTree` accepts an `IgnorePredicate`
  and skips entire subtrees whose directory is ignored.
- **`status` enumeration:** `'untracked'` ChangeKind (declared but
  never emitted in §10) is now emitted for working-tree files not in
  the index AND not ignored.
- **Tracked beats ignored:** index entries are emitted normally
  regardless of ignore status. The §14.1 `seen.add(path)` order
  already encodes this; §14.3 must not regress it.

## 2. Architecture

The §14.1 `IgnorePredicate` seam is preserved; §14.3 replaces the
stub with a real evaluator (`buildIgnoreEvaluator`) and plumbs an
ignore predicate into the walker.

```
buildIgnoreEvaluator(ctx)
  ├─ readGlobalExcludes(ctx)        → loads ~/<core.excludesFile>
  ├─ readInfoExclude(ctx)           → loads .git/info/exclude
  └─ readRepoRootGitignore(ctx)     → loads <workDir>/.gitignore

walkWorkingTree(ctx, { ignore, ... })
  ├─ at each dir: readDirGitignore(dir) — caches per-dir nested rules
  └─ before recursing into dir: if ignore(dir, isDirectory=true) skip whole subtree
       before yielding leaf:    if ignore(path, isDirectory=false) drop leaf

add({ all: true }):  uses buildIgnoreEvaluator + walkWorkingTree
status():            same evaluator; on top of the existing index-driven
                     scan, fan-out walkWorkingTree to surface untracked
                     leaves NOT in the index.
```

The evaluator is an opaque object (or a `MatcherStack`) carrying a
list of `{ basedir, ruleset }` pairs sorted so that nearer-to-leaf
files win on tie. Per Git semantics, evaluation is "last matching
rule wins" across the entire stack, with each level's rules
contributing in order. This is a natural fit for `domain/ignore/match.ts`'s
existing `matches()` function.

## 3. New domain primitives

### 3.1 `MatcherStack`

```typescript
// src/domain/ignore/matcher-stack.ts
export interface IgnoreLevel {
  /** Directory (relative to repo root) where this ruleset lives. */
  readonly basedir: FilePath | '';
  readonly rules: IgnoreRuleset;
}

export const matchInStack = (
  stack: ReadonlyArray<IgnoreLevel>,
  path: FilePath,
  isDir: boolean,
): MatchResult => {
  let result: MatchResult = 'unset';
  for (const level of stack) {
    // Rules only apply if the path is within `basedir` (or basedir is '' for root-level).
    if (level.basedir !== '' && !path.startsWith(`${level.basedir}/`)) continue;
    // The path that the level's rules see is relative to basedir.
    const relative = level.basedir === ''
      ? path
      : (path.slice(level.basedir.length + 1) as FilePath);
    const r = matches(level.rules, relative, isDir);
    if (r !== 'unset') result = r;
  }
  return result;
};
```

A `MatcherStack` is built up by the application-layer evaluator and
threaded through the walk.

### 3.2 No changes needed to `parseGitignore` or `matches`

The existing parser handles the syntax. The existing `matches`
function handles a single ruleset against a single path. The
domain stays pure; composition lives in the application layer.

## 4. Application-layer additions

### 4.1 `buildIgnoreEvaluator` (factory)

```typescript
// src/application/commands/internal/build-ignore-evaluator.ts
export interface IgnoreEvaluator {
  readonly stack: ReadonlyArray<IgnoreLevel>;
  /** Cache lookup for `<dir>/.gitignore` — populated lazily during the walk. */
  readonly loadDirRules: (dir: FilePath | '') => Promise<IgnoreRuleset>;
}

export const buildIgnoreEvaluator = async (ctx: Context): Promise<IgnoreEvaluator> => {
  const base: IgnoreLevel[] = [];
  // Order matters: global → info/exclude → repo-root → (nested loaded lazily)
  const global = await readGlobalExcludes(ctx);
  if (global !== undefined) base.push({ basedir: '', rules: global });
  const info = await readInfoExclude(ctx);
  if (info !== undefined) base.push({ basedir: '', rules: info });
  const root = await readGitignore(ctx, '');
  if (root !== undefined) base.push({ basedir: '', rules: root });
  // Lazy per-directory loader — caches results.
  const cache = new Map<FilePath | '', IgnoreRuleset>();
  const loadDirRules = async (dir: FilePath | ''): Promise<IgnoreRuleset> => {
    if (cache.has(dir)) return cache.get(dir)!;
    const r = await readGitignore(ctx, dir);
    const empty: IgnoreRuleset = [];
    const resolved = r ?? empty;
    cache.set(dir, resolved);
    return resolved;
  };
  return { stack: base, loadDirRules };
};
```

### 4.2 Loader helpers

```typescript
// src/application/commands/internal/read-gitignore.ts
const MAX_GITIGNORE_BYTES = 1 * 1024 * 1024;  // 1 MiB — bounded read

export const readGitignore = async (
  ctx: Context,
  dir: FilePath | '',
): Promise<IgnoreRuleset | undefined> => {
  const path = dir === ''
    ? `${ctx.layout.workDir}/.gitignore`
    : `${ctx.layout.workDir}/${dir}/.gitignore`;
  return loadAndParse(ctx, path);
};

export const readInfoExclude = async (ctx: Context): Promise<IgnoreRuleset | undefined> =>
  loadAndParse(ctx, `${ctx.layout.gitDir}/info/exclude`);

export const readGlobalExcludes = async (ctx: Context): Promise<IgnoreRuleset | undefined> => {
  const config = await readConfig(ctx);   // already exists in config-read.ts
  const path = config.core?.excludesFile;
  if (path === undefined) return undefined;
  // path may be `~/...` → expand via ctx; or absolute → use as-is.
  const resolved = await expandUserPath(ctx, path);
  return loadAndParse(ctx, resolved);
};

const loadAndParse = async (
  ctx: Context,
  path: string,
): Promise<IgnoreRuleset | undefined> => {
  try {
    const stat = await ctx.fs.lstat(path);
    if (stat.size > MAX_GITIGNORE_BYTES) {
      throw gitignoreFileTooLarge(path as FilePath, stat.size, MAX_GITIGNORE_BYTES);
    }
    const text = await ctx.fs.readUtf8(path);
    return parseGitignore(text);
  } catch (err) {
    // FILE_NOT_FOUND → undefined (no such file is fine); other errors propagate.
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};
```

### 4.3 `walkWorkingTree` extension

```typescript
export type WalkIgnorePredicate =
  (path: FilePath, isDirectory: boolean) => boolean | Promise<boolean>;

export interface WalkWorkingTreeOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  /**
   * §14.3: prune ignored directories AND drop ignored leaves. The
   * predicate is invoked for every directory BEFORE descent and for
   * every leaf BEFORE yielding. Returning `true` skips the directory
   * subtree / leaf entirely. May be sync or async.
   */
  readonly ignore?: WalkIgnorePredicate;
}
```

In `walkInternal`, every predicate call is awaited via `Promise.resolve(...)`
so sync predicates pay no microtask penalty:

```typescript
for (const entry of entries) {
  if (config.ctx.signal?.aborted) throw operationAborted();
  if (isForbiddenGitComponent(entry.name)) continue;
  const path = joinPath(prefix, entry.name);
  validateWorkingTreePath(path);
  if (entry.isDirectory && !entry.isSymbolicLink) {
    if (await config.ignore?.(path, true)) continue;  // PRUNE whole subtree
    yield* walkInternal(config, counter, path, depth + 1, false);
    continue;
  }
  if (!entry.isFile && !entry.isSymbolicLink) continue;
  if (await config.ignore?.(path, false)) continue;    // DROP single leaf
  counter.value += 1;
  if (counter.value > config.maxEntries) {
    throw treeEntryLimitExceeded(counter.value, config.maxEntries);
  }
  const stat = await config.ctx.fs.lstat(...);
  yield { path, stat };
}
```

The §14.1 invocations pass no `ignore` option → behaviour unchanged.

### 4.4 Wiring `add --all`

§14.3 widens the `IgnorePredicate` type to also accept
`Promise<boolean>` return values (the §14.1 sync stub still satisfies
the wider type). The default predicate becomes a per-walk closure that
descends a `MatcherStack`:

```typescript
// internal/add-ignore.ts (modified)
export type IgnorePredicate =
  (path: FilePath, isDirectory: boolean) => boolean | Promise<boolean>;

export const defaultIgnorePredicate: IgnorePredicate = () => false;

// New factory:
export const buildRepoIgnorePredicate = async (ctx: Context): Promise<IgnorePredicate> => {
  const evaluator = await buildIgnoreEvaluator(ctx);
  const stack: IgnoreLevel[] = [...evaluator.stack];   // mutable per-walk copy
  const stackedDirs = new Set<string>();               // basedirs currently on the stack
  return async (path, isDirectory) => {
    // Lazy-load nested rules for every ancestor of `path` that we haven't loaded.
    for (const ancestor of ancestorsOf(path)) {
      if (stackedDirs.has(ancestor)) continue;
      const rules = await evaluator.loadDirRules(ancestor as FilePath);
      if (rules.length > 0) stack.push({ basedir: ancestor as FilePath, rules });
      stackedDirs.add(ancestor);
    }
    return matchInStack(stack, path, isDirectory) === 'ignored';
  };
};
```

`addAll` falls back to the new factory when the optional `ignore`
parameter is `undefined`. The §14.1 internal test seam (custom
predicate injection) still works unchanged.

Why a closure with a mutable stack rather than a pre-built tree? The
walker visits ancestors before descendants, so the stack grows
naturally as `path`s drill deeper. Caching by ancestor key means each
nested `.gitignore` is read at most once per call. No I/O happens for
subtrees the walker prunes (the ignore call for a pruned dir returns
`true` before its `.gitignore` would be loaded).

### 4.5 `status` untracked enumeration

Add a second pass to `status`:

```typescript
export const status = async (ctx: Context): Promise<StatusResult> => {
  // ... existing setup
  const indexByPath = ...;

  // Existing pass: index entries vs working tree.
  const settled = ...;
  const indexChanges = ...;
  const workingTreeChanges = settled.filter(...);

  // NEW: walk working tree for files NOT in the index.
  const predicate = await buildRepoIgnorePredicate(ctx);
  const untracked: ChangeEntry[] = [];
  for await (const { path } of walkWorkingTree(ctx, { ignore: predicate })) {
    if (!indexByPath.has(path)) untracked.push({ kind: 'untracked', path });
  }

  return { branch, detached, indexChanges, workingTreeChanges: [...workingTreeChanges, ...untracked], clean: ... };
};
```

The `clean` flag now considers untracked: if any non-ignored
working-tree file is not in the index, `clean = false`.

### 4.6 Error variant for oversize `.gitignore`

```typescript
// domain/commands/error.ts
| {
    readonly code: 'GITIGNORE_FILE_TOO_LARGE';
    readonly path: FilePath;
    readonly size: number;
    readonly limit: number;
  }
```

Same pattern as `WORKING_TREE_FILE_TOO_LARGE` (§14.1).

## 5. Path expansion (global excludes)

`core.excludesFile` typically lives at `~/.config/git/ignore`. The
node adapter must expand `~`/`$HOME` to the actual home directory.
The browser/memory adapters return `undefined` (no global config).

Implementation: add `ctx.layout.homeDir?: string` (optional) to
`RepositoryLayout`. The node adapter populates it via `os.homedir()`;
other adapters leave it `undefined`. `expandUserPath` throws if `~`
is present but `homeDir` is `undefined`.

ADR-033 documents this choice (alternatives: process-env lookup at
call time vs. layout-level injection — layout wins for testability).

## 6. Testing strategy

### 6.1 Domain — `matcher-stack.test.ts` (new)

1. Empty stack returns `unset`.
2. Single level at root: ruleset → match result identical to bare
   `matches()`.
3. Two levels at root: last-matching rule across both wins.
4. Level at `<basedir>`: rules apply only to paths under it.
5. Negation in inner level overrides ignore in outer.
6. `directoryOnly` rule + non-dir path: never matches.

### 6.2 Application — `read-gitignore.test.ts` (new)

7. Missing repo-root `.gitignore` → `undefined`.
8. Present + valid → parsed rules.
9. Present + oversize → `GITIGNORE_FILE_TOO_LARGE` with path/size/limit.
10. `core.excludesFile` unset → global = `undefined`.
11. `core.excludesFile` set + file present → parsed.
12. `~` expansion with `homeDir` set → resolves correctly.
13. `~` expansion with `homeDir` undefined → throws.

### 6.3 Primitive — `walk-working-tree.test.ts` (extend)

14. `ignore` skips a single leaf.
15. `ignore` prunes an entire subtree (no lstat on children).
16. Without `ignore`, behaves as §14.1.

### 6.4 Command — `add.test.ts` (extend)

17. `node_modules/foo` ignored via repo-root `.gitignore` → not staged.
18. `dist/` ignored as directory → entire tree skipped (no lstat).
19. Tracked-but-ignored file stays staged across re-add (the
    `seen.add(path)` invariant from §14.1 still holds).
20. Nested `.gitignore` adds rules for its subtree only.
21. Negation: `*.log` + `!keep.log` → `keep.log` staged.
22. `.git/info/exclude` rule honoured.

### 6.5 Command — `status.test.ts` (extend)

23. Working tree with one new file not in index → `untracked` emitted.
24. Untracked-but-ignored → NOT emitted.
25. Tracked-but-ignored → emits as modified/clean (not as untracked).
26. `clean = false` when untracked exists.
27. `clean = true` when only ignored untracked files exist.

### 6.6 Integration

`test/integration/gitignore-end-to-end.test.ts`: realistic repo with
nested `.gitignore`, `.git/info/exclude`, negation. Validates against
canonical git command output (where possible — fall back to
hand-spec for memory adapter).

## 7. Module structure

```
src/domain/ignore/
  matcher-stack.ts                 NEW
  index.ts                         export matchInStack
src/application/commands/internal/
  add-ignore.ts                    MODIFIED (AsyncIgnorePredicate + default builder)
  read-gitignore.ts                NEW
  build-ignore-evaluator.ts        NEW
src/application/commands/
  add.ts                           MODIFIED (default predicate wired)
  status.ts                        MODIFIED (untracked enumeration)
src/application/primitives/
  walk-working-tree.ts             MODIFIED (async ignore predicate)
  types.ts                         MODIFIED (WalkWorkingTreeOptions.ignore)
src/domain/commands/error.ts       MODIFIED (GITIGNORE_FILE_TOO_LARGE variant)
src/domain/error.ts                MODIFIED (extractDetail arm)
src/ports/context.ts               MODIFIED (RepositoryLayout.homeDir?)
src/adapters/node/                 MODIFIED (populate homeDir)
src/adapters/memory/               MODIFIED (homeDir undefined; settable via options)
```

## 8. Non-goals

- `git check-ignore` command (debugging tool) — defer.
- `git ls-files --others` direct equivalent — covered indirectly via
  `status` untracked.
- `.gitignore` evaluation in `clone` (filtering during checkout) —
  not how Git works; out of scope.
- Per-OS path-normalisation rules for Windows excludesFile — wait
  for §14.4 Windows support.

## 9. ADRs

- ADR-033 — `core.excludesFile` resolution: layout-level `homeDir`
  injection vs. process-env at call time.
- ADR-034 — Walk-time directory pruning: `walkWorkingTree.ignore`
  becomes async; cache nested rules per directory.
- ADR-035 — Tracked-vs-ignored invariant pinned: §14.1 `seen` order
  becomes a load-bearing contract.
- ADR-036 — Bounded `.gitignore` size: 1 MiB cap mirrors the
  pattern from §13.8/§14.1.

## 10. Acceptance checklist

- [ ] `repo.add([], { all: true })` honours repo-root + nested
      `.gitignore` + `.git/info/exclude` + global excludesFile.
- [ ] Ignored directories are pruned at walk-time (no leaf lstats).
- [ ] Tracked-but-ignored files stay tracked.
- [ ] `repo.status()` emits `{ kind: 'untracked' }` for non-indexed
      non-ignored files.
- [ ] `status.clean` reflects untracked presence.
- [ ] §14.1 literal-path `add(paths)` unchanged.
- [ ] §14.1 mutation score on touched files maintained.
- [ ] 100% line/branch/function/statement coverage holds.
- [ ] Stryker green on changed surface.
