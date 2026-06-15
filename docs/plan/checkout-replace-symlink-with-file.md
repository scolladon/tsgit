# Plan — checkout: replace a symlink with a regular file (one shared working-tree writer)

> Source: design doc `docs/design/checkout-replace-symlink-with-file.md` · ADRs `340`, `341`
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices: coverage/interop/property tests fold
  into the implementation slice whose code they exercise.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

## Deviation from the design's 6-slice hint (read before implementing)

The design's "Slicing hint for the planner" proposed 6 slices. Verified live against
the worktree, three of them are **test-only / no-op over already-landed code** and the
sizing rules forbid them as standalone slices — they are folded:

- **Design slice 4 (migrate `apply-merge-to-worktree.ts` + `stash.ts`)** is a **no-op
  source change**: both files **already import and call the shared primitive
  `writeWorkingTreeFile`** from `src/application/primitives/internal/write-working-tree-file.js`
  (verified: `apply-merge-to-worktree.ts` import L37–41 + call L231/238; `stash.ts`
  import L35–37 + call L379). They inherit the always-`rmIfExists` the moment that
  primitive's body is rerouted — which happens in **this plan's Slice 2**. There is no
  distinct import/call edit to make. Slice 2 *is* their migration; their cherry-pick /
  rebase / revert / stash interop suites are the behaviour-preservation guard and run
  under the phase-boundary `npm run validate`. Folded into Slice 2.
- **Design slice 5 (memory cross-adapter consistency assert)** exercises the
  `rmIfExists` line introduced by `writeRegularFile` — it is the mutation-kill test for
  that exact line and must ship in the slice that introduces the line. Folded into
  Slice 1.
- **Design slice 6 (drop the 4 test workarounds)** exercises the consolidated regular
  branch landed in Slice 1 (checkout's `applyEntry` + distinct-types both route through
  it); it is Slice 1's end-to-end self-heal proof. Folded into Slice 1.

Net: **3 slices.** Slice 1 = the bug fix + twin gap + interop pin + memory assert +
workaround removal (one shared `writeRegularFile` regular branch fixes them all). Slices
2–3 = the pure behaviour-preserving migration of the regular-only writers. Nothing else
in the design's hint changes — order (bug fix first, then merge-local deletion after the
primitive is rerouted) and the pinned matrix are preserved.

## Surface decision (decided up front — NO surface gates tripped)

Every symbol this plan introduces or changes is **internal** (consumed only within
`src/`), confirmed against `surface-gates.md`:

- `writeRegularFile` (NEW) — internal helper in `internal/write-working-tree-file.ts`;
  consumed only by its two siblings in the same module. **Internal.**
- `ensureParent` (NEW, extracted) — internal, same module. **Internal.**
- `joinPath` lifted/shared into the internal module (NEW export from that module) —
  consumed only by the dispatcher in the same module + `apply-changeset.ts` (a sibling
  in `src/`). **Internal.**
- `writeWorkingTreeEntry`, `writeWorkingTreeFile`, `rmIfExists`, `parentDir`,
  `removeWorkingTreeFile` — already internal; bodies/wiring change, surface does not.
- `writeFileEntry` is **deleted** (not exported beyond the module today).
- merge-local `writeWorkingTreeFile` is **deleted**.

No `Repository` method, no exported error code / union member, no Tier-1 command, no
barrel entry, no `index.*` re-export changes. Therefore **none** of the surface gates
fire: no `src/application/commands/index.ts` edit, no `src/repository.ts` /
`test/unit/repository/repository.test.ts` edit, no `docs/use/commands/*` page, no
`test/parity/scenarios/*` scenario, no README count bump, **no `reports/api.json`
regeneration** (the `check:doc-typedoc` prepush gate stays green untouched). The
implementer must NOT chase any of those — they are phantom gates for this change.
ADR-249 (structured data only) is unaffected: no command surface, no rendered output.

---

## Slice 1 — bug fix + twin gap: the shared `writeRegularFile` regular branch

### Context

