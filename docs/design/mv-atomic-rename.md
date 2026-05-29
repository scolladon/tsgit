# Design — `mv` (atomic rename in index + working tree)

## Goal

A tier-1 `mv` command that renames/moves tracked paths, mutating **both** the
index and the working tree, faithful to `git mv`. Headline invariant: the move
is **atomic** — every (source → target) pair is validated up front; on any
refusal nothing is moved (unless `skipErrors`).

Composes on the Phase-20 foundation: index lock (`acquireIndexLock`), index
read (`readIndex`), working-tree path validation (`validateWorkingTreePath`),
and the `repo.*` facade-binding pattern used by `rm`/`add`.

## Scope

In scope (faithful to `git mv`):

- **File rename** — `mv(['a.txt'], 'b.txt')`.
- **Move into a directory** — `mv(['a.txt','b.txt'], 'dir')` → `dir/a.txt`,
  `dir/b.txt`. Directory-mode triggers on: dest is an existing directory, dest
  ends with `/`, or there is more than one source.
- **Directory rename** — `mv(['old'], 'new')` reparents every tracked
  entry under `old/` and renames the working-tree directory in one
  `fs.rename`.
- **`force`** (`-f`) — overwrite an existing destination.
- **`dryRun`** (`-n`) — validate and report, mutate nothing.
- **`skipErrors`** (`-k`) — skip bad (source → target) pairs instead of the
  default atomic abort.
- The full refusal taxonomy git emits (see Errors).

Out of scope (documented, not implemented):

- No `--verbose` (the structured `MvResult` already carries the move list).
- No submodule/gitlink (`160000`) relocation beyond a plain entry repath — v1
  has no submodule materialisation (consistent with `materializeFile`).
- No pathspec/glob expansion of sources — `git mv` takes literal paths, not
  pathspecs; sources are literal paths validated by `validateWorkingTreePath`.

## Cache-entry-copy semantics (load-bearing, verified against git)

`git mv a.txt b.txt` does **not** re-hash the working file. It renames the
working-tree file via the filesystem and **copies the source's index (cache)
entry** to the destination path — same `id` (blob), same `mode`, same stat
fields — changing only `path`. Consequence: an *unstaged* edit to `a.txt`
travels with the file to `b.txt` on disk, while the staged blob recorded at
`b.txt` is still the source's previously-staged blob.

tsgit mirrors this exactly: the destination `IndexEntry` is the source entry
with `path` replaced. No blob is written; `ctx.fs.read`/`writeObject` are never
called. This is the cheapest faithful implementation and the reason the backlog
phrases it "atomic rename in index + working tree".

## Public API

```ts
export interface MvOptions {
  /** Overwrite an existing destination (file on disk or tracked entry). `-f`. */
  readonly force?: boolean;
  /** Validate and report the plan without touching index or working tree. `-n`. */
  readonly dryRun?: boolean;
  /** Skip refused (source → target) pairs instead of aborting the whole call. `-k`. */
  readonly skipErrors?: boolean;
  /** Break a stale `index.lock` older than N ms (same contract as rm/add). */
  readonly breakStaleLockMs?: number;
}

export interface MvMove {
  readonly from: FilePath;
  readonly to: FilePath;
}

// Reasons that are *per-source* and therefore skippable under `skipErrors`.
export type MvSkipReason =
  | 'source-not-tracked'
  | 'bad-source'
  | 'destination-exists'
  | 'into-self';

export interface MvSkipped {
  readonly source: FilePath;
  readonly reason: MvSkipReason;
}

export interface MvResult {
  /** Index-entry-level moves performed (one per moved entry; a directory
   *  source expands to one MvMove per reparented entry, mirroring git's
   *  `R old -> new` status lines). Sorted by `from`. */
  readonly moved: ReadonlyArray<MvMove>;
  /** Pairs skipped under `skipErrors`. Empty unless `skipErrors` is set. */
  readonly skipped: ReadonlyArray<MvSkipped>;
}

export const mv = async (
  ctx: Context,
  sources: ReadonlyArray<string>,
  destination: string,
  opts?: MvOptions,
): Promise<MvResult>;
```

