# Plan — session-caches faithfulness addendum

<!-- cspell:ignore reflogexpire reflogexpireunreachable cntrl punct xdigit -->

> Source: design doc `docs/design/session-caches-faithfulness-addendum.md` (decisions ratified
> 2026-09-14; its "Ratified decisions" list and section C's full-parity + parse-acceptance shape are
> authoritative; its "Ref write and delete semantics, and memory-adapter parity (U1–U6)" section binds Parts 17–18) ·
> ADRs 863, 864, 865, 866, 867, 868, 869, 870, 871, 872 (accepted) and the committed correction
> notes on ADRs 851, 852, 855, 857, 860 · parent plan `docs/plan/session-caches-per-command-floor.md`
> (Parts 1–13, implemented; this plan continues its numbering).
> The plan is the implementation script AND the knowledge handoff. Part agents start with zero
> context: whatever a part block omits is paid later as agent rediscovery. `plan-lint.sh` enforces the
> schema below — the plan phase cannot close without it.

**Seven parts (Part 14 – Part 20), nineteen commits.** The dependency order is the design's
(I → A → H/O → F/M → C/B → K/E/D), with the ref-transaction semantics decided after it (U3–U6) placed before C.
The design's seventh part (N, a test-only pin) is folded into Part 15 as its second commit; the parse-acceptance
work is its own commit inside Part 19; memory-adapter parity (gap G1, widened by U1 and U2) is Part 17's first two
commits; and the ref delete and dereference semantics (gap G2, U3, U4, U6, U5) are Part 18. All explained under
[Deviations](#deviations-from-the-design-partition).

| Part | Design items | Commits | Nature |
|---|---|---|---|
| 14 | I | 1 | narrow classification change |
| 15 | A, N | 2 | behaviour change (A); regression pin (N) |
| 16 | H, O | 2 | cache tuning, no git-observable change |
| 17 | G1 + U1 memory-adapter resolution, U2 refusal codes, F, M | 4 | adapter parity fixes; behaviour change (F); documented epoch + pin (M) |
| 18 | G2 null id + U3 absent no-op, U4 packed refs, U6 coupled `HEAD` entry, U5 dereference | 4 | behaviour change (delete and write semantics, lock refusals, caller changes) |
| 19 | C, parse acceptance, B | 3 | behaviour change (new refusals, refusal order) |
| 20 | K, E, D | 3 | pure refactor (K); behaviour change (E, D) |

**Undecided open items bind two parts** (design "Open items raised by the U1–U6 pins", repeated
[below](#open-items-raised-by-the-u1u6-pins)): O1 and O3 in Part 18, O2 and O4 in Part 17. The parts carry each
outcome's delta; the session names the outcome when it spawns the part.

Parts run sequentially in one working tree (`/Users/scolladon/workspace/perso/node/tsgit-session-caches-per-command-floor`,
branch `feat/session-caches-per-command-floor`); each part starts from the previous part's last commit.

## What this plan reuses from the parent plan, and what changes

Read these four sections of `docs/plan/session-caches-per-command-floor.md` before starting any part.
They are not repeated here.

- **Release line** — reused. Still the v5 line; the only `!` commit remains the parent's Part 8
  commit 2. **Change:** no commit in this plan carries `!`. Every new refusal and changed default is a
  faithfulness fix typed `feat`/`fix` (house convention: faithfulness fixes are not breaking) and is
  listed in the [v5 migration notes](#v5-migration-notes-for-the-docs-phase).
- **Sizing rules** — reused verbatim. **Change:** its rule "a part that would be a pure test pass over
  already-landed code merges into its neighbour" is what folds design item N into Part 15.
- **The part gate, and its two traps** — Trap 1 (wireit cache hits read like passes), Trap 2 (zsh passes
  an unquoted `$FILES` as one argument; write paths literally) and the "New words" cspell guidance apply
  unchanged. **Change:** the [machine constraint](#machine-constraint-binding-on-every-part) replaces the
  manifest's `npm run check:types` / `npm run check:spelling` form with the bare commands, always.
- **Beyond part-level TDD: smokes and probes** — its "Verification discipline" paragraph applies
  unchanged (pre-existing-failure claims verified against `main`; a scripted edit confirmed with
  `git diff --stat` before trusting a green gate; every new guard arm gets its own test row). Its table
  rows are replaced by [the addendum table](#beyond-part-level-tdd-probes-and-smokes-addendum). Bench runs
  keep `--config vitest.bench.config.ts`: a `vitest bench` run without it silently writes no
  `reports/benchmarks/raw.json`.

## Machine constraint (binding on every part)

Memory is saturated by other sessions. Inside a part, run **only**:

- `npx vitest run --maxWorkers=2 <literal unit test paths>` (batches of at most ~8 files);
- each `test/integration/*-interop.test.ts` file in its **own** `npx vitest run <file>` invocation;
- `npx vitest run --config vitest.perf.config.ts <literal perf test path>` (Part 20 only);
- `npx tsc --noEmit -p tsconfig.json`;
- `./node_modules/.bin/biome check <literal touched paths>`;
- `npx cspell --no-progress <literal touched paths>` (never `cspell.json` itself).

Never inside a part: `npm run validate`, a full or project-wide suite, Stryker, `npm run build`,
`check:size`, `check:tarball`, `docs:json`, `check:architecture`, `check:dead-code`, `check:duplicates`,
`check:test-pyramid`, `check:write-surfaces`, `bench:ab`. The session runs them at the
[phase boundary](#phase-boundary-obligations-session-after-part-20). A part that owes one says so in its
Gate under **Owed at the phase boundary**, so the debt is declared, not discovered.

**Commit with hooks on, capped.** The pre-commit hook runs `lint-staged`, which runs
`biome check --write` and `vitest related --run --project unit` over staged `*.ts`. For a widely
imported module (`update-ref.ts`, `read-object.ts`, `object-resolver.ts`, the fifteen `errorDataCode`
importers) `vitest related` fans out to hundreds of files. Commit as
`VITEST_MAX_WORKERS=2 git commit -m '<message>'` (vitest reads `VITEST_MAX_WORKERS`). Never
`--no-verify`. A related-test failure outside the part's own files is a real failure the part caused
until verified against `main`.

## Conventions every part applies

- **Test shape.** `describe('Given …')` › `describe('When …')` › `it('Then …')`; the two-level
  `describe('Given …, When …')` › `it('Then …')` only when one expectation lives under the When. AAA
  section comments. `sut` is the function under test, never its result (the result is `result`).
  `it.each` rows use a `label` field, never `then`.
- **Refusal assertions.** `try`/`catch` and assert `data` field by field (`code`, then every payload
  field). Never `toThrow(Class)` alone. One isolated test per guard condition.
- **Spies.** Stryker's vitest runner ignores the config's `restoreMocks`: every file that adds a
  `vi.spyOn` restores it explicitly (`spy.mockRestore()` or `afterEach(() => vi.restoreAllMocks())`).
- **Conditional spreads** (`...(x === undefined ? {} : { key: x })`) are asserted on key presence
  (`'key' in data`, `Object.keys(data)`); `toEqual` treats an absent key and an `undefined` one alike.
- **No references to this plan, the design, ADRs, the backlog, design matrix rows (A1, C8, D10 …) or
  review findings inside source or test code** — titles, comments and docstrings describe behaviour; the
  commit is the join point. Git source locations (`refs.c:1425`) stay allowed in docstrings, as the
  codebase already cites them.
- **No suppression directives** (`v8 ignore`, `istanbul ignore`, `stryker-disable`, `biome-ignore`,
  `@ts-ignore`).
- **Interop files.** One `beforeAll` builds a base repository with git (60 000 ms timeout); every row
  works on a copy (`cp(base, dir, { recursive: true })` — the `caseDir`/`cloneRepo` pattern in
  `test/integration/reflog-interop.test.ts`). Every git spawn goes through
  `test/integration/interop-helpers.ts` (`git`, `runGit`, `runGitEnv`, `tryRunGitWithExit`), which strips
  every `GIT_*` variable, points `HOME`/`XDG_CONFIG_HOME` at a non-existent path, sets
  `GIT_CONFIG_NOSYSTEM=1` and disables auto-maintenance. Base repositories set
  `commit.gpgsign=false`. No row in this plan compares conflict markers, so
  `-c merge.conflictStyle=merge` is not needed; add it if a row ever does. git's human lines are
  reconstructed **in the test** from tsgit's structured fields and compared with git's stderr — the
  library returns data, never a rendered line. Each new interop file opens with an `@proves` block
  (`surface`, `bucket: cross-tool-interop`, `unique`, `interopSurface`), which the phase-boundary audits
  read. A git loose object is mode `0444`: `chmod(path, 0o644)` before overwriting it.

## The part gate (addendum form)

```
npx vitest run --maxWorkers=2 <unit test files, literal>
npx vitest run <interop file A>          # one invocation per interop file
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check <every touched file, literal>
npx cspell --no-progress <every touched file, literal>
```

Chain with `&&`; a step that checked zero files is not green (Trap 2). Each part's Gate block lists the
exact files.

## Beyond part-level TDD: probes and smokes (addendum)

| Part | Extra step | Why |
|---|---|---|
| **17** commits 1–2 (memory adapter) | Run the whole symlink-using test set listed in Part 17 (34 unit files + `test/integration/add-all.test.ts`) and, after commit 2, the absence-code batch, in batches; `test/unit/adapters/node/node-file-system.test.ts` unchanged. | The `FileSystem` contract suite runs against both adapters, so every new contract row is its own Node-parity oracle; the enumerated suites catch production code that relied on the memory adapter never following a link or reporting its old codes. |
| **17** commit 4 (M) | **Characterization sanity.** The epoch pin documents today's behaviour, so it cannot go red first. Prove it is not vacuous: locally change `readHeadFile` (`src/application/primitives/internal/head-file.ts:156-164`) to ignore `trusted`, run the new test, watch it fail, revert with `git checkout -- src/application/primitives/internal/head-file.ts`, confirm `git diff --stat` shows only intended files. | A pin that passes against a broken implementation proves nothing. |
| **18** commit 2 (U4) | Inode-and-mtime probe: in the loose-only interop row, `stat` `packed-refs` before and after on both sides (`ino`, `mtimeMs`). | "Untouched" must be proven on the file, not inferred from equal bytes — a rewrite with identical bytes would pass a content comparison. |
| **18** commit 4 (U5) | Re-run `test/integration/reflog-interop.test.ts`, `loose-ref-interop.test.ts`, `reftable-ref-storage-interop.test.ts`, `head-symlink-interop.test.ts` unchanged, each in its own invocation. | Class C callers now write through `HEAD`; their reflog bytes must not move for a direct branch. |
| **19** commit 1 (C) | **Mandatory wall-clock A/B, idle machine only** — procedure below. Run after the C commit lands; re-run once after commit 2 if the machine is still idle. | Every verified `updateRef` now reads and hashes one object; `commit` pays it once per commit for the object it has just written. Only absolute main-vs-branch numbers can show the cost. |
| **19** commit 1 (C) | Re-run `test/integration/blob-streaming-interop.test.ts` and `test/integration/blob-streaming-checkout-interop.test.ts` unchanged. | The loose stream arm now reads its header at open; streaming output bytes must not move. |
| **20** commit 1 (K) | `git diff --stat HEAD~1 -- test/` prints nothing after committing. | The refactor's preservation proof is "no test assertion changed". |
| **20** commit 3 (D) | Clock discipline for the configuration interop file (see Part 20). | git's default cutoffs use its own `time(NULL)`; rows must not depend on wall-clock drift. |

### Part 19 wall-clock A/B procedure (record, never assert)

Preconditions: `uptime` 1-minute load average below 3, and `ps -Ao command | grep -E 'vitest|stryker|tsc|rollup'`
shows no process from another session. If the machine never becomes idle, record "not measured: machine
not idle" in the part notes — do not measure on a loaded machine.

`bench:ab` has no file filter (it runs every bench file both trees share), and no `branch.create` bench
exists (the parent design measured that floor with uncommitted fs-count scripts). The A/B is therefore
scoped by hand, reusing `tooling/bench-ab.ts`'s recipe (two detached worktrees sharing `node_modules`,
alternating round order, best-of-rounds):

```
WT=/Users/scolladon/workspace/perso/node/tsgit-session-caches-per-command-floor
S=<your scratchpad directory>
git -C "$WT" worktree add --detach "$S/ab-main" main
git -C "$WT" worktree add --detach "$S/ab-head" HEAD
ln -s "$WT/node_modules" "$S/ab-main/node_modules"
ln -s "$WT/node_modules" "$S/ab-head/node_modules"
cp "$S/branch-create.bench.ts" "$S/ab-main/test/bench/"
cp "$S/branch-create.bench.ts" "$S/ab-head/test/bench/"
# rounds 1 and 3: main then head; round 2: head then main
(cd "$S/ab-main" && VITEST_MAX_WORKERS=1 npx vitest bench --run --config vitest.bench.config.ts \
   test/bench/commit.bench.ts test/bench/branch-create.bench.ts) \
 && cp "$S/ab-main/reports/benchmarks/raw.json" "$S/ab-main-r1.json"
# … same for ab-head, then rounds 2 and 3 …
git -C "$WT" worktree remove --force "$S/ab-main"
git -C "$WT" worktree remove --force "$S/ab-head"
```

`$S/branch-create.bench.ts` (scratch, never committed; `benchScenario` and the scratch helpers exist on
`main` too):

```ts
import { benchScenario } from './support/bench-dsl.js';
import { buildCommitScratch, SCRATCH_AUTHOR } from './support/write-scratch.js';

benchScenario(
  'Given a scratch repository with one commit',
  'When branch.create() creates a branch at HEAD, Then measure tsgit',
  async () => {
    const scratch = await buildCommitScratch();
    await scratch.repo.commit({ message: 'base', author: SCRATCH_AUTHOR, committer: SCRATCH_AUTHOR });
    let index = 0;
    const sut = async (): Promise<void> => {
      index += 1;
      await scratch.repo.branch.create({ name: `ab-${index}` });
    };
    return { teardown: (): void => scratch.disposeSync(), sut };
  },
);
```

Report, per row (`commit()`, `branch.create()`) and per side, the best round's absolute time per
operation from the `tsgit` rows of each `raw.json` (the file `tooling/bench-ab.ts` reduces with
`bestOfRounds` from `tooling/bench-check.ts`), plus every entry's `sampleCount > 0` (a warm-up error is
swallowed as a zero-sample pass). Absolute numbers for both sides, never a percentage alone. The numbers
go in the part notes handed back to the session for the PR body — no file is committed.

## Deviations from the design partition

1. **Design item N is not a part of its own.** It is a regression pin with no `src/` delta over code
   landed in parent Parts 4 and 6 — exactly the "pure test pass over already-landed code" the sizing
   rules merge into a neighbour. It lands as **Part 15 commit 2**, beside A, whose new
   `readObjectWithSize` is a second first-touch reader of the same verdict; the pin covers it too, which
   gives the fold a reason beyond placement. The design allows N "anywhere", so no ordering constraint
   moves.
2. **Parse acceptance is its own commit (Part 19 commit 2)** rather than folded into C's commit. C's
   commit is already the largest in the plan (blob-source stream-arm change, verifier, ref writer, clone,
   ~40 test files of fixture repair); parse acceptance is a separable refusal class layered on the same
   read, with its own pure domain module and property suite, and each commit is independently green.
   Thirteen commits instead of twelve before the gap resolutions below.
5. **Commits and a part added by gap resolutions and U1–U6** (nineteen commits in total). G1 (b), widened by
   U1: the memory adapter resolves every symlinked component — **Part 17 commit 1** — and U2 aligns its refusal
   codes — **Part 17 commit 2** — both before F, so F's unit rows use the real memory adapter. G2 (b), U3, U4, U6
   and U5 are one subject — `updateRef`'s transaction semantics — and become **Part 18** (four commits), before C:
   C's placement skips the delete forms Part 18 defines and sits before its chain. Old Part 18's null-id commit
   moves into Part 18 commit 1; old Part 18 commits 2–4 become **Part 19** commits 1–3; the reflog part becomes
   **Part 20**. None is in the design partition; all were decided after it (ADR-871, ADR-872).
6. **Why Part 18 is a part of its own, and Part 17 is not split** (the parent plan's sizing rules). Part 18 has
   its own `src/` delta, its own interop file and a gate set disjoint from C's (store, locks, command callers
   rather than object reads); folded into C's part it would be seven commits and two unrelated fixture repairs.
   Part 17's adapter commits and F/M share the memory adapter as the F oracle and F and M are small, so a
   separate adapter part would not earn a lifecycle; its commits grow from three to four instead.
3. **`buildExpiryPolicy` splits into two domain functions (Part 20 commit 3).** The design's single
   `buildExpiryPolicy({ entries, explicit, defaults, parse })` takes the explicit flags as already-parsed
   numbers, but git parses configuration **before** flags (D15: a bogus `gc.reflogExpire` plus
   `--expire=bogus2` reports the configuration). With that signature the application would have to
   resolve the flags — and throw `REVPARSE_UNRESOLVED` — before the domain validates the entries. The part
   uses `parseReflogExpiryEntries(entries, parse)` (validates in file order, throws) then
   `expiryPolicyFor(config, explicit, defaults)`. Same rule, order-preserving.
4. **C's test enumeration is wider than "the 18 files that call `updateRef`".** Commands reach
   `updateRef` too, and `clone` writes through `writeRef`: `test/unit/application/commands/clone.test.ts`
   builds its pack with `buildPackFromSingleBlob` (34 uses) and points the HEAD branch at that blob,
   which C refuses. Part 19 lists every suite to run.

No dependency missing from the design's order was found. Two it leaves implicit are stated in the
parts: C's "a cache hit is hashed and every cached entry has an honest header" guarantee depends on A
(Part 15 before Part 19), E's terminal-name resolution classifies structurally with the domain
`errorDataCode` (Part 14 before Part 20), and C's placement depends on Part 18's delete forms and chain (Part 18
before Part 19).

## Design gaps found while planning

All seven are **resolved** (G1, G2 by the user; G3–G7 by the session, 2026-09-14). The table keeps the
reason and the options that were weighed; the last column is the decision the parts implement.
The open items U1–U6 raised while resolving them were decided by the user and folded (design section "Ref write
and delete semantics, and memory-adapter parity"); the pins that decision raised are the
[open items O1–O4](#open-items-raised-by-the-u1u6-pins) below.

| # | Item | Reason | Options weighed | Resolution |
|---|---|---|---|---|
| G1 | F's unit rows cannot run on the plain memory adapter | `MemoryFileSystem.read`/`readUtf8` (`src/adapters/memory/memory-file-system.ts:66-91`) never follow a symlink, and `stat` resolves a relative link target against the adapter root, not the link's directory (`:155-178`, `:459-465`). The design's "memory adapter `symlink`; F2 oid → `direct`" row would resolve `missing`. | (a) A test-local Context double that follows the HEAD link. (b) Teach `MemoryFileSystem` POSIX symlink following on read. (c) Pin F2–F5 in Node interop only. | **(b), user; widened by U1 and U2.** Part 17 commits 1–2: the memory adapter resolves a symlink in every component (reads follow the leaf too; write leaves never), a relative link text against the link's directory, 40 hops; its refusal codes follow the Node adapter's explicit errno arms. F's unit rows use the real memory adapter. ADR-872. |
| G2 | Null new id (`update-ref <ref> 0{40}`) | Pinned while planning: git **deletes** the ref; tsgit's `updateRef(name, zeroOid, {})` writes a null-id ref (`update-ref.ts:47-48`). The design said only "null ids are unverified". | (a) Keep the write, pin as residual. (b) A null `newId` without `delete: true` deletes, as git does. (c) Refuse it unless `delete: true`. | **(b), user.** Part 18 commit 1: delete path, compare-and-swap honoured, absent ref a no-op success (U3, both paths), never verified (git's `!is_null_oid`), own log removed; the coupled `logs/HEAD` entry on every delete path is commit 3 (U6). ADR-871. |
| G3 | E13 ("unparseable ref content → could not be found") | The design's `resolveTerminalName` returns `undefined` on `INVALID_REF`, but a loose ref holding neither an oid nor `ref: …` refuses `INVALID_OBJECT_ID` (`parseLooseRef` → `ObjectId.from`, `src/domain/objects/object-id.ts:42-44`). | (a) Both codes mean "does not resolve for reading". (b) `parseLooseRef` raises `INVALID_REF`. (c) Residual. | **(a), session.** `INVALID_OBJECT_ID` and `INVALID_REF` both classified with `errorDataCode` as unresolvable (Part 20 commit 2). |
| G4 | The shared ref glob's matching engine | `name-rev`'s `matchRefGlob` compiles to a backtracking `RegExp` (`src/domain/name-rev/ref-pattern.ts:13-21`); D feeds it patterns from repository configuration, which a planted `.git/config` controls — the ReDoS class the linear `compileGlob` closed. | (a) Linear byte-wise matcher + perf guard. (b) Extend the regex. (c) Extend `compileGlob`. | **(a), session.** Part 20 commit 3. |
| G5 | `payloadByteLength`'s public docstring becomes untrue | `src/domain/objects/size.ts:7-17` says it equals git's `cat-file --batch` size; after A, `catFileBatch` reports the stored claim. The docstring is in `reports/api.json`. | (a) Amend in Part 15, regenerate `reports/api.json` once at the phase boundary. (b) Leave it. (c) Amend in the docs phase. | **(a), session.** |
| G6 | Perf A/B tooling | No `branch.create` bench exists, and `bench:ab` cannot be scoped to two files. | (a) Hand-scoped A/B with an uncommitted scratch `branch-create.bench.ts`. (b) Commit a bench. (c) Full `bench:ab`. | **(a), session.** |
| G7 | C's clone unit row "nothing written" | `clone` writes `refs/remotes/origin/<b>` before the local HEAD branch (`clone.ts:287-297`), so the type refusal comes after a remote-tracking ref is written. | (a) Assert only the local branch and `HEAD` are absent. (b) Verify every ref before writing any. (c) Remove the failed clone's directory. | **Resolved by existing behaviour, session.** `clone` already removes `ctx.layout.gitDir` on any failure (`src/application/commands/clone.ts:111-118`, mirroring git's `remove_junk` before checkout). The clone rows assert the refusal data **and** that the gitDir is gone — stronger than (a), no new behaviour. |

### Open items raised by the U1–U6 pins

U1–U6 (the open items the gap resolutions raised) are **decided** — all six folded into this PR by the user,
2026-09-14 (ADR-871, ADR-872). Their pins raised four items that are **not** decided; each stops the part that
meets it until the session names an outcome (design "Open items raised by the U1–U6 pins").

| # | Item | Reason | Options | Part |
|---|---|---|---|---|
| O1 | `branch.rename`'s `logs/HEAD` entries | U6 gave rename a non-logging delete "so its reflog bytes stay git's"; git writes two `logs/HEAD` entries when renaming the branch `HEAD` names, on both backends (design R11, R12), and tsgit writes none today. | (a) Log both (delete with the rename message, `HEAD` re-point logged `0{40} → id`), git's bytes — recommended. (b) Non-logging delete as decided, residual recorded. (c) Logging delete only. | 18 commit 3 |
| O2 | `MemoryFileSystem.mkdir` on a symlink leaf | Node's `mkdir -p` follows its leaf (a link to a directory succeeds; dangling `FILE_NOT_FOUND`; loop `PERMISSION_DENIED`); the decision keeps write leaves no-follow; memory refuses `NOT_A_DIRECTORY` (design Y12). | (a) Follow on `mkdir` only. (b) Keep `NOT_A_DIRECTORY` — the part's default. (c) Refuse `PERMISSION_DENIED`. | 17 commit 1 |
| O3 | `remote.rename`'s packed-only refusal (`assertRenamableTrackingRef`) | Its stated cause (no packed rewrite) is removed by U4; git renames packed-only tracking refs (design R9); not among U1–U6. | (a) Remove it in U4's commit. (b) Keep, residual. (c) Separate follow-up. | 18 commit 2 |
| O4 | Depth-one non-directory and dangling-component codes on memory create surfaces | Node's explicit arms give `FILE_EXISTS` / `FILE_NOT_FOUND` (design Y10, Y11), but ADR-811 ratified keeping memory's `NOT_A_DIRECTORY`. | (a) Keep ADR-811 — the part's default. (b) Reopen ADR-811 and mirror Node. | 17 commit 2 |

## Git pins taken while planning

Probed against `git version 2.55.0` in scratch `mktemp` repositories with `HOME` isolated,
`GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed, signing off. They settle rows the design left "to be
probed" and add rows the parts pin in interop. The U1–U6 pins — symbolic refs on the write path (S1–S28),
deletes (X1–X17), commands (R1–R15), `packed-refs` (Q1–Q14) and the Node-against-memory adapter matrix (Y1–Y16) —
are in the design's "Ref write and delete semantics, and memory-adapter parity" section; Parts 17 and 18 cite them
by row.

| Pin | Result | Used by |
|---|---|---|
| Empty-tree id as a target in a repository that does not store it | `update-ref refs/tags/et 4b825dc6…` → 0, written; `update-ref refs/heads/et 4b825dc6…` → 128 `trying to write non-commit object … to branch 'refs/heads/et'`; reftable backend identical | Part 19: the verifier takes a virtual empty-tree arm |
| Empty blob id not stored | `update-ref refs/tags/eb e69de29b…` → 128 `nonexistent object` (only the empty tree is virtual) | Part 19 |
| Parse acceptance (the design's six rows) | no `tree` line → 128 `error: bogus commit object <id>`; non-hex parent → 128 `error: bad parents in commit <id>`; `type bogus` → 128 `error: unknown tag type 'bogus' in <id>`; tag `object` line cut to 30 hex → 128 (fatal only); commit with `tree`/`parent` but no author/committer on `refs/heads/*` → 0; garbage tree on `refs/tags/*` → 0 | Part 19 commit 2 |
| Parent id equal to the tree id | not shallow → 128 `error: object <tree> is a tree, not a commit` + `error: bad parent <tree> in commit <id>`; commit id listed in `.git/shallow` → 0 on `refs/tags/*` and on `refs/heads/*` | Part 19 commit 2 |
| Upper-case tree hex; bad `parent` line after `author`; empty tag name; tag body shorter than h + 24 | 0; 0; 0; 128 (fatal only) | Part 19 commit 2 |
| Second parent line malformed | 128 `bad parents` | Part 19 commit 2 (unit) |
| Null new id, existing loose branch `b` | `update-ref refs/heads/b 0{40}` → 0; ref gone; `logs/refs/heads/b` removed. `update-ref -d` identical | Part 18 commit 1 |
| Null new id, absent ref | `update-ref refs/heads/nx 0{40}` → 0; no ref, no log file created. `-d` on an absent ref → 0 too (U3, decided) | Part 18 commit 1 |
| Null new id with an old value | matching old → 0, deleted, log removed; mismatching old → 128 `cannot lock ref 'refs/heads/d': is at <oid> but expected <old>`, ref kept; old value on an absent ref → 128 `unable to resolve reference`; null old on an absent ref → 0; null old on an existing ref → 128 `reference already exists` | Part 18 commit 1 |
| Null new id on the branch `HEAD` points at | `update-ref -m why refs/heads/main 0{40}` → 0; `logs/refs/heads/main` removed; `logs/HEAD` gains `<old> 0{40} <identity> <ts> <tz>\twhy`. `-d` writes the identical `logs/HEAD` entry | Part 18 commit 3 |
| Null new id, packed-only ref; symref; tag | packed-only → 0, removed from `packed-refs` (U4, decided); `refs/heads/sym → x` → 0, `x` deleted, `sym` kept (U5, decided); lightweight tag → 0, deleted | Part 18 commits 1, 2 (packed-only), 4 (symref) |
| Null new id, reftable backend | existing ref → 0, ref gone, `reflog exists` → 1 (log gone); absent → 0 | Part 18 commit 1 |
| Bogus `gc.reflogExpire`, `reflog expire --expire=now` with **no ref** | 128 `error: 'bogus' for 'gc.reflogexpire' is not a valid timestamp` + `fatal: bad config variable 'gc.reflogexpire' in file '.git/config' at line 9` — configuration is parsed before the no-ref no-op | Part 20 commit 3 |
| Malformed `core.deltaBaseCacheLimit`, `reflog expire --all --expire=now`, zero reflogs | 0 — the repo-settings class is not reached with zero targets | Part 20 commit 2 |
| `[gc "<pattern>"] reflogExpire = never` against `refs/heads/main`, one 200-day-old entry | `refs/heads/m[a-z]in`, `refs/heads/m[[:lower:]]in`, `refs/heads/m[]a]in`, `refs/heads/m[a-]in` → kept (match); `refs/heads/m[!a]in`, `refs/heads/m[^a]in`, `refs/heads/m[[:digit:]]in`, `refs/heads/M*`, unterminated `refs/heads/m[a` → expired (no match); subsection `"refs/heads/m\\ain"` (pattern `m\ain`) → kept, `"refs/heads/m\\*in"` (pattern `m\*in`) → expired | Part 20 commit 3 (brackets in interop; escapes unit-only, see Part 20) |

## Anchor corrections to the design

Verified against the tree at `81e727aa` (no `src/` change since the design's anchor commit `b80d85f9`):

- `instrumentedContext` is `test/unit/application/primitives/fixtures.ts:394` (design: `:343`, which is
  `NodeIdentityFixture`).
- `isFileNotFound` is `src/application/primitives/ref-store.ts:314`; `hasUsableHead` is
  `src/application/primitives/internal/repo-state.ts:131`.
- Two docstrings still name the application-layer `errorDataCode` path:
  `src/application/primitives/internal/pack-byte-source.ts:113` and
  `src/application/primitives/pack-registry.ts:598`.
- `test/unit/application/primitives/stream-blob.test.ts:895-975` holds the zero-chunk and no-NUL inflate
  rows and the cold-Context ledger row, not size-lying rows.
- `src/domain/objects/size.ts`'s docstring is `:7-17`, the function `:18`.
- The memo's entry-count tests in `test/unit/application/primitives/object-resolver.test.ts:3634-3656`
  and `:3658-3700` locate the memo's `createLruCache` call by `call[0] === ctx.deltaCache.maxSize` and
  derive the cap from `PARSED_OBJECT_TYPICAL_ENTRY_BYTES`; both assumptions break in Part 16 commit 2.
- `CONFIG_BAD_DATE_VALUE` has no row in `docs/use/errors.md` today (pre-existing documentation gap).
- `clone` removes `ctx.layout.gitDir` on any failure (`src/application/commands/clone.ts:111-118`), which
  the design's "nothing written" wording did not account for (G7).
- `updateRef`'s `delete: true` path (`src/application/primitives/update-ref.ts:42-45` →
  `ref-store.ts:842-858` `applyDelete`) removes the loose file and its reflog but writes no coupled
  `logs/HEAD` entry, refuses a packed-only ref and refuses an absent ref — all relevant to G2.
- `REF_UPDATE_CONFLICT`'s data is `{ name, expected, actual }` (`src/domain/refs/error.ts:53-57`); the first
  Part 18 draft wrote `ref`.
- `docs/use/primitives/update-ref.md`'s signature block documents `options?: { oldId?, message? }`; the type has
  always been `UpdateRefOptions` (`src/application/primitives/types.ts:103-118`), which the facade passes through
  unchanged (`src/repository.ts:423`, `:999-1002`).
- `ref-store.ts`'s `applyDelete` starts at `:836` (docblock) / `:842` (function); the files backend never locks a
  delete today, and a loose-and-packed delete removes only the loose file, so the packed value resurrects (design
  Q2).
- C types the **given** ref name (design S6, S9, S10), not the terminal of a symref chain; the design's C section is
  unchanged by U5.

## Size budgets — tarball and size-limit

**Tarball** (`tooling/verify-tarball.sh:152`, `SIZE_CAP=$((928 * 1024))` = 950 272 B). Last recorded
measure 949 335 B → 937 B of headroom (the session's working figure is ~800 B; trust neither without a
clean rebuild). Runtime added by part, design estimates plus planning estimates for the gap and U1–U6
resolutions: Part 15 ≈ +300 B; Part 16 ≈ +80 B; Part 17 ≈ +500 B (memory-adapter walk and codes, U1/U2) + ≈
+200 B (F); Part 18 ≈ +50 B (null id, absent no-op) + ≈ +450 B (lock helper, `packedRefsWithout`, locked delete) +
≈ +100 B (coupled entry, backend table) + ≈ +700 B (write chain, update tables, callers); Part 19 ≈ +350 B
(verifier) + the stream-arm change + the parse scanner (≈ +1 KiB total) + ≈ +60 B (B); Part 20 ≈ +1.2 KiB
(policy + token walk) + ≈ +0.5 KiB (glob). **The cap is crossed by Part 17 or Part 18 — U4 and U5 alone
(≈ +1.15 KiB) exceed the 937 B headroom — and by several KiB at Part 20.**

**size-limit** (`.size-limit.json`, `kB` = 1 000 B, gzip). Approximate headroom measured with
`gzip -9` on the current `dist/` (built after the last `src/` commit):

| Entry | Limit | Now | Headroom | Likely consumer |
|---|---|---|---|---|
| `Browser bundle (no-build)` `dist/browser/tsgit.js` | 195 kB | ≈ 194 141 B | ≈ 0.86 kB | every part; crossed by Part 18 (gzip of ≈ +1.3 KiB runtime) or 19 |
| `Chunks: domain` | 73 kB | ≈ 72 343 B | ≈ 0.66 kB | Part 18 (`packedRefsWithout`), Part 19 (parse scanner), Part 20 (policy, glob) |
| `Chunks: primitives` | 65 kB | ≈ 64 237 B | ≈ 0.76 kB | Part 15, Part 18 (write chain, locked delete), Part 19 (verifier, stream arm), Part 20 (token walk) |
| `Chunks: commands-internal` | 43 kB | ≈ 41 101 B | ≈ 1.9 kB | unlikely (Part 18's caller edits are a few bytes) |
| `Command (reflog)` | 3 kB | ≈ 1 551 B | ≈ 1.45 kB | Part 20 |
| `Memory adapter` `dist/esm/adapters/memory/index.js` | 10 kB | ≈ 3 878 B | ≈ 6.1 kB | Part 17 commits 1–2 (not a risk) |

`MemoryFileSystem` is not in the no-build browser bundle (its `symlink loop` refusal string appears only in `dist/esm/adapters/memory/index.js`), so Part
17 commits 1–2 do not touch that budget; it does enter the tarball and the `Facade (memory shim)` entry.

**Remedy (phase boundary, not in-part).** A red `check:tarball` or `check:size` is believed only after
`rm -rf dist .wireit` and a fresh build. If still red: raise the tarball cap by the minimum whole KiB that
passes, extending the attribution comment above `SIZE_CAP` with the measured tarball and the runtime each
part added (the existing comment's style); raise a size-limit entry by the minimum step that passes
(quarter-kB, as the existing `2.75 kB` entry does), naming the measured size and the parts in the commit
message. One `chore(size): …` commit per gate.

## Phase-boundary obligations (session, after Part 20)

1. `rm -rf dist .wireit`, then `npm run validate` serially. It covers what parts may not run:
   `check:architecture` (Part 14's domain import direction, new domain modules), `check:dead-code`
   (Part 14's deleted module), `check:duplicates` (Part 15's `readObjectWithSize` beside `readObject`),
   `check:test-pyramid` and `check:write-surfaces` (new interop `@proves` blocks), `check:size`,
   `check:tarball`, `test:coverage` (100 %), `test:integration`, `test:parity`, `test:perf`.
2. `npm run docs:json` and commit `reports/api.json` — owed by Part 15 (`payloadByteLength` docstring,
   G5), Part 17 commit 2 (the port's `readdir` JSDoc), Part 18 commits 3–4 (`UpdateRefOptions`: the delete arm's
   `reflogMessage`, `noDeref`) and Part 20 (`CONFIG_BAD_DATE_VALUE` gains optional `key`, `source`, `line`). Suggested
   message: `docs(api): regenerate the API report`. `check:doc-typedoc` is a prepush gate, not a validate
   gate.
3. Size-cap raises per [Size budgets](#size-budgets--tarball-and-size-limit).
4. Browser e2e is not run by any part: `test/parity/scenarios/reftable-refs.scenario.ts` changes in
   Part 19 and runs under Playwright in CI too; Part 18's `updateRef` changes reach it unchanged.
5. Open items O1–O4 must each be named before its part is spawned; a part spawned without one stops.

## v5 migration notes (for the docs phase)

One line each on the 5.0 migration page; every item is observable by a caller.

1. **`reflog({ action: 'expire' })` with no `ref` and no `all` does nothing** — returns
   `{ kind: 'expire', removed: 0, kept: 0 }`. It used to expire `HEAD`'s log. git behaves this way.
   (DC-E2, ADR-867)
2. **Default expiry clocks are total 30 days, unreachable 90 days** — git ≥ 2.50's binary
   (`reflog.h:25-28`), not git's documented 90/30. Reachable entries 30–90 days old now expire on a
   default expire, and a default expire does no reachability walk. (DC-D1, ADR-865)
3. **`catFile` / `catFileBatch` entry `size` is the stored loose header's claim** (git
   `cat-file --batch`/`-s`). It equals the content length for every honest object; `readObjectMetadata`
   stays content-derived. (DC-A2, ADR-863)
4. **A loose blob whose header size lies is readable**: `readObject`, `readBlob`, `catFile`, `streamBlob`
   and `checkout` serve its real bytes; `verifyHash: true` refuses `OBJECT_HASH_MISMATCH`; a size-lying
   commit, tree or tag still refuses `INVALID_OBJECT_HEADER`. (DC-A1, ADR-863)
5. **`updateRef` verifies its target** (by the name given, not a symref's target) before the compare-and-swap: `OBJECT_NOT_FOUND` for a missing
   object, `OBJECT_HASH_MISMATCH` for bytes that do not hash to the id, `INVALID_COMMIT` / `INVALID_TAG`
   for a commit or tag git's parser refuses, `UNEXPECTED_OBJECT_TYPE { expected: 'commit' }` for a
   non-commit on `HEAD` or `refs/heads/*`. A wrong `expected` plus a bad target now reports the target
   refusal, not `REF_UPDATE_CONFLICT`. Deletes and symbolic writes are unverified. Every verified update
   reads and hashes one object. (C, ADR-864)
6. **`tag.create`**: a lightweight tag to a missing object refuses `OBJECT_NOT_FOUND` (any existing type
   is accepted); an existing tag name refuses `TAG_EXISTS` before the target is verified, annotated tags
   included. (B, ADR-864)
7. **`clone`** refuses an advertisement whose HEAD branch or detached `HEAD` names a missing, corrupt or
   non-commit object, and a tag or remote-tracking ref naming a missing or corrupt object. (C, ADR-864)
8. **`streamBlob` on a loose non-blob** refuses `UNEXPECTED_OBJECT_TYPE` at its `await`, not at the first
   chunk. (C, ADR-864)
9. **A symlinked `HEAD` whose link text is not a `refs/`-prefixed valid refname is read through**: the
   linked file's content decides (`direct` oid or `ref: …`), instead of refusing `INVALID_REF`; a
   `commit` then replaces the link with a regular file (direct) or advances the branch (symbolic).
   (F, ADR-868)
10. **`gc.reflogExpire`, `gc.reflogExpireUnreachable` and `gc.<pattern>.reflogExpire[Unreachable]` are
    honoured** (repository-local configuration only). `refs/stash` never expires unless a pattern or an
    explicit flag says so. A valueless or unparseable value refuses `CONFIG_MISSING_VALUE` /
    `CONFIG_BAD_DATE_VALUE { value, key, source, line }` on any line, before flags, targets and the
    repo-settings class; `CONFIG_BAD_DATE_VALUE` gains optional `key`, `source`, `line`. (D, ADR-866)
11. **Single-ref `reflog expire` resolves its target as git does**: short names DWIM; a symref (or `HEAD`)
    without its own log expires its target's log; a deleted ref with a kept log, a dangling symref, an
    unborn `HEAD`, an invalid name (was `INVALID_REF`) and unparseable ref content refuse
    `REFLOG_NOT_FOUND { ref }` with the argument as passed; a tip naming a missing object expires by
    clock instead of throwing `OBJECT_NOT_FOUND`; the repo-settings class is checked after the target
    resolves. (E, ADR-867)
12. **`name-rev` `refs` / `exclude` patterns** with `[…]` or `\` match as git's `wildmatch` does instead of
    literally. (DC-D3, ADR-866)
13. **A custom adapter's duck-typed `{ data: { code: 'OBJECT_NOT_FOUND' } }` rejection** is folded as a
    missing object at the ten classification sites (for example `catFileBatch` yields `missing`).
    (I, ADR-870)
14. **Cache ceilings**: at sha256 the FlatTree and parsed-memo default valves admit their full reference
    workload; the memo's valve is charged at measured cost (≈ 37.7 MiB at sha1), so the documented cache
    family ceiling is ≈ 158 MiB, not 136 MiB. No API change. (H, O, ADR-869)
15. **`MemoryFileSystem` resolves symlinks like POSIX**: every symlinked path component is followed, on reads and
    writes; `read`, `readSlice`, `readUtf8`, `stat`, `exists` and `readdir` follow the leaf too (40-hop limit), a
    relative link text against the link's own directory — `stat` used to resolve it against the adapter root. A
    read through a link returns the target's bytes instead of `FILE_NOT_FOUND`, a write through a symlinked
    directory lands in the target directory instead of refusing `NOT_A_DIRECTORY`, and `exists` on a dangling
    link is `false` instead of `true` — the Node adapter's answers. Write leaves, `lstat`, `readlink`, `rm`,
    `rename` and `openWithNoFollow` still act on the link itself. The browser adapter is unchanged (OPFS has no
    symlinks). (G1, U1, ADR-872)
16. **`updateRef(name, <null id>, …)` deletes the ref**, as `git update-ref <ref> 0{40}` does, instead of
    writing a ref holding the null id: the same delete as `delete: true` — compare-and-swap honoured, own reflog
    removed, no target verified. (G2, ADR-871)
17. **`updateRef` dereferences symbolic refs** as `git update-ref` does: writing or deleting through a symref
    changes its target and keeps the symref; every symref walked and the `HEAD` that names one gain a reflog
    entry; `expected` is compared with the target's value; a symref cycle refuses `REF_CYCLE_DETECTED`; there is
    no depth cap. `noDeref: true` (git's `--no-deref`) acts on the name itself. The reflog old id of a `HEAD`
    entry coupled through a symref is the null id on the files backend and the resolved id on reftable, as git's
    two backends write it. (U5, ADR-871)
18. **Deleting the ref `HEAD` names appends `<old> 0{40} <message>` to `logs/HEAD`** on every delete path
    (`delete: true` and the null id); `delete: true` accepts an optional `reflogMessage`. (U6, ADR-871)
19. **A delete of an absent ref succeeds** (it refused `REF_NOT_FOUND`); `branch.delete`, `tag.delete` and
    `remote.remove` keep refusing unknown names first. (U3, ADR-871)
20. **A packed-only or loose-and-packed ref is deleted** (it refused `UNSUPPORTED_OPERATION`
    `delete-packed-ref`, or resurrected the packed value): `packed-refs` is rewritten without it, under git's
    canonical header, sorted. (U4, ADR-871)
21. **Deletes lock as git does**: a held `packed-refs.lock` refuses every delete `RESOURCE_LOCKED { resource:
    'ref', path }`, and a held `<ref>.lock` refuses `REF_LOCKED { name }` — an absent ref included. `fetch
    --prune` deletes packed-only tracking refs and no longer prunes a symbolic `refs/remotes/<r>/HEAD`. (U4, U5,
    ADR-871)
22. **`MemoryFileSystem` refuses with the Node adapter's codes**: a symlink loop `PERMISSION_DENIED` (was
    `UNSUPPORTED_OPERATION` from `stat`; `exists` now throws it), reading a directory `PERMISSION_DENIED` (was
    `FILE_NOT_FOUND`), `readdir` of a missing path `FILE_NOT_FOUND` (was `NOT_A_DIRECTORY`), any path beneath a
    regular file `NOT_A_DIRECTORY` (was `FILE_NOT_FOUND`; `exists` now throws it). (U2, ADR-872)
23. **Commands write refs as git does through symrefs**: `commit`, `merge`, `reset`, `merge --abort`,
    `cherry-pick`, `revert` and their aborts write through `HEAD`, so a raced update refuses
    `REF_UPDATE_CONFLICT { name: 'HEAD' }`; `branch.create({ force })`, `tag.create({ force })`, `notes` and
    `push`'s tracking update move a symref's target instead of replacing the symref; `branch.delete`,
    `tag.delete` and `remote.remove` still delete a symref itself. (U5, ADR-871)

## Docs-phase debt declared by the parts

- Part 15: `docs/use/primitives/read-object.md`, `docs/use/primitives/stream-blob.md`,
  `docs/use/primitives/cat-file-batch.md`, `docs/use/commands/cat-file.md` (blob reads serve the body;
  `size` is the stored claim; commit/tree/tag refuse; the cap measures actual bytes);
  `docs/use/errors.md` `INVALID_OBJECT_HEADER` (commit/tree/tag) and `OBJECT_HASH_MISMATCH` (stored
  header hashed) rows.
- Part 16: `docs/use/primitives/internals.md:98` and `:107` (valves, family total ≈ 158 MiB, sha256
  admission), `docs/understand/performance.md:59` and `:72`.
- Part 17: `docs/understand/security.md:31-33` ("Memory — symlink loop cap": every component resolved, the leaf
  followed on reads only, relative to the link's directory, 40 hops, `PERMISSION_DENIED` on a loop, structural
  containment still refusing targets outside the root); `docs/use/primitives/internals.md:66` (read-through rule
  for a non-refname link text; the HEAD-slot epoch sentence is written in the part itself).
- Part 18: `docs/use/primitives/update-ref.md` (replace the stale `{ oldId?, message? }` signature with
  `UpdateRefOptions`; dereferencing, `noDeref`, reflog entries per symref, null id and `delete: true` as deletes,
  absent no-op, coupled `logs/HEAD` entry, packed rewrite, the two lock refusals, the backend differences);
  `docs/use/commands/fetch.md` (prune), `docs/use/commands/branch.md`, `docs/use/commands/tag.md`,
  `docs/use/commands/remote.md` (symrefs deleted as themselves); `docs/use/errors.md` rows `REF_UPDATE_CONFLICT`,
  `REF_CYCLE_DETECTED`, `RESOURCE_LOCKED`, `REF_LOCKED`, `REF_NOT_FOUND`, `UNSUPPORTED_OPERATION`.
- Part 19: `docs/use/primitives/update-ref.md` (verification, typed by the given name),
  `docs/use/commands/tag.md`, `docs/use/commands/clone.md`, `docs/use/primitives/stream-blob.md` (refusal at
  `await`); `docs/use/errors.md` rows `OBJECT_NOT_FOUND`, `OBJECT_HASH_MISMATCH`, `INVALID_COMMIT`, `INVALID_TAG`,
  `UNEXPECTED_OBJECT_TYPE` gain `updateRef` / `clone` / `tag.create` throwers and the caller composition of
  git's two lines.
- Part 20: `docs/use/commands/reflog.md` Behaviour + Throws (keys, precedence, defaults 30/90 with the
  git-source note, stash, target resolution, no-ref no-op, class ordering), `docs/use/commands/name-rev.md`
  (glob dialect), `docs/use/errors.md` rows `REFLOG_NOT_FOUND`, `CONFIG_MISSING_VALUE` (new thrower) and a
  new `CONFIG_BAD_DATE_VALUE` row.

## Expected plan-lint warnings

`plan-lint` warns when two parts' Context blocks name the same file. Expected, each a different function
or a citation: `src/application/primitives/read-object.ts` (15 `readObjectWithSize`; 19
`withLazyFetchRetry` export), `src/application/primitives/internal/blob-source.ts` (15 `toBytesSource`;
19 stream arm + verifier), `src/application/primitives/object-resolver.ts` (15 loose arm; 19 cites
`verifyObjectContent`), `src/application/primitives/ref-store.ts` (14 import; 17 `resolveHeadDirect`; 18
`applyDelete`, locks; 19 cites `refExists`), `src/application/primitives/update-ref.ts` (14 import; 18 delete
forms and chain; 19 verification line), `src/application/primitives/types.ts` (18 `UpdateRefOptions` only),
`src/application/primitives/reftable-transaction.ts` (18 only),
`src/domain/objects/error.ts` (14 `isObjectNotFound`; 19 cites factories), `src/domain/refs/packed-refs.ts` (18
only), `src/application/commands/reflog.ts` (14 lists a call site; 20 edits), `src/application/commands/branch.ts`
(14 import; 18 `noDeref`, rename; 19 suite list), `src/application/commands/tag.ts` (18 `noDeref`; 19 pre-check),
`src/application/commands/fetch.ts` (18 prune), `src/application/commands/commit.ts`, `merge.ts`, `reset.ts`,
`cherry-pick.ts`, `revert.ts` (18 write through `HEAD`; 19 runs their test suites only), `src/adapters/memory/memory-file-system.ts`
(17 only), `test/unit/application/primitives/cat-file-batch.test.ts` (14, 15),
`test/unit/application/primitives/fixtures.ts` (15, 19), `test/unit/application/primitives/update-ref.test.ts` (18,
19), `src/application/commands/clone.ts` (19 only), `docs/use/errors.md` and `reports/api.json` (shared
infrastructure). Not a merge signal.

## Self-review (convergence record)

Three passes against the design (including its U1–U6 section), the ADRs and the ratified decisions; a fourth pass
after the U1–U6 fold.

- **Coverage of design changes and gap resolutions.** I → Part 14. A → Part 15 c1. N → Part 15 c2. H →
  Part 16 c1. O (DC-O1 a) → Part 16 c2. G1 (b) + U1 memory-adapter resolution → Part 17 c1. U2 codes → Part 17 c2.
  F → Part 17 c3. M (DC-M1 a) → Part 17 c4. G2 (b) null id + U3 absent no-op → Part 18 c1. U4 packed refs and
  locks, prune catch removal → Part 18 c2 (O3 either way). U6 coupled entry, delete-arm `reflogMessage` →
  Part 18 c3 (O1 either way). U5 chain, `noDeref`, backend table, caller classes C/D/E → Part 18 c4. C (DC-C1 a,
  DC-C2 c) + stream arm + `withLazyFetchRetry` export + empty-tree arm + G7 clone assertion + typing by the
  given name → Part 19 c1. Parse acceptance → Part 19 c2. B → Part 19 c3. G3 → Part 20 c2; G4 → Part 20 c3; G5
  → Part 15 c1; G6 → Part 19 probes. K → Part 20 c1. E (DC-E1 a, DC-E2 a) → Part 20 c2. D (DC-D1 a, DC-D2 a,
  DC-D3 b) → Part 20 c3. ADR correction notes: already committed, no part; ADR-864's and ADR-868's notes point to
  ADR-871 and ADR-872. Docs: declared above. O1–O4: tabled, each part carries both outcomes or the default.
- **Interop coverage of pinned rows.** A1 (`cat-file -s`/`-p`/`--batch`, checkout, status, fsck), A2, A3 →
  Part 15 interop; A1's buffered-tier rows (`diff`, `archive`, `grep`, `repack`) and A4 are unit-only by
  design (reproducing them means sizing a buffer from the claim; tsgit's real-bytes behaviour is pinned by
  unit rows). Null-id and absent deletes (existing, absent, matching old, mismatching old, old on absent,
  `expected: 'absent'`, reftable) → Part 18 c1; Q1–Q12, Q14, X13, prune of a packed-only ref (R8) → Part 18 c2; X2,
  X3, X16 and Q14's `logs/HEAD` → Part 18 c3; S1, S3–S5, S7, S8, S11, S12, S14–S17, S19–S25, S27, S28, X4–X12, X14,
  X15, X17, R5, R6, R8 (`origin/HEAD` kept), R10, R14 → Part 18 c4. Q13 (a lying `sorted` trait), R9 (O3), R11–R13
  (O1), S2/S6/S9/S10 (C's typing) and R15 (push, covered by the class-B unit row) are placed with their owner or
  recorded as residuals. S13 (a 6-link chain) is unit-only (a chain row per length adds nothing over S11 in
  interop). B1–B8 → Part 19 c3. C1–C9 + S9/S10 + empty tree/blob + reftable → Part 19 c1; the six parse rows + PC4
  checked/shallow + upper-case hex, late `parent`, empty tag name and short tag rows → Part 19 c2. Memory-adapter
  arms Y1–Y8 → the `FileSystem` contract suite, run against Node and memory (Part 17 c1, c2); Y9–Y16 are the
  recorded non-folds. D0–D10i, D12–D23, D8h (brackets), D14b (no ref) → Part 20 c3; D11 unit-only by default
  (lowercase keys are the token walk's own rows; an interop row may be added if cheap); D11c/D11d unit-only
  (local-only configuration scope, ADR-637 residual; the interop environment deliberately has no global
  configuration); `\` escapes in patterns unit-only (config subsection quoting is a separate grammar). E1,
  E2, E4, E5, E6, E6b, E7, E8, E10, E12, E13, E14, E15, O-a–O-e, zero-reflog `--all` → Part 20 c2; E3, E16, O-f
  unit-only (unchanged agreement, same code path as a pinned row); E9, E1c–e out of scope (one ref per call; other
  verbs). F1–F8 → Part 17 c3.
- **Every part has a gate that fails without its change**, with inert-change risks named in each part's
  traps: Part 14 (a foreign error must reach `readOne` — it does, `readLooseCompressed` only swallows
  `FILE_NOT_FOUND`); Part 15 (lying rows must use a claim ≠ body length on a **loose** object, and assert
  `ctx.deltaCache.has(id) === false`); Part 16 (sha256 rows must build the Context with
  `algorithm: 'sha256'` and assert the valve number itself); Part 17 (a follow row whose link text is
  absolute passes under the old root-relative `stat`, so every new contract row uses a **relative** link
  text in a subdirectory; a write-through row must assert the bytes at the real path; the F1 `missing` row passes
  on any adapter, so F2 carries the proof; M's pin needs the characterization sanity step); Part 18 (the null-id
  rows must start from an existing loose ref with a reflog, or "log removed" passes vacuously; a lock row must
  assert the refusal data, and Q4 must prove the lock was taken; backend-twin rows kill an inverted table field;
  a chain row must assert a single `applyRefUpdates` call); Part 19 (above-the-gate rows must prove the object
  exceeds 65 536 compressed bytes, or the buffered arm answers); Part 20 (K asserts nothing new by design — its
  proof is an empty test diff; E's gone-ref interop row must be flipped, not duplicated).
- **Surface decisions** are made per new export in each part; the public shape changes are
  `payloadByteLength`'s docstring (Part 15, G5), the port's `readdir` JSDoc (Part 17 c2), `UpdateRefOptions`
  (Part 18 c3–c4: the delete arm's `reflogMessage`, `noDeref`) and `CONFIG_BAD_DATE_VALUE`'s data (Part 20). The
  public `MemoryFileSystem` class (`src/adapters/memory/index.ts`) changes behaviour without a type change
  (migration notes 15, 22). No barrel, facade shape, exhaustiveness switch, Tier-1 command or doc-coverage page is
  added.

---

## Part 14 — `errorDataCode` moves to the domain; `isObjectNotFound` classifies by error data (design I, DC-I1, ADR-870)

### Context

**Behaviour.** A narrow classification change. For every error tsgit raises itself nothing changes:
every `OBJECT_NOT_FOUND` producer inside the ten call sites' try bodies is same-graph code. Only a value
re-thrown verbatim through a Context port — a dist-bundle adapter in a mixed module graph, a dual-package
consumer, a user adapter throwing a duck-typed `{ data: { code } }` — with `data.code ===
'OBJECT_NOT_FOUND'` now folds as a miss. A value with no `data`, or a non-string `code`, still
propagates.

**Design excerpt (DC-I1 a).** `errorDataCode` moves to `src/domain/error-data-code.ts` (pure, zero
imports); its fifteen application importers re-point; `isObjectNotFound = (err: unknown): boolean =>
errorDataCode(err) === 'OBJECT_NOT_FOUND'`. The 72 other `instanceof TsgitError` classifications in
`src/` are counted and **not** swept (`src/application/commands/reflog.ts:458` `tryResolve` and
`src/application/primitives/object-resolver.ts:220` among them).

**Files — create**
- `src/domain/error-data-code.ts` — body verbatim from
  `src/application/primitives/internal/error-data-code.ts:14-18`:
  ```ts
  export function errorDataCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const data = (error as { readonly data?: { readonly code?: unknown } }).data;
    return typeof data?.code === 'string' ? data.code : undefined;
  }
  ```
  Keep the docstring's "why structural, not `instanceof`" paragraph (`:1-12`); drop its stale consumer
  list (it names four consumers; there are fifteen plus `isObjectNotFound`) rather than re-listing.
  No imports at all.

**Files — delete**
- `src/application/primitives/internal/error-data-code.ts` (`git rm`).

**Files — re-point the fifteen importers** (verified line of each import):

| File:line | New specifier |
|---|---|
| `src/application/commands/branch.ts:16` | `'../../domain/error-data-code.js'` |
| `src/application/commands/internal/fsck/roots.ts:12` | `'../../../../domain/error-data-code.js'` |
| `src/application/commands/internal/gc-pipeline.ts:34` | `'../../../domain/error-data-code.js'` |
| `src/application/primitives/fetch-pack.ts:23` | `'../../domain/error-data-code.js'` |
| `src/application/primitives/pack-registry.ts:24` | `'../../domain/error-data-code.js'` |
| `src/application/primitives/ref-store.ts:35` | `'../../domain/error-data-code.js'` |
| `src/application/primitives/reftable-transaction.ts:85` | `'../../domain/error-data-code.js'` |
| `src/application/primitives/update-ref.ts:6` | `'../../domain/error-data-code.js'` |
| `src/application/primitives/internal/cruft-pack-lifecycle.ts:20` | `'../../../domain/error-data-code.js'` |
| `src/application/primitives/internal/loose-oid-cache.ts:30` | `'../../../domain/error-data-code.js'` |
| `src/application/primitives/internal/midx-source.ts:35` | `'../../../domain/error-data-code.js'` |
| `src/application/primitives/internal/pack-byte-source.ts:24` | `'../../../domain/error-data-code.js'` |
| `src/application/primitives/internal/reftable-source.ts:20` | `'../../../domain/error-data-code.js'` |
| `src/application/primitives/internal/shallow-set.ts:21` | `'../../../domain/error-data-code.js'` |
| `src/application/primitives/internal/write-pack-artifacts.ts:28` | `'../../../domain/error-data-code.js'` |

Biome's import sorting may move the line; let `biome check --write` on those files reorder it.
Docstrings naming the old path: `src/application/primitives/internal/pack-byte-source.ts:113`
(`./error-data-code.js`) and `src/application/primitives/pack-registry.ts:598`
(`internal/error-data-code.ts`) → `domain/error-data-code.ts`.

**Files — edit**
- `src/domain/objects/error.ts:74-80` — docstring (it describes "the `instanceof` + code check") and body:
  `export const isObjectNotFound = (err: unknown): boolean => errorDataCode(err) === 'OBJECT_NOT_FOUND';`
  Add `import { errorDataCode } from '../error-data-code.js';`. Keep `import { TsgitError } from
  '../error.js'` (line 1; the factories construct it).

**The ten call sites** (no edit; the classification change lands through the helper):
`src/application/primitives/read-object.ts:186` (lazy-fetch retry), `src/application/primitives/cat-file-batch.ts:44`
(batch fold), `src/application/primitives/internal/read-commit.ts:30`,
`src/application/primitives/internal/closure-not-marks.ts:91` and `:144`,
`src/application/commands/reflog.ts:316` and `:398`, `src/application/commands/bundle-verify.ts:166` and
`:187`, `src/application/primitives/walk-submodules.ts:135`.

**Public or internal — decided: internal.** `errorDataCode` is not re-exported by `src/domain/index.ts`
(it re-exports sub-barrels only) — do not add it anywhere. `isObjectNotFound` stays out of
`src/domain/objects/index.ts`. Surface gates tripped: none (no `reports/api.json`, no errors row, no page).

**Tests**
- Create `test/unit/domain/error-data-code.test.ts` (no dedicated test exists; the function was covered
  only through consumers). One `describe('errorDataCode')` with `it.each` rows `{ label, value, expected }`:
  an object whose `data.code` is a string → that string; `null` → `undefined`; a string, a number and
  `undefined` → `undefined`; an object without `data` → `undefined`; `data` without `code` →
  `undefined`; `data.code` a number → `undefined`.
- `test/unit/domain/objects/error.test.ts:184-230` (`describe('isObjectNotFound')`) — keep its three rows;
  add "Given a foreign-shaped error that is not a TsgitError instance" →
  `Object.assign(new Error('foreign graph'), { name: 'TsgitError', data: { code: 'OBJECT_NOT_FOUND', id } })`
  → `true`; "Given an error whose data.code is not a string" →
  `Object.assign(new Error('x'), { data: { code: 404 } })` → `false`.
- `test/unit/application/primitives/cat-file-batch.test.ts` — beside `:228-268` (the `DECOMPRESS_FAILED`
  `ctx.fs.read` double; copy its shape): "Given a foreign-shaped OBJECT_NOT_FOUND thrown by the read" → a
  `read` double that rejects `Object.assign(new Error('foreign graph'), { data: { code: 'OBJECT_NOT_FOUND', id: stored } })`
  on the loose path → collected entries `[{ ok: false, id: stored, reason: 'missing' }]`. It reaches
  `readOne` because `readLooseCompressed` (`src/application/primitives/object-resolver.ts:214-226`) swallows
  only `instanceof TsgitError && FILE_NOT_FOUND`, and `withLazyFetchRetry` rethrows without a promisor.

**Property tests — none.** `errorDataCode` is a three-branch total function whose input space the six
example rows enumerate; a property would restate the implementation (the tautology the house rules
forbid). Lens 3 ("never throws") is trivially true for every `fc.anything()` value.

**Traps**
- No references to this plan, the design, ADRs or the backlog in source or test code.
- Throw an `Error` carrying `data`, never a plain object literal: biome's throw rules reject a
  non-`Error` throw, and the realistic foreign value *is* an `Error` subclass from another module graph.
- After re-pointing, `rg -n "internal/error-data-code" src test` must print nothing (docstrings included).
- `src/domain/error-data-code.ts` must import nothing (`domain-cannot-import-outward`; checked by
  `check:architecture` at the phase boundary). `domain/objects/error.ts` → `../error-data-code.js` adds no
  cycle (the new module has no imports).
- Do not "fix" the other 72 `instanceof TsgitError` classifications here.

### TDD steps

1. **RED** — `test/unit/domain/error-data-code.test.ts` importing
   `../../../src/domain/error-data-code.js`. Fails: module not found.
2. **GREEN** — create `src/domain/error-data-code.ts` (verbatim body).
3. **RED** — the foreign-shaped row in `error.test.ts`. Fails: `instanceof TsgitError` is `false`, so
   `isObjectNotFound` returns `false`.
4. **RED** — the foreign-shaped `catFileBatch` row. Fails: the rejection propagates out of `collect`.
5. **GREEN** — `isObjectNotFound` through `errorDataCode`; both rows pass.
6. **REFACTOR** — re-point the fifteen importers, `git rm` the application module, fix the two
   docstrings and `isObjectNotFound`'s docstring; `rg` check above; `biome check --write` on the touched
   files.

### Gate

```
npx vitest run --maxWorkers=2 test/unit/domain/error-data-code.test.ts test/unit/domain/objects/error.test.ts test/unit/application/primitives/cat-file-batch.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/commands/bundle-verify.test.ts test/unit/application/primitives/walk-submodules.test.ts test/unit/application/commands/reflog.test.ts
npx vitest run --maxWorkers=2 test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/internal/shallow-set.test.ts test/unit/application/primitives/internal/midx-source.test.ts test/unit/application/primitives/internal/reftable-source.test.ts test/unit/application/primitives/internal/write-pack-artifacts.test.ts test/unit/application/primitives/fetch-pack.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/error-data-code.ts src/domain/objects/error.ts src/application/commands/branch.ts src/application/commands/internal/fsck/roots.ts src/application/commands/internal/gc-pipeline.ts src/application/primitives/fetch-pack.ts src/application/primitives/pack-registry.ts src/application/primitives/ref-store.ts src/application/primitives/reftable-transaction.ts src/application/primitives/update-ref.ts src/application/primitives/internal/cruft-pack-lifecycle.ts src/application/primitives/internal/loose-oid-cache.ts src/application/primitives/internal/midx-source.ts src/application/primitives/internal/pack-byte-source.ts src/application/primitives/internal/reftable-source.ts src/application/primitives/internal/shallow-set.ts src/application/primitives/internal/write-pack-artifacts.ts test/unit/domain/error-data-code.test.ts test/unit/domain/objects/error.test.ts test/unit/application/primitives/cat-file-batch.test.ts
npx cspell --no-progress src/domain/error-data-code.ts src/domain/objects/error.ts src/application/primitives/internal/pack-byte-source.ts src/application/primitives/pack-registry.ts test/unit/domain/error-data-code.test.ts test/unit/domain/objects/error.test.ts test/unit/application/primitives/cat-file-batch.test.ts
```

**Owed at the phase boundary:** `check:architecture` (import direction), `check:dead-code` (the deleted
module leaves no dangling consumer). **Surface gates tripped:** none.

### Commit

`fix(objects): classify a missing object by its error code, not its class identity`

## Part 15 — A size-lying loose header serves a blob's bytes; `catFile` reports the stored size; one repo-settings verdict pinned (design A + N, DC-A1, DC-A2, DC-N1, ADR-863) — 2 commits

### Context

**Depends on Part 14** only for a clean tree; no shared function. **Must precede Part 19**: C's
guarantee that every `ctx.deltaCache` entry re-derives its stored header from `content.byteLength` holds
only once no size-lying loose object is admitted to the cache.

#### Commit 1 — size-lying loose header (A)

**Design excerpt (DC-A1 b, DC-A2 a).** git has three tiers: the header-only tier reports the claim
(`cat-file -s`, `--batch-check`); the streaming tier, which git uses for every user-facing blob read
(`cat-file -p`, `show`, `checkout`, `--batch` body), emits the real bytes; the buffered tier (every
commit/tree/tag read) allocates from the claim and refuses (`corrupt loose object` / `hash mismatch`).
tsgit: a size-lying loose **blob** is served with its inflated bytes by every read and is **never
cached**; a size-lying **commit, tree or tag** keeps today's refusal, verbatim reason
`size mismatch: header says N, actual content is M`; `verifyHash: true` hashes the **stored** header, so
a lying blob refuses `OBJECT_HASH_MISMATCH { expected: id, actual }`; no allocation is sized from the
claim (`enforceLooseCap` keeps measuring actual bytes); `catFileBatch`'s entry `size` is the resolver's
`declaredSize` for every type; `readObjectMetadata` stays content-derived. No new `await` on the
per-object read path (the parent design's Post-review correction 8: no extracted `async` tier).

Observable today (live, per the design): `catFile`, `readObject`, `readObject { verifyHash }` refuse
`INVALID_OBJECT_HEADER`; `streamBlob` (stream arm) serves real bytes; `streamBlob { verifyHash }` refuses
`OBJECT_HASH_MISMATCH`.

**Files and anchors (verified)**

- `src/domain/objects/git-object.ts:21-36` — `splitObject(rawBytes)` returns
  `{ type, content, bytes }` and throws `invalidObjectHeader('size mismatch: header says ${size}, actual content is ${content.length}')`.
  Keep it strict (`parseObject:38-42` is public). Add beside it:
  ```ts
  export interface LooseObjectSplit extends ObjectContent {
    readonly declaredSize: number;
  }
  /** The loose-object split with the header's size claim kept as data, never enforced. */
  export function splitLooseObject(rawBytes: Uint8Array): LooseObjectSplit {
    const { type, size, contentOffset } = parseHeader(rawBytes);
    return { type, content: rawBytes.subarray(contentOffset), declaredSize: size };
  }
  /** git's buffered tier refuses a size-lying commit, tree or tag; a blob takes the streaming contract. */
  export function assertLooseSizeConsistent(split: LooseObjectSplit): void {
    if (split.type === 'blob' || split.declaredSize === split.content.byteLength) return;
    throw sizeMismatch(split.declaredSize, split.content.byteLength);
  }
  ```
  REFACTOR: `splitObject` builds on `splitLooseObject` and a module-private
  `sizeMismatch(declared, actual)` factory so the reason literal exists once.
  `parseHeader` (`src/domain/objects/header.ts:8-36`) already refuses every non-canonical header text
  (`blob 07`, negative, non-finite), so `serializeHeader(type, declaredSize)` (`header.ts:38`) reproduces
  the stored header byte for byte.
- `src/application/primitives/object-resolver.ts`
  - `:7` import `splitObject` → `assertLooseSizeConsistent, splitLooseObject`.
  - `:68-75` `resolveObjectContentWithDepth(ctx, registry, id, verifyHash, maxBytes, externalDepth):
    Promise<ObjectContent & { chainDepth: number }>` → return type gains `declaredSize: number` on
    **every** arm, same literal shape: empty tree `:82-84` `declaredSize: 0`; cache hit `:85-90`
    `declaredSize: cached.content.byteLength`; pack `:107-110` `declaredSize: resolved.content.byteLength`.
  - Loose arm `:91-99` becomes:
    ```ts
    const split = splitLooseObject(loose);
    assertLooseSizeConsistent(split);
    enforceLooseCap(id, split.content, maxBytes);
    if (split.declaredSize === split.content.byteLength) {
      cacheEntry(ctx.deltaCache, id, { type: split.type, content: split.content });
    }
    await verifyObjectContent(ctx, id, split.type, split.content, verifyHash, split.declaredSize);
    return { type: split.type, content: split.content, chainDepth: 0, declaredSize: split.declaredSize };
    ```
  - `:254-273` `verifyObjectContent(ctx, id, type, content, verifyHash)` → add a sixth parameter
    `declaredSize: number = content.byteLength` and hash `serializeHeader(type, declaredSize)`. Every
    other caller (`:88`, `:109`, `blob-source.ts:171`, `:223`, `:251`) passes nothing.
  - `:113-136` `resolveObject` — extract the memo lookup/parse/insert (`:128-135`) into a module-private
    **synchronous** `parseMemoised(ctx, id, type, content): GitObject` and add
    `export async function resolveObjectWithSize(ctx, registry, id, verifyHash, maxBytes?): Promise<{ readonly object: GitObject; readonly size: number }>`
    that awaits `resolveObjectContentWithDepth(..., 0)` once and returns
    `{ object: parseMemoised(...), size: declaredSize }`. `resolveObject` keeps its single `await`
    (a sync helper adds a call, not a microtask).
  - `:146-151` `enforceLooseCap` unchanged. `:691-693` `cacheEntry` unchanged.
- `src/application/primitives/internal/blob-source.ts`
  - `:21` import `splitObject` → `assertLooseSizeConsistent, splitLooseObject`.
  - `:141-144` `toBytesSource(looseFormatBytes)` → split with `splitLooseObject`,
    `assertLooseSizeConsistent`, return `{ kind: 'bytes', type, content }`. The buffered arm hashes the
    stored bytes before the split (`resolveLoose:181-185` → `verifyBufferedBytes:154-163`), so a lying
    object under `verifyHash` refuses `OBJECT_HASH_MISMATCH` before any size refusal. Stream arm
    (`:186-193`) untouched in this part.
- `src/application/primitives/read-object.ts` — beside `readObject:199-209` add
  ```ts
  export async function readObjectWithSize(
    ctx: Context,
    id: ObjectId,
    options?: ReadObjectOptions,
  ): Promise<{ readonly object: GitObject; readonly size: number }> {
    const verifyHash = options?.verifyHash ?? false;
    const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
    return withLazyFetchRetry(ctx, id, registry, () =>
      resolveObjectWithSize(ctx, registry, id, verifyHash, options?.maxBytes),
    );
  }
  ```
  (`withLazyFetchRetry:173` stays module-private in this part.)
- `src/application/primitives/cat-file-batch.ts` — `:12` drop `payloadByteLength` from the import;
  `:21-26` `buildOkEntry(id, { object, size })` → `{ ok: true, id, type: object.type, size, object }`;
  `:35-47` `readOne` calls `readObjectWithSize(ctx, id, readOptions)`.
- `src/domain/objects/size.ts:7-17` — `payloadByteLength`'s docstring: replace "Equal to the `size` field
  of git's `cat-file --batch` header" with a sentence saying it is the canonical body length, equal to
  the stored size git's `cat-file --batch` prints for every object whose stored header is honest and whose
  body re-serialises byte-exactly (G5). The function body is unchanged.

**Public or internal — decided.** `splitLooseObject`, `assertLooseSizeConsistent`, `LooseObjectSplit`:
internal (`src/domain/objects/index.ts:37-38` exports only `GitObject`, `ObjectContent`, `parseObject`,
`parseObjectContent`, `serializeObject` from `git-object.ts` — do not add). `resolveObjectWithSize`,
`readObjectWithSize`: internal (`src/application/primitives/index.ts:70` exports `readObject` by name
only — do not add). `CatFileBatchEntry.size` (`src/application/primitives/types.ts:377-389`) keeps its
type; **do not add a JSDoc to it** (that would change `reports/api.json` for no behaviour).
**Surface gates tripped:** `reports/api.json` via `payloadByteLength`'s docstring → owed at the phase
boundary. Docs rows: declared debt.

**Fixtures**
- `test/unit/application/primitives/fixtures.ts:301` `writeRawObjectBytes(ctx, type, content)` writes an
  honest loose object and returns its id. Add beside it
  `writeLooseWithDeclaredSize(ctx, id, type, declaredSize, content)`: deflate
  `serializeHeader(type, declaredSize)` + `content` with `ctx.compressor.deflate` and write it at
  `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}` — the forge `read-object.test.ts:211-247`
  inlines today. A test forges an honest object's id first (`writeRawObjectBytes` or hash the honest
  bytes) and then overwrites the file with a lying header, so the path matches the real hash.
- `buildSeededContext` (`fixtures.ts:253`), `instrumentedContext` (`fixtures.ts:394`).

**Tests (unit)**
- `test/unit/domain/objects/git-object.test.ts` — new `describe('splitLooseObject')`: one row per type
  returning `{ type, content, declaredSize }`; a claim ≠ body length does not throw; a malformed header
  (`blob 07\0x`) still refuses `INVALID_OBJECT_HEADER` with `reason: 'invalid size: 07'`. New
  `describe('assertLooseSizeConsistent')`: blob with a mismatch → returns; commit, tree, tag with a
  mismatch → one isolated row each refusing `INVALID_OBJECT_HEADER` with the verbatim reason; a commit
  whose sizes agree → returns (kills the `===` comparison). The strict `parseObject` / `splitObject`
  size-mismatch rows (`:150-175`, `:350-390`) stay unchanged — `parseObject` is public and keeps the
  equality check.
- `test/unit/application/primitives/object-resolver.test.ts` — lying loose blob (body 12 B, claim 5):
  `resolveObjectContentWithDepth` returns the 12 content bytes, `declaredSize: 5`, and afterwards
  `ctx.deltaCache.has(id) === false`; an honest loose blob → `ctx.deltaCache.has(id) === true` (the two
  rows kill both constant mutants of the cache gate); lying loose commit → `INVALID_OBJECT_HEADER` with
  the verbatim reason; lying blob with `verifyHash: true` → `OBJECT_HASH_MISMATCH` with `expected === id`
  and `actual === await ctx.hash.hashHex(<the stored lying bytes>)` (if `declaredSize` is not threaded, the
  canonical header re-hashes to `id` and nothing throws — this row kills that); a second
  `verifyHash: true` read after an unverified read still refuses; `declaredSize` equals the content
  length on the cache-hit, pack and empty-tree arms (one row each); `resolveObjectWithSize` on a commit
  returns the memoised parse and `size`.
- `test/unit/application/primitives/read-object.test.ts:211-247` — **rewrite** the forge row: title
  "Given a loose blob whose header claims 1 byte and whose body is 8, When readObject is called with
  maxBytes 4, Then the cap measures the actual 8 bytes and refuses OBJECT_TOO_LARGE" → data
  `{ code: 'OBJECT_TOO_LARGE', id, actualSize: 8, limit: 4 }` (a cap trusting the claim would admit it —
  the old test's security intent, re-pinned). Add a lying commit forge still refusing
  `INVALID_OBJECT_HEADER`. Add `readObjectWithSize` rows: honest blob `size === content.byteLength`;
  lying blob `size === claim`; a missing id without a promisor refuses `OBJECT_NOT_FOUND { id }`.
- `test/unit/application/primitives/internal/blob-source.test.ts` — beside `:118` (`Given a loose blob`):
  lying loose blob under the gate → `kind: 'bytes'`, `type: 'blob'`, content = body; lying loose commit
  under the gate → `INVALID_OBJECT_HEADER`; lying loose blob under the gate with `verifyHash: true` →
  `OBJECT_HASH_MISMATCH`.
- `test/unit/application/primitives/cat-file-batch.test.ts` — lying blob → entry
  `{ ok: true, type: 'blob', size: 5 }` with `object.content` the 12 body bytes; an honest blob, tree,
  commit and tag → `size === payloadByteLength(object, ctx.hashConfig)` (extend `:52` and `:114`).
- `test/unit/application/primitives/read-object-metadata.test.ts` — lying loose blob →
  `uncompressedSize: 12`.
- `test/unit/application/primitives/stream-blob.test.ts` — one row: a lying loose blob streamed yields
  the 12 body bytes (pins the agreement with `readObject`).

**Tests (interop)** — create `test/integration/loose-header-size-interop.test.ts`.
`@proves` surface `readObject, catFile, streamBlob, checkout`; unique "a loose object whose header size
disagrees with its body, against git 2.55.0"; interopSurface `readObject, catFile, streamBlob`.
Base (`beforeAll`, 60 000 ms): `git init -q -b main`, `user.name`/`user.email`, `commit.gpgsign=false`,
`small.txt` = `hello world\n` (12 B), `medium.txt` = 40 lines of 47 B each (1 880 B), one commit with
fixed `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` through `runGit(…, { env })`; record the two blob ids, the
tree id and the commit id. Forge helper: `chmod(path, 0o644)` then
`writeFile(path, deflateSync(Buffer.concat([Buffer.from(`${type} ${claim}\0`), body])))` (`node:zlib`).
Every row runs on a copy; tsgit through `createNodeContext({ workDir })`.

| Row | git side | tsgit side |
|---|---|---|
| small blob, claim 5 | `cat-file -s` → `5`; `cat-file -p` → the 12 B; `cat-file --batch` header `<id> blob 5` + 12 B body | `catFile` entry `size: 5`, content equals git's `-p` bytes; `readObject` content equal; `streamBlob` drained equal |
| small blob, claim 20 | same with `20` | same |
| small blob, claim 104857600 | `cat-file -s` → `104857600`; `-p` → 12 B | `catFile` `size: 104857600`, content 12 B |
| medium blob, claims 500 and 4000 | `-p` → 1 880 B both | `readObject` 1 880 B both |
| checkout of the lying small blob | delete `small.txt`, `checkout -- small.txt` → 12 B file | twin copy: `checkout(ctx, { paths: ['small.txt'] })` → 12 B file |
| status on the lying repository | `status --porcelain` → empty | `status` reports clean |
| hash verification | `fsck --full` exit 3, stdout/stderr mention `hash-path mismatch` for the blob | `readObject(id, { verifyHash: true })` and `streamBlob(id, { verifyHash: true })` → `OBJECT_HASH_MISMATCH { expected: id }` |
| commit, claim 50 (body over-runs) | `cat-file -p <commit>` exit 128, stderr contains `corrupt loose object '<id>'` | `readObject` → `INVALID_OBJECT_HEADER`, reason `size mismatch: header says 50, actual content is <n>` |
| commit, claim 400 (body under-runs) — **titled as the recorded residual** | `cat-file -p` exit 0 (400 B) and `log --format=%H` exit 0 | `readObject` refuses `INVALID_OBJECT_HEADER` |
| tree, claims 10 and 200 | `ls-tree HEAD` exit 128 both | `readObject(tree)` refuses `INVALID_OBJECT_HEADER` both |
| blob claim `9007199254740993` — **titled as the recorded residual** | `cat-file -s` prints the claim verbatim, `-p` 12 B | `readObject` refuses `INVALID_OBJECT_HEADER`, reason `invalid size: 9007199254740993` |
| blob claim `18446744073709551616` | `cat-file -s` exit 128 `size_t overflow` | refuses `INVALID_OBJECT_HEADER` |

Unit-only, with reason: the buffered-tier blob rows (`diff --stat`, `archive`, `grep`, `repack`) — git's
truncation and zero-padding come from a buffer sized by the claim, which the threat model rules out; the
real-bytes behaviour is pinned by the object-resolver unit rows. The source-reading row (how git's tiers
work internally) is not observable beyond the rows above.

**Property tests — none.** `splitLooseObject` adds a `subarray` and a pass-through number on top of
`parseHeader`, whose grammar `test/unit/domain/objects/header.properties.test.ts` already covers; the
four-type × mismatch space is enumerated by example rows.

**Traps**
- No references to this plan, the design, ADRs, matrix rows or the backlog in source or test code.
- **Inert-change risk:** a lying object must be **loose** (a packed object never reaches the loose arm)
  and the claim must differ from the body length; assert `ctx.deltaCache.has(id)` explicitly.
- `resolveObjectContentWithDepth` is a deliberate exception to the 20-line guideline (parent design
  Post-review correction 8). Keep it inline; do not extract an `async` helper.
- The Stryker directive at `object-resolver.ts:632` describes `verifyObjectContent(verifyHash=false)`;
  its line is untouched — re-run, do not re-prove.
- `fsck` reads loose objects through its own `parseHeader` path
  (`src/application/commands/internal/fsck/object-cache.ts:287`, `content-validation.ts:54`); A must not
  change it. `test/unit/application/commands/fsck.test.ts:4325-4350` ("size larger than content → dangling
  blob") stays green.
- `CatFileInput.maxBytes`'s public JSDoc (`src/application/commands/cat-file.ts:22`) still reads
  "forwarded to the underlying `readObject` call"; leave it (editing changes `reports/api.json`).

#### Commit 2 — one repo-settings verdict on a primitive-only first read (N)

**Design excerpt (DC-N1 a).** Measured: the verdict is computed once. With
`cacheBudgets.deltaBaseCacheMaxBytes` supplied (the budget then reads no configuration), a primitive-only
first `readObject` issues exactly `stat` + `readUtf8` of `.git/config`; without it, the second `stat`
belongs to the delta-base budget's own `readConfig`, the per-read freshness a primitive-only session keeps
on purpose. Pin it so the non-defect cannot become one. No runtime change; `config-read.ts` untouched.

**Anchors.** `getPackRegistry` (`src/application/primitives/read-object.ts:64-99`) runs
`assertRepoSettingsValid` unless `repoSettingsVerdictSettled`; the verdict's compute
(`src/application/primitives/internal/repo-settings-gate.ts:23-33`) calls `findLastInvalidMaxTreeDepth`
(`src/application/primitives/config-read.ts:939`) and, only without the option,
`findLastInvalidDeltaBaseCacheLimit` (`:982`). Existing neighbours:
`test/unit/application/primitives/pack-registry.test.ts:867-897` (construction issues
`stat, readUtf8, stat` of `/repo/.git/config`), `test/unit/application/primitives/read-object.test.ts:591-609`
(a settled session re-runs no finder; its spy pattern: `import * as configReadMod`, `vi.spyOn(configReadMod,
'findLastInvalidMaxTreeDepth')`), `:611+` (a gated first read issues zero config stats).

**Tests (test-only commit)**
- `read-object.test.ts` — "Given a bare memory Context with cacheBudgets.deltaBaseCacheMaxBytes supplied
  and no gate": build with `buildSeededContext({ objects: [blob] })` (it writes through `ctx.fs`, so no
  verdict is settled), derive `{ ...base, cacheBudgets: { deltaBaseCacheMaxBytes: 2048 } }`, wrap with
  `instrumentedContext`, install the finder spy **before** the first read. When `readObject` runs twice:
  the calls whose path is `/repo/.git/config` are exactly
  `[{ method: 'stat', … }, { method: 'readUtf8', … }]` for the first read, and the spy was called exactly
  once across both reads.
- Same file — without the option: config calls `stat, readUtf8, stat` for the first read; finder spy
  exactly once across two reads.
- Same file — `readObjectWithSize` (commit 1's new reader) as the first touch: finder spy exactly once
  across `readObjectWithSize` + `readObject`.
- `pack-registry.test.ts` beside `:867-897` — with the option supplied: `createPackRegistry` issues
  `stat, readUtf8` of config only.

**Traps**
- The spy must exist before the first read; restore it in the test.
- Pin the exact call list **and** the spy count: either alone can pass if the verdict path were skipped.
- No references to this plan, the design, ADRs or review findings in test code.

### TDD steps

**Commit 1 (A)**
1. **RED** — `git-object.test.ts`: `splitLooseObject` rows. Fails: not exported.
2. **RED** — `assertLooseSizeConsistent` rows (blob passes; commit/tree/tag refuse; equal sizes pass).
   Fails: not exported.
3. **GREEN** — both functions; `splitObject` over `splitLooseObject` + `sizeMismatch`.
4. **RED** — `object-resolver.test.ts`: lying loose blob returns its body with `declaredSize: 5` and is not
   cached. Fails: `INVALID_OBJECT_HEADER`.
5. **RED** — lying blob under `verifyHash` refuses `OBJECT_HASH_MISMATCH` with `actual` = hash of the stored
   bytes. Fails: `INVALID_OBJECT_HEADER` today.
6. **GREEN** — loose arm, `declaredSize` on every arm, `verifyObjectContent`'s sixth parameter.
7. **RED** — `read-object.test.ts` rewritten cap row expects `OBJECT_TOO_LARGE { actualSize: 8, limit: 4 }`.
   Fails: `INVALID_OBJECT_HEADER`. (Green after step 6 — if it is already green, step 6 landed first; keep
   the row.)
8. **RED** — `blob-source.test.ts` buffered lying blob → bytes. Fails: `INVALID_OBJECT_HEADER`.
9. **GREEN** — `toBytesSource`.
10. **RED** — `cat-file-batch.test.ts` lying blob → `size: 5`. Fails: size is 12 (or the read refuses).
11. **GREEN** — `resolveObjectWithSize` + `parseMemoised`, `readObjectWithSize`, `catFileBatch`'s
    `readOne`/`buildOkEntry`.
12. **RED/GREEN** — `read-object-metadata.test.ts` and `stream-blob.test.ts` rows (should pass; they pin
    behaviour the change must keep).
13. **RED/GREEN** — `loose-header-size-interop.test.ts`, row by row.
14. **REFACTOR** — `payloadByteLength` docstring (G5); remove the unused `payloadByteLength` import from
    `cat-file-batch.ts`; `git diff --stat` sanity.

**Commit 2 (N)**
15. **Characterization** — the four rows above; they should pass first time (there is no defect). Prove
    they are not vacuous: temporarily make `computeRepoSettingsVerdict` run twice (call
    `findLastInvalidMaxTreeDepth(ctx)` a second time), watch the spy-count rows fail, revert with
    `git checkout -- src/application/primitives/internal/repo-settings-gate.ts`.

### Gate

Commit 1:
```
npx vitest run --maxWorkers=2 test/unit/domain/objects/git-object.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/cat-file-batch.test.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/stream-blob.test.ts test/unit/application/commands/cat-file.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/fsck.test.ts test/unit/application/commands/checkout.test.ts
npx vitest run test/integration/loose-header-size-interop.test.ts
npx vitest run test/integration/loose-object-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/objects/git-object.ts src/domain/objects/size.ts src/application/primitives/object-resolver.ts src/application/primitives/internal/blob-source.ts src/application/primitives/read-object.ts src/application/primitives/cat-file-batch.ts test/unit/application/primitives/fixtures.ts test/unit/domain/objects/git-object.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/cat-file-batch.test.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/stream-blob.test.ts test/integration/loose-header-size-interop.test.ts
npx cspell --no-progress src/domain/objects/git-object.ts src/domain/objects/size.ts src/application/primitives/object-resolver.ts src/application/primitives/internal/blob-source.ts src/application/primitives/read-object.ts src/application/primitives/cat-file-batch.ts test/unit/application/primitives/fixtures.ts test/unit/domain/objects/git-object.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/cat-file-batch.test.ts test/integration/loose-header-size-interop.test.ts
```

Commit 2:
```
npx vitest run --maxWorkers=2 test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/cat-file-batch.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/pack-registry.test.ts
npx cspell --no-progress test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/pack-registry.test.ts
```

**Owed at the phase boundary:** `reports/api.json` (`payloadByteLength` docstring); `check:duplicates`
(`readObjectWithSize` sits beside `readObject` and `readRawObject`; different callee identifiers should
keep jscpd's token match apart — if it flags, have `readObjectWithSize` call a named sync
`verifyHashOption(options)` rather than touching `readObject`); `check:size` (primitives chunk).
**Surface gates tripped:** `reports/api.json` only.

### Commit

Commit 1: `fix(objects): serve a size-lying loose blob's bytes and report its stored size`

Commit 2: `test(objects): pin one repo-settings verdict on a primitive-only first read`

## Part 16 — Width-aware FlatTree and parsed-memo valves, charged at measured cost (design H + O, DC-H1, DC-O1, ADR-869) — 2 commits

### Context

**No git-observable change.** Independent of Parts 14–15 in files; sequential only so gates stay
attributable. Every source edit lands in `src/application/primitives/internal/object-caches.ts`.

**Design excerpt — H (DC-H1 a).** Both sizers charge one byte per hex character of an oid and have no
other width term (`flatTreeByteSize`, `src/application/primitives/read-head-tree.ts:104-110`, charges
`path.length + id.length + 110` per entry plus 48 B; `parsedObjectByteSize`, `object-caches.ts:182-204`,
charges `parents × hexLength`). Measured: 50 000 files with 14-character paths size to 8 200 048 B at sha1
and 9 400 048 B at sha256 against the 8 388 608 B FlatTree valve (44 620 fit at sha256); a typical commit
(216-character message, one parent) sizes to 512 B at sha1 and 536 B at sha256, so
`32 768 × 536 = 17 563 648 > 16 777 216` and the memo valve binds at 31 300 entries at sha256. The reference
counts stay dial-scaled and width-independent; each valve adds exactly what its sizer charges for the wider
oids of that count.

**Design excerpt — O (DC-O1 a).** A memoised commit retains ≈ 947 B of fixed overhead at sha1 (LRU node and
map entry included) plus ≈ 0.99 B per message byte; the sizer charges 256 B and under-states a typical
commit 2.34× (method: `process.memoryUsage().heapUsed` deltas after six forced collections,
`parseObjectContent` × 20 000 retained in `createLruCache`, Node 22.22.3, Apple M3 Pro, each configuration
run twice). Correct the constants, keep the 32 768 dial-derived entry count, valve =
`entries × typicalEntryBytes(width)`. The FlatTree sizer's 1.26–1.32× under-count is recorded, not changed.

**Current code (verified)** — `src/application/primitives/internal/object-caches.ts`:
- `:70` `export const memoByteValve = (ctx: Context): number => ctx.deltaCache.maxSize;` (docblock `:43-69`).
- `:80` `export const PARSED_OBJECT_TYPICAL_ENTRY_BYTES = 512;` (docblock `:72-79`).
- `:91-93` `memoMaxEntries = (ctx) => ctx.cacheBudgets?.parsedObjectMemoMaxEntries ?? Math.floor(memoByteValve(ctx) / PARSED_OBJECT_TYPICAL_ENTRY_BYTES)`.
- `:109` `const FLAT_TREE_DEFAULT_SHARE = 0.5;` (docblock `:95-108` describes the sha256 shortfall — rewrite).
- `:124-128` `budgetsFor(ctx)` → `flatTreeCacheMaxBytes: ctx.cacheBudgets?.flatTreeCacheMaxBytes ?? ctx.deltaCache.maxSize * FLAT_TREE_DEFAULT_SHARE`.
- `:130-137` `parsedObjectMemoFor` → `createLruCache(memoByteValve(ctx), memoMaxEntries(ctx))`.
- `:165` `const PARSED_OBJECT_FIXED_OVERHEAD_BYTES = 256;` (docblock `:154-164`).
- `ctx.hashConfig.hexLength: 40 | 64` (`src/domain/objects/hash-config.ts:4`).
- Consumer: `read-head-tree.ts:25` imports `budgetsFor`; `:61` reads `flatTreeCacheMaxBytes`.

#### Commit 1 — width surcharge (H)

```ts
const SHA1_HEX_LENGTH = 40;
/** Tracked files the FlatTree default admits per 16 MiB of dial, at every hash width. */
const FLAT_TREE_REFERENCE_FILES = 50_000;
const REFERENCE_DIAL_BYTES = 16 * 1024 * 1024;

const oidWidthSurcharge = (ctx: Context): number => ctx.hashConfig.hexLength - SHA1_HEX_LENGTH;

/** The dial-derived entry count — the valve's reference, independent of an explicit entry option. */
const defaultMemoEntries = (ctx: Context): number =>
  Math.floor(ctx.deltaCache.maxSize / PARSED_OBJECT_TYPICAL_ENTRY_BYTES);

export const memoMaxEntries = (ctx: Context): number =>
  ctx.cacheBudgets?.parsedObjectMemoMaxEntries ?? defaultMemoEntries(ctx);

export const memoByteValve = (ctx: Context): number =>
  ctx.deltaCache.maxSize + defaultMemoEntries(ctx) * oidWidthSurcharge(ctx);

const defaultFlatTreeValve = (ctx: Context): number => {
  const dial = ctx.deltaCache.maxSize;
  const files = Math.floor((FLAT_TREE_REFERENCE_FILES * dial) / REFERENCE_DIAL_BYTES);
  return dial * FLAT_TREE_DEFAULT_SHARE + files * oidWidthSurcharge(ctx);
};
// budgetsFor → flatTreeCacheMaxBytes: ctx.cacheBudgets?.flatTreeCacheMaxBytes ?? defaultFlatTreeValve(ctx)
```

Numbers the tests pin: sha1 → memo valve 16 777 216, FlatTree 8 388 608 (byte-identical to today); sha256 →
memo valve 17 563 648, FlatTree 9 588 608 (51 003 reference files fit; sha1: 51 149); 4 MiB dial at sha256 →
memo valve 4 390 912, FlatTree 2 397 152, entries 8 192. An explicit `parsedObjectMemoMaxEntries` sets only
the entry cap — the surcharge multiplies the **dial-derived** count. An explicit `flatTreeCacheMaxBytes`
wins verbatim.

#### Commit 2 — measured memo accounting (O)

```ts
/** Dial bytes per default memo entry — floor(dial / 512) = 32 768 entries at the 16 MiB default. */
export const PARSED_OBJECT_DIAL_BYTES_PER_ENTRY = 512;
/** Measured sha1 retained size of a typical commit: fixed overhead + 216-byte message + one parent oid. */
export const PARSED_OBJECT_TYPICAL_ENTRY_BYTES = 1206;
const PARSED_OBJECT_FIXED_OVERHEAD_BYTES = 950;

const defaultMemoEntries = (ctx: Context): number =>
  Math.floor(ctx.deltaCache.maxSize / PARSED_OBJECT_DIAL_BYTES_PER_ENTRY);
const typicalEntryBytes = (ctx: Context): number =>
  PARSED_OBJECT_TYPICAL_ENTRY_BYTES + oidWidthSurcharge(ctx);
export const memoByteValve = (ctx: Context): number => defaultMemoEntries(ctx) * typicalEntryBytes(ctx);
```

`950 + 216 + 40 = 1 206`, so `parsedObjectByteSize(typicalCommit, 40) === PARSED_OBJECT_TYPICAL_ENTRY_BYTES`
by construction (the existing reconcile assertion keeps it honest). Numbers the tests pin: sha1 valve
`32 768 × 1 206 = 39 518 208` B (≈ 37.7 MiB); sha256 `32 768 × 1 230 = 40 304 640` B; 4 MiB dial at sha1
`8 192 × 1 206 = 9 879 552` B. Docstrings carry the measurement method and ratios.

**Public or internal — decided: internal.** `object-caches.ts` is not barrelled.
`PARSED_OBJECT_DIAL_BYTES_PER_ENTRY` is exported for tests only, as `PARSED_OBJECT_TYPICAL_ENTRY_BYTES`
already is. **Surface gates tripped:** none. Docs: declared debt.

**Tests — commit 1**
- `test/unit/application/primitives/read-head-tree.test.ts:473-531` (`syntheticTreeOf(entryCount,
  hexLength)` `:478-486`, `budgetsFor`, `flatTreeByteSize`): the sha1 row `:488-507` stays. **Rewrite** the
  sha256 row `:509-530` ("overruns the valve and is refused"): Context from
  `createMemoryContext({ algorithm: 'sha256' })` (`src/adapters/memory/memory-adapter.ts:25`); assert
  `valve === 9_588_608`, a 50 000 × 64-hex tree admitted, `flatTreeByteSize(syntheticTreeOf(51_003, 64)) <=
  valve` and `syntheticTreeOf(51_004, 64)` over it. Add a 4 MiB-dial sha256 row (`{ algorithm: 'sha256',
  deltaCacheMaxBytes: 4 * 1024 * 1024 }` → `2_397_152`) and an explicit `flatTreeCacheMaxBytes: 4096` sha256
  row (→ `4096`).
- `test/unit/application/primitives/internal/object-caches.test.ts:223-261` — parameterise over
  `{ label, algorithm, hexLength, valve }` (sha1 `16_777_216`, sha256 `17_563_648`): cap `32_768` both;
  `cap × parsedObjectByteSize(typical, hexLength) <= valve`; sha1 `realTypicalBytes ===
  PARSED_OBJECT_TYPICAL_ENTRY_BYTES`, sha256 `+ 24`. `:263-276` (4 MiB → 8 192) stays; add 4 MiB sha256 →
  `memoByteValve === 4_390_912`; add explicit `parsedObjectMemoMaxEntries: 100` at sha256 →
  `memoMaxEntries === 100` and `memoByteValve === 17_563_648`.

**Tests — commit 2**
- `object-caches.test.ts:43-58` — sizer literal `3 + 8 + 10 + 256` → `3 + 8 + 10 + 950`.
- Invariant rows → valves `39_518_208` / `40_304_640`, cap `32_768`; 4 MiB sha1 → `9_879_552`; the
  explicit-entries row keeps the dial-derived valve.
- New "Given commits with 4 KiB messages": `bytes = parsedObjectByteSize({ message: 'x'.repeat(4096),
  extraHeaders: [], parents: [oid40] }, 40)` (5 086); insert `Math.ceil(memoByteValve(ctx) / bytes) + 10`
  entries into `parsedObjectMemoFor(ctx)`; assert `entryCount === Math.floor(memoByteValve(ctx) / bytes)`
  and `entryCount > Math.floor((16 * 1024 * 1024) / bytes)` (kills a valve left at the dial).
- `test/unit/application/primitives/object-resolver.test.ts:3634-3656` — find the memo's `createLruCache`
  call by `call[0] === memoByteValve(ctx)` (not `ctx.deltaCache.maxSize`); expect `call[1] ===
  Math.floor(ctx.deltaCache.maxSize / PARSED_OBJECT_DIAL_BYTES_PER_ENTRY)`. `:3668-3671` derive
  `derivedEntryCap` from `PARSED_OBJECT_DIAL_BYTES_PER_ENTRY`.
- `object-resolver.test.ts:3695-3730` (LRU eviction at a three-entry byte valve) sets
  `deltaCacheMaxBytes: perEntry * 3`, assuming valve = dial. Re-derive: `deltaCacheMaxBytes: 1536` gives 3
  dial entries and a 3 618 B valve against `perEntry = 960`; assert
  `Math.floor(memoByteValve(ctx) / perEntry) === 3` in Arrange so a retune fails loudly.

**Property tests — none.** Arithmetic over constants and a two-value width; example rows at both widths and
two dials enumerate it, and a property would restate the formula.

**Traps**
- No references to this plan, the design, ADRs or the backlog in source, docstrings or tests.
- **Inert-change risk:** a sha256 row on a default (sha1) Context passes sha1 numbers; always pass
  `algorithm: 'sha256'` and assert the valve number itself.
- At sha1 a dropped and a doubled surcharge both read 0; only sha256 rows distinguish them.
- Commit 1 keeps valve = dial at sha1, so `object-resolver.test.ts:3634-3730` stays green; commit 2 is where
  those blocks change.
- Keep every valve a function evaluated per call; module-level eager values would read constants in TDZ
  order.

### TDD steps

**Commit 1 (H)**
1. **RED** — sha256 FlatTree row expects `9_588_608` and admission. Fails: 8 388 608, refused.
2. **RED** — sha256 memo invariant row expects `17_563_648`. Fails: 16 777 216.
3. **RED** — explicit-entries sha256 row expects valve `17_563_648` with cap 100. Fails (valve is the dial).
4. **GREEN** — `oidWidthSurcharge`, `defaultMemoEntries`, `memoMaxEntries`, `memoByteValve`,
   `defaultFlatTreeValve`, `budgetsFor`.
5. **RED/GREEN** — 4 MiB sha256 rows and the explicit `flatTreeCacheMaxBytes` row.
6. **REFACTOR** — docstrings of `FLAT_TREE_DEFAULT_SHARE` and `memoByteValve`.

**Commit 2 (O)**
7. **RED** — invariant rows expect `39_518_208` / `40_304_640`. Fails.
8. **RED** — 4 KiB-message row. Fails: the valve binds at the dial.
9. **GREEN** — constants 950 / 1 206 / 512, `typicalEntryBytes`, `defaultMemoEntries`, `memoByteValve`.
10. **GREEN** — repair `object-caches.test.ts:43-58` and `object-resolver.test.ts:3634-3730`.
11. **REFACTOR** — docstrings: measured method and ratios; remove the "256 B" wording.

### Gate

Each commit:
```
npx vitest run --maxWorkers=2 test/unit/application/primitives/internal/object-caches.test.ts test/unit/application/primitives/read-head-tree.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/ports/context.test.ts test/unit/repository/validate-options.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/internal/object-caches.ts test/unit/application/primitives/internal/object-caches.test.ts test/unit/application/primitives/read-head-tree.test.ts test/unit/application/primitives/object-resolver.test.ts
npx cspell --no-progress src/application/primitives/internal/object-caches.ts test/unit/application/primitives/internal/object-caches.test.ts test/unit/application/primitives/read-head-tree.test.ts test/unit/application/primitives/object-resolver.test.ts
```

**Owed at the phase boundary:** none beyond validate. **Surface gates tripped:** none.

### Commit

Commit 1: `fix(cache): widen the FlatTree and parsed-memo default valves by hash width`

Commit 2: `fix(cache): charge the parsed-object memo at its measured per-entry cost`

## Part 17 — The memory adapter resolves every symlinked component and refuses as the Node adapter maps; a symlinked `HEAD` whose link text is not a valid refname is read through; the HEAD slot's gate-to-gate epoch (gap G1 b, U1, U2, design F + M, DC-M1, ADRs 872, 868, ADR-855 correction) — 4 commits

### Context

**Depends on Part 14** (`ref-store.ts:35` already imports `errorDataCode` from the domain). Commits 1 and 2
must land before commit 3: F's unit rows run on the real memory adapter, and its directory row relies on commit 2's
`PERMISSION_DENIED` for a directory read. Open items O2 and O4 (design) are undecided; this part implements
their defaults (memory keeps `NOT_A_DIRECTORY` for `mkdir` on a link leaf and for a create surface's depth-one
non-directory or dangling parent) and must not change them.

#### Commit 1 — the memory adapter resolves every path component (gap G1 b, widened by U1; ADR-872)

**Decision.** `MemoryFileSystem` resolves a symlink in **every** path component, as the Node adapter's
syscalls do: reads (`read`, `readSlice`, `readUtf8`, `stat`, `exists`, `readdir`) follow the leaf too;
every other surface (`lstat`, `readlink`, `openWithNoFollow`, `rm`, `rename`, `atomicRename`,
`rmRecursive`, `chmod`, `write`, `writeStream`, `writeUtf8`, `appendUtf8`, `writeExclusive`, `symlink`,
`mkdir`) resolves intermediates only and keeps its leaf behaviour. A relative link text resolves against
the link's own directory. The hop bound is the existing `SYMLINK_FOLLOW_LIMIT` (40,
`src/adapters/memory/memory-file-system.ts:154`) with the existing boundary. This commit aligns **no
refusal code** — commit 2 does (U2); the walk's loop refusal reuses `stat`'s existing
`UNSUPPORTED_OPERATION { operation, reason: 'symlink loop: …' }` shape on every surface that now walks. Design: "Change — U1 and U2" and matrix Y1–Y3.

**Per-method behaviour (verified against both adapters' source and the design's Node probe, Y1–Y3).**

| Method (memory anchor) | Memory today | Node adapter (`src/adapters/node/node-file-system.ts`) | Memory after this commit |
|---|---|---|---|
| `read` (`:66-73`), `readSlice` (`:75-86`), `readUtf8` (`:88-91`) | `files.get` of the lexical path → `FILE_NOT_FOUND` through any link | `readFile`/`open` on the lexical path; the OS follows every component (`:631-663`) | walk `follow`, then today's lookup |
| `stat` (`:156-162`) → `statFollowing` (`:164-179`) | follows a leaf link, relative text against the **root**; intermediates never | `fsOps.stat` follows all (`:743-747`) | walk `follow`; `statFollowing` deleted |
| `exists` (`:144-151`) | `true` for any link key, dangling included; `false` through a link | `fsOps.stat`: dangling → `false` (`:730-741`) | walk `follow`; absent → `false` |
| `readdir` (`:196-221`) | a link → `NOT_A_DIRECTORY` | follows (`:755-766`) | walk `follow`, then today's directory logic |
| `lstat` (`:181-194`), `readlink` (`:354-361`), `openWithNoFollow` (`:421-431`) | lexical path | lexical `resolveRead`, OS follows intermediates, not the leaf | walk `no-follow` |
| `write` (`:93-103`), `writeStream` (`:105-116`), `writeExclusive` (`:118-126`), `writeUtf8` (`:128-130`), `appendUtf8` (`:132-142`), `symlink` (`:363-371`), `mkdir` (`:223-231`) | `ensureParentDirs` → `assertAncestorChainFree` (`:492-505`) refuses any link on the chain `NOT_A_DIRECTORY` | `resolveWrite` realpaths the parent, then `O_NOFOLLOW` / leaf checks (`:1228-1278`) | walk `no-follow`, then today's leaf refusals and parent creation on the walked path |
| `rm` (`:233-256`), `rename`/`atomicRename` (`:259-276`), `rmRecursive` (`:385-392`), `chmod` (`:381-383`) | lexical path | `resolveWrite` (parent realpath, leaf not followed) | walk `no-follow` (both `rename` paths) |

Unchanged in this commit, changed by commit 2: every refusal code (a loop still reports `stat`'s
`UNSUPPORTED_OPERATION` — now from the walk, with `operation` = the calling surface — a directory read
`FILE_NOT_FOUND`, a missing `readdir` `NOT_A_DIRECTORY`). Kept for good (ADR-811, ADR-815, ADR-818,
design Y10–Y12): a non-directory or a dangling link at a create surface's immediate parent refuses
`NOT_A_DIRECTORY`; `mkdir` on a symlink leaf refuses `NOT_A_DIRECTORY` (open item O2); write leaves never
follow. A followed target outside the root refuses `PERMISSION_DENIED` through `resolve` (`:459-465`), the
posture `test/unit/adapters/memory/memory-file-system.test.ts:14-21` declares (`symlinkReadEscape:
'refused'`).

**Target shape** (design sketch; keep each helper under 20 lines):

```ts
/** POSIX resolution over the in-memory tree: every symlinked component is followed — a relative link
 *  text against the link's own directory — and the leaf too under 'follow'. */
private walk(path: string, leaf: 'follow' | 'no-follow', operation: string): string {
  let pending = segmentsUnder(this.rootDir, this.resolve(path));
  let current = this.rootDir;
  for (let hops = 0; pending.length > 0; ) {
    const next = `${current}/${pending[0]}`;
    const target = this.symlinks.get(next);
    if (target === undefined || (pending.length === 1 && leaf === 'no-follow')) {
      current = next;
      pending = pending.slice(1);
      continue;
    }
    hops += 1;
    if (hops >= MemoryFileSystem.SYMLINK_FOLLOW_LIMIT) throw unsupportedOperation(operation, `symlink loop: ${path}`);
    pending = [...segmentsUnder(this.rootDir, this.resolve(target.startsWith('/') ? target : `${current}/${target}`)), ...pending.slice(1)];
    current = this.rootDir;
  }
  return current;
}
```
Preserve the hop boundary exactly: `test/unit/adapters/memory/memory-file-system.test.ts:591-635` ("chain of
exactly 40 valid symlinks ending at a file" — refuses at the 40th hop) stays green unchanged in this commit;
`:563-590` (mutual loop, `operation: 'stat'`, reason `symlink loop: /repo/a`) stays green for `stat`.
`segmentsUnder` is a module function beside `parentOf` (`:610-612`). The walk never files a key: a create
surface's parent chain is created on the **walked** path by today's `ensureParentDirs`, so ADR-818's
pairwise-disjoint key sets hold.

**Public or internal.** `MemoryFileSystem` is public (`src/adapters/memory/index.ts:4`); no type or JSDoc
change in this commit. `walk` is private. **Surface gates tripped:** none mechanical; migration note 15
(rewritten); docs debt `docs/understand/security.md:31-33`.

**Browser (OPFS) impact: none — confirmed.** `src/adapters/browser/browser-file-system.ts:168-173`:
`readlink` and `symlink` refuse `UNSUPPORTED_OPERATION`, and its `lstat` never reports a link (`:112`). The
memory adapter is not in the no-build browser bundle.

**Node-parity oracle.** `test/unit/ports/file-system.contract.ts` runs against `MemoryFileSystem`
(`test/unit/adapters/memory/memory-file-system.test.ts:6-25`) and `NodeFileSystem`
(`test/unit/adapters/node/node-file-system.test.ts`, `symlinkReadEscape: 'allowed'`, `:81`). Add contract rows
beside `:791` ("Given symlink, When stat, Then follows symlink"), every link text **relative** and inside a
subdirectory (an absolute text passes the old root-relative follower and proves nothing):
- leaf: `write(<root>/sub/target.txt)`, `symlink('target.txt', <root>/sub/link)` → `read`, `readUtf8`,
  `readSlice(link, 1, 2)` return the target's bytes; `stat(link).size`; `exists(link)` `true`;
  `lstat(link).isSymbolicLink` `true`;
- `symlink('../top.txt', <root>/sub/up)` → `read(up)` returns `<root>/top.txt`'s bytes; a two-hop relative
  chain → the final target's bytes;
- `symlink('missing.txt', <root>/sub/dangling)` → `exists` `false`; `read` refuses `FILE_NOT_FOUND`;
- `mkdir(<root>/sub/dir)`, a file inside, `symlink('dir', <root>/sub/dir-link)` → `readdir(dir-link)` lists it;
  `stat(dir-link).isDirectory` `true`;
- **intermediate** (U1): `write(<root>/real/f.txt)`, `symlink('../real', <root>/sub/link-dir)` → `read`,
  `readUtf8`, `readSlice`, `stat`, `exists`, `lstat` (`isFile` `true`), `openWithNoFollow(…, 'read')` of
  `<root>/sub/link-dir/f.txt` see `real/f.txt`; `readdir(<root>/sub/link-dir)` lists `f.txt`;
- **writes through a component** (U1), each asserting the bytes at the **real** path afterwards: `write`,
  `writeExclusive`, `writeUtf8`, `appendUtf8`, `writeStream`, `symlink` and `mkdir` under
  `<root>/sub/link-dir/…` (a missing `deep/new/` parent is created under `real/`); `rename` and `atomicRename`
  of `link-dir/a` to `link-dir/b`; `rm(link-dir/b)`; `rmRecursive(link-dir/deep)`;
  `openWithNoFollow(link-dir/f.txt, 'write')`; a two-hop directory chain (`link2 → link-dir → ../real`);
- leaf rules unchanged: `write(<root>/sub/link-dir)` still refuses `PERMISSION_DENIED`,
  `rmRecursive(<root>/sub/link2)` removes the link and keeps `real/`.
The Node run of each row is its parity oracle; the head-symlink interop rows in commit 3 are the end-to-end
one on Node.

**Existing tests and fixtures that touch the old behaviour** (`rg -l '\.symlink\(' test --glob
'!test/integration/**'` plus integration users of the memory adapter). None asserts a non-following memory
read (the only link reads in the memory suite read a path a file has replaced, `:1612`, or a target, `:1716`);
every `exists` on a link there has a live target (`:245`, `:364`, `:558`, `:960`, `:1643`, `:2206`). The set
below must still pass, because production code could have relied on a memory read or write through a link
failing:
- Adapter and port suites: `test/unit/adapters/memory/memory-file-system.test.ts`,
  `test/unit/adapters/node/node-file-system.test.ts`, `test/unit/adapters/node/node-file-system-injected.test.ts`,
  `test/unit/ports/file-system.contract.ts` (via the two adapter suites),
  `test/unit/adapters/snapshot-resolvers/fs-workdir-enumerator.test.ts`,
  `test/unit/repository/wrap-fs-validator.test.ts`, `test/unit/repository/file-system-layout-probe.test.ts`.
- Commands: `test/unit/application/commands/add.test.ts`, `blame.test.ts`, `cherry-pick.test.ts`,
  `grep.test.ts`, `merge.test.ts`, `rebase.test.ts`, `revert.test.ts`, `rm.test.ts`, `stash.test.ts`,
  `status.test.ts`, `internal/repo-state.test.ts`, `internal/resolve-pathspec.test.ts`,
  `internal/working-tree.test.ts`.
- Primitives: `test/unit/application/primitives/apply-changeset.test.ts`, `apply-merge-to-worktree.test.ts`,
  `compare-working-tree-entry.test.ts`, `internal/head-file.test.ts`, `internal/repo-state.test.ts`,
  `internal/symlinked-leading-path.test.ts`, `internal/write-working-tree-file.test.ts`, `ref-store.test.ts`,
  `snapshot/workdir-entry.mutation.test.ts`, `snapshot/workdir-entry.test.ts`,
  `update-config-sections.test.ts`, `walk-working-tree.properties.test.ts`, `walk-working-tree.test.ts`.
- Integration: `test/integration/add-all.test.ts`.
- **`refuseReadOnSymlink` users** (`test/unit/application/primitives/fixtures.ts:322-332`):
  `stash.test.ts:182`, `blame.test.ts:1191`, `grep.test.ts:577`, `compare-working-tree-entry.test.ts:265`,
  `snapshot/workdir-entry.test.ts:229`, `internal/head-file.test.ts:43`. They assert production code never
  reads through a worktree link; they matter more now.
- **`symlinked-leading-path` users** — `internal/symlinked-leading-path.test.ts` and
  `internal/write-working-tree-file.test.ts` pin that checkout refuses to write beneath a symlinked worktree
  directory. That refusal is production code's own lstat walk, not the adapter's; if either goes red, the
  production guard relied on the adapter refusing — fix the guard to be explicit, never weaken the test.

**Traps**
- No references to this plan, the design, ADRs, gap or open-item numbers or the backlog in source or test code.
- **Inert-change risk:** absolute link texts pass before and after; every new row uses relative text in a
  subdirectory, and every write-through row asserts the bytes at the real path (a write that silently created
  a directory at the link's name would otherwise pass a read-back through the same link).
- Do not follow the leaf in any non-read surface; do not change any refusal code here (commit 2).
- Symlink creation in the Node contract run needs OS symlink support; the existing `:791` row already
  requires it.

#### Commit 2 — the memory adapter refuses as the Node adapter maps (U2; ADR-872)

**Decision.** Where an explicit `mapErrno` arm (`src/adapters/node/node-file-system.ts:251-282`) gives the
Node adapter's code, the memory adapter gives the same (design matrix Y4–Y8):

| Condition | Surfaces | Memory before | Memory after | Node errno |
|---|---|---|---|---|
| more than the hop limit (a loop, as a component or a followed leaf) | every surface; `exists` throws | `UNSUPPORTED_OPERATION { operation, reason: 'symlink loop: …' }` (walk), `exists` `true` on a loop leaf | `PERMISSION_DENIED { path }` | `ELOOP` |
| the path is a directory | `read`, `readUtf8`, `readSlice` | `FILE_NOT_FOUND` | `PERMISSION_DENIED` | `EISDIR` |
| the path is absent, or a dangling link | `readdir` | `NOT_A_DIRECTORY` | `FILE_NOT_FOUND` | `ENOENT` |
| an intermediate component is a regular file (or a link to one) | `read`, `readUtf8`, `readSlice`, `stat`, `lstat`, `readlink`, `openWithNoFollow(read)`, `rm`, `rename` source, `rmRecursive`, `exists` (throws) | `FILE_NOT_FOUND`; `rmRecursive` resolves; `exists` `false` | `NOT_A_DIRECTORY { path }` | `ENOTDIR` |

Implementation: the walk's hop refusal becomes `permissionDenied(path)` (drop the `operation` parameter);
the walk refuses `notADirectory(path)` when a non-final component resolves to a file
(`assertTraversable`); `read`'s absent-key branch checks `directories.has` first; `readdir`'s
`!directories.has` branch refuses `fileNotFound(path)` unless a file occupies the key (`notADirectory`);
`exists` lets the two walk refusals propagate. Not changed (design Y10–Y16, ADR-811, O2, O4): create
surfaces' immediate-parent and dangling-component codes, `mkdir` on a link leaf, `rm` of a directory,
`readlink` of a non-link (`FILE_NOT_FOUND`, the port's documented answer), `openWithNoFollow(dir, 'read')`,
the hop limit.

**Public or internal.** `src/ports/file-system.ts:120`'s `readdir` JSDoc ("Throws NOT_A_DIRECTORY if not a
directory") gains "FILE_NOT_FOUND if absent" — a `reports/api.json` change, owed at the phase boundary.
The comments that name memory's old `readdir` code are corrected in this commit (behaviour unchanged, both
codes accepted): `src/application/commands/internal/gc-pipeline.ts:157-170`,
`src/application/primitives/pack-registry.ts:586-590`, `src/application/primitives/internal/shallow-set.ts:36`,
`src/application/primitives/internal/loose-oid-cache.ts:39`, `src/application/primitives/internal/midx-source.ts:97`.
Migration note 22.

**Node-parity oracle.** Contract rows (both adapters), each asserting `data.code` exactly: a mutual loop
`la ↔ lb` → `read(la)`, `stat(la)`, `readdir(la)`, `read(la/x)`, `lstat(la/x)`, `write(la/x)`, `rm(la/x)`
refuse `PERMISSION_DENIED`, `exists(la)` rejects `PERMISSION_DENIED`; `read(dir)`, `readUtf8(dir)`,
`readSlice(dir, 0, 1)` → `PERMISSION_DENIED`; `readdir(missing)`, `readdir(dangling-link)` → `FILE_NOT_FOUND`;
`read(file/x)`, `stat(file/x)`, `lstat(file/x)`, `readlink(file/x)`, `rm(file/x)`, `rename(file/x, y)`,
`rmRecursive(file/x)` → `NOT_A_DIRECTORY`, `exists(file/x)` rejects `NOT_A_DIRECTORY`. Every row is isolated
(one condition, one surface, `try`/`catch`, field-by-field `data`).

**Existing tests that flip or may flip.**
- `test/unit/adapters/memory/memory-file-system.test.ts`: `:331-350` (readdir of a missing path →
  `NOT_A_DIRECTORY` → **flips** to `FILE_NOT_FOUND`), `:563-590` (mutual loop → `UNSUPPORTED_OPERATION`
  `operation: 'stat'` → **flips** to `PERMISSION_DENIED`), `:591-635` (40-hop row → **flips** its code, keeps its
  boundary), any row reading a directory or a path beneath a file (`rg -n "readdir|When read" …`).
- `test/unit/ports/file-system.contract.ts:702` ("Given non-directory path, When readdir, Then throws
  NOT_A_DIRECTORY") uses a regular file (`not-a-dir.txt`) and stays green.
- Suites that assert memory-produced `NOT_A_DIRECTORY` for absence (run them; keep production code accepting
  both codes): `test/unit/application/commands/maintenance.test.ts`, `test/unit/application/primitives/pack-registry.test.ts`,
  `shallow-file.test.ts`, `internal/shallow-set.test.ts`, `loose-oid-cache.test.ts`, `internal/midx-source.test.ts`,
  `config-read.test.ts`, `apply-changeset.test.ts`, `atomic-write.test.ts`.
- Production `exists` calls on a path beneath a regular file now throw on memory as on Node. A red suite here
  is production code that already threw on Node: fix the production call site to Node's behaviour (catch
  `NOT_A_DIRECTORY` where git tolerates it), recording the site in the part notes — never soften the adapter.

**Traps**
- No references to this plan, the design, ADRs or open items in source or test code.
- Assert the exact code in every new row (ADR-824's shape); one condition per row.
- Do not change create surfaces' parent codes or `mkdir`'s leaf (ADR-811; O2, O4 undecided).

#### Commit 3 — read-through (F)

**Design excerpt.** git's `read_ref_internal` (`refs/files-backend.c:516-570`): a symlinked `HEAD` whose
link text starts with `refs/` **and** passes `check_refname_format` is a symref; any other text falls through
to an ordinary open of the path, which follows the link — `ENOENT` is a missing ref, a directory fails the
read. Discovery (`validate_headref`) checks only the `refs/` prefix; tsgit's gate already matches
(`src/application/primitives/internal/repo-state.ts:131-133` `hasUsableHead` → `isRefsLinkText`,
`src/domain/repository/head-ref.ts:47-48`). Pins (git 2.55.0; `side` ≠ `main`):

| Row | Link text → target | `rev-parse HEAD` | `symbolic-ref HEAD` | `commit --allow-empty` |
|---|---|---|---|---|
| F1 | `refs/heads/a..b` → absent | 128 | 128 | 0; `.git/HEAD` replaced by a regular file (tsgit: recorded residual) |
| F2 | `refs/heads/a..b` → file with `side`'s oid | `side` | 128 | 0; `HEAD` becomes a regular file; target file unchanged |
| F3 | `refs/heads/a..b` → file `ref: refs/heads/side` | `side` | `refs/heads/side` | 0; `HEAD` stays a symlink; `side` advances |
| F4 | `refs/heads/../heads/side` (resolves to `refs/heads/side`) | `side` | 128 | 0; regular file |
| F5 | `refs/heads/x.lock` → file with an oid | the oid | 128 | 0; regular file |
| F6 | `refs/heads/a..b` → a directory | 128 | 128 | 128 `cannot lock ref 'HEAD'` |
| F7 | `refs/heads/valid-dangling` → absent | 128 | `refs/heads/valid-dangling` | 0; link stays; branch created (tsgit agrees today) |
| F8 | `refs/heads/sp ace` → file with an oid | the oid | 128 | 0; regular file |

`status -b` reports `(detached)` for F1, F2, F4, F5, F6, F8, `side` for F3, `valid-dangling` for F7; F1 and
F6 add `(initial)`.

**Current code (verified)** — `src/application/primitives/ref-store.ts`:
- `:408-416` docblock; `:417-431` `resolveHeadDirect()` inside `createFilesRefStore` (`:373`): the symlink arm
  `:419-422` runs `validateRefName(head.linkText.replace(/\\/g, '/'))` and throws `INVALID_REF` otherwise;
  the file arm `:423-428` maps `parseLooseRef(head.content)` to `symbolic` / `direct`; `:429-430`
  `unusable` → `missing` only for `FILE_NOT_FOUND`.
- `:433-446` `resolveDirect(name)` repeats the same `parseLooseRef` mapping for loose content (`:436-442`).
- `:314-316` `isFileNotFound(err)` (structural). `:24` imports `parseLooseRef` (`src/domain/refs/loose-ref.ts:18`,
  throws `INVALID_REF` or `INVALID_OBJECT_ID`). `:36` imports `readHeadFile`.
- `isSafeRefName` (`src/domain/refs/ref-validation.ts:64`), `isRefsLinkText` (`head-ref.ts:47`).

**Target.**
```ts
// module level — the `parseLooseRef` mapping both arms share
const fromLooseContent = (content: string): ResolveDirectResult => {
  const parsed = parseLooseRef(content);
  return parsed.type === 'symbolic'
    ? { kind: 'symbolic', target: parsed.target }
    : { kind: 'direct', id: parsed.target };
};

// inside createFilesRefStore
async function resolveHeadDirect(): Promise<ResolveDirectResult> {
  const head = await readHeadFile(ctx);
  if (head.kind === 'symlink') return resolveHeadSymlink(head.linkText);
  if (head.kind === 'file') return fromLooseContent(head.content);
  if (isFileNotFound(head.cause)) return { kind: 'missing' };
  throw head.cause;
}
/** read_ref_internal's symlink rule: a refs/-prefixed valid refname is a symref; any other text is read through. */
async function resolveHeadSymlink(linkText: string): Promise<ResolveDirectResult> {
  const text = linkText.replace(/\\/g, '/');
  if (isRefsLinkText(text) && isSafeRefName(text)) return { kind: 'symbolic', target: text as RefName };
  return resolveFollowedHead();
}
/** The file the link points to, read fresh on every call and never slotted: the slot's identity is the
 *  link's own lstat, which a rewrite of the target does not change. */
async function resolveFollowedHead(): Promise<ResolveDirectResult> {
  const path = `${ctx.layout.gitDir}/HEAD`;
  try {
    if ((await ctx.fs.stat(path)).isDirectory) return { kind: 'missing' };
    return fromLooseContent(await ctx.fs.readUtf8(path));
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'missing' };
    throw err;
  }
}
```
`resolveDirect`'s loose arm (`:436-442`) calls `fromLooseContent` too. The directory check exists for Node,
whose `readUtf8` maps `EISDIR` to `PERMISSION_DENIED`. `internal/head-file.ts` and the gate are unchanged;
HEAD writes are unchanged (a `direct` result makes `commit` write `HEAD` itself — lock-and-rename replaces
the link; a `symbolic` result advances the branch and keeps the link). Applies to primitive-only sessions.

**Residuals (ADR-868), pinned as titled rows:** F1 and F6 — the read-through yields `missing`, and
`readHeadRaw` (`repo-state.ts:336`) turns a missing `HEAD` into `REF_NOT_FOUND`, so `status` and (F1)
`commit` refuse where git reports a detached `(initial)` head and writes a detached `HEAD`.

**Public or internal — decided.** `fromLooseContent`, `resolveHeadSymlink`, `resolveFollowedHead`: module
private. **Surface gates tripped:** none. Docs debt: `docs/use/primitives/internals.md:66`.

**Adapter (gap G1 and U1 resolved by commit 1, U2 by commit 2).** After them the memory adapter's `stat` and
`readUtf8` follow the link relative to `<gitDir>` and refuse a directory read `PERMISSION_DENIED`, exactly as Node
does, so the rows below use the real adapter — no test double.

**Tests (unit)** — `test/unit/application/primitives/ref-store.test.ts` after `:989-1022` (the two existing
symlink rows stay: a valid refname link text is symbolic, dangling or not). New rows on
`await buildSeededContext()` (the real memory adapter), symlink written with `ctx.fs.symlink(linkText,
'/repo/.git/HEAD')`, targets written under `/repo/.git/`, `sut = createRefStore(ctx)`,
`result = await sut.resolveDirect('HEAD')`:
- link `refs/heads/a..b`, target absent → `{ kind: 'missing' }`;
- link `refs/heads/a..b`, target holds an oid → `{ kind: 'direct', id }` (the row that proves the
  read-through; F1's `missing` alone would pass on any adapter);
- target holds `ref: refs/heads/side` → `{ kind: 'symbolic', target: 'refs/heads/side' }`;
- link `refs/heads/../heads/side` → `direct` with `side`'s oid;
- link `refs/heads/x.lock` → `direct`; link `refs/heads/sp ace` → `direct`;
- target is a directory → `missing`. After commit 2 the memory adapter's `readUtf8` of a directory refuses
  `PERMISSION_DENIED`, as Node's `EISDIR` mapping does, so this row on the real adapter fails if the `isDirectory`
  check is dropped (it would surface `PERMISSION_DENIED`). Node interop F6 is the end-to-end oracle;
- link text `refs\heads\main` (backslashes) → `symbolic` `refs/heads/main` (normalisation kept);
- target content malformed (`garbage`) → refuses `INVALID_OBJECT_ID` (the `parseLooseRef` mapping; assert
  `data.code`);
- a Context whose `stat` rejects `permissionDenied` for the HEAD path → `resolveDirect` rejects
  `PERMISSION_DENIED` (not `missing`);
- "Given a gate already validated HEAD on this Context": `await validateHead(ctx)`
  (`src/application/primitives/internal/head-file.ts:128`) on the **same** Context object, `resolveDirect`
  → `direct` X; rewrite the target file to oid Y (the link is untouched); `resolveDirect` again → `direct`
  Y (the followed content is never slotted).

**Tests (interop)** — extend `test/integration/head-symlink-interop.test.ts` (existing H1 `:53-125`, H2
`:127-165`, helper `replaceHeadWithSymlink(dir, linkText)` `:46-50`). Add one top-level
`describe('Given HEAD is a symlink whose link text is not a valid refname')` with its own `beforeAll`
(60 000 ms): a base repository, `main` with one commit, `side` with a second commit, `commit.gpgsign=false`,
auto-maintenance disabled; each row copies the base (twins for commit rows: git commits in one copy, tsgit
in the other). tsgit reads through `createNodeContext({ workDir })`, `revParse`/`resolveRef(ctx, 'HEAD')`,
`currentBranchRef` (`repo-state.ts:347`), `commit(ctx, { message, allowEmpty: true })`
(`src/application/commands/commit.ts:66-70`). For each commit row compare, in both copies,
`lstatSync('.git/HEAD').isSymbolicLink()`, the target file's bytes and `git rev-parse HEAD^`.

| Row | Setup | Assert (git and tsgit agree unless titled residual) |
|---|---|---|
| F2 | write `.git/refs/heads/a..b` = `side` oid; link `refs/heads/a..b` | HEAD resolves to `side`; `symbolic-ref` 128 / `currentBranchRef` `undefined`; commit → regular `HEAD` file, target unchanged, `HEAD^` = `side` |
| F3 | target content `ref: refs/heads/side\n` | HEAD = `side`; `symbolic-ref` → `refs/heads/side` both; commit advances `side`, link kept |
| F4 | link `refs/heads/../heads/side` | HEAD = `side`; not symbolic; commit → regular file, `refs/heads/side` unchanged |
| F5 | `.git/refs/heads/x.lock` = `main` oid; link `refs/heads/x.lock` | HEAD = `main`; not symbolic; commit → regular file |
| F8 | `.git/refs/heads/sp ace` = `main` oid; link `refs/heads/sp ace` | same as F5 |
| F7 | link `refs/heads/valid-dangling`, no target | `symbolic-ref` and `currentBranchRef` → `refs/heads/valid-dangling`; commit creates the branch, link kept |
| F1 | link `refs/heads/a..b`, no target | `rev-parse HEAD` 128 / `resolveRef` refuses `REF_NOT_FOUND`; **residual-titled:** git `status --porcelain=v2 --branch` exit 0 with `# branch.oid (initial)` and `# branch.head (detached)`, git `commit` exit 0 writing a regular `HEAD`, while tsgit `status` and `commit` refuse `REF_NOT_FOUND` |
| F6 | `mkdir .git/refs/heads/a..b`; link `refs/heads/a..b` | `rev-parse` 128 / `resolveRef` refuses; `commit` refuses in both (git 128 `cannot lock ref 'HEAD'`); **residual-titled:** git `status` exit 0 detached, tsgit `status` refuses |

**Property tests — none.** Resolution arms over a handful of filesystem states, enumerated by example rows.

**Traps**
- No references to this plan, the design, ADRs, matrix rows (F1…) or the backlog in source or test code.
- Do not call `branchList`/`enumerateRefs` in F rows: a loose ref file named `a..b` or `sp ace` makes ref
  enumeration refuse or skip, a different behaviour from the one under test.
- On a git-created repository, loose ref files are writable; loose **object** files are `0444` (not used here).
- The slot keeps the link text and the link's own identity (`head-file.ts:95-98`); never cache the followed
  content in it.
- `isRefsLinkText` already normalises backslashes; pass it the normalised text anyway so the same string
  reaches `isSafeRefName`.
- A primitive-only session with a non-`refs/` link text now reads through instead of refusing — the gate
  (`hasUsableHead`) still refuses such a repository before any command.

#### Commit 4 — the HEAD slot's gate-to-gate epoch (M)

**Design excerpt (DC-M1 a).** `validateHead` (`head-file.ts:128-146`, every gate) marks the slot
`trusted`; `readHeadFile` (`:156-164`) serves a trusted slot with zero I/O; nothing clears it at command end
(no command-end hook exists; command functions called directly bypass the facade). The epoch is therefore
**gate to gate** on every adapter: trusted from a gate until the next gate, tsgit's own `HEAD` write
(`invalidateHeadSlot`, `:167-169`) or an `lstat` failure at a gate; primitive reads between commands are
served from it. The words say "command"; fix the words and pin the behaviour (the shape of ADR-850's config
epoch). No code change.

**Files**
- `src/application/primitives/internal/head-file.ts:120-127` (`validateHead` docblock: "that is the
  same-command sharing `readHeadFile` relies on; only cross-command reuse needs `identity !== undefined`")
  and `:148-155` (`readHeadFile` docblock: "one `validateHead` already populated in THIS command") → state
  the gate-to-gate epoch; the `ino === 0` rule decides whether the **next gate** re-reads content, not
  whether reads before it trust the slot.
- `docs/design/session-caches-per-command-floor.md:1307` ledger row L1 ("trusted for the rest of that
  command" / "Within one command after its gate") → gate-to-gate wording; add point 9, dated 2026-09-14, to
  its Post-review corrections block (`:24-56`) saying the same in one paragraph.
- `docs/use/primitives/internals.md:66` — the sentence "always marks the slot `trusted` for the rest of the
  command" and "reused only within that one command" → gate-to-gate wording. (The F read-through sentence on
  the same line is docs-phase debt; edit only the epoch wording here.)

**Tests** — `test/unit/application/primitives/internal/head-file.test.ts` (existing blocks `:219`, `:241`,
`:265`, `:291`; fixtures `withNodeIdentity` `fixtures.ts:354`, `instrumentedContext` `:394`):
- "Given a gate validated HEAD on the memory adapter and HEAD was rewritten raw afterwards": `validateHead`
  → `writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/other\n')` → `readHeadFile` returns the old content with
  zero fs calls (instrumented) → `validateHead` returns the new content.
- Same on `withNodeIdentity` (`ino !== 0`): after the raw rewrite flip `identity.ino` (a lock-and-rename
  changes the inode) → `readHeadFile` still returns the old content → the next `validateHead` returns the
  new content.
- Characterization sanity step: see the addendum probes table.

**Traps**
- No references to this plan, the design, ADRs or findings in docstrings or tests (the design doc and
  `internals.md` are documents and may name the decision).
- The pin passes today by design; it is not a RED step. The sanity mutation is local and reverted.
- Do not change `readHeadFile`'s behaviour (DC-M1 b was rejected).

### TDD steps

**Commit 1 (memory adapter walks every component)**
1. **RED** — contract row: relative link in a subdirectory, `read(link)` returns the target's bytes. Fails on the memory
   run (`FILE_NOT_FOUND`); passes on the Node run (the parity oracle).
2. **RED** — contract row: `read(<root>/sub/link-dir/f.txt)` through a symlinked directory. Fails on memory.
3. **GREEN** — `walk`; `read`, `readSlice`, `readUtf8`, `stat`, `exists`, `readdir` walk `follow`; delete `statFollowing`.
4. **RED/GREEN** — `stat.size` (relative text against the link's directory), `../` target, two-hop chain, dangling link,
   link to a directory, `lstat`/`openWithNoFollow` through a component (walk `no-follow`).
5. **RED** — contract row: `write(<root>/sub/link-dir/w.txt)` lands at `real/w.txt`. Fails on memory
   (`NOT_A_DIRECTORY` from `assertAncestorChainFree`).
6. **GREEN** — every create, `rm`, `rename`, `atomicRename`, `rmRecursive`, `chmod` surface walks `no-follow`; remaining
   write-through rows, leaf rules unchanged.
7. **Regression** — `memory-file-system.test.ts:563-635` unchanged and green; the enumerated suites in batches (Gate).

**Commit 2 (refusal codes)**
8. **RED** — contract row: mutual loop, `read(la)` → `PERMISSION_DENIED`. Fails on memory.
9. **GREEN** — the walk's hop refusal becomes `permissionDenied(path)`; flip `:563-635`'s code assertions.
10. **RED/GREEN** — directory read, missing and dangling `readdir`, each beneath-a-file row, `exists` throwing twice.
11. **REFACTOR** — the port's `readdir` JSDoc and the five stale comments.
12. **Regression** — the absence-code suites listed under commit 2, then the commit-1 batches again.

**Commit 3 (F)**
13. **RED** — `ref-store.test.ts`: link `refs/heads/a..b` → target oid resolves `direct`. Fails: `INVALID_REF`
    (`ref name must not contain ..`).
14. **RED** — target `ref: refs/heads/side` resolves symbolic `side`; target directory → `missing`; absent →
    `missing`. Fail: `INVALID_REF`.
15. **GREEN** — `fromLooseContent`, `resolveHeadSymlink`, `resolveFollowedHead`; `resolveDirect` uses
    `fromLooseContent`.
16. **RED/GREEN** — `..` path, `.lock`, space, backslash, malformed content, the directory row on the real adapter,
    `stat` permission failure, and the post-gate target rewrite rows.
17. **RED/GREEN** — interop rows F2, F3, F4, F5, F8, F7, then the residual-titled F1 and F6.
18. **REFACTOR** — `resolveHeadDirect`'s docblock (`:408-416`) states the read-through rule.

**Commit 4 (M)**
19. **Characterization** — the two epoch rows (pass first time); run the sanity mutation from the probes table,
    watch them fail, revert.
20. **Docs** — the two docstrings, ledger L1 + correction point 9, `internals.md:66` epoch wording.

### Gate

Commit 1 (memory adapter walk) and commit 2 (refusal codes) — the same batches; commit 2 adds the last batch:
```
npx vitest run --maxWorkers=2 test/unit/adapters/memory/memory-file-system.test.ts test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/snapshot-resolvers/fs-workdir-enumerator.test.ts test/unit/repository/wrap-fs-validator.test.ts test/unit/repository/file-system-layout-probe.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/add.test.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/grep.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/rebase.test.ts test/unit/application/commands/revert.test.ts test/unit/application/commands/rm.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/stash.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/internal/repo-state.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts
npx vitest run --maxWorkers=2 test/unit/application/primitives/internal/head-file.test.ts test/unit/application/primitives/internal/repo-state.test.ts test/unit/application/primitives/internal/symlinked-leading-path.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/snapshot/workdir-entry.mutation.test.ts test/unit/application/primitives/snapshot/workdir-entry.test.ts test/unit/application/primitives/update-config-sections.test.ts
npx vitest run --maxWorkers=2 test/unit/application/primitives/walk-working-tree.properties.test.ts test/unit/application/primitives/walk-working-tree.test.ts
npx vitest run test/integration/add-all.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/maintenance.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/shallow-file.test.ts test/unit/application/primitives/internal/shallow-set.test.ts test/unit/application/primitives/loose-oid-cache.test.ts test/unit/application/primitives/internal/midx-source.test.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/atomic-write.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/adapters/memory/memory-file-system.ts test/unit/ports/file-system.contract.ts test/unit/adapters/memory/memory-file-system.test.ts
npx cspell --no-progress src/adapters/memory/memory-file-system.ts test/unit/ports/file-system.contract.ts test/unit/adapters/memory/memory-file-system.test.ts
```
Commit 2 adds to both the biome and cspell lists: `src/ports/file-system.ts`
`src/application/commands/internal/gc-pipeline.ts` `src/application/primitives/pack-registry.ts`
`src/application/primitives/internal/shallow-set.ts` `src/application/primitives/internal/loose-oid-cache.ts`
`src/application/primitives/internal/midx-source.ts`, plus any production file an `exists` fix touched.

Commit 3 (F):
```
npx vitest run --maxWorkers=2 test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/internal/head-file.test.ts test/unit/application/primitives/internal/repo-state.test.ts test/unit/application/primitives/resolve-ref.test.ts test/unit/application/primitives/update-ref.test.ts
npx vitest run test/integration/head-symlink-interop.test.ts
npx vitest run test/integration/head-identity-freshness-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/ref-store.ts test/unit/application/primitives/ref-store.test.ts test/integration/head-symlink-interop.test.ts
npx cspell --no-progress src/application/primitives/ref-store.ts test/unit/application/primitives/ref-store.test.ts test/integration/head-symlink-interop.test.ts
```

Commit 4 (M):
```
npx vitest run --maxWorkers=2 test/unit/application/primitives/internal/head-file.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/internal/head-file.ts test/unit/application/primitives/internal/head-file.test.ts
npx cspell --no-progress src/application/primitives/internal/head-file.ts test/unit/application/primitives/internal/head-file.test.ts docs/design/session-caches-per-command-floor.md docs/use/primitives/internals.md
```

**Owed at the phase boundary:** `npm run docs:json` + `reports/api.json` (commit 2: the port's `readdir` JSDoc);
`check:size` and `check:tarball` (the memory walk enters the tarball and `Facade (memory shim)`). **Surface gates
tripped:** none beyond the api report.

### Commit

Commit 1: `fix(adapters): resolve symlinks in every path component on the memory adapter`

Commit 2: `fix(adapters): refuse as the node adapter does on the memory adapter`

Commit 3: `fix(refs): read through a symlinked HEAD whose link text is not a valid refname`

Commit 4: `test(refs): pin the HEAD slot's gate-to-gate trust epoch and document it`

## Part 18 — `updateRef` deletes and dereferences as git's ref transaction does: the null id and absent refs, packed refs under git's locks, the coupled `HEAD` entry, symbolic refs (gap G2 b, U3, U4, U6, U5; ADR-871) — 4 commits

### Context

**Depends on Part 14** (`src/application/primitives/update-ref.ts:6` imports the domain `errorDataCode`).
Independent of Parts 15–17 in code. **Must precede Part 19**: C's placement skips exactly the delete forms this
part defines, and Part 19's fixtures write refs through the chain this part introduces. Commits land in order:
each later commit reuses the store behaviour the earlier ones pin (the no-op and locked delete, then the
coupled entry, then the chain).

Design: "Ref write and delete semantics, and memory-adapter parity (U1–U6)" — matrices S (symrefs), X
(deletes), R (commands), Q (`packed-refs`); "Change — U3/U4/U5/U6"; the two caller audits. Decisions: ADR-871.
**Open items O1 and O3 are undecided** — the commits carry both outcomes where they apply; implement the one
the session names when it spawns this part, and stop if none is named.

**Shared interop file, created by commit 1:** `test/integration/ref-transaction-interop.test.ts`. `@proves`:
surface `updateRef, fetch, branch.delete, tag.delete, remote.remove`; bucket `cross-tool-interop`; unique
"ref updates dereference symbolic refs and delete as git's ref transaction does"; interopSurface `updateRef`.
`beforeAll` (60 000 ms) builds two bases with git — files and `git init --ref-format=reftable` — each with
commits `C1`, `C2` on `main`, `user.name A` / `user.email a@x`, `commit.gpgsign=false`,
`tag.gpgsign=false`; every symref the rows need is created **in the base with git** (`git symbolic-ref`), so
both copies start from identical `logs/…` bytes — git's `symbolic-ref` writes its own log line (`0{40}
<target>` with an empty message), which `writeSymbolicRef` does not, and a row must never depend on that
difference. Each row copies a base into `peer` (git) and `ours` (tsgit, `createNodeContext({ workDir: ours })`),
runs `tryRunGitWithExit(['-C', peer, 'update-ref', …])` and `updateRef(ctx, …)`, and compares exit status with
refusal data, `git show-ref --verify` presence, `git symbolic-ref` output, and the **appended** bytes of every
`logs/…` file the row names (reftable: after `git refs migrate --ref-format=files` on a copy of each side).
Pin identity and time as `test/integration/reflog-interop.test.ts:1364` does (`vi.spyOn(Date, 'now')` plus a
pinned `GIT_COMMITTER_DATE`, offset `+0000`); restore the spy in `afterEach`.

#### Commit 1 — a null new id deletes the ref, and a delete of an absent ref is a no-op (gap G2 b, U3)

**Decision.** `updateRef(ctx, name, zeroOid(ctx.hashConfig), { reflogMessage })` takes the delete path exactly
as `delete: true` does (git marks a null new value `REF_DELETING`; `!is_null_oid` keeps it unverified). Both
stores' deletes of an absent ref succeed without writing (X1). No `logs/HEAD` entry yet (commit 3), no lock yet
(commit 2), no dereferencing yet (commit 4).

**Pins** (plan pins "Null new id …" rows, design X1):

| Row | git | tsgit today | after this commit |
|---|---|---|---|
| existing loose branch `b` with a log, `update-ref refs/heads/b 0{40}` | 0; ref gone; `logs/refs/heads/b` removed | writes `0{40}` into `refs/heads/b` | ref gone; log removed |
| absent ref, null id; `update-ref -d refs/heads/gone` | 0; nothing created | null ref written / `REF_NOT_FOUND` | no-op on both paths |
| matching old value | 0; deleted; log removed | null ref written | deleted; log removed |
| mismatching old value | 128 `cannot lock ref 'refs/heads/d': is at <oid> but expected <old>` | `REF_UPDATE_CONFLICT` | `REF_UPDATE_CONFLICT { name, expected, actual }`; ref and log kept |
| old value on an absent ref | 128 `unable to resolve reference` | `REF_UPDATE_CONFLICT` | `REF_UPDATE_CONFLICT` with `actual: 'absent'` |
| `expected: 'absent'` on absent / existing | 0 / 128 `reference already exists` | no-op write / conflict | no-op / conflict |
| reftable existing / absent | 0, ref and log gone / 0 | null ref / `REF_NOT_FOUND` | deleted, logs tombstoned / no-op |
| packed-only ref | 0; line removed (Q7) | null ref written loose | `UNSUPPORTED_OPERATION` `delete-packed-ref` — **residual until commit 2** |
| symref `refs/heads/sym → x` | 0; `x` deleted, `sym` kept (X4) | null written into `sym` | `sym` removed — **residual until commit 4** |
| branch `HEAD` points at | `logs/HEAD` gains `<old> 0{40} why` (X2) | null ref written | no entry — **residual until commit 3** |

**Current code (verified).** `src/application/primitives/update-ref.ts:17-49` `updateRef`: `validateRefName`
`:26`; `current = store.resolveDirect(name)` `:29`; `head = resolveHeadForCoupling(store)` `:33`; the CAS
`:35-40`; `delete: true` → `applyRefUpdates([{ kind: 'delete', name }])` `:42-45`; otherwise `refUpdatesFor`
`:47-48` (`:58-73`). Files backend delete: `src/application/primitives/ref-store.ts:836-858` `applyDelete`
(loose file + `removeReflogFile` `:666-671`; packed-only refuses `delete-packed-ref` `:850-856`; absent refuses
`refNotFound` `:857`). Reftable: `src/application/primitives/reftable-transaction.ts:490-501`
`applyDeleteRecords` (`refNotFound` at `:497`). `UpdateRefOptions`: `src/application/primitives/types.ts:103-118`.

**Target.**
```ts
export async function updateRef(ctx: Context, name: RefName, newId: ObjectId, options: UpdateRefOptions): Promise<void> {
  validateRefName(name);
  const store = getRefStore(ctx);
  const current = await store.resolveDirect(name);
  const head = await resolveHeadForCoupling(store);
  assertExpected(name, options.expected, current);                // today's :35-40, extracted
  if (isDelete(ctx, newId, options)) return store.applyRefUpdates([{ kind: 'delete', name }]);
  const oldId = current.kind === 'direct' ? current.id : zeroOid(ctx.hashConfig);
  await store.applyRefUpdates(refUpdatesFor(name, newId, oldId, options.reflogMessage, head));
}

const isDelete = (ctx: Context, newId: ObjectId, options: UpdateRefOptions): boolean =>
  options.delete === true || newId === zeroOid(ctx.hashConfig);
```
`applyDelete` drops its `throw refNotFound(update.name)` (`:857`) for a bare `return`; `applyDeleteRecords` returns
before pushing any record when `stack.lookup(name) === undefined`. `refNotFound` stays imported where other code
uses it. `isDelete` compares against the zero id **of the context's width** (`zeroOid`,
`src/domain/objects/object-id.ts:87`); a 40-zero id on a sha256 Context is not the null id.

**Public or internal.** No new export; types unchanged; behaviour changes (migration notes 16, 19).

**Tests (unit)** — `test/unit/application/primitives/update-ref.test.ts`:
- existing loose ref with a reflog (assert the log exists in Arrange), null id → ref file gone, reflog file gone;
- absent ref, null id → nothing created, no throw; with `expected: 'absent'` → same;
- matching `expected` → deleted; mismatching → `REF_UPDATE_CONFLICT`, `name`, `expected`, `actual` asserted field
  by field, ref and log unchanged; `expected: <id>` on an absent ref → `actual: 'absent'`; `expected: 'absent'` on an
  existing ref → conflict;
- sha256 Context: `'0'.repeat(64)` deletes; `'0'.repeat(40)` is not the null id (it takes the write path);
- `:302-318` ("delete=true on a ref that exists in neither loose nor packed storage" → `REF_NOT_FOUND`) **flips**:
  resolves, nothing created;
- `:278-300` (packed-only → `UNSUPPORTED_OPERATION`) stays until commit 2; add the null-id twin beside it;
- a symbolic ref, null id → the symref file is removed (residual title until commit 4).
- `test/unit/application/primitives/ref-store.test.ts:500-521` ("delete update on a ref that exists in neither …"
  → `REF_NOT_FOUND`) **flips** to a resolving no-op.
- `test/unit/application/primitives/reftable-transaction.test.ts:438-466` (delete of an absent ref →
  `REF_NOT_FOUND`) **flips**: no record appended (assert the table count is unchanged).
- `test/unit/application/primitives/reftable-ref-store.test.ts`: existing ref, null id through `updateRef` on a
  reftable Context → `resolveDirect` `missing`, `hasReflog` `false`.
- `test/unit/application/commands/branch.test.ts`, `tag.test.ts`: the "not found" rows (`branchNotFound`,
  `tagNotFound`) stay green — the commands' own pre-checks, R1/R2.

**Tests (interop)** — create `test/integration/ref-transaction-interop.test.ts` (shared setup above). Rows: existing
ref; absent ref (null id and `-d`); matching old; mismatching old (git's `is at <oid> but expected <old>`
reconstructed from `data.actual`/`data.expected`); old value on absent; `expected: 'absent'` on absent and on
existing; reftable existing and absent. Residual-titled until their commit: packed-only (2), symref (4), `HEAD`
entry (3) — each written so the later commit flips the title and the assertion, never duplicates the row.

**Traps**
- No references to this plan, the design, ADRs, gap/open-item numbers or the backlog in source or test code.
- **Inert-change risk:** a "log removed" row on a ref that never had a log passes vacuously.
- `REF_UPDATE_CONFLICT`'s data field is `name` (`src/domain/refs/error.ts:53-57`), not `ref`.

#### Commit 2 — a packed ref's delete rewrites `packed-refs` under git's locks (U4)

**Decision.** The files backend's delete takes the loose ref's lock (when its directory exists), then
`packed-refs.lock`; when `packed-refs` holds the name it is rewritten without it; then the loose file and its
log go. `fetch --prune`'s packed-only catch is deleted. The reftable backend is unchanged. Design "Change — U4",
pins Q1–Q14, X13, R8 (packed-only part).

**Pins used by the rows** (design Q, X13): Q1 packed-only delete (new inode); Q2 loose-and-packed — both gone;
Q3 annotated tag — its `^` line goes; Q4 loose-only — `packed-refs` untouched (same inode and mtime); Q5
`packed-refs.lock` held — every delete refuses, the absent and null-id forms included, with no `packed-refs` file
too; Q6 a non-delete ignores it; Q8 header canonicalised; Q9 sorted; Q10 lines and `^` values copied, nothing
peeled, no object read; Q11 last ref → header-only file (46 bytes); Q12 malformed → refused, nothing changed;
X13 `<ref>.lock` held → `cannot lock ref`, for an existing and an absent name; the nested absent delete leaves no
`refs/heads/deep/`.

**Current code (verified).** `applyDelete` `src/application/primitives/ref-store.ts:836-858`; `loadPackedRefs`
`:378-395` (mtime-keyed `packedCache`, `:374`); `removeReflogFile` `:666-671`; `packRefs` `:917-952` (unlocked
`writeUtf8`, `:940` — unchanged). `atomicWriteFile` `src/application/primitives/atomic-write.ts:20-47`;
`refLocked` `src/domain/refs/error.ts:78-79`; `RESOURCE_LOCKED` `src/domain/error.ts:37-42` (built inline at
`src/application/primitives/internal/index-lock.ts:25-27`); `packedRefsPath` / `commonGitDir` / `lockSuffix`
`src/application/primitives/path-layout.ts:56`, `:41`, `:116`. `parsePackedRefs` / `serializePackedRefs`
`src/domain/refs/packed-refs.ts:18-29`, `:92-113` (`''` for zero entries, `:93-95`), `buildHeaderLine` `:115-129`. Prune:
`src/application/commands/fetch.ts:373-403` with the catch `:389-400` and `isPackedRefDeleteError` `:406-411`.

**Target.**
```ts
// src/domain/refs/packed-refs.ts — not added to src/domain/refs/index.ts
/** git's packed-refs rewrite without `name`: canonical header, sorted, surviving lines and peeled values
 *  copied verbatim, the header alone when nothing is left. */
export function packedRefsWithout(content: string, name: RefName): string {
  const { entries } = parsePackedRefs(content);
  const kept = entries.filter((entry) => entry.name !== name);
  return kept.length === 0 ? `${CANONICAL_HEADER}\n` : serializePackedRefs({ entries: kept, peeling: 'fully', sorted: true });
}

// src/application/primitives/atomic-write.ts
/** Hold `<path>.lock` for `body`; `commit` writes the lock and renames it onto `path`; an uncommitted lock is
 *  removed on every exit. A held lock refuses through `onLocked`. */
export async function withLockFile(ctx: Context, path: string, onLocked: (lockPath: string) => TsgitError,
  body: (commit: (content: Uint8Array) => Promise<void>) => Promise<void>): Promise<void>;

// src/application/primitives/ref-store.ts — createFilesRefStore
async function applyDelete(update: Extract<RefUpdate, { kind: 'delete' }>): Promise<void> {
  await checkExpected(update.name, update.expected);
  const loose = looseRefPath(refDir(update.name), update.name);
  await withLooseRefLock(loose, update.name, () =>
    withLockFile(ctx, packedRefsPath(commonGitDir(ctx)), packedRefsLocked, (commit) =>
      removeEverywhere(update.name, loose, commit)));
}
```
- `CANONICAL_HEADER` is `serializePackedRefs`'s own `buildHeaderLine` output for `{ peeling: 'fully', sorted:
  true }` — reuse it (export the builder module-privately or compute it once), never retype the literal.
- `withLooseRefLock` takes `<loose>.lock` through `withLockFile` with `() => refLocked(name)` only when
  `ctx.fs.stat(parentOf(loose))` reports a directory; `FILE_NOT_FOUND` / `NOT_A_DIRECTORY` there skip the lock
  (no directory, no lock can exist; creating one would leave `refs/heads/deep/` behind).
- `packedRefsLocked = (path) => new TsgitError({ code: 'RESOURCE_LOCKED', resource: 'ref', path })`.
- `removeEverywhere`: read `packed-refs` (absent → skip); `parsePackedRefs` refusal propagates before any
  commit; when an entry has the name, `commit(encode(packedRefsWithout(content, name)))` and `packedCache =
  undefined`; then `rm` the loose file if present, `removeReflogFile(name)`, and `invalidateHeadSlot(ctx)` when
  `name` is `HEAD` (as `applySet` does, `:821`). Every function under 20 lines.
- Order is git's (packed first, loose second): a failure between them leaves the loose file holding the current
  value, never resurrecting an older packed one.
- `fetch.ts`: delete `isPackedRefDeleteError`, the `try`/`catch` and warn at `:389-400`, and the comment; the
  `Stryker disable` line at `:409` goes with the function. Keep the loop body a plain `await updateRef(…)`.
- `TsgitError` / `unsupportedOperation` imports in `ref-store.ts` and `fetch.ts`: drop what becomes unused.

**Open item O3 (undecided).** If the session names **(a)**: also delete `assertRenamableTrackingRef`
(`ref-store.ts:288-307`) and its call (`src/application/commands/remote.ts:220`), flip
`test/unit/application/commands/remote.test.ts:~820-840` (`rename-packed-tracking-ref` → the packed-only tracking
ref is renamed: new loose ref, packed line gone) and delete `test/unit/application/primitives/ref-store.test.ts:369-427`
(the three `assertRenamableTrackingRef` rows), and add interop R9. If **(b)** or **(c)**: leave both untouched.

**Public or internal.** `withLockFile` and `packedRefsWithout` are internal (not barrelled). No type changes.
Migration notes 20, 21.

**Tests (unit)**
- `test/unit/domain/refs/packed-refs.test.ts` — `packedRefsWithout`: removes an entry and its `peeled` value; a
  header-less input gains the canonical header; an unsorted input comes back sorted; a `peeled`-only header is
  replaced; an entry naming a missing object and an annotated tag without a `^` line are copied unchanged; the
  last entry → the header line alone (46 bytes: assert the exact string); a name not present → the canonical
  rewrite of the rest; a malformed line refuses `INVALID_PACKED_REFS` (assert `data.reason`).
- New `test/unit/domain/refs/packed-refs.properties.test.ts` (lens 2, compositional; generators in
  `test/unit/domain/refs/arbitraries.ts`): for arbitrary sorted unique entry sets (optionally peeled) and any name,
  `parsePackedRefs(packedRefsWithout(serializePackedRefs(x), name)).entries` equals `x.entries` minus `name`
  (`numRuns: 200`); removing the same name twice equals removing it once (lens 4, `numRuns: 100`).
- `test/unit/application/primitives/atomic-write.test.ts` — `withLockFile`: a held lock refuses through
  `onLocked` with the lock path and runs nothing; a body that commits leaves `path` = content and no lock; a body
  that does not commit leaves `path` untouched and no lock; a body that throws removes the lock and rethrows the
  body's error; a `rename` failure removes the lock and rethrows (spy `ctx.fs.rename`, restore it).
- `test/unit/application/primitives/ref-store.test.ts:340-367` ("packed-only ref, delete → `delete-packed-ref`")
  **flips**: the line is gone from `packed-refs`, the other entries and header bytes as `packedRefsWithout` gives.
  New rows: loose-and-packed → both gone and `resolveDirect` `missing`; loose-only with `packed-refs` present →
  `packed-refs` bytes and `ctx.fs.stat(...).mtimeMs` unchanged (spy `ctx.fs.writeExclusive` to prove the lock was
  still taken); `packed-refs.lock` present → `RESOURCE_LOCKED { resource: 'ref', path }` for a packed, a loose-only
  and an absent name, the loose file intact; `<ref>.lock` present → `REF_LOCKED { name }`, and it wins over a held
  `packed-refs.lock`; an absent nested name → no `refs/heads/deep` directory afterwards; a malformed `packed-refs`
  → `INVALID_PACKED_REFS`, loose file intact, no lock left; `HEAD` deleted through the store → the HEAD slot is
  invalidated (`readHeadFile` re-reads).
- `test/unit/application/primitives/update-ref.test.ts:278-300` (packed-only → `UNSUPPORTED_OPERATION`) **flips**;
  its null-id twin from commit 1 flips too.
- `test/unit/application/commands/fetch.test.ts:1955-2000` ("prune packed-only ref handling" — skip and warn)
  **flips**: `ghost` is pruned, listed in `prunedRefs`, and no warn is logged.
- `test/unit/application/primitives/stash-ref.test.ts` — the last-entry drop still deletes `refs/stash` (now under
  both locks); run unchanged.

**Tests (interop)** — append to `ref-transaction-interop.test.ts`; the files base gains `git pack-refs --all`
over `lp`, `p1`, `p2`, annotated `at1`/`at2`, lightweight `lt`, then a loose `lp` = `C2`. Rows Q1, Q2, Q3, Q4
(inode and mtime via `stat`), Q5 (plant `packed-refs.lock` in both copies; the absent and null-id forms too; git's
line reconstructed from `data.path`), Q6, Q7, Q8 (write a header-less file into both copies), Q9, Q10, Q11 (exact
bytes), Q12 (both refuse, both files unchanged), Q14 (the packed-only `main` `HEAD` points at: `packed-refs`
header-only on both; the `logs/HEAD` comparison is commit 3's), X13 (both lock shapes), the nested absent delete,
and `fetch --prune` of a packed-only tracking ref against the `packed-refs-interop.test.ts` remote fixture pattern
(or a `file://` bare upstream in `beforeAll`). Flip commit 1's packed-only residual row.

**Traps**
- No references to this plan, the design, ADRs or open items in source or test code.
- **Inert-change risk:** a lock-contention row whose lock is planted at the wrong path passes a no-op delete —
  assert the refusal data, not only "nothing changed"; a Q4 row must prove the lock was taken and released.
- The memory adapter's `writeExclusive` creates parent directories: the loose-lock skip is what keeps an absent
  nested delete from leaving directories — test it on the memory adapter and in interop.
- Do not add a lock to `packRefs` here (recorded residual).

#### Commit 3 — every delete path writes the coupled `logs/HEAD` entry (U6)

**Decision.** Deleting the ref `HEAD` symbolically names — through `delete: true` or the null id — appends
`<old> 0{40} <message>` to `logs/HEAD` in the same `applyRefUpdates` call (X2, X3, Q14). The `delete: true` arm
of `UpdateRefOptions` gains `reflogMessage?: string` (empty when omitted: the line ends at the zone, X3). A delete
of an **absent** ref `HEAD` names writes `0{40} 0{40} <message>` on the files backend and nothing on reftable
(X16) — the first field of the backend table. `branch.rename` per open item O1.

**Current code (verified).** `coupledHeadTarget` `src/application/primitives/update-ref.ts:79-81`;
`resolveHeadForCoupling` `:88-95`; `refUpdatesFor` `:58-73`. `UpdateRefOptions` `src/application/primitives/types.ts:103-118`.
`serializeReflogLine` omits the tab for an empty message (`src/domain/reflog/reflog-format.ts:53-61`).
`recordRefUpdate`'s per-name gate `src/application/primitives/record-ref-update.ts:36-58`. `branchRename`
`src/application/commands/branch.ts:165-234` (`moveReflog` `:219`, the reflogOnly rename entry `:220-227`, the
delete `:228`, the `HEAD` re-point `:229-232`).

**Target.**
```ts
// types.ts — the delete arm
| { readonly delete: true; readonly expected?: ObjectId | 'absent'; readonly reflogMessage?: string };

// src/application/primitives/internal/ref-transaction-logging.ts (commit 4 adds two fields)
export interface TransactionLogging {
  /** Whether a delete of an absent target still writes its split log-only entries. */
  readonly noOpDeleteLogs: 'written' | 'skipped';
}
export const transactionLogging = (ctx: Context): TransactionLogging =>
  ctx.layout.refStorage === 'reftable' ? REFTABLE : FILES;

// update-ref.ts
function deleteUpdates(ctx: Context, name: RefName, current: ResolveDirectResult, head: ResolveDirectResult,
  message: string): readonly RefUpdate[] {
  const deletion: RefUpdate = { kind: 'delete', name };
  if (!coupledHeadTarget(head, name)) return [deletion];
  const zero = zeroOid(ctx.hashConfig);
  const absent = current.kind !== 'direct';
  if (absent && transactionLogging(ctx).noOpDeleteLogs === 'skipped') return [deletion];
  const reflog = { oldId: absent ? zero : current.id, newId: zero, message };
  return [deletion, { kind: 'reflogOnly', name: HEAD, reflog }];
}
```
The `reflogOnly` HEAD entry goes through `recordRefUpdate`'s gate, which creates `logs/HEAD` when absent under
`core.logAllRefUpdates` (X16's "created"); the files backend's delete already removed the branch's own log.

**Open item O1 (undecided) — `branch.rename`.** git writes two `logs/HEAD` entries when renaming the branch
`HEAD` names (R11, R12). If the session names:
- **(a)** — rename's delete passes `{ delete: true, noDeref: true, reflogMessage: branchRenamed(from, to) }`
  (`noDeref` lands in commit 4; in this commit omit it — `from` is direct, `resolveRef` at `:172`) and the `HEAD`
  re-point at `:229-232` becomes `store.applyRefUpdates([{ kind: 'setSymbolic', name: HEAD, target: to, reflog: {
  oldId: zeroOid(ctx.hashConfig), newId: id, message: branchRenamed(from, to) } }])` instead of
  `writeSymbolicRef`. Interop: extend `test/integration/reflog-interop.test.ts:1348-1420` (both rename rows) to
  compare `logs/HEAD` bytes too, and add R12 (the old log absent) and R13 (a branch `HEAD` does not name: no entry).
- **(b)** — rename's delete becomes a store-level `getRefStore(ctx).applyRefUpdates([{ kind: 'delete', name: from }])`
  (no coupled entry); add an interop row pinning git's two entries against tsgit's none, residual-titled.
- **(c)** — as (a) for the delete; keep `writeSymbolicRef`; the second entry residual-titled.
Stop if the session names none.

**Public or internal.** `UpdateRefOptions` gains a field — `reports/api.json` owed at the phase boundary;
`transactionLogging` is internal. Migration notes 16 (rewritten), 18.

**Tests (unit)** — `test/unit/application/primitives/update-ref.test.ts`:
- `HEAD` symbolic to `refs/heads/main`: `delete: true` with `reflogMessage` → `readReflog(ctx, HEAD)` gains
  exactly `{ oldId: <old>, newId: ZERO, message }`; without `reflogMessage` → `message: ''` and the raw line has no
  tab; the null id → the same entry; a branch `HEAD` does not name → no `HEAD` entry;
- files Context, `HEAD` → unborn `main`, `delete: true` → `logs/HEAD` created with `0{40} 0{40}`; a reftable Context,
  same → `readReflog(ctx, HEAD)` unchanged (kills an inverted table field);
- the entry and the deletion land in **one** `applyRefUpdates` call (spy the store, as `:426` does);
- `:208-222` (malformed `HEAD`, delete) stays green: an unreadable `HEAD` reads as uncoupled;
- `test/unit/application/primitives/internal/ref-transaction-logging.test.ts` (new): `refStorage: 'files'` →
  `written`; `'reftable'` → `skipped`.
- `test/unit/application/commands/branch.test.ts` rename rows: run; under O1 (a) assert the two `HEAD` entries on a
  memory Context, under (b) assert none.

**Tests (interop)** — append: X2 (`-m why`), X3 (no `-m`, exact bytes), Q14's `logs/HEAD` comparison, X16 on both
bases. Flip commit 1's `HEAD`-entry residual row. O1's rows as above.

**Traps**
- No references to this plan, the design, ADRs or open items in source or test code.
- Pin identity and time; compare `logs/HEAD` **bytes**, not parsed entries (the missing tab is the point of X3).
- The coupled entry must not be written when the delete itself refuses (CAS, locks): it rides in the same
  `applyRefUpdates` list after the `delete`, and the files store applies in order.

#### Commit 4 — `updateRef` dereferences symbolic refs; `noDeref`; the callers (U5)

**Decision.** As ADR-871 and the design's "Change — U5": the chain (`internal/ref-write-chain.ts`), the
compare-and-swap on the terminal's value naming the given ref, a symref log-only entry per walked link, the
coupled `HEAD` entry whenever `HEAD` names the terminal or a walked link, `noDeref` on both arms, the backend
table's two remaining fields, the reftable store keeping a symbolic record's logs on delete, and the caller-audit
changes.

**Pins** (design S1–S28, X4–X12, X14, X15, X17, R5–R8, R10, R14, R15). The rows that decide shape:
S3/S11 (every link logs), S12 (a link logs an unchanged value, the terminal does not), S16 (per-name gate), S4
(CAS: given name, terminal value), S7/S19/S20 (`expected: 'absent'` through a dangling symref succeeds; under
`noDeref` it refuses with `'absent'`/`'absent'`), S13/S14/S15 (no cap; repetition refuses; `noDeref` never
walks), S17/S21/S27 (`noDeref` old value is the referent's; `HEAD` coupled with the resolved value), S23/S24/X11
(files null-id `HEAD` old through a walked link), X5/X14 (files `0{40} 0{40}` link and `HEAD` entries on an
absent target; reftable none), X6 (reftable keeps a `noDeref`-deleted symref's log and appends `<old> 0{40}`),
S28 (`noDeref` referent read failure refuses only with `expected`), X10/X17 (`noDeref` delete of `HEAD`).

**Current code (verified).** After commits 1–3: `updateRef` (`update-ref.ts`), `refUpdatesFor` (`:58-73`),
`deleteUpdates` (commit 3), `coupledHeadTarget` (`:79-81`), `resolveHeadForCoupling` (`:88-95`). The read chain:
`resolveDirectChain` `src/application/primitives/resolve-ref.ts:64-104` (array `includes` cycle check `:85`,
`MAX_SYMBOLIC_REF_DEPTH = 5` `src/application/primitives/types.ts:22`), `refCycleDetected` /
`refChainTooDeep` `src/domain/refs/error.ts:72-76` (`refCycleDetected` `:75-76`). Reftable delete: `applyDeleteRecords`
`reftable-transaction.ts:490-501` (`tombstoneExistingLogs` just above it). Store selection:
`createRefStore` `ref-store.ts:332-336`.

**Target.** The design's sketches, verbatim in shape: `RefWriteChain`, `resolveWriteChain`, `walkSymbolicChain`
(visited `Set`, `refCycleDetected([...links, current])`, each hop's target through `validateRefName`),
`resolveWithoutDeref` (`readReferentValue` maps `REF_CYCLE_DETECTED` / `REF_CHAIN_TOO_DEEP` to `'absent'` only
when `expected` is `undefined`; share the read walk by exporting a store-level helper from `resolve-ref.ts`
rather than copying it), `assertExpected` over the chain, `writeUpdates` / `deleteUpdates` over the chain,
`TransactionLogging` completed with `headOldThroughLink: 'null-id' | 'resolved'` and `symbolicDeleteLog:
'removed' | 'kept-with-entry'`, and `updateRef` as the design shows (Part 19's verification line not yet present).
In `applyDeleteRecords`, tombstone existing logs only when the live record is not symbolic.

**Callers** (design caller audit):
- **Class C → `HEAD`**: `src/application/commands/abort-merge.ts:56`, `internal/abort-sequencer-reset.ts:32`,
  `cherry-pick.ts:347`, `:483`, `commit.ts:236`, `merge.ts:182`, `:298`, `reset.ts:87` (always `HEAD`), `revert.ts:183`,
  `:460`. The `branch` values stay in each result; only the `updateRef` name changes. `commit.ts`'s docstring
  (`:229-230`) and `reset.ts`'s comment (`:82-85`) are rewritten to say the write goes through `HEAD`.
- **Class D → `noDeref: true`**: `branch.ts:161`, `:228` (plus O1's message), `tag.ts:221`, `remote.ts:181`.
- **Class E**: `fetch.ts` prune skips `entry.value.kind === 'symbolic'` before the advertised-branch test.
- **Facade**: `src/repository.ts:999-1002` passes options through; nothing to change beyond the type.

**Public or internal.** `UpdateRefOptions.noDeref` (both arms) — `reports/api.json` owed. New modules internal.
Migration notes 17, 21, 23.

**Tests (unit)**
- New `test/unit/application/primitives/internal/ref-write-chain.test.ts`: direct name → `links: []`; absent → `old:
  'absent'`; one hop and two hops (links in order); dangling symref → terminal is the target, `old: 'absent'`,
  `danglingSymref: false`; p ↔ q and z → z → `REF_CYCLE_DETECTED { chain: [p, q, p] }` / `[z, z]`; a six-hop chain
  resolves (kills a copied depth cap); `noDeref` on a direct name, on a symref (old = referent value, links empty),
  on a dangling symref (`danglingSymref: true`), on a cycle without `expected` (`old: 'absent'`) and with (rethrows
  `REF_CYCLE_DETECTED`); an invalid link target → `INVALID_REF` before a second read (count `resolveDirect` calls).
- `ref-transaction-logging.test.ts` gains the two fields per backend.
- `update-ref.test.ts` — each shape isolated: S3 (both logs), S12 (link logs, terminal does not), S16 (a tag symref
  to a branch: no tag log), S4 (conflict names the given ref with the terminal's id), S7, S8, S19 (both `'absent'`),
  S1 and S22 (`updateRef('HEAD')` moves `main`, `HEAD` keeps `ref: refs/heads/main`), S21 (`noDeref` `HEAD`
  detaches), S23 on a files Context (`HEAD` entry `0{40}` old) and on a reftable Context (resolved old), S24 (HEAD
  names the terminal: resolved on both), S25 (a non-coupled chain), S27, X4, X5 per backend, X6 per backend, X8,
  X9, X10 (`noDeref` delete of `HEAD` removes the file and `logs/HEAD`, and the HEAD slot is invalidated), X11 per
  backend, X12, X14 per backend, X15; the commit-1 symref residual row **flips** to X4. Every multi-entry row asserts
  a single `applyRefUpdates` call.
- `test/unit/application/primitives/reftable-transaction.test.ts`: deleting a symbolic record leaves its log
  records; deleting a direct record still tombstones them.
- Class C suites — run and repair: `commit.test.ts`, `merge.test.ts` (`:1720-1800` patches `readUtf8` to fail the
  *second* read of `refs/heads/main`; with the write through `HEAD` the read sequence is `HEAD`, `refs/heads/main`,
  `HEAD` — re-derive the count from a `readUtf8` spy log, do not guess), `reset.test.ts`, `abort-merge.test.ts`,
  `cherry-pick.test.ts`, `revert.test.ts`; add one row per command family on a `HEAD → refs/heads/s → refs/heads/x`
  chain asserting `x` moved and `s` stayed symbolic (the class's observable fix).
- Class D suites: `branch.test.ts`, `tag.test.ts`, `remote.test.ts` — add a symref row each (the symref is deleted,
  its target kept).
- Class E: `fetch.test.ts` — a symbolic `refs/remotes/origin/HEAD` whose target's branch is no longer advertised →
  `origin/HEAD` kept, the target pruned, `prunedRefs` excludes `origin/HEAD`.
- Unaffected class-A fixture writers (run, do not edit): `test/unit/application/primitives/laws.test.ts`,
  `commondir-per-worktree-refs.test.ts`, `test/unit/application/commands/internal/commit-ish.test.ts`,
  `name-rev.test.ts`, `pull.test.ts`, `rebase.test.ts`.

**Tests (interop)** — append to `ref-transaction-interop.test.ts` (symrefs created in the base with git): S1, S3,
S4, S5, S7, S8, S11, S12, S14 (git's line reconstructed from `data.chain`: the last name and the one before it),
S15, S16, S17, S19, S20, S21, S22, S23 and S24 on both bases, S25, S27, S28, X4–X12, X14, X15 on both bases, X17
on reftable; command rows R5, R6, R8 (`origin/HEAD` kept), R10, R14 through `branchDelete`, `tagDelete`,
`fetch`, `remoteRemove`, `notesAdd`. Flip commit 1's symref residual row. Re-run
`test/integration/reflog-interop.test.ts` (class C writes and `branch.rename`), `loose-ref-interop.test.ts`,
`reftable-ref-storage-interop.test.ts` and `head-symlink-interop.test.ts` unchanged.

**Property tests.** `walkSymbolicChain` is orchestration over store reads; its invariants (links are distinct, the
terminal is never symbolic, a repeat always refuses) are covered by the enumerated rows — no property suite.

**Traps**
- No references to this plan, the design, ADRs, matrix rows or open items in source or test code.
- Do not reuse `resolveDirectChain`'s `chain.includes` for the write walk (O(n²)); the read-path helper keeps its
  own cap for `noDeref` only.
- A link entry is written even when old equals new; the terminal's is not — the table in the design, not today's
  single rule.
- Class C: the result objects keep reporting the branch name; only the name passed to `updateRef` changes.
- `invalidateHeadSlot` on a `noDeref` delete of `HEAD` (commit 2's store change) — assert it; a stale slot would
  report the deleted `HEAD` as present within the same gate.

### TDD steps

**Commit 1 (null id, absent no-op)**
1. **RED** — `update-ref.test.ts`: existing loose ref with a reflog, null id → ref and log gone. Fails: a null-id ref is
   written.
2. **RED** — `delete: true` on an absent ref resolves. Fails: `REF_NOT_FOUND`.
3. **GREEN** — `isDelete`, `assertExpected` extracted; `applyDelete` and `applyDeleteRecords` return for an absent ref.
4. **RED/GREEN** — CAS rows, sha256 width, reftable rows, the flipped `ref-store.test.ts` / `reftable-transaction.test.ts`
   rows, the residual rows.
5. **RED/GREEN** — create `ref-transaction-interop.test.ts`; commit-1 rows and residual-titled rows.

**Commit 2 (packed refs under locks)**
6. **RED** — `packed-refs.test.ts`: `packedRefsWithout` removes an entry and its peeled line. Fails: missing export.
7. **GREEN** — `packedRefsWithout`; **RED/GREEN** the header, sort, copy, header-only and malformed rows; the property suite.
8. **RED** — `atomic-write.test.ts`: `withLockFile` refuses a held lock. **GREEN** — `withLockFile`; remaining rows.
9. **RED** — `ref-store.test.ts:340-367` flipped (packed-only deleted). Fails: `delete-packed-ref`.
10. **GREEN** — `applyDelete` with both locks and `removeEverywhere`.
11. **RED/GREEN** — loose-and-packed, loose-only (lock taken, file untouched), contention rows (packed, loose, both), nested
    absent name, malformed file, `HEAD` slot invalidation.
12. **RED/GREEN** — `fetch.test.ts:1955-2000` flipped; delete the catch. Then O3 per the session's choice.
13. **RED/GREEN** — interop Q/X13/prune rows; flip the packed-only residual.

**Commit 3 (coupled HEAD entry)**
14. **RED** — `update-ref.test.ts`: `delete: true` on the branch `HEAD` names → one `HEAD` entry. Fails: none.
15. **GREEN** — `deleteUpdates`, the delete arm's `reflogMessage`, `transactionLogging` with `noOpDeleteLogs`.
16. **RED/GREEN** — empty message bytes, null id, non-coupled branch, unborn `HEAD` per backend, single call.
17. **RED/GREEN** — O1 per the session's choice; interop X2, X3, Q14, X16; flip the residual.

**Commit 4 (dereference)**
18. **RED** — `ref-write-chain.test.ts`: one hop → `links: [s]`, terminal `x`. Fails: module missing.
19. **GREEN** — `walkSymbolicChain`, `resolveWithoutDeref`, the shared read helper; **RED/GREEN** the remaining chain rows.
20. **RED** — `update-ref.test.ts` S3: a write through `s` moves `x`, keeps `s`, logs both. Fails: `s` overwritten.
21. **GREEN** — `updateRef` over the chain, `writeUpdates`, `deleteUpdates` over the chain, the full `TransactionLogging`.
22. **RED/GREEN** — every enumerated `update-ref.test.ts` row, backend twins first for S23, X5, X6, X11, X14; the reftable
    store's symbolic-record log rule.
23. **RED/GREEN** — class D (`noDeref` at the four sites, each with its symref row), class E (prune skip), class C (switch to
    `HEAD`, one chain row per command family); repair `merge.test.ts:1720-1800` from a read log.
24. **RED/GREEN** — interop S/X/R rows on both bases; flip the symref residual.
25. **REFACTOR** — `updateRef`'s docstring states the split rule and names the backend table; `commit.ts:229-230` and
    `reset.ts:82-85` comments.

### Gate

Commit 1:
```
npx vitest run --maxWorkers=2 test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/reftable-transaction.test.ts test/unit/application/primitives/reftable-ref-store.test.ts test/unit/application/primitives/stash-ref.test.ts test/unit/application/commands/branch.test.ts test/unit/application/commands/tag.test.ts test/unit/application/commands/remote.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/fetch.test.ts
npx vitest run test/integration/ref-transaction-interop.test.ts
npx vitest run test/integration/reftable-ref-storage-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/update-ref.ts src/application/primitives/ref-store.ts src/application/primitives/reftable-transaction.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/reftable-transaction.test.ts test/unit/application/primitives/reftable-ref-store.test.ts test/integration/ref-transaction-interop.test.ts
npx cspell --no-progress src/application/primitives/update-ref.ts src/application/primitives/ref-store.ts src/application/primitives/reftable-transaction.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/reftable-transaction.test.ts test/unit/application/primitives/reftable-ref-store.test.ts test/integration/ref-transaction-interop.test.ts
```

Commit 2:
```
npx vitest run --maxWorkers=2 test/unit/domain/refs/packed-refs.test.ts test/unit/domain/refs/packed-refs.properties.test.ts test/unit/application/primitives/atomic-write.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/stash-ref.test.ts test/unit/application/commands/fetch.test.ts test/unit/application/commands/remote.test.ts
npx vitest run test/integration/ref-transaction-interop.test.ts
npx vitest run test/integration/packed-refs-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/refs/packed-refs.ts src/application/primitives/atomic-write.ts src/application/primitives/ref-store.ts src/application/commands/fetch.ts test/unit/domain/refs/packed-refs.test.ts test/unit/domain/refs/packed-refs.properties.test.ts test/unit/domain/refs/arbitraries.ts test/unit/application/primitives/atomic-write.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/commands/fetch.test.ts test/integration/ref-transaction-interop.test.ts
npx cspell --no-progress src/domain/refs/packed-refs.ts src/application/primitives/atomic-write.ts src/application/primitives/ref-store.ts src/application/commands/fetch.ts test/unit/domain/refs/packed-refs.test.ts test/unit/domain/refs/packed-refs.properties.test.ts test/unit/domain/refs/arbitraries.ts test/unit/application/primitives/atomic-write.test.ts test/integration/ref-transaction-interop.test.ts
```
(O3 (a) adds `src/application/commands/remote.ts` and `test/unit/application/commands/remote.test.ts` to both lists.)

Commit 3:
```
npx vitest run --maxWorkers=2 test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/internal/ref-transaction-logging.test.ts test/unit/application/commands/branch.test.ts test/unit/application/primitives/record-ref-update.test.ts
npx vitest run test/integration/ref-transaction-interop.test.ts
npx vitest run test/integration/reflog-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/update-ref.ts src/application/primitives/types.ts src/application/primitives/internal/ref-transaction-logging.ts src/application/commands/branch.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/internal/ref-transaction-logging.test.ts test/unit/application/commands/branch.test.ts test/integration/ref-transaction-interop.test.ts test/integration/reflog-interop.test.ts
npx cspell --no-progress src/application/primitives/update-ref.ts src/application/primitives/types.ts src/application/primitives/internal/ref-transaction-logging.ts src/application/commands/branch.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/internal/ref-transaction-logging.test.ts test/integration/ref-transaction-interop.test.ts test/integration/reflog-interop.test.ts
```

Commit 4 (unit batches, one invocation each):
```
npx vitest run --maxWorkers=2 test/unit/application/primitives/internal/ref-write-chain.test.ts test/unit/application/primitives/internal/ref-transaction-logging.test.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/reftable-transaction.test.ts test/unit/application/primitives/resolve-ref.test.ts test/unit/application/primitives/laws.test.ts test/unit/application/primitives/commondir-per-worktree-refs.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/commit.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/reset.test.ts test/unit/application/commands/abort-merge.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts test/unit/application/commands/rebase.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/branch.test.ts test/unit/application/commands/tag.test.ts test/unit/application/commands/remote.test.ts test/unit/application/commands/fetch.test.ts test/unit/application/commands/notes.test.ts test/unit/application/commands/push.test.ts test/unit/application/commands/pull.test.ts test/unit/application/commands/internal/commit-ish.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/name-rev.test.ts test/unit/application/commands/stash.test.ts
```
Interop (one invocation each): `test/integration/ref-transaction-interop.test.ts`, `test/integration/reflog-interop.test.ts`,
`test/integration/loose-ref-interop.test.ts`, `test/integration/reftable-ref-storage-interop.test.ts`,
`test/integration/head-symlink-interop.test.ts`, `test/integration/tag-interop.test.ts`,
`test/integration/branch-start-point-interop.test.ts`. Then:
```
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/update-ref.ts src/application/primitives/types.ts src/application/primitives/internal/ref-write-chain.ts src/application/primitives/internal/ref-transaction-logging.ts src/application/primitives/resolve-ref.ts src/application/primitives/reftable-transaction.ts src/application/commands/abort-merge.ts src/application/commands/internal/abort-sequencer-reset.ts src/application/commands/cherry-pick.ts src/application/commands/commit.ts src/application/commands/merge.ts src/application/commands/reset.ts src/application/commands/revert.ts src/application/commands/branch.ts src/application/commands/tag.ts src/application/commands/remote.ts src/application/commands/fetch.ts test/unit/application/primitives/internal/ref-write-chain.test.ts test/unit/application/primitives/update-ref.test.ts test/integration/ref-transaction-interop.test.ts
npx cspell --no-progress src/application/primitives/update-ref.ts src/application/primitives/types.ts src/application/primitives/internal/ref-write-chain.ts src/application/primitives/internal/ref-transaction-logging.ts src/application/primitives/resolve-ref.ts src/application/primitives/reftable-transaction.ts src/application/commands/commit.ts src/application/commands/reset.ts src/application/commands/fetch.ts test/unit/application/primitives/internal/ref-write-chain.test.ts test/unit/application/primitives/update-ref.test.ts test/integration/ref-transaction-interop.test.ts
```
Add to both lists every command test file the class C/D/E rows touched.

**Owed at the phase boundary:** `npm run docs:json` + `reports/api.json` (`UpdateRefOptions`); `check:size` and
`check:tarball` (≈ +1.25 KiB runtime, see Size budgets); `check:write-surfaces` and `check:test-pyramid` (new interop
`@proves`); `test:parity` (the reftable scenario writes through `updateRef`). **Surface gates tripped:** the public
`UpdateRefOptions` type (api report only; no barrel, facade shape or doc-coverage page added).

### Commit

Commit 1: `fix(refs): delete the ref when updateRef is given the null object id or an absent ref`

Commit 2: `fix(refs): delete packed refs by rewriting packed-refs under git's locks`

Commit 3: `fix(refs): log the deletion of the branch HEAD points at on every delete path`

Commit 4: `feat(refs): dereference symbolic refs in updateRef as git's ref transaction does`

## Part 19 — Ref updates verify their target: existence, hash, parse acceptance, branch typing; `tag.create`'s order (design C + B, DC-C1 a with its parse-acceptance follow-up, DC-C2 c, ADR-864) — 3 commits

### Context

**Depends on Part 14** (`update-ref.ts:6` imports the domain `errorDataCode`), **Part 15** (no size-lying
loose object is ever cached, so a cache hit re-derives its stored header from `content.byteLength`) and **Part 18**
(`isDelete`, the chain: verification is placed before `resolveWriteChain` and skips both delete forms). C types the
**given** name, never the chain's terminal (design S6, S9, S10): a tree reaches `refs/heads/x` through
`refs/tags/ts → refs/heads/x`, and `refs/heads/bt → refs/tags/tt` refuses.

#### Commit 1 — target verification: existence, hash, branch typing (C)

**Design excerpt (ratified).** git's `ref_transaction_update` (`refs.c:1425-1445`): an update with a new
value, not symbolic, not the null id, not `REF_SKIP_OID_VERIFICATION` runs `parse_object`; `NULL` ⇒
`trying to write ref '<ref>' with nonexistent object <oid>`; a non-commit on a branch (`is_branch`,
`refs.c:1072`: `HEAD` or `refs/heads/*`) ⇒ `trying to write non-commit object <oid> to branch '<ref>'`.
`parse_object` hashes: a mismatching object is reported `hash mismatch` and then as nonexistent. tsgit's
rule: the object exists **and** its stored bytes hash to the id; `HEAD` and `refs/heads/*` also need type
`commit`, an annotated tag object refused, never peeled; the type test runs after the hash; verification
precedes the compare-and-swap; deletes, null ids and symbolic writes are unverified. The hash is computed on
every verified update (a cache hit is hashed, not trusted); a body above the 64 KiB compressed buffer gate
is hashed as it inflates and never retained.

| Pin | Result (git 2.55.0) |
|---|---|
| C1 | `update-ref refs/heads/u` ← commit 0; ← tree / blob / annotated tag 128 non-commit (tag not peeled); ← missing 128 nonexistent |
| C2 | `refs/tags/u`, `refs/remotes/o/u`, `refs/notes/u`, `refs/u`, `refs/stash` ← commit / tree / blob / tag: 0 |
| C3 | the same five refs ← missing: 128 nonexistent |
| C4 | `update-ref HEAD <tree>` (HEAD → main) and `--no-deref HEAD <tree>`: 128 non-commit to branch `'HEAD'` |
| C5 | `--no-deref HEAD <missing>` 128 nonexistent; `ORIG_HEAD <tree>` 0; `FOO_HEAD <missing>` 128 nonexistent |
| C6 | `--stdin` `create refs/heads/s <tree>` / `update refs/heads/main <tree>`: 128 non-commit, no `update_ref failed` prefix |
| C7 | `refs/tags/t <missing> <wrong-old>` and `refs/heads/main <tree> <wrong-old>`: verification reported, not the CAS |
| C8 | `refs/tags/cb <hash-mismatching blob>`, `refs/heads/cc <hash-mismatching commit>`: 128 `error: hash mismatch <oid>` + nonexistent |
| C9 | `-d refs/tags/t <wrong-old>` 1 (CAS); `refs/tags/t 0{40}` 0 (deletes — Part 18); `symbolic-ref refs/heads/s refs/heads/nope` 0; `update-ref refs/heads/s <tree>` (s → nope) 128 typed by the **given** name; reftable: C1/C3 identical |
| planning | empty-tree id not stored: `refs/tags/*` 0, `refs/heads/*` 128 non-commit; empty blob not stored: 128 nonexistent |

**Supporting change 1 — the loose stream arm reads its header at open.** Today
`src/application/primitives/internal/blob-source.ts:186-193` returns `type: undefined` and refuses a loose
non-blob lazily on first drain (`stripHeader:310-333` throws `unexpectedObjectType('blob', type, id)`).
After: `resolveLoose` opens the iterator, reads chunks up to the NUL, parses the header and returns its
`type`; the tail hashes `headerBytes` and the remainder exactly as today.
```ts
// resolveLoose stream arm
const iterator = readableStreamToAsyncIterable(inflateOneShot(ctx, compressed))[Symbol.asyncIterator]();
const header = await readLooseHeader(id, iterator);   // on any throw: await returnIterator(iterator), rethrow
return {
  kind: 'stream',
  type: header.type,
  materialised: false,
  stream: yieldAndVerifyLooseChunks(ctx, id, header, iterator, gate.verifyHash),
  release: () => returnIterator(iterator),
};
```
- `HeaderStripped` (`:300-303`) gains `readonly type: ObjectType`; `stripHeader` becomes `readLooseHeader`,
  does the first `next()` itself, keeps both refusals verbatim —
  `invalidObjectHeader(`inflate stream produced no output for object ${id}`)` (today `:357`) and
  `invalidObjectHeader(`no NUL terminator found in inflated object ${id}`)` (today `:328`) — and no longer
  refuses a non-blob.
- `yieldAndVerifyChunks` (`:339-379`) becomes `yieldAndVerifyLooseChunks(ctx, id, header, iterator,
  verifyHash)`: hashes `header.headerBytes`, yields `header.content` when non-empty, then the remaining
  chunks with the abort check, `finalizeHash`, and `finally { await iterator.return?.() }`.
- `returnIterator(iterator)` swallows like `cancelUnread` (`:291-297`): `release()` never rejects. It must
  cancel **through the iterator** — the readable is locked by then, so `inflated.cancel()` would reject on
  the lock and release nothing.
- `BlobSource` (`:52-68`) stream arm `type: ObjectType`. Delete the module docstring's exception sentence
  (`:7-11`).
- `src/application/primitives/stream-blob.ts:21` → `if (source.type !== 'blob')`;
  `src/application/primitives/internal/whitespace-drop-predicate.ts:45-49` `refuseNonBlob` → same condition,
  and its comment (`:42-44`) loses "`type` is `undefined` only on the loose streamed arm".
- Observable in tsgit only: `streamBlob` on a loose non-blob refuses at its `await`.

**Supporting change 2.** `src/application/primitives/read-object.ts:173` — export `withLazyFetchRetry` (add
`export`; the docstring gains "and the ref-target verifier"). `blob-source.ts` already imports
`read-object.ts` (`:36`); `read-object.ts` does not import `blob-source.ts`, so no cycle.

**The verifier** — `src/application/primitives/internal/blob-source.ts`, beside `openBlobSource` (`:75`):
```ts
export interface VerifiedObject {
  readonly type: ObjectType;
}
const VIRTUAL_EMPTY_TREE: VerifiedObject = { type: 'tree' };

/** git's parse_object read for one id: it exists and its stored bytes hash to it. Every arm hashes; a body
 *  above the buffer gate is hashed as it inflates and never retained. A promised object is fetched first. */
export async function verifyStoredObject(ctx: Context, id: ObjectId): Promise<VerifiedObject> {
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  return withLazyFetchRetry(ctx, id, registry, () => hashStoredObject(ctx, registry, id));
}

async function hashStoredObject(ctx: Context, registry: PackRegistry, id: ObjectId): Promise<VerifiedObject> {
  if (id === emptyTreeOid(ctx.hashConfig)) {
    await registry.assertLoadable();            // same order as the resolver: store gate, then the virtual tree
    return VIRTUAL_EMPTY_TREE;
  }
  const source = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES, { verifyHash: true });
  if (source.kind === 'stream') {
    for await (const _chunk of source.stream) {
      // the arm's tail hashes each chunk and refuses OBJECT_HASH_MISMATCH after the last one
    }
  }
  return { type: source.type };
}
```
Why every arm hashes (verified): cache hit `resolveFromCache:165-173` → `verifyObjectContent:171`; buffered
loose `resolveLoose:181-185` → `verifyBufferedBytes:154-163` over the stored bytes; packed base buffered
`:218-224` (both payload and declared size under the gate) → `verifyObjectContent`; packed base streamed
`yieldAndVerifyPackedBaseChunks:390-411`; packed delta `resolvePackDelta:243-253` → `verifyObjectContent`;
loose streamed → `yieldAndVerifyLooseChunks`. The parsed-object memo is not on this path.
`MAX_BUFFERED_BLOB_BYTES = 65_536` (`:40`).

**The check** — new `src/application/primitives/internal/ref-target.ts`:
```ts
const HEAD_REF = 'HEAD';
/** git's is_branch (refs.c:1072). */
const isBranchRef = (name: RefName): boolean => name === HEAD_REF || name.startsWith(HEADS_PREFIX);

/** git's ref_transaction_update verification (refs.c:1425-1445): the object must exist with intact bytes,
 *  then a branch needs a commit. */
export const assertRefTargetValid = async (ctx: Context, name: RefName, id: ObjectId): Promise<void> => {
  if (id === zeroOid(ctx.hashConfig)) return;
  const { type } = await verifyStoredObject(ctx, id);
  if (type !== 'commit' && isBranchRef(name)) throw unexpectedObjectType('commit', type, id);
};
```
Helpers: `HEADS_PREFIX` (`src/domain/refs/ref-prefixes.ts:6`), `zeroOid` (`src/domain/objects/object-id.ts:87`),
`emptyTreeOid` (`:105`), `unexpectedObjectType` (`src/domain/objects/error.ts:85-89`).

**Placement.**
- `src/application/primitives/update-ref.ts` (as reshaped by Part 18) — after `validateRefName(name)`, before
  `getRefStore`/`resolveWriteChain`: `if (!isDelete(ctx, newId, options)) await assertRefTargetValid(ctx, name,
  newId);` — the **given** `name`, never the chain's terminal; `isDelete` is Part 18's `options.delete === true || newId === zeroOid(ctx.hashConfig)` — git's
  `!is_null_oid` guard plus an explicit delete. Verification therefore still precedes the compare-and-swap
  (C7), and neither delete path is ever verified.
- `src/application/commands/clone.ts:321-335` `writeRef` — `await assertRefTargetValid(ctx, name, id)` before
  `applyRefUpdates`; `:372-380` `applyRemoteHead`'s detached arm — `await assertRefTargetValid(ctx, HEAD,
  advertisement.head.id)` before its `applyRefUpdates`. The symref arm (`:362-368`) writes a symbolic ref:
  unverified. Call order in `clone` (`:225-226`): `writeFetchedRefs` (remote-tracking refs, then the local
  HEAD branch, `:287-297`) then `applyRemoteHead`.
- Internal writers of ids the same command produced (`commit`, `stash` — `stash-ref.ts` bypasses
  `updateRef` — `rebase`, `checkout`, `worktree`, `submodule`) are not touched; those routing through
  `updateRef` are verified automatically.

**Refusal data** — existing codes only: absent `OBJECT_NOT_FOUND { id }`; hash mismatch
`OBJECT_HASH_MISMATCH { expected: id, actual }`; non-commit on a branch
`UNEXPECTED_OBJECT_TYPE { expected: 'commit', actual, id }`. git's lines compose from these fields plus the
ref name the caller passed.

**Public or internal — decided: internal.** `verifyStoredObject`, `VerifiedObject`, `assertRefTargetValid`,
`withLazyFetchRetry`'s export: none is barrelled (`src/application/primitives/index.ts` exports
`updateRef` `:110`, `readObject` `:70`, `streamBlob` `:94` by name). `BlobSource` is internal.
**Surface gates tripped:** none mechanical (no new code, no `reports/api.json` change). Docs: declared debt.

**Tests (unit)**
- `test/unit/application/primitives/update-ref.test.ts` — `ID_A`, `ID_B`, `ID_A_SHA256` (`:13-16`) are
  synthetic: replace them with real objects written per test (a local helper that `writeObject`s a
  parentless commit with a distinct message; the sha256 row `:347` builds it on its own Context). New rows,
  each isolated:
  - tree / blob / annotated tag → `refs/heads/x` → `UNEXPECTED_OBJECT_TYPE { expected: 'commit', actual, id }`,
    ref absent (`it.each` over `label`; the tag row asserts `actual: 'tag'` — not peeled);
  - tree → `HEAD` → same refusal (isolates `HEAD` from the `refs/heads/` prefix);
  - tree → `refs/tags/x`, `refs/remotes/o/x`, `refs/notes/x`, `refs/stash`, `ORIG_HEAD` → written
    (`ORIG_HEAD` kills a `name.includes('HEAD')` mutant);
  - tree → `refs/tags/ts` where `ts → refs/heads/x` (symref written with `writeSymbolicRef`) → written, `x` names the
    tree; tree → `refs/heads/bt` where `bt → refs/tags/tt` → `UNEXPECTED_OBJECT_TYPE` (kills typing by the terminal);
  - missing id → `refs/tags/x` → `OBJECT_NOT_FOUND { id }`, no ref file and no reflog file;
  - missing id + wrong `expected` → `OBJECT_NOT_FOUND` (not `REF_UPDATE_CONFLICT`); tree → `refs/heads/main`
    + wrong `expected` → `UNEXPECTED_OBJECT_TYPE`;
  - `delete: true` with a missing `newId` → the ref is deleted (no verification);
  - `zeroOid` without `delete` → deleted by Part 18's path, and a counted `createHasher` shows no hash (no
    verification);
  - hash-mismatching loose blob (blob X's loose bytes planted at id Y's path) → `refs/tags/x` →
    `OBJECT_HASH_MISMATCH { expected: Y, actual: X }`, nothing written; the same blob → `refs/heads/x` →
    `OBJECT_HASH_MISMATCH`, not `UNEXPECTED_OBJECT_TYPE` (kills a type-before-hash reordering); a
    hash-mismatching commit → `refs/heads/x` → `OBJECT_HASH_MISMATCH`;
  - commit read through `readObject` first (warms `ctx.deltaCache` and the memo), then `updateRef` on a
    Context whose `hash.createHasher` is counted → at least one hasher created during `updateRef` (a cache
    hit never answers). Bind the delegated method (`base.hash.createHasher.bind(base.hash)` — memory and
    browser hash services differ in method shape);
  - a loose blob of 70 000 incompressible bytes (a seeded LCG, never `Math.random`), Arrange asserts its
    loose file exceeds 65 536 bytes → `refs/tags/big` written, and a spy on `ctx.compressor.inflate` never
    saw that file's bytes (kills a buffered fallback);
  - empty-tree id, not stored → `refs/tags/et` written; → `refs/heads/et` →
    `UNEXPECTED_OBJECT_TYPE { actual: 'tree', id: emptyTreeOid(ctx.hashConfig) }`; empty blob id not stored →
    `OBJECT_NOT_FOUND`.
- `test/unit/application/primitives/internal/blob-source.test.ts`:
  - `:363-410` streamed loose commit row **flips**: `type === 'commit'` at open; draining yields the body
    without refusing. The buffered row (`:364-379`) stays.
  - loose object with no NUL / zero inflate output streamed → `openBlobSource` itself rejects
    `INVALID_OBJECT_HEADER` (reason contains the id).
  - `release()` on a streamed loose source cancels the inflate readable once (count `.cancel()` on a wrapped
    `createInflateStream().readable`, the `cancelTrackingContext` pattern in
    `whitespace-drop-predicate.test.ts:143-162`).
  - `verifyStoredObject` per arm — cache hit, buffered loose, streamed loose blob and commit, packed base
    buffered and streamed (`writeSyntheticPack`, `test/unit/application/primitives/pack-fixture.ts:173`),
    packed delta, virtual empty tree, absent id → `OBJECT_NOT_FOUND`; a mismatch per arm (buffered loose,
    streamed loose, packed base — the `:460` pattern) → `OBJECT_HASH_MISMATCH`; a promised object: a
    `ctx.promisor` double that writes the object when asked is called once and the result verifies.
  - `:341-361` (empty tree through `openBlobSource` → `OBJECT_NOT_FOUND`) stays: the virtual arm lives in
    the verifier only.
- `test/unit/application/primitives/stream-blob.test.ts:200-301` — the loose commit row asserts the refusal
  comes from `await streamBlob(ctx, id)` alone (no `collect`); the packed rows stay. `:897-972` (zero-chunk
  and no-NUL rows) stay green (their `try` covers the `await`).
- `test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts:619-641` — retitle "refuses
  mid-stream" to "refuses at open"; `cancelCount() === 2` must still hold.
- `test/unit/application/commands/clone.test.ts` — add `buildPackFromSingleCommit(ctx, message)` beside
  `buildPackFromSingleBlob` (`:68-77`), a pack holding one commit whose `tree` line names the empty tree (no
  tree entry needed; clone does not check out). Switch every fixture whose advertisement names a local HEAD
  branch (`symref=HEAD:refs/heads/<b>`) or a detached `head` at the pack's object to the commit helper;
  rows that assert only `refs/remotes/origin/*` may keep blobs. New rows: HEAD branch naming a tree the pack
  carries → rejects `UNEXPECTED_OBJECT_TYPE { expected: 'commit', actual: 'tree', id }` **and**
  `ctx.fs.exists(ctx.layout.gitDir)` is `false` afterwards — `clone` removes the gitDir on any failure
  (`src/application/commands/clone.ts:111-118`, git's `remove_junk`), which is stronger than asserting single
  refs absent (G7); detached advertisement whose `head` is a tree → rejects the same, gitDir gone; a tag
  naming an id the pack does not carry → `OBJECT_NOT_FOUND`, gitDir gone. Assert the gitDir exists after
  bootstrap in a success row of the same fixture, so "gone" cannot pass because it was never created.
- `test/unit/application/primitives/laws.test.ts:39-62` ("updateRef ∘ resolveRef returns the same id" over
  arbitrary hex) → arbitrary commit messages: `writeObject` a commit, `updateRef` `refs/heads/main`,
  `resolveRef` returns it (`numRuns: 10` unchanged).
- `test/parity/scenarios/reftable-refs.scenario.ts:70` `NEW_OID = ObjectId.from('b'.repeat(40))` (written at
  `:159`, expected at `:125`) → write a deterministic commit in the scenario and use its id.
- Read (not run) `test/bench/fixtures.ts:114-124` `writeManyRefs` callers and `test/bench/name-rev.bench.ts:144`
  to confirm they pass real ids.

**Tests (interop)** — create `test/integration/ref-write-verification-interop.test.ts` (Part 18's deletes and symref writes live in
`ref-transaction-interop.test.ts`). `@proves` surface
`updateRef, tag.create, clone`; unique "ref updates verify their target as git's ref transaction does";
interopSurface `updateRef, tag.create`. `beforeAll` (60 000 ms): a files-backend base with one file committed
(so the empty tree is **not** stored — `git commit --allow-empty` on an empty tree would store it), tree `T`,
blob `B`, commit `C`, annotated tag `AT` → `T` (`git tag -a -m x at T`), a missing id `NX`, and a
reftable twin (`git init --ref-format=reftable`). Each row copies the base into `peer` (git) and `ours`
(tsgit, `createNodeContext({ workDir: ours })`), runs `tryRunGitWithExit(['-C', peer, 'update-ref', …])` and
`updateRef(ctx, name, id, { reflogMessage })`, then compares git's exit code and reconstructed stderr
(`fatal: update_ref failed for ref '<ref>': trying to write ref '<ref>' with nonexistent object <oid>`,
`… trying to write non-commit object <oid> to branch '<ref>'`, `error: hash mismatch <oid>`) with tsgit's
refusal data, and whether the ref exists in each copy (`git show-ref --verify`). Rows: C1 (five targets),
C2 (five refs × four types, one `it.each`), C3, C4 (`HEAD`), C5 (`--no-deref HEAD NX`, `ORIG_HEAD T`,
`FOO_HEAD NX`), C6 (git `--stdin` against tsgit's single `updateRef`, same verdict), C7 (both orders), C8
(plant `B`'s loose file at a fabricated id's path — `chmod 0o644` the copy — and `C`'s at another), C9
(`-d` with a wrong old id → both CAS refusals, tsgit `REF_UPDATE_CONFLICT`; `symbolic-ref refs/heads/s
refs/heads/nope` vs `writeSymbolicRef` from `src/application/primitives/write-symbolic-ref.ts` → both write;
`update-ref refs/heads/s T` → both refuse typed by `refs/heads/s`; the null-id rows are Part 18's; S9 `update-ref refs/tags/ts T` through `ts → refs/heads/x` → both write, and S10
`update-ref refs/heads/bt T` through `bt → refs/tags/tt` → both refuse typed by `refs/heads/bt`), the
empty-tree rows, the empty-blob row, and C1/C3 on the reftable twin.

**Property tests — none in this commit.** Orchestration over reads; each arm is an enumerated example row.

**Traps**
- No references to this plan, the design, ADRs, matrix rows (C1…) or the backlog in source or test code.
- **Inert-change risk:** an "above the gate" row that does not exceed 65 536 compressed bytes silently takes
  the buffered arm — assert the file size in Arrange; use incompressible bytes.
- The header read at open must return the iterator when it throws, or the inflate pipeline leaks.
- `release()` through `inflated.cancel()` is a silent no-op once the iterator holds the lock.
- A related-test failure in the pre-commit hook for a command suite is this part's fixture debt, not flake:
  enumerate below and fix fixtures (write a real object, or use a non-branch ref where the type is not the
  point).
- `hashStoredObject` hashes even when a cache hit is available — do not add a "trusted cache" shortcut.
- If biome refuses the comment-only `for await` body, drain with `count` from
  `src/application/primitives/snapshot-operators/terminals.ts:7` instead; commit 2 replaces the loop anyway.

#### Commit 2 — git's commit and tag parse acceptance

**Design excerpt (ratified follow-up).** `parse_object_buffer` (`object.c:261`) refuses a commit or tag that
`parse_commit_buffer` (`commit.c:516`) or `parse_tag_buffer` (`tag.c:130`) refuses, and the transaction then
reports it as nonexistent. Transcribe git's acceptance — nothing stricter; tsgit's own parsers refuse objects
git accepts (`parseCommitContent` requires author/committer, `parseTagContent` refuses an empty name, both
take lower-case ids only). `h` = hex length (40 or 64); offsets are into the body after the loose header;
"hex" is `0-9`, `a-f` or `A-F`, decoded before any comparison.

| # | Commit condition that refuses | git's `error:` line | `reason` |
|---|---|---|---|
| PC1 | body length ≤ h + 6; or bytes 0–4 ≠ `tree `; or byte h + 5 ≠ LF | `bogus commit object <oid>` | `bogus commit object` |
| PC2 | bytes 5 … h + 4 not all hex | `bad tree pointer in commit <oid>` | `bad tree pointer` |
| PC3 | a parent line — entered at offset p only while more than h + 7 bytes remain and bytes p … p + 6 are `parent ` — is the last h + 8 bytes of the body, or bytes p + 7 … p + h + 6 are not all hex, or byte p + h + 7 ≠ LF | `bad parents in commit <oid>` | `bad parents` |
| PC4 | a parent id equals the tree id, and the commit is not a shallow boundary | `object <tree> is a tree, not a commit` + `bad parent <parent> in commit <oid>` | `bad parent <parent-id, lower-case>` |

The parent scan stops at the first line PC3 does not enter. Lines are checked in order; the first refusal
wins; within one line the grammar (PC3) precedes the lookup (PC4). A PC4 candidate on line k and a PC3
failure on a later line: `checked` → PC4, `skipped` (shallow) → PC3.

| # | Tag condition that refuses | git's `error:` line | `reason` |
|---|---|---|---|
| PT1 | body length < h + 24 | none | `tag object too short` |
| PT2 | bytes 0–6 ≠ `object `; or bytes 7 … h + 6 not all hex; or byte h + 7 ≠ LF | none | `bad object line` |
| PT3 | next bytes not `type `; or no LF before the body ends; or the type name before that LF is 20 bytes or longer | none | `bad type line` |
| PT4 | the type name compared up to its first NUL is not `blob`, `tree`, `commit` or `tag` | `unknown tag type '<name>' in <oid>` | `unknown tag type '<name>'` (name through `sanitizeForDisplay`, `src/domain/error.ts:124`) |
| PT5 | four or fewer bytes remain after the type line, or they do not start `tag `; or no LF follows `tag ` | none | `bad tag line` |

Not checked (accepted): everything after a commit's parent lines (author, committer, their absence,
encoding, gpgsig, message, later `parent` lines); a tag's `tagger`, empty name, message, signature, and
whether the tagged object exists or has the named type; any tree body; any blob. `bad tree pointer` via an
in-process conflict and `bad tag pointer` need a hash fixed point — unreachable, not transcribed. Residuals:
conflicts with objects parsed earlier in one git process; `info/grafts` (tsgit reads none, so PC4 refuses
where git skips a grafted commit).

**New pure module** — `src/domain/objects/parse-acceptance.ts` (no I/O; imports only
`src/domain/error.ts`'s `sanitizeForDisplay` and `src/domain/objects/encoding.ts`'s `decode` `:80`):
```ts
export interface ParseAcceptanceRefusal {
  readonly type: 'commit' | 'tag';
  readonly reason: string;
}
export interface ParseAcceptanceScan { /* readonly fields; opaque to callers */ }
export const startParseAcceptance = (type: 'commit' | 'tag', hexLength: 40 | 64): ParseAcceptanceScan;
export const feedParseAcceptance = (scan: ParseAcceptanceScan, chunk: Uint8Array): ParseAcceptanceScan; // never throws
export const needsParentLookups = (scan: ParseAcceptanceScan): boolean; // a parent id equalled the tree id
export const parseAcceptanceVerdict = (
  scan: ParseAcceptanceScan,
  options: { readonly parentLookups: 'checked' | 'skipped' },
): ParseAcceptanceRefusal | undefined;
```
Scan design (pre-chewed): the scan carries a phase, a byte count, the bytes of the current unfinished window
(bounded), the lower-cased tree hex, the first PC4 candidate (lower-cased parent hex) and the first grammar
refusal; each `feed` returns a new scan. Commit: the tree window needs h + 6 bytes (PC1 then PC2 are decided
at the verdict, since PC1's length test needs the total); a parent window at p needs up to h + 9 bytes or the
end of input — fewer than h + 8 bytes left at the end means the loop is not entered (accept), exactly h + 8
left means PC3, the (h + 9)th byte existing means "not the last line"; after the first grammar refusal or the
first line PC3 does not enter, stop inspecting (keep counting bytes). Tag: the object window needs h + 8
bytes; the type window keeps at most `type ` + 20 name bytes (20 name bytes without LF decide PT3 early);
the `tag ` window needs 5 bytes; the final LF search keeps only a flag. PT1 and PC1 read the total byte count
at the verdict, which checks conditions in table order. Retained memory is at most one window plus the tree
hex, whatever the body size.

**Wiring.**
- `blob-source.ts` `VerifiedObject` gains `readonly acceptance: ParseAcceptanceScan | undefined` (commit and
  tag only). `hashStoredObject` starts a scan for `source.type` `commit`/`tag`
  (`startParseAcceptance(type, ctx.hashConfig.hexLength)`), feeds `source.content` on the bytes arm (after
  `openBlobSource` already hashed it) or every chunk while draining the stream (the hash throws after the last
  chunk, before the scan is returned); the virtual empty tree returns `acceptance: undefined`.
- `ref-target.ts`:
  ```ts
  export const assertRefTargetValid = async (ctx: Context, name: RefName, id: ObjectId): Promise<void> => {
    if (id === zeroOid(ctx.hashConfig)) return;
    const { type, acceptance } = await verifyStoredObject(ctx, id);            // OBJECT_NOT_FOUND, OBJECT_HASH_MISMATCH
    if (acceptance !== undefined) await assertParseAccepted(ctx, id, acceptance); // INVALID_COMMIT, INVALID_TAG
    if (type !== 'commit' && isBranchRef(name)) throw unexpectedObjectType('commit', type, id);
  };
  const assertParseAccepted = async (ctx: Context, id: ObjectId, scan: ParseAcceptanceScan): Promise<void> => {
    const shallow = needsParentLookups(scan) && (await loadShallowSet(ctx)).has(id);
    const refusal = parseAcceptanceVerdict(scan, { parentLookups: shallow ? 'skipped' : 'checked' });
    if (refusal === undefined) return;
    throw refusal.type === 'commit' ? invalidCommit(refusal.reason) : invalidTag(refusal.reason);
  };
  ```
  `loadShallowSet` (`src/application/primitives/internal/shallow-set.ts:77`), `invalidCommit` / `invalidTag`
  (`src/domain/objects/error.ts:59`, `:62`). The shallow set is read only when a parent equalled the tree.

**Public or internal — decided: internal.** `parse-acceptance.ts` is not added to
`src/domain/objects/index.ts`. **Surface gates tripped:** none (existing codes).

**Tests (unit)**
- New `test/unit/domain/objects/parse-acceptance.test.ts` — one row per condition and boundary, both widths
  where the boundary depends on `h`: commit body of exactly h + 6 bytes (PC1) and h + 7 (accepted);
  `tree ` prefix wrong; LF missing at h + 5; non-hex tree (PC2); upper-case tree hex accepted; parent line
  that is the last h + 8 bytes (PC3); a `parent ` prefix with exactly h + 7 bytes left (accepted — loop not
  entered); non-hex parent; LF missing at p + h + 7; second parent line malformed (PC3); a `parent` line after
  `author` with junk (accepted); parent equal to tree with `checked` (PC4, reason carries the lower-cased id)
  and `skipped` (accepted); a PC4 candidate on line 1 and a PC3 failure on line 2 → `checked` PC4, `skipped`
  PC3; PC3 on line 1 and a candidate on line 2 → PC3 and `needsParentLookups` false; no author or committer
  (accepted); tag of h + 23 bytes (PT1) and h + 24 (not PT1); `object ` wrong; short object hex (PT2); `type `
  missing; type name of 19 bytes (accepted if valid) and 20 bytes (PT3); no LF after the type (PT3); `bogus`
  (PT4, reason `unknown tag type 'bogus'`); a control character in the name is sanitised in the reason;
  `commit\0x` accepted as `commit`; nothing after the type line (PT5); `tag ` followed by LF (accepted, empty
  name); `tag` with no LF after it (PT5).
- New `test/unit/domain/objects/parse-acceptance.properties.test.ts` — lens 4 (the verdict is invariant under
  re-feeding the same bytes in any partition): for bodies from a grammar generator (tree line, 0–3 parent
  lines, optional junk, random single-byte mutations, both widths, commit and tag shapes) and a random
  partition into chunks, `parseAcceptanceVerdict` and `needsParentLookups` of the chunked feed equal those of
  the one-chunk feed for both `parentLookups` values (`numRuns: 100`); lens 3: `feedParseAcceptance` never
  throws on arbitrary bytes and arbitrary partitions (`numRuns: 200`). Generators go in
  `test/unit/domain/objects/arbitraries.ts`. The oracle is the same function on a different partition —
  metamorphic, not a copy of the loop.
- `update-ref.test.ts` — hash-valid malformed commit (`writeRawObjectBytes`, `fixtures.ts:301`) →
  `refs/tags/x` → `INVALID_COMMIT { reason: 'bogus commit object' }`, nothing written; malformed commit →
  `refs/heads/x` → the parse refusal, not `UNEXPECTED_OBJECT_TYPE` (kills type-before-parse); malformed tag
  → `INVALID_TAG`; tree with garbage entries → `refs/tags/x` written; commit without author → `refs/heads/x`
  written; a loose commit above the gate (incompressible message ≥ 70 000 bytes, Arrange asserts the file
  size) with a bad parent line → refused and `ctx.compressor.inflate` never saw its bytes; parent equal to tree
  → refused, and with its id in `.git/shallow` (write the file, `invalidateShallowSet`) → written; an
  `instrumentedContext` over a commit whose parent differs from its tree shows no call on `/repo/.git/shallow`.
- `blob-source.test.ts` — `verifyStoredObject` returns `acceptance` for a commit and a tag (bytes and stream
  arms) and `undefined` for a blob, a tree and the virtual empty tree.

**Tests (interop)** — append to `ref-write-verification-interop.test.ts`. Objects written in the **base**
(`beforeAll`) with `git hash-object --literally -w -t <type> --stdin` (pass `input` to `runGit`), so both twins
hold them; targets written by `git update-ref` in `peer` and `updateRef` in `ours`: commit without a `tree`
line (refused, `error: bogus commit object <id>` ↔ `INVALID_COMMIT` `bogus commit object`); parent line with a
non-hex character (`bad parents`); tag type `bogus` (`unknown tag type 'bogus' in <id>` ↔ reason
`unknown tag type 'bogus'`); tag `object` line cut to 30 hex (fatal only ↔ `bad object line`); commit with
`tree`/`parent` but no author/committer on `refs/heads/x` (accepted by both); garbage tree on `refs/tags/x`
(accepted); parent equal to tree (both error lines ↔ `bad parent <tree>`); the same commit listed in
`.git/shallow` in both twins, on `refs/tags/*` and `refs/heads/*` (accepted); upper-case tree hex on
`refs/heads/x` (accepted); junk `parent` after `author` (accepted); empty tag name (accepted); tag body
shorter than h + 24 (refused ↔ `tag object too short`).

#### Commit 3 — `tag.create` reports an existing name before verifying the target (B)

**Design excerpt.** For a lightweight tag git checks existence only (B1: tree, blob and tag-object targets
succeed; B2/B5: a missing object refuses in the transaction; B8 reftable identical). An existing name is
reported before the target is verified (B4), because `builtin/tag.c:658-694` resolves the target, validates
the name, checks `already exists`, creates the tag object, then runs the transaction. B3 (`0123456`, `nope`)
fails resolution first; B6 (`bad..name`) fails name validation; B7 annotated to a missing object: git
`fatal: bad object type.`, tsgit `OBJECT_NOT_FOUND` from `resolveObjectType` — unchanged. After commit 1,
B2/B5 refuse structurally through `updateRef`; tsgit detects an existing name only through `updateRef`'s CAS
(`updateTagRef`, `src/application/commands/tag.ts:192-212`), which now runs after verification.

**Change** — `src/application/commands/tag.ts:85-103` `tagCreate`, after `assertRepoSettingsValid` (`:99`),
before `createAnnotatedTag` (`:100`):
```ts
if (input.force !== true && (await refExists(ctx, name))) throw tagExists(name);
```
`refExists` (`src/application/primitives/ref-store.ts:284-286`, imported `:25`) and `tagExists` (imported `:7`)
exist; the CAS in `updateTagRef` stays as the race guard. `branch.create` already has the same pre-check
(`src/application/commands/branch.ts:124`). Refusals: `OBJECT_NOT_FOUND { id }` (from `updateRef`),
`TAG_EXISTS` (existing data shape).

**Public or internal:** no new symbol. **Surface gates tripped:** none. Docs: `docs/use/commands/tag.md`.

**Tests**
- `test/unit/application/commands/tag.test.ts` — lightweight to a missing full oid → `OBJECT_NOT_FOUND { id }`,
  no `refs/tags/<name>`; to a tree, a blob and an annotated tag object → written; existing name + missing
  target → `TAG_EXISTS` (the row that fails without the pre-check); `force: true` + missing target →
  `OBJECT_NOT_FOUND`; annotated with an existing name + missing target → `TAG_EXISTS`. Rows `:377`, `:400`
  (unresolvable targets) stay.
- Interop (append): B1 (four types written, `for-each-ref --format=%(objecttype)` matches tsgit's stored
  targets' types), B2, B3 (both refuse, nothing written), B4, B5 (`-f`), B6, B7 (both refuse, nothing
  written), B8 on the reftable twin (tree written, missing refused). tsgit through `tagCreate` from
  `src/application/commands/tag.ts`.

**Traps (commits 2 and 3)**
- No references to this plan, the design, ADRs, matrix rows (PC1, B4…) or the backlog in source or test code.
- `feedParseAcceptance` must not throw on any input; record the first failure and keep counting — a throw
  would take precedence over `OBJECT_HASH_MISMATCH`, which git reports first.
- The verdict is read only after the hash passed: never call `parseAcceptanceVerdict` inside the drain.
- `refExists` treats a symbolic `refs/tags/<name>` as existing, as `branch.create` already does.

### TDD steps

**Commit 1 (C)**
1. **RED** — `blob-source.test.ts`: a streamed loose commit reports `type: 'commit'` at open. Fails:
   `undefined`.
2. **GREEN** — `readLooseHeader`, `yieldAndVerifyLooseChunks`, `returnIterator`, `BlobSource` narrowing;
   `stream-blob.ts:21` and `whitespace-drop-predicate.ts:46` conditions; fix the flipped rows.
3. **RED** — `update-ref.test.ts`: tree → `refs/heads/x` refuses `UNEXPECTED_OBJECT_TYPE`. Fails: written.
4. **RED** — missing id → `refs/tags/x` refuses `OBJECT_NOT_FOUND`. Fails: written.
5. **RED** — mismatching blob → `refs/heads/x` refuses `OBJECT_HASH_MISMATCH`. Fails: written.
6. **GREEN** — export `withLazyFetchRetry`; `verifyStoredObject`, `hashStoredObject`, the empty-tree arm;
   `ref-target.ts`; `updateRef` placement.
7. **RED/GREEN** — remaining `update-ref.test.ts` rows (HEAD, non-branch refs, `ORIG_HEAD`, CAS order,
   delete and null id unverified, cache hit hashed, above-the-gate blob, empty tree/blob, annotated tag not
   peeled).
8. **RED/GREEN** — `blob-source.test.ts` per-arm verifier rows, including the promisor row.
9. **RED/GREEN** — `clone.test.ts` refusal rows; then `writeRef` / `applyRemoteHead` placement.
10. **GREEN** — enumerate and repair fixtures (batches below): `clone.test.ts` commit helper, `laws.test.ts`,
    `reftable-refs.scenario.ts`, every failing command suite.
11. **RED/GREEN** — interop C1–C9, empty tree/blob, reftable rows.
12. **Probe** — the wall-clock A/B (addendum probes table), idle machine only.

**Commit 2 (parse acceptance)**
13. **RED** — `parse-acceptance.test.ts` PC1 row. Fails: module missing.
14. **GREEN** — commit scan through PC1–PC3; **RED/GREEN** PC4 with `checked`/`skipped` and ordering rows.
15. **RED/GREEN** — tag scan PT1–PT5 rows.
16. **RED/GREEN** — property suite; a failing partition means a window that lost its carry across chunks.
17. **RED** — `update-ref.test.ts` malformed commit → `INVALID_COMMIT`. Fails: written.
18. **GREEN** — `VerifiedObject.acceptance`, scan feeding in `hashStoredObject`, `assertParseAccepted`.
19. **RED/GREEN** — remaining unit rows (branch parse-before-type, above-the-gate stream, shallow skip,
    shallow not read), then the interop parse rows.

**Commit 3 (B)**
20. **RED** — `tag.test.ts`: existing name + missing target → `TAG_EXISTS`. Fails: `OBJECT_NOT_FOUND`.
21. **GREEN** — the pre-check. **RED/GREEN** — remaining `tag.test.ts` rows, then interop B1–B8.
22. **REFACTOR** — `tagCreate`'s comment at `:96-98` states git's order (resolve, class, exists, create,
    verify).

### Gate

Commit 1 (C; unit batches, one invocation each):
```
npx vitest run --maxWorkers=2 test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/stream-blob.test.ts test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/laws.test.ts test/unit/application/primitives/commondir-per-worktree-refs.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/clone.test.ts test/unit/application/commands/tag.test.ts test/unit/application/commands/branch.test.ts test/unit/application/commands/commit.test.ts test/unit/application/commands/reset.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/internal/commit-ish.test.ts test/unit/application/commands/name-rev.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/fetch.test.ts test/unit/application/commands/push.test.ts test/unit/application/commands/pull.test.ts test/unit/application/commands/rebase.test.ts test/unit/application/commands/notes.test.ts test/unit/application/commands/remote.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/abort-merge.test.ts test/unit/application/commands/stash.test.ts test/unit/repository/reftable-extension-accepted.test.ts test/unit/application/commands/diff.test.ts
npx vitest run --maxWorkers=1 test/parity/memory.test.ts test/parity/node.test.ts
```
Interop (one invocation each): `test/integration/ref-write-verification-interop.test.ts`,
`test/integration/blob-streaming-interop.test.ts`, `test/integration/blob-streaming-checkout-interop.test.ts`,
`test/integration/loose-ref-interop.test.ts`, `test/integration/tag-interop.test.ts`,
`test/integration/branch-start-point-interop.test.ts`, `test/integration/head-symlink-interop.test.ts`,
`test/integration/reftable-ref-storage-interop.test.ts`, `test/integration/bare-repo-custom-gitdir-interop.test.ts`.
Then:
```
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/internal/blob-source.ts src/application/primitives/internal/ref-target.ts src/application/primitives/internal/whitespace-drop-predicate.ts src/application/primitives/stream-blob.ts src/application/primitives/read-object.ts src/application/primitives/update-ref.ts src/application/commands/clone.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/stream-blob.test.ts test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts test/unit/application/commands/clone.test.ts test/unit/application/primitives/laws.test.ts test/parity/scenarios/reftable-refs.scenario.ts test/integration/ref-write-verification-interop.test.ts
npx cspell --no-progress src/application/primitives/internal/blob-source.ts src/application/primitives/internal/ref-target.ts src/application/primitives/update-ref.ts src/application/commands/clone.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/commands/clone.test.ts test/integration/ref-write-verification-interop.test.ts
```
Add to both lists every other fixture file the enumeration touched.

Commit 2 (parse acceptance):
```
npx vitest run --maxWorkers=2 test/unit/domain/objects/parse-acceptance.test.ts test/unit/domain/objects/parse-acceptance.properties.test.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/commands/clone.test.ts test/unit/application/commands/commit.test.ts
npx vitest run test/integration/ref-write-verification-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/objects/parse-acceptance.ts src/application/primitives/internal/blob-source.ts src/application/primitives/internal/ref-target.ts test/unit/domain/objects/parse-acceptance.test.ts test/unit/domain/objects/parse-acceptance.properties.test.ts test/unit/domain/objects/arbitraries.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/integration/ref-write-verification-interop.test.ts
npx cspell --no-progress src/domain/objects/parse-acceptance.ts src/application/primitives/internal/ref-target.ts test/unit/domain/objects/parse-acceptance.test.ts test/unit/domain/objects/parse-acceptance.properties.test.ts test/unit/domain/objects/arbitraries.ts test/integration/ref-write-verification-interop.test.ts
```

Commit 3 (B):
```
npx vitest run --maxWorkers=2 test/unit/application/commands/tag.test.ts
npx vitest run test/integration/ref-write-verification-interop.test.ts
npx vitest run test/integration/tag-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/commands/tag.ts test/unit/application/commands/tag.test.ts test/integration/ref-write-verification-interop.test.ts
npx cspell --no-progress src/application/commands/tag.ts test/unit/application/commands/tag.test.ts test/integration/ref-write-verification-interop.test.ts
```

**Owed at the phase boundary:** `check:size` and `check:tarball` (this part likely crosses the browser
bundle, primitives-chunk and domain-chunk limits and the tarball cap — see Size budgets);
`check:write-surfaces` and `check:test-pyramid` (new interop `@proves`); browser e2e for the changed parity
scenario. **Surface gates tripped:** none mechanical.

### Commit

Commit 1: `feat(refs): verify a ref update's target object as git's ref transaction does`

Commit 2: `feat(refs): refuse a ref target that git's commit and tag parse acceptance refuses`

Commit 3: `fix(tag): report an existing tag name before verifying the target`

## Part 20 — `reflog expire`: split, `repo_dwim_log` target resolution, `gc.reflogExpire*` policy (design K + E + D, DC-D1, DC-D2, DC-D3, DC-E1, DC-E2, ADRs 865, 866, 867) — 3 commits

### Context

**Depends on Part 14** (E classifies ref-read failures with the domain `errorDataCode`). Independent of
Parts 15–19 in functions. All three commits edit `src/application/commands/reflog.ts` (467 lines), in order
K → E → D.

**Current code (verified)** — `src/application/commands/reflog.ts`: `:28-43` `ReflogAction` (expire arm
`{ action: 'expire'; ref?; all?; expire?; expireUnreachable? }`); `:69-70` `DEFAULT_EXPIRE = '90.days.ago'`,
`DEFAULT_EXPIRE_UNREACHABLE = '30.days.ago'`; `:77` `resolveUserRef` (`validateRefName`); `:79-89` `reflog`
(`assertRepoSettingsValid` at `:85`, before `delete`/`expire`/`show`; comment `:82-84`); `:112-113`
`hasReflog`; `:164-194` `runExpire` (31 lines: cutoffs `:173-175`, targets `:176`, loop `:180-185`, the
one-transaction comment `:186-191`, `applyRefUpdates` `:192`); `:201-213` `resolveExpireTargets` (the
`hasReflog` guard and its comment `:205-210`); `:220-247` `expireReflog`; `:249-257` `resolveCutoff`
(`resolveExpiryCutoff` → `revparseUnresolved`); `:267-280` `expireKindFor` (peels with `peelRefToCommit` at
`:277`); `:312-321` `readAncestorMeta`; `:394-401` `peelGently`; `:458-466` `tryResolve`.
`resolveExpiryCutoff(raw, nowSeconds)` — `src/application/primitives/expiry-cutoff.ts:37-42`.

#### Commit 1 — `runExpire` under 20 lines (K), pure refactor

`runExpire` runs once per command and each iteration awaits file and commit reads, so an extracted `async`
helper's microtask is below measurement — not the per-object hot path the parent design protects.

```ts
type ExpireOptions = Extract<ReflogAction, { readonly action: 'expire' }>;
interface ExpiryCuts { readonly expireCut: number; readonly unreachableCut: number }
interface ExpiryPolicy { readonly cutoffsFor: (ref: RefName) => ExpiryCuts }

const resolveExpiryPolicy = (now: number, opts: ExpireOptions): ExpiryPolicy => {
  const cuts: ExpiryCuts = {
    expireCut: resolveCutoff(opts.expire ?? DEFAULT_EXPIRE, now),
    unreachableCut: resolveCutoff(opts.expireUnreachable ?? DEFAULT_EXPIRE_UNREACHABLE, now),
  };
  return { cutoffsFor: () => cuts };
};

const runExpire = async (ctx: Context, opts: ExpireOptions): Promise<ReflogResult> => {
  const policy = resolveExpiryPolicy(Math.floor(Date.now() / 1000), opts);
  const targets = await resolveExpireTargets(ctx, opts);
  const outcome = await expireTargets(ctx, targets, policy);
  // (the existing one-transaction comment, verbatim)
  await getRefStore(ctx).applyRefUpdates(outcome.updates);
  return { kind: 'expire', removed: outcome.removed, kept: outcome.kept };
};

/** Strictly sequential: each target's reachability state is built inside expireReflog, never shared. */
const expireTargets = async (ctx, targets, policy): Promise<ExpireOutcome> => { … };  // loop, push update even when nothing prunes
```
Preserved invariants: one `applyRefUpdates` per run; an update per target even when nothing prunes; the
log-existence guard before any rewrite; reachability state per ref; targets sequential; `resolveCutoff`
refusals before target resolution.

#### Commit 2 — target resolution as `repo_dwim_log` (E)

**Design excerpt (DC-E1 a, DC-E2 a).** `builtin/reflog.c:282-297` and `refs.c:840-879` `repo_dwim_log`: for
each `ref_rev_parse_rules` candidate, the name must resolve for reading (follows symrefs; a missing terminal
ref, an invalid name or unparseable content fails; the object is never read), then the candidate's own log
wins, else — for a symref — the log of the ref it resolves to; first hit wins; none ⇒
`reflog could not be found: '<argument>'`. With no ref and no `--all`, nothing is expired. The repo-settings
class is reached only after the target resolves, and never with zero targets.

| Pin | git 2.55.0 |
|---|---|
| E1 | `refs/heads/gone` deleted, log kept: `expire --expire=now refs/heads/gone` → 255 `error: reflog could not be found: 'refs/heads/gone'`, log untouched; short `gone` → same with `'gone'` |
| E2 | packed-only ref with a log → 0, expired |
| E3 | ref exists, no log → 255 (tsgit agrees today) |
| E4 | `expire side` → 0, `refs/heads/side`'s log expired |
| E5 | dangling symref `refs/heads/sym → refs/heads/nope` with its own log → 255 |
| E6 | symref `sym2 → main` with its own log → 0, `sym2`'s log expired, `main`'s untouched |
| E6b | symref `sym2 → main`, no own log → 0, `main`'s log expired |
| E7 | `expire HEAD`, `logs/HEAD` absent → 0, `main`'s log expired |
| E8 | unborn `HEAD` (→ `refs/heads/unborn`), `logs/HEAD` present → 255, log untouched |
| E10 | `expire --expire=now` (no ref, no `--all`) → 0, `HEAD` and `main` logs untouched |
| E12 | `refs/heads/bad..name`; `HEAD@{0}` → 255 (not an invalid-name refusal) |
| E13 | loose ref with unparseable content, log present → 255 |
| E14 | ref holding a missing object's id, `--expire=now` → 0, expired |
| E15 | same ref, `--expire=never --expire-unreachable=now` → 0, every entry expired |
| E16 | `refs/tags/tree-tag` → tree with a log, `never`/`now` → 0, all expired (tsgit agrees today) |
| O-a / O-b | malformed `core.deltaBaseCacheLimit` + `expire refs/heads/nope` / `refs/heads/gone` → 255 could not be found |
| O-c | malformed class + `--expire=bogus HEAD` → 128 invalid timestamp |
| O-d | malformed class + `expire --expire=now` (no ref) → 0 |
| O-e / O-f | malformed class + `--all`; + `never`/`never HEAD` → 128 class |
| planning | malformed class + `--all --expire=now`, zero reflogs → 0 |

**Changes**
- `src/application/primitives/resolve-ref.ts:14-16` `ChainOutcome` `found` arm gains
  `readonly name: RefName`; `resolveDirectChain` (`:64-107`) returns `{ kind: 'found', id: result.id, name:
  current }` at `:93-95`. New export (internal — `src/application/primitives/index.ts:88` exports `resolveRef`
  by name only):
  ```ts
  /** The name a ref resolves to for reading — undefined when the chain ends missing or a link's content or
   *  name is unparseable (git's RESOLVE_REF_READING failure); cycle and depth refusals propagate. */
  export async function resolveTerminalName(ctx: Context, name: RefName | 'HEAD'): Promise<RefName | undefined> {
    try {
      const outcome = await resolveChainOutcome(ctx, name, undefined);
      return outcome.kind === 'found' ? outcome.name : undefined;
    } catch (err) {
      if (UNREADABLE_REF_CODES.has(errorDataCode(err) ?? '')) return undefined;
      throw err;
    }
  }
  ```
  `UNREADABLE_REF_CODES = new Set(['INVALID_REF', 'INVALID_OBJECT_ID'])` — `INVALID_OBJECT_ID` is what
  `parseLooseRef` raises for content that is neither an oid nor `ref: …` (design gap G3, option a).
- `reflog.ts:79-89` — dispatch `expire` before `assertRepoSettingsValid`; rewrite the comment (`exists` and
  `expire` reach the class on their own terms).
- `runExpire` gains one line after the targets: `if (targets.length > 0) await assertRepoSettingsValid(ctx);`.
- `resolveExpireTargets` (`:201-213`):
  ```ts
  const resolveExpireTargets = async (ctx: Context, opts: ExpireOptions): Promise<ReadonlyArray<RefName>> => {
    if (opts.all === true) return listReflogs(ctx);
    if (opts.ref === undefined) return [];            // git expires nothing without a ref or --all
    return [await dwimReflog(ctx, opts.ref)];
  };
  /** git's repo_dwim_log: the first candidate that resolves and has a log — its own, else its symref target's.
   *  Only a name that has a log is returned, so the unconditional rewrite never manufactures a log file. */
  const dwimReflog = async (ctx: Context, arg: string): Promise<RefName> => {
    for (const candidate of refCandidates(arg)) {
      const found = await logForCandidate(ctx, candidate);
      if (found !== undefined) return found;
    }
    throw reflogNotFound(arg as RefName);
  };
  const logForCandidate = async (ctx: Context, candidate: RefName | 'HEAD'): Promise<RefName | undefined> => {
    if (!isSafeRefName(candidate)) return undefined;                // no I/O for an invalid name
    const terminal = await resolveTerminalName(ctx, candidate);
    if (terminal === undefined) return undefined;
    if (await hasReflog(ctx, candidate as RefName)) return candidate as RefName;
    return terminal !== candidate && (await hasReflog(ctx, terminal)) ? terminal : undefined;
  };
  ```
  `refCandidates` (`src/domain/refs/ref-candidates.ts:19-26`, rule order verbatim, tags before heads),
  `isSafeRefName` (`src/domain/refs/ref-validation.ts:64`), `reflogNotFound`
  (`src/domain/reflog/error.ts:17-18`, `{ code: 'REFLOG_NOT_FOUND', ref }`).
- `expireKindFor` (`:267-280`) — `peelRefToCommit(ctx, direct.id)` (`:277`) → `peelGently(ctx, direct.id)`
  (`:394-401`): a tip naming a missing object expires by clock (E14/E15).

**Tests (unit)** — `test/unit/application/commands/reflog.test.ts` (2 278 lines; fixtures `seedRepo`,
`writeReflog`, `writeCommit` `:51`, `entry`, `identityAt`, `wallNow` `:846`):
- **Flip** `:787-803` ("expire `../../etc/passwd` throws INVALID_REF") → `REFLOG_NOT_FOUND { ref:
  '../../etc/passwd' }` **and** an `instrumentedContext` shows no fs call whose path contains `etc/passwd`
  (the path-safety property survives the code change). The `show`/`delete` rows above it stay `INVALID_REF`.
- **Flip** `:1019-1042` ("expire defaults to HEAD") → no ref, no `all` → `{ kind: 'expire', removed: 0,
  kept: 0 }`, both logs byte-identical, and no `applyRefUpdates` rewrite.
- `:1122-1144` (missing reflog → `REFLOG_NOT_FOUND`, no file created) stays.
- New isolated rows for each `logForCandidate` arm: invalid name → no I/O; candidate does not resolve;
  own log; symref target's log; neither. DWIM: `side` → `refs/heads/side`; a name present as both
  `refs/tags/x` and `refs/heads/x`, both with logs → the tag's log (rule order). E1 gone ref (log bytes
  untouched); E5 dangling symref; E6 own log wins; E6b target log; E7 `HEAD` without its log; E8 unborn `HEAD`;
  E12 `HEAD@{0}`; E13 unparseable content (`garbage\n`) → `REFLOG_NOT_FOUND`; E14/E15 missing tip object →
  expired by clock, no `OBJECT_NOT_FOUND`; E16 tree-tag `always` (unchanged). Class ordering: malformed
  `core.deltaBaseCacheLimit` + unresolvable ref → `REFLOG_NOT_FOUND`; + no ref → no-op; + resolvable ref →
  `CONFIG_BAD_NUMERIC_VALUE`; + `all` with zero logs → no-op.
- `test/unit/application/primitives/resolve-ref.test.ts` — `resolveTerminalName`: direct ref → its own name;
  two-hop symref chain → the terminal name; missing terminal → `undefined`; unparseable content →
  `undefined`; symref to an invalid name → `undefined`; cycle → still refuses `REF_CYCLE_DETECTED` (assert
  `data.code`). `resolveRef`'s existing rows stay (the `found` arm only gained a field).

**Tests (interop)** — extend `test/integration/reflog-interop.test.ts` (base `baseDir` with four commits at
`BASE_EPOCH`, `caseDir(slug)` `:367`, `cloneRepo` `:357`, `mainLogPath`, `headLogPath`, `branchLogPath`,
`refPath`). **Flip** `:1927-1959` ("git refuses while tsgit proceeds — a recorded, pre-existing divergence")
into the E1 agreement row (both refuse, log bytes untouched in both) — replace it, do not add a duplicate. New
rows, each comparing git's exit code and `reflog could not be found: '<arg>'` line (reconstructed from
`data.ref`) with tsgit's result, and log bytes across twins where a log is rewritten: E1 (full and short
name), E2 (`git pack-refs --all`), E4, E5, E6, E6b, E7, E8, E10, E12 (`refs/heads/bad..name` and `HEAD@{0}`),
E13, E14, E15, O-a, O-b, O-c (git 128 `invalid timestamp` ↔ tsgit `REVPARSE_UNRESOLVED`, both refuse before
the class), O-d, O-e, and the zero-reflog `--all` row. Unit-only, with reason: E3 and E16 (unchanged
agreement on the same code path as pinned rows), O-f (same ordering as O-e with a resolvable `HEAD`); out of
scope: E9 (tsgit takes one ref) and the `exists`/`delete`/`show` rows.

#### Commit 3 — `gc.reflogExpire*` policy (D)

**Design excerpt (DC-D1 a, DC-D2 a, DC-D3 b).** `reflog.c:35-80` `reflog_expire_config`, `:17-33`
`find_cfg_ent`, `:98-133` `reflog_expire_options_set_refname`, `reflog.h:25-28`
`REFLOG_EXPIRE_OPTIONS_INIT`, `builtin/reflog.c:216` (configuration) before `:221` (options). Per slot, in
order: an explicit flag; else the **first** pattern entry (first appearance, same pattern text merged) whose
`wildmatch(pattern, ref, 0)` matches supplies the slot — an unset slot is **never**; else `refs/stash` ⇒
never; else the last valid `[gc]` value; else the default (total 30 days, unreachable 90 days — git ≥ 2.50's
binary). Every entry is validated in file order before anything else, whether or not it matches: valueless ⇒
`CONFIG_MISSING_VALUE { key, source, line }`; unparseable ⇒ `CONFIG_BAD_DATE_VALUE { value, key, source,
line }`; valid duplicates are last-wins. Keys are lowercased with the subsection verbatim
(`gc.refs/tags/*.reflogexpire`). Only `reflog expire` reads these keys. Local configuration only (ADR-637).

Matrix (git 2.55.0; `main` at C; A 200 d → B 100 d → C 60 d; U 60 d child of B and U2 10 d child of C
dangling; `logs/refs/heads/main` rewritten per row with e1 `0→A` 200 d, e2 `A→B` 100 d, e3 `B→U` 60 d,
e4 `U→B` 60 d, e5 `B→C` 60 d, e6 `C→U2` 10 d, e7 `U2→C` 10 d; cells are entries **kept**):

| # | Config / flags | Kept |
|---|---|---|
| D0 / D0′ | none, `refs/heads/main` / `main` | e6 e7 |
| D0″ | none, no ref | all 7 (no-op) |
| D1 | `gc.reflogExpire = never` | all 7 |
| D2 | `gc.reflogExpireUnreachable = never` | e6 e7 |
| D3 / D3b | `45.days.ago`/`15.days.ago` / `120.days.ago`/`45.days.ago` | e6 e7 / e2 e5 e6 e7 |
| D4 / D4b | D3b + `--expire=now` / `--expire=never` | none / e1 e2 e5 e6 e7 |
| D5 / D5b | D3b + `--expire-unreachable=never` / both flags `150.days.ago` `5.days.ago` | e2–e7 / e2 e5 |
| D6 / D6b / D6c | `[gc "refs/heads/*"]` total `120.days.ago` only / unreachable `45.days.ago` only / both | e2–e7 / e1 e2 e5 e6 e7 / e2 e5 e6 e7 |
| D6d / D6e | global 120/45 + pattern `reflogExpire = never` (either section order) | all 7 |
| D7 | non-matching `[gc "refs/tags/*"]` never/never | e6 e7 |
| D8 / D8b | `heads/*` never/never then `heads/m*` total `now`; reverse order | all 7 / none |
| D8c | `[gc "refs/heads/*"]` total 120 d, a second `[gc "refs/heads/*"]` unreachable 45 d | e2 e5 e6 e7 |
| D8d / D8e | pattern `refs/heads/main` / `main` (never/never) | all 7 / e6 e7 |
| D8f / D8g | pattern `refs/*` / `refs/**` (never/never) | all 7 / all 7 |
| D8h (planning) | `refs/heads/m[a-z]in`, `m[[:lower:]]in`, `m[]a]in`, `m[a-]in` / `m[!a]in`, `m[^a]in`, `m[[:digit:]]in`, `M*`, `m[a` (`reflogExpire = never`) | all 7 / e6 e7 |
| D9 / D9b / D9c | `false`/`false`; total `now`; unreachable `all` | all 7 / none / none |
| D9d / D9e | `150 days ago`/`2 weeks ago`; `@<now − 50 d>`/`@<now − 5 d>` | e2 e5 e6 e7 / none |
| D10 | `reflogExpire = bogus` | 128 `error: 'bogus' for 'gc.reflogexpire' is not a valid timestamp` + `fatal: bad config variable 'gc.reflogexpire' in file '.git/config' at line <n>`; nothing rewritten |
| D10b / D10c | valueless / empty | `error: missing value for 'gc.reflogexpire'` + same fatal / `'' for …` + same fatal |
| D10d / D10e | `bogus` then `never`; `never` then `bogus` | 128 at the bogus line (not last-wins) |
| D10f | `[gc "refs/tags/*"] reflogExpire = bogus` (non-matching) | 128, key `gc.refs/tags/*.reflogexpire` |
| D10g | `bogus` + both flags | 128 |
| D10h / D10i | `NEVER`; `120.days.ago` then `never` | all 7 / all 7 |
| D12 / D12b | `refs/stash` log (stash → C), no config; global 45/15 | all 7 / all 7 |
| D12c / D12d | `[gc "refs/stash"] reflogExpire = 45.days.ago`; `--expire=45.days.ago` | e6 e7 / e6 e7 |
| D13 / D13b | `HEAD` log, defaults; `[gc "HEAD"]` never/never | e6 e7 / all 7 |
| D14 / D14b (planning) / D15 | `bogus` + `expire refs/heads/nope`; `bogus` + no ref; `bogus` + `--expire=bogus2 HEAD` | 128 configuration refusal each |
| D16–D19 | `bogus` + `reflog show HEAD` / `delete HEAD@{0}` / `exists HEAD` / `status` | 0 each |
| D20 / D21 | `bogus` + malformed `core.deltaBaseCacheLimit`, either line order | configuration refusal both |
| D22 | `--expire=bogus HEAD`, clean config | git 128 `invalid timestamp`; tsgit `REVPARSE_UNRESOLVED` (unchanged, titled divergence) |
| D23 | `--all --expire=now` with `HEAD` | 0, everything expired |

**Files**
- New `src/domain/refs/ref-glob.ts` (DC-D3 b, engine per G4 option a) — git's `wildmatch(pattern, text, 0)`:
  `*` and `**` match any run including `/`; `?` one byte including `/`; `\x` a literal `x` (a trailing lone
  `\` never matches); `[…]` a set: `!` or `^` first negates; the first member may be `]`; `a-z` a byte range
  (a `-` first, last, or right after a range is literal); `\` escapes inside; `[:alnum:]`, `alpha`, `blank`,
  `cntrl`, `digit`, `graph`, `lower`, `print`, `punct`, `space`, `upper`, `xdigit` (ASCII classes); a `[:`
  without a closing `:]` treats `[` as a member; an unknown class name, an unterminated `[`, or `\` at the end
  of a set makes the pattern match nothing. Case-sensitive. Match over UTF-8 bytes of both strings
  (`encode`, `src/domain/objects/encoding.ts:76`), tokenised once, matched with a linear
  `O(tokens × length)` dynamic program (the `compileGlob` shape, `src/domain/pathspec/compile-glob.ts`),
  never a `RegExp`.
  ```ts
  export const compileRefGlob = (pattern: string): ((ref: string) => boolean) => { … };
  export const matchRefGlob = (pattern: string, ref: string): boolean => compileRefGlob(pattern)(ref);
  ```
  Probe unclear cases in a scratch repository (`[gc "<pattern>"] reflogExpire = never` against a 200-day-old
  entry, as in the planning pins), never from memory.
- `src/domain/name-rev/ref-pattern.ts:7-21` — delete `escapeLiteral`, `globToRegExp`, `matchRefGlob`; import
  `matchRefGlob` from `../refs/ref-glob.js`; `buildRefFilter` (`:34`) unchanged; docstring (`:1-6`) names the
  shared dialect. `src/domain/name-rev/index.ts:7` still exports only `buildRefFilter`.
- New `src/domain/reflog/expire-policy.ts` (split per Deviation 3):
  ```ts
  export interface ReflogExpiryConfigEntry {
    readonly pattern: string | undefined;   // subsection verbatim; undefined for [gc]
    readonly slot: 'total' | 'unreachable';
    readonly value: string | null;          // null = valueless
    readonly key: string;                   // 'gc.reflogexpire' | 'gc.<pattern>.reflogexpireunreachable' …
    readonly source: string;
    readonly line: number;                  // 1-based
  }
  export interface ExpiryCuts { readonly expireCut: number; readonly unreachableCut: number }
  export interface ExplicitExpiryCuts { readonly total?: number; readonly unreachable?: number }
  export interface ReflogExpiryPolicy { readonly cutoffsFor: (ref: RefName | 'HEAD') => ExpiryCuts }
  export interface ParsedExpiryConfig { /* readonly: pattern table in first-seen order, global slots */ }
  /** reflog_expire_config: every entry parsed in file order; the first invalid one throws. */
  export const parseReflogExpiryEntries = (
    entries: ReadonlyArray<ReflogExpiryConfigEntry>,
    parse: (raw: string) => number | undefined,
  ): ParsedExpiryConfig;
  /** reflog_expire_options_set_refname, per slot: explicit, first matching pattern (unset = never),
   *  refs/stash never, last global value, default. */
  export const expiryPolicyFor = (
    config: ParsedExpiryConfig,
    explicit: ExplicitExpiryCuts,
    defaults: ExpiryCuts,
  ): ReflogExpiryPolicy;
  ```
  "Never" is `Number.NEGATIVE_INFINITY` (what `resolveExpiryCutoff` returns for `never`/`false`). Patterns are
  compiled once with `compileRefGlob`. `refs/stash` is a local constant.
- `src/domain/commands/error.ts` — `:188` union member →
  `{ readonly code: 'CONFIG_BAD_DATE_VALUE'; readonly value: string; readonly key?: string; readonly source?: string; readonly line?: number }`;
  `:641-649` factory → `configBadDateValue(value: string, location?: { readonly key: string; readonly source:
  string; readonly line: number })` spreading `key: sanitizeForDisplay(location.key)`, `source`, `line` only
  when `location` is given (`exactOptionalPropertyTypes` is on, `tsconfig.json:10`); docstring covers both
  callers. `configMissingValue(key, source, line)` (`:582`) is reused as is.
- `src/domain/error.ts:510-511` message: unchanged when `key` is absent; with a location append
  ` for '${key}' in file ${source} at line ${line}`.
- `src/application/primitives/config-read.ts` — after `findFirstValuelessInSection` (`:699-727`, same token
  walk shape over `readConfigEntry` `:487`, `token.startLine + 1` lines, lowercased section and key):
  `export const readReflogExpiryConfig = async (ctx: Context): Promise<ReadonlyArray<ReflogExpiryConfigEntry>>`
  — every `[gc]` / `[gc "<pattern>"]` entry whose lowercased key is `reflogexpire` (slot `total`) or
  `reflogexpireunreachable` (slot `unreachable`); parses no values. Internal (not in
  `src/application/primitives/index.ts:24-32`).
- `src/application/commands/reflog.ts` — `:69-70` → `DEFAULT_EXPIRE = '30.days.ago'`,
  `DEFAULT_EXPIRE_UNREACHABLE = '90.days.ago'`; delete commit 1's local `ExpiryCuts`/`ExpiryPolicy` in favour of
  the domain types; `resolveExpiryPolicy` becomes:
  ```ts
  const resolveExpiryPolicy = async (ctx: Context, now: number, opts: ExpireOptions): Promise<ReflogExpiryPolicy> => {
    const config = parseReflogExpiryEntries(await readReflogExpiryConfig(ctx), (raw) => resolveExpiryCutoff(raw, now));
    return expiryPolicyFor(config, explicitCuts(opts, now), defaultCuts(now));   // flag refusals after config refusals
  };
  ```
  `runExpire`'s first line becomes `const policy = await resolveExpiryPolicy(ctx, Math.floor(Date.now() /
  1000), opts);`; `expireTargets` asks `policy.cutoffsFor(ref)` with the **resolved** refname. `runExpire`
  stays under 20 lines.

**Public or internal — decided.** Internal: `ref-glob.ts`, `expire-policy.ts` (not added to
`src/domain/refs/index.ts` or `src/domain/reflog/index.ts`), `readReflogExpiryConfig`, `resolveTerminalName`.
**Public shape change:** `CONFIG_BAD_DATE_VALUE`'s data gains three optional fields (the error union is in
`reports/api.json` via `TsgitErrorData`). No exhaustiveness switch changes (the code exists:
`test/unit/domain/exhaustiveness.ts:168`, `src/domain/error.ts:510`).

**Tests (unit)**
- New `test/unit/domain/refs/ref-glob.test.ts` — move the `matchRefGlob` rows from
  `test/unit/domain/name-rev/ref-pattern.test.ts:1-58` (the `buildRefFilter` rows `:60+` stay, re-importing
  nothing they no longer use); add one row per rule above, including every planning-pin pattern, `\*` literal,
  trailing `\`, unknown class, and a multi-byte UTF-8 range row.
- New `test/unit/domain/refs/ref-glob.properties.test.ts` — move the three properties from
  `test/unit/domain/name-rev/ref-pattern.properties.test.ts` (never throws; `*` matches all;
  metacharacter-free literal matches iff equal); add lens 2 invariants: escaping every character of a string
  (`\` before each) matches exactly that string; a single-member set `[c]` behaves as the literal `c` for
  non-special `c`; for token-grammar patterns `p`, `q` (no trailing `\`, no unterminated `[`), `p` matching
  `r` and `q` matching `s` imply `p + q` matches `r + s`. `numRuns` 100 (composition), 50 for filter-heavy.
- New `test/perf/domain/refs/ref-glob.perf.test.ts` — the `compile-glob.perf.test.ts` guard:
  `compileRefGlob(`${'a*'.repeat(64)}b`)` against `'a'.repeat(10_000)` returns `false` in under 1 000 ms.
- `test/unit/domain/name-rev/ref-pattern.test.ts` — one `buildRefFilter` row with a bracket include pattern.
- New `test/unit/domain/reflog/expire-policy.test.ts` — the matrix as parameterised rows over a fixed `now`
  with `parse` = a table-driven stub (and one row through the real `resolveExpiryCutoff` semantics for
  `never`/`now`): explicit per slot; first matching pattern wins (both orders); same pattern merged; unset
  pattern slot never; matching pattern hides globals; non-matching pattern → defaults; `refs/stash` never, and
  with a stash pattern; `HEAD` matched by `[gc "HEAD"]`; valid duplicates last-wins; the first invalid entry
  in file order throws — valueless → `CONFIG_MISSING_VALUE { key, source, line }`, unparseable →
  `CONFIG_BAD_DATE_VALUE { value, key, source, line }`, on a non-matching pattern too, before a valid later
  line.
- New `test/unit/domain/reflog/expire-policy.properties.test.ts` — lens 2 (an aggregator over entries):
  empty entries ⇒ `defaults` for any non-stash ref and never/never for `refs/stash`; appending a valid pattern
  entry that does not match `ref` never changes `cutoffsFor(ref)`; explicit slots equal the explicit values
  for any entries. `numRuns` 100; generators in `test/unit/domain/reflog/arbitraries.ts`.
- New `test/unit/application/primitives/config-read-reflog-expiry.test.ts` (kept out of the 8 527-line
  `config-read.test.ts` so the part gate stays small) — `readReflogExpiryConfig`: `[gc]` and
  `[gc "<pattern>"]` entries with slots, verbatim subsection (case and `*` kept), lowercased key, 1-based
  line, `value: null` for a valueless key, unrelated `[gc]` keys and other sections ignored.
- `test/unit/domain/commands/error.test.ts:1569-1572` — add the located message row; the existing
  `{ value }` row keeps its message. `test/unit/application/primitives/expiry-cutoff.test.ts:100`, `:173` —
  assert `'key' in data === false` for the `gc.pruneExpire` path.
- `test/unit/application/commands/reflog.test.ts` — default-clock rows re-derived under 30/90: `:942-964`
  (reachable 50 days now pruned) flips; `:893-917` keeps its count but its comment moves to the total clock;
  rows whose purpose is the reachability walk (`:1047-1070` and any that needed the 90-day total) pass explicit
  `expire: '90.days.ago', expireUnreachable: '30.days.ago'`; new rows: configuration refusal precedes
  `REVPARSE_UNRESOLVED`, target resolution and the class; `show`/`delete`/`exists` ignore a bogus
  `gc.reflogExpire`; per-target cutoffs use the resolved refname (`main` → `refs/heads/main` pattern).

**Tests (interop)** — new `test/integration/reflog-expire-config-interop.test.ts`. `@proves` surface
`reflog`; unique "gc.reflogExpire* configuration against git 2.55.0"; interopSurface `reflog`. `beforeAll`
(60 000 ms): capture `NOW = Math.floor(Date.now() / 1000)` once; build A, B, C, U, U2 with
`git commit-tree` (committer/author dates `@<NOW − n·86400> +0000` through `runGit(…, { env })`, so U and U2
are dangling without reflog noise); `git update-ref refs/heads/main C`, `git update-ref refs/stash C`,
`git symbolic-ref HEAD refs/heads/main`. A row copies the base into `peer` and `ours`, writes the same
`.git/config` text (base config + the row's snippet) and the same seven-entry log (`<old> <new> Ada
<ada@example.com> <NOW − days·86400> +0000\t<message>\n`) into both, runs `git reflog expire …` in `peer` and
`reflog(ctx, { action: 'expire', … })` in `ours`, then compares log bytes and the kept entries by message.
**Clock discipline:** every entry lies at least 5 days from every cutoff the matrix uses (60 d vs 45/50 d,
10 d vs 5/15 d, 100 d vs 90/120 d), so neither git's `time(NULL)` nor tsgit's `Date.now()` can move an entry
across a cutoff during a run; `@<epoch>` rows derive their epochs from `NOW`; no `vi.setSystemTime` (git runs
in its own process). Refusal rows compare git's exit code and both stderr lines with lines reconstructed from
the data (`path.relative(dir, data.source)` gives `.git/config`; line numbers computed from the written
config text, never hard-coded) and assert both logs untouched. Rows: D0–D10i, D12–D23 and D8h as tabled.
Unit-only, with reason: D11 (lowercase keys — covered by the unit token walk; add an interop row if cheap),
D11c (`-c`) and D11d (`~/.gitconfig`) — local-only configuration scope is a recorded residual and the interop
environment deliberately has no global configuration; the eager-gate ordering residual (a malformed streaming
`[core]` class reported first).

**Traps (all commits)**
- No references to this plan, the design, ADRs, matrix rows (D10, E13…) or the backlog in source or test
  code.
- **K is assertion-neutral:** `git diff --stat HEAD~1 -- test/` must print nothing for commit 1. If a test
  needs changing, the refactor changed behaviour.
- **Inert-change risk (E):** the old divergence row at `reflog-interop.test.ts:1927-1959` must be flipped;
  leaving it and adding an agreement row beside it makes the file contradict itself and one of them fail.
- Configuration is validated before flags (D15): never resolve `opts.expire` before
  `parseReflogExpiryEntries` has run.
- The token walk reads the cached parse; do not add a config read path.
- `CONFIG_BAD_DATE_VALUE`'s optional fields are asserted by presence (`'key' in data`), both present for the
  config path and absent for `gc.pruneExpire`.
- `name-rev`'s behaviour changes for `[…]` and `\` only; its existing rows stay green.
- `stash-ref.ts` never routes through `reflog expire`; `refs/stash` rows need the stash ref to resolve (E),
  hence `update-ref refs/stash C` in the base.
- git prints configuration keys lowercased and the refusal assertions quote them verbatim: add
  `reflogexpire`, `reflogexpireunreachable` and the class names `cntrl`, `punct`, `xdigit` to
  `cspell.json`'s `words` (kept sorted) in commit 3, per the parent plan's "New words" guidance.

### TDD steps

**Commit 1 (K)**
1. **Baseline** — run the gate's `reflog` unit file and `reflog-interop.test.ts`; record green.
2. **REFACTOR** — `ExpireOptions`, `ExpiryCuts`, `ExpiryPolicy`, `resolveExpiryPolicy` (sync), `expireTargets`,
   slimmed `runExpire`. Re-run; `git diff --stat -- test/` empty.

**Commit 2 (E)**
3. **RED** — `resolve-ref.test.ts`: `resolveTerminalName` for a two-hop chain. Fails: not exported.
4. **GREEN** — `ChainOutcome.found.name`, `resolveTerminalName`.
5. **RED** — `reflog.test.ts` E1 gone ref → `REFLOG_NOT_FOUND`. Fails: the log is rewritten.
6. **RED** — E4 `side` → expired; E6b target log; E7 `HEAD` without its log. Fail: `REFLOG_NOT_FOUND` /
   `INVALID_REF`.
7. **GREEN** — `dwimReflog`, `logForCandidate`, `resolveExpireTargets`; flip `:787-803`.
8. **RED** — no ref, no `all` → no-op. Fails: `HEAD` expired. **GREEN** — `opts.ref === undefined` arm; flip
   `:1019-1042`.
9. **RED** — E15 missing tip object → expired by clock. Fails: `OBJECT_NOT_FOUND`. **GREEN** — `peelGently`
   in `expireKindFor`.
10. **RED** — malformed class + unresolvable ref → `REFLOG_NOT_FOUND`. Fails: `CONFIG_BAD_NUMERIC_VALUE`.
    **GREEN** — dispatch before the class; class after targets when non-empty.
11. **RED/GREEN** — remaining arm and ordering rows; interop rows (flip the old divergence row first).

**Commit 3 (D)**
12. **RED** — `ref-glob.test.ts` bracket row. Fails: module missing. **GREEN** — the linear matcher;
    move the name-rev rows and properties; re-point `ref-pattern.ts`; perf guard.
13. **RED** — `expire-policy.test.ts` first rows (defaults, explicit, first pattern). Fails: module missing.
    **GREEN** — `parseReflogExpiryEntries`, `expiryPolicyFor`; then the remaining matrix and refusal rows and
    the property suite.
14. **RED** — `config-read-reflog-expiry.test.ts`. Fails: not exported. **GREEN** — `readReflogExpiryConfig`.
15. **RED** — `error.test.ts` located message row; `expiry-cutoff.test.ts` absence rows. **GREEN** — the
    union member, factory, formatter.
16. **RED** — `reflog.test.ts`: `gc.reflogExpire = never` keeps a 200-day entry. Fails: expired.
    **GREEN** — async `resolveExpiryPolicy`, 30/90 defaults; re-derive the default-clock rows.
17. **RED/GREEN** — ordering rows (config before flags/targets/class; other verbs ignore the keys); then the
    interop file row by row.

### Gate

Commit 1:
```
npx vitest run --maxWorkers=2 test/unit/application/commands/reflog.test.ts
npx vitest run test/integration/reflog-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/commands/reflog.ts
npx cspell --no-progress src/application/commands/reflog.ts
```

Commit 2:
```
npx vitest run --maxWorkers=2 test/unit/application/commands/reflog.test.ts test/unit/application/primitives/resolve-ref.test.ts test/unit/application/commands/rev-parse.test.ts test/unit/application/commands/internal/commit-ish.test.ts
npx vitest run test/integration/reflog-interop.test.ts
npx vitest run test/integration/repo-settings-config-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/commands/reflog.ts src/application/primitives/resolve-ref.ts test/unit/application/commands/reflog.test.ts test/unit/application/primitives/resolve-ref.test.ts test/integration/reflog-interop.test.ts
npx cspell --no-progress src/application/commands/reflog.ts src/application/primitives/resolve-ref.ts test/unit/application/commands/reflog.test.ts test/unit/application/primitives/resolve-ref.test.ts test/integration/reflog-interop.test.ts
```

Commit 3:
```
npx vitest run --maxWorkers=2 test/unit/domain/refs/ref-glob.test.ts test/unit/domain/refs/ref-glob.properties.test.ts test/unit/domain/name-rev/ref-pattern.test.ts test/unit/domain/reflog/expire-policy.test.ts test/unit/domain/reflog/expire-policy.properties.test.ts test/unit/application/primitives/config-read-reflog-expiry.test.ts test/unit/domain/commands/error.test.ts test/unit/application/primitives/expiry-cutoff.test.ts
npx vitest run --maxWorkers=2 test/unit/application/commands/reflog.test.ts test/unit/application/commands/name-rev.test.ts test/unit/application/commands/maintenance.test.ts
npx vitest run --config vitest.perf.config.ts test/perf/domain/refs/ref-glob.perf.test.ts
npx vitest run test/integration/reflog-expire-config-interop.test.ts
npx vitest run test/integration/reflog-interop.test.ts
npx vitest run test/integration/name-rev-interop.test.ts
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/refs/ref-glob.ts src/domain/name-rev/ref-pattern.ts src/domain/reflog/expire-policy.ts src/domain/commands/error.ts src/domain/error.ts src/application/primitives/config-read.ts src/application/commands/reflog.ts test/unit/domain/refs/ref-glob.test.ts test/unit/domain/refs/ref-glob.properties.test.ts test/unit/domain/name-rev/ref-pattern.test.ts test/unit/domain/name-rev/ref-pattern.properties.test.ts test/unit/domain/reflog/expire-policy.test.ts test/unit/domain/reflog/expire-policy.properties.test.ts test/unit/domain/reflog/arbitraries.ts test/unit/application/primitives/config-read-reflog-expiry.test.ts test/unit/domain/commands/error.test.ts test/unit/application/primitives/expiry-cutoff.test.ts test/unit/application/commands/reflog.test.ts test/perf/domain/refs/ref-glob.perf.test.ts test/integration/reflog-expire-config-interop.test.ts
npx cspell --no-progress src/domain/refs/ref-glob.ts src/domain/reflog/expire-policy.ts src/domain/commands/error.ts src/application/primitives/config-read.ts src/application/commands/reflog.ts test/unit/domain/refs/ref-glob.test.ts test/unit/domain/reflog/expire-policy.test.ts test/unit/application/primitives/config-read-reflog-expiry.test.ts test/integration/reflog-expire-config-interop.test.ts
```
(`test/unit/domain/name-rev/ref-pattern.properties.test.ts` is deleted by the move — `git rm` it and drop it
from the biome list if biome reports a missing path.)

**Owed at the phase boundary:** `reports/api.json` (`CONFIG_BAD_DATE_VALUE` optional fields);
`check:size` (domain chunk, browser bundle, `Command (reflog)`) and `check:tarball`; `check:architecture`
(new domain modules and the `name-rev` → `refs` edge); `check:test-pyramid` / `check:write-surfaces` (new
interop file). **Surface gates tripped:** `reports/api.json`.

### Commit

Commit 1: `refactor(reflog): split expire into a policy, its targets and per-target expiry`

Commit 2: `fix(reflog): resolve an expire target as git's repo_dwim_log does`

Commit 3: `feat(reflog): honour gc.reflogExpire, gc.reflogExpireUnreachable and gc.<pattern> keys`