**Goal.** Introduce the layered helper and route checkout through it, fixing 24.9p
(checkout symlink→file) AND the `writeWorkingTreeEntry` twin gap in one shared regular
branch. Pin against real git (matrix A–D). Add the memory cross-adapter consistency
assert. Drop the 4 redundant `unlinkSync` test workarounds.

**Files to touch (all paths absolute from worktree root
`/Users/scolladon/workspace/perso/node/tsgit-checkout-replace-symlink-with-file`):**

- `src/application/primitives/internal/write-working-tree-file.ts` — the consolidated
  module. Current exported symbols (verified via Serena): `rmIfExists`, `parentDir`,
  `writeWorkingTreeFile`, `writeWorkingTreeEntry`, `removeWorkingTreeFile`, plus consts
  `decoder`, `MODE_REGULAR_PERM` (0o644), `MODE_EXEC_PERM` (0o755).
  - `rmIfExists(ctx, fullPath: string)` — `lstat`-probe (`.then(true).catch(false)`) then
    `ctx.fs.rm`. **Unchanged.** Already removes dangling symlinks (no follow).
  - `parentDir(fullPath: string): string | undefined` — `lastIndexOf('/')`, `<= 0 →
    undefined`. **Unchanged.**
  - `writeWorkingTreeFile(ctx, path: FilePath, content: Uint8Array)` — today:
    `const fullPath = \`${ctx.layout.workDir}/${path}\``; mkdir parent; `ctx.fs.write`.
    **Not touched in this slice** (rerouted in Slice 2). Leave as-is here.
  - `writeWorkingTreeEntry(ctx, path: FilePath, content: Uint8Array, mode: FileMode)` —
    today: bare-concat `fullPath`; mkdir parent; if `SYMLINK` → `rmIfExists` +
    `ctx.fs.symlink(decoder.decode(content), fullPath)` + return; else `ctx.fs.write` +
    `ctx.fs.chmod(fullPath, mode === EXECUTABLE ? 0o755 : 0o644)`. **This is the twin gap**
    (regular branch has no `rmIfExists`). It has **no GITLINK branch today** — add one
    (mkdir) so it can serve checkout's submodule materialisation.
- `src/application/primitives/apply-changeset.ts` — current exported symbols:
  `joinPath`, `applyEntry`, `applyChangeset`, `writeFileEntry`, `buildIndexEntry`, …
  - `joinPath = (workdir: string, rel: FilePath): string => workdir.endsWith('/') ?
    \`${workdir}${rel}\` : \`${workdir}/${rel}\`` (L48–49) — **trailing-slash-aware.**
    Lift/share this into the internal module so the dispatcher reuses it (design
    §"Faithfulness of the absolute-path equivalence"). `apply-changeset.ts` keeps using
    it (import it from the internal module, or keep a local re-export — implementer's
    call, but there must be **one** definition).
  - `writeFileEntry(ctx, absPath: string, content, mode: FileMode)` (L118–138) — branches
    SYMLINK (`rmIfExists`+`symlink`) / GITLINK (`mkdir`) / regular (`write`+`chmod`, **NO
    `rmIfExists` — the 24.9p gap**). **DELETE this function.**
  - `applyEntry(ctx, workdir: string, entry: ChangesetEntry)` (L165–184) — computes
    `absPath = joinPath(workdir, entry.path)`; on `delete` → `rmIfExists(ctx, absPath)`;
    else reads blob (or empty Uint8Array for GITLINK) and calls
    `writeFileEntry(ctx, absPath, content, entry.mode)`; then `return buildIndexEntry(ctx,
    absPath, entry.path, entry.id, entry.mode)`. **Migrate the writer call to
    `writeWorkingTreeEntry(ctx, entry.path, content, entry.mode)`** (drop the pre-join for
    the writer). **KEEP `absPath` computed** — `buildIndexEntry(ctx, absPath, …)` still
    needs it for its `lstat` (verified: `buildIndexEntry(ctx, absPath, relPath, id, mode)`,
    L140–163, opens with `await ctx.fs.lstat(absPath)`). The `delete`-branch `rmIfExists`
    keeps `absPath` too. So `applyEntry` still computes `absPath` for `buildIndexEntry`
    and `delete`, but the **writer** receives `entry.path` and joins internally.
  - **Path equivalence (faithfulness, read-only verified):** both `applyChangeset`
    callers pass `workdir = ctx.layout.workDir` — `materialize-tree.ts` (the checkout /
    branch-switch path) and `apply-sparse-checkout.ts`. The dispatcher joins
    `ctx.layout.workDir` with the **same trailing-slash-aware `joinPath`**, so the resolved
    absolute path is byte-identical to `writeFileEntry`'s old `joinPath(workdir,
    entry.path)`. If the implementer finds any `FilePath` where the lifted `joinPath`
    differs from the old result beyond the (eliminated) trailing-slash double-slash case,
    surface it as a slice blocker — do not improvise.

**Target shape of `internal/write-working-tree-file.ts` after this slice (design
§"Target shape of the shared helper", chosen option (ii) layered pair):**

```
rmIfExists(ctx, fullPath)                  // unchanged
parentDir(fullPath)                        // unchanged
ensureParent(ctx, fullPath)                // (extracted) mkdir parent when parentDir !== undefined
joinPath(workDir, path)                    // lifted/shared, trailing-slash-aware