Facade binding: `repo.mv(sources, destination, opts?)` (the `Context` is bound),
identical to how `repo.rm`/`repo.add` are bound in `repository.ts`.

**Why `(sources[], destination)` and not a trailing-element array or an
overload** — fixed by ADR-200: an explicit `sources` array + separate
`destination`, uniform with `rm`/`add` taking `ReadonlyArray<string>`, and
matching the two-arg rename precedent (`branch.rename(old, new)`,
`remote.rename(old, new)`, `config.renameSection(old, new)`). A single rename
reads `mv(['a.txt'], 'b.txt')`.

## Errors

Per ADR-202, each refusal is its own **granular `CommandError` code** (callers
match a single `code`, no nested `reason` narrowing). Seven codes, each
carrying `source` and `destination` (`FilePath`):

```ts
| { readonly code: 'MV_SOURCE_NOT_TRACKED';            // git: "not under version control"
    readonly source: FilePath; readonly destination: FilePath }
| { readonly code: 'MV_BAD_SOURCE';                    // git: "bad source"
    readonly source: FilePath; readonly destination: FilePath }
| { readonly code: 'MV_DESTINATION_EXISTS';            // git: "destination exists"
    readonly source: FilePath; readonly destination: FilePath }
| { readonly code: 'MV_INTO_SELF';                     // git: "can not move directory into itself"
    readonly source: FilePath; readonly destination: FilePath }
| { readonly code: 'MV_DESTINATION_NOT_DIRECTORY';     // git: "destination 'X' is not a directory"
    readonly source: FilePath; readonly destination: FilePath }
| { readonly code: 'MV_DESTINATION_DIRECTORY_MISSING'; // git: "destination directory does not exist"
    readonly source: FilePath; readonly destination: FilePath }
| { readonly code: 'MV_MULTIPLE_SOURCES_SAME_TARGET';  // git: "multiple sources for the same target"
    readonly source: FilePath; readonly destination: FilePath }
```

The last three codes (`MV_DESTINATION_NOT_DIRECTORY`,
`MV_DESTINATION_DIRECTORY_MISSING`, `MV_MULTIPLE_SOURCES_SAME_TARGET`) are
**structural** — they describe the request as a whole, not one source pair — so
they are always thrown, never collected into `skipped`, even under
`skipErrors`. The first four are per-source and skippable; when skipped they map
into `MvResult.skipped[].reason` as the kebab-case `MvSkipReason`
(`'source-not-tracked' | 'bad-source' | 'destination-exists' | 'into-self'`) —
result *data* keeps its own vocabulary, distinct from the SCREAMING_SNAKE error
codes (ADR-202).

One factory per code in `domain/commands/error.ts`
(`mvSourceNotTracked(source, destination)`, …); one exhaustive message arm each
in `domain/error.ts`'s `extractDetail`. Messages render faithfully, e.g.:

- `MV_DESTINATION_EXISTS: destination exists, source=a.txt, destination=keep.txt`
- `MV_SOURCE_NOT_TRACKED: not under version control, source=u.txt, destination=d/u.txt`
- `MV_BAD_SOURCE: bad source, source=a.txt, destination=z.txt`
- `MV_INTO_SELF: can not move directory into itself, source=a.txt, destination=a.txt`
- `MV_DESTINATION_NOT_DIRECTORY: destination 'nope.txt' is not a directory, source=a.txt`
- `MV_DESTINATION_DIRECTORY_MISSING: destination directory does not exist, source=a.txt, destination=missing/`
- `MV_MULTIPLE_SOURCES_SAME_TARGET: multiple sources for the same target, source=a.txt, destination=d/a.txt`

(git emits two near-identical phrasings for a colliding destination —
`destination exists` from the file-rename path and `destination already exists`
from the directory path. tsgit unifies both under `MV_DESTINATION_EXISTS` with
the `destination exists` message; the `source`/`destination` data are identical,
only git's internal wording differs between code paths. Documented wording
unification, not a behavioural divergence.)

