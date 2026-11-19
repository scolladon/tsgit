# Plan — mv-directory-one-rename

> Source: design doc `docs/design/mv-directory-one-rename.md` · ADRs 1217, 1218, 1219, 1220, 1221, 1222, 1223, 1224, 1225, 1226, 1227
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a path in backticks:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## How the design's parts map here

The design's P1–P6 are kept in order; three are split by the sizing rules.

| Design | Plan part | Requirements |
|---|---|---|
| P1 port + adapters + wrapper | 1 (port, node, memory, contract), 2 (wrapper, browser absence) | R8, ADR-1217 |
| P2 dispatch + hardened leaf path | 3 (dispatch, one-step rename, breaking), 4 (leaf path) | R1, R2, R3, R4, R5, R6, R7 |
| P3 `-k` arms + 32.72 fold + `rename-failed` + partial-move removal | 5 (skip a refused rename), 6 (remove a partial move) | R7, R11, R12, R13, R14, ADR-1220, ADR-1223, ADR-1224, ADR-1225 |
| P4 case-only file rename | 7 | R9 |
| P5 interop | 8 (PATH_MAX-derived rows), 9 (case-insensitive-host rows) | R2, R3, R4, R10, R11, R12, R14 cross-tool |
| P6 docs | 10 | design § 7 |
| P7 destination beyond a symbolic link | 11 (the error code), 12 (the check and its `skipErrors` arms) | R15, R16, R17, ADR-1226 |
| P8 interop + docs for P7 | 13 | R15, R16, R17 cross-tool; design § 7 |
| P9 existing destination through a link + index replacement | 14 | R18, ADR-1227 |
| P10 absent untracked source | 15 | R19, ADR-1227 |

Every part commits alone; parts are sequential on one working tree and build on each
other. Shared files across parts are deliberate: parts 3–4 (working-tree), 5–7 (mv.ts)
and 8–9 (mv-interop) are split by the sizing ceiling and each lands a distinct behaviour
slice on the previous part's code; `reports/api.json` is regenerated in each part that
changes the public surface (decision P-4). Interop parts 8 and 9 are the cross-tool proof of behaviour landed in parts 3–7
(allowed standalone by the run's constraints); every behaviour part carries its own unit
rows. Parts 11–13 were added after parts 1–10 landed (ADR-1226): they reopen mv.ts, mv.test.ts,
mv-interop, interop-helpers and mv.md because those parts are already committed, not by choice
of slicing. The error code (11) and the check (12) are split by the six-file ceiling; 13 is the
cross-tool proof and the prose for 12. Parts 14 and 15 (ADR-1227) come after Part 13 and build on
its code: Part 12's beyond-symlink gate, `statOrUndefined` and `DestinationPolicy.scanner`, and
Part 13's link describe in mv-interop. Each carries its own unit rows, interop rows and docs
(four and five files), so no interop-only part is added for them. They reopen the same files for
the same reason as 11–13: the earlier parts are committed by the time these were planned.

## Repo-wide traps every part inherits

- Part agents may have **no MCP tools**: every symbol below is named so `Read`/`Grep`/`Edit`
  suffice. Run commands from the worktree root.
- `rtk` rewrites some commands; use `./node_modules/.bin/<tool>` when a raw binary is needed.
- No phase/ADR/backlog/row numbers in `src/` or `test/` code or comments — except the
  existing `(row Mn)` title convention of `test/integration/pathspec-length-interop.test.ts`,
  which parts 8 keeps for its new rows. No suppression directives of any kind.
- Test conventions: `describe('Given …')` > `describe('When …')` > `it('Then …')`, AAA
  comments, `const sut = <function under test>`. Error assertions check `data` (code and
  fields), never the class alone.
- The memory adapter's port members are class fields (arrow functions bound to the
  instance). `{ ...ctx.fs }` keeps them; a spread that replaces `rename` does **not**
  change what `renameDirectory` calls (it delegates to the instance's own `rename`). Strip
  a member with the omission idiom (`const { renameDirectory: _renameDirectory, ...rest } = fs`),
  never `renameDirectory: undefined` (`exactOptionalPropertyTypes`). Precedent:
  `withoutAtomicRename` in test/unit/application/primitives/reftable-transaction.test.ts.
- Memory layout: `createMemoryContext()` gives `workDir === '/repo'`, `gitDir === '/repo/.git'`.
- A `return` of a promise inside `try { … } finally { await lock.release() }` must be
  `return await …`, or the lock releases before the work finishes.
- If the phase gate's size check goes red after parts 5–7: `rm -rf dist .wireit`, rebuild,
  re-read every failing row, then raise the caps in a separate `chore(size)` commit.

## Decision candidates

Settled upstream (not candidates): D1–D6 (ADR-1217..1222), N1 (ADR-1223), N2 (ADR-1224),
N3 = B (ADR-1225), ADR-1226 (the behaviour of Parts 11–13). Open in the design, and the plan is
written for each recommendation: **N4 = A** (one `skipped` entry per member), **N5 = A** (a new
`MV_DESTINATION_BEYOND_SYMLINK`; with B, Part 11 is dropped and Part 12 calls
`pathspecBeyondSymlink(destination)`), **N6 = A** (a later part, not planned here; with B, Part 13
also adds the two ledger rows). N6 is settled by ADR-1227 (Parts 14 and 15). Open from the
ADR-1227 revision, plan written for each recommendation: **N7 = A** (`moved` does not list the
entries the replacement removes), **N8 = A** (a later Part 16, not planned here; with B, Part 15
adds one `docs/known-divergences.md` row and its file count becomes six), **N9 = A** (a forced
move through a link into `.git` is copied; with B, Part 14 gains a resolved-path check and an ADR
is needed first). The plan-level choices below are load-bearing for the run's shape; each
has a recommendation the plan is written for.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| P-1 | Where the interop rows land | **A** two standalone interop parts after the behaviour parts (8: PATH_MAX-derived, 9: case-insensitive host). **B** fold each row into the part landing its behaviour (3, 5, 6, 7). **C** one interop part | **A** | B pushes parts 3 and 5 over the 6-file ceiling and doubles their tool budget with deep-chain fixtures; C holds ~16 rows × 2 `core.ignorecase` values, over ~100 tool calls. A keeps every behaviour part's unit rows in-part (each guard killed at unit level) and makes the interop parts pure proof |
| P-2 | Transitional leaf path in part 3 | **A** part 3 dispatches to `renameDirectory` and keeps today's `moveNode` for the capability-absent branch; part 4 replaces `moveNode`. **B** one part lands dispatch and the new leaf path together | **A** | B is ~9 RED cycles and 5 files; A gives the breaking commit (`mv d D` refusing) its own atomic slice and leaves part 4 a non-breaking `fix` |
| P-3 | Wrapper shape for the new optional member | **A** generalise `guardedAtomicRename` into one `guardedOptionalRename(fs, guard, key)` serving `'atomicRename'` and `'renameDirectory'`, like `guardedPathProbe`. **B** a second copy `guardedRenameDirectory` (the design's wording) | **A** | B is a 12-line clone of an existing block: `check:duplicates` (jscpd, `minTokens` 50 on `src/`) can flag it, and two copies drift. A keeps the design's behaviour (forward when present, omit when absent, guard both paths as writes) |
| P-4 | `reports/api.json` cadence | **A** regenerate with `npm run docs:json` in each part that changes the public surface (1: `FileSystem.renameDirectory?`; 5: `'rename-failed'`). **B** once, in part 5 | **A** | The surface-gates context says pre-pay in the slice that changes the surface; staleness is only caught at prepush, so B would leave part 1's commit silently stale |

## Part 1 — Port capability on node and memory

### Context

Files edited: `src/ports/file-system.ts`, `src/adapters/node/node-file-system.ts`,
`src/adapters/memory/memory-file-system.ts`, `test/unit/ports/file-system.contract.ts`,
`reports/api.json` (regenerated, never hand-edited).

Public-surface decision: `FileSystem.renameDirectory?` is **public** (the port is exported).
Surface gates: `reports/api.json` via `npm run docs:json` (prepush `check:doc-typedoc`). No
barrel, facade, error union, doc-coverage or README count is touched: no docs page lists
port members (checked: no `atomicRename` mention under docs/use or README.md).

- Port, `src/ports/file-system.ts`: `interface FileSystem`. `readonly rename` ends near
  line 231 (its doc lists the refusals); `readonly atomicRename?: (src: string, dst: string) => Promise<void>;`
  near line 251. Add right after `atomicRename`, verbatim from design § 1:
  `readonly renameDirectory?: (src: string, dst: string) => Promise<void>;` with the
  design's doc comment (one platform step, whole subtree including empty subdirectories,
  refusals are `rename`'s by delegation, a destination inside the source — case alias
  included — refuses UNSUPPORTED_OPERATION and moves nothing; optional; node and memory
  provide it; the browser adapter omits it; a caller finding it absent moves entry by entry
  and must tolerate a partial move).
- Node, `src/adapters/node/node-file-system.ts`: class field
  `atomicRename = async (src, dst) => { await this.rename(src, dst); };` near line 1645.
  Add `renameDirectory` beside it, same shape, with a one-line why-comment (rename(2) moves a
  directory whole in one step).
- Memory, `src/adapters/memory/memory-file-system.ts`: **name collision** — the class
  already has `private renameDirectory(src: string, dst: string): void` (near line 406,
  re-keys `files`/`symlinks`/`times`/`directories`), called from the `rename` field (near
  line 340). Rename the private method to `relocateDirectory` (both the declaration and the
  one call), then add the public field `renameDirectory = async (src, dst) => { await this.rename(src, dst); };`
  beside `atomicRename` (near line 349). Memory's into-self refusal is
  `unsupportedOperation('filesystem', 'EINVAL')` in `assertRenamable`.
- Browser: no source change (part 2 pins the absence).
- Contract, `test/unit/ports/file-system.contract.ts`: `fileSystemContractTests(createSut)`
  runs inside the memory and node adapter suites (test/unit/adapters/memory/memory-file-system.test.ts,
  test/unit/adapters/node/node-file-system.test.ts; node also runs on windows-latest in CI).
  Module-level helpers `lexists(fs, path)` / `utimeNow(fs, path)` near line 208 throw
  `new Error('the adapter under contract provides no …')` when the optional member is
  absent: add a sibling `renameDirectory(fs, src, dst)`. Put the new rows after the rename
  kind rows (after "Given src === dst for a non-empty directory, When rename, …", near
  line 700) in a `describe('Given the optional renameDirectory', …)` like the existing
  `describe('Given the optional rmdir', …)` near line 1434. Use `env.rootDir`, `env.fs.write`,
  `env.fs.mkdir`, `env.fs.readdir`, `env.fs.exists`, `errorDataCode`.
- Windows-safe expectations: on the into-self row assert only `data.code`,
  `data.operation === 'filesystem'` and `typeof data.reason === 'string'`; assert nothing moved.

### TDD steps

1. RED — contract row "Given a directory holding a file, an empty subdirectory and a
   nested file, When renameDirectory moves it, Then every entry sits under the destination
   and the source is gone" (fixture: `rd-src/a.bin`, empty `rd-src/emp`, `rd-src/s/b.bin`;
   assert bytes of both files at `rd-dst/…`, `rd-dst/emp` exists, `rd-src` absent). Fails
   on both adapters: the helper throws "the adapter under contract provides no
   renameDirectory" — neither adapter has the member.
2. GREEN — port member + doc; node field; memory private rename to `relocateDirectory` +
   public field.
3. GUARD — "Given a directory, When renameDirectory targets a path inside it, Then it
   refuses UNSUPPORTED_OPERATION and nothing moves": passes after step 2 because both
   adapters' `rename` already refuses into-self before moving.
4. GUARD — "Given no entry at the source, When renameDirectory, Then it refuses
   FILE_NOT_FOUND": passes by delegation to `rename`.
5. REFACTOR — none expected beyond the doc comments. Run `npm run docs:json` and stage
   `reports/api.json`.

### Gate

`npx vitest run test/unit/adapters/memory/memory-file-system.test.ts test/unit/adapters/node/node-file-system.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/file-system.ts src/adapters/node/node-file-system.ts src/adapters/memory/memory-file-system.ts test/unit/ports/file-system.contract.ts && npm run check:spelling`
Before commit: `npm run docs:json` (commit the regenerated `reports/api.json`).

### Commit

`feat(ports): add an optional one-step directory rename to the file system port`

## Part 2 — The path guard forwards the capability; the browser stays without it

### Context

Files edited: `src/repository/wrap-fs-validator.ts`,
`test/unit/repository/wrap-fs-validator.test.ts`,
`test/unit/adapters/browser/browser-file-system.test.ts`.

No new exported symbol (the wrapper helper is module-private). `wrapFsValidator` is the only
`FileSystem` wrapper in `src` (`createWorktreeFs`, `createObjectSourceAccess`,
`makeWorktreeFs`, `makeConfinedFs` in src/repository.ts and src/index.node.ts all go through it).