// LOW-LEVEL regular writer — SINGLE owner of the unlink-before-regular-write rule (ADR-341)
writeRegularFile(ctx, fullPath: string, content, mode?: FileMode)
  // ensureParent → rmIfExists(ctx, fullPath) ALWAYS → ctx.fs.write → if mode given chmod(exec?755:644)

// MODE DISPATCHER
writeWorkingTreeEntry(ctx, path, content, mode)
  // fullPath = joinPath(ctx.layout.workDir, path)
  // SYMLINK  → rmIfExists + ctx.fs.symlink(decoder.decode(content), fullPath)
  // GITLINK  → ensureParent? then ctx.fs.mkdir(fullPath)   (NEW branch — only checkout feeds it)
  // regular  → writeRegularFile(ctx, fullPath, content, mode)   (twin gap closed)

writeWorkingTreeFile(ctx, path, content)   // UNCHANGED in this slice (Slice 2 reroutes it)
removeWorkingTreeFile(ctx, path)           // unchanged
```

Notes the implementer must honour:
- `writeRegularFile`'s `rmIfExists` is **always** called, no symlink guard (ADR-341) —
  this is the line the mutation phase targets; the kill tests below pin it.
- The dispatcher's regular branch now applies chmod via `writeRegularFile`'s `mode?`
  arg, preserving today's 644/755 behaviour. GITLINK passes no content write/chmod
  (mkdir only) — design §"GITLINK branch": only checkout reaches it; merge family rejects
  `gitlink` in `UNSUPPORTED_CONFLICT_TYPES` before any write (verified: `merge.ts`
  L179–182 set `{'rename-rename','gitlink'}`; `apply-merge-to-worktree.ts` L46 same).
- `ensureParent` may be a provably-equivalent `mkdir` mutant target (the FileSystem port
  contract creates parents in `write`). The merge-local copy Stryker-disables its own
  mkdir as equivalent. If the same equivalence holds, document it per CLAUDE.md "accept
  provably equivalent mutants" — do NOT add a `Stryker disable` comment without surfacing
  it; prefer an honest kill test if one exists, else note equivalence in the mutation
  phase. Functions stay <20 lines (Object Calisthenics / CLAUDE.md).

**Tests to add / extend:**

1. NEW interop test
   `test/integration/checkout-replace-symlink-with-file-interop.test.ts` (the 24.9p
   faithfulness pin). Mirror the established interop style from
   `test/integration/distinct-types-with-base-interop.test.ts`:
   - Header `@proves` block (style verified L1–13 of distinct-types):
     ```
     surface:        repo.checkout
     bucket:         cross-tool-interop
     unique:         checkout symlink→file replace runs against git
     interopSurface: checkout
     ```
   - Helpers from `./interop-helpers.ts` (verified exports): `GIT_AVAILABLE`,
     `makePeerPair(slug)` (returns `{ peer, ours, dispose }`, both `mkdtemp` dirs),
     `runGit(args, opts?)`, `runGitEnv()` (scrubbed env, ADR-337/338 hardened), `lsStage(dir)`
     (= `git ls-files --stage`).
   - `describe.skipIf(!GIT_AVAILABLE)(..., { timeout: 60_000 }, ...)` (60s per the
     interop-load flake note). Use ONE shared peer/ours pair per the heavy-interop
     convention — prefer a `beforeAll` that builds the base graph once and per-`it`
     branch-switches, OR a shared pair with per-scenario branches; the distinct-types
     file uses `beforeEach` + `{ timeout: 60_000 }` — either is acceptable but keep the
     git-spawn count bounded.
   - tsgit side: `openRepository({ cwd: pair.ours })` from `../../src/index.node.js`;
     branch switch = `repo.checkout({ rev: 'feat' })`; path-restore = `repo.checkout({
     paths: ['p'], force: true })` (verified `CheckoutOptions`: `{ rev }` switch vs
     `{ paths, force? }` restore — `checkout.ts` L31/33/37).
   - Reconstruct git's view via structured probes (ADR-249), never rendered stdout:
     `lstatSync(p).isSymbolicLink()`, `readlinkSync`, `readFileSync`, mode bits via
     `lstatSync(p).mode & 0o777`, and `lsStage(ours) === lsStage(peer)`.
   - **Edge matrix (reproduce the pinned matrix exactly — design §"Pinned faithfulness
     matrix", git 2.54.0):**
     - **A** symlink→regular 644: base+main commit `p` as symlink `the-target`; `feat`
       commits `p` as regular `regular file content\n` (644); HEAD on main (disk = symlink);
       `checkout feat` → `p` is a regular file, content `regular file content\n`, mode
       **644**, `!isSymbolicLink()`, stage `100644`, `lsStage` parity, status clean.
     - **D** symlink→executable 755: same graph but `feat`'s `p` is `#!/bin/sh…` (755);
       `checkout feat` → regular file, mode **755**, stage `100755`, parity, clean.
     - **B** reverse regular→symlink (continuing from `feat`): `checkout main` → `p` is a
       symlink → `the-target`, `isSymbolicLink()` true, `readlink` matches on both tools,
       stage `120000`, parity, clean. (Guards the SYMLINK branch against regression.)
     - **C** dangling-symlink squat: `feat` has regular `p`; place a **dangling** symlink
       (`symlinkSync('/nonexistent/dangling', join(ours,'p'))`) squatting `p`; `repo.checkout({
       paths: ['p'], force: true })` → dangling symlink removed, regular file `regular file
       content\n` written, `!isSymbolicLink()`, index unchanged, clean.
   - Parity assertion is `ours === peer` (both tools build the same graph), not literals
     alone.

