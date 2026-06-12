# Plan — distinct types with a base

Implementation script for `docs/design/distinct-types-with-base.md` (ratified) and
ADR-318/319/320/321. Prior art binding: ADR-307 (labels), ADR-310/311 (add-add
contentVerdict + distinct-types rename), ADR-028 (merge MERGE_MSG), ADR-249
(structured output).

## How to execute a slice (read first, every slice)

- Worktree: `/Users/scolladon/workspace/perso/node/tsgit-distinct-types-with-base`
  (branch `feat/distinct-types-with-base`). Serena MCP is already activated on it —
  use `find_symbol` / `replace_symbol_body` / `insert_after_symbol` for TS edits;
  `Read`/`Edit` only for non-code files. All paths below are relative to the
  worktree root.
- TDD per step: write the RED test, run it, watch it fail **for the stated
  reason**, then the GREEN change, then the suite.
- Test conventions: `describe('Given …')` > `describe('When …')` > `it('Then …')`
  (2-level shortcut allowed for a single expectation), AAA with section comments,
  SUT in a variable named `sut` (the function/object under test — results go in
  `result`).
- Gate before every commit: `npm run validate` (never commit red, never
  `--no-verify`). Coverage is 100% — every new branch needs a test.
- Never use `v8 ignore` / `stryker-disable` / `biome-ignore` / `@ts-ignore`.
  Existing `// Stryker disable` comments this plan tells you to touch are
  **re-derived or deleted**, never silently kept and never extended.