- `src/repository/wrap-fs-validator.ts`: `guardedAtomicRename(fs, guard): Pick<FileSystem, 'atomicRename'>`
  near line 71 (destructure, `{}` when absent, guard `s` and `d`, `atomicRename.call(fs, s, d)`),
  spread in the returned object as `...guardedAtomicRename(fs, guard),` near line 254, right
  after the `rename` member. Precedent for a key-parameterised helper:
  `guardedPathProbe(fs, readGuard, key)` near line 50. Per decision P-3, replace
  `guardedAtomicRename` with `guardedOptionalRename(fs, guard, key: 'atomicRename' | 'renameDirectory'): Partial<Pick<FileSystem, typeof key>>`
  and spread it twice. Keep its doc comment (why optional members stay absent behind the
  wrapper) and extend it to the directory rename (an adapter without it keeps the
  entry-by-entry path).
- `test/unit/repository/wrap-fs-validator.test.ts`: block
  `describe('wrapFsValidator — the optional atomicRename capability')` near line 746, with
  `fsWithAtomicRename()` (a receiver-reading method recording `[src, dst]` pairs on
  `this.renamed`), `stubFs()`, `expectOutside(fn)`. Clone it as
  `describe('wrapFsValidator — the optional renameDirectory capability')` right after it.
- `test/unit/adapters/browser/browser-file-system.test.ts`: the row
  "When checking for the atomicRename capability" near line 22
  (`new BrowserFileSystem({} as unknown as FileSystemDirectoryHandle)`, `'atomicRename' in sut`).
  Add the `renameDirectory` twin beside it.

### TDD steps

1. RED — "Given an adapter providing renameDirectory and two in-root paths, When
   renameDirectory is called through the wrapper, Then it delegates on the adapter with both
   paths" (asserts `fs.renamed` equals `[['/repo/d', '/repo/e']]`). Fails: `sut.renameDirectory`
   is undefined, the optional call is a no-op, `renamed` stays `[]`.
2. GREEN — `guardedOptionalRename` with the `'renameDirectory'` spread (P-3; if the
   orchestrator picks B, a `guardedRenameDirectory` copy).
3. GUARD — `describe.each` source / destination outside every root, wrapper built with
   `{ guardReads: false }`: `PATHSPEC_OUTSIDE_REPO`, nothing renamed. Passes after step 2
   (both paths guarded); kills a dropped `guard(s)` or `guard(d)` each in isolation.
4. GUARD — "Given an adapter without renameDirectory, as the browser adapter is, Then the
   wrapper exposes no renameDirectory either" (`'renameDirectory' in sut` is false).
   Passes: the helper returns `{}`; kills an always-forwarding mutant.
5. GUARD — browser row "the adapter does not expose renameDirectory": passes, the browser
   adapter never had the member.
6. REFACTOR — fold `guardedAtomicRename` into `guardedOptionalRename`; the existing
   atomicRename rows must stay green unchanged.

### Gate

`npx vitest run test/unit/repository/wrap-fs-validator.test.ts test/unit/adapters/browser/browser-file-system.test.ts && npm run check:types && ./node_modules/.bin/biome check src/repository/wrap-fs-validator.ts test/unit/repository/wrap-fs-validator.test.ts test/unit/adapters/browser/browser-file-system.test.ts && npm run check:spelling`

### Commit

`feat(repository): forward the directory-rename capability through the path guard`

## Part 3 — Rename a directory in one step where the port can (breaking)

### Context

Files edited: `src/application/commands/internal/working-tree.ts`,
`test/unit/application/commands/internal/working-tree.test.ts`,
`test/unit/application/commands/mv.test.ts`.

No new exported symbol. This part makes `mv(['d'], 'D')` on a case-insensitive node host
refuse `UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'EINVAL' }` with index and
disk unchanged (was: OK + work tree emptied) — the breaking change of ADR-1222. It also
fixes deep-descendant moves (rows 1–3) and empty-directory loss (row E) on node and memory.

- `src/application/commands/internal/working-tree.ts` today: `renameInWorkingTree(ctx, rawFrom, rawTo)`
  (line ~132) → `moveNode(ctx, from: MoveEnd, to: MoveEnd)` (lstat; plain directory →
  readdir + recurse + `ctx.fs.rmRecursive(from)`; else `moveLeaf`) and
  `moveLeaf(ctx, fromAbs, to)` (mkdir `dirname(to.abs)` when not `''`, `ctx.fs.rename`,
  catch `isPathTooLong(err) → throw pathTooLong(to.rel)`, else rethrow). `MoveEnd { abs, rel }`,
  `childOf(end, name)`, `repoPath(ctx, path)`. Imports already present: `dirname`,
  `pathTooLong`, `isPathTooLong`, `validatePath`.
- Target shape (design § 2):
  ```ts
  export const renameInWorkingTree = async (ctx, rawFrom, rawTo) => {
    const from = moveEnd(ctx, validatePath(rawFrom));
    const to = moveEnd(ctx, validatePath(rawTo));
    const stat = await ctx.fs.lstat(from.abs);
    if (!isPlainDirectory(stat)) return renameNamingDestination(ctx, ctx.fs.rename, from, to);
    const renameDirectory = ctx.fs.renameDirectory;
    if (renameDirectory !== undefined) return renameNamingDestination(ctx, renameDirectory, from, to);
    return moveNode(ctx, from, to);   // part 4 replaces this with the read-first leaf path
  };
  ```
  `renameNamingDestination(ctx, op, from, to)` is `moveLeaf` generalised: mkdir the parent
  when `dirname(to.abs) !== ''`, then `op.call(ctx.fs, from.abs, to.abs)`, same catch. Its
  comment ("the source was just read, so a too-long refusal can only mean the destination")
  now holds for both arms. `moveNode`'s leaf arm calls `renameNamingDestination(ctx, ctx.fs.rename, from, to)`;
  delete `moveLeaf`. `isPlainDirectory(stat)` = `stat.isDirectory && !stat.isSymbolicLink`
  (not `isRealDirectory`, which is a private name in empty-directories.ts). `moveEnd(ctx, rel)`
  builds `{ abs: repoPath(ctx, rel), rel }`. Doc comment of `renameInWorkingTree`: drop
  "memory and OPFS adapters are file-oriented"; say one rename where the port can (part 4
  rewrites the degraded-path paragraph).
- `test/unit/application/commands/internal/working-tree.test.ts`, `describe('renameInWorkingTree')`
  near line 721: the row "Then it recurses leaf-by-leaf — readdir, mkdir the leaf parent,
  rename each leaf, rmRecursive the shell" builds `{ ...base.fs, readdir, mkdir, rmRecursive, rename }`
  spies — after GREEN it would hit memory's `renameDirectory`. Convert it to the
  capability-absent case (strip `renameDirectory` from `base.fs` first, then spread the
  spies); its expectations stay valid in this part. Row "Given a root-level target whose
  parent is the work-tree root '/'" (workDir `'/'`, stubbed leaf `lstat`) must stay green.
  Helpers: `leafStat()`, `expectError(fn, code)`; imports `permissionDenied`,
  `unsupportedOperation`, `TsgitError` from src/domain/index.js; `pathTooLong` lives in
  src/domain/error.js.
- `test/unit/application/commands/mv.test.ts`, `describe('mv — a move the file system refuses')`
  near line 1032: helper `failingRename(ctx, fault)` stubs only `rename`. Rows to change
  are named in the TDD steps. File helpers: `seedAndStage(tree)`, `work`, `exists`,
  `readWork`, `indexEntry(ctx, path)`, `expectError(fn, code)`. Add a sibling helper
  `failingDirectoryRename(ctx, fault)` stubbing `renameDirectory` (a separate helper, not a
  boolean parameter), and a `withoutDirectoryRename(ctx)` omission helper (reused by parts 4–6).

### TDD steps

1. RED — working-tree "Given a directory and an adapter with renameDirectory, When
   renameInWorkingTree moves it, Then it renames the directory once and reads nothing
   beneath it": spies on `renameDirectory`, `readdir`, `rmRecursive`, `rename`; expect
   `renameDirectory` called exactly once with `('/repo/old', '/repo/new')`, `readdir` and
   `rmRecursive` never called. Fails: today's `moveNode` calls `readdir('/repo/old')` and
   never `renameDirectory`.
2. RED — working-tree "Given renameDirectory refusing PATH_TOO_LONG for the absolute
   source, Then the error names the repository-relative destination"
   (`data` equals `{ code: 'PATH_TOO_LONG', path: 'new' }`). Fails: `renameDirectory` is
   never called, the leaf loop moves the tree and resolves.
3. RED — working-tree "Given renameDirectory refusing PERMISSION_DENIED, Then that very
   error is rethrown" (`rejects.toBe(fault)`). Fails: resolves (same reason).
4. RED — mv "Given a directory move whose rename the file system refuses as too long, Then
   it names the destination directory": rewrite the existing row "Given a directory move
   whose leaf rename the file system refuses as too long" to use
   `failingDirectoryRename(ctx, pathTooLong('/abs/d'))` and expect `{ code: 'PATH_TOO_LONG', path: 'e' }`.
   Fails: `renameDirectory` is not called; the leaf loop, whose `rename` is not stubbed, moves `d/f` and `mv` resolves.
5. RED — mv "Given a directory whose source descendant the file system refuses as too long,
   When mv with renameDirectory, Then the move succeeds and the index holds e/f": rewrite the
   existing source-descendant row (its `lstat` stub throws for `work(ctx, 'd/f')`) to expect
   success, `indexEntry(ctx, 'e/f')` defined, `exists(ctx, 'e/f')` true. Fails: the leaf
   loop `lstat`s `d/f` and rejects with the fault.
6. RED — mv "Given a directory rename refused UNSUPPORTED_OPERATION EINVAL without
   skipErrors, Then mv rejects with that very error, the index keeps d/f and the source is
   on disk" (`failingDirectoryRename(ctx, unsupportedOperation('filesystem', 'EINVAL'))`;
   `rejects.toBe(fault)`, `indexEntry(ctx, 'd/f')` defined, `indexEntry(ctx, 'e/f')`
   undefined, `exists(ctx, 'd/f')` true). Fails: resolves, the leaf loop ignores the stub.
7. GREEN — dispatch, `renameNamingDestination`, `isPlainDirectory`, `moveEnd`; convert the
   leaf-by-leaf working-tree row to the stripped fs.
8. GUARD — working-tree "Given a symlink to a directory as the source, Then it goes through
   rename, never renameDirectory" (memory `symlink` + spies). Passes after step 7; kills the
   `!stat.isSymbolicLink` operand of `isPlainDirectory`.
9. GUARD — mv capability-absent variants on `withoutDirectoryRename(...)`: (a) the leaf
   rename refused too long still names `'e/f'` (`failingRename` on the stripped fs); (b) the
   source-descendant fault still `rejects.toBe(fault)`. Both pass: the absent branch is
   still `moveNode`; they kill a mutant forcing `renameDirectory !== undefined` true.
10. REFACTOR — `renameInWorkingTree` ≤ 20 lines; no dead `moveLeaf`.

### Gate

`npx vitest run test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/mv.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/working-tree.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/mv.test.ts && npm run check:spelling`

### Commit

`fix(mv)!: rename a directory in one step where the file system can`

## Part 4 — The entry-by-entry path reads first and never deletes content

### Context

Files edited: `src/application/commands/internal/working-tree.ts`,
`test/unit/application/commands/internal/working-tree.test.ts`,
`test/unit/application/commands/mv.test.ts`,
`test/unit/application/commands/internal/working-tree.properties.test.ts` (new),
`test/unit/application/commands/internal/arbitraries.ts`.

No new exported symbol. Applies only where the port has no `renameDirectory` (browser/OPFS,
third-party adapters).

- Replace `moveNode` (left by part 3 as the capability-absent branch) with
  `moveTreeEntryByEntry(ctx, from: MoveEnd, to: MoveEnd)` (design § 3):
  ```
  collect(from)       -> { dirs: MoveEnd[] (pre-order, from included), leaves: MoveEnd[] }  // lstat + readdir only
  for dir of dirs:    mkdir(mapTo(dir).abs)                         // empty directories survive
  for leaf of leaves: renameNamingDestination(ctx, ctx.fs.rename, leaf, mapTo(leaf))
  await removeEmptyDirectoryTree(ctx, from.abs)                     // result ignored on purpose
  ```
  `collect` returns immutable arrays; a child is a directory when `isPlainDirectory(lstat)`.
  `mapTo(end, from, to)` = `{ abs: to.abs + end.abs.slice(from.abs.length), rel: to.rel + end.rel.slice(from.rel.length) }`.
  Keep `childOf`. Import `removeEmptyDirectoryTree` from
  ../../primitives/internal/empty-directories.js (commands → primitives is allowed): it
  descends in listing order, stops `false` at the first non-directory entry, removes empty
  directories through `rmdir` (or `rm` when the port has no `rmdir`). The `false` is
  ignored because what remains is exactly what the renames left. No cleanup on a fault, no
  progress report (CQS): a write fault after the first rename propagates with a partial
  move; everything written lies under `to.abs`.
- Rewrite the `renameInWorkingTree` doc comment: one rename where the port can; otherwise
  read the whole subtree, recreate every directory, move each leaf, then remove only empty
  source directories; a fault after the first move leaves a partial move (like the browser's
  own `rename`).