2. EXTEND
   `test/unit/application/primitives/internal/write-working-tree-file.test.ts` (current
   structure verified: top `describe('write-working-tree-file')` with child describes
   `parentDir`, `writeWorkingTreeFile`, `writeWorkingTreeEntry`, `writeWorkingTreeEntry —
   chmod`, `removeWorkingTreeFile`; imports from
   `../../../../../src/application/primitives/internal/write-working-tree-file.js`;
   `FILE_MODE`/`FilePath` from `../../../../../src/domain/objects/index.js`;
   `buildSeededContext` from `../fixtures.js` — backed by `createMemoryContext`, so
   `ctx.fs` is the **memory** adapter). Add, following GWT-split + AAA + `sut`:
   - `describe('writeRegularFile')`:
     - **isolated guard test A — symlink-occupied path:** Arrange a symlink at
       `\`${ctx.layout.workDir}/r.txt\`` (`ctx.fs.symlink('old-target', fullPath)`); Act
       `writeRegularFile(ctx, fullPath, encode('new'), FILE_MODE.REGULAR)`; Assert
       `lstat(fullPath)` reports a regular file (`isSymbolicLink === false`) and bytes ===
       'new'. (CLAUDE.md: guard clauses need isolated tests.)
     - **isolated guard test B — absent path:** no pre-existing entry; Act
       `writeRegularFile`; Assert it writes the bytes and does not throw (rmIfExists is a
       no-op). (Second guard branch in isolation.)
     - **regular-over-regular:** pre-write a regular file with different bytes; Act
       `writeRegularFile`; Assert bytes rewritten to the new content (identical-bytes
       rewrite is safe).
     - **chmod by mode:** spy `ctx.fs.chmod` (style verified L138 `vi.spyOn(ctx.fs,
       'chmod')`); assert called with 0o755 for EXECUTABLE, 0o644 for REGULAR; and **not
       called** when `mode` arg is omitted (the `writeWorkingTreeFile` path).
   - EXTEND `describe('writeWorkingTreeEntry')`:
     - **twin-gap kill — regular over symlink:** Arrange a symlink at the path; Act
       `writeWorkingTreeEntry(ctx, 'r.txt' as FilePath, encode('x'), FILE_MODE.REGULAR)`;
       Assert `lstat` reports a regular file (not a symlink) and bytes land. (Proves the
       regular branch now routes through `writeRegularFile`'s always-rm.)
     - **GITLINK branch (NEW):** Act `writeWorkingTreeEntry(ctx, 'sub' as FilePath, new
       Uint8Array(), FILE_MODE.GITLINK)`; Assert a directory is created at the path and
       `ctx.fs.write`/`ctx.fs.chmod` are NOT called (spy + `not.toHaveBeenCalled`). Kills
       the GITLINK-branch-removal mutant alongside the `submodule-init-sync-deinit-interop`
       suite.
     - Keep the existing SYMLINK / nested-parent / chmod tests green (the SYMLINK branch
       still `rmIfExists`+`symlink`).
   - **Memory cross-adapter consistency (ADR-341, folded design slice 5)** — in the
     `writeRegularFile` or `writeWorkingTreeEntry` describe: after a symlink→file write on
     the memory `ctx.fs`, assert `lstat(fullPath).isSymbolicLink() === false` AND there is
     **exactly one** entry at the path (no stale `symlinks` entry). The memory adapter's
     `write` (`src/adapters/memory/memory-file-system.ts` ~L85–90) sets `files` WITHOUT
     clearing `symlinks`, and `lstat` (~L144) checks `symlinks` first — so without the
     `rmIfExists`, `lstat` would still report a symlink. This assert is the memory-side
     mutation-kill for the dropped-`rmIfExists` mutant (it catches the corruption even
     though memory `write` does not throw). Assert observable: `lstat` is a regular file
     after the write (a symlink-still-present result fails it).
   - Error assertions must be specific (assert `.code`/`.reason`, never `toThrow(Error)`
     alone) per CLAUDE.md — applies if any new test asserts a throw.

3. EDIT `test/integration/distinct-types-with-base-interop.test.ts` — **drop the 4
   redundant `unlinkSync` workarounds** (folded design slice 6; the design's verified
   table is the authority, NOT the brief). Remove exactly:
   - **L211–215** the whole `if (spec.theirs.kind === 'symlink') { unlinkSync(path.join(pair.ours,
     'p')); }` block in `setupWithBase` (incl. the explanatory comment L211–212).
   - **L502–504** the comment + `unlinkSync(path.join(pair.ours, 'p'))` (S5).
   - **L660–662** the comment + `unlinkSync(...)` (S8).
   - **L718–720** the comment + `unlinkSync(...)` (P1).
   - **KEEP the `unlinkSync` import** (L20) — lines 1046/1121/1285/1300/1382 still use it
     (Q1/Q2/Q6/P5 — verified NOT this bug's squat: regular→regular or symlink-retarget
     mechanics). KEEP those. After removal, the suite passes **because tsgit self-heals**
     the symlink→file checkout via Slice 1's consolidated regular branch — this is the
     twin-gap end-to-end proof.

### TDD steps

- **RED**
  - Add the new interop test (matrix A–D). On node, A/D/C **fail** with
    `PERMISSION_DENIED` (checkout's regular fallthrough writes through the occupying
    symlink — the 24.9p bug); B passes (reverse already works).
  - Add `writeRegularFile` unit tests + the `writeWorkingTreeEntry` twin-gap/GITLINK
    tests + the memory consistency assert. They **fail to compile/import** (`writeRegularFile`
    does not exist yet) and the twin-gap/memory asserts fail (regular branch has no
    `rmIfExists`; memory `lstat` still reports a symlink). Expected failure reason: missing
    export + missing always-unlink.
  - Remove the 4 `unlinkSync` workarounds — those distinct-types scenarios now **fail** on
    node with `PERMISSION_DENIED` at `checkout main` (the squat the workaround used to
    pre-clear). Expected failure reason: same 24.9p bug, via `writeWorkingTreeEntry`'s
    regular branch.
- **GREEN**
  - In `internal/write-working-tree-file.ts`: extract `ensureParent`; lift/share
    `joinPath` (trailing-slash-aware); add `writeRegularFile(ctx, fullPath, content,
    mode?)` = `ensureParent` → **always** `rmIfExists` → `write` → `chmod` if `mode`
    given; route `writeWorkingTreeEntry`'s regular branch through `writeRegularFile`; add
    the GITLINK `mkdir` branch; the dispatcher joins via the shared `joinPath`. Leave
    `writeWorkingTreeFile` unchanged here.
  - In `apply-changeset.ts`: delete `writeFileEntry`; migrate `applyEntry` to call
    `writeWorkingTreeEntry(ctx, entry.path, content, entry.mode)` while still computing
    `absPath` for `buildIndexEntry` + the `delete` branch; switch `apply-changeset`'s
    `joinPath` usage to the single shared definition.
  - All three test groups go GREEN: interop A–D pass with `ours === peer`; unit branches
    pass; the 4 de-worked distinct-types scenarios pass because tsgit unlinks the squatter
    itself.
- **REFACTOR**
  - Keep each helper <20 lines, early returns, no nesting >2. Confirm there is exactly
    ONE `joinPath` and ONE owner of the always-unlink rule (`writeRegularFile`). Run
    `get_diagnostics_for_file` on both edited source files; ground truth is `check:types`.

### Gate

`npx vitest run test/integration/checkout-replace-symlink-with-file-interop.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts test/integration/distinct-types-with-base-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/write-working-tree-file.ts src/application/primitives/apply-changeset.ts test/integration/checkout-replace-symlink-with-file-interop.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts test/integration/distinct-types-with-base-interop.test.ts`

### Commit

`fix(checkout): replace an occupying symlink with a regular file via one shared writer`

---

## Slice 2 — route the regular-only `writeWorkingTreeFile` through `writeRegularFile`

### Context

**Goal.** Make the primitive façade `writeWorkingTreeFile` self-heal on a symlink-squat
by delegating to `writeRegularFile` (gains the always-`rmIfExists`). This is the
behaviour-preserving migration for **`apply-merge-to-worktree.ts` and `stash.ts` at the
same time** — both already call this primitive (no edit needed in those files; see the
deviation note above). Behaviour-preserving: regular-over-regular rewrites to identical
bytes; a symlink-squat now self-heals instead of throwing on node.

**Files to touch:**

- `src/application/primitives/internal/write-working-tree-file.ts` — change ONLY
  `writeWorkingTreeFile(ctx, path: FilePath, content: Uint8Array)`. Today (after Slice 1
  it is still the original): `fullPath = joinPath/bare-concat`; mkdir parent;
  `ctx.fs.write(fullPath, content)`. **After:** `writeRegularFile(ctx, joinPath(ctx.layout.workDir,
  path), content)` (no `mode` arg → default 644, no chmod, exactly matching today's
  behaviour for its callers — git restores these from regular blobs). Use the shared
  `joinPath` (Slice 1 lifted it) so the path resolution is identical to the dispatcher.

**Files that inherit the fix with NO edit (do not touch — verified):**

- `src/application/primitives/apply-merge-to-worktree.ts` — imports `writeWorkingTreeFile`
  from `./internal/write-working-tree-file.js` (L37–41); calls it at L231 (`resolved-merged`)
  and L238 (`resolved-known`). Guarded by `cherry-pick-interop`, `rebase-interop`,
  `revert-interop`.
- `src/application/commands/stash.ts` — imports it from
  `../primitives/internal/write-working-tree-file.js` (L35–37); calls it at L379
  (`restoreUntracked`). Guarded by `stash-interop`.

**Tests to add / extend:**

- EXTEND `test/unit/application/primitives/internal/write-working-tree-file.test.ts`
  `describe('writeWorkingTreeFile')`:
  - **symlink-squat self-heal:** Arrange a symlink at `\`${ctx.layout.workDir}/r.txt\``;
    Act `writeWorkingTreeFile(ctx, 'r.txt' as FilePath, encode('x'))`; Assert `lstat`
    reports a regular file (not a symlink) and bytes land. (RED before the reroute: memory
    `lstat` would still report a symlink — or on node it throws.)
  - **no chmod:** spy `ctx.fs.chmod`; Act `writeWorkingTreeFile`; Assert
    `chmod` is NOT called (façade passes no mode). Keep the existing nested-parent test
    green.
- The behaviour-preservation guard for apply-merge/stash is their existing interop
  suites; they run under the phase-boundary `npm run validate` (no per-slice edit, but
  list them in the slice gate as a regression guard — see Gate).

### TDD steps

- **RED** — add the `writeWorkingTreeFile` symlink-squat self-heal + no-chmod unit tests;
  the self-heal test fails (façade still does a bare `ctx.fs.write` with no `rmIfExists`,
  so memory `lstat` still reports a symlink / node throws). Expected failure reason:
  regular branch of the façade does not unlink first.
- **GREEN** — reroute `writeWorkingTreeFile` body to `writeRegularFile(ctx,
  joinPath(ctx.layout.workDir, path), content)`. Unit tests pass. apply-merge / stash
  interop suites stay green (they now pay one extra `lstat`+`unlink` per write,
  observably identical on-disk state).
- **REFACTOR** — confirm the façade is a one-liner delegating to `writeRegularFile`; no
  duplicated mkdir/write logic remains. `get_diagnostics_for_file`; `check:types`.

### Gate

`npx vitest run test/unit/application/primitives/internal/write-working-tree-file.test.ts test/integration/cherry-pick-interop.test.ts test/integration/rebase-interop.test.ts test/integration/revert-interop.test.ts test/integration/stash-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/write-working-tree-file.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts`

### Commit

`refactor(primitives): route writeWorkingTreeFile through the shared regular writer`

---

## Slice 3 — migrate `merge.ts` to the shared `writeWorkingTreeFile`, delete its private copy

### Context

**Goal.** Remove `merge.ts`'s private copy of `writeWorkingTreeFile` (DRY, ADR-340) and
route its two call sites through the shared primitive (which, after Slice 2, already does
rm-then-write — exactly what the merge-local copy did). Pure behaviour-preserving
consolidation.

**Files to touch:**

- `src/application/commands/merge.ts`:
  - Private `writeWorkingTreeFile = async (ctx, path: FilePath, content: Uint8Array)`
    (L666–682) — does `bare-concat fullPath`; `parentDir`; **Stryker-disabled** redundant
    mkdir; `rmIfExists`; `ctx.fs.write`. **DELETE this function** (and its leading
    block-comment about the 'creation'-mode rm). It is identical to the shared primitive
    after Slice 2.
  - Two call sites of the private copy (verified): **L601** (`writeOutcomeToTree`,
    `unchanged`/`resolved-known` blob) and **L607** (`writeOutcomeToTree`,
    `resolved-merged` bytes). They keep the same call shape `writeWorkingTreeFile(ctx,
    outcome.path, …)` but now resolve to the imported shared primitive.
  - Import block (L37–40): currently `import { rmIfExists, writeWorkingTreeEntry } from
    '../primitives/internal/write-working-tree-file.js';`. **Add `writeWorkingTreeFile`**
    to this import. `rmIfExists` is still imported (used by the private `removeWorkingTreeFile`
    at L685–688 — see scope note).
  - **SCOPE NOTE — do NOT delete merge's private `parentDir` / `removeWorkingTreeFile`.**
    Verified: `merge.ts` also defines private `parentDir` (L691–695) and
    `removeWorkingTreeFile` (L685–688). They are duplicates of the internal module's, BUT:
    (a) the design's call-site table mandates deleting ONLY the merge-local
    `writeWorkingTreeFile`; (b) both are **directly imported and unit-tested** in
    `test/unit/application/commands/merge.test.ts` (`parentDir` direct tests L1864–1894;
    `removeWorkingTreeFile` direct tests L2055–2079). Deleting them is out of scope for
    24.9p (it would force test rewrites the design did not sanction and is the refactor
    phase's job). Leave them. After deleting `writeWorkingTreeFile`, `parentDir` is still
    referenced (by the now-deleted function?) — verify: `parentDir` is referenced ONLY by
    the deleted `writeWorkingTreeFile` (find_referencing showed merge.ts L672) AND by
    merge.test.ts. Once `writeWorkingTreeFile` is deleted, `parentDir`'s only remaining
    use is the direct unit test — it would become unused in src. **If `parentDir` becomes
    unreferenced in `src/` after the deletion, that is a real issue:** surface it as a
    slice decision — either keep the direct unit test referencing it (so it stays exported
    and exercised) or, if biome/knip flags dead code, escalate `{ slice 3, reason:
    parentDir orphaned by writeWorkingTreeFile deletion, options: (a) leave the export +
    its direct unit test as the only consumer, (b) remove parentDir + its merge.test.ts
    block, (c) defer to refactor phase }`. Do NOT silently delete the tested symbol.

**Behaviour-preservation guard (existing interop suites — no edit):**
`merge-interop`, `merge-conflict-interop`, `merge-driver-interop`, `merge-abort-interop`,
`conflict-marker-size-and-labels-interop`, `add-add-content-interop`. These build the
same graph with real git and assert tsgit's worktree/index `=== peer`; if the
consolidation broke any merge on-disk state, one goes red. Plus
`test/unit/application/commands/merge.test.ts` must stay green (it still imports
`parentDir`/`removeWorkingTreeFile`).

### TDD steps

- **RED** — N/A as a new test: this slice adds no new behaviour (Slice 2 already made the
  shared primitive do rm-then-write). The "RED" is the regression net: before the edit,
  confirm the merge interop + merge unit suites are green (baseline). The change is a pure
  deletion + import reroute.
- **GREEN** — add `writeWorkingTreeFile` to the internal-module import; delete merge's
  private `writeWorkingTreeFile` + its block comment; the two call sites (L601/L607) now
  bind the imported shared primitive. Resolve the `parentDir`-orphan question per the
  scope note (escalate if biome/knip flags it). All merge interop + unit suites stay
  green — behaviour-preserving (the merge-local copy and the shared primitive are
  byte-identical in effect after Slice 2).
- **REFACTOR** — confirm no merge-local writer duplication remains; the import is sorted
  (biome). `get_diagnostics_for_file` on `merge.ts`; `check:types`.

### Gate

`npx vitest run test/integration/merge-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/merge-driver-interop.test.ts test/integration/merge-abort-interop.test.ts test/integration/conflict-marker-size-and-labels-interop.test.ts test/integration/add-add-content-interop.test.ts test/unit/application/commands/merge.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/merge.ts`

### Commit

`refactor(merge): delete merge-local writeWorkingTreeFile, use the shared writer`

---

## Phase-boundary gate (run once after Slice 3, NOT per slice)

`npm run validate` — full quality gate (lint + format + types + unit + coverage +
interop). This is the behaviour-preservation proof for the whole consolidation: the
checkout interop pin (Slice 1) plus every merge / cherry-pick / rebase / revert / stash
interop suite (the ADR-340 negative-blast-radius guard) must be green. The mutation phase
runs separately and gates the PR; the mutation-kill tests for the always-`rmIfExists`
line and the GITLINK branch already ship in Slice 1.