Existing codes reused: `EMPTY_PATHSPEC` (zero sources), `BARE_REPOSITORY`
(via `assertNotBare(ctx, 'mv')`), `OPERATION_IN_PROGRESS` (via
`assertNoPendingOperation`), `PATHSPEC_OUTSIDE_REPO` (via
`validateWorkingTreePath` on every source and the destination),
`RESOURCE_LOCKED` (lock contention).

**Minor, documented divergence:** for a single-source rename whose destination
*parent directory* is missing **without** a trailing slash, git lets the OS
`rename(2)` fail (`renaming 'a.txt' failed: No such file or directory`). tsgit
pre-checks the destination parent and raises the clean
`MV_DESTINATION_DIRECTORY_MISSING` instead — the *behaviour*
is identical (refuse; never auto-create destination directories), only the error
surface is the library's uniform domain error rather than a leaked OS errno.
This honours the repo's "no raw OS errors escape" invariant while preserving
git's refusal semantics. (`ctx.fs.rename` would itself throw a wrapped
`FILE_NOT_FOUND`; the pre-check makes the refusal explicit and testable.)

## Algorithm

```
mv(ctx, sources, destination, opts):
  assertRepository(ctx)
  assertNotBare(ctx, 'mv')
  assertNoPendingOperation(ctx)              // same gate as rm
  if sources.length === 0: throw emptyPathspec()
  const destRaw = destination
  validateWorkingTreePath(stripTrailingSlash(destination))   // PATHSPEC_OUTSIDE_REPO
  for s of sources: validateWorkingTreePath(s)

  lock = acquireIndexLock(ctx, breakStaleLockMs?)
  try:
    index = readIndex(ctx)                   // tolerate INDEX_MISSING_CODES → empty
    byPath: Map<FilePath, IndexEntry>
    mode = resolveDestinationMode(ctx, sources, destRaw)
      // → { kind: 'rename', target } | { kind: 'into-dir', destDir }
      //   throws destination-not-directory / destination-directory-missing
    moves: MvMove[] = []; skipped: MvSkipped[] = []
    indexOps: Array<{ del: FilePath; adds: IndexEntry[] }> = []
    fsOps: Array<{ from: FilePath; to: FilePath }> = []     // working-tree renames
    for source of sources (validated; see "duplicate sources" below):
      target = mode.kind === 'rename' ? mode.target
                                      : join(mode.destDir, basename(source))
      verdict = validateMove(ctx, byPath, source, target, opts)
        // → { ok, kind: 'file'|'directory', entries } | { skip: MvSkipReason } | throw
      if verdict.skip:
        if opts.skipErrors: skipped.push({source, reason: verdict.skip}); continue
        else: throw errorFor(verdict.skip, source, target)  // granular code per reason
      // record plan (pure; mutate maps only after the full loop succeeds)
      plan += { source, target, kind, entries }
    assertNoTargetCollision(plan)            // throws MV_MULTIPLE_SOURCES_SAME_TARGET
    if opts.dryRun:
      return { moved: plannedMoves.sort(byFrom), skipped }
    // EXECUTE — index first into the in-memory map, then working tree, then commit:
    apply plan to byPath  (delete source entries, insert repathed dest entries)
    for each plan item: fs.rename(workdir/source, workdir/target)
    lock.commit(values(byPath))
    return { moved: plannedMoves.sort(byFrom), skipped }
  finally:
    lock.release()
```

### `resolveDestinationMode`

- Directory-mode is required when `sources.length > 1` **or** `destination`
  ends with `/`.
- Probe the destination on disk (`lstat`):
  - exists and `isDirectory` → into-dir (`destDir = stripTrailingSlash(dest)`).
  - ends with `/` and not an existing dir → `destination-directory-missing`.
  - `sources.length > 1` and not an existing dir → `destination-not-directory`.
  - otherwise (single source, no trailing slash, not an existing dir) →
    rename-mode (`target = dest`). The destination *parent* dir existence is
    checked in `validateMove` (raises `destination-directory-missing`).

### `validateMove(ctx, byPath, source, target, opts)`

Order matches git's precedence (verified):

1. **classify source** — exact `byPath` entry → `file`; else any
   `${source}/`-prefixed entries → `directory`; else → `skip:'source-not-tracked'`.