- `test/unit/application/commands/internal/working-tree.test.ts`: the capability-absent
  row converted in part 3 ("readdir, mkdir the leaf parent, rename each leaf, rmRecursive
  the shell") flips: no `rmRecursive`. Rewrite it per step 2 below.
- `test/unit/application/commands/mv.test.ts`: the capability-absent source-descendant
  variant added in part 3 (GUARD 9b).
- Property test (new) `test/unit/application/commands/internal/working-tree.properties.test.ts`
  with a header comment naming the lens (counting invariant: every entry of the source maps
  1:1 to the destination with the same relative path and bytes; independent oracle: the
  memory adapter's own `renameDirectory`). `NUM_RUNS = 100`. Arbitrary in
  `test/unit/application/commands/internal/arbitraries.ts` (fast-check `fc`, existing
  exports `remoteUrlArb`, `pathArb`): add `directoryTreeArb()` — 0–4 levels, 0–5 entries
  per directory, unique names from `[a-z]{1,8}` per directory, entries are file (bytes),
  symlink (target text) or directory (possibly empty). Precedent layout:
  test/unit/application/commands/internal/resolve-pathspec.properties.test.ts.

### TDD steps

1. RED — working-tree "Given an adapter without renameDirectory and a directory holding a
   file and an empty subdirectory, When renameInWorkingTree, Then the empty subdirectory
   survives at the destination" (`/repo/old/f.txt`, empty `/repo/old/emp`; expect
   `/repo/new/emp` exists, `/repo/old` absent). Fails: `moveNode` recurses into `emp`, finds
   nothing to rename and `rmRecursive`s it; `/repo/new/emp` is never created.
2. RED — working-tree "Given an adapter without renameDirectory, Then every lstat and
   readdir happens before the first rename, a mkdir is made for every directory, and
   rmRecursive is never called": a shared call log (`[op, path]`) around `lstat`,
   `readdir`, `mkdir`, `rename`, `rmRecursive`; fixture `/repo/old/a`, `/repo/old/s/b`;
   assert index of the first `rename` > index of the last `lstat`/`readdir`, `mkdir` seen
   for `/repo/new` and `/repo/new/s`, no `rmRecursive`. Fails: `moveNode` renames `old/a`
   before reading `old/s`, and calls `rmRecursive`.
3. RED — working-tree "Given readdir faulting on a nested directory, Then the fault
   propagates and no rename happened" (fault on `readdir('/repo/old/s')`, `rename` spy
   never called, `/repo/old/a` still there). Fails: `old/a` is renamed before `old/s` is read.
4. RED — working-tree "Given an entry that appears in the source after the move, Then it is
   kept": wrap `rename` so that, after delegating, it writes `/repo/old/late` once; expect
   `/repo/new/a` present and `readUtf8('/repo/old/late')` succeeds. Fails: `moveNode`'s
   `rmRecursive('/repo/old')` deletes `late`. Kills a `rmRecursive` swap of the cleanup.
5. RED — mv "Given an adapter without renameDirectory and a source descendant whose lstat
   faults, Then nothing moved and the index is unchanged": seed `{ 'd/a': 'a', 'd/f': 'f' }`,
   `lstat` throws for `work(ctx, 'd/f')`; `rejects.toBe(fault)`, `exists(ctx, 'd/a')` true,
   `exists(ctx, 'e')` false, `indexEntry(ctx, 'd/a')` defined. Fails: `moveNode` moves
   `d/a` before it `lstat`s `d/f`.
6. GREEN — `moveTreeEntryByEntry`, `collect`, `mapTo`, `removeEmptyDirectoryTree`; delete
   `moveNode`; rewrite the doc comment.
7. GUARD — working-tree "Given rename faulting on the second leaf, Then that very fault
   rejects, the first leaf is under new, the second still under old, nothing is removed,
   and every mkdir/rename destination is /repo/new or starts with /repo/new/". Passes after
   step 6 (no cleanup on fault; every write is under `to.abs`) — pins the invariant part 6's
   removal relies on.
8. GUARD — property "for every generated tree, moving with renameDirectory stripped yields
   the same recursive listing and bytes as moving with it". Passes after step 6.
9. REFACTOR — each new function ≤ 20 lines, nesting ≤ 2.

### Gate

`npx vitest run test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/internal/working-tree.properties.test.ts test/unit/application/commands/mv.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/working-tree.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/internal/working-tree.properties.test.ts test/unit/application/commands/internal/arbitraries.ts test/unit/application/commands/mv.test.ts && npm run check:spelling`

### Commit

`fix(mv): read a directory whole before moving it entry by entry and keep its empty directories`

## Part 5 — skipErrors skips a refused rename as git mv -k does

### Context

Files edited: `src/application/commands/mv.ts`,
`src/application/commands/internal/working-tree.ts`,
`test/unit/application/commands/mv.test.ts`,
`test/unit/application/commands/internal/working-tree.test.ts`,
`reports/api.json` (regenerated).

Public-surface decisions: `MvSkipReason` (exported from src/application/commands/index.ts
near line 211) gains the literal `'rename-failed'` → **public**; gate: `npm run docs:json`.
`PlanSkipReason = Exclude<MvSkipReason, 'rename-failed'>` is **internal** (unexported, so no
forgotten-export entry). `discardDirectory` is exported from the internal module only
(**internal**, consumed by mv.ts). No new error code; no barrel/facade change.

- `src/application/commands/mv.ts` today: `mv` (line ~111) under `acquireIndexLock`:
  `readIndexMap` → `resolveDestinationMode` → rename-mode check → `buildPlan(ctx, byPath, sources, mode, opts)`
  → `assertNoTargetCollision` → `plannedMoves(planned)` → dryRun return →
  `applyToIndex(indexPathRulesOf(ctx), byPath, planned)` (validates every repathed path
  with `pathRules.validateIndexPath(moved.path, NO_PARSER_OFFSET, moved.mode)`, then
  `delete` + `set`) → `renameInWorkingTree` per item → `lock.commit(Array.from(byPath.values()), 'update')`.
  `PlanItem { source, target, entries }`; `Verdict` success arm `{ kind, entries }` already
  carries `kind`; `buildPlan` pushes `{ source, target, entries }`; `refusal(reason: MvSkipReason, …)`
  is an exhaustive switch over the four planning reasons; `classifySource(byPath, source)`
  (`'untracked'` when no entry equals `source` or lies under `source/` by bytes);
  `lstatOrUndefined(ctx, path: FilePath)`; `repath(entry, source, target)`.
  Lock type: `IndexLock` from ../primitives/internal/index-lock.js.
- Target (design § 4, minus the partial-move removal, which is part 6):
  ```ts
  if (opts.dryRun === true) return { moved: plannedMoves(planned), skipped };
  return await executePlan(ctx, lock, byPath, plan, opts);

  const executePlan = async (ctx, lock, byPath, { planned, skipped }: Plan, opts) => {
    const repathed = planned.map((item) => repathItem(indexPathRulesOf(ctx), item)); // validates all first
    const executed = await renameEach(ctx, repathed, opts);
    const indexed = executed.filter(movesIndex);
    applyToIndex(byPath, indexed);
    await removeAbandonedSources(ctx, byPath, executed);   // after the whole loop
    await lock.commit(Array.from(byPath.values()), 'update');
    return { moved: plannedMoves(indexed.map(({ item }) => item)), skipped: [...skipped, ...renameSkipsOf(executed)] };
  };
  ```
  - `PlanItem` gains `readonly kind: 'file' | 'directory'` (copied from the verdict in `buildPlan`).
  - `repathItem(pathRules, item)` → `{ item, moves: ReadonlyArray<{ from: IndexEntry; to: IndexEntry }> }`,
    running `validateIndexPath` on every `to`; `applyToIndex(byPath, indexed)` keeps only the
    map writes.
  - `renameEach` picks `const run = opts.skipErrors === true ? renameOrSkip : renameOrThrow`
    and runs it sequentially in plan order, returning `{ item, moves, outcome: 'renamed' | 'skipped' }`.
    `renameOrSkip`: `try { await renameInWorkingTree(…); return 'renamed'; } catch (err) { if (!(err instanceof TsgitError)) throw err; return 'skipped'; }`.
  - `movesIndex({ item, outcome })` = `outcome === 'renamed' || item.kind === 'directory'`.
  - `renameSkipsOf(executed)` maps each `'skipped'` record to `{ source: item.source, reason: 'rename-failed' }`, plan order.
  - `removeAbandonedSources(ctx, byPath, executed)`: for each `kind === 'directory'` +
    `outcome === 'skipped'` record, in plan order, when `classifySource(byPath, item.source).kind === 'untracked'`,
    `await discardDirectory(ctx, item.source)`.
  - `MvSkipReason` gains `'rename-failed'` with a trailing comment (the working-tree rename
    was refused); the doc comment says the fifth reason is collected at execution. `Verdict.skip`
    and `refusal()` take `PlanSkipReason`.
  - `mv` must stay ≤ 20 lines: extract the planning steps under the lock into one function
    (e.g. `planUnderLock(ctx, byPath, request, opts)` returning `Plan`, with a small
    request record for `{ sources, destination, destNoSlash }`).
- `src/application/commands/internal/working-tree.ts`: add next to `removeDirectory`
  (near line 110) the design's `discardDirectory(ctx, rawPath)` =
  `ctx.fs.rmRecursive(repoPath(ctx, validateWorkingTreePathOn(rawPath, ctx)))` with its doc
  comment (deletes untracked content on purpose; a missing path is not an error).
  `removeDirectory` is not reused (it refuses a missing path with `CHECKOUT_OVERWRITE_DIRTY`).
- Tests, `test/unit/application/commands/mv.test.ts`: new
  `describe('mv — skipErrors and a rename the file system refuses')` after
  `describe('mv — a move the file system refuses')`; reuse `failingRename`,
  `failingDirectoryRename` (part 3). **Trap:** the index commit itself renames
  (`ctx.fs.rename(lockPath, indexFile)` in src/application/primitives/internal/index-lock.ts
  near line 330), and under skipErrors the call now reaches the commit — so `failingRename`
  (which refuses every rename) makes a skipErrors row fail at commit. Add
  `failingWorkTreeRename(ctx, fault, refusedName)`: throws only when `src` is not under
  the git dir and ends with `refusedName`; delegates otherwise. Lossy seeding: module-level `seedRows`,
  `indexView`, `captureError`; `seedMember` lives inside `describe('mv on a directory
  holding a lossy member')` near line 969 — hoist it to module scope (parameterised by
  extra members) rather than copy it.
- Tests, `test/unit/application/commands/internal/working-tree.test.ts`: new
  `describe('discardDirectory')` after `describe('removeDirectory')`; import it.
- Unit rows simulate case aliases with stubs (the memory adapter is case-sensitive).

### TDD steps

1. RED — working-tree `discardDirectory`: "Given a tree holding a file, a nested directory
   and an empty directory, Then all of it is removed"; "Given a missing path, Then it
   resolves"; "Given ../x, Then PATHSPEC_OUTSIDE_REPO carrying the path". Fail:
   `discardDirectory` is not exported (TypeError: not a function).
2. GREEN — `discardDirectory`.
3. RED — mv "Given a tracked file whose rename refuses PATH_TOO_LONG, When mv with
   skipErrors, Then it returns, base is absent from moved, skipped is
   `[{ source: 'base', reason: 'rename-failed' }]`, and index and disk keep base"
   (`failingWorkTreeRename(ctx, pathTooLong('/abs/base'), 'base')`, `mv(['base'], 'S')`).
   Fails: mv rejects with PATH_TOO_LONG (an execution-time refusal throws whatever the flag).
4. GREEN — `PlanItem.kind`, `repathItem`, `renameEach` / `renameOrThrow` / `renameOrSkip`,
   `movesIndex` (file arm only: `outcome === 'renamed'`), `applyToIndex(byPath, indexed)`,
   `renameSkipsOf`, `executePlan`, `MvSkipReason` + `PlanSkipReason`.
5. GUARD — "Given an untracked ghost and a refused base in one call, Then skipped lists the
   planning skip first, then the rename skip" (`[{ source: 'ghost', reason: 'source-not-tracked' }, { source: 'base', reason: 'rename-failed' }]`).
   Passes after step 4; kills a reversed concatenation.
6. GUARD — "Given two files where only the first rename refuses, Then the second moves in
   index and disk and the first stays" (`failingWorkTreeRename` keyed on the first name). Passes after step 4; kills a skip that aborts the loop.
7. RED — mv "Given a directory d (tracked d/f, d/s/t; untracked d/u; empty d/emp) whose
   renameDirectory refuses EINVAL, When mv(['d'], 'D') with skipErrors, Then it returns, the
   index holds D/f and D/s/t, moved lists both, skipped is `[{ source: 'd', reason: 'rename-failed' }]`
   and nothing remains at d". Fails: the directory's members are not repathed (file-only
   `movesIndex`) and d stays on disk.
8. GREEN — `movesIndex` directory operand; `removeAbandonedSources` after the loop, deleting
   unconditionally for skipped directories.
9. RED — mv "Given a directory holding a lossy member whose renameDirectory refuses, When mv
   with skipErrors, Then the lossy entry stays in the index under d/ and d is not deleted"
   (hoisted `seedMember`). Fails: the unconditional removal deletes d.
10. GREEN — the `classifySource(byPath, item.source).kind === 'untracked'` condition.
11. GUARD — "Given d refusing and e renamed into d/e, When mv(['d', 'e'], 'D') with
    skipErrors, Then d/e is gone too": `lstat` stub answers `/repo/D` with `/repo/d`'s stat
    (so `D` is an existing directory and the mode is into-dir); `renameDirectory` stub throws
    EINVAL for `/repo/d` and, for `/repo/e`, calls the real one with destination `/repo/d/e`.
    Passes after step 10; kills a per-item cleanup (which would delete d before e moves in).
