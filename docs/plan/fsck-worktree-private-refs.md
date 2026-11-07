# Plan — fsck checks every worktree's private refs and names them as git does

> Source: design doc `docs/design/fsck-worktree-private-refs.md` · ADRs 1150–1163
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

## How the design's nine parts map here

The design's order is kept (predicates → enumeration → walk → facts → listing → fsck
layer → namespace → interop → docs). Parts are split, never merged:

| design part | plan parts | why split |
|---|---|---|
| 1 domain predicates | 1, 2 | seven files in one Context block |
| 2 enumeration | 3 | — |
| 3 per-store walk | 4, 5, 6 | the walk's read-at-path refactor, the store loop and the root kinds are three GREENs; the store loop cannot land green without retiring the snapshot's HEAD refusal (a linked HEAD would report `cannotReadRef` twice: the existing test "Given a linked worktree whose HEAD file cannot be read for permission" pins exactly one) and without the per-store root check (a prefixed refs name fails `startsWith('refs/')` and would be judged a root ref), so those two fsck-layer pieces ride in Part 5; the widened `reason` and the new arm must land with the finding that carries them, so they ride in Part 6 |
| 4 facts | 7 | — |
| 5 listing | 8 | the integrity walk's `.lock` skip moves here, beside the listing's skip (both halves of ADR-1160 in one commit) |
| 6 fsck layer | 9 (+ pieces in 5 and 6, above) | — |
| 7 namespace | 10, 11, 12 | port method, write chain, read locator: fourteen files in one block |
| 8 interop | 13, 14, 15 | one new suite filled in three passes; the old suite's edits live in Part 5, where the names change |
| 9 docs | 16 | — |