2. **bad source** — `file`: `lstat(workdir/source)` must succeed and be a file
   or symlink; `directory`: `lstat(workdir/source)` must succeed and be a
   directory. Missing/wrong type → `skip:'bad-source'`.
3. **into-self** — `target === source` or `target.startsWith(source + '/')`
   (dir into itself) → `skip:'into-self'`.
4. **destination parent dir** — `dirname(target)` must exist on disk (skip when
   `dirname` is the repo root) → else throw
   `destination-directory-missing` (always thrown, never skipped — it is a
   structural error about the destination, not the source pair).
5. **destination exists** — `target` tracked in `byPath` **or**
   `lstat(workdir/target)` succeeds. `force` suppresses this **only for a file
   source**; a **directory** source is refused regardless of `force` (verified:
   `git mv -f dir existing-file` still fails "destination already exists"). So:
   `kind==='file' && force` → allowed; otherwise → `skip:'destination-exists'`.
6. Return `{ ok, kind, entries }` where `entries` are the source entries to
   repath (`[byPath.get(source)]` for a file; all `${source}/`-prefixed entries
   for a directory).

### Index reparent

- File: `byPath.delete(source)`; `byPath.set(target, {...entry, path: target})`.
- Directory: for each `e` with `e.path === source || e.path.startsWith(source+'/')`:
  `newPath = target + e.path.slice(source.length)`; delete old, set repathed.
  The directory's own working-tree rename is a single `fs.rename(source, target)`
  (moves tracked **and** untracked contents, faithful to git).

### Working-tree rename

`renameInWorkingTree(ctx, from, to)` in `internal/working-tree.ts`: validates
both paths, then `ctx.fs.rename(workdir/from, workdir/to)`. For a directory
source, one rename moves the whole subtree. For multiple file sources into a
dir, one rename per source.

### Target collisions (no dedup — verified against git)

git does **not** de-duplicate sources. Two sources that map to the same target
(`mv(['a.txt','a.txt'], 'dd')` → both `dd/a.txt`; or `mv(['x/f','y/f'],'dd')`)
are refused with `multiple sources for the same target`. After planning every
(source → target) pair against the **original** `byPath`, a pass detects any two
moves sharing a `to` and throws `MV_MULTIPLE_SOURCES_SAME_TARGET` (structural —
always thrown). Note that `mv(['a.txt','a.txt'], 'b.txt')` never reaches this
check: two sources force dir-mode, and `b.txt` not being a directory raises
`MV_DESTINATION_NOT_DIRECTORY` first — matching git's precedence exactly.

### Helpers

`basename` already exists (`domain/error.ts`, `@internal`). A sibling
`dirname(path)` (everything before the last `/`, or `''` for a root-level path)
is added next to it — both are pure, shared, and unit-tested.

### Security