12. GUARD — strategy isolation: (a) without skipErrors a `TsgitError` from renameDirectory
    rejects with that very error and the index is unchanged (kills the `skipErrors === true`
    ternary); (b) with skipErrors a plain `Error` rejects with it and the index is unchanged
    (kills the `instanceof` guard).
13. GUARD — "Given two sources moved into t where the second's member fails index-path
    validation under Windows path syntax, Then INVALID_INDEX_ENTRY and the first source has
    not moved on disk" (`seedRows({ a: 'a', 'd/x\\y': 'y', 't/k': 'k' }, [{ path: 'a' }, { path: 'd/x\\y' }])`,
    `{ ...ctx, windowsPathSyntax: true }`, `mv(['a', 'd'], 't')`). Passes: every item is
    repathed before the first rename; kills a validate-then-rename interleave.
14. REFACTOR — `mv` ≤ 20 lines via the planning extraction; run `npm run docs:json`.

### Gate

`npx vitest run test/unit/application/commands/mv.test.ts test/unit/application/commands/internal/working-tree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/mv.ts src/application/commands/internal/working-tree.ts test/unit/application/commands/mv.test.ts test/unit/application/commands/internal/working-tree.test.ts && npm run check:spelling`
Before commit: `npm run docs:json` (commit the regenerated `reports/api.json`).

### Commit

`fix(mv): skip a rename the file system refuses under skipErrors as git mv -k does`

## Part 6 — skipErrors removes a partial entry-by-entry move it abandoned

### Context

Files edited: `src/application/commands/mv.ts`, `test/unit/application/commands/mv.test.ts`.

No new exported symbol. Scope: a directory whose entry-by-entry move (port without
`renameDirectory`) failed after creating entries at the destination. Without skipErrors
nothing changes (partial move stays).

- `src/application/commands/mv.ts` after part 5: `renameOrSkip(ctx, item)`, `PlanItem` with
  `kind`, `validateMove` (filters lossy members out under skipErrors:
  `classified.entries.filter((entry) => !isLossy(entry))`), `buildPlan`,
  `lstatOrUndefined`, `discardDirectory` import.
- Target (design § 4, ADR-1225 = N3 option B):
  ```ts
  const renameOrSkip = async (ctx, item) => {
    const targetWasAbsent = (await lstatOrUndefined(ctx, item.target)) === undefined;
    try { await renameInWorkingTree(ctx, item.source, item.target); return 'renamed'; }
    catch (err) {
      if (!(err instanceof TsgitError)) throw err;
      if (targetWasAbsent && abandonsSource(item)) await removePartialMove(ctx, item.target);
      return 'skipped';
    }
  };
  const abandonsSource = (item) => item.kind === 'directory' && item.retained.length === 0;
  const removePartialMove = async (ctx, target) => {
    if ((await lstatOrUndefined(ctx, target)) === undefined) return;
    await discardDirectory(ctx, target);
  };
  ```
  `PlanItem` gains `readonly retained: ReadonlyArray<IndexEntry>` (the lossy members
  `validateMove` filtered out; empty for a file); `Verdict`'s success arm carries it to
  `buildPlan`. The removal runs immediately (a later pair's `targetWasAbsent` must see git's
  disk). `renameOrThrow` is untouched.
- Tests: new `describe('mv — skipErrors and a partial entry-by-entry move')` in
  `test/unit/application/commands/mv.test.ts`. Local helpers:
  - `faultOnRename(ctx, { at, fault })`: delegates every member to the inner fs (start from
    `withoutDirectoryRename(ctx)`, part 3) and throws `fault` on the `at`-th `rename` call
    (1-based) whose `src` is not under /repo/.git, so the leaf path has moved `at - 1`
    leaves. Fault: `permissionDenied('/abs/x')`.
  - A path-folding wrapper that maps every path argument beginning /repo/T/D to /repo/T/d
    on every member it forwards (`lstat`, `readdir`, `mkdir`, `rename`, `rmRecursive`,
    `exists`, `write`, …) — simulates a case-insensitive host on the case-sensitive memory adapter.
  - Assertions use `exists`, `readWork`, `indexView` / `indexEntry`, `vi.fn` spies (import
    `vi` from vitest; the file currently imports only `describe, expect, it`).

### TDD steps

1. RED — "Given d (tracked d/f, d/g; untracked d/u; empty d/emp) and a rename fault at the
   2nd leaf, When mv(['d'], 'e') with skipErrors, Then it returns, skipped is
   `[{ source: 'd', reason: 'rename-failed' }]`, the index holds e/f and e/g, and neither d
   nor e exists". Fails: part 5 deletes d but leaves the moved leaf under e.
2. GREEN — `removePartialMove` called unconditionally in `renameOrSkip`'s catch (no guards yet).
3. RED — guard 3a, "Given a file base → S whose rename (stubbed for a `src` ending in base
   only, so the index commit still renames) writes S and then throws, Then S
   still exists with base's bytes, base exists and the index keeps base". Fails: the
   unconditional removal deletes S.
4. GREEN — `abandonsSource` with the `kind === 'directory'` operand only.
5. RED — guard 3b, "Given d/y, d/z and a lossy d/<0xff> member, a rename fault at the 2nd
   leaf, Then the first leaf stays under e, the other under d, the lossy entry stays in the
   index under d/, and d exists" (hoisted `seedMember` from part 5 with extra member d/z).
   Fails: the removal deletes e and its moved leaf.
6. GREEN — `PlanItem.retained` threaded from `validateMove` → `buildPlan`; the
   `retained.length === 0` operand.
7. RED — guard 1, "Given x/d and y/D moved into T where T/D aliases T/d (path-folding
   wrapper), tracked x/d/f, y/D/g, y/D/u and T/keep, a rename fault at the 3rd leaf, Then
   T/d/f still exists, y/D is gone, and skipped is `[{ source: 'y/D', reason: 'rename-failed' }]`".
   Fails: the removal of `T/D` (folded to `T/d`) deletes the first pair's T/d/f.