- No phase/ADR/backlog references inside source or test code.
- Interop tests spawn real git: always go through `test/integration/interop-helpers.ts`
  (`runGit` scrubs `GIT_*` env). Pin the conflict style with
  `-c merge.conflictStyle=merge` on every peer merge/cherry-pick/revert (the
  machine's global git config uses diff3).

## Shared context (verified against the worktree, 2026-06-11)

### Domain types — `src/domain/merge/merge-types.ts`

```ts
export interface MergeConflict {
  readonly type: ConflictType;
  readonly path: FilePath;
  readonly baseId?: ObjectId;
  readonly ourId?: ObjectId;
  readonly theirId?: ObjectId;
  readonly baseMode?: FileMode;
  readonly ourMode?: FileMode;
  readonly theirMode?: FileMode;
  readonly conflictContent?: Uint8Array;
  readonly contentVerdict?: 'clean' | 'content' | 'binary';
  /** Recorded path for our side; populated only on `distinct-types` conflicts. */
  readonly ourPath?: FilePath;
  /** Recorded path for their side; populated only on `distinct-types` conflicts. */
  readonly theirPath?: FilePath;
}
```

`ConflictType` already contains `'content' | 'add-add' | 'distinct-types' |
'modify-delete' | 'type-change' | 'rename-rename' | 'gitlink' | 'binary'` — no new
type is added anywhere in this feature.

### Classification — `src/domain/merge/three-way-tree.ts`

Local helpers that exist and are reused: `isRegularKind`, `isSymlinkKind`,
`isGitlink`, `flattenLabel` (`label.replace(/\//g, '_')`), `entriesEqual`,
`conflictOutcome`, `enforceOutputCap`, `resolveMode`, `gitlinkConflict`,
`typeChangeConflict`, `addAddConflict`. `isSameKind` is imported from
`src/domain/diff/mode-kind.ts`. `FILE_MODE` values: REGULAR `'100644'`,
EXECUTABLE `'100755'`, SYMLINK `'120000'`, GITLINK `'160000'`.

Current signatures (verbatim):

```ts
async function resolveBothPresent(
  path: FilePath,
  base: FlatTreeEntry,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  contentMerger: ContentMerger,
): Promise<MergeOutcome>
```

```ts
function distinctTypesConflict(
  path: FilePath,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  labels: MergeLabels,
  reserved: Set<FilePath>,
): MergeOutcome
```

```ts
function uniquePath(reserved: Set<FilePath>, base: FilePath, label: string): FilePath {
  const suffix = flattenLabel(label);
  let candidate = `${base}~${suffix}` as FilePath;
  let n = 0;
  while (reserved.has(candidate)) {
    candidate = `${candidate}_${n}` as FilePath;
    n += 1;
  }
  reserved.add(candidate);
  return candidate;
}
```

`resolvePath(path, base, our, their, contentMerger, labels, reserved)` is the only
caller of `resolveBothPresent` (its tail: `return resolveBothPresent(path, base,
our, their, contentMerger);`). `mergeTrees` builds `reserved = new
Set<FilePath>(paths)` once and threads the **same instance** into every
`resolvePath` call — `resolveBothPresent` must receive that same instance, never a
copy, or two conflicts could probe the same rename target.

The kind-mismatch disjunction to replace inside `resolveBothPresent`:

```ts
// Both sides modified differently.
if (!isSameKind(our.mode, their.mode) || !isSameKind(base.mode, our.mode)) {
  return typeChangeConflict(path, base, our, their);
}
const mode = resolveMode(base, our, their);
if (isGitlink(mode)) {
  return gitlinkConflict(path, base, our, their);
}
return resolveContentMerge(path, base, our, their, mode, contentMerger);
```

`resolveContentMerge(path, base, our, their, mode, contentMerger)` always puts
`baseId: base.id, baseMode: base.mode` into the `ContentMergeContext` and emits
markered conflicts as `{ type: result.conflictType, …, conflictContent:
result.markedBytes }` (no `contentVerdict`). `resolveAddAdd` is the model for the
new R4 helper: it builds the ctx **without** base fields, and on clean-but-
mode-differing emits `contentVerdict: 'clean'` with `conflictContent: result.bytes`.
`src/application/primitives/build-content-merger.ts` reads the base blob iff
`baseId` is present in the ctx — **zero change needed there**.

### Stage emission — `src/domain/diff/index-diff.ts`

```ts
function distinctTypesEmissions(conflict: MergeConflict): ReadonlyArray<StageEmission> {
  // pushes { ourId, ourMode, stage: 2, path: ourPath } then
  //        { theirId, theirMode, stage: 3, path: theirPath }, each guarded on all
  //        three fields being defined
}
```

```ts
function recordedPaths(conflict: MergeConflict): ReadonlyArray<FilePath> {
  if (conflict.type === 'distinct-types') {
    const paths: FilePath[] = [];
    if (conflict.ourPath !== undefined) paths.push(conflict.ourPath);
    if (conflict.theirPath !== undefined) paths.push(conflict.theirPath);
    return paths;
  }
  return [conflict.path];
}
```

`conflictsToIndexEntries` dedupes recorded paths, pushes all emissions, then sorts
with this comparator carrying the two Stryker comments that become false (quoted so
you can find them verbatim):

```ts
  entries.sort((a, b) => {
    const pathCmp = comparePaths(a.path, b.path);
    // Stryker disable next-line ConditionalExpression: equivalent — same-path entries only ever come from one conflict (recorded paths are deduplicated above, and a distinct-types conflict emits each side at its own path) and are pushed in ascending stage order; with `true` the comparator returns 0 for them and V8's spec-stable sort preserves that already-ascending insertion order, yielding identical output.
    if (pathCmp !== 0) return pathCmp;
    // Stryker disable next-line ArithmeticOperator: equivalent — same-path runs are always pushed pre-sorted ascending by stage (regular conflicts emit 1→2→3, distinct-types one stage per path, duplicates rejected above), so the comparator never has to reorder them; `+` and `-` both leave the already-ascending run in place.
    return a.flags.stage - b.flags.stage;
  });
```

### Writers

`src/application/commands/merge.ts`:

```ts
writeConflictToTree = async (ctx: Context, conflict: MergeConflict): Promise<void> => {
  if (conflict.type === 'distinct-types') {
    await writeDistinctTypesSides(ctx, conflict);
    return;
  }
  const bytes = await materialiseConflictBytes(ctx, conflict);
  if (bytes === undefined) return;
  // When the materialised bytes come from the ours blob verbatim (no conflict
  // markers were injected), the file must be written with the original mode.
  // Symlink/symlink add-add conflicts fall here: the bytes are the ours
  // symlink target, and we must re-create a symlink, not a regular file.
  const useMode =
    conflict.type === 'add-add' &&
    conflict.conflictContent === undefined &&
    conflict.ourMode !== undefined
      ? conflict.ourMode
      : undefined;
  if (useMode !== undefined) {
    await writeWorkingTreeEntry(ctx, conflict.path, bytes, useMode);
    return;
  }
  await writeWorkingTreeFile(ctx, conflict.path, bytes);
}
```

```ts
materialiseContent = async (ctx: Context, conflict: MergeConflict): Promise<Uint8Array | undefined> => {
  if (conflict.conflictContent !== undefined) return conflict.conflictContent;
  if (conflict.ourId === undefined || conflict.theirId === undefined) return undefined;
  const [ours, theirs] = await Promise.all([
    readBlob(ctx, conflict.ourId, READ_BLOB_OPTS),
    readBlob(ctx, conflict.theirId, READ_BLOB_OPTS),
  ]);
  return writeConflictMarkers([ours.content], [theirs.content]);
}
```

(`writeConflictMarkers` is imported at the top of merge.ts solely for this
fallback.) `materialiseAddAdd` is already the take-ours shape:
`conflict.conflictContent ?? readOursBlob(ctx, conflict)`.

`src/application/primitives/apply-merge-to-worktree.ts` — `writeMarkedConflict`
has the identical `useMode` block (`conflict.type === 'add-add' && …`).
`conflictBytes` already returns `conflictContent ?? modify-delete survivor ?? ours
blob`, with two equivalence comments on the bare-take-ours branch ("the write
reproduces bytes the working tree already holds (ours was checked out)") that
slice 5 re-derives. The apply writer routes `distinct-types` to
`writeDistinctTypesSides` at line ~248 — identical to merge.

`src/application/primitives/internal/write-working-tree-file.ts` —
`writeWorkingTreeEntry(ctx, path, content, mode)`: symlink mode → `rmIfExists` +
`ctx.fs.symlink`; **all other modes → bare `ctx.fs.write` with no chmod** (the
exec-bit gap). The mode-faithful model is `apply-changeset.ts`'s private
`writeFileEntry` (`MODE_REGULAR_PERM = 0o644`, `MODE_EXEC_PERM = 0o755`,
`ctx.fs.chmod(absPath, mode === FILE_MODE.EXECUTABLE ? MODE_EXEC_PERM :
MODE_REGULAR_PERM)`). `ctx.fs.chmod` exists on the FileSystem port
(`src/ports/file-system.ts:120`) and on all adapters.

`src/application/primitives/internal/write-distinct-types-sides.ts` — already
mode-aware via `writeWorkingTreeEntry` per side; **no change in any slice** (the
base is never materialised; the exec-bit fix in slice 5 reaches it for free).

`collectUntrackedRenameBlockers` (merge.ts ~512) and `changedPaths` /
`findWouldOverwrite` (apply ~99/~120) already key off `distinct-types` recorded
paths — with-base conflicts inherit S7's refusal with **no code change**; the
interop pins it.

### Sequencer call sites (R7) — all five, verbatim today

- `src/application/commands/cherry-pick.ts:358-362`:
  `conflicts !== undefined && conflicts.length > 0 ? conflictMergeMsg(draft, conflicts.map((c) => c.path)) : draft`
- `src/application/commands/revert.ts:191-194`:
  `conflictMergeMsg(revertMessage(cData, source), conflicts.map((c) => c.path))`
- `src/application/commands/rebase.ts:343-346`:
  `message: conflictMergeMsg(cData.message, conflicts.map((c) => c.path))`
- `src/application/commands/rebase.ts:1059-1062`:
  `message: conflictMergeMsg(template, meld.conflicts.map((c) => c.path))`
- `src/application/commands/rebase.ts:1081-1084`:
  `message: conflictMergeMsg(cData.message, step.conflicts.map((c) => c.path))`

`conflictMergeMsg(draft, paths)` lives in
`src/application/commands/internal/cherry-pick-state.ts` and stays unchanged.
`merge.ts` writes no `# Conflicts:` trailer (ADR-028) — do not touch it.

### Test fixtures to reuse

- `test/unit/domain/merge/three-way-tree.test.ts`: `entry(id, mode)`, `tree(pairs)`,
  `noopMerger`, `spyMerger(result)` (records each `ContentMergeContext` in `ctxs`),
  ids `ID_A..ID_D`, labels via `DEFAULT_MERGE_LABELS` import and a local `LABELS`
  constant near the distinct-types describes.
- `test/unit/domain/diff/index-diff.test.ts`: `conflict(partial & { path })`
  factory (line ~406), `zeroStat`; the distinct-types describes start at line ~586.
- `test/unit/application/commands/merge.test.ts`: `conflictOf(over)` factory
  (line ~2094), `createMemoryContext`, `seedBlob`.
- Interop: `test/integration/interop-helpers.ts` exports `runGit`, `runGitEnv`,
  `hasGit`, `GIT_AVAILABLE`, `makePeerPair` (returns `{ peer, ours, dispose }`),
  `initBothRepos`, `git`, `lsStage`, `writeTreeOf`, `topReflogSubject`, `tryRunGit`.
  `test/integration/add-add-content-interop.test.ts` is the structural template:
  `AUTHOR` / `COMMIT_ENV`, `describe.skipIf(!GIT_AVAILABLE)(…, { timeout: 60_000 })`,
  per-test `beforeEach` building peer (`runGit init` + user config +
  `commit.gpgsign false`) and tsgit (`openRepository({ cwd: pair.ours })` +
  `repo.init()`), peer helpers (`peerAdd`/`peerCommit`/`peerBranch`/`peerCheckout`/
  `peerWrite`/`peerSymlink`/`peerMergeConflict`/`peerMergeClean`), tsgit setup via
  the repo API (`repo.add`, `repo.commit`, `repo.branch.create`, `repo.checkout`,
  `repo.merge.run({ rev, message, author })`), node `symlinkSync`/`readlinkSync`/
  `chmodSync` for kind/mode fixtures, `repo.cherryPick.run({ commits })` /
  `repo.revert.run({ commits })` for sequencers.

### Pinned evidence (real git 2.54.0 ort) — copied per slice below

Full table in the design doc. Each slice block restates the rows it owns.

---

## Slice 1 — `uniquePath` probing resets to the stem (R6)

**Goal:** `p~HEAD`, `p~HEAD_0`, `p~HEAD_1`, … — git re-probes from the stem; the
shipped loop appends cumulatively (`p~HEAD_0_1`). Fix the helper, export it for
direct testing, ship the property test, pin the no-base double collision against
real git.

**Files / symbols:**

- `src/domain/merge/three-way-tree.ts` → `uniquePath` (body quoted in Shared
  context). Add `export` to the function (module-level export only — do **not**
  touch `src/domain/merge/index.ts`; the public API surface and `reports/api.json`
  stay unchanged).
- `test/unit/domain/merge/three-way-tree.test.ts` → existing test at lines
  1463-1485: `describe('Given f~HEAD and f~HEAD_0 both already present in input
  trees')` … `it('Then ourPath=f~HEAD_0_1 (probe loop appends _n to current
  candidate)')` asserting `expect(result.conflicts[0]?.ourPath).toBe('f~HEAD_0_1')`
  — this pins the bug and must be rewritten, not duplicated.
- New `test/unit/domain/merge/three-way-tree.properties.test.ts` (generators in
  the existing `test/unit/domain/merge/arbitraries.ts`).
- `test/integration/add-add-content-interop.test.ts` → new no-base interop case
  (this suite owns the no-base behaviour; the with-base probing twin lands with
  the new suite in slice 3).

**Pinned bytes:**

| Row | Scenario | git result |
|---|---|---|
| S8 | tracked `p~HEAD` exists | rename probes to `p~HEAD_0` (already pinned in the add-add suite, "rename target f~side is already tracked") |
| P1 | tracked `p~HEAD` **and** `p~HEAD_0` exist | rename probes to **`p~HEAD_1`** — git resets to the stem; never `p~HEAD_0_1` |

**TDD steps:**

1. RED (unit): rewrite the 1463 test as `describe('Given f~HEAD and f~HEAD_0 both
   already present in input trees')` > `describe('When ours is regular and theirs
   is symlink')` > `it('Then ourPath=f~HEAD_1 (probing resets to the stem)')`,
   asserting `ourPath === 'f~HEAD_1'` and `theirPath === 'f'`. Fails: current loop
   yields `f~HEAD_0_1`.
2. RED (property): `three-way-tree.properties.test.ts`, importing `uniquePath`
   directly from `../../../../src/domain/merge/three-way-tree.js`. Generator:
   slash-free label (so `flattenLabel` is the identity and the stem is computable
   as `` `${base}~${label}` ``), a base path, and a reserved set built from the
   stem plus an arbitrary contiguous-or-gapped subset of `stem_0 … stem_9`.
   Properties (`numRuns: 200`, cheap):
   - `it('Then the result is not in the pre-call reserved set and is added to it')`
   - `it('Then the result is the stem when free, else stem_k for the minimal free k')`
     — oracle: smallest `k ≥ 0` with `` `${stem}_${k}` `` not in the pre-call set
     (spec-shaped counting oracle, not a copy of the SUT loop: the buggy SUT
     disagrees with it on any set containing both the stem and `stem_0`).
   Both fail against the cumulative loop whenever the set contains stem and
   `stem_0`. `Given` titles read "Given an arbitrary …".
3. GREEN: fix `uniquePath` — hold the stem, re-derive each candidate from it:
   ```ts
   export function uniquePath(reserved: Set<FilePath>, base: FilePath, label: string): FilePath {
     const stem = `${base}~${flattenLabel(label)}`;
     let candidate = stem as FilePath;
     let n = 0;
     while (reserved.has(candidate)) {
       candidate = `${stem}_${n}` as FilePath;
       n += 1;
     }
     reserved.add(candidate);
     return candidate;
   }
   ```
4. RED (interop, `add-add-content-interop.test.ts`): `describe('Given f~HEAD and
   f~HEAD_0 are both already tracked')` > `describe('When a distinct-types
   conflict occurs on both tools')` > `it('Then the rename probes to f~HEAD_1
   matching git')`. Build on the existing "rename target f~side is already
   tracked" case (line ~617): root commit tracks `f~HEAD` and `f~HEAD_0`; side
   branch adds symlink `f`; main adds regular `f` (ours regular ⇒ suffix
   `~HEAD`). Assert `lsStage` parity and the worktree file at `f~HEAD_1` on both
   tools. Fails before the fix with tsgit writing `f~HEAD_0_1`.
5. `npm run validate`.

**Mutation notes:** the property test kills the cumulative-append mutant class and
the `n` start-offset mutants (minimal-k oracle). No equivalence comments touched.

**Commit:** `fix(merge): reset unique-path probing to the stem`

---

## Slice 2 — `basePath` + classification rework (R1/R2/R4/R5/R8, ADR-318/319/320)

**Goal:** replace the single kind-mismatch disjunction in `resolveBothPresent`
with the routing table; extend `distinctTypesConflict` with the base entry and
kind-matched `basePath`; add the R4 base-less content-merge route and the R5
symlink-pair bare `content` conflict. Start the new interop suite with the two
rows this slice alone completes end-to-end (S9, P2).

**Files / symbols:**

- `src/domain/merge/merge-types.ts` → `MergeConflict` gains:
  ```ts
  /** Recorded path of the base's stage-1 entry; populated only on `distinct-types` conflicts that have a base. */
  readonly basePath?: FilePath;
  ```
- `src/domain/merge/three-way-tree.ts` → `resolveBothPresent` (signature grows by
  `labels: MergeLabels, reserved: Set<FilePath>`), its single caller `resolvePath`
  (tail call gains `labels, reserved` — the same instances it already passes to
  `resolveAddAdd`), `distinctTypesConflict` (gains trailing optional
  `base?: FlatTreeEntry`), two new private helpers (names suggested):
  `symlinkPairConflict`, `resolveKindChangedBase`.
- `test/unit/domain/merge/three-way-tree.test.ts` — extend; one existing test
  rewritten (see step 1).
- New `test/integration/distinct-types-with-base-interop.test.ts` (S9 + P2 only in
  this slice; later slices append to it).

**Routing table to implement (design, ratified):**

| ours kind | theirs kind | base kind | route |
|---|---|---|---|
| regular | symlink (either order) | regular or symlink | `distinct-types` with base fields (R1+R2) |
| gitlink in the ours/theirs pair (unless all three gitlink) | | | `type-change` as today (R8) |
| regular | symlink (either order) | gitlink | `type-change` as today (R8) |
| symlink | symlink | any (incl. gitlink) | bare take-ours `content` conflict, no merger call (R5) |
| regular | regular | kind differs (symlink or gitlink base) | `resolveKindChangedBase` — base-less merge ctx, base-ful conflict fields (R4) |
| regular | regular | regular | existing `resolveMode` + `resolveContentMerge`, untouched |
| gitlink | gitlink | gitlink | `gitlinkConflict`, untouched |

Suggested GREEN shape for the post-trivial part of `resolveBothPresent` (extract
to a helper if the function would exceed ~20 lines; the four trivial-resolution
early returns at the top stay byte-identical):

```ts
if (isGitlink(our.mode) || isGitlink(their.mode)) {
  if (isGitlink(our.mode) && isGitlink(their.mode) && isGitlink(base.mode)) {
    return gitlinkConflict(path, base, our, their);
  }
  return typeChangeConflict(path, base, our, their);
}
const ourSymlink = isSymlinkKind(our.mode);
const theirSymlink = isSymlinkKind(their.mode);
if (ourSymlink && theirSymlink) return symlinkPairConflict(path, base, our, their);
if (ourSymlink || theirSymlink) {
  if (isGitlink(base.mode)) return typeChangeConflict(path, base, our, their);
  return distinctTypesConflict(path, our, their, labels, reserved, base);
}
if (!isSameKind(base.mode, our.mode)) {
  return resolveKindChangedBase(path, base, our, their, contentMerger);
}
const mode = resolveMode(base, our, their);
return resolveContentMerge(path, base, our, their, mode, contentMerger);
```

Note the old `if (isGitlink(mode)) return gitlinkConflict(…)` after `resolveMode`
is subsumed by the gitlink block above (three regulars never resolve to gitlink);
remove it from the regular/regular tail — coverage will flag it as dead otherwise.

`distinctTypesConflict` extension — keep the existing rename mechanics verbatim,
append base fields when a base exists; `basePath` is the recorded path of the
side whose kind equals the base's kind (within reach the base is regular or
symlink, the regular side's recorded path is always `renamedPath`):

```ts
function distinctTypesConflict(
  path: FilePath,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  labels: MergeLabels,
  reserved: Set<FilePath>,
  base?: FlatTreeEntry,
): MergeOutcome {
  // …existing ourIsRegular / regularLabel / renamedPath / ourPath / theirPath…
  if (base === undefined) return conflictOutcome({ /* existing no-base literal */ });
  const basePath = isRegularKind(base.mode) ? renamedPath : path;
  return conflictOutcome({
    type: 'distinct-types', path,
    baseId: base.id, baseMode: base.mode, basePath,
    ourId: our.id, ourMode: our.mode, theirId: their.id, theirMode: their.mode,
    ourPath, theirPath,
  });
}
```

`symlinkPairConflict` (R5, ADR-319) — bare, all three stage fields, **no**
`conflictContent`, **no** `contentVerdict`, merger never invoked:

```ts
function symlinkPairConflict(path, base, our, their): MergeOutcome {
  return conflictOutcome({
    type: 'content', path,
    baseId: base.id, baseMode: base.mode,
    ourId: our.id, ourMode: our.mode, theirId: their.id, theirMode: their.mode,
  });
}
```

`resolveKindChangedBase` (R4, ADR-320) — mirror `resolveAddAdd`'s post-merger
logic, with base fields on the **conflict** but not the **ctx**; mode rule: equal
side modes ⇒ that mode (resolved when clean); differing side modes ⇒ conflict even
on clean content:

```ts
async function resolveKindChangedBase(path, base, our, their, contentMerger): Promise<MergeOutcome> {
  const ctx: ContentMergeContext = {
    path, ourId: our.id, theirId: their.id, ourMode: our.mode, theirMode: their.mode,
  };
  const result = await contentMerger(ctx, undefined, new Uint8Array(0), new Uint8Array(0));
  if (result.status === 'clean') {
    enforceOutputCap(result.bytes, 'clean bytes');
    if (our.mode === their.mode) {
      if (result.id !== undefined) return { status: 'resolved-known', path, id: result.id, mode: our.mode };
      return { status: 'resolved-merged', path, bytes: result.bytes, mode: our.mode };
    }
    return conflictOutcome({
      type: 'content', path, baseId: base.id, baseMode: base.mode,
      ourId: our.id, ourMode: our.mode, theirId: their.id, theirMode: their.mode,
      conflictContent: result.bytes, contentVerdict: 'clean',
    });
  }
  enforceOutputCap(result.markedBytes, 'marked bytes');
  return conflictOutcome({
    type: result.conflictType, path, baseId: base.id, baseMode: base.mode,
    ourId: our.id, ourMode: our.mode, theirId: their.id, theirMode: their.mode,
    conflictContent: result.markedBytes,
  });
}
```

(Markered R4 conflicts deliberately omit `contentVerdict` — ADR-320's neutral
clause; only the clean-bytes case carries `'clean'`.)

**Pinned bytes (rows this slice owns end-to-end):**

| Row | Scenario | git result |
|---|---|---|
| S9 | base=symlink `base-target`; ours=file `shared\nours\n`; theirs=file `shared\ntheirs\n` | `Auto-merging p` + `CONFLICT (content)`, UU. Index: `120000 <base> 1 p` + file stages 2/3. Worktree: per-region markers with the shared prefix **outside** them — content merge ran with an **empty base** |
| P2 | S9 + `.gitattributes` `merge=union` | clean merge, exit 0: `p` = ours' lines then theirs' lines, stage 0, mode 100644 |
| S5 | trivial — ours did NOT change `p`; theirs=symlink (and mirror) | clean merge, exit 0; changed side taken — already shipped via `entriesEqual`; unit-pinned here, interop-pinned in slice 3 |

(Stage-1 emission for S9 already works — `regularEmissions` keys off
`baseId`/`baseMode`, which the R4 conflict carries.)

**TDD steps (unit first — every routing row gets an isolated test; assert the
full conflict data, not just `type`, so StringLiteral/field mutants die):**

1. RED: rewrite the existing test at lines 904-922 (`describe('Given modify-modify
   with kind change (file vs symlink) on ours vs theirs')` > `it('Then type-change
   conflict')`) — it pins the old divergence. New shape: base regular `p`@ID_A,
   ours regular ID_B, theirs symlink ID_C, merger spy → `it('Then a with-base
   distinct-types conflict renames the regular side and records the base with
   it')`: type `'distinct-types'`, `ourPath: 'p~HEAD'`, `theirPath: 'p'`,
   `basePath: 'p~HEAD'`, `baseId: ID_A`, `baseMode: '100644'`, merger not called.
   Fails: today yields `type-change`.
2. RED: the other three side/base permutations, one test each (use
   `DEFAULT_MERGE_LABELS` or an explicit `LABELS = { ours: 'HEAD', theirs: 'side' }`):
   - ours symlink / theirs regular / base regular → `theirPath: 'p~side'`,
     `ourPath: 'p'`, `basePath: 'p~side'` (S2 shape).
   - ours symlink / theirs regular / base symlink → `basePath: 'p'` (= `ourPath`)
     (S3 shape).
   - ours regular / theirs symlink / base symlink → `basePath: 'p'`
     (= `theirPath`), `ourPath: 'p~HEAD'` (S4 shape).
   All fail (type-change today).
3. RED: rename-target reservation with a base: base regular, ours regular `f`,
   theirs symlink `f`, ours tree also tracks `f~HEAD` → `ourPath: 'f~HEAD_0'`,
   `basePath: 'f~HEAD_0'` — proves with-base routing reuses the same `reserved`
   instance and the kind-match follows the **probed** path. Fails (type-change).
4. RED (R8 rows stay put): gitlink-involved pairs keep today's bare `type-change`
   (assert `basePath === undefined`, no rename fields):
   - ours gitlink / theirs regular / base regular,
   - ours regular / theirs symlink / base **gitlink**,
   - ours gitlink / theirs gitlink / base regular.
   These pass today — write them anyway as regression pins for the rework (they
   protect the new gitlink guards; each conditional in the gitlink block needs its
   own row or its mutant survives).
5. RED (R5): ours symlink ID_B / theirs symlink ID_C, base **file** → `it('Then a
   bare take-ours content conflict carries all three stages and no merged
   bytes')`: type `'content'`, `conflictContent === undefined`,
   `contentVerdict === undefined`, all six id/mode fields set, merger **not**
   called (spy). Fails: today this is `type-change`.
6. RED (R5, symlink base): same pair with base symlink ID_A → same bare shape,
   merger not called. Fails for a different reason: today this routes through
   `resolveContentMerge` and returns a markered `content` conflict — this test is
   the one that kills the link-target-content-merge divergence.
7. RED (R4 ctx shape): base symlink, sides regular with different ids; `spyMerger`
   returning a content conflict → assert the merger **was called once** with
   `ctxs[0].baseId === undefined && ctxs[0].baseMode === undefined`, while the
   emitted conflict has `baseId: ID_A, baseMode: '120000'` and
   `conflictContent` = the marked bytes. Fails: today a kind-changed base trips
   `!isSameKind(base.mode, our.mode)` → bare `type-change`, merger never called.
8. RED (R4 clean/equal modes): merger clean bytes, sides both `'100644'` →
   `resolved-merged` with `mode: '100644'`; sibling test for the `result.id`
   fast-path → `resolved-known`. Fails: today these are `type-change` conflicts,
   not resolutions.
9. RED (R4 clean/differing modes — Q1/Q2 domain shape): merger clean, ours
   `'100755'`, theirs `'100644'` → conflict `type: 'content'`,
   `contentVerdict: 'clean'`, `conflictContent` = clean bytes, all base/side
   fields. Fails: today `type-change` with no merger call.
10. RED (R4 caps): merger returning oversize clean bytes and oversize marked
    bytes (> `MAX_CONFLICT_OUTPUT_BYTES`) under a kind-changed base → both throw
    `invalidMergeInput` — mirror the existing resolveAddAdd cap tests (try/catch,
    assert error data, not `toThrow(Class)`).
11. GREEN: implement the routing + helpers as sketched. Thread `labels, reserved`
    through `resolvePath` → `resolveBothPresent`.
12. RED (interop — create `test/integration/distinct-types-with-base-interop.test.ts`
    from the add-add template; header `@proves` block: surface `repo.merge.run`,
    bucket cross-tool-interop, interopSurface merge). Shared setup helper for the
    suite (write it now, every later slice reuses it):
    `setupWithBase(spec: { base: KindSpec; ours: KindSpec; theirs: KindSpec })`
    where `KindSpec = { kind: 'file' | 'symlink'; bytes?: string; target?: string;
    exec?: boolean }` — base commit holds `p` (plus `root.txt`), branch `side`
    commits theirs' shape, `main` commits ours' shape, HEAD on main; built twice
    (peer via `peerWrite`/`peerSymlink`/`chmodSync` + `git add/commit`, tsgit via
    the repo API + `symlinkSync`). Cases this slice:
    - S9: `it('Then the two-way marker bytes and the symlink stage-1 entry match
      git')` — `peerMergeConflict('side')` not ok, `repo.merge.run` kind
      `'conflict'`, `lsStage` parity (pins `120000 … 1 p`), worktree `p` bytes
      equal peer's (shared prefix outside markers).
    - P2: `.gitattributes` with `p merge=union` committed in the base on both
      tools → both merges clean, `lsStage` parity (stage 0), worktree bytes equal.
13. `npm run validate` — includes the whole existing suite; expect and fix any
    consumer test that pinned `type-change` for these shapes (the only known one
    is the line-904 unit test rewritten in step 1; `status`/`diff` "type-change"
    tests use the *diff* change type and are unaffected — verified).

**Mutation notes:** each guard in the routing block has an isolated row (steps
4-6); the `basePath` kind-match ternary is killed by S1-vs-S3 permutations; the
R4 ctx assertions kill ObjectLiteral mutants re-adding base fields.

**Commit:** `feat(merge): classify with-base distinct types, kind-changed bases and symlink pairs`

---

## Slice 3 — stage-1 emission at `basePath` + S1–S4 interop pins

**Goal:** the index records the base's stage-1 entry at the kind-matched recorded
path; the comparator's two stale equivalence claims are re-derived; the new
interop suite pins S1–S4, S5, S7, S8/P1, S12.

**Files / symbols:**

- `src/domain/diff/index-diff.ts` → `distinctTypesEmissions` (body quoted in
  Shared context), the two `// Stryker disable` comments inside
  `conflictsToIndexEntries` (quoted verbatim in Shared context). `recordedPaths`
  needs **no change** (`basePath` always aliases `ourPath` or `theirPath`, so
  dedup keys are untouched).
- `test/unit/domain/diff/index-diff.test.ts` → extend the
  `describe('conflictsToIndexEntries')` block (distinct-types cases start ~586).
- `test/integration/distinct-types-with-base-interop.test.ts` → append cases.

**GREEN change (after the their-side push, so a two-stage run at one path arrives
stage-descending and the comparator must actually reorder it):**

```ts
if (
  conflict.baseId !== undefined &&
  conflict.baseMode !== undefined &&
  conflict.basePath !== undefined
) {
  out.push({ id: conflict.baseId, mode: conflict.baseMode, stage: 1, path: conflict.basePath });
}
```

**Comparator comments — what must happen:**

- The **ConditionalExpression** disable ("same-path entries … one conflict …
  ascending insertion order") becomes a **killable** mutant once the run arrives
  (2, 1): with `if (true) return pathCmp`, same-path pairs return 0 and stable
  sort preserves (2, 1). **Delete the disable**; the unit test in step 2 is the
  killer.
- The **ArithmeticOperator** disable stays (for a 2-element same-path pair both
  `-` and `+` return a positive value and order the pair identically; ascending
  1→2→3 runs were already empirically equivalent) but its justification text is
  now false ("distinct-types one stage per path"). **Re-derive it**, e.g.:
  "equivalent — same-path runs are either ascending triples (regular conflicts
  emit 1→2→3) which both operators leave in place, or two-element distinct-types
  runs (side stage then base stage 1) for which both operators return a positive
  value and produce the same sorted pair." Do not blindly keep the old text.

**Pinned bytes:**

| Row | Scenario | git result |
|---|---|---|
| S1 | base=file `base\n`; ours=file `ours\n`; theirs=symlink `target-b` | exit 1. Index: `120000 <theirs> 3 p`, `100644 <base> 1 p~HEAD`, `100644 <ours> 2 p~HEAD`. Worktree: `p` → symlink `target-b`, `p~HEAD` file `ours\n` |
| S2 | mirror — ours=symlink `target-a`; theirs=file `theirs\n` | Index: `120000 <ours> 2 p`, `100644 <base> 1 p~B`, `100644 <theirs> 3 p~B`. Worktree: `p` → symlink, `p~B` file |
| S3 | base=symlink `base-target`; ours=symlink `ours-target`; theirs=file | Index: `120000 <base> 1 p`, `120000 <ours> 2 p`, `100644 <theirs> 3 p~B`. Worktree: `p` → ours' symlink, `p~B` file |
| S4 | mirror — ours=file; theirs=symlink `theirs-target` | Index: `120000 <base> 1 p`, `120000 <theirs> 3 p`, `100644 <ours> 2 p~HEAD`. Worktree: `p` → theirs' symlink, `p~HEAD` file |
| S5 | ours did NOT change `p`; theirs=symlink (and mirror) | clean merge, exit 0; changed side taken (`mode change 100644 => 120000 p`) |
| S7 | untracked file squats `p~HEAD` | refusal, exit 2: `error: The following untracked working tree files would be overwritten by merge:\n\tp~HEAD` — nothing written, HEAD/index untouched |
| S8/P1 | tracked `p~HEAD` (then also `p~HEAD_0`) under a **with-base** conflict | probes `p~HEAD_0`, then `p~HEAD_1` |
| S12 | theirs branch `feature/x`, theirs regular | suffix flattens `/` → `_`: `p~feature_x` (stages 1+3 there) |

**TDD steps:**

1. RED (unit): `describe('Given a with-base distinct-types conflict whose base is
   a regular file')` > `describe('When conflictsToIndexEntries called')` >
   `it('Then the base entry is emitted at stage 1 at basePath alongside stage
   2')` — conflict via the `conflict()` factory: path `f`, `ourPath: 'f~HEAD'`,
   `theirPath: 'f'`, `basePath: 'f~HEAD'`, all ids/modes set (`baseMode` regular,
   `theirMode` symlink). Assert the **exact** ordered `[path, stage, id, mode]`
   tuples: `('f', 3)`, `('f~HEAD', 1)`, `('f~HEAD', 2)` — fails: no stage-1
   emission exists.
2. RED (unit, comparator killer): same conflict — explicit
   `it('Then the two-stage run at f~HEAD lists stage 1 before stage 2')`. Fails
   before GREEN for the missing emission; after GREEN it is the test that kills
   the un-disabled ConditionalExpression mutant (insertion order at `f~HEAD` is
   2 then 1).
3. RED (unit): symlink-base placement — `basePath: 'f'` (= `theirPath`… use the
   S3 shape: `ourPath: 'f'`, `theirPath: 'f~B'`, `basePath: 'f'`): tuples
   `('f', 1)`, `('f', 2)`, `('f~B', 3)`.
4. RED (unit): partial guards — basePath set but `baseId` undefined → no stage-1
   emission; `baseId`/`baseMode` set but `basePath` undefined (the no-base 24.9f
   shape never has it, but the guard needs its isolated test) → no stage-1
   emission. Two tests, one per missing operand.
5. GREEN: the emission block above; delete the ConditionalExpression disable;
   re-derive the ArithmeticOperator text.
6. RED (interop): append to `distinct-types-with-base-interop.test.ts`, one case
   per row S1–S4 (use `setupWithBase`): peer merge not ok + tsgit `'conflict'`,
   `lsStage(pair.ours) === lsStage(pair.peer)` (this is the stage-1-placement
   byte pin), worktree kind+bytes both repos (`readlinkSync` for the symlink
   side, `readFile` for the regular side at its renamed path). S1 fails before
   GREEN with tsgit's `lsStage` missing the `1 p~HEAD` line; S3/S4 also differ on
   stage-1 placement.
7. RED (interop): S5 trivial boundary — theirs changes `p` to a symlink, ours
   untouched → both tools merge clean, `writeTreeOf` parity, worktree `p` is a
   symlink on both. (Passes already — regression pin for the scope boundary.)
8. RED (interop): S7 refusal — `setupWithBase` S1 shape + untracked file at
   `p~HEAD` in both worktrees → peer exit ≠ 0 with the untracked-overwrite error;
   tsgit refuses (assert the typed error/refusal result `repo.merge.run` returns
   for untracked blockers — mirror the existing "untracked file exists at the
   rename target" case in `add-add-content-interop.test.ts` line ~681 for the
   exact shape), nothing written (`p~HEAD` bytes unchanged), HEAD/index untouched
   (`lsStage` unchanged). Should pass (guard pre-exists) — pin it.
9. RED (interop): S8/P1 with-base probing — base tracks `p~HEAD` (S8 → `p~HEAD_0`)
   and a second case also tracking `p~HEAD_0` (P1 → `p~HEAD_1`), `lsStage` parity.
10. RED (interop): S12 — branch `feature/x` as theirs with regular kind, base
    file: rename lands at `p~feature_x` carrying stages 1+3, `lsStage` parity.
11. `npm run validate`.

**Mutation notes:** step 1's exact-tuple assertion kills the stage-number and
path-choice mutants in the new block; step 4 kills each guard operand. After this
slice run a scoped check if practical:
`./node_modules/.bin/stryker run --mutate src/domain/diff/index-diff.ts` — but
remember local Stryker under vitest-4 mis-pairs and reports false survivors;
analytic justification + the explicit killer tests are the source of truth, do
not config-grind.

**Commit:** `feat(merge): record the base stage at its kind-matched recorded path`

---

## Slice 4 — sequencer `# Conflicts:` lists recorded paths (R7)

**Goal:** cherry-pick / revert / rebase MERGE_MSG trailers name each conflict's
**recorded** paths, sorted — `p`, `p~HEAD` — not `conflict.path`. Retroactively
fixes 24.9f's no-base gap. `merge` stays trailer-less (ADR-028).

**Files / symbols:**

- `src/domain/diff/index-diff.ts` → promote `recordedPaths` to an export (keep
  the name) and add the sorted aggregate next to it:
  ```ts
  export function sortedRecordedPaths(
    conflicts: ReadonlyArray<MergeConflict>,
  ): ReadonlyArray<FilePath> {
    return conflicts.flatMap((conflict) => [...recordedPaths(conflict)]).sort(comparePaths);
  }
  ```
  (`comparePaths` is already imported in this file; the flatMap result is a fresh
  array, sorting it in place mutates nothing shared.)
- `src/domain/diff/index.ts` → barrel-export both (`recordedPaths`,
  `sortedRecordedPaths`). This barrel is not re-exported by `src/index.ts`, so
  the public API surface / `reports/api.json` are untouched.
- The five call sites (quoted verbatim in Shared context) each become
  `conflictMergeMsg(<draft>, sortedRecordedPaths(<conflicts>))`:
  - `src/application/commands/cherry-pick.ts:358-362`
  - `src/application/commands/revert.ts:191-194`
  - `src/application/commands/rebase.ts:343-346`, `:1059-1062`, `:1081-1084`
  (add the `sortedRecordedPaths` import from `'../../domain/diff/index.js'` in
  each file; `conflictMergeMsg` itself is untouched).
- Tests: `test/unit/domain/diff/index-diff.test.ts`,
  `test/unit/application/commands/cherry-pick.test.ts`, `revert.test.ts`,
  `rebase.test.ts` (find each suite's existing conflict-stop MERGE_MSG
  assertions and add a distinct-types variant beside them), interop suite.

**Pinned bytes:**

| Row | Scenario | git result |
|---|---|---|
| S6 | S1 via `cherry-pick` | same conflict; rename suffix is the **regular side's** label — ours regular ⇒ `p~HEAD` even under cherry-pick; MERGE_MSG = source subject + `# Conflicts:` block listing `p`, `p~HEAD` |
| P5 | via `revert` where theirs (the reverted-to parent) is the regular side | rename target = `p~parent of 9eddd19 (make p a symlink)` — the theirs label **verbatim**, spaces and parens included, only `/` flattened |

Existing sequencer tests stay green without edits: for non-distinct-types
conflicts `recordedPaths` returns `[conflict.path]` and `mergeTrees` already
yields conflicts in sorted path order, so `sortedRecordedPaths` is byte-identical
to the old `conflicts.map((c) => c.path)` there.

**TDD steps:**

1. RED (unit, index-diff): `describe('Given a mix of a distinct-types conflict
   and a regular conflict')` > `describe('When sortedRecordedPaths called')` >
   `it('Then it lists every recorded path byte-sorted')` — distinct-types at
   `p` with `ourPath: 'p~HEAD'`, `theirPath: 'p'` plus a regular conflict at `a`
   → `['a', 'p', 'p~HEAD']`. Fails: the export does not exist (compile error —
   that is the honest RED for a new symbol).
   Add the single-conflict cases: regular → `[path]`; distinct-types with one
   recorded path absent → only the present one.
2. GREEN: promote + add `sortedRecordedPaths`, barrel exports.
3. RED (unit, cherry-pick): locate the existing conflict-stop test that asserts
   the MERGE_MSG `# Conflicts:` block in `cherry-pick.test.ts`; add a sibling
   whose conflict set contains a distinct-types conflict (drive the real merge to
   a no-base or with-base distinct-types stop, or assert at the state-writer
   seam the suite already uses) → `it('Then MERGE_MSG lists the recorded paths,
   not the conflict path')`: block contains `#\tp\n#\tp~HEAD\n` and not a lone
   `#\tp\n`. Fails: call site maps `c.path`.
4. GREEN: switch cherry-pick.ts:358. Repeat RED→GREEN per file: revert.ts:191
   (revert unit test), rebase.ts:343 / 1059 / 1081 (rebase stop tests — the
   interactive (`:1059`) and non-interactive (`:343`, `:1081`) stops each need
   one distinct-types assertion or the three call-site fixes share one killer
   and two stay mutant-prone; minimum: one test per call site).
5. RED (interop, append to the new suite): S6 — build the S1 shape as a
   cherry-pick: base commit `p` file; commit "make p a symlink" on a branch;
   cherry-pick a regular-side commit… follow the existing cherry-pick
   distinct-types interop case (`add-add-content-interop.test.ts` line ~752) for
   mechanics, but **with a base**: root commits file `p`; `feature` branch
   commits regular change to `p`; `main` commits symlink `p`; cherry-pick
   `feature` onto `main` on both tools (`-c merge.conflictStyle=merge`,
   `core.editor=true` on the peer). Assert: stages parity (`lsStage`), worktree
   (`p` symlink, regular at the labelled rename), and **MERGE_MSG byte parity**:
   `readFile(<repo>/.git/MERGE_MSG)` equal across tools — the trailer lists both
   recorded paths. Fails before GREEN on the MERGE_MSG bytes (and the rename
   suffix label is pinned as the regular side's = theirs' label here).
6. RED (interop): P5 — revert with the reverted-to parent as the regular side.
   Recipe: root commits **regular** `p`; commit A "make p a symlink" (symlink
   `target-a`); commit B changes the symlink target (`target-b`); revert commit A.
   Revert's three-way: base = A's tree (symlink `target-a`), ours = HEAD (symlink
   `target-b`), theirs = A's parent (**regular** `p`) → S3-shaped distinct types
   where the theirs label is `parent of <abbrev> (make p a symlink)` (ADR-307,
   verbatim — spaces and parens included, only `/` flattened). Pin the rename
   target byte-exactly: `p~parent of <7-abbrev> (make p a symlink)`, plus
   `lsStage` and MERGE_MSG parity. Compute the abbrev via
   `runGit(['-C', pair.peer, 'rev-parse', …]).trim().slice(0, 7)` like the
   existing cherry-pick case does (line ~772 of the add-add suite).
7. `npm run validate`.

**Mutation notes:** the `.sort(comparePaths)` call is killed by step 1's
out-of-order fixture (construct conflicts so flatMap order ≠ sorted order — put
the distinct-types conflict first and the `a` conflict second).

**Commit:** `fix(sequencer): list recorded conflict paths in MERGE_MSG trailers`

---

## Slice 5 — mode-aware conflict writes repo-wide (ADR-321) + R5/Q-row pins

**Goal:** both conflict writers use ours'/merged mode whenever `ourMode` is
defined — bare take-ours conflicts re-create ours' **kind** (symlink ⇒
`fs.symlink`), marker-bytes writes carry the resolved/ours mode (exec bit
survives). The merge writer's dead marker-fallback for bare `content` conflicts
becomes take-ours (it would corrupt R5 otherwise). Interop pins Q1/Q2/Q4 and
S9b/P3.

**Files / symbols:**

- `src/application/primitives/internal/write-working-tree-file.ts` →
  `writeWorkingTreeEntry`: after the symlink branch, replace the bare
  `await ctx.fs.write(fullPath, content);` with write + chmod, mirroring
  `apply-changeset.ts`'s `writeFileEntry` constants:
  ```ts
  await ctx.fs.write(fullPath, content);
  await ctx.fs.chmod(fullPath, mode === FILE_MODE.EXECUTABLE ? MODE_EXEC_PERM : MODE_REGULAR_PERM);
  ```
  with `const MODE_REGULAR_PERM = 0o644; const MODE_EXEC_PERM = 0o755;` module
  constants. (This automatically fixes the exec bit for `writeDistinctTypesSides`
  too — that file is untouched.) Note: a gitlink `ourMode` reaching this function
  produces the same bytes as today plus a 644 chmod — the gitlink-involved
  `type-change` worktree shape stays the recorded R8 divergence; do not add a
  gitlink branch.
- `src/application/commands/merge.ts`:
  - `writeConflictToTree` — replace the `useMode` block (quoted in Shared
    context) with the unconditional rule and rewrite its comment:
    ```ts
    if (conflict.ourMode !== undefined) {
      await writeWorkingTreeEntry(ctx, conflict.path, bytes, conflict.ourMode);
      return;
    }
    await writeWorkingTreeFile(ctx, conflict.path, bytes);
    ```
    (`ourMode` undefined ⇔ ours has no side — the modify-delete theirs-survivor
    case — which keeps today's plain write.)
  - `materialiseContent` — drop the marker fallback (unreachable from the domain:
    every markered `content`/`binary` conflict carries `conflictContent`; bare
    `content` now means R5 take-ours, ADR-319). Target shape — byte-for-byte the
    `materialiseAddAdd` pattern already in the file:
    ```ts
    materialiseContent = async (
      ctx: Context,
      conflict: MergeConflict,
    ): Promise<Uint8Array | undefined> => {
      if (conflict.conflictContent !== undefined) return conflict.conflictContent;
      return readOursBlob(ctx, conflict);
    };
    ```
    (keep `materialiseContent` and `materialiseAddAdd` separate here even though
    they converge; folding is an architecture-refactor-phase call). Remove the
    now-unused `writeConflictMarkers` import (line ~19; its only use was this
    fallback at line ~667).
- `src/application/primitives/apply-merge-to-worktree.ts`:
  - `writeMarkedConflict` — same `useMode` replacement as `writeConflictToTree`.
  - `conflictBytes` — behaviourally already take-ours for bare shapes; **re-derive**
    the bare-branch equivalence comment ("Bare add-add
    (binary/symlink-symlink/type-change): keep ours when present" + the
    ConditionalExpression/BlockStatement disable claiming the write reproduces
    on-disk bytes): the enumeration must now include bare `content` (R5 symlink
    pairs). The skip-equivalence claim itself still holds for the apply consumers
    (ours is checked out at `path`, and bare take-ours rewrites ours' own
    content), so the disable survives with corrected text — but verify the claim
    against the new shapes before keeping it; if you find a counterexample,
    delete the disable and write the killer instead.
  - `outcomeChangesOurs` — re-read its block comment ("an unchanged/equal outcome
    the conflict-writer would additionally touch reproduces bytes the working
    tree already holds"): conflict outcomes are filtered out before it and
    distinct-types paths flow through `changedPaths`' conflict branch, so the
    claims still hold; update wording only if it names shapes that moved. State
    the conclusion in the slice's commit-time notes (the review phase re-audits).
- Tests:
  - `test/unit/application/primitives/internal/write-working-tree-file.test.ts`
  - `test/unit/application/commands/merge.test.ts` — `materialiseConflictBytes`
    tests at lines ~2276-2298 ("content conflict with no conflictContent but
    ours+theirs ids" → expects a marker block) and ~2300-2313 ("no conflictContent
    and only ourId" → expects `undefined`) pin the dead fallback and **must be
    rewritten** to the take-ours contract; the writer tests around `useMode` (the
    "type-change with BOTH conflictContent and ourId" test at ~2117 asserts ours
    blob wins for type-change — re-check its assertions against the new mode-aware
    write path and update expectations if they pinned a plain-file write).
  - `test/unit/application/primitives/apply-merge-to-worktree.test.ts` — writer
    expectations for bare conflicts.
  - Interop suite — append Q1/Q2/Q4, S9b/P3.

**Pinned bytes:**

| Row | Scenario | git result |
|---|---|---|
| Q1 | base=symlink; sides identical file bytes, modes 100755 vs 100644 | `CONFLICT (content)`, UU; stage 1 symlink + stages 2/3 sharing the blob, differing in mode; worktree = the bytes with **ours' mode** (755), no markers |
| Q2 | base=symlink; `merge=union`; ours 100755 / theirs 100644 differing text | `Auto-merging p` + `CONFLICT (content)`, UU; worktree = clean union bytes, ours' mode, **no markers** |
| Q4 | control — plain modify/modify content conflict, all stages 100755 | marker file written **mode 755** |
| S9b | base=file; both sides symlinks, differing targets | `CONFLICT (content)`, UU; stages 1 (file) + 2/3 (symlinks) at `p`; worktree keeps **ours' symlink** — no target merge, no markers |
| P3 | base=symlink; both sides symlinks, differing targets | identical shape to S9b |

**TDD steps:**

1. RED (unit, write-working-tree-file): the memory adapter's `chmod` is a
   **no-op** (`memory-file-system.ts:309` only validates the path) and its lstat
   mode is a constant — so assert the **port call**, London-school:
   `describe('Given an executable mode')` > `describe('When writeWorkingTreeEntry
   writes a regular payload')` > `it('Then it chmods the file to 0o755')` —
   `buildSeededContext()` (the suite's existing fixture), spy with
   `vi.spyOn(ctx.fs, 'chmod')`, write with `'100755'`, assert the spy was called
   with (workDir-joined path, `0o755`). Siblings:
   `'100644'` chmods `0o644`; symlink mode never calls chmod. All fail: no chmod
   call exists today. (The **real** on-disk bit is pinned by the Q1/Q2/Q4
   interop in steps 9-10 — the node adapter path.)
2. GREEN: the chmod line + constants.
3. RED (unit, merge writer): bare `content` symlink-pair conflict
   (`conflictOf({ type: 'content', ourId, theirId, baseId, ourMode: '120000',
   theirMode: '120000', baseMode: '100644' })`, ours blob seeded with the target
   string) through `writeConflictToTree` → `it('Then ours symlink is re-created,
   not its target bytes as a file')`: lstat is a symlink, readlink = target.
   Fails twice today (marker fallback bytes + regular-file write) — after fixing
   `materialiseContent` it still fails on the kind until `useMode` lands; keep
   the two GREEN sub-steps separate so each RED reason is observed:
   3a GREEN: `materialiseContent` take-ours collapse (+ rewrite the two pinned
   fallback tests at ~2276/~2300: bare content with ours+theirs ids → ours bytes;
   bare content with only ourId → ours bytes, no longer `undefined`).
   3b GREEN: `writeConflictToTree` useMode generalisation.
4. RED (unit, merge writer): marker-bytes conflict with `ourMode: '100755'` →
   written file has exec bit (Q4 unit twin). Fails before 3b.
5. RED (unit, merge writer): modify-delete with ours deleted (only `theirId`) →
   still a plain survivor write (no mode regression — guards the
   `ourMode === undefined` arm).
6. RED (unit, merge writer): bare `type-change` with `ourMode: '120000'` (ours
   symlink, theirs e.g. gitlink — the ADR-321-cited gitlink-involved case) →
   ours' symlink is re-created at `path`, not target bytes as a file. Fails
   before the useMode generalisation (the old gate was `type === 'add-add'`).
7. RED (unit, apply writer): mirror tests 3-6 against `writeMarkedConflict`
   (bare content symlink pair → symlink; `conflictContent` + exec mode → exec
   marker file; ours-deleted modify-delete unchanged; symlink-ours type-change →
   symlink). GREEN: `writeMarkedConflict` useMode replacement +
   `conflictBytes`/`outcomeChangesOurs` comment re-derivations.
8. RED (interop): S9b and P3 — `setupWithBase` symlink pairs over file and
   symlink bases → both tools UU; `lsStage` parity (three stages at `p`);
   worktree `p` is **ours' symlink** on both (`readlinkSync` both repos equal);
   no marker bytes anywhere. Fails before this slice (tsgit wrote a regular file;
   P3 additionally wrote marker bytes) — these two rows are also the end-to-end
   proof of slice 2's R5 classification.
9. RED (interop): Q1 — base symlink, sides identical bytes with `chmodSync` 755
   on ours' side only → both tools UU, stage parity, worktree bytes identical
   with mode 755 on both (`lstatSync(...).mode & 0o777 === 0o755`), no markers.
   Q2 — union attribute + differing text + differing modes → UU, clean union
   bytes, ours' mode, no markers. Both fail before this slice (tsgit's marker
   file came out 644).
10. RED (interop): Q4 control — plain regular content conflict (no kind change
    anywhere) with both sides 100755 → marker file mode 755 on both tools. Fails
    before this slice (the pre-existing repo-wide exec-bit gap).
11. `npm run validate` — expect collateral expectation updates in merge.test.ts /
    apply-merge-to-worktree.test.ts wherever a take-ours write's on-disk mode is
    asserted; fix expectations to the mode-aware contract, never weaken
    assertions.

**Mutation notes:** the EXECUTABLE-ternary is killed by test 1's pair; the
`ourMode !== undefined` guard by tests 3-5; deleting the merge marker-fallback
removes its mutants wholesale. The re-derived comments in `conflictBytes` are the
mutation phase's audit anchor — write them as if defending each disable to a
reviewer.

**Commit:** `feat(merge): mode-aware conflict writes for every conflict type`

---

## Sequencing and parallelism

Strictly sequential 1 → 2 → 3 → 4 → 5. Slices 4 and 5 are conceptually
independent (different production files) but both append cases to
`distinct-types-with-base-interop.test.ts` and slice 5's S9b/P3 pins depend on
slice 2 — do not parallelise; the shared interop file would conflict.

## Post-slice phases (workflow-owned, not slices)

- Review ×3 (typescript / security / tests) then the architecture-refactor pass:
  candidate folds spotted while planning — `materialiseContent` /
  `materialiseAddAdd` are now byte-identical (merge.ts), and
  `writeWorkingTreeEntry` vs `apply-changeset.ts`'s `writeFileEntry` differ only
  by the gitlink branch; both are refactor-phase calls, not slice work.
- Mutation: scoped runs per touched file
  (`./node_modules/.bin/stryker run --mutate <file>`), remembering local
  vitest-4 mis-pairing produces false survivors — verify suspicious survivors
  analytically or via `__STRYKER_ACTIVE_MUTANT__` before writing tests for them.
- Docs: release-note the probing change (R6 alters an observable 24.9f output on
  double collisions) and the sequencer MERGE_MSG fix; backlog follow-up for the
  merge-command tracked-dirty refusal (S13, R9 — explicitly out of scope).

## Out of scope (do not let a slice drift into these)

- Gitlink-involved pairs (S10/S11) — keep bare take-ours `type-change` (R8).
- Delete vs kind-change (one side absent) — existing `modify-delete` route.
- Merge-command tracked-dirty refusal (S13) — backlog follow-up.
- Display strings — consumers reconstruct from structured fields (ADR-249).
- `merge` MERGE_MSG trailer (ADR-028 divergence stands).