Every source and the destination pass `validateWorkingTreePath` (rejects `..`,
absolute, `\`, NUL, `.git`, control chars, `:` ADS). Containment to `workDir` is
enforced by the facade's `wrapFsValidator`. `ctx.fs.rename` operates on the link
itself (never follows a symlink leaf), so a symlinked source/target relocates
the link, not its target. The security-review pass verifies the rename path gets
the same ancestor-symlink containment the write path documents; if the adapter's
`rename` lacks it, that is surfaced there before commit.

**Execution order** — index map is mutated in memory first (cannot fail), then
working-tree renames, then `lock.commit`. If an fs.rename throws mid-loop
(e.g. an adapter race), the lock is released by `finally` **without commit**, so
the on-disk index is untouched — but some working-tree renames may already have
happened. This matches git's own non-transactional working-tree behaviour
(git also performs renames sequentially). The atomicity guarantee is about
*validation* (all-or-nothing planning), not crash-atomic filesystem moves —
documented explicitly so the test/security review does not flag it as a hidden
partial-write.

## Module layout

```
src/application/commands/mv.ts                 # new — the command
src/application/commands/internal/working-tree.ts   # +renameInWorkingTree
src/domain/commands/error.ts                   # +7 granular MV_* variants + factories
src/domain/error.ts                            # +7 MV_* message arms
src/application/commands/index.ts              # export { mv, MvOptions, ... }
src/repository.ts                              # Repository.mv binding + interface
```

Browser/parity surface: add `mv` to the namespace-aware browser-surface audit
list (PR #90 infra) and ship a parity scenario alongside `reset-rm-reflog`.

## Testing strategy

Unit (`test/unit/application/commands/mv.test.ts`), GWT describe/it + AAA +
`sut`, 100% line/branch/function, mutation-resistant (specific `.data`
assertions via try/catch, isolated guard tests):

- file rename: index repathed (same blob), working file moved, old gone.
- cache-entry copy: unstaged edit to source ⇒ dest working content = edited,
  dest index blob = source's staged blob (the headline invariant).
- move into existing dir (single + multi source) → `dir/basename`.
- directory rename: all `dir/*` entries reparented; untracked file in dir moves.
- `force`: overwrite tracked dest; overwrite on-disk untracked dest (file
  source). Directory source over an existing file is refused **even with
  `force`** (`destination-exists`).
- each refusal reason in isolation (own test, asserting `.data.reason`,
  `.data.source`, `.data.destination`): source-not-tracked, bad-source,
  destination-exists (tracked + on-disk), into-self (`a→a` and `dir→dir/sub`),
  destination-not-directory (multi-source), destination-directory-missing
  (trailing slash + missing parent on rename),
  multiple-sources-for-same-target (two sources → one dir target).
- `dryRun`: returns the plan, mutates nothing (index + working tree unchanged).
- `skipErrors`: bad pairs land in `skipped`, good ones move; mixed batch.
- atomic abort (no skipErrors): one bad source ⇒ no working-tree mutation, index
  unchanged, throws.
- empty sources → `EMPTY_PATHSPEC`; bare repo → `BARE_REPOSITORY` (operation
  `'mv'`); pending op → `OPERATION_IN_PROGRESS`; source/dest path escape →
  `PATHSPEC_OUTSIDE_REPO`.
- lock: `breakStaleLockMs` breaks a stale lock; held lock → `RESOURCE_LOCKED`;
  lock released after success and after pre-commit throw (`finally`).
- index-missing/corrupt tolerance parallel to rm (empty index → source-not-tracked).

**No property-based tests.** Per CLAUDE.md, command facades / orchestration
with no algebraic round-trip, matcher, or grammar do not warrant `fast-check`;
`mv` is pure orchestration over the index map and `fs.rename`. The four lenses
(round-trip / compositional matcher / total-function-over-grammar / idempotence)
do not fit. This is called out so the test-review pass records the deliberate
omission rather than flagging a gap.

Parity: a `mv` scenario (rename + move-into-dir) in `test/parity/scenarios/`,
asserting the resulting index entries / blob ids against a pinned expectation,
matching the `reset-rm-reflog` style.

## Key decisions (rationale + alternatives)

1. **Cache-entry copy, no re-hash** — verified against git; cheapest + faithful;
   preserves unstaged edits. Alternative (re-hash working file at target) would
   diverge from git and lose the staged/working distinction. Rejected.
2. **Validate-all-then-execute (atomic planning)** — matches git's default
   die-on-first-bad. Alternative (move eagerly per source) breaks atomicity.
   `skipErrors` is the opt-out, faithful to `-k`.
3. **Granular per-reason `MV_*` codes** (ADR-202) — seven distinct codes, one
   per refusal, each `{source, destination}`. Chosen over a consolidated
   `MV_REFUSED{reason}` so callers match a single `code`; trade-off is a larger
   `CommandError` union.
4. **`(sources[], destination)` API** (ADR-200) vs trailing-element / overload —
   uniform with rm/add + the `(old,new)` rename precedent.
5. **Options shipped: `force` + `dryRun` + `skipErrors`** (ADR-201) — the three
   real `git mv` flags with observable semantics; `--verbose` is subsumed by the
   structured result.
6. **Pre-check destination parent dir** → clean domain error instead of leaking
   `fs.rename` ENOENT. Faithful in behaviour (refuse, no auto-create);
   documented divergence in error *surface* only.
```