8. GREEN — `targetWasAbsent` read before the rename.
9. RED — guard 2, "Given the leaf path's first mkdir of /repo/e faulting, Then rmRecursive
   is called with /repo/d and never with /repo/e" (spy on `rmRecursive`; fault keyed on
   `mkdir('/repo/e')`, not on call order). Fails: `discardDirectory('e')` calls
   `rmRecursive('/repo/e')` (the memory adapter's idempotent `rmRecursive` hides it without the spy).
10. GREEN — the early return in `removePartialMove`.
11. GUARD — "Without skipErrors, the same fixture as step 1 rejects with the injected fault,
    the index is unchanged, the first leaf is under e and the rest under d". Passes:
    `renameOrThrow` never removes; kills a removal leaking into the throw path.
12. REFACTOR — none expected; each function ≤ 20 lines.

### Gate

`npx vitest run test/unit/application/commands/mv.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/mv.ts test/unit/application/commands/mv.test.ts && npm run check:spelling`

### Commit

`fix(mv): remove a partial entry-by-entry move under skipErrors as git leaves none`

## Part 7 — Case-only file rename under core.ignorecase

### Context

Files edited: `src/application/commands/mv.ts`, `test/unit/application/commands/mv.test.ts`.

No new exported symbol (`DestinationPolicy` is internal).

- `src/application/commands/mv.ts`: `destinationFree(ctx, byPath, target, kind, force: boolean)`
  (near line 284 before part 5; name unchanged) computes
  `byPath.has(keyOfPath(target)) || (await lstatOrUndefined(ctx, target)) !== undefined`,
  then `kind === 'file' && force` when it exists. Called from `validateMove(ctx, byPath, source, target, opts)`
  as `destinationFree(ctx, byPath, target, classified.kind, opts.force === true)`.
- Target (design § 4, "Row 6"): replace `force: boolean` with
  `policy: DestinationPolicy` where `interface DestinationPolicy { readonly force: boolean; readonly ignoreCase: boolean }`;
  ```ts
  const onDisk = (await lstatOrUndefined(ctx, target)) !== undefined
    && !(kind === 'file' && policy.ignoreCase && asciiLower(source) === asciiLower(target));
  const exists = byPath.has(keyOfPath(target)) || onDisk;
  ```
  (`destinationFree` gains the `source` argument.) `ignoreCase` is read once per call:
  `(await readConfig(ctx)).core?.ignoreCase === true` — import `readConfig` from
  ../primitives/config-read.js and `asciiLower` from ../../domain/pretty/ascii.js
  (precedent: src/application/commands/stash.ts near line 659). Thread the policy from the
  planning function (part 5's extraction) → `buildPlan` → `validateMove` → `destinationFree`.
  `byPath.has` stays case-exact. The `kind === 'file'` operand is git's: a directory source
  has no ignore-case escape.
- Tests in `test/unit/application/commands/mv.test.ts`, new
  `describe('mv — a destination that differs only in case')`. Seed config with
  `updateConfigEntries(ctx, [{ section: 'core', key: 'ignorecase', value: 'true' }])` from
  src/application/primitives/update-config.js (stash.test.ts precedent). Alias simulation:
  an `lstat` stub answering the upper-case work path with the lower-case path's stat (the
  memory adapter is case-sensitive; the rename itself then moves `f` to `F` on memory).

### TDD steps

1. RED — "Given core.ignorecase true and F aliasing f, When mv(['f'], 'F'), Then it moves
   (index holds F, not f; disk holds F)". Fails: `MV_DESTINATION_EXISTS { source: 'f', destination: 'F' }`.
2. GREEN — `DestinationPolicy`, `readConfig` read, the escape in `destinationFree`.
3. GUARD — `describe.each` over config `'false'` and no `core.ignorecase` at all: same alias,
   `mv(['f'], 'F')` refuses `MV_DESTINATION_EXISTS { source: 'f', destination: 'F' }`, index
   unchanged. Kills the `policy.ignoreCase` operand and an `=== true` → `!== false` mutant.
4. GUARD — "Given core.ignorecase true and an existing G that is not a case variant, When
   mv(['f'], 'G'), Then it refuses MV_DESTINATION_EXISTS". Kills the `asciiLower`
   comparison forced true.
5. GUARD — "Given core.ignorecase true, a directory a/d and A aliasing a, with A/d answered
   as a/d's stat, When mv(['a/d'], 'A'), Then it refuses MV_DESTINATION_EXISTS
   `{ source: 'a/d', destination: 'A/d' }` with index and disk unchanged". Kills the
   `kind === 'file'` operand.
6. GUARD — "Given core.ignorecase true and A aliasing a, When mv(['a/g'], 'A'), Then a/g
   moves to A/g" (into-dir mode, file twin). Passes after step 2.
7. GUARD — existing force rows ("Given force and a tracked destination file", "Given force
   and an on-disk untracked destination", "Given a directory source over an existing file
   with force") stay green: `force` is now read from the policy.
8. REFACTOR — no boolean parameter left on `destinationFree`.

### Gate

`npx vitest run test/unit/application/commands/mv.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/mv.ts test/unit/application/commands/mv.test.ts && npm run check:spelling`

### Commit

`fix(mv): rename a file whose name differs only in case under core.ignorecase`

## Part 8 — Interop: directory moves past PATH_MAX and skipErrors on long names

### Context

Files edited: `test/integration/mv-interop.test.ts`,
`test/integration/pathspec-length-interop.test.ts`,
`test/integration/interop-helpers.ts`.

No `src/` delta: cross-tool proof of parts 3–6 (decision P-1). Every row is a GUARD (the
behaviour already landed); a red row is a real divergence → blocker protocol, never a
test edit to make it pass.

- `test/integration/mv-interop.test.ts`: top-level
  `describe.skipIf(!GIT_AVAILABLE)('mv porcelain interop')` with `makePeerPair('mv')`
  (peer = git, ours = tsgit via `openRepository({ cwd: pair.ours })` + `repo.init()`),
  helpers `writeBoth`, `seed(files)`, `snapshot(dir)` (`lsStage`, `writeTreeOf`),
  `pathExists`. Add new describes **outside** that block where they need their own root:
  `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` with a `realpath`ed
  `mkdtemp` root, `pathMax = Number(execFileSync('getconf', ['PATH_MAX', root]).toString().trim())`
  in `beforeAll`, `levels = Math.floor(pathMax / 201) + 2`, `Q200 = 'q'.repeat(200)`.
  Build the deep chain with `execFileSync('sh', ['-c', 'for i in $(seq N); do mkdir Q && cd Q; done; : > leaf'], { cwd })`
  (`process.chdir` is refused in vitest workers; an absolute `mkdir` of the chain is
  ENAMETOOLONG). An Arrange precondition asserts the absolute leaf length exceeds `pathMax`.
  Verify the leaf with the same `cd` chain + `test -f leaf`. Teardown with
  `execFileSync('rm', ['-rf', root])` — node's `rm` resolves absolute paths and can fail
  past PATH_MAX (verify; keep `rm -rf` if it does).
- Never compare `status` on the deep rows (tsgit's walk refuses past PATH_MAX — out of
  scope); compare `git ls-files -s` of both twins and the disk shape.
- `test/integration/pathspec-length-interop.test.ts`: block
  `describe.skipIf(!GIT_AVAILABLE || win32)('Given long pathspecs against a tracked long name')`
  owns `S300`, `BASE`, `twins(modified, untracked, extraTracked)` (returns
  `{ gitRepo, tsgitRepo, ctx: createNodeContext({ workDir: tsgitRepo }) }`; `extraTracked`
  is committed, `untracked` written), `snapshotOf`, `filesOf`, `caught`,
  `tryRunGitWithExit`. Rows M2–M7 end near line 1058; add M8 and M9 after M7 using the
  file's `(row Mn)` title convention, calling `mv` directly as M2–M7 do.
- `test/integration/interop-helpers.ts`: add an exported `mvVerboseLines(sources, targetOf, result, directorySources)`
  rebuilding git's `mv -v` stdout from tsgit's fields (design § P5 "Rebuilding git's
  view"): one `Renaming <source> to <target>` line per argv source, then one line per
  `moved` entry whose `from` lies under a directory source, grouped by argv source. Rows
  whose argv order differs from byte order compare member lines as a set. Part 9 reuses it.

### TDD steps

1. GUARD — rows 1 and 2: tracked d/f plus an untracked deep chain under d (row 1) /
   under d/a with tracked d/z (row 2); `git mv d e` vs `repo.mv(['d'], 'e')`; same
   `ls-files -s`; `e/f` (or `e/z`) present, d absent, the leaf exists under e in both.
   Passes: part 3's one-step rename never reads a descendant.
2. GUARD — row 3: row 1 inside `git worktree add` of each twin; tsgit opened on the linked
   tree. Passes for the same reason.
3. GUARD — row E (every platform with git, inside the existing peer-pair block): tracked
   d/f, empty d/emp, untracked d/u; `mv d e`; both twins hold e/emp, e/f, e/u.
4. GUARD — row H: `X` of relative length `pathMax - 150` built by the shell chain, sources
   `L` = `'l'.repeat(200)` (tracked L/f, L/s/t, untracked L/u) and file b; preconditions
   `rel(X/L) > pathMax` and `abs(X/b) < pathMax`; `git mv -k -v L b X` vs tsgit
   `mv(['L', 'b'], 'X', { skipErrors: true })` on the twin; `ls-files -s` parity, L gone and X/b
   present in both, git's `-v` lines equal `mvVerboseLines(…)`, `skipped` equals
   `[{ source: 'L', reason: 'rename-failed' }]`.
5. GUARD — M8: `twins([], ['d/u'], ['d/f', 'd/s/t'])`; `git mv -k -v d S300` vs
   `mv(ctx, ['d'], S300, { skipErrors: true })`; git exit 0; `ls-files -s` parity and
   `filesOf` parity (d gone, base kept); `-v` rebuild; `skipped` `[{ source: 'd', reason: 'rename-failed' }]`.
   Do not compare `snapshotOf`'s `status` (git warns `File name too long`).
6. GUARD — M9: `git mv -k -v base S300` vs `mv(ctx, [BASE], S300, { skipErrors: true })`;
   git exit 0; `snapshotOf` and `filesOf` equal to before in both; `result` equals
   `{ moved: [], skipped: [{ source: 'base', reason: 'rename-failed' }] }`; `-v` rebuild
   (one line).

### Gate

`npx vitest run test/integration/mv-interop.test.ts test/integration/pathspec-length-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/mv-interop.test.ts test/integration/pathspec-length-interop.test.ts test/integration/interop-helpers.ts && npm run check:spelling`

### Commit

`test(mv): pin directory moves past PATH_MAX and skipErrors on long names against git`

## Part 9 — Interop: case-folded moves on a case-insensitive host

### Context

Files edited: `test/integration/mv-interop.test.ts`.

No `src/` delta: cross-tool proof of parts 3, 5, 6 and 7. Every row is a GUARD.

- Gate every describe on a **host probe**, not `process.platform`: precedent
  `isCaseInsensitiveFilesystem()` in test/integration/checkout-leading-symlink-interop.test.ts
  near line 49 (write `Probe-File` in a fresh `mkdtemp`, `existsSync('probe-file')`,
  top-level `await`). Use `describe.skipIf(!GIT_AVAILABLE || !CASE_INSENSITIVE)` and
  `describe.each(['true', 'false'])` over `core.ignorecase`, set in **both** twins with
  `runGit(['-C', dir, 'config', 'core.ignorecase', value])` (git init on macOS writes `true`).
- Reuse part 8's `mvVerboseLines` from test/integration/interop-helpers.ts and the file's
  peer-pair helpers (`seed`, `snapshot`, `pathExists`). Rebuild git's refusal text from
  tsgit's fields with a local errno table (`EINVAL` → `Invalid argument`); never compare
  tsgit to a rendered string.
- Row L excludes Windows (`process.platform !== 'win32'`): node's directory-replace arm is unpinned there.

### TDD steps

1. GUARD — row 5, both values: tracked d/f, d/g, untracked d/u; `git mv d D` exit 128,
   stderr contains `renaming 'd' to 'D/d' failed: ` + the errno text of tsgit's
   `data.reason`; tsgit rejects `UNSUPPORTED_OPERATION { operation: 'filesystem' }`; both
   twins keep `ls-files -s` and every disk entry, d/u included.
2. GUARD — row 5-n (true): `git mv -n d D` vs `{ dryRun: true }`: tsgit `moved` equals git's
   `Renaming` lines minus the directory's own line.
3. GUARD — row 5-k, both values: tracked d/f, d/g, d/s/t, untracked d/u, d/s/u, empty d/emp;
   `git mv -k -v d D` exit 0 vs `skipErrors: true`; `ls-files -s` parity (`D/d/…`), disk
   empty but `.git` in both, `-v` rebuild, `skipped` `[{ source: 'd', reason: 'rename-failed' }]`.
   Title says the source is deleted as git deletes it.
4. GUARD — row C (true): tracked d/f, d/s/t, e/e1, untracked d/u; `git mv -k -v d e D` vs
   `repo.mv(['d', 'e'], 'D', { skipErrors: true })`; `ls-files -s` parity, both disks empty,
   `-v` rebuild.
5. GUARD — rows 6 / 6′ / 6-f / 6-d: tracked f, d/g (6, 6′) and a/g, a/d/f (6-f, 6-d).
   true: `mv f F`, `mv -f f F`, `mv d/g d/G`, `mv a/g A` all succeed in both with
   `ls-files -s` parity. false: `mv f F`, `mv d/g d/G`, `mv a/g A` refuse in both (git 128,
   tsgit `MV_DESTINATION_EXISTS`), `mv -f f F` moves in both. 6-d under both values:
   `mv a/d A` git 128 / tsgit `MV_DESTINATION_EXISTS { source: 'a/d', destination: 'A/d' }`;
   with `-k` / `skipErrors`: git 0, tsgit `skipped` `[{ source: 'a/d', reason: 'destination-exists' }]`,
   nothing changed in either twin.
6. GUARD — row L (both values, not win32): tracked x/d/f, y/D/g, y/D/u, T/keep. Without
   `-k`: git 128, tsgit rejects `DIRECTORY_NOT_EMPTY`; `ls-files -s` parity (unchanged),
   disk parity (T/d/f moved in both). With `-k -v`: `ls-files -s` parity
   (`T/D/g T/D/u T/d/f T/keep`), disk parity (T/d/f and T/keep, y/D gone), `-v` rebuild,
   `skipped` `[{ source: 'y/D', reason: 'rename-failed' }]`.

### Gate

`npx vitest run test/integration/mv-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/mv-interop.test.ts && npm run check:spelling`

### Commit

`test(mv): pin case-folded directory and file moves against git`

## Part 10 — Docs

### Context

Files edited: `docs/use/commands/mv.md`, `docs/known-divergences.md`, `docs/BACKLOG.md`.

No `src/` delta. Content is design § 7; no ADR numbers in `docs/use/` prose.

- `docs/use/commands/mv.md` (101 lines): signature block's `type MvSkipReason` → add
  `| 'rename-failed'`; the `MvResult` comment lists the five reasons. Options table row
  `skipErrors`: also skips a pair whose working-tree rename the file system refuses. Add a
  paragraph after the destination-mode paragraph: a directory moves in one step on node and
  memory, so a refusal leaves it untouched; on the browser adapter it moves entry by entry
  and a failure midway can leave it partially moved. Case-only renames: under
  `core.ignorecase=true` a **file** whose destination differs only in ASCII case moves; a
  directory whose destination exists by case refuses whatever the setting. New section
  "Skipping errors deletes data as git does" with the 5-k example: a refused file rename
  leaves the file where it is (index and disk); a refused directory rename still moves its
  tracked entries in the index, then deletes the source directory with everything in it,
  untracked files included, and anything another source of the same call moved into it;
  both reported in `skipped` as `'rename-failed'`, a directory's members also in `moved`.
  On the entry-by-entry adapter a move failing partway under `skipErrors` also removes what
  it placed at the destination; without `skipErrors` the partial move stays. "Byte-exact
  paths" paragraph: a directory holding a lossy member keeps its source, and a partial move
  of it stays at the destination. `PATH_TOO_LONG` Throws line: inside a directory move
  `path` names the directory's destination (entry-by-entry: the leaf's destination); add
  "unless `skipErrors`". Closing sentence: the first four are planning refusals collected
  in `skipped` under their own reason; a working-tree rename the file system refuses is
  collected as `'rename-failed'`; the rest always throw.
- `docs/known-divergences.md`: remove the **32.72** bullet (near line 212) and its fenced
  block (the two-line `git mv -k base <s300>` / `tsgit mv(…)` block) plus one blank line.
- `docs/BACKLOG.md`: entry `- [ ] **32.67** …` (near line 763) → `- [x]`, and append
  exactly ` · ADRs 1217–1225 · design/mv-directory-one-rename.md` at the end of that entry
  (precedent: the 32.60 entry's tail). `## Release order` table row 3 (near line 46):
  `· 32.67 ·` → `· ~~32.67~~ ·`. Touch nothing else.
- docs/use/errors.md needs no change (`UNSUPPORTED_OPERATION` already covers a directory
  renamed onto a destination inside itself). docs/design/mv-atomic-rename.md stays as history.

### TDD steps

1. GUARD — `npm run check:spelling` and the doc checks pass on the edited prose (no code
   behaviour; docs-only part).
2. GUARD — `rtk proxy grep -n "32.72" docs/known-divergences.md` returns nothing;
   `grep -n "~~32.67~~" docs/BACKLOG.md` matches row 3.

### Gate

`npm run check:spelling && npm run check:doc-links` (biome does not process markdown, so
the manifest's biome step has no touched file here).
Phase gate after this part: `npm run validate`.

### Commit

`docs(mv): document one-step directory moves and the data skipErrors deletes`

## Part 11 — The mv refusal code for a destination beyond a symbolic link

### Context

Files edited: `src/domain/commands/error.ts`, `src/domain/commands/index.ts`,
`src/domain/error.ts`, `test/unit/domain/error.test.ts`, `test/unit/domain/exhaustiveness.ts`,
`reports/api.json` (regenerated, never hand-edited).

Written for design candidate N5 = A. With N5 = B this part is dropped.

Public-surface decision: `MV_DESTINATION_BEYOND_SYMLINK` (a `TsgitErrorData` member) and
`mvDestinationBeyondSymlink` (re-exported through src/domain/index.ts's
`export * from './commands/index.js'`) are **public**. Surface gates (.claude/workflow/surface-gates.md
§ "New error code"): the union, the exhaustiveness switch, api.json. No barrel-surface set test
exists for the domain factories (checked: `mvIntoSelf` appears only in test/unit/domain/error.test.ts
under test/). The `MV_*` codes are documented on docs/use/commands/mv.md, not docs/use/errors.md;
that page changes in Part 13.

- `src/domain/commands/error.ts`: the union arm list holding
  `| { readonly code: 'MV_INTO_SELF'; readonly source: FilePath; readonly destination: FilePath }`
  (near line 438). Add after `MV_DESTINATION_DIRECTORY_MISSING`'s arm:
  `| { readonly code: 'MV_DESTINATION_BEYOND_SYMLINK'; readonly source: FilePath; readonly destination: FilePath }`
  (biome may wrap it across lines like its neighbours). The factory block "`mv` refusal
  factories" (near line 1393) holds
  `export const mvDestinationDirectoryMissing = (source: FilePath, destination: FilePath): TsgitError => …`;
  add after it
  `export const mvDestinationBeyondSymlink = (source: FilePath, destination: FilePath): TsgitError =>
  new TsgitError({ code: 'MV_DESTINATION_BEYOND_SYMLINK', source, destination });`.
- `src/domain/commands/index.ts`: the alphabetical `export { … } from './error.js'` list
  (`mvBadSource`, `mvDestinationDirectoryMissing`, …, near line 29): add `mvDestinationBeyondSymlink`
  before `mvDestinationDirectoryMissing`.
- `src/domain/error.ts`: the message `switch` (`case 'MV_DESTINATION_DIRECTORY_MISSING':` near
  line 729, ends in `const _exhaustive: never = data;` near line 861). Add
  `case 'MV_DESTINATION_BEYOND_SYMLINK': return \`destination is beyond a symbolic link, source=${data.source}, destination=${data.destination}\`;`
  — git's text, pinned (design § Pinned matrix — destination beyond a symbolic link, row Y1).
- `test/unit/domain/exhaustiveness.ts`: `assertExhaustiveSwitch`, the `case 'MV_…':` run near
  line 228: add `case 'MV_DESTINATION_BEYOND_SYMLINK':`.
- `test/unit/domain/error.test.ts`: factories are imported from ../../../src/domain/index.js
  (the block listing `mvIntoSelf`, near line 49). Clone the
  `describe("Given mvDestinationExists('a.txt', 'keep.txt')")` block (near line 1005): data
  `{ code, source, destination }` with `toEqual` and the full message
  `'MV_DESTINATION_BEYOND_SYMLINK: destination is beyond a symbolic link, source=dir/a, destination=lnk/x/a'`.

### TDD steps

1. RED — the error.test.ts row for `mvDestinationBeyondSymlink('dir/a', 'lnk/x/a')`: data and
   message. Fails to compile (no export).
2. GREEN — the union arm, the factory, the barrel line, the message case, the exhaustiveness case.
   `npm run check:types` green proves every `never` switch is wired.
3. REFACTOR — none. Run `npm run docs:json` and stage `reports/api.json`.

### Gate

`npx vitest run test/unit/domain/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commands/error.ts src/domain/commands/index.ts src/domain/error.ts test/unit/domain/error.test.ts test/unit/domain/exhaustiveness.ts && npm run check:spelling`
Before commit: `npm run docs:json` (commit the regenerated `reports/api.json`).

### Commit

`feat(mv): add the refusal code for a destination beyond a symbolic link`

## Part 12 — Refuse a destination beyond a symbolic link

### Context

Files edited: `src/application/commands/mv.ts`,
`src/application/commands/internal/resolve-pathspec.ts`,
`test/unit/application/commands/mv.test.ts`, `reports/api.json` (regenerated).

Design: § 8, R15–R17, rows Y1–Y20 of "Pinned matrix — destination beyond a symbolic link".
Written for N4 = A (one `skipped` entry per member). Depends on Part 11 (with N5 = B, replace
`mvDestinationBeyondSymlink(source, target)` by `pathspecBeyondSymlink(target)` and drop the
Part 11 dependency).

Public-surface decision: `MvSkipReason` gains `'destination-beyond-symlink'` → **public**
(api.json). `beyondSymlink`'s new export is internal (commands/internal, consumed by `mv.ts`
only).

- `src/application/commands/internal/resolve-pathspec.ts`: the module-private
  `const beyondSymlink = async (scanner: LeadingPathScanner, target: FilePath): Promise<boolean>`
  (near line 105, comment "git's lstat_cache records a failed lstat as 'not a symlink'") becomes
  `export const`. Body unchanged: `scanner.hasSymlinkedLeadingPath(target)`, and an
  `isPathTooLong(err)` catch answering `false`. Its existing callers and tests stay as they are.
- Scanner: `createLeadingPathScanner(ctx: Context): LeadingPathScanner` and the
  `LeadingPathScanner` type in src/application/primitives/internal/symlinked-leading-path.ts
  (read-only). `hasSymlinkedLeadingPath(path)` scans the leading components only (never the
  leaf), stops at a missing component, reports a regular file as `kind: 'file'` (not a link), and
  memoizes each prefix for the scanner's lifetime. Import it into mv.ts from
  ../primitives/internal/symlinked-leading-path.js; import `beyondSymlink` from
  ./internal/resolve-pathspec.js.
- `src/application/commands/mv.ts`, current shape (after Parts 1–10):
  - `export type MvSkipReason = 'source-not-tracked' | 'bad-source' | 'destination-exists' | 'into-self' | 'rename-failed'`
    with its doc comment "The first four are decided while planning". Add
    `| 'destination-beyond-symlink'` before `'rename-failed'`; the comment says the first five.
    `type PlanSkipReason = Exclude<MvSkipReason, 'rename-failed'>` picks it up unchanged.
  - `type Verdict` success arm `{ kind; entries; retained }`: add
    `readonly skippedMembers: ReadonlyArray<IndexEntry>`; every existing success return passes `[]`.
  - `interface DestinationPolicy { force; ignoreCase }` + `destinationPolicyOf(ctx, opts)`: add
    `readonly scanner: LeadingPathScanner`, built with `createLeadingPathScanner(ctx)`.
  - `validateMove(ctx, byPath, source, target, opts, policy): Promise<Verdict>`: insert after the
    `into-self` line and **before** the `parent`/`isDirectoryOnDisk` check (whose Stryker comment
    line must stay directly above its `if`):
    `if (await destinationBeyondSymlink(ctx, policy.scanner, target)) return beyondSymlinkVerdict(…)`.
    `validateMove` is already near 20 lines; if the insertion pushes it over, extract the
    destination half (parent check + `destinationFree`) into a helper.
  - New `destinationBeyondSymlink(ctx, scanner, target)`:
    `(await lstatOrUndefined(ctx, target)) === undefined && (await beyondSymlink(scanner, target))`.
    The first operand is load-bearing (rows Y16–Y18: an existing destination is never this
    refusal).
  - New `beyondSymlinkVerdict(kind, source, target, entries, members, opts): Verdict` as design § 8:
    file → `{ skip: 'destination-beyond-symlink' }`; directory + `skipErrors` →
    `{ kind: 'directory', entries: [], retained: members, skippedMembers: entries }`; directory
    without → `{ skip, source: first.path, target: repath(first, source, target) }` with
    `first = entries[0]` (non-empty: `if (entries.length === 0) return { skip: 'bad-source' }`
    precedes). Avoid a boolean parameter: pass `opts` (the record), as `validateMove` does.
  - `buildPlan`: on a success verdict, push
    `verdict.skippedMembers.map((member) => ({ source: member.path, reason: 'destination-beyond-symlink' }))`
    into `skipped` before pushing the plan item.
  - `refusal(reason: PlanSkipReason, source, target)`: add
    `case 'destination-beyond-symlink': return mvDestinationBeyondSymlink(source, target);` and the
    import from ../../domain/commands/error.js.
  - `resolveDestinationMode(ctx, firstSource, destination, destNoSlash)`: read
    `destination.endsWith('/') ? await statOrUndefined(ctx, destNoSlash) : await lstatOrUndefined(ctx, destNoSlash)`
    (R17). New `statOrUndefined` beside `lstatOrUndefined`, same shape over `ctx.fs.stat`.
  - Unchanged and relied on: `executePlan` → `repathItem` (no moves for `entries: []`) →
    `renameEach` (the directory is renamed) → `movesIndex` (directory: always, no-op) →
    `removeAbandonedSources` (members remain → no deletion) and `abandonsSource`
    (`retained.length === 0` false → no partial-move removal).
- `test/unit/application/commands/mv.test.ts` (1808 lines): module helpers `seedAndStage(workingTree)`
  (memory context, seeds and stages), `work(ctx, path)`, `exists(ctx, path)`, `readWork`,
  `indexEntry(ctx, path)`, `expectError(fn, code)`; `captureError` near line 852; `indexView` and
  `seedMember` in `describe('mv on a directory holding a lossy member')`; `failingRename` in
  `describe('mv — a move the file system refuses')`. Add a new top-level
  `describe('mv — a destination beyond a symbolic link')` after
  `describe('mv — a destination that differs only in case')`. Create links with
  `ctx.fs.symlink(target, work(ctx, name))` (port signature `(target, path)`) after
  `seedAndStage`; the link need not be tracked (row Y8). Memory layout: /repo, /repo/.git.
- Trap: check first that the memory adapter's `lstat`, `exists` and `renameDirectory` resolve a
  **leading** link (`walkLookup(path, 'no-follow')` follows every component but the last). If its
  rename does not follow `inner` to `sub`, assert the directory row's disk outcome with
  `!exists('dir')` plus the index, and leave the through-the-link disk shape to Part 13's interop.

### TDD steps

1. RED → GREEN — file pairs without `skipErrors` (`it.each`): `f → inner/g` (link at the parent),
   `f → deep/dl/g` (deeper link), `f → dang/x` (dangling), `f → pointer/x` (link to a file),
   `f → inner/absent/x` (missing below the link), and `force: true` on `f → inner/g`. Each rejects
   `{ code: 'MV_DESTINATION_BEYOND_SYMLINK', source: 'f', destination: <target> }` (try/catch on
   `.data`), index and disk unchanged. Add `dryRun: true` → same refusal (row Y13).
2. RED → GREEN — a directory `dir` (`dir/a`, `dir/b`) → `inner/x`: rejects with
   `{ source: 'dir/a', destination: 'inner/x/a' }` (first member), nothing changed.
3. RED → GREEN — `skipErrors`: file → `{ moved: [], skipped: [{ source: 'f', reason:
   'destination-beyond-symlink' }] }`, nothing written. Directory → returns, `moved` `[]`,
   `skipped` `[{ source: 'dir/a', … }, { source: 'dir/b', … }]` in that order, index still
   `dir/a dir/b`, `dir` gone from disk. Two sources `['dir', 'ghost']` into `inner/sub2` (seed
   `sub/sub2/k` so it is a real directory reached through the link: into-directory mode without
   the slash, so this row does not need step 5) → the member skips, then `{ source: 'ghost', reason: 'source-not-tracked' }`. `dryRun` + `skipErrors` → the
   same result, nothing written. A directory whose `renameDirectory` refuses (`failingRename`)
   under `skipErrors` → `skipped` ends with `{ source: 'dir', reason: 'rename-failed' }`, `dir` and
   every file under it still exist, nothing removed under the target (R11/R14 inert).
4. RED → GREEN — order and gate guards (each isolated): an existing `sub/keep` reached as
   `inner/keep` (row Y17) still rejects `MV_DESTINATION_DIRECTORY_MISSING`, with and without
   `force` (kills the `lstat === undefined` operand); `dir → dir/l/x` with `dir/l` a link rejects
   `MV_INTO_SELF` (row Y15); an untracked present `u → inner/u` rejects `MV_SOURCE_NOT_TRACKED`
   (row Y14); `dir → sub/keep/x` (a regular file in a leading component) rejects
   `MV_DESTINATION_DIRECTORY_MISSING` (row Y19); an `lstat` stub (`{ ...ctx.fs, lstat }`) raising
   `pathTooLong` for exactly `<root>/inner` (on the ctx handed to `mv`, so the scanner built in
   `destinationPolicyOf` sees it too) makes `f → inner/g` reject
   `MV_DESTINATION_DIRECTORY_MISSING`, not `PATH_TOO_LONG` nor the new code (the tolerance).
5. RED → GREEN — R17: `f → 'inner/'` rejects `{ source: 'f', destination: 'inner/f' }`;
   `skipErrors` `dir → 'inner/'` renames `dir` (member skips as step 3); `f → 'dang/'` and
   `f → 'pointer/'` reject `MV_DESTINATION_DIRECTORY_MISSING { destination: 'dang/' }` (resp.
   `'pointer/'`); `['f', 'g'] → 'inner'` (no slash) rejects `MV_DESTINATION_NOT_DIRECTORY`.
6. REFACTOR — `validateMove` and `buildPlan` ≤ 20 lines; run `npm run docs:json` and stage
   `reports/api.json`.

### Gate

`npx vitest run test/unit/application/commands/mv.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/mv.ts src/application/commands/internal/resolve-pathspec.ts test/unit/application/commands/mv.test.ts && npm run check:spelling`
Before commit: `npm run docs:json` (commit the regenerated `reports/api.json`).

### Commit

`fix(mv): refuse a destination beyond a symbolic link as git mv does`

## Part 13 — Interop and docs: a destination beyond a symbolic link

### Context

Files edited: `test/integration/mv-interop.test.ts`, `test/integration/interop-helpers.ts`,
`docs/use/commands/mv.md`.

No src/ delta: cross-tool proof of Part 12 plus its docs (decision P-1's shape). Every interop
row is a GUARD; a red row is a divergence → blocker protocol, never a test edit to make it pass.

- `test/integration/mv-interop.test.ts` (905 lines): add a top-level
  `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')('mv porcelain interop beyond a symbolic link', …)`
  after the case-insensitive block (near line 612), copying that block's per-test
  `prepare` (`makePeerPair`, `runGit(['init', '-q', '-b', 'main', pair.peer])`,
  `openRepository({ cwd: pair.ours })` + `repo.init()`), `afterEach` dispose, `writeBoth`, `seed`,
  `expectParity` (`lsStage` + `diskEntries`, near line 595). Add a `linkBoth(name, target,
  tracked)` helper: `symlinkSync(target, path.join(dir, name))` in both twins, then
  `runGit(['-C', pair.peer, 'add', '--', name])` and `repo.add([name])` when tracked. Use
  `pathExists(dir, rel)` (near line 46; `stat` follows links) for `.git/hooks/<name>/a` and
  `sub/<name>/a`. `outcomeOf(run)` (near line 600) returns the rejection's `data`;
  `tryRunGitWithExit(args)` returns `{ status, stdout, stderr }` (verify the field names).
- Rebuild git's refusal from tsgit's fields, never compare tsgit to a string:
  `` `fatal: destination is beyond a symbolic link, source=${data.source}, destination=${data.destination}` ``
  must be contained in git's stderr.
- `test/integration/interop-helpers.ts`: `mvVerboseLines(sources, targetOf, result,
  directorySources)` (near line 639) and `interface MvVerboseResult { moved }`. Widen the
  interface with `readonly skipped: ReadonlyArray<{ readonly source: string; readonly reason: string }>`
  and drop from the per-source lines every source that `skipped` names with a reason other than
  `'rename-failed'` (git prints nothing for a planning skip, rows Y4, Y5; a refused rename still
  prints, rows F, 5-k). Callers in parts 8 and 9 already pass the full `MvResult`; confirm they
  still compile and pass.
- `docs/use/commands/mv.md` (signature block `type MvSkipReason = …` near line 29; options table
  `skipErrors` row near line 54; "Skipping errors deletes data as git does" near line 82; Throws
  list near line 103; closing "The first four are planning refusals" near line 115): content as
  design § 7's ADR-1226 bullet. No ADR numbers in docs/use prose.

### TDD steps

1. GUARD — row Y1/Y2: tracked `dir/a dir/b f`, tracked `lnk -> .git`; `git mv dir lnk/hooks/x`
   and `git mv f lnk/hooks/pre-commit` exit 128 vs tsgit rejecting with the rebuilt message
   contained in git's stderr; `expectParity()` unchanged; `.git/hooks/x` absent in both.
2. GUARD — rows Y3, Y4, Y5: `-k -v` vs `skipErrors: true`: Y3 `dir → lnk/hooks/y`:
   `ls-files -s` parity (still `dir/…`), `dir` absent and `.git/hooks/y/a` present in both, git's
   stdout lines equal `mvVerboseLines(['dir'], …, result, ['dir'])` (one line), `skipped` per
   member. Y4 file: git stdout empty and `mvVerboseLines` `[]`, nothing changed. Y5
   `['dir', 'f2'] → lnk/hooks`: one line, `.git/hooks/dir/a` in both.
3. GUARD — rows Y6, Y7, Y8 with `inner -> sub` (tracked `sub/keep`), `dang -> nowhere`,
   `pointer -> f`: refusals parity (each pair of Y6/Y8); Y7 `-k -v dir inner/x`: `sub/x/a` present
   and untracked in both, `ls-files -s` parity.
4. GUARD — rows Y10–Y12: `f → inner/` refusal rebuilt with `destination=inner/f`; `-k -v dir f
   inner/` → `sub/dir/a` in both, `f` kept, one `-v` line; `f → dang/`, `f → pointer/`: git
   `destination directory does not exist` vs tsgit `MV_DESTINATION_DIRECTORY_MISSING` with the
   same `destination`.
5. GUARD — rows Y13, Y15: `-n` refuses in both; `-n -k` git exit 0 vs `dryRun + skipErrors`
   returning, nothing changed in either; `dir → dir/l/x` into-self in both.
6. Docs — the mv.md edits; `npm run check:spelling`.

### Gate

`npx vitest run test/integration/mv-interop.test.ts test/integration/pathspec-length-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/mv-interop.test.ts test/integration/interop-helpers.ts && npm run check:spelling && npm run check:doc-links`
Phase gate after this part: `npm run validate`.

### Commit

`test(mv): pin a destination beyond a symbolic link against git and document it`

## Part 14 — Treat an existing destination through a link as git does, and apply git's index replacement

### Context

Files edited: `src/application/commands/mv.ts`, `test/unit/application/commands/mv.test.ts`,
`test/integration/mv-interop.test.ts`, `docs/use/commands/mv.md`.

Design: § 9, R18, rows Z1–Z21 of "Pinned matrix — an existing destination through a link, and
the index replacement" (and Y17, Y18). Written for N7 = A (no new result field) and N9 = A (copy
git's forced write through a link into `.git`). Depends on Parts 12 and 13: the beyond-symlink
gate already sits between the `into-self` line and the parent check, `statOrUndefined` exists
beside `lstatOrUndefined`, and mv-interop has the `skipIf(!GIT_AVAILABLE || win32)` describe
"mv porcelain interop beyond a symbolic link" with `linkBoth(name, target, tracked)`. No public
surface change (no api.json regeneration): `MvResult`, the codes and the skip reasons are
unchanged.

- `src/application/commands/mv.ts`, current shape (after Parts 1–13):
  - `validateMove(ctx, byPath, source, target, opts, policy): Promise<Verdict>`: after the
    beyond-symlink gate, the block
    `const parent = dirname(target) as FilePath;` / the `// Stryker disable next-line StringLiteral: …`
    comment / `if (parent !== '' && !(await isDirectoryOnDisk(ctx, parent))) { throw mvDestinationDirectoryMissing(source, target); }`.
    The `if` and the Stryker comment line above it stay byte-identical (it is the existing
    approved directive and its text names `isDirectoryOnDisk`, which is why the helper keeps
    its name; do not edit or add any directive).
  - `isDirectoryOnDisk(ctx, path)` (bottom of the file: `lstatOrUndefined` + an
    `equivalent-mutant` comment + `stat?.isDirectory === true && stat.isSymbolicLink !== true`):
    keep the name and signature, change the body to
    `(await statOrUndefined(ctx, path))?.isDirectory === true`, and replace the
    `equivalent-mutant` comment by a one-line why-comment ("`stat` follows the parent's own link,
    as `rename(2)` does"). The `isSymbolicLink` operand goes: `stat` never reports a link, so it
    would be dead code. Its one caller is the parent check (confirm with Grep).
  - `destinationFree(ctx, byPath, source, target, kind, policy)`: unchanged. Its
    `lstatOrUndefined(ctx, target)` already resolves a leading link, so `'inner/keep'` reads as
    present.
  - `applyToIndex(byPath: Map<IndexPathKey, IndexEntry>, indexed: ReadonlyArray<ExecutedItem>): void`
    (today: a nested loop doing `byPath.delete(indexPathKey(from))` then
    `byPath.set(indexPathKey(to), to)` per move). Rewrite as design § 9: flatten the moves,
    delete every `from` first, snapshot `const remaining = Array.from(byPath.values())` (index
    order: `readIndexMap` inserted entries in on-disk order and only deletions happened), then for
    each `to` delete `conflictsWith(byPath, remaining, to.path)` and `set` the `to`. New
    `conflictsWith(byPath, remaining, path)` returns
    `[...entriesAtLeadingDirectories(byPath, path), ...entriesBeneath(remaining, path)]`.
  - Imports: `entriesAtLeadingDirectories`, `entriesBeneath` from
    ../../domain/git-index/directory-file-conflict.js (read-only; signatures
    `entriesAtLeadingDirectories(byKey: ReadonlyMap<IndexPathKey, IndexEntry>, path: FilePath): ReadonlyArray<IndexEntry>`
    — stage-0 entries at `a`, `'a/x'` for `'a/x/y'`; `entriesBeneath(sorted: ReadonlyArray<IndexEntry>, path: FilePath): ReadonlyArray<IndexEntry>`
    — binary search, every stage, lossy entries by bytes). Precedent consumer:
    src/application/commands/add.ts `dropBeneathInserted`.
- `test/unit/application/commands/mv.test.ts`: module helpers `seedAndStage(workingTree)`,
  `work(ctx, path)`, `exists(ctx, path)`, `readWork(ctx, path)`, `indexEntry(ctx, path)`,
  `expectError(fn, code)`, `captureError`; `add` is already imported (stage a link with
  `add(ctx, ['inner'])` after `ctx.fs.symlink('sub', work(ctx, 'inner'))`; port signature
  `symlink(target, path)`). Part 12's `describe('mv — a destination beyond a symbolic link')` holds
  the guard row "an existing `'sub/keep'` reached as `'inner/keep'` still rejects
  `MV_DESTINATION_DIRECTORY_MISSING`, with and without `force`": **flip it** to the R18
  expectations below; it keeps killing the gate's `lstat === undefined` operand (with that
  operand forced true, `'inner/keep'` would refuse `MV_DESTINATION_BEYOND_SYMLINK`). Add a sibling
  top-level `describe('mv — an existing destination through a link and the index replacement')`
  after it.
- Index drift fixtures (memory adapter, no git): `seedAndStage({ f: 'F', 'x/y': 'Y' })`, then
  `ctx.fs.rmRecursive(work(ctx, 'x'))` and `ctx.fs.write(work(ctx, 'x'), encode('X'))` makes `x`
  a file on disk while the index holds `'x/y'`; `seedAndStage({ f: 'F', t: 'T' })`, then
  `ctx.fs.rm(work(ctx, 't'))`, `ctx.fs.mkdir(work(ctx, 't'))`, write `'t/keep'`, makes `t` a
  directory while the index holds the file `t`. Use whatever byte-encoding helper the file
  already uses for `ctx.fs.write` (Grep `ctx.fs.write(` in it).
- Trap: confirm the memory adapter resolves the leading link on `rename` (`walk(dst, 'create')`)
  and on `mkdir` of the link itself (`mkdirThroughLeafSymlink` returns for a link to a directory).
  If `rename` does not follow `inner`, assert the unit row's disk outcome as `!exists('f')` plus
  the index and leave "`'sub/keep'` holds `F`" to the interop row; never weaken the index assertion.
- `test/integration/mv-interop.test.ts`: two places.
  - Inside Part 13's link describe, reusing its `prepare`, `writeBoth`, `seed`, `linkBoth`,
    `expectParity` (`lsStage` + `diskEntries`), `outcomeOf(run)` (the rejection's `data`) and
    `tryRunGitWithExit(args)` (returns `{ stdout, stderr, exitCode }`): rows Y17/Z1 (tracked and
    untracked `'sub/keep'`), Y18/Z2, Z4 (untracked `inner`), Z5 (`-k` vs `skipErrors`), Z7 (`-n -f`
    vs `dryRun` + `force`), Z9 (`deep/real/dl -> ../../sub`), Z10, Z11/Z12 (`'inner/'` with
    `'sub/f'`), Z21 (`lnk -> .git`, .git/description: read it in both twins and compare to `F`).
  - Inside the top-level `describe.skipIf(!GIT_AVAILABLE)('mv porcelain interop', …)` (every
    platform with git, like its existing `-f` row "When repo.mv -f overwrites one with the other"),
    rows Z15–Z20 with the drift built by `node:fs/promises` calls in both twins after `seed`
    (`rm`, `mkdir`, `writeFile` are already imported). Compare `lsStage(pair.ours)` to
    `lsStage(pair.peer)`.
  - Rebuild git's refusal from tsgit's fields, never compare tsgit to a literal message:
    a file source `` `fatal: destination exists, source=${data.source}, destination=${data.destination}` ``,
    a directory source `` `fatal: destination already exists, source=…, destination=…` `` (the
    existing row 6-d's convention), contained in git's stderr.
- `docs/use/commands/mv.md`: the options table's `force` row (near line 54), the Throws entry of
  `MV_DESTINATION_DIRECTORY_MISSING` (near line 103), and a short "Index replacement" paragraph
  after the lossy-member paragraph (near line 99): content as design § 7's ADR-1227 bullet. No ADR
  numbers in docs/use prose.

### TDD steps

1. RED → GREEN — planning through a link (memory, tracked `f sub/keep`, link `inner -> sub`
   tracked): `mv(['f'], 'inner/keep')` rejects `{ code: 'MV_DESTINATION_EXISTS', source: 'f',
   destination: 'inner/keep' }` (try/catch on `.data`), index and disk unchanged; the same with
   `sub/keep` untracked; `skipErrors: true` → `{ moved: [], skipped: [{ source: 'f', reason:
   'destination-exists' }] }`; `dryRun: true` → the same refusal; `mv(['dir'], 'inner/keep',
   { force: true })` → `MV_DESTINATION_EXISTS { source: 'dir', destination: 'inner/keep' }`.
   Flip Part 12's guard row. Isolated guard: a tracked regular file `g` and `mv(['f'], 'g/x')` still
   rejects `MV_DESTINATION_DIRECTORY_MISSING { source: 'f', destination: 'g/x' }` (kills
   `isDirectory === true` → `true`). GREEN: `isDirectoryOnDisk` reads with `statOrUndefined`.
2. RED → GREEN — the forced move and the replacement through a link: `force: true` on
   `f → inner/keep` returns `{ moved: [{ from: 'f', to: 'inner/keep' }], skipped: [] }`; the index
   has no `f` and no `inner`, has `inner/keep` with `f`'s oid and mode, and `sub/keep` with its
   original oid; `exists('f')` is false and `inner` is still a link (`ctx.fs.lstat`). With `inner`
   untracked: the index holds `inner/keep` and `sub/keep`. A deeper link
   `deep/real/dl -> ../../sub` (tracked): `f → deep/real/dl/keep` with `force` removes
   `deep/real/dl`, keeps `inner`. `dryRun` + `force` returns the same `moved` and writes nothing.
   GREEN: `applyToIndex` + `conflictsWith`.
3. RED → GREEN — the replacement without a link (each row isolates one operand of
   `conflictsWith`): entries beneath (`x/y` in the index, `x` a file on disk) — `mv(['f'], 'x',
   { force: true })` leaves `x` and no `x/y`; leading directory (`t` a file in the index, `t/keep`
   on disk) — `mv(['f'], 't/keep', { force: true })` leaves `t/keep` and no `t`; no `force`:
   `mv(['dir'], 't/d')` leaves `t/d/a` and no `t`, `mv(['f'], 't/new')` leaves `t/new` and no
   `t`. A directory move into an empty target (`mv(['dir'], 'e')`, existing rows) still lists
   every member (kills an emptied `from`-deletion loop through the index read-back).
4. GUARD — interop rows as the Context lists. Every row is a GUARD; a red row is a divergence →
   blocker protocol, never a test edit to make it pass. For Z21 also assert `.git/description`
   holds `F\n` in both twins (git's data-destroying arm, N9 = A).
5. Docs — the mv.md edits; `npm run check:spelling`.
6. REFACTOR — `validateMove`, `applyToIndex` and `conflictsWith` ≤ 20 lines each, no boolean
   parameter, no new directive.

### Gate

`npx vitest run test/unit/application/commands/mv.test.ts test/integration/mv-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/mv.ts test/unit/application/commands/mv.test.ts test/integration/mv-interop.test.ts && npm run check:spelling && npm run check:doc-links`

### Commit

`fix(mv): move onto an existing destination through a symbolic link and replace index entries as git mv does`

## Part 15 — Refuse an absent untracked source as a bad source

### Context

Files edited: `src/application/commands/mv.ts`, `test/unit/application/commands/mv.test.ts`,
`test/integration/mv-interop.test.ts`, `test/integration/pathspec-length-interop.test.ts`,
`docs/use/commands/mv.md`.

Design: § 10, R19, rows U1–U12 of "Pinned matrix — an absent untracked source". Depends on Part
14 only by file order (both edit `validateMove`); no shared code. Written for N8 = A (a present
directory without a tracked member keeps `MV_SOURCE_NOT_TRACKED` here; a later part changes it if N8 = A is ratified). No
public surface change: `MV_BAD_SOURCE` and `'bad-source'` already exist (no api.json).

- `src/application/commands/mv.ts`, `validateMove`'s first two lines:
  `const classified = classifySource(byPath, source);` and
  `if (classified.kind === 'untracked') return { skip: 'source-not-tracked' };`. Replace the
  second with `return { skip: await untrackedVerdictOf(ctx, source) }` and add
  `const untrackedVerdictOf = async (ctx: Context, source: FilePath): Promise<PlanSkipReason> => (await lstatOrUndefined(ctx, source)) === undefined ? 'bad-source' : 'source-not-tracked';`
  beside `sourceExistsOnDisk`, with a why-comment ("git's `lstat` of the source fails first").
  `lstatOrUndefined` (not `statOrUndefined`): a dangling untracked link is present (row U6).
  `buildPlan`/`refusal()` need no change: the verdict has no `source`/`target` override, so
  `refusal('bad-source', source, target)` names the user's source and the mode's target (U2:
  `'dir/ghost'`).
- `test/unit/application/commands/mv.test.ts` — every row that asserts the old answer for an
  absent path (find them with Grep on `MV_SOURCE_NOT_TRACKED` and `source-not-tracked`):
  - `describe('Given skipErrors and a mix of one bad and one good source')` (absent
    `ghost.txt`): `skipped` becomes `[{ source: 'ghost.txt', reason: 'bad-source' }]`.
  - `describe('Given an untracked source')` ("Then throws MV_SOURCE_NOT_TRACKED carrying source
    and destination", absent `ghost.txt` → `z.txt`): becomes the absent case, `MV_BAD_SOURCE {
    source: 'ghost.txt', destination: 'z.txt' }`; add a sibling `describe('Given an untracked
    file present on disk')` writing `loose.txt` with `ctx.fs.write(work(ctx, 'loose.txt'), …)`
    without staging it → `MV_SOURCE_NOT_TRACKED { source: 'loose.txt', destination: 'z.txt' }`
    (U5). The two rows together kill `untrackedVerdictOf`'s ternary.
  - `describe('Given one bad source among good ones without skipErrors')` →
    `expectError(…, 'MV_BAD_SOURCE')`; `describe('Given an mv that throws before commit')` (lock
    release) → `'MV_BAD_SOURCE'`.
  - The three tolerance rows `describe('Given a corrupt index (INVALID_INDEX_HEADER)')`,
    `(INVALID_INDEX_ENTRY)` and `describe('Given readIndex racing to FILE_NOT_FOUND')` call
    `seedRepo(ctx, {})` and expect `MV_SOURCE_NOT_TRACKED` for an absent `a.txt`: change their
    seeding to `seedRepo(ctx, { workingTree: { 'a.txt': 'a' } })` so `a.txt` is on disk and the
    row still proves "the index reads as empty" with `MV_SOURCE_NOT_TRACKED`. Leave the
    `PERMISSION_DENIED` propagation row as it is.
  - `describe('Given an untracked ghost and a refused base in one call')` (absent `ghost`):
    the first `skipped` entry becomes `{ source: 'ghost', reason: 'bad-source' }`.
  - Part 12's row "Two sources `['dir', 'ghost']` into `'inner/sub2'`" in
    `describe('mv — a destination beyond a symbolic link')`: `ghost`'s entry becomes
    `{ source: 'ghost', reason: 'bad-source' }`.
  - New rows next to "Given an untracked source": into a directory (`mv(['ghost'], 'dir')` with
    a tracked `'dir/keep'`) → `{ source: 'ghost', destination: 'dir/ghost' }` (U2); a missing
    parent (`'missing/z'`) → `MV_BAD_SOURCE` (U3); `dryRun` → `MV_BAD_SOURCE` (U4); an untracked
    dangling link `ctx.fs.symlink('nowhere', work(ctx, 'dl2'))` → `MV_SOURCE_NOT_TRACKED` (U6,
    kills an `lstat` → `stat` swap); `skipErrors` with `['ghost', 'loose.txt', 'gone', 'f']` into
    `dir` (`gone` tracked then removed with `ctx.fs.rm`) → `skipped` `[{ ghost, 'bad-source' },
    { loose.txt, 'source-not-tracked' }, { gone, 'bad-source' }]` and `f` moved (U10).
- `test/integration/mv-interop.test.ts`: the top-level row `describe('Given an untracked source
  path')` / "Then it refuses like git mv and mutates nothing" (absent `ghost.txt` → `dest.txt`,
  `expect(code).toBe('MV_SOURCE_NOT_TRACKED')`): switch git to `tryRunGitWithExit` (returns
  `{ stdout, stderr, exitCode }`), expect exit 128, `code` `MV_BAD_SOURCE`, and git's stderr to
  contain the message rebuilt from tsgit's `data` (`` `fatal: bad source, source=${data.source}, destination=${data.destination}` ``).
  Add beside it: a present untracked file (U5: `not under version control`, `MV_SOURCE_NOT_TRACKED`)
  and the `-k -v` mix (U10: `ghost untracked gone f` into `dir`; `lsStage` parity, git's stdout
  lines equal `mvVerboseLines(['ghost', 'untracked', 'gone', 'f'], (s) => 'dir/' + s, result, [])`;
  verify the helper's parameter order in test/integration/interop-helpers.ts before writing it).
  In Part 13's link describe (tracked links need `win32` skipped): U6, an untracked dangling link
  `dl2 -> nowhere` (`linkBoth('dl2', 'nowhere', false)`), both refusing `not under version control`.
- `test/integration/pathspec-length-interop.test.ts` (constants `S300`, `P5000`, `DIR805`,
  `BASE`, helpers `twins`, `caught`, `snapshotOf`, `tryRunGitWithExit`, `GIT_EXIT_FATAL`): the
  `describe.each` "When git and tsgit move the missing $from to short (row $id)" → title "Then
  both refuse it as a bad source", `err.data` `{ code: 'MV_BAD_SOURCE', source: row.from,
  destination: 'short' }`, and git's stderr contains the rebuilt `bad source, source=${row.from}`
  line (U12). Row M7 ("move the missing S300 to short skipping errors") → `skipped`
  `[{ source: S300, reason: 'bad-source' }]`. Keep the `(row Mn)` title convention.
- `docs/use/commands/mv.md`, the Throws list (near line 103): `MV_SOURCE_NOT_TRACKED` — a source
  present on disk is not in the index; `MV_BAD_SOURCE` — a source is missing from the working
  tree, tracked or not. No other prose changes.

### TDD steps

1. RED → GREEN — the absent case (`ghost.txt` → `MV_BAD_SOURCE`) and the present case
   (`loose.txt` → `MV_SOURCE_NOT_TRACKED`) as isolated rows; GREEN: `untrackedVerdictOf`.
2. RED → GREEN — U2, U3, U4, U6 and U10 at unit level.
3. Update the existing rows listed in the Context (each is red after step 1's GREEN; change the
   expectation or the seeding exactly as listed, nothing else).
4. GUARD — the interop rows in mv-interop and pathspec-length-interop. A red row is a divergence
   → blocker protocol.
5. Docs — the Throws list; `npm run check:spelling`.
6. REFACTOR — `validateMove` ≤ 20 lines.

### Gate

`npx vitest run test/unit/application/commands/mv.test.ts test/integration/mv-interop.test.ts test/integration/pathspec-length-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/mv.ts test/unit/application/commands/mv.test.ts test/integration/mv-interop.test.ts test/integration/pathspec-length-interop.test.ts && npm run check:spelling && npm run check:doc-links`
Phase gate after this part: `npm run validate`.

### Commit

`fix(mv): refuse an absent untracked source as a bad source as git mv does`

## Part 16 — Add the refusal code for an empty source directory

### Context

Files edited: `src/domain/commands/error.ts`, `src/domain/commands/index.ts`, `src/domain/error.ts`
(message case), `test/unit/domain/error.test.ts`, `test/unit/domain/exhaustiveness.ts`,
`reports/api.json`. Separate from Part 11 because ADR-1228 (N8) ratified this code after Part 11
landed. Mirror Part 11's `mvDestinationBeyondSymlink` arm exactly: a new
`MV_SOURCE_DIRECTORY_EMPTY { source, destination }` (ADR-202 `MV_*` family). Git's message
(git 2.56.0, rows U9): `source directory is empty, source=<s>, destination=<d>`.

### TDD steps

1. RED: `mvSourceDirectoryEmpty('ud','z')` data `{ code: 'MV_SOURCE_DIRECTORY_EMPTY', source: 'ud',
   destination: 'z' }` and message
   `MV_SOURCE_DIRECTORY_EMPTY: source directory is empty, source=ud, destination=z`; bind the call
   result as `result`. GREEN: union arm, factory, barrel export, message case, exhaustiveness case.

### Gate

`npx vitest run test/unit/domain/error.test.ts && npx tsc --noEmit -p tsconfig.json &&
./node_modules/.bin/biome check <touched-files> && npm run check:spelling &&
node --experimental-strip-types tooling/audit-test-pyramid.ts`; regenerate `reports/api.json` with
`npm run docs:json`.

### Commit

`feat(mv): add the refusal code for an empty source directory`

## Part 17 — Refuse a source directory without a tracked member as git mv does

### Context

Files edited: `src/application/commands/mv.ts`, `test/unit/application/commands/mv.test.ts`,
`test/integration/mv-interop.test.ts`, `docs/use/commands/mv.md`, `reports/api.json`.

Design: N8 rows U9, U11 of "Pinned matrix — an absent untracked source" (git 2.56.0, 2/2):
`mv ud z` (ud holds only untracked `ud/u`) and `mv emp z` (empty directory) exit 128
`source directory is empty, source=ud, destination=z`; `mv -k -v ud emp f dir` exits 0 printing
only `Renaming f to dir/f`, leaving `ud/u` and `emp`. ADR-1228 (N8): `'source-directory-empty'`
joins `MvSkipReason`; Part 16's `mvSourceDirectoryEmpty` is the refusal.

Anchors in `src/application/commands/mv.ts`: `MvSkipReason` (union, ~L90), `PlanSkipReason =
Exclude<MvSkipReason, 'rename-failed'>`, `untrackedVerdictOf(ctx, source)` (~L528: `'bad-source'`
when `lstat` finds nothing, else `'source-not-tracked'`), its call site in `validateMove`
(`classified.kind === 'untracked'`), and `refusal(reason, source, target)` (~L632, exhaustive
switch). The new verdict: `lstat` finds a plain directory (not a symlink) →
`'source-directory-empty'`. An untracked file, an untracked dangling link and an untracked symlink
to a directory keep `'source-not-tracked'` (U5, U6).

### TDD steps

1. RED: a directory holding only an untracked file, and an empty directory, each refuse
   `MV_SOURCE_DIRECTORY_EMPTY` with source/destination, index and disk unchanged; dryRun too.
   GREEN: `untrackedVerdictOf` distinguishes a plain directory; `refusal` maps the new reason.
2. RED (skipErrors): `mv(['ud','emp','f'], 'dir', { skipErrors: true })` returns
   `moved: [f → dir/f]`, `skipped` `ud`, `emp` with `'source-directory-empty'`; `ud/u`, `emp` stay.
3. GUARD: an untracked file, an untracked dangling link and an untracked symlink to a directory
   keep `MV_SOURCE_NOT_TRACKED`.
4. GUARD (interop): U9 both shapes — git 128 with `source directory is empty, source=<s>,
   destination=z` rebuilt from tsgit's fields; U11 — git `-k -v` stdout equals `mvVerboseLines`,
   `lsStage` parity, disk parity.
5. Docs: `mv.md` Throws list and `MvSkipReason` literals.

### Gate

`npx vitest run test/unit/application/commands/mv.test.ts test/integration/mv-interop.test.ts &&
npx tsc --noEmit -p tsconfig.json && ./node_modules/.bin/biome check <touched-files> &&
npm run check:spelling && npm run check:doc-links &&
node --experimental-strip-types tooling/audit-test-pyramid.ts`; regenerate `reports/api.json`
with `npm run docs:json`. Phase gate after this part: `npm run validate`.

### Commit

`fix(mv): refuse a source directory without a tracked member as git mv does`