Shared files (plan-lint's overlap warnings): ref-store.ts, ref-store.test.ts, refs-verify.ts,
roots.ts, fsck-worktree-heads.test.ts and fsck-broken-ref-chain.test.ts recur across parts on
purpose. Each part is one GREEN that must land green on its own; merging the parts that share
ref-store.ts would rebuild a part far over the sizing rules' five-cycle, six-file ceiling.
The parts run sequentially on one tree, so each starts from the previous commit.

Interop rows: every new-suite row lands in Parts 13–15, after every behaviour it pins.
The old suite `test/integration/fsck-broken-ref-chain-interop.test.ts` changes in Part 5
only (its `shownRef` would double the prefix the moment tsgit carries it), and every part
that changes fsck's observable output (5, 6, 8, 9, 12) re-runs it as a GUARD.

## Standing rules for every part (carry them; the implementers have no MCP tools)

- **RED first, one RED per function, run before its code.** Write the test, run it, see the
  named failure, then write the GREEN. A test that passes on first run is a GUARD; say why.
  Never break code to watch a test fail.
- **Test conventions.** `describe('Given …')` > `describe('When …')` > `it('Then …')`; AAA
  with `// Arrange`, `// Act`, `// Assert` comments; the system under test is bound to
  `sut` (the function or store, never its result). Error assertions read `.data` through
  try/catch (`expect((err as TsgitError).data).toEqual({ code: …, … })`), never a bare
  `toThrow(Class)`. 100 % line/branch/function/statement coverage on touched files. No
  `v8 ignore`, `istanbul ignore`, `biome-ignore`, `@ts-ignore`, no new `Stryker disable`
  line. Anchor new describes on describe titles named below, never on a closing-brace line.
- **No provenance in code or tests:** no ADR, backlog, design-row or part ids (A2, P3, …)
  in source, test titles or comments. Row ids appear in this plan only.
- **Runner traps.** A shell hook rewrites bare `npx vitest --version` / `npx tsc` into other
  runners: use the gate command exactly as given, or `./node_modules/.bin/vitest run <file>`
  for an ad-hoc run. `git diff` / `git show` need `--no-ext-diff`. wireit caches
  `check:types` and `check:spelling`: before trusting a green, `rm -rf .wireit` or run
  `./node_modules/.bin/tsc --noEmit -p tsconfig.json` and
  `./node_modules/.bin/cspell --no-progress <files>`. Never create files at the worktree root.
  `npm run validate` skips the integration projects' posix-only folder and is not the part
  gate; an interop suite runs only when named:
  `./node_modules/.bin/vitest run --project integration <file>` (project name `integration`,
  from vitest.config.ts).
- **Commit** with `git commit -m "<message>"`, your own files only; never stash, reset,
  checkout or switch. Never commit on a red gate.
- **Imports.** New domain predicates are internal: import them from their module file
  (house pattern: ref-store.ts imports `isPseudoRef` from the per-worktree-ref module, not
  from the refs barrel). Do NOT add them to the refs barrel (src/domain/refs/index.ts):
  src/domain/index.ts is a typedoc entry point, so a barrel entry would enter
  reports/api.json and the public surface.
- **Line numbers** below were re-located at the worktree base (adf96e8f; unchanged at
  76af0cc7) and shift as earlier parts land: find symbols by name, use the numbers as hints.

## Part 1 — Domain: name a linked store's refs and the main worktree's namespace

### Context

Files:
- `src/domain/refs/per-worktree-ref.ts` — today exports `PER_WORKTREE_PREFIXES`, `isPerWorktreeRef(name: RefName): boolean` (root-ref syntax `^[A-Z_-]*$` OR one of the three prefixes), `isPseudoRef`. Add three pure functions and two named constants ("worktrees/" and "main-worktree/"), each with a one-line doc comment saying why:
  - `linkedWorktreeRefPrefix(id: string): string` → the string "worktrees/" + id + "/".
  - `bareStoreRefName(name: string): string` → strips ONE leading "worktrees/<id>/" where <id> is one or more non-slash characters; identity otherwise (git's `parse_worktree_ref` for the display prefix).
  - `mainWorktreeBareName(name: RefName): RefName | undefined` → when `name` starts with "main-worktree/" and the remainder passes `isPerWorktreeRef`, the remainder; `undefined` for every other name (git's `REF_WORKTREE_MAIN` arm). The empty remainder ("main-worktree/") returns "" because `isPerWorktreeRef('')` is true (git's `is_root_ref_syntax` also accepts the empty string); pin it as an example row, it is not an error.
- `test/unit/domain/refs/per-worktree-ref.test.ts` — existing describes "isPerWorktreeRef" and the `isPseudoRef` one; add one top-level describe per new function.
- `test/unit/domain/refs/per-worktree-ref.properties.test.ts` — NEW property sibling (fast-check). Copy the layout of test/unit/domain/refs/symref-referent.properties.test.ts (local `fc.stringMatching` generators, `fc.assert(fc.property(…), { numRuns })`, GWT titles, `sut`). Read-only helper available: `arbRefName` in test/unit/domain/refs/arbitraries.ts (two to four lowercase components, never per-worktree in practice; filter with `isPerWorktreeRef` when a shared name is needed — an independently tested sibling, not a tautology). Generators to define locally: per-worktree names = root-ref syntax `/^[A-Z_-]{1,12}$/` or one of "refs/bisect/", "refs/worktree/", "refs/rewritten/" followed by an `arbRefName` value.

Public surface: none. All three are internal (not barrelled). knip (`check:dead-code`, phase gate only) sees them unused until Parts 3, 5 and 12 consume them; that is expected between parts.

Property lenses (CLAUDE.md, property-testing.md): `mainWorktreeBareName` is a name parser — lens 1 (round-trip: add the prefix, strip it) and lens 3 (total: `undefined` for every shared remainder and every name without the prefix). `linkedWorktreeRefPrefix` is a template with no grammar (no lens). `bareStoreRefName` gets no property per the caller's instruction; lens 1 nominally fits it composed with `linkedWorktreeRefPrefix` — see decision candidate PC-2.

### TDD steps

1. RED — per-worktree-ref.test.ts, describe "linkedWorktreeRefPrefix" > "Given a worktree id, When the prefix is built" > it "Then it is worktrees/<id>/": `expect(sut('wt')).toBe('worktrees/wt/')`. Fails: `linkedWorktreeRefPrefix` is not exported (import error).
2. GREEN — add `linkedWorktreeRefPrefix`.
3. RED — describe "bareStoreRefName": `it.each` rows: "worktrees/wt/refs/bisect/bad" → "refs/bisect/bad"; "worktrees/wt/HEAD" → "HEAD"; "worktrees/a/worktrees/b/HEAD" → "worktrees/b/HEAD" (one prefix only); "worktrees/wt" → unchanged (no trailing slash); "worktrees//HEAD" → unchanged (empty id); "x/worktrees/wt/HEAD" → unchanged (not leading); "refs/heads/main", "HEAD", "main-worktree/HEAD" → unchanged. Fails: not exported.
4. GREEN — add `bareStoreRefName` (an anchored pattern `^worktrees\/[^/]+\/`, replaced once).
5. RED — describe "mainWorktreeBareName": rows "main-worktree/HEAD" → "HEAD"; "main-worktree/ORIG_HEAD" → "ORIG_HEAD"; "main-worktree/refs/bisect/bad", "main-worktree/refs/worktree/x", "main-worktree/refs/rewritten/x" → the remainder; "main-worktree/" → ""; and `undefined` for "main-worktree/refs/heads/main", "refs/heads/main", "HEAD", "worktrees/wt/HEAD", "main-worktreeX/HEAD", "x/main-worktree/HEAD". Fails: not exported.
6. GREEN — add `mainWorktreeBareName`.
7. RED → GREEN is not available for properties (the code exists): per-worktree-ref.properties.test.ts is a GUARD: (a) "Given an arbitrary per-worktree name, When it is spelled under main-worktree/, Then mainWorktreeBareName returns it" (numRuns 200); (b) "Given an arbitrary shared ref name, When it is spelled under main-worktree/, Then mainWorktreeBareName returns undefined" (numRuns 100); (c) "Given an arbitrary ref name, When it carries no main-worktree/ prefix, Then mainWorktreeBareName returns undefined" (numRuns 100). Passes because step 6 implements exactly the prefix + `isPerWorktreeRef` rule.
8. REFACTOR — none expected; keep each function one expression.

Likely mutation survivors and their killers: the `isPerWorktreeRef` conjunct in `mainWorktreeBareName` (killed by "main-worktree/refs/heads/main" → `undefined`); the anchor and the `+` quantifier of `bareStoreRefName`'s pattern (killed by "x/worktrees/wt/HEAD" and "worktrees//HEAD"); the prefix literal (killed by the exact-equality row of step 1).

### Gate

`npx vitest run test/unit/domain/refs/per-worktree-ref.test.ts test/unit/domain/refs/per-worktree-ref.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/refs/per-worktree-ref.ts test/unit/domain/refs/per-worktree-ref.test.ts test/unit/domain/refs/per-worktree-ref.properties.test.ts && npm run check:spelling`

### Commit

`feat(refs): name a linked worktree's refs and the main-worktree namespace as git parses them`

## Part 2 — Domain: loose-entry skips and the branch referent test

### Context

Files:
- `src/domain/refs/loose-entry-name.ts` — NEW module, shape of src/domain/refs/per-worktree-ref.ts (module doc comment saying these are git's iterator rules, pure, no I/O). Two predicates over a basename, with named constants for "." and ".lock":
  - `isSkippedByRefsVerify(basename: string): boolean` → does not start with "." AND ends with ".lock" (`files_fsck_refs_dir`: a `.lock` file is skipped unless dot-led).
  - `isSkippedByLooseIterator(basename: string): boolean` → starts with "." OR ends with ".lock" (`loose_fill_ref_dir`).
- `test/unit/domain/refs/loose-entry-name.test.ts` — NEW.
- `src/domain/refs/symref-referent.ts` — add `isBranchReferent(referent: string): boolean` → starts with "refs/heads/" (git's `refs_fsck_symref` HEAD rule). The module already holds `REFS_PREFIX`, `WORKTREES_PREFIX` constants; add a "refs/heads/" constant beside them.
- `test/unit/domain/refs/symref-referent.test.ts` — add a top-level describe "isBranchReferent".

Public surface: none (internal, not barrelled). knip sees the three unused until Parts 7 and 8.

Property lenses: all three fail lens 1 (no inverse), lens 2 (no aggregation), lens 4 (no structure to count); lens 3 would re-implement `startsWith`/`endsWith` as the oracle (tautology). Their input space is a handful of classes, so an example sweep is the right tool. No property sibling.

### TDD steps

1. RED — loose-entry-name.test.ts, describe "isSkippedByRefsVerify" > "Given a ref directory entry name, When the refs-verify walk judges it": `it.each` "bad.lock" → true; ".x.lock" → false; "x.locked" → false; "bad" → false; ".hidden" → false. Fails: module does not exist.
2. GREEN — create the module with `isSkippedByRefsVerify`.
3. RED — describe "isSkippedByLooseIterator": ".hidden" → true; "bad.lock" → true; ".x.lock" → true; "x.locked" → false; "bad" → false. Fails: not exported.
4. GREEN — add `isSkippedByLooseIterator`.
5. RED — symref-referent.test.ts, describe "isBranchReferent": "refs/heads/main" → true; "refs/heads/a/b" → true; "refs/tags/x" → false; "refs/heads" → false; "HEAD" → false; "heads/main" → false. Fails: not exported.
6. GREEN — add `isBranchReferent`.

Likely survivors and killers: the dot-led exception in `isSkippedByRefsVerify` (".x.lock" → false); `&&`↔`||` in either predicate (".hidden" and "bad" rows); the trailing slash in "refs/heads/" ("refs/heads" → false).

### Gate

`npx vitest run test/unit/domain/refs/loose-entry-name.test.ts test/unit/domain/refs/symref-referent.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/refs/loose-entry-name.ts src/domain/refs/symref-referent.ts test/unit/domain/refs/loose-entry-name.test.ts test/unit/domain/refs/symref-referent.test.ts && npm run check:spelling`

### Commit

`feat(refs): add git's loose-entry skip rules and branch referent test`

## Part 3 — Linked worktree enumeration in OS order, with git's gitdir skip rule

### Context

Files:
- `src/application/primitives/internal/linked-worktrees.ts` — NEW. Exports:
  - `UNOPENABLE_FILE_CODES` (moved, unexported if nothing outside needs it) and `isUnopenableFile(err: unknown): boolean`, MOVED verbatim from src/application/commands/internal/fsck/roots.ts L200–208, its doc comment and its existing equivalent-marked Stryker line included (moving an approved line is not adding one).
  - `interface LinkedWorktreeAdmin { readonly id: string; readonly adminDir: string; readonly gitdirPointer: string }` (`gitdirPointer` is the `gitdir` file's raw content, untrimmed).
  - `linkedWorktreeAdmins(ctx: Context): Promise<ReadonlyArray<LinkedWorktreeAdmin>>`: list `commonGitDir(ctx)` + "/worktrees" with `(ctx.fs.readdirInOsOrder ?? ctx.fs.readdir).call(ctx.fs, dir)` (copy of ref-store.ts `readdirInOsOrder`, L1415–1417); a FILE_NOT_FOUND on that listing returns `[]`, every other fault propagates (today's `exists` + `readdir` pair propagates them too). Per entry, read "<adminDir>/gitdir" with `ctx.fs.readUtf8`; skip on `isUnopenableFile(err)`, rethrow anything else; skip when the content is exactly "" (git skips only a zero-byte file; whitespace-only still lists). No `isDirectory` filter: a file entry fails its gitdir read with NOT_A_DIRECTORY and is skipped by the same rule.
  - Imports: `commonGitDir` from the path-layout module, `errorDataCode` from src/domain/error-data-code.ts, `Context` type.
- `src/application/commands/internal/fsck/roots.ts` — re-import `isUnopenableFile` from the new module (delete the local copy, L195–208); `linkedWorktreeContext` (L921–939) takes `(ctx, admin: LinkedWorktreeAdmin): Context` — no gitdir read any more, returns `ctx` when `admin.adminDir === ctx.layout.gitDir` (now AFTER the skip rule, so a current worktree whose gitdir is empty is skipped: pin J), else `deriveWorktreeContext(ctx, admin.id, stripGitSuffix(resolveWorktreePath(admin.adminDir, admin.gitdirPointer.trim())))` keeping the existing equivalent-marked Stryker line on the trim. `worktreeContexts` (L942–955) maps `linkedWorktreeAdmins(ctx)` and names each "worktrees/<id>/HEAD" with `linkedWorktreeRefPrefix(id) + 'HEAD'` (Part 1). `addOtherWorktreeRoots` (L840–851, gc) iterates `linkedWorktreeAdmins(ctx)`, skips the admin whose `adminDir === ctx.layout.gitDir`, and calls `addNonCurrentWorktreeRoots(linkedWorktreeContext(ctx, admin), roots)`.
- `src/application/commands/internal/prune-worktrees.ts` — L33 imports `isUnopenableFile, stripGitSuffix` from the fsck roots module: take `isUnopenableFile` from the new module instead (no re-export from roots.ts).
- `test/unit/application/primitives/internal/linked-worktrees.test.ts` — NEW. Memory adapter (`createMemoryContext` from src/adapters/memory/memory-adapter.ts); admin dirs written as test/unit/application/commands/fsck-worktree-heads.test.ts `repoWithWorktrees` (L36–49) writes them (HEAD, gitdir "/work/<id>/.git\n", commondir "../..\n"). Fault injection as that file's `failGitdirRead` (L351–358): `vi.spyOn(ctx.fs, 'readUtf8')` delegating to the bound original. OS order: `Object.assign(ctx.fs, { readdirInOsOrder: async (p) => [...(await readdir(p))].reverse() })`, as ref-store.test.ts L3058–3064 does (the memory adapter has no `readdirInOsOrder`).
- `test/unit/application/commands/fsck-worktree-reflogs-index.test.ts` — fixture `repoWithWorktrees` (L65–80, wt1 and wt2), `reflogLine` (L82), `reflogFindings`; anchor new describes after "Given the main HEAD reflog naming an absent object" (L158).

Read-only: rev-list.ts L132 and pack-verify-order.ts L138 consume `worktreeContexts`/`worktreeHeads` and inherit the order (no edit). Maintenance suites exercise `addOtherWorktreeRoots`: test/unit/application/commands/maintenance.test.ts, maintenance-worktree-prune.test.ts, maintenance-resolve-undo-roots.test.ts (GUARDs).

Public surface: none (primitives/internal is not barrelled).

### TDD steps

1. RED — linked-worktrees.test.ts, describe "linkedWorktreeAdmins": "Given a repository with no worktrees directory, When the admins are listed, Then there are none" → `[]`. Fails: module does not exist.
2. GREEN — create the module with the absent-root path and the listing loop.
3. RED — same describe, one `it` per skip branch, each asserting the full returned array: an admin whose gitdir is absent (FILE_NOT_FOUND); refused (`permissionDenied(path)` from src/domain/error.ts); NOT_A_DIRECTORY (an entry that is a regular file under worktrees); zero bytes → all skipped; a whitespace-only gitdir ("\n") → listed with `gitdirPointer: '\n'`; an unclassified fault (`new Error('EIO')`) on the gitdir read → `rejects.toBe(fault)`; an unclassified fault on the worktrees listing → propagates. Run: the skip branches fail until the per-entry read exists (the step-2 GREEN may already cover some; any that pass on first run are GUARDs — say which).
4. GREEN — per-entry gitdir read and skip rule.
5. RED — "Given an adapter that lists in OS order, When the admins are listed, Then they follow that order" (reversed fake → ["wt2", "wt1"] by id); and "Given an adapter without that capability, Then they follow readdir" (["wt1", "wt2"]). The first fails if step 2 used `ctx.fs.readdir` directly; if step 2 already used the `??` form it is a GUARD (say so).
6. GREEN/REFACTOR — roots.ts: move `isUnopenableFile`, rewire `linkedWorktreeContext`, `worktreeContexts`, `addOtherWorktreeRoots`; prune-worktrees.ts import. Run fsck-worktree-heads.test.ts, fsck-worktree-reflogs-index.test.ts and the three maintenance suites as GUARDs (unchanged order on the memory adapter; same skip set).
7. RED — fsck-worktree-reflogs-index.test.ts: "Given linked worktrees whose HEAD reflogs each name an absent object and an adapter listing in OS order, When fsck runs from the main worktree, Then the reflog findings follow that order" (R1/R2: wt2 before wt1 under the reversed fake). Run against the step-6 tree: passes (GUARD) because `worktreeContexts` now reads OS order — state it; if you did step 7 before step 6 it is the RED for step 6.
8. RED — "Given the current linked worktree's own gitdir file emptied and its HEAD reflog naming an absent object, When fsck runs from that worktree, Then no invalid-reflog-entry is reported" (J): `fsck(deriveWorktreeContext(ctx, 'wt1', '/work/wt1'))` after writing "" to the wt1 gitdir. GUARD on the step-6 tree for the same reason; it is the proof the shortcut moved after the skip rule.

Likely survivors and killers: the `??` fallback (step 5 pair); `raw === ''` (whitespace-only row); each `UNOPENABLE_FILE_CODES` member (one `it` per code in step 3); the `adminDir === ctx.layout.gitDir` shortcut placement (step 8).

### Gate

`npx vitest run test/unit/application/primitives/internal/linked-worktrees.test.ts test/unit/application/commands/fsck-worktree-reflogs-index.test.ts test/unit/application/commands/fsck-worktree-heads.test.ts test/unit/application/commands/maintenance.test.ts test/unit/application/commands/maintenance-worktree-prune.test.ts test/unit/application/commands/maintenance-resolve-undo-roots.test.ts test/unit/application/commands/rev-list.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/linked-worktrees.ts src/application/commands/internal/fsck/roots.ts src/application/commands/internal/prune-worktrees.ts test/unit/application/primitives/internal/linked-worktrees.test.ts test/unit/application/commands/fsck-worktree-reflogs-index.test.ts && npm run check:spelling`

### Commit

`fix(worktree): enumerate linked worktrees in OS order and skip the current one on an empty gitdir, as git does`

## Part 4 — The integrity walk reads each body at the path it walked

### Context

Files:
- `src/application/primitives/ref-store.ts`, inside `createFilesRefStore` (L797):
  - `readLooseContent(name: RefName)` (L835–848) → `readLooseContentAt(path: string)`: same body minus the `looseRefPath(refDir(name), name)` line.
  - `readLooseLeaf(name, path)` (L922–929) and `leafAfterRefusedOpen(name, path, err)` (L931–949): `leafAfterRefusedOpen` calls `readLooseContentAt(path)`; drop the `name` parameter from both if nothing else reads it (verified: `name` is only forwarded to `readLooseContent`). Update the one caller in `resolveDirect` (L1024).
  - `readLooseContentOrRefusal(name)` (L1438–1460) → `readLooseContentOrRefusal(name: RefName, path: string)`: reads `readLooseContentAt(path)`, uses `path` for the `lstat` and both findings (delete the `looseRefPath(refDir(name), name)` line).
  - `looseBodyFindings(name)` (L1468–1480) → `looseBodyFindingsAt(name: RefName, path: string)`.
  - `walkIntegrityEntries` (L1331–1352): call `looseBodyFindingsAt(name, \`${dir}/${entry.name}\`)`.
  - `rootRefFindings` (L1523–1530): call `looseBodyFindingsAt(entry.name as RefName, \`${ctx.layout.gitDir}/${entry.name}\`)` (same path `refDir` gave for a root-ref name; Part 5 replaces this with the store gitdir).
- `test/unit/application/primitives/ref-store.test.ts` — top-level describe "ref-store — the integrity walk of a linked worktree" (L5078) uses a FAKE layout (`gitDir: '/repo/wt'`, `commonDir: base.layout.gitDir`) that Part 5 retires; add the new describe below it using the REAL admin layout so it survives Part 5: base = `await buildSeededContext()` (test/unit/application/primitives/fixtures.ts L256; gitDir "/repo/.git"), write "/repo/.git/worktrees/wt/gitdir" = "/work/wt/.git\n", child `ctx = { ...base, layout: { ...base.layout, gitDir: '/repo/.git/worktrees/wt', commonDir: base.layout.gitDir } }` (the shape test/unit/application/primitives/commondir-refs.test.ts `asWorktreeChild` L21–24 builds).

Behaviour change (observable only from a linked working directory, under today's two roots): a per-worktree name met under the COMMON refs root is read from the common dir (A5 from wt), a shared name met under the OWN root is read from the own gitdir (A16 from wt), and the own garbage is no longer reported twice (A20 from wt). Names stay bare until Part 5.

Rows owned (ref-store level, bare names; Part 5 re-labels them): A5 (wt), A16 (wt), A20 (wt, main + own copies only).

### TDD steps

1. RED — new top-level describe "ref-store — the integrity walk reads each file where it found it" > "Given garbage at the main worktree's refs/bisect/bad and a clean own refs/bisect/bad, When verifyIntegrity runs from the linked worktree" > it "Then the main file's garbage is reported": expect `[{ ref: 'refs/bisect/bad', msgId: 'badRefContent' }]` among the findings. Today: the common-root entry is read by name from the own gitdir (clean) → no finding.
2. RED — same describe: "Given garbage at the own gitdir's refs/heads/stray (a shared name), When verifyIntegrity runs from the linked worktree, Then it is reported" → `{ ref: 'refs/heads/stray', msgId: 'badRefContent' }`. Today: read by name from the common dir (absent) → nothing. And "Given garbage in the main refs/bisect/bad and a valid oid without newline in the own one, Then each file is judged once" → one `badRefContent` and one `refMissingNewline`, both on "refs/bisect/bad". Today both entries are read by name from the own gitdir → two `refMissingNewline`.
3. GREEN — the refactor listed in Context; one function at a time, rerunning after each.
4. REFACTOR — none beyond the signature changes; run the whole ref-store.test.ts, ref-store-symlinked-refs.test.ts, ref-store-file-in-ref-path.test.ts and ref-store-directory-at-ref-path.test.ts as GUARDs (`resolveDirect` keeps the same path; the plain-reader fallback now receives the path it was handed, which equals `looseRefPath(refDir(name), name)` on that route).

Likely survivor: none new; the path-vs-name swap is killed by step 2.

### Gate

`npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/ref-store-symlinked-refs.test.ts test/unit/application/primitives/ref-store-file-in-ref-path.test.ts test/unit/application/primitives/ref-store-directory-at-ref-path.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts test/unit/application/primitives/ref-store.test.ts && npm run check:spelling`

### Commit

`fix(fsck): read each ref the refs walk meets at the path it was found, not by its name`

## Part 5 — Walk every worktree's ref store and name a linked store's refs with its prefix

### Context

Files:
- `src/application/primitives/ref-store.ts` (inside `createFilesRefStore`):
  - Add `interface IntegrityStore { readonly gitDir: string; readonly prefix: string }` (doc: one ref store git's refs verify checks; `gitDir` is the common dir for the main store, the admin dir otherwise; `prefix` "" or "worktrees/<id>/"). ADR-1151 lists a `linked` field; it has no reader (absent roots are silent for both kinds) — omitted pending PC-1.
  - `integrityStores(): Promise<ReadonlyArray<IntegrityStore>>` = `{ gitDir: commonGitDir(ctx), prefix: '' }` followed by `linkedWorktreeAdmins(ctx)` (Part 3) mapped to `{ gitDir: adminDir, prefix: linkedWorktreeRefPrefix(id) }` (Part 1). The current linked worktree is one of these (its admin dir is `ctx.layout.gitDir`); one whose gitdir is empty is skipped (J).
  - `verifyIntegrity` (L1512–1520): one `IntegrityRun` (L656) across stores; for each store, stop when `run.ended`; walk `${store.gitDir}/refs` while `isDirectoryPath` (L1796) is true (Part 6 replaces this gate), then, unless ended, its root refs.
  - `walkIntegrityRoot(root, run)` (L1322) → `walkIntegrityRoot(store, run)`: passes the name prefix `${store.prefix}refs` (today `REFS_DIR`) to `walkIntegrityEntries`, so children are named "worktrees/<id>/refs/…" for a linked store and "refs/…" for the main one; bodies are already read at the walked path (Part 4).
  - `rootRefFindings()` (L1523) → `rootRefFindings(store)`: `readdirInOsOrder(store.gitDir)`, name `${store.prefix}${entry.name}`, read at `${store.gitDir}/${entry.name}`.
  - Delete `refsWalkRoots` (L1115–1119). Keep `gitDirToStrip` (L1382) and `linkReferentFindings` (L1393) untouched: they strip the CWD's gitdir whatever store is walked (requirement 7; A1, B12, B13).
  - Imports: `linkedWorktreeAdmins` from the Part 3 module, `linkedWorktreeRefPrefix` from the per-worktree-ref module.
- `src/application/commands/internal/fsck/refs-verify.ts`:
  - `collectContentNotices` (L233–257): replace `const isRootRef = !finding.ref.startsWith(REFS_PREFIX)` with a test on `bareStoreRefName(finding.ref)` (Part 1), and replace the single `rootCheckEnded` flag with a per-store record keyed on the store prefix (the ref minus its bare name: `finding.ref.slice(0, finding.ref.length - bare.length)`); a store's root check ends at its own first error. Extract a small helper if the function passes 20 lines.
  - Retire the snapshot's HEAD refusal (DC-6): delete `unreadableHeadFinding` (L325–332), `RefSnapshot.unreadable` (L301; `RefSnapshot` keeps `targets`, or `snapshotTargets` returns the targets array), the `unreadable` handling and its `EXIT_REFS_CONTENT` bit in `collectAbsentTargets` (L347–366), and `PresenceCheck.checkContentFormat` (L340) with the matching property at the `runRefsVerifyPass` call site (L401–407) — it has no other reader once the refusal goes. Drop the `UnreadableHead` import (L12).
- `src/application/commands/internal/fsck/roots.ts`: `UnreadableHead` (L890–893), the `unreadable` arm of `HeadRead` (L895–898), `isPermissionRefusalOf` (L903–904) and the `ownFile` lines of `headOf` (L911–913) go; `headOf` keeps `named`/`none` (a refused HEAD is `PERMISSION_DENIED`, which `isSkippedRefReadFault` L119 already skips). `WorktreeHeadSnapshot` (L961–964) keeps `heads` only; `snapshotWorktreeHeads` (L973–982) stops collecting `unreadable`; `worktreeHeads` (L984) unchanged.
- `test/unit/application/primitives/ref-store.test.ts`:
  - Migrate the two FAKE-layout describes to the real admin layout of Part 4: "ref-store — the integrity walk of a linked worktree" (L5078; expectation becomes `['refs/heads/zzz', 'worktrees/wt/refs/bisect/bad']`) and "ref-store — the integrity walk of a linked worktree that ends early" (L5105; refused path becomes "/repo/.git/worktrees/wt/refs", expectation unchanged). Re-label Part 4's describe expectations to the prefixed names.
  - New top-level describe "ref-store — the integrity walk of every worktree's ref store". Main context = `buildSeededContext()`; linked context as Part 4; write admin dirs (HEAD, gitdir, commondir) for "wt" and "vt" as in fsck-worktree-heads.test.ts `repoWithWorktrees`. Symlinks: `ctx.fs.symlink(target, path)`, as test/unit/application/primitives/ref-store-symlinked-refs.test.ts L491–700 does with the memory adapter (realpath works there). OS order: the reversed `readdirInOsOrder` fake of L3058–3064.
- `test/unit/application/commands/fsck-worktree-heads.test.ts`: fixture `repoWithWorktrees` (L36–49), `failHeadRead` (L241–248), `refuseRead` (L297–308), `cannotReadFindings` (L277). Edit "Given a HEAD naming a branch the permissions refuse" (L313–333): the `result.unreadable` assertion (L327) goes, the `heads` assertion stays.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` (old suite) — the names change here, so this part keeps it green:
  - delete `shownRef` (L1197–1199) and `OWN_NAMESPACE` (L1195); the `symlinkRef` line (L1229–1233) uses `finding.ref`.
  - `printedPath` (L1176–1177): absolute when `row.via` is "gitdir" or "linked"; from any other cwd, absolute only for a linked store's ROOT-ref file (its parent directory is "<dir>/.git/worktrees/<id>": `path.dirname(path.dirname(file)) === path.join(dir, '.git', 'worktrees')`), relative to `dir` otherwise (refs walk paths under ".git/worktrees/<id>/refs" print relative from the main cwd: A11, A13, B5, B6, P10).
  - the body lookup (L1254): index `row.root`/`row.refs` with `bareStoreRefName(finding.ref)` (import it from src/domain/refs/per-worktree-ref.ts).

Rows owned (unit level): A1, A2, A3/A4, A5, A6, A16, A18, A19, A20, C4, J (store walk), B2, B5, B12, B13, P1, P2, P3, S10, P9, P4, P5, P6, Q7, P11 (GUARD). Interop rows for all of them land in Parts 13–14.

Public data change (breaking for linked-cwd consumers, ADR-1152): content findings of a linked store carry "worktrees/<id>/"; P2's `ref` changes from "main-worktree/HEAD" to "HEAD". `FsckFinding`'s TYPE is unchanged, so reports/api.json does not move here. The commit marker is decision candidate PC-3.

### TDD steps

1. RED — ref-store.test.ts new describe, "Given garbage in a linked worktree's refs/bisect/bad and refs/heads/stray, When verifyIntegrity runs from the main worktree, Then each is reported under worktrees/wt/" (A2, A16 from w); plus `it.each` over the two contexts (main, linked) for: main garbage at refs/bisect/bad + "wt" and "vt" garbage → three findings "refs/bisect/bad", "worktrees/vt/refs/bisect/bad", "worktrees/wt/refs/bisect/bad" (A20, C4); a linked symlink "worktrees/wt/refs/bisect/bad" → "../../../../refs/heads/main" gives `symlinkRef` and, from the linked cwd only, `badReferentName` with the absolute realpath (A1); a link to "../../HEAD" gives `symlinkRef` only, from both (B13); a link outside the repository gives `badReferentName` with the absolute path (B12); garbage at the linked "refs/worktree/x" and "refs/rewritten/x" (A3/A4); the main "refs/worktree/x" a link to "../heads/main" stays bare from both (A6, GUARD); the linked "refs/bisect/bad" refused for reading → `cannotReadRef` with the prefixed `ref` and the admin path (B5; refuse `openWithNoFollow` + `readUtf8` as fsck-worktree-heads.test.ts `refuseRead` does); an own oid without newline → `refMissingNewline` on the prefixed name (A18); "ref: foo" → `badReferentName` prefixed (A19); the current worktree's gitdir emptied → its store is not walked (J). Today: only the cwd's view is walked and names are bare.
2. GREEN — `IntegrityStore`, `integrityStores`, the store loop in `verifyIntegrity`, `walkIntegrityRoot(store, run)`; migrate the two fake-layout describes. Rerun.
3. RED — "Given garbage root refs in the main gitdir (ORIG_HEAD) and in the wt admin dir (CHERRY_PICK_HEAD, REBASE_HEAD), and an AUTO_MERGE without newline there, When verifyIntegrity runs from either worktree, Then each store's root refs are read from its own gitdir under its own prefix" (P3, S10 at store level: "ORIG_HEAD", "worktrees/wt/AUTO_MERGE" `refMissingNewline`, "worktrees/wt/CHERRY_PICK_HEAD", "worktrees/wt/REBASE_HEAD"); "the wt HEAD as ref: refs/heads/side without newline" → `refMissingNewline` on "worktrees/wt/HEAD" from both (B2); and "Given the main ORIG_HEAD refused for reading, When verifyIntegrity runs from the linked worktree, Then cannotReadRef names ORIG_HEAD at the main path" (P9 wt; refuse with `refuseRead`-style spies on `openWithNoFollow` + `readUtf8`). Today: root refs come from the cwd's gitdir only.
4. GREEN — `rootRefFindings(store)`; delete `refsWalkRoots`.
5. RED — "Given a main link whose realpath dies and garbage in the wt store, Then the walk ends at the link and the wt store is never read" (P4 from w: findings `symlinkRef`, `refsVerifyEnded`, nothing prefixed); "Given main garbage and a wt link that dies, Then the main finding, the wt `symlinkRef` and the end are reported, in that order" (P5); "Given linked stores zz, aa, mm, each with garbage, and the reversed OS-order fake, Then their findings follow the fake's order" (P6, Q7: assert the order equals `readdirInOsOrder('/repo/.git/worktrees')` mapped to ids — derived from the fake, not hard-coded). Run on the step-4 tree: the loop already shares one run and reads `linkedWorktreeAdmins`' order, so these are GUARDs — state that; keep them, they pin the cross-store end and the order.
6. RED — fsck-worktree-heads.test.ts: "Given the main worktree's HEAD file refused for permission, When fsck runs from a linked worktree, Then one cannotReadRef names HEAD at the main path with bit 8" (P2): `fsck(deriveWorktreeContext(ctx, 'wt1', '/work/wt1'))`, `refuseRead(ctx, \`${ctx.layout.gitDir}/HEAD\`)`; expect exactly `[{ type: 'bad-ref', ref: 'HEAD', msgId: 'cannotReadRef', severity: 'error', path, reason: 'PERMISSION_DENIED' }]` from `cannotReadFindings`. Today (steps 1–4 landed): the walk reports "HEAD" and the snapshot reports "main-worktree/HEAD" — two findings. The existing "Given a linked worktree whose HEAD file cannot be read for permission" (L250, P1) fails the same way (two `cannotReadRef`).
7. GREEN — retire the snapshot refusal in refs-verify.ts and roots.ts; edit the L313 test. L250 is GREEN again with its expectation unchanged (now sourced from the walk; `failHeadRead` refuses `readUtf8`, which `readLooseContentAt` uses, and the `lstat` succeeds).
8. RED — fsck-worktree-heads.test.ts: "Given garbage in the main ORIG_HEAD and in the wt admin's CHERRY_PICK_HEAD and REBASE_HEAD, When fsck runs, Then each store's root check stops at its own first error" → `badRefContent` on "ORIG_HEAD" and on whichever of the two wt root refs the store lists first (memory order: "worktrees/wt1/CHERRY_PICK_HEAD"), not the second (P3 fsck level); and "Given garbage in the main ORIG_HEAD and in a wt store's refs/bisect/bad, Then both are reported" (a prefixed refs name is not a root ref). Today: one flag for the whole walk, and `!startsWith('refs/')` judges "worktrees/wt1/refs/bisect/bad" a root ref → the second store's findings are dropped.
9. GREEN — per-store root check on `bareStoreRefName` in `collectContentNotices`.
10. GUARD — fsck-worktree-heads.test.ts: "Given garbage in a linked store and references not checked, When fsck runs, Then no content finding is reported" (P11): passes because `collectContentNotices` skips every integrity finding when `checkContentFormat` is false (L246).
11. REFACTOR — old interop suite edits (Context); run it (Gate). Keep `collectContentNotices` under 20 lines.

Likely survivors and killers: the prefix-key reset in `collectContentNotices` (step 8: two stores' root errors both reported, a second error in one store dropped); `run.ended` between stores (P4 row); store order main-first (A20 order assertion).

### Gate

`npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck-worktree-heads.test.ts test/unit/application/commands/fsck-worktree-reflogs-index.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/commands/fsck-symlinked-ref.test.ts test/unit/application/primitives/ref-store-symlinked-refs.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts src/application/commands/internal/fsck/refs-verify.ts src/application/commands/internal/fsck/roots.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck-worktree-heads.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit

`fix(fsck): check every worktree's ref store from any worktree and name a linked store's refs worktrees/<id>/ as git does`

## Part 6 — A store root that is not a directory, and a store gitdir whose root refs cannot be listed

### Context

Files:
- `src/application/primitives/ref-store.ts`:
  - `RefIntegrityFinding` (L247–280): the `refsWalkFailed` arm (L275) gains `readonly reason: 'PERMISSION_DENIED' | 'NOT_A_DIRECTORY'`; add `{ readonly msgId: 'rootRefsUnreadable'; readonly path: string }`.
  - `walkIntegrityRoot(store, run)`: classify `${store.gitDir}/refs` by `ctx.fs.lstat` — FILE_NOT_FOUND → absent (nothing, both store kinds: A10 and the main store as today); `isSymbolicLink || !isDirectory` → push `{ msgId: 'refsWalkFailed', path, reason: 'NOT_A_DIRECTORY' }`, no `unreadableRefPath` (B6, P10, S9); a directory → today's listing, whose refusal now pushes `reason: 'PERMISSION_DENIED'` (A11). Any other `lstat` fault propagates. A `RootKind` union ('directory' | 'absent' | 'not-a-directory') keeps it readable. The `isDirectoryPath` gate in `verifyIntegrity` goes.
  - `rootRefFindings(store, …)`: a PERMISSION_DENIED from `readdirInOsOrder(store.gitDir)` pushes `{ msgId: 'rootRefsUnreadable', path: store.gitDir }` and returns; any other fault propagates (existing test "When that listing faults for another reason than permission", L3105–3123, stays green).
- `src/application/commands/internal/fsck/refs-verify.ts`: `refsWalkFailedFinding` (L113–119) copies `reason`; add `type UnreadableRootRefsFinding = FsckFinding & { readonly type: 'unreadable-root-refs' }` and add it to `RefFinding` (L20–27) and to the `findings` array type of `collectContentNotices`; `walkNoticeOf` (L211–220) maps `rootRefsUnreadable` to `{ type: 'unreadable-root-refs', path, reason: 'PERMISSION_DENIED' }`; `failsRefsVerify` (L222–223) counts it. All of it already sits behind `checkContentFormat` (P11).
- `src/application/commands/internal/fsck/types.ts`: the `refs-walk-failed` arm (L74–81) widens `reason` to `'PERMISSION_DENIED' | 'NOT_A_DIRECTORY'` (doc comment: NOT_A_DIRECTORY is git's `cannot open directory <p>: Not a directory`, no warning beside it); add the arm `{ readonly type: 'unreadable-root-refs'; readonly path: string; readonly reason: 'PERMISSION_DENIED' }` after it, doc comment: a store gitdir git cannot list for its root refs, no line printed, exit bit 8, gated by `checkReferences`.
- `reports/api.json` — `FsckFinding` is public (exported from src/application/commands/index.ts L143 through fsck.ts L80; src/application/commands/index.ts is a typedoc entry). Regenerate with `npm run docs:json` and commit the result (a large typedoc-id diff is normal). This is the prepush gate `check:doc-typedoc`; validate does not catch it.
- `test/unit/application/primitives/ref-store.test.ts`: existing "Given the refs root whose listing is refused" (L3012–3031) expectation gains `reason: 'PERMISSION_DENIED'`; same for any other `refsWalkFailed` expectation (search the file for `refsWalkFailed`). New describes go in Part 5's top-level describe.
- `test/unit/application/commands/fsck-worktree-heads.test.ts` — fsck-level rows.

Surface gates checked: no exhaustiveness switch over `FsckFinding['type']` exists in src (verified: the only readers of "refs-walk-failed" are refs-verify.ts and types.ts); `FsckFinding` is already barrel-exported; the user doc rows (docs/use/commands/fsck.md L41, L180) are not a gate and land in Part 16; api.json is pre-paid here.

Rows owned (unit level): A10, A11, B6 (w), P10, S9, H, F.

### TDD steps

1. RED — ref-store.test.ts: "Given a linked store whose refs is a regular file, When verifyIntegrity runs, Then the walk fails on it as not a directory" → `{ msgId: 'refsWalkFailed', path: '/repo/.git/worktrees/vt/refs', reason: 'NOT_A_DIRECTORY' }` and no `unreadableRefPath` (B6). Fails: `isDirectoryPath` is false → silent. Separate `it`: "whose refs is a symbolic link to a directory holding garbage" → the same finding and no `badRefContent` (P10; today `isDirectoryPath` follows the link and walks it); "Given the main refs a symbolic link" → the finding on "/repo/.git/refs" (S9); "Given a linked store with no refs" → nothing (A10, GUARD: absent today too).
2. GREEN — root classification by `lstat`; the PERMISSION_DENIED arm carries `reason`; update the L3028 expectation. Add one `it` for an `lstat` fault other than FILE_NOT_FOUND on the root → propagates.
3. RED — "Given a linked store gitdir whose listing is refused, When verifyIntegrity runs, Then rootRefsUnreadable names that gitdir" (H): refuse `readdir` for "/repo/.git/worktrees/wt" with the file's `refuseListing` helper (L33) — note `rootRefFindings` reads through `readdirInOsOrder ?? readdir`, and the memory adapter has no `readdirInOsOrder`. Fails: the refusal propagates today.
4. GREEN — `rootRefsUnreadable`.
5. RED — fsck-worktree-heads.test.ts: "Given a linked worktree whose refs is a regular file, When fsck runs, Then refs-walk-failed carries NOT_A_DIRECTORY with bit 8" → `{ type: 'refs-walk-failed', path, reason: 'NOT_A_DIRECTORY' }`. Fails: `refsWalkFailedFinding` hard-codes PERMISSION_DENIED (and `tsc` rejects copying the wider reason until types.ts widens — widen in the GREEN).
6. GREEN — types.ts widening; `refsWalkFailedFinding` copies `reason`.
7. RED — "Given a linked worktree whose admin dir lists nothing (listing refused) and nothing else wrong, When fsck runs, Then unreadable-root-refs is reported with bit 8 and no other ref finding" (H); and "… with checkReferences false, Then nothing and exit 0". Fails: `walkNoticeOf` drops the unknown msgId; exit 0.
8. GREEN — the new arm in types.ts, refs-verify.ts mapping and `failsRefsVerify`. Then `npm run docs:json` and stage reports/api.json.
9. GUARD — "Given a linked admin dir whose listing is refused and garbage in its refs/bisect/bad, Then the badRefContent is still reported" (F): passes because the refs root is classified and listed independently of the gitdir listing.

Likely survivors and killers: `isSymbolicLink ||` (P10 row alone) and `!isDirectory` (B6 row alone) — separate `it`s; FILE_NOT_FOUND → absent (A10 row; and the `lstat`-fault row kills widening it to every code); PERMISSION_DENIED → `rootRefsUnreadable` only (the existing other-fault propagation test).

### Gate

`npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck-worktree-heads.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts src/application/commands/internal/fsck/refs-verify.ts src/application/commands/internal/fsck/types.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck-worktree-heads.test.ts && npm run check:spelling && npm run check:doc-typedoc`

### Commit

`fix(fsck): report a refs root that is not a directory and a worktree gitdir whose root refs cannot be listed, as git does`

## Part 7 — badRefName and badHeadTarget facts from the store walk

### Context

Files:
- `src/application/primitives/ref-store.ts`:
  - `RefIntegrityFinding` (L247): add `{ readonly ref: RefName; readonly msgId: 'badRefName' }` and widen the referent arm's msgId to `'badReferentName' | 'symrefTargetIsNotARef' | 'badHeadTarget'`.
  - `walkIntegrityEntries` (L1331): for every NON-directory entry (regular file or symbolic link) still walked, push `{ ref: name, msgId: 'badRefName' }` when `!isSafeRefName(name)` (the PREFIXED name, as git's `check_refname_format` runs on it), BEFORE the `symlinkRef`/body facts (git's `files_fsck_ref` runs the name check, then the content check). Root refs are exempt structurally: they come from `rootRefFindings`, which never adds it. `isSafeRefName` is already imported (L30–39 refs barrel import).
  - `looseBodyFindingsAt` symbolic branch (today L1474–1476): `[...symbolicBodyNotices(name, body), ...headTargetFindings(name, body.referent), ...referentFindings(name, body.referent)]`, where the new helper returns `[{ ref, msgId: 'badHeadTarget', referent }]` when `bareStoreRefName(ref) === 'HEAD'` and `!isBranchReferent(referent)` (Parts 1, 2), else `[]`. A direct (detached) HEAD gets none.
- `test/unit/application/primitives/ref-store.test.ts` — describes under Part 5's top-level describe.

Nothing downstream changes yet: `CONTENT_MSG_IDS` in refs-verify.ts (L135) does not hold the two msgIds, so fsck drops them until Part 9 (verified: `isContentFinding` filters on that set and `walkNoticeOf` ignores unknown msgIds).

Rows owned (unit level): Q9 (both content facts), A24, B1, B3, C1.

### TDD steps

1. RED — "Given a main ref refs/heads/a..b holding a valid oid, When verifyIntegrity runs, Then badRefName is reported on it" (B1) → `{ ref: 'refs/heads/a..b', msgId: 'badRefName' }`; plus "a linked store's refs/bisect/a..b" → on "worktrees/wt/refs/bisect/a..b" (A24); plus "a linked store's refs/bisect/.x.lock holding garbage" → `badRefName` then `badRefContent`, in that order (Q9); plus "a link named refs/heads/a..b" → `badRefName` before `symlinkRef`. Fails: no such fact.
2. GREEN — the name check in `walkIntegrityEntries`.
3. RED — "Given the main HEAD as ref: refs/tags/x, When verifyIntegrity runs, Then badHeadTarget names that referent" (C1) → `{ ref: 'HEAD', msgId: 'badHeadTarget', referent: 'refs/tags/x' }` ahead of any referent fact; "the wt HEAD as ref: refs/tags/x" → on "worktrees/wt/HEAD" (B3); "a HEAD as ref: refs/heads/main" → none; "a detached HEAD" → none; "a refs/heads/x as ref: refs/tags/y" → none (not a HEAD). Fails: no such fact.
4. GREEN — `headTargetFindings`.

Likely survivors and killers: `bareStoreRefName(ref) === 'HEAD'` mutated to `ref === 'HEAD'` (B3 linked row); the negation of `isBranchReferent` (the refs/heads/main row); the order of `badRefName` before the body (Q9 order assertion).

### Gate

`npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/commands/fsck-worktree-heads.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts test/unit/application/primitives/ref-store.test.ts && npm run check:spelling`

### Commit

`feat(fsck): record git's badRefName and badHeadTarget facts in the ref store walk`

## Part 8 — Skip lock and dot-led names in the walk and the listing; a linked refs that is a file lists nothing

### Context

Files:
- `src/application/primitives/ref-store.ts`:
  - `walkIntegrityEntries` (L1331): skip a non-directory entry when `isSkippedByRefsVerify(entry.name)` (Part 2), before any fact for it (B7: "bad.lock" skipped; Q9: ".x.lock" still walked).
  - `walkRefDir(dir, prefix)` (L1065–1077): skip any entry, directory or not, when `isSkippedByLooseIterator(entry.name)` (C2, Q8, Q9). Its other caller `smallestLooseRefIn` (L1906–1909) already filters with `isSafeRefName`, which rejects every component that starts with "." or ends with ".lock" (verified in src/domain/refs/ref-validation.ts `validateRefName`), so that write route's result is unchanged.
  - `walkTarget` (L1209–1220): in the catch, return `[]` when `target.ownNamespace` and the code is PERMISSION_DENIED OR NOT_A_DIRECTORY (B6 from vt: a linked "refs" that is a file makes `walkRefsRoot`'s `stat` of "<own>/refs/bisect" throw NOT_A_DIRECTORY).
- `test/unit/application/primitives/ref-store.test.ts` — listing describes after "ref-store — loose refs listed from a linked worktree" (L4864); walk describes under Part 5's top-level describe.
- `test/unit/application/primitives/ref-store-file-in-ref-path.test.ts` — inside `describe.each(ADAPTERS)` (L62–63; memory and node adapters, `seedRepository` L46): add "Given a linked worktree whose refs is a regular file". The node build makes a real temp repo; write the admin dir (HEAD, gitdir, commondir) and a FILE at "<admin>/refs".

Rows owned (unit level): B7, C2/Q8 (listing and walk), Q9 (listing), B6 (vt listing).

### TDD steps

1. RED — ref-store.test.ts: "Given a linked store holding refs/bisect/bad.lock with garbage, When verifyIntegrity runs, Then nothing is reported for it" (B7); and "a main refs/heads/x.lock with garbage" → nothing (C2). Fails: today `badRefContent` (and an integrity `badRefOid` for an oid body).
2. GREEN — `isSkippedByRefsVerify` in `walkIntegrityEntries`. Keep the Q9 row of Part 7 green (dot-led lock still walked).
3. RED — "Given main refs/heads/x.lock (garbage) and refs/heads/y.lock (a valid oid), When listRefNames and listRefs run, Then neither is listed" (Q8); "Given a linked worktree's refs/bisect/.x.lock, When listRefNames runs from it, Then it is not listed" (Q9); "Given a directory refs/heads/.hidden holding a ref, Then nothing under it is listed". Fails: `walkRefDir` lists every entry.
4. GREEN — `isSkippedByLooseIterator` in `walkRefDir`.
5. RED — ref-store-file-in-ref-path.test.ts: "Given a linked worktree whose refs is a regular file, When listRefNames runs from that worktree, Then it lists the shared refs and nothing of its own namespace, without throwing" (B6 vt). Fails: NOT_A_DIRECTORY propagates from `walkTarget`.
6. GREEN — `walkTarget` catch widened for `ownNamespace` only.
7. GUARD — ref-store.test.ts: "Given refs/heads/x a regular file, When listRefNames runs with the prefix refs/heads/x/y/ from the main worktree, Then the NOT_A_DIRECTORY of the shared target propagates" — characterization of today's shared behaviour (`ancestorsReadable` reads "<common>/refs/heads/x", the memory adapter throws NOT_A_DIRECTORY for a `readdir` of a file, and the shared target rethrows). Run it before step 6 too: it must pass on both trees. It is the killer of the `target.ownNamespace &&` conjunct; if it does not throw on the step-4 tree, stop and report (`{ unit, reason, options }`) rather than pinning a different shape.
8. GUARD — run test/unit/application/commands/fsck-broken-ref-chain.test.ts and the old interop suite: no existing row lists a lock or dot-led name (state it if one changes).

Likely survivors and killers: the `ownNamespace` conjunct (step 7); `isSkippedByLooseIterator` applied before the kind check (the ".hidden" directory row); `isSkippedByRefsVerify` applied to directories (a directory named "d.lock" holding a ref must still be walked: add that `it` in step 1).

### Gate

`npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/ref-store-file-in-ref-path.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/ref-store-file-in-ref-path.test.ts && npm run check:spelling`

### Commit

`fix(refs): skip lock and dot-led names as git's ref iterators do, and list nothing under a linked refs that is a file`

## Part 9 — fsck grades badRefName and badHeadTarget, points broken names at zero, and survives a garbage HEAD

### Context

Files:
- `src/application/commands/internal/fsck/refs-verify.ts`:
  - `ContentFinding` (L69–80) and `CONTENT_MSG_IDS` (L135–142) gain `badRefName` and `badHeadTarget`.
  - `ContentGrades` (L83–89) / `gradesOf` (L91–97): `badRefName: retypeSeverity(severities, 'badRefName', 'error')`, `badHeadTarget: retypeSeverity(severities, 'badHeadTarget', 'error')` (both msgIds are in src/domain/fsck/msg-ids.ts L90, L99).
  - `ownGrade` (L167–175) and `contentFinding` (L177–197): `badRefName` → `{ type: 'bad-ref', ref, msgId: 'badRefName', severity }`; `badHeadTarget` → with `referent` (the existing final destructuring arm can carry it once the union includes it).
  - Shadowing (`contentSeverity` L153–165, `refsWithInvalidReferent` L199–206): when `grades.badHeadTarget === 'error'`, a ref carrying `badHeadTarget` drops its `badReferentName` and `symrefTargetIsNotARef` (git's `refs_fsck_symref` returns early). Keep the ADR-1124 rule (an error `badReferentName` drops `symrefTargetIsNotARef`). Build both sets once per call.
  - `snapshotTargets` (L305): a listed name failing `isSafeRefName` (import from src/domain/refs/ref-validation.ts) gets `zeroOid(ctx.hashConfig)` whatever its entry holds (B1, A24 from wt).
- `src/application/commands/internal/fsck/roots.ts`: `headOf` (L907) returns `NO_HEAD` when `errorDataCode(err) === 'INVALID_OBJECT_ID'` as well as on `isSkippedRefReadFault` (A7 from w, A8 from wt). Name the code as a constant. Do not widen `isSkippedRefReadFault` (L119): gc and other callers use it.
- `test/unit/application/commands/fsck-configured-severity.test.ts` — helpers `sut = fsck` (L17), `initRepo` (L29), `configure(ctx, body)` (L36), `badRefs(findings, msgId)`; shape of "Given a ref whose content is not an object name, softened to warn" (L344–375).
- `test/unit/application/commands/fsck-broken-ref-chain.test.ts` — anchor after "Given a ref holding garbage alone" (L80).
- `test/unit/application/commands/fsck-worktree-heads.test.ts` — `repoWithWorktrees` (L36).

Rows owned (unit level): B1, A24 (wt pointer), Q9 (fsck: two findings, no pointer once Part 8 unlisted it), B3, C1, P12 (and its badRefName/badHeadTarget analogues), A7 (w), A8 (wt).

### TDD steps

1. RED — fsck-broken-ref-chain.test.ts, describe "Given a branch named refs/heads/a..b holding a valid oid" > "When fsck runs": two `it`s, both run before any code — "Then badRefName errors with bit 8" (fails: the fact is dropped by `isContentFinding`) and "Then the name points at the zero oid, exit 10" (fails: `targetOf` resolves the valid oid) (B1).
2. GREEN — `badRefName` through the content pass (sets, grades, `contentFinding`). The first `it` passes; the pointer `it` stays red.
3. GREEN — the `isSafeRefName` check in `snapshotTargets`; the pointer `it` passes. Add "Given a linked store's refs/bisect/a..b, When fsck runs from that worktree, Then the zero pointer names refs/bisect/a..b bare" (A24 wt; GUARD on this tree).
4. RED — "Given HEAD as ref: refs/tags/x, When fsck runs, Then badHeadTarget errors with bit 8 and no symrefTargetIsNotARef or badReferentName is reported for HEAD" (C1); "Given a linked worktree's HEAD as ref: refs/tags/x, When fsck runs from the main worktree" (B3) → on "worktrees/wt1/HEAD"; "Given HEAD as ref: tags (a one-component referent), Then only badHeadTarget" (shadows `badReferentName`). Fails: dropped.
5. GREEN — `badHeadTarget` grade and its shadow.
6. RED — fsck-configured-severity.test.ts: "Given badRefName softened to warn" → warning, exit 2 (pointer only); "Given badHeadTarget softened to warn" → warning, and the referent facts are NOT shadowed (shadow only at error); "Given badHeadTarget silenced" → nothing. Fails until the grades route through `retypeSeverity` — if step 2/5 already wired them, these are GUARDs (say so) and remain the killers of the grade defaults and the error-only shadow.
7. RED — fsck-worktree-heads.test.ts: "Given a linked worktree whose HEAD holds garbage, When fsck runs from the main worktree, Then badRefContent names worktrees/wt1/HEAD and no pointer is reported for it" (A7); "Given the main HEAD holding garbage, When fsck runs from a linked worktree, Then badRefContent names HEAD" (A8). Fails: `headOf` rethrows INVALID_OBJECT_ID → fsck rejects. Assert the thrown code first (try/catch + `.data`) to confirm the RED reason.
8. GREEN — `headOf` INVALID_OBJECT_ID → `NO_HEAD`. GUARD: the existing "Given a linked worktree whose HEAD read fails with an unclassified fault" (L335) still rejects (kills widening the catch).

Likely survivors and killers: the shadow guard `grades.badHeadTarget === 'error'` (step 6 warn row); default grades 'error' (step 1/4 exit-bit assertions); `isSafeRefName` in `snapshotTargets` (B1 pointer); the INVALID_OBJECT_ID literal (A7 row).

### Gate

`npx vitest run test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/commands/fsck-configured-severity.test.ts test/unit/application/commands/fsck-worktree-heads.test.ts test/unit/application/commands/fsck-symlinked-ref.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/fsck/refs-verify.ts src/application/commands/internal/fsck/roots.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/commands/fsck-configured-severity.test.ts test/unit/application/commands/fsck-worktree-heads.test.ts && npm run check:spelling`

### Commit

`fix(fsck): report badRefName and badHeadTarget, point a broken ref name at zero, and survive another worktree's garbage HEAD, as git does`

## Part 10 — RefStore gains the write-route reader resolveDirectForWrite

### Context

Files:
- `src/application/primitives/ref-store.ts`:
  - `RefStore` interface (L93; `resolveDirect` L100): add `resolveDirectForWrite(name: RefName): Promise<ResolveDirectResult>` with a doc comment stating the rule: every reader on a write route (compare-and-swap, presence, the write chain) reads through it, so it sees the loose file at the path the write will touch; a new write route must use it, never `resolveDirect`.
  - In `createFilesRefStore`: add `interface LooseLocation { readonly dir: string; readonly path: string }` and `writeLocation(name)` = `{ dir: refDir(name), path: looseRefPath(refDir(name), name) }`; today's `resolveDirect` body (L1018–1037) becomes `resolveDirectAt(name, location)` (the `HEAD` → `resolveHeadDirect()` check stays first inside it); `resolveDirect(name)` and `resolveDirectForWrite(name)` both = `resolveDirectAt(name, writeLocation(name))` here (Part 12 moves `resolveDirect` to the read locator). Return both from the store object (L2436–2441).
  - `checkExpected` (L1533–1541) and `refIsPresent` (L2132–2134) call `resolveDirectForWrite`. `stillHoldsPackedValue` (L2377) stays on `resolveDirect` (names come from the loose walk under refs/, never mapped).
  - `withPseudoRefFiles` (L694–697): add `resolveDirectForWrite: (name) => (isPseudoRef(name) ? files : backend).resolveDirectForWrite(name)`.
- `src/application/primitives/reftable-ref-store.ts`: the returned store (L398–399) adds `resolveDirectForWrite: resolveDirect`.
- `test/unit/application/primitives/ref-store.test.ts` — reftable fixtures already imported: `withReftableStorage`, `writeReftableFiles`, `commonReftableDir` (test/unit/application/primitives/reftable-fixtures.ts) and `buildSingleRefTable` (L42). Anchor after "Given packed-refs is absent" (L1658).

`RefStore` is internal: no `RefStore`, `resolveDirect` or `resolveDirectChain` symbol in reports/api.json (verified) and src/application/primitives/index.ts exports only `resolveRef` from resolve-ref; no surface gate.

### TDD steps

1. RED — "Given a loose ref, a packed-only ref and a missing name, When resolveDirectForWrite reads each, Then it answers what resolveDirect answers" (`it.each`). Fails: `sut.resolveDirectForWrite is not a function` (TypeError; assert the values, not the error).
2. GREEN — `LooseLocation`, `writeLocation`, `resolveDirectAt`, the two methods; route `checkExpected` and `refIsPresent`.
3. RED — "Given a reftable repository with MERGE_HEAD as a file and a branch in the stack, When resolveDirectForWrite reads each, Then MERGE_HEAD comes from the file and the branch from the stack". Fails with a TypeError: `withPseudoRefFiles` spreads the reftable store, which has no `resolveDirectForWrite` yet.
4. GREEN — reftable alias and `withPseudoRefFiles` routing.
5. GUARD — the whole of ref-store.test.ts, ref-store-transaction-prepare.test.ts, ref-store-transaction-names.test.ts, update-ref.test.ts and commondir-writes.test.ts: `checkExpected`/`refIsPresent` read the same path as before (both locators are the write one until Part 12).

Likely survivor: none; the routing is pinned by Part 12's characterization rows once the locators differ.

### Gate

`npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/reftable-ref-store.test.ts test/unit/application/primitives/ref-store-transaction-prepare.test.ts test/unit/application/primitives/ref-store-transaction-names.test.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/commondir-writes.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts src/application/primitives/reftable-ref-store.ts test/unit/application/primitives/ref-store.test.ts && npm run check:spelling`

### Commit

`refactor(refs): give write routes their own ref reader, resolveDirectForWrite`

## Part 11 — The write chain reads through the write view

### Context

Files:
- `src/application/primitives/internal/ref-write-chain.ts`: `walkSymbolicChain` (L42; read at L49) and `resolveWithoutDeref` (L101; read at L106) call `store.resolveDirectForWrite`; `readReferentValue` (L82; chain call L88) passes `{ resolveDirect: store.resolveDirectForWrite }` to `resolveDirectChain`.
- `src/application/primitives/resolve-ref.ts`: `resolveDirectChain(refStore: RefStore, …)` (L205–206) narrows to `refStore: Pick<RefStore, 'resolveDirect'>` (it only calls `resolveDirect`, L230). Its other callers (L48, L182) pass a full store and still type-check.
- `test/unit/application/primitives/internal/ref-write-chain.test.ts` — top describe "resolveWriteChain" (L27); helpers `ref`, `setDirect`, `WRITE_OPTS`, `NO_DEREF_OPTS`, `noDerefWithExpected`, `seedBrokenReferent`. Two existing tests read the old method and must follow it: "When the referent read fails for an I/O reason" (L443–470: its `failingStore` overrides `resolveDirect` → override `resolveDirectForWrite`) and "Given a symbolic ref whose link target is not a valid ref name" (L473–492: `vi.spyOn(store, 'resolveDirect')` → spy `resolveDirectForWrite`).
- `test/unit/application/primitives/update-ref.test.ts` — "Given HEAD symbolically names the branch" > "When updateRef writes HEAD itself" (L971–993) wraps `store.resolveDirect` to record reads and expects `[HEAD, MAIN]`: wrap BOTH `resolveDirect` and `resolveDirectForWrite` into the same `reads` list (the chain now reads through the latter; `resolveHeadForCoupling`, update-ref.ts L253–260, stays on the former).

### TDD steps

1. RED — ref-write-chain.test.ts new describe "Given a store whose read view and write view answer differently" (fake: `{ ...getRefStore(ctx), resolveDirect: async () => { throw new Error('read view') } }`, the real `resolveDirectForWrite` kept): "When resolveWriteChain dereferences a symbolic ref, Then it reads only the write view" (`walkSymbolicChain`); "When resolveWriteChain runs with noDeref on a direct ref" (`resolveWithoutDeref`); "When resolveWriteChain runs with noDeref on a symbolic ref, Then the referent is read through the write view" (`readReferentValue`). Each asserts the chain fields (`terminal`, `old`, …). Fails: the chain calls `resolveDirect` → "read view" error.
2. GREEN — the three call sites and the `Pick` narrowing. The two existing ref-write-chain tests and the update-ref test turn red here (they watch `resolveDirect`): migrate them as described — that is the same GREEN, not a broken step.
3. GUARD — resolve-ref.test.ts, update-ref.test.ts and symbolic-ref / branch suites that write through the chain (`./node_modules/.bin/vitest run test/unit/application/primitives` is cheap enough to run whole once).

Likely survivors and killers: each of the three call sites reverting to `resolveDirect` — one `it` each in step 1.

### Gate

`npx vitest run test/unit/application/primitives/internal/ref-write-chain.test.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/resolve-ref.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/ref-write-chain.ts src/application/primitives/resolve-ref.ts test/unit/application/primitives/internal/ref-write-chain.test.ts test/unit/application/primitives/update-ref.test.ts && npm run check:spelling`

### Commit

`refactor(refs): read the write chain through the write view of the ref store`

## Part 12 — Resolve main-worktree/<per-worktree ref> on the read side

### Context

Files:
- `src/application/primitives/ref-store.ts` (inside `createFilesRefStore`): add `readLocation(name)` = `writeLocation(name)` when `mainWorktreeBareName(name)` (Part 1) is `undefined`, else `{ dir: commonGitDir(ctx), path: looseRefPath(commonGitDir(ctx), bare) }`; `resolveDirect(name)` = `resolveDirectAt(name, readLocation(name))`. `resolveDirectForWrite` keeps `writeLocation`. The packed fallback keeps the FULL name (`resolveAfterLooseMiss(name, location.dir, location.path)`, L1005), as git's `read_ref_internal` does (B15). No "worktrees/<id>/" branch: today's location already is git's path for it (A26, A27; the design's "No worktrees/<id>/ branch"). `readLocation`'s `dir` equals `writeLocation`'s for every mapped name — a "main-worktree/…" name is not per-worktree, so `refDir` gives the common dir — so no mutant on `dir` can change behaviour; say so in the doc comment rather than testing it. Keep `refDir`/`perWorktreeRefDir` and every write path builder unchanged (requirement 13), `resolveHeadDirect` for `HEAD`.
- `test/unit/application/primitives/commondir-refs.test.ts` — `adminDir` (L18), `asWorktreeChild` (L21–24), `buildSeededContext`; top describe "common-dir ref + reflog split" (L26).
- `test/unit/application/primitives/resolve-ref.test.ts` — describes "resolveRef" (L33) and "readRefCandidate" (L879).
- `test/unit/application/primitives/ref-store-transaction-prepare.test.ts` — top describe "createRefStore().applyRefUpdates" (L58).
- `test/unit/application/commands/rev-parse-list.test.ts` — imports `revParse` and the memory adapter already (L1–7); `revParse(ctx, expression)` returns `RevParseEntry[]` (`{ kind: 'object', id, negated }`).
- `test/unit/application/commands/fsck-broken-ref-chain.test.ts` — anchor after "Given a symbolic ref whose target does not exist" (L137).

Rows owned (unit level): C3, B14, B15, A25, B8, A26/A27 (GUARD), W14 unchanged (characterization).

### TDD steps

1. RED — commondir-refs.test.ts: "Given a detached main HEAD, When resolveDirect reads main-worktree/HEAD from the child Context and from the main one, Then it answers the main HEAD" (`{ kind: 'direct', id }`); "Given a loose main refs/bisect/bad, When the child resolves main-worktree/refs/bisect/bad, Then it is found". Fails: looked up at "<common>/main-worktree/…" → `{ kind: 'missing' }`.
2. GREEN — `readLocation`; `resolveDirect` on it.
3. GUARD — commondir-refs.test.ts, both Contexts: "main-worktree/refs/heads/main" missing although "refs/heads/main" exists; "worktrees/wt/HEAD" and "worktrees/wt/refs/bisect/bad" found at "<common>/worktrees/wt/…"; "worktrees/wt/refs/heads/side" and "worktrees/nope/HEAD" missing; B15's pair: packed-refs holding "refs/bisect/packed" and "main-worktree/refs/bisect/fullname" → "main-worktree/refs/bisect/packed" missing, "main-worktree/refs/bisect/fullname" found; "main-worktree/ORIG_HEAD" absent → missing. Pass on the step-2 tree by construction (unmapped names keep `writeLocation`; the packed probe uses the full name) — they are the killers of the mapping branch and the full-name fallback.
4. RED — resolve-ref.test.ts "resolveRef": "Given refs/heads/x = ref: main-worktree/HEAD and HEAD on main, When resolveRef reads x from the child, Then it resolves through the main HEAD to main's oid"; "readRefCandidate": "main-worktree/HEAD found from both Contexts". If step 2 already makes them pass (it should: both go through `resolveDirectChain` → `resolveDirect`), they are GUARDs — say so.
5. RED/GUARD — rev-parse-list.test.ts: "Given a linked worktree, When revParse reads main-worktree/HEAD, worktrees/wt/HEAD and worktrees/wt/refs/bisect/bad, Then each is the object git resolves" and "main-worktree/refs/heads/main, worktrees/wt/refs/heads/side, worktrees/nope/HEAD throw OBJECT_NOT_FOUND" (try/catch, `.data.code`), from both Contexts (C3, B14). GUARD after step 2 (it goes through `readRefCandidate`).
6. RED/GUARD — fsck-broken-ref-chain.test.ts: "Given refs/heads/x = ref: main-worktree/HEAD, When fsck runs, Then only symrefTargetIsNotARef is reported and exit 0" (A25); same for "ref: main-worktree/refs/bisect/bad" with that file present (B8). GUARD after step 2 (`targetOf` → `resolveRef`).
7. GUARD (characterization of the write side) — ref-store-transaction-prepare.test.ts, from the main Context with a DETACHED main HEAD holding X: "When applyRefUpdates sets main-worktree/HEAD expecting X, Then it refuses REF_UPDATE_CONFLICT with actual absent" (`checkExpected` reads `writeLocation`: "<common>/main-worktree/HEAD"), asserted on `.data` `{ code: 'REF_UPDATE_CONFLICT', name, expected: X, actual: 'absent' }`; "When applyRefUpdates sets main-worktree/HEAD/x, Then it writes" (`refIsPresent` on the prefix "main-worktree/HEAD" reads `writeLocation` and finds nothing to conflict with). Write both BEFORE step 2 and run them on the Part 11 tree. The first is verified by reading `checkExpected` (a non-direct or missing value reads as "absent", and "<common>/main-worktree/HEAD" does not exist). The second is the expected characterization; if it does not pass on the Part 11 tree, pin the outcome that tree actually gives (that is today's write side) and say so in the final report. Both must pass unchanged after step 2 — the proof the write side did not move (W14).

Likely survivors and killers: the `mainWorktreeBareName(name) === undefined` branch (step 1 vs the step-3 refusals); routing `checkExpected`/`refIsPresent` back to `resolveDirect` (step 7 rows turn red then).

### Gate

`npx vitest run test/unit/application/primitives/commondir-refs.test.ts test/unit/application/primitives/resolve-ref.test.ts test/unit/application/primitives/ref-store-transaction-prepare.test.ts test/unit/application/commands/rev-parse-list.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/primitives/ref-store.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts test/unit/application/primitives/commondir-refs.test.ts test/unit/application/primitives/resolve-ref.test.ts test/unit/application/primitives/ref-store-transaction-prepare.test.ts test/unit/application/commands/rev-parse-list.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts && npm run check:spelling`

### Commit

`fix(refs): resolve main-worktree/<per-worktree ref> to the main worktree's ref on reads, as git does`

## Part 13 — Interop suite: seeder, line rebuild, and the content and naming rows

### Context

Files:
- `test/integration/fsck-worktree-private-refs-interop.test.ts` — NEW. Every behaviour it pins has landed (Parts 1–12); the suite is a harness, so a RED here is a real tsgit/git divergence: report it with the blocker protocol, never adjust the expectation to tsgit.

Structure (reuse, do not copy, what fits):
- Helpers from test/integration/interop-helpers.ts: `GIT_AVAILABLE`, `runGit`, `tryRunGitWithExit` (both spawn with a scrubbed `GIT_*` environment and isolated HOME; pass `-c commit.gpgsign=false -c gc.auto=0` on every git call). `describe.skipIf(!GIT_AVAILABLE)`.
- Lifetime: at top level `const open = trackedRepositories()` and `const context = trackedContexts(createNodeContext)` from test/integration/repository-lifecycle.ts (L48, L88). Every `openRepository`/`createNodeContext` goes through them from the first draft.
- Cleanup: `afterEach` restores modes then removes roots, as the old suite does (its L1035–1042: `refusedPaths` chmod back to 0o755 first, then `rm -rf`), plus `__resetConfigCacheForTests()` from src/application/primitives/config-read.ts.
- Seeder `seed(shape)`: `realpath(mkdtemp(...))` root; `git init -q -b main <root>/w`, one commit (`commit-tree` of the empty tree + `update-ref`, as the old suite's `commitOf` L1046–1049, and point main at it); `git -C w worktree add -q wt -b side` and further linked worktrees in the shape's creation order (`worktrees: ['zz', 'aa', 'mm']`); hand-made admin dirs (`handMade: { vt: { gitdir?: string | '', refsFile?: true, workDir?: true } }` writing HEAD, gitdir, commondir, and for a `workDir` a "<w>/vt/.git" file "gitdir: <admin>"); `files`, `links`, `restricted` keyed by GITDIR-relative path ("refs/bisect/bad", "ORIG_HEAD", "worktrees/wt/refs/bisect/bad", "worktrees/wt/HEAD"), so a finding's `ref` IS its seeded key; `packed` lines; `config`; `cwd: 'w' | <id>`; `flags`/`options` (`--no-references` ↔ `{ checkReferences: false }` as the old suite's `NO_REFERENCES` L206).
- tsgit side: `(await open({ cwd })).fsck(options)`; a fatal row (git exit 128) asserts the open/fsck rejects with the data code (`NOT_A_REPOSITORY`).
- Line rebuild from structured findings (ADR-249), extending the old suite's `rebuiltLines` (L1202–1258) shape: `badRefContent` body from `files[finding.ref]`; `badRefName` → "error: <ref>: badRefName: invalid refname format"; `badHeadTarget` → "error: <ref>: badHeadTarget: HEAD points to non-branch '<referent>'"; `symlinkRef`, `badReferentName`, `symrefTargetIsNotARef`, `refMissingNewline` as the old suite; `cannotReadRef` → "error: cannot read ref file '<p>': Permission denied"; `unreadable-ref-path` and `refs-walk-failed` PERMISSION_DENIED as the old suite; `refs-walk-failed` NOT_A_DIRECTORY → "error: cannot open directory <p>: Not a directory" (no quotes); `unreadable-root-refs` → no line; `refs-verify-ended` → "fatal: Invalid path '<p>': <text>" (absolute); `invalid-reflog-entry` → "error: <ref>: invalid reflog entry <id>" (as test/integration/alternates-gc-fsck-interop.test.ts L603); `no-default-references` as the old suite.
- Path spelling (the design's "Path spelling in git's lines"): cwd linked → absolute; cwd main → relative to `w` except a linked store's ROOT-ref path (parent dir is "<w>/.git/worktrees/<id>"), which stays absolute.
- Comparison (house rule): content and walk lines as a sorted multiset; pointer lines (`POINTER_LINE` of the old suite, L27) in sequence; exit codes equal; the die rows compare the whole multiset.
- POSIX/non-root gate for every `chmod` row: `const UNPRIVILEGED = process.platform !== 'win32' && process.getuid?.() !== 0` (old suite L30–31), `it.skipIf(!UNPRIVILEGED)`.

Rows owned (new suite, each from every cwd the design pinned): A0, A1, A2, A3/A4, A5, A6, A7 (w), A7/A9 (wt fatal), A8 (wt), A8 (w fatal), A9, A10 (w, vt), A14, A15, A16, A17, A18, A19, A20, C4, A21, A22, J, A24, B1, B2, B3, C1, B7, C2/Q8 (fsck), Q9, B12, B13, P11, P12.

### TDD steps

1. GUARD — scaffold + seeder + rebuild + the A0 row from w and wt: passes (clean repository, exit 0 both sides). If it fails, the harness is wrong, not tsgit: fix the harness.
2. GUARD — add the remaining rows of this part, a few at a time, running the suite after each batch. Each passes because Parts 1–12 implement it; a failing row is either a harness spelling bug (fix the rebuild, citing the design's spelling rule) or a tsgit divergence (stop: `{ unit, reason, ≤3 options }`).
3. REFACTOR — keep helpers under 20 lines; no row ids in titles (titles describe the shape: "Given garbage in a linked worktree's bisect ref, When fsck runs from the main worktree, Then …").

### Gate

`npx vitest run test/integration/fsck-worktree-private-refs-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/fsck-worktree-private-refs-interop.test.ts && npm run check:spelling` — and the explicit run `./node_modules/.bin/vitest run --project integration test/integration/fsck-worktree-private-refs-interop.test.ts` (validate does not run it).

### Commit

`test(fsck): pin every worktree's ref store content checks and names against git`

## Part 14 — Interop suite: permission, root-kind, order and walk-death rows

### Context

Files:
- `test/integration/fsck-worktree-private-refs-interop.test.ts` — extend Part 13's suite (same seeder, rebuild and comparison; this part shares the file with Parts 13 and 15 on purpose: one suite per ADR-1162, filled in three agent-sized passes).

Additions:
- `restricted` modes: 0o000 for a file or directory, 0o300 (search, no read) for an admin dir (F, H); restore before removal (Part 13's `afterEach`).
- OS-order rows (P6, Q7, R1/R2) derive the expectation from git's output on the SAME throwaway (lesson 026): P6 compares the sequence of tsgit's badRefContent lines with git's sequence; Q7 compares the whole multiset (which store died first shows); R1/R2 compares the reflog lines in sequence. Never hard-code an order. Repeat the arrange on fresh throwaways: `it.each([1, 2, 3])` per order row.
- The node adapter supplies `readdirInOsOrder`, so tsgit sees the same order git does.

Rows owned: A11 (w, wt), A12, A13 (w, wt), P1, P2, P9 (w, wt), P3 (w, wt), S10, B5 (w, wt), B6 (w, vt), P10 (w, wt), S9 (w, wt), F, H, P4 (w, wt), P5 (w, wt), P6, Q7, R1/R2. All `chmod` rows POSIX + non-root.

### TDD steps

1. GUARD — permission rows (A11, A12, A13, P1, P2, P9, B5, F, H): pass by Parts 5, 6. The path-spelling rule decides A11/A13/B5 from w (relative) against P1 (absolute).
2. GUARD — root-kind rows (B6, P10, S9): pass by Part 6 (`refs-walk-failed` NOT_A_DIRECTORY rebuilt as "cannot open directory").
3. GUARD — root-ref rows (P3, S10): pass by Part 5 (per-store stop; OS order of the admin dir decides which wt root ref is first: derive from git's line).
4. GUARD — die and order rows (P4, P5, P6, Q7, R1/R2), each repeated on three throwaways.
A failing row: harness bug → fix with the design rule cited; tsgit divergence → blocker protocol.

### Gate

`npx vitest run test/integration/fsck-worktree-private-refs-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/fsck-worktree-private-refs-interop.test.ts && npm run check:spelling` — and `./node_modules/.bin/vitest run --project integration test/integration/fsck-worktree-private-refs-interop.test.ts`.

### Commit

`test(fsck): pin unreadable, non-directory and OS-ordered worktree ref stores against git`

## Part 15 — Interop suite: namespace resolution and listing rows

### Context

Files:
- `test/integration/fsck-worktree-private-refs-interop.test.ts` — extend the suite again.

Additions:
- rev-parse rows: git `rev-parse --verify <name>` (via `tryRunGitWithExit` with `-C <cwd>`) against `(await open({ cwd })).revParse(name)`, rebuilt from structured fields: a single `object` entry prints its `id` (use `revParseStdout` from test/integration/interop-helpers.ts L495), exit 0; an `OBJECT_NOT_FOUND` rejection rebuilds "fatal: Needed a single revision", exit 128. Names (B14/C3): "main-worktree/HEAD", "worktrees/wt/HEAD", "worktrees/wt/refs/bisect/bad" (seeded at ".git/worktrees/wt/refs/bisect/bad"), "main-worktree/refs/heads/main", "worktrees/wt/refs/heads/side", "worktrees/nope/HEAD"; B15 on its own throwaway: loose main "refs/bisect/bad", packed "refs/bisect/packed" and "main-worktree/refs/bisect/fullname", names "main-worktree/refs/bisect/bad", "…/packed", "…/fullname", "main-worktree/ORIG_HEAD", "worktrees/wt". From w and from wt.
- fsck rows A25 (refs/heads/x = "ref: main-worktree/HEAD"), B8 ("ref: main-worktree/refs/bisect/bad"), A26/A27 ("ref: worktrees/wt/HEAD", "ref: worktrees/wt/refs/bisect/bad"), from w and wt.
- Listing rows: git `for-each-ref --format=%(refname)` against `getRefStore(context({ workDir: cwd })).listRefNames()` restricted to names under "refs/" (git's for-each-ref does not print HEAD): C2/Q8 ("x.lock", "y.lock" unlisted), Q9 (".x.lock" unlisted, from wt), B6 from vt (git exit 0 and tsgit does not throw). `getRefStore` from src/application/primitives/ref-store.ts.

Rows owned: B14/C3, B15, A25, B8, A26/A27, C2/Q8 (listing), Q9 (listing), B6 (vt listing). Out of scope by design: E1, W14.

### TDD steps

1. GUARD — rev-parse rows: pass by Part 12.
2. GUARD — fsck namespace rows: pass by Part 12.
3. GUARD — listing rows: pass by Part 8.
A failing row: harness bug → fix with the design rule cited; tsgit divergence → blocker protocol.

### Gate

`npx vitest run test/integration/fsck-worktree-private-refs-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/fsck-worktree-private-refs-interop.test.ts && npm run check:spelling` — and `./node_modules/.bin/vitest run --project integration test/integration/fsck-worktree-private-refs-interop.test.ts`.

### Commit

`test(refs): pin main-worktree and worktrees/<id> resolution and lock-name listing against git`

## Part 16 — Docs

### Context

Files:
- `docs/use/commands/fsck.md` — L41 type snippet (`refs-walk-failed` reason union; the `unreadable-root-refs` arm); L131 `checkReferences` (the pass now walks every worktree's store; `unreadable-root-refs` is dropped with the rest); L163 `bad-ref` (a linked store's findings carry "worktrees/<id>/", the current one's included; `badRefName` and `badHeadTarget` messages with defaults and shadowing; an unreadable HEAD is reported once, by the walk; the main HEAD seen from a linked worktree is named "HEAD"); L180 `refs-walk-failed` (`reason` "NOT_A_DIRECTORY" for a root that is a file or a symbolic link, with no warning beside it); a new `unreadable-root-refs` row after L180; L270 exit table (bit 8 gains `badRefName`, `badHeadTarget`, `unreadable-root-refs`, a non-directory root).
- `docs/design/fsck.md` — msg-id table L359 (`badRefName`) and L363 (`badHeadTarget`): now emitted.
- `docs/design/fsck-broken-ref-chain-unreadable.md` — L616 "Assumption, unpinned": replace with a pointer to docs/design/fsck-worktree-private-refs.md rows A1, B12, B13 (git strips the cwd's gitdir).
- `docs/use/commands/rev-parse.md` — "main-worktree/<per-worktree ref>" and "worktrees/<id>/<per-worktree ref>" resolve; other names under those prefixes do not; writes through them are unchanged.

The BACKLOG tick of 32.48 and 32.49 is the documentation phase's job (design Part 9), not this part's. No row ids or ADR numbers in the user docs (docs/use); the design doc may cite them.

### TDD steps

1. GUARD — no code. Write the prose; run `./node_modules/.bin/cspell --no-progress` on the four files (reword rather than add dictionary words).

### Gate

`./node_modules/.bin/cspell --no-progress docs/use/commands/fsck.md docs/design/fsck.md docs/design/fsck-broken-ref-chain-unreadable.md docs/use/commands/rev-parse.md && npm run check:spelling && npm run check:doc-coverage`

### Commit

`docs(fsck): document every worktree's ref checks, the new findings and main-worktree resolution`

## Gate commands (manifest, verbatim)

`npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files> && npm run check:spelling` — resolved per part above. Phase gate: `npm run validate` (plus `npm run check:doc-typedoc` before push, pre-paid in Part 6).

## Decision candidates

Load-bearing choices the design and ADRs 1150–1163 do not settle. The plan is written with
each recommendation; the alternative changes only the named part.

| # | Choice | Alternatives | Recommendation | Why |
|---|---|---|---|---|
| PC-1 | `IntegrityStore.linked` (ADR-1151 lists it) | (a) omit it; (b) keep it | (a) | It has no reader: an absent root is silent for both store kinds (A10, and the main store as today), and nothing else branches on the kind. A field nobody reads is dead code. Part 5. |
| PC-2 | A property for `bareStoreRefName` | (a) none, as the caller instructed; (b) a round-trip property in the same sibling: `bareStoreRefName(linkedWorktreeRefPrefix(id) + n) === n` for any slash-free `id` and any `n` | (b) | property-testing.md lens 1 fits (prefix add/strip is a pair), and the sibling file already exists in Part 1, so the cost is one `it`. Under (a) the example rows of Part 1 step 3 stand alone. Part 1. |
| PC-3 | Where the breaking data change is marked (DC-3: a linked store's `ref` gains its prefix; P2's `ref` becomes "HEAD"; `refs-walk-failed.reason` widens) | (a) part commits plain, the PR title carries `!` (squash merge decides the changelog); (b) Parts 5 and 6 commit with `fix(fsck)!:` | (a) | The repository squash-merges and release-please reads the merged title (recent `fix(gc)!:`, `feat!:` titles). A `!` on a part commit is lost in the squash. The propose phase must title the PR with `!`. |

## Out-of-perimeter notes

None proven.
