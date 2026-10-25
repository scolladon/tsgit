# Plan — forced-checkout-displace-occupant

> Source: design doc `docs/design/forced-checkout-displace-occupant.md` (final at fd4b2a9a) · ADRs 1075, 1076, 1077, 1078, 1079, 1080, 1081, 1082, 1083, 1084, 1085, 1086
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

## How to read this plan (every part)

- Line numbers are at fd4b2a9a. No file under src/ or test/ changed between main 4899565f (the design's
  reference) and fd4b2a9a, so the design's `file:line` references hold until a part of this plan moves them.
  A later part's numbers are the fd4b2a9a numbers: re-locate by symbol name (grep) after earlier parts landed.
- Implementers have no MCP tools: every symbol to touch is named with its file and line here. Use Read / Grep /
  Edit / Bash.
- TDD discipline: one RED per function. Write the RED test, RUN it, see it fail for the stated reason, then write
  that function's GREEN. Never batch REDs across functions, never write GREEN first. A test that passes on first
  run is a GUARD: record it as one and move on, never bend code to make it fail.
- Test conventions (CLAUDE.md): `describe('Given …')` > `describe('When …')` > `it('Then …')` (the 2-level
  `describe('Given …, When …')` shortcut only when one expectation lives under the When); AAA comments
  (`// Arrange`, `// Act`, `// Assert`); the system under test is `sut`; error assertions read the error's
  data (`code`, `localChanges`, `untracked`, paths), never `toThrow(Class)` alone; one isolated test per guard
  condition; 100% line/branch/function/statement coverage of every touched src file.
- No provenance in code or tests: never write a part number, ADR number, design id (RC4a, P3, S1…), or backlog id
  in a source file, a test title or a comment. Shape names in test data (`d`, `f`, `occupant`) are fine; a test
  title says what the shape is ("a regular file where the entry's leading directory is due"), not its row id.
- No suppression directives of any flavour. Existing `// Stryker disable` lines are pre-existing; do not add any.
- Interop rows: each row builds the same history in two peers (`makePeerPair` / `initBothRepos` / `runGit` /
  `runGitEnv` from test/integration/interop-helpers.ts), plants the occupant in both work trees, runs the git
  command in the git peer and the tsgit call in the other, and compares: the recursive work-tree listing (type,
  link target, content), `git ls-files -s`, `git ls-files -t`, and the outcome (git exit status + the refusal
  class and paths parsed from stderr; tsgit error `code` + `localChanges` / `untracked`). The expectation of a
  row is always "same as the git peer". The "git 2.55 (pinned)" column below is the outcome the git peer must
  produce: if the git peer does not produce it, the harness is wrong — fix the harness, never the pin, never
  the expectation. Ratified equivalences (design, Parity summary): git `lose-untracked` ≡ tsgit `untracked`;
  `CHECKOUT_OVERWRITE_DIRTY` / `WORKING_TREE_DIRTY` / `STASH_APPLY_WOULD_OVERWRITE` ≡ git's refusal of the same
  class and paths; git "beyond a symbolic link" ≡ `localChanges`; git `unstaged (precondition)` /
  `unresolved (continue precondition)` ≡ `WORKING_TREE_DIRTY` with the same tree, index and state (R7).
- RED vs GUARD for interop rows: a row whose "tsgit main" cell already equals its git cell under the
  equivalences above is a GUARD (it passes before your GREEN, and must keep passing); every other row is RED
  (it fails before your GREEN with the "tsgit main" cell as the reason).
- Write-path variants (`pool` default; `one` = `filter.probe.process` configured with no attribute using it;
  `in-core` = `core.autocrlf=true` in both peers): every A.1 row runs on all three; A.2–A.5 rows run on `pool`
  only (design, "How the matrix was pinned").
- Interop tests run with git 2.55: prefix every vitest run that includes a test/integration/*-interop.test.ts
  file with `PATH="<git-2.55-bin>:$PATH"`, where `<git-2.55-bin>` is the `bin` directory of the git 2.55.0
  install the run brief names. git 2.56 diverges from CI's 2.55 on some outputs.
- Part gate (manifest `gates.part`): `npx vitest run <touched-tests> && npm run check:types &&
  ./node_modules/.bin/biome check <touched-files> && npm run check:spelling`. wireit can serve a cached green
  (`Ran 0 scripts and skipped 1`): when it does, re-run the bypasses `npx tsc --noEmit -p tsconfig.json` and
  `npx cspell --no-progress <touched-files>`. Never commit on a red gate; never `--no-verify`.
- Commit only your own files: `git add <paths>` then `git commit -m "<message>"` (one double-quoted `-m`).
  Never touch the branch, index of other files, stash, or working tree of files you did not edit.
- Public surface (`.claude/workflow/surface-gates.md`): the only new PUBLIC symbols are three optional option
  members on the public `MaterializeTreeOpts` and `ApplyChangesetOpts` (re-exported by
  src/application/primitives/index.ts lines 7 and 64): `ignoredOccupants` (Part 5), `untrackedOccupants` and
  `unmergedPaths` (Part 7). They add no error code, no command, no barrel entry and no facade method, so the only
  surface gate they trip is `reports/api.json` (`check:doc-typedoc`, a prepush gate, not a validate gate), which
  Part 24 regenerates once. Every other new symbol in this plan is INTERNAL: exported from its module only for a
  sibling in src/, never added to src/application/primitives/index.ts, src/application/commands/index.ts or
  src/index*.ts. Do not raise size caps in any part (the orchestrator re-measures them after review).
- No docs/backlog edits in any part (the documentation phase owns them).
- Shared files across parts (plan-lint's locality warnings) are intentional: apply-changeset.ts, reset-worktree.ts,
  merge.ts, stash.ts, rebase.ts, rebase-state.ts and their suites are edited by successive parts that each land one
  git behaviour on top of the previous one, in the dependency order argued below; merging them would exceed the
  6-file / ~5-cycle part ceiling or reorder a protection after the displacement it guards. Each later part re-reads
  the file as the earlier parts left it.
- `LineOutcome` (rebase.ts:544) already includes `ReplayOutcome`; Part 11 adds `WorktreeRefusal` to it and Part 21
  adds it to `ReplayOutcome` too — a repeated union member is harmless; keep one declaration of `WorktreeRefusal`.

## Ordering argument

Turning on the displacement (design P1: Parts 13 and 14) is the step that converts today's crashes into
deletions, so every pre-flight and reset-mode protection that keeps git-protected data on disk lands first:
the shared occupant classifier and the unforced pre-flight (Parts 1–2), the merge-family pre-flight (Part 4,
RC5), `pull` into an unborn branch protecting ignored occupants (Part 5, RC7), sparse re-inclusion leaving
occupants (Part 6, RC6), and each reset caller's git mode (Parts 7–12, RC9: O2's `merge --abort`, the sequencer
aborts, the rebase abort/skip/`reset` step and the rebase start would otherwise displace untracked files git
keeps). Part 3 (the delete wave, RC3) only ever removes less than today, so it is safe anywhere and lands early.
After Parts 13–14 every caller that reaches the forced displacement is one git also displaces through, which is why
the path-restore index rule (Part 15), the stash snapshot (Part 16) and the merge snapshot/rewind (Parts 17–19) come
after: their pinned rows need the displacement to succeed, and P7 (Part 16) lands before P9 (Parts 17–19) because the
merge snapshot runs P7's path classes. The rebase policy-file part (Part 20, design P12) lands before the reschedule
parts (Parts 21–24, design P11), which sit on top of P8 (Parts 10–12): this deviates from the "P11 before P12"
example in the run brief because the A.5 R rows pin `rewritten-list` absence (V squash/fixup) and
`drop_redundant_commits` absence on an interactive reschedule (R1), which only P12's writer produces, and P11's
`refuseRescheduled` forwards P12's `redundantCommits` (DC-C).

Intermediate-state check: no commit between Part 1 and Part 24 deletes a file, symlink or directory content that
git 2.55 keeps for the same command and shape. Parts 1–12 only add refusals or keep occupants (each turns a crash
or an overwrite into git's refusal or git's kept occupant); the A.2 rows that need the displacement to SUCCEED are
deferred to Parts 13–14 (column "lands in"), and until then they keep main's crash (`NOT_A_DIRECTORY` /
`DIRECTORY_NOT_EMPTY`), never a deletion.

| part | title | design parts / root causes |
|---|---|---|
| 1 | Leading-file scanner verdict + shared occupant classifier, add rules | scanner data shape; P3 add rules; P4 module; RC4c, RC4d |
| 2 | Classifier update/delete rules | P3 update/delete; RC4a, RC4b |
| 3 | Forced delete wave keeps what git keeps | P2; RC3 |
| 4 | Merge-family pre-flight through the classifier | P4; RC5 |
| 5 | `pull` into an unborn branch protects ignored occupants | P5; RC7 (public option) |
| 6 | Sparse re-inclusion leaves occupants | P6; RC6 |
| 7 | `untrackedOccupants` and `unmergedPaths` options | P8 option shape (public options) |
| 8 | `merge --abort` resets as `reset --merge` | P8a (abort-merge); RC9a, RC9d |
| 9 | Sequencer `--abort` / `--skip` reset as `reset --merge` | P8a (sequencer); RC9a, RC9d, RC9e |
| 10 | Rebase abort and skip as an untracked-protecting hard reset | P8b (abort, skip, edit-stop and rescheduled-pick skip); RC9b, RC9d |
| 11 | The rebase-merges `reset` step protects untracked occupants and reschedules | P8b (reset step); RC9b |
| 12 | Rebase start checks out before HEAD moves | P8c; RC9c |
| 13 | Displace a leading regular file before the write wave | P1 (leading file); RC1 |
| 14 | Clear a directory at an updated path before the write wave | P1 (directory, gitlink); RC2 |
| 15 | Path restore drops colliding index entries | P10; RC11 |
| 16 | `stash push` builds git's work-tree tree | P7; RC8 |
| 17 | A true merge snapshots local changes before its strategies | P9 steps 1–2; RC10b |
| 18 | The strategy loop rewinds and restores as git does | P9 step 3 (rewind, restore, refusal = failure); RC10, RC10c |
| 19 | A staged change fails each strategy after the snapshot | P9 step 3 (dirty index); RC10d |
| 20 | The empty-commit policy file and `rewritten-list` as git writes them | P12; RC13 |
| 21 | A replay refusal is a typed outcome | P11 (unions, fast-forward) |
| 22 | A refused flat-rebase line is rescheduled | P11 (writer, detection, flat loop, flat retry); RC12 |
| 23 | A refused interactive line is rescheduled | P11 (interactive loop, retry dispatch); RC12 |
| 24 | A refused meld member is rescheduled; api.json | P11 (meld); RC12; api.json for Parts 5 and 7 |

Requirement map: R1 → 13, 14; R2 → 3; R3 → 1, 2; R4 → 4; R5 → 5; R6 → 6; R7 → every part (GUARD rows + RED
rows); R8 → 13; R9 → 8, 9; R10 → 10, 11; R11 → 12; R12 → 16; R13 → 17; R14 → 15; R15 → 18; R16 → 19; R17 → 22, 23,
24. ADR consequences: 1075 → 13, 14; 1076 → 1, 2, 4; 1077 → 5, 24; 1078 → 3, 6; 1079 → 8–12, 16, 17–19; 1080 → no
`checkout -f HEAD` row anywhere; 1081 → 7, 24; 1082 → 17–19; 1083–1085 → 11, 21–24; 1086 → nothing changes in
`produceOnto`'s empty-pick handling.

## Decision candidates

Load-bearing choices the design and ADRs do not pre-decide. The orchestrator settles them before
implementation; each part below is written against the recommendation.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-A | The fate of `hardResetWorktreeToCommit` (src/application/commands/internal/reset-worktree.ts:21). Design P8 says it "loses its last caller and is removed", but P9's rewind (Part 17) is exactly git's `reset --hard HEAD` (force + forceRewriteAll), which is what that helper does | (a) keep it, unchanged, as the rewind's helper: Parts 8–12 move every current caller to an intent-named helper, Part 18 becomes its caller (b) remove it in Part 12 and inline a forced `materializeTree` in merge.ts (c) rename it `hardResetWorktreeToHead` | (a) | Its name already states the intent (git's `reset --hard`), and P9's rewind is that mode; (b) duplicates the sparse-aware lock ceremony in merge.ts; (c) is a rename with no behaviour. Between Part 12 and Part 18 it is called only from its unit test; knip runs at validate, after Part 18. |
| DC-B | How `applyChangeset` recognises an unmerged path under `unmergedPaths: 'reset'` (ADR-1081 fixes the option, not the marker) | (a) `materializeTree` projects each unmerged path as an `update` (target has it) or `delete` (target lacks it) whose `previousId` and `previousMode` are `undefined`; under `'reset'` such an entry gets only the directory-survivor rule (b) a new optional `unmerged?: true` member on the public `ChangesetEntry` (c) a `ReadonlySet<FilePath>` of unmerged paths on `ApplyChangesetOpts` | (a) | An update/delete with no previous id already means "nothing to compare against" in `evaluateDirtyPath` (apply-changeset.ts:286-310, whose `previousId === undefined` early return exempts it), so the up-to-date exemption git applies to unmerged paths is the existing contract; (b) and (c) widen the public surface (api.json, size) for a fact the entry shape already carries. |
| DC-C | P11 / P12 order (run brief example: "P11 before P12 if they share writers") | (a) P12 first (Part 20), P11 after (Parts 21–24) (b) P11 first, P12 after | (a) | The A.5 R rows P11 pins compare `rebase-merge/` file lists byte for byte: R1's interactive reschedule has no `drop_redundant_commits` and V squash/fixup have no `rewritten-list`; only P12's writer leaves those. Under (b) those rows would be RED at P11's commit or pinned against tsgit's pre-P12 bytes. |
| DC-D | The ADR-1078 delete warning text. git prints `warning: unable to unlink 'f': <OS error text>`, and the errno text is OS-specific (probe, git 2.55.0 on macOS: `unable to unlink 'f': Operation not permitted`; Linux gives `Is a directory`) | (a) `unable to unlink '<path>'` (the design's text, no errno suffix) (b) a fixed `: Is a directory` suffix | (a) | The library cannot know the host's OS error text and the design pins `unable to unlink 'f'`; ADR-1078 rows assert the logger call only. |
| DC-E | `findWouldOverwrite`'s new removed-set input (ADR-1076 consequence) | (a) a 4th parameter `removed: ReadonlySet<FilePath>` defaulting to an empty set (b) a required 4th parameter | (a) | The property suite (test/unit/application/primitives/find-would-overwrite.properties.test.ts) calls it with three arguments and stays untouched; the two production callers pass the set explicitly. |
| DC-F | Whether `snapshotLocalChanges` (Part 17) holds the index lock while it reads | (a) under `acquireIndexLock`, released without a commit, exactly as `stashAndReset` (stash.ts:489) does (b) lock-free | (a) | It is the first half of `stashAndReset`; keeping the same lock discipline keeps one code path and refuses a concurrent writer the way `stash create` does. |
| DC-G | What a refused rebase-merges `reset <label>` step writes (design P8b pins only: the line heads `git-rebase-todo`, ends `done`, HEAD detached at the last pick; A.5) | (a) a typed refusal from `resetToLabel` (ADR-1085's rule) and a new `writeRescheduledLine` writing `git-rebase-todo`, `done`, `end`, `msgnum` with `writeRescheduledPick`'s formulas, nothing else (b) the same files plus `REBASE_HEAD` (c) catch `WORKING_TREE_DIRTY` around the reset step | (a) | git's sequencer reschedules a failed `reset` with `save_todo` (todo + done) after it already wrote `msgnum` / `end` for the attempt; a `reset` line names no commit, so no `REBASE_HEAD`; (c) is the runtime check ADR-1085 refused. The interop row compares only what is pinned (todo, done, HEAD, work tree, index). |
| DC-H | How a strategy's refused clean or conflict write reaches the merge strategy loop (design P9 step 3: "a strategy fails, and the loop moves on") | (a) a typed refusal: `attemptNonConflictTree` and the conflict pre-flight return `{ kind: 'refused', … }`, the fast-forward keeps a throwing wrapper (b) catch `WORKING_TREE_DIRTY` inside `tryStrategies` | (a) | "Types over runtime checks", the same reasoning ADR-1085 applied to the rebase loop; (b) would also swallow a dirty refusal raised by an unrelated step. |

Pinned outside the design (probe run in a `mktemp -d` throwaway, git 2.55.0, `GIT_CONFIG_NOSYSTEM=1`, `HOME`
isolated): git's sparse re-inclusion warning is ONE message per command, listing one line per kept entry that
has a leading-path obstruction, naming the OBSTRUCTING COMPONENT (an entry `d/x` under a file or symlink `d`
lists `d`; `d/x` and `d/y` list `d` twice), and nothing for an occupant standing AT the entry's own path (a
dangling symlink `f` where `f` is due prints no line; design A.1 S2/S3b/S3c `/sparse` rows carry no warning
either). Exact bytes of the probe's stderr:

```
warning: The following paths were already present and thus not updated despite sparse patterns:
	d
	d
	e

After fixing the above paths, you may want to run `git sparse-checkout reapply`.
```

DC-G pin (git 2.55.0, `mktemp -d` throwaway, scrubbed env). Todo `label onto / pick A / label x / reset onto / exec echo occ > a / reset x / pick B`, rebased with `-i --rebase-merges main`: the `reset x` step refuses with "The following untracked working tree files would be overwritten by reset: a" and exits 1. The occupant `a=occ` stays, the index holds only `keep`, and HEAD stays at `onto`. `REBASE_HEAD` is absent. `git-rebase-todo` is `reset x` then `pick B`. `done` ends with `reset x`. `end` is `7` and `msgnum` is `6`, which are `writeRescheduledPick`'s formulas. The `rebase-merge/` file set is unchanged from the previous step (`done end git-rebase-todo git-rebase-todo.backup head-name interactive msgnum no-reschedule-failed-exec onto orig-head refs-to-delete rewritten-list`), with no `author-script`, `message` or `stopped-sha`. DC-A through DC-H are settled as recommended.

## Part 1 — Leading-file scanner verdict and the shared occupant classifier (add rules)

### Context

Files this part edits or creates:
- `src/application/primitives/internal/symlinked-leading-path.ts` — add `obstructingLeadingComponent`.
- `src/application/primitives/internal/occupant-clash.ts` (NEW) — the shared classifier (ADR-1076).
- `src/application/primitives/apply-changeset.ts` — the unforced pre-flight's add branch calls the classifier.
- `test/unit/application/primitives/internal/symlinked-leading-path.test.ts` — scanner rows.
- `test/unit/application/primitives/internal/occupant-clash.test.ts` (NEW) — classifier rows (memory adapter).
- `test/integration/checkout-occupant-displacement-interop.test.ts` (NEW) — the A.1 checkout-family matrix harness.

Read-only references: test/unit/application/primitives/apply-changeset.test.ts (must stay green; its untracked-clash rows pin today's data).

Current code (fd4b2a9a):
- `createLeadingPathScanner` (symlinked-leading-path.ts:56) returns `LeadingPathScanner` (interface :17-45).
  `PrefixShape = 'symlink' | 'directory' | 'other' | 'missing'` (:47). `walkLeadingComponents(path)` (:141-154)
  walks prefixes through the memo `classifyPrefix` (:105) and returns the first `symlink` prefix, or `undefined`
  when it meets `missing` OR `other` (:149, "Nothing can sit beneath a missing prefix or a regular file").
  `symlinkedLeadingComponent(path)` (:156-172) caches the walk per leading directory in `verdicts`, stamped with
  `generation`. `hasSymlinkedLeadingPath` (:174) projects it.
- apply-changeset.ts: `IgnoredProbe` (:206), `ClashScope { removed: ReadonlySet<string> (absolute paths);
  isIgnoredPath; scanner }` (:211-215), `createIgnoredProbe(ctx)` (:219-224), `childSurvives` (:229-239),
  `holdsSurvivor` (:241-246), `isUntrackedClash` (:250-258, `pathIsOccupied` then `lstat`: any non-directory
  clashes — RC4d: ignore rules never consulted for a file/symlink AT the path), `untrackedClashOf` (:263-279,
  knows only a symlinked leading component), `DirtyClass` (:281-284), `evaluateDirtyPath` (:286-310; add branch
  :307-309), `deletedPaths` (:328), `checkDirty` (:333-365, builds the `ClashScope` with a fresh scanner and
  `createIgnoredProbe`), `removeIgnoredBelow` (:678, used by `clearOccupants` with `createIgnoredProbe`).
- `lstatIfReachable(fs, path)` (src/application/primitives/internal/fs-probes.ts:46) returns `undefined` for an
  absent path or one beneath a regular file, never throws for those.

New shape (design "Fix design", data shape; decided internal — exported for siblings only, never barrelled):

```ts
// symlinked-leading-path.ts
export interface LeadingObstruction { readonly path: FilePath; readonly kind: 'symlink' | 'file' }
// LeadingPathScanner gains:
readonly obstructingLeadingComponent: (path: FilePath) => Promise<LeadingObstruction | undefined>;
```

`walkLeadingComponents` returns the first `symlink` OR `other` prefix as a `LeadingObstruction` instead of
stopping silently at `other`; a `missing` prefix still ends the walk (`undefined`). The `verdicts` cache stores
the `LeadingObstruction | undefined`; `symlinkedLeadingComponent` becomes the projection
`(o) => o?.kind === 'symlink' ? o.path : undefined` and `hasSymlinkedLeadingPath` stays its projection — same
memo, same cache, so no caller pays an extra `lstat` (R8). The `generation` stamping is unchanged.

```ts
// occupant-clash.ts (internal)
export type IgnoredProbe = (absPath: string, isDirectory: boolean) => Promise<boolean>;
export interface ClashScope {
  readonly workdir: string;
  readonly removed: ReadonlySet<string>;   // absolute paths the changeset deletes
  readonly isIgnoredPath: IgnoredProbe;
  readonly scanner: LeadingPathScanner;
}
export interface OccupantClash { readonly class: 'local-changes' | 'untracked'; readonly path: FilePath }
export type OccupantVerdict =
  | { readonly kind: 'clash'; readonly clash: OccupantClash }
  | { readonly kind: 'clear' };
export interface OccupantShape { readonly kind: 'add'; readonly path: FilePath }  // Part 2 widens it
export const createIgnoredProbe: (ctx: Context) => IgnoredProbe;              // moved verbatim
export const holdsSurvivor: (ctx: Context, absDir: string, scope: ClashScope) => Promise<boolean>; // moved
export const classifyOccupant: (ctx: Context, shape: OccupantShape, scope: ClashScope) => Promise<OccupantVerdict>;
```

Add rules (design P3 "add:" block; git's `verify_absent` → `check_leading_path`), in this order:
1. `scanner.obstructingLeadingComponent(path)` is a file or symlink at component `c` → `untracked: c`, unless
   `scope.removed` holds `joinPath(workdir, c)` or `isIgnoredPath(abs c, false)` → `clear`.
2. `lstatIfReachable` at the path is a directory → `untracked: path` iff `holdsSurvivor` (unchanged rule).
3. a file or symlink at the path → `untracked: path` unless `isIgnoredPath(abs path, false)` (RC4d) → `clear`.
4. nothing at the path → `clear`.
`evaluateDirtyPath`'s add branch becomes `classifyOccupant(ctx, { kind: 'add', path: entry.path }, scope)` mapped to
`DirtyClass`; `ClashScope` / `createIgnoredProbe` / `holdsSurvivor` / `childSurvives` / `isUntrackedClash` /
`untrackedClashOf` move out of apply-changeset.ts (delete them there, import from occupant-clash.ts;
`clearOccupants` keeps using `createIgnoredProbe` via the import). Refusal arrays keep one element per entry,
sorted by `comparePaths` (already done in `checkDirty`): Y1 (`d` a file, d/x and d/y added) lists `d` twice.

Interop harness (new file). Model it on test/integration/checkout-leading-symlink-interop.test.ts (its
`commitTree` :61, `commitOn` :81, `listing` :132, `describe.skipIf(!GIT_AVAILABLE)` :138). History: `main` holds
`keep`; `t` is a child of `main`. Shapes, variants and commands are the design's (How the matrix was pinned):
/add = HEAD lacks the entry, `t` has it (v2); /update = HEAD has v1, `t` v2, the work tree replaced the entry
by the occupant; /same = HEAD v1, the command restores HEAD. Drive it with `describe.each` over
`{ shape, command, variant }`; the four commands of this file are `checkout t` (tsgit `repo.checkout` unforced),
`checkout -f t` (`force: true`), `reset --hard t`, and `checkout t -- <p>` (path restore of the due path).
`checkout -f HEAD` rows are OUT (ADR-1080): never add them. This part adds the `checkout t` /add rows below and
Y1. Y1 is pinned in prose only (design Parity summary RC4c): file `d`, `t` adds d/x and d/y → git exit 1
`untracked: [d, d]` (git lists `d` once per entry), occupant kept.

Pinned rows (this part):

| row | commands | git 2.55 (pinned) | tsgit main |
|---|---|---|---|
| A.1 S1/add | `checkout t` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S2/add | `checkout t` | 1 lose-untracked:f → f/ f/u=untracked | COD untracked=[f] → f/ f/u=untracked |
| A.1 S3a/add | `checkout t` | 1 untracked:d → d@->nowhere | COD untracked=[d] → d@->nowhere |
| A.1 S3b/add | `checkout t` | 1 untracked:f → f@->nowhere | COD untracked=[f] → f@->nowhere |
| A.1 S3c/add | `checkout t` | 1 lose-untracked:l → l/ l/u=untracked | COD untracked=[l] → l/ l/u=untracked |
| A.1 S3d/add | `checkout t` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S3e/add | `checkout t` | 1 untracked:d → d@->nowhere | COD untracked=[d] → d@->nowhere |
| A.1 S3f/add | `checkout t` | 1 untracked:f → f=occupant | COD untracked=[f] → f=occupant |
| A.1 I2/add | `checkout t` | ok → f=v2 | ok → f=v2 |
| A.1 I3/add | `checkout t` | ok → d/ d/x=v2 | ok → d/ d/x=v2 |
| A.1 I5/add | `checkout t` | ok → l@->t-v2 | ok → l@->t-v2 |
| A.1 I6/add | `checkout t` | ok → f=v2 | COD untracked=[f] → f=occupant |
| A.1 I7/add | `checkout t` | ok → f=v2 | COD untracked=[f] → f@->nowhere |
| A.1 X4/add | `checkout t` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |

### TDD steps

1. RED — symlinked-leading-path.test.ts, new `describe('Given a regular file where a leading directory is due')`
   > `When obstructingLeadingComponent scans a path beneath it` > `Then it names the file component with kind file`;
   plus rows: symlink first (`kind: 'symlink'`), a file beneath a real directory (`a` dir, `a/b` file, path
   `a/b/c` → `{ path: 'a/b', kind: 'file' }`), a missing component (`undefined`), a root-level path (`undefined`),
   and memo reuse (spy `ctx.fs.lstat`: two paths under the same file prefix → one `lstat` of that prefix).
   Fails: the scanner has no `obstructingLeadingComponent` member (TypeError: not a function).
2. GREEN — implement it in `walkLeadingComponents` + the `verdicts` cache; re-express `symlinkedLeadingComponent`
   and `hasSymlinkedLeadingPath` as projections.
3. GUARD — the existing symlinked-leading-path.test.ts rows (symlink verdicts, `invalidate`,
   `ensureLeadingDirectories`, generation staleness) all pass unchanged: the projections return what they did.
4. RED — occupant-clash.test.ts (memory adapter; build `ClashScope` from `createLeadingPathScanner`, a stub
   `isIgnoredPath` and a `removed` set): one `describe` per add rule, one `it` per guard — file obstruction →
   untracked component; file obstruction the changeset removes → clear; ignored file obstruction → clear;
   symlink obstruction → untracked component; directory with a survivor → untracked path; directory of ignored
   files only → clear; file at path → untracked path; ignored file at path → clear; ignored symlink at path →
   clear; nothing → clear. Fails: module src/application/primitives/internal/occupant-clash.ts does not exist.
5. GREEN — create occupant-clash.ts, moving `IgnoredProbe`, `ClashScope` (gaining `workdir`),
   `createIgnoredProbe`, `childSurvives`, `holdsSurvivor` from apply-changeset.ts; implement `classifyOccupant`.
6. RED — checkout-occupant-displacement-interop.test.ts with the harness and the rows above + Y1. RED rows:
   S1, S3d, X4 `/add` (main `NOT_A_DIRECTORY`), I6, I7 `/add` (main refuses `untracked=[f]`), Y1 (main
   `NOT_A_DIRECTORY`). GUARD rows: S2, S3a, S3b, S3c, S3e, S3f, I2, I3, I5 `/add` (main column already equals git).
7. GREEN — wire `evaluateDirtyPath`'s add branch (apply-changeset.ts:307-309) to `classifyOccupant`; delete the
   moved helpers and `untrackedClashOf` / `isUntrackedClash`; `checkDirty` builds `ClashScope` with `workdir`.
8. GUARD — `test/unit/application/primitives/apply-changeset.test.ts` whole file green (existing untracked-clash
   and symlink-leading rows keep their data).
9. REFACTOR — each function < 20 lines, early returns, no nesting > 2; delete now-unused imports
   (`pathIsOccupied` stays only if `isDirtyUnder` still uses it — it does).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/primitives/internal/symlinked-leading-path.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/checkout-occupant-displacement-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/symlinked-leading-path.ts src/application/primitives/internal/occupant-clash.ts src/application/primitives/apply-changeset.ts test/unit/application/primitives/internal/symlinked-leading-path.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/integration/checkout-occupant-displacement-interop.test.ts && npm run check:spelling`

### Commit

`fix(checkout): refuse an untracked file in a leading path and overwrite an ignored one, as git does`

## Part 2 — Classifier update/delete rules

### Context

Files this part edits:
- `src/application/primitives/internal/occupant-clash.ts` (created by Part 1) — widen `OccupantShape`.
- `src/application/primitives/apply-changeset.ts` — the update/delete branch of `evaluateDirtyPath`.
- `test/unit/application/primitives/internal/occupant-clash.test.ts` (Part 1) — update/delete rows.
- `test/integration/checkout-occupant-displacement-interop.test.ts` (Part 1) — the unforced /update and delete rows.

Current code: `evaluateDirtyPath` (apply-changeset.ts:286-310), update/delete branch :293-301: skips a lossy
entry, an entry with `previousId === undefined`, a gitlink `previousMode`, then `isDirtyUnder` (:169-178), whose
`pathIsOccupied` (src/application/primitives/internal/path-occupied.ts:12-15) folds `NOT_A_DIRECTORY` into
"absent" (RC4a: a path beneath a regular file reads as clean), and whose `readWorkingBytes` (:103-122) `read`s a
directory (EISDIR → `PERMISSION_DENIED`, RC4b). `isDirtyUnder`, `createWorkingTreeDirtyCheck` (:189) and
`isWorkingTreeDirty` (:202) keep their contract (sparse narrowing uses them; ADR-1076 consequence).

Widened shape and rules (design P3 "update / delete" block; git's `verify_uptodate`: `lstat` then
`ie_match_stat`, only `ENOENT` is absent):

```ts
export type OccupantShape =
  | { readonly kind: 'add'; readonly path: FilePath }
  | { readonly kind: 'update' | 'delete'; readonly path: FilePath };
export type OccupantVerdict =
  | { readonly kind: 'clash'; readonly clash: OccupantClash }
  | { readonly kind: 'clear' }
  | { readonly kind: 'compare-content' };   // a plain file/symlink at the path: the caller hashes it
```

For `update` / `delete` (the caller has already skipped lossy, `previousId === undefined` and gitlink entries):
1. leading obstruction `kind: 'file'` → `local-changes: path` (the entry's own path, not the component).
2. leading obstruction `kind: 'symlink'` → `clear` (git sees the entry deleted; unchanged behaviour).
3. a directory at the path: `update` → `local-changes: path`; `delete` → `untracked: path` iff `holdsSurvivor`,
   else `local-changes: path` (X1 empty dir, X2 ignored-only dir → local).
4. otherwise → `compare-content`; `evaluateDirtyPath` then runs `isDirtyUnder` unchanged.
Exhaustive `switch (shape.kind)` in `classifyOccupant`.

Pinned rows (this part; `checkout t` = unforced switch):

| row | commands | git 2.55 (pinned) | tsgit main |
|---|---|---|---|
| A.1 S1/update | `checkout t` | 1 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S2/update | `checkout t` | 1 local:f → f/ f/u=untracked | PERMISSION_DENIED → f/ f/u=untracked |
| A.1 S3a/update | `checkout t` | ok → d/ d/x=v2 | ok → d/ d/x=v2 |
| A.1 S3b/update | `checkout t` | 1 local:f → f@->nowhere | COD local=[f] → f@->nowhere |
| A.1 S3c/update | `checkout t` | 1 local:l → l/ l/u=untracked | PERMISSION_DENIED → l/ l/u=untracked |
| A.1 S3d/update | `checkout t` | 1 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S3e/update | `checkout t` | ok → d/ d/l@->t-v2 | ok → d/ d/l@->t-v2 |
| A.1 S3f/update | `checkout t` | 1 local:f → f=occupant | COD local=[f] → f=occupant |
| A.1 D1/delete | `checkout t` | 1 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 D2/delete | `checkout t` | 1 lose-untracked:f → f/ f/u=untracked | PERMISSION_DENIED → f/ f/u=untracked |
| A.1 D3/delete | `checkout t` | 1 lose-untracked:l → l/ l/u=untracked | PERMISSION_DENIED → l/ l/u=untracked |
| A.1 D4/delete | `checkout t` | 1 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 I1/update | `checkout t` | 1 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 I2/update | `checkout t` | 1 local:f → f/ f/u=untracked | PERMISSION_DENIED → f/ f/u=untracked |
| A.1 I3/update | `checkout t` | ok → d/ d/x=v2 | ok → d/ d/x=v2 |
| A.1 I4/update | `checkout t` | 1 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 I5/update | `checkout t` | 1 local:l → l/ l/u=untracked | PERMISSION_DENIED → l/ l/u=untracked |
| A.1 X1/delete | `checkout t` | 1 local:f → f/ | PERMISSION_DENIED → f/ |
| A.1 X2/delete | `checkout t` | 1 local:f → f/ f/u=untracked | PERMISSION_DENIED → f/ f/u=untracked |
| A.1 X3/update | `checkout t` | 1 local:f → f/ | PERMISSION_DENIED → f/ |

### TDD steps

1. RED — occupant-clash.test.ts, one `it` per rule above (file obstruction on update; on delete; symlink
   obstruction → clear; directory at an updated path → local; empty directory at a deleted path → local;
   directory of ignored files at a deleted path → local; directory holding an untracked file at a deleted path →
   untracked; plain file at the path → compare-content). Fails: `classifyOccupant` accepts only `kind: 'add'`
   (type error on the widened shape; at runtime the add rules answer `untracked`/`clear`, never `local-changes`
   or `compare-content`).
2. GREEN — widen `OccupantShape` / `OccupantVerdict`, implement the update/delete branch.
3. RED — interop rows above. RED rows: every row whose main cell is `NOT_A_DIRECTORY` or `PERMISSION_DENIED`
   (S1, S2, S3c, S3d, I1, I2, I4, I5 `/update`; D1–D4; X1, X2, X3). GUARD rows: S3a, S3b, S3e, S3f, I3 `/update`.
4. GREEN — `evaluateDirtyPath`'s update/delete branch calls `classifyOccupant` and runs `isDirtyUnder` only on
   `compare-content`.
5. GUARD — test/unit/application/primitives/apply-changeset.test.ts and
   test/unit/application/commands/internal/apply-sparse-checkout.test.ts green (sparse narrowing still goes through
   `isWorkingTreeDirty`).
6. REFACTOR — `evaluateDirtyPath` < 20 lines (split the update/delete arm into a helper if needed).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/integration/checkout-occupant-displacement-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/occupant-clash.ts src/application/primitives/apply-changeset.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/integration/checkout-occupant-displacement-interop.test.ts && npm run check:spelling`

### Commit

`fix(checkout): refuse an update or delete beneath a file or at a directory as a local change, as git does`

## Part 3 — Forced delete wave keeps what git keeps

### Context

Files this part edits:
- `src/application/primitives/apply-changeset.ts` — `applyDeleteEntry`.
- `test/unit/application/primitives/apply-changeset.test.ts` — delete-wave rows.
- `test/integration/checkout-occupant-displacement-interop.test.ts` (Part 1) — forced delete rows.

Current code: `applyDeleteEntry` (apply-changeset.ts:366-382): skips lossy; skips a path with a symlinked leading
component (`scanner.hasSymlinkedLeadingPath`); a gitlink `previousMode` → `removeEmptyDirectory` (unchanged);
otherwise `rmIfExists(ctx, abs)` (src/application/primitives/internal/write-working-tree-file.ts:46), whose
`lstat` throws `NOT_A_DIRECTORY` beneath a file (only `FILE_NOT_FOUND` folded, :51), whose `rm` refuses a
populated directory (`DIRECTORY_NOT_EMPTY`) and removes an empty one (git keeps it). It returns `entry.path` for
`pruneEmptiedDirectories` (:503).

New behaviour (design P2; R2; ADR-1078; DC-D): after the symlink and gitlink branches, probe with
`lstatIfReachable(ctx.fs, abs)`:
- `undefined` (absent or beneath a regular file) → remove nothing, return `undefined` (not pruned);
- a directory (non-gitlink path) → leave it, `ctx.logger?.warn?.(\`unable to unlink '${entry.path}'\`)`, return
  `undefined`;
- otherwise `await ctx.fs.rm(abs)`, return `entry.path`.
Drop the `rmIfExists` import from apply-changeset.ts if nothing else there uses it (grep). The index drops the
entry either way (materializeTree builds the index from the target; nothing to change there).

Pinned rows (this part; forced = `checkout -f t` / `reset --hard t`; `checkout t -- keep` restores a bystander):

| row | commands | git 2.55 (pinned) | tsgit main |
|---|---|---|---|
| A.1 D1/delete | `checkout -f t`, `reset --hard t` | ok → d=occupant other=o | NOT_A_DIRECTORY → d=occupant |
| A.1 D1/delete | `checkout t -- keep` | ok → d=occupant | ok → d=occupant |
| A.1 D2/delete | `checkout -f t`, `reset --hard t` | ok + warn `unable to unlink` → f/ f/u=untracked other=o | DIRECTORY_NOT_EMPTY → f/ f/u=untracked |
| A.1 D2/delete | `checkout t -- keep` | ok → f/ f/u=untracked | ok → f/ f/u=untracked |
| A.1 D3/delete | `checkout -f t`, `reset --hard t` | ok + warn `unable to unlink` → l/ l/u=untracked other=o | DIRECTORY_NOT_EMPTY → l/ l/u=untracked |
| A.1 D3/delete | `checkout t -- keep` | ok → l/ l/u=untracked | ok → l/ l/u=untracked |
| A.1 D4/delete | `checkout -f t`, `reset --hard t` | ok → d=occupant other=o | NOT_A_DIRECTORY → d=occupant |
| A.1 D4/delete | `checkout t -- keep` | ok → d=occupant | ok → d=occupant |
| A.1 X1/delete | `checkout -f t`, `reset --hard t` | ok + warn `unable to unlink` → f/ other=o | ok → other=o |
| A.1 X2/delete | `checkout -f t` | ok + warn `unable to unlink` → f/ f/u=untracked other=o | DIRECTORY_NOT_EMPTY → f/ f/u=untracked |

### TDD steps

1. RED — apply-changeset.test.ts, `describe('Given a forced delete of a path beneath a regular file')`: applies,
   leaves the file, reports `deleted: 1` and no write. Fails: `applyDeleteEntry` throws `NOT_A_DIRECTORY` from
   `rmIfExists`'s `lstat`.
2. RED — `describe('Given a forced delete of a path that is now a populated directory')`: applies, keeps the
   directory and its child, warns once through a spied `ctx.logger.warn` with `unable to unlink 'f'`. Fails:
   `rm` refuses `DIRECTORY_NOT_EMPTY`.
3. RED — `describe('Given a forced delete of a path that is now an empty directory')`: keeps the empty directory,
   warns. Fails: `rmIfExists` removes it.
4. RED — interop rows above: D1, D2, D3, D4, X1, X2 forced (main: `NOT_A_DIRECTORY`, `DIRECTORY_NOT_EMPTY`, or X1
   removing the empty directory). GUARD: the `checkout t -- keep` rows (main column equals git).
5. GREEN — rewrite the tail of `applyDeleteEntry` as above (< 20 lines; extract `removeDeletedFile` if needed).
   Steps 1–4 turn green together: they are one function's three guards plus their interop rows.
6. GUARD — existing delete rows (file removed, gitlink rmdir, symlinked leading path skipped, prune of emptied
   directories) green.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/primitives/apply-changeset.test.ts test/integration/checkout-occupant-displacement-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/checkout-occupant-displacement-interop.test.ts && npm run check:spelling`

### Commit

`fix(checkout): keep a directory or a leading file where a forced checkout deletes an entry, as git does`

## Part 4 — Merge-family pre-flight through the classifier

### Context

Files this part edits:
- `src/application/primitives/find-would-overwrite.ts` — `findWouldOverwrite`.
- `src/application/primitives/apply-merge-to-worktree.ts` — pass the merge's deletions.
- `src/application/commands/merge.ts` — `assertNothingOverwritten` passes the deletions.
- `test/unit/application/primitives/find-would-overwrite.test.ts` — classifier rows.
- `test/integration/cherry-pick-interop.test.ts`, `test/integration/stash-interop.test.ts` — RC5 rows.

Current code: `findWouldOverwrite(ctx, paths, currentIndex)` (find-would-overwrite.ts:113-138): for an index-absent
changed path, `isUntrackedPresent` (:84-93) `lstat`s the path (beneath a file: throws → caught → absent; beneath a
dangling symlink: the port follows nothing but the path resolves through the link → absent; a directory: present
whatever its content or ignore rules); for a tracked path, `compareAndRefresh` (:133) — a tracked changed path
beneath a regular file is not flagged, so the `force: true` apply (apply-merge-to-worktree.ts:538-545) throws
`NOT_A_DIRECTORY`. Callers: `applyMergeToWorktree` (apply-merge-to-worktree.ts:527, `merged.outcomes` in scope);
merge.ts `assertNothingOverwritten(ctx, changed)` (:1763-1775) called from `persistOctopusConflict` (:1344,
`outcomes` in scope) and `refuseUnwritableConflicts` (:1717, `result.outcomes` in scope). `isDeleted(outcome)`
(apply-merge-to-worktree.ts:210) narrows to `resolved-deleted`. `findTrackedBeyondSymlink` (:146) unchanged.

New behaviour (design P4; ADR-1076; DC-E):

```ts
export const findWouldOverwrite = async (
  ctx: Context, paths: ReadonlySet<FilePath>, currentIndex: GitIndex,
  removed: ReadonlySet<FilePath> = NOTHING_REMOVED,
): Promise<WouldOverwrite>
```
- index-absent path (escaped names still read as absent first, `hasEscapedBytes`): `classifyOccupant(ctx,
  { kind: 'add', path }, scope)` with a `ClashScope` of `{ workdir, removed: abs(removed), isIgnoredPath:
  createIgnoredProbe(ctx), scanner }` — a `clash` goes to its class/path (an obstruction names the COMPONENT);
  replaces `isUntrackedPresent` (delete it).
- tracked non-gitlink path whose `scanner.obstructingLeadingComponent` is a `file` → `localChanges: path` before
  `compareAndRefresh` runs.
- Output keeps one path per entry (a component named twice stays twice), sorted by `comparePaths`, mapped through
  `viewOfEscaped` as today.
- `apply-merge-to-worktree.ts:527` passes `new Set(merged.outcomes.filter(isDeleted).map((o) => o.path))`;
  `assertNothingOverwritten(ctx, changed, removed)` gains the same third input from its two callers.
- One scanner per call, shared by the classifier and `scopeOf` (already one per call, :121).

Pinned rows (this part; `cherry-pick t` in cherry-pick-interop.test.ts, `stash apply` / `stash pop` in
stash-interop.test.ts — the stash rows stash `t`'s change and apply it over the occupant). I1 /add
cherry-pick needs the displacement and lands in Part 12:

| row | commands | git 2.55 (pinned) | tsgit main |
|---|---|---|---|
| A.1 S1/add | `stash apply`, `stash pop` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S1/add | `cherry-pick t` | 128 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S1/update | `stash apply`, `stash pop` | 1 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S1/update | `cherry-pick t` | 128 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S3a/add | `cherry-pick t` | 128 untracked:d → d@->nowhere | ok → d/ d/x=v2 |
| A.1 S3a/add | `stash apply`, `stash pop` | 1 untracked:d → d@->nowhere | ok → d/ d/x=v2 |
| A.1 S3d/add | `stash apply`, `stash pop` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S3d/add | `cherry-pick t` | 128 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S3d/update | `stash apply`, `stash pop` | 1 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S3d/update | `cherry-pick t` | 128 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S3e/add | `cherry-pick t` | 128 untracked:d → d@->nowhere | ok → d/ d/l@->t-v2 |
| A.1 S3e/add | `stash apply`, `stash pop` | 1 untracked:d → d@->nowhere | ok → d/ d/l@->t-v2 |
| A.1 D1/delete | `stash apply`, `stash pop` | 1 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 D1/delete | `cherry-pick t` | 128 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 I2/add | `cherry-pick t` | ok → f=v2 | WTD untracked=[f] → f/ f/u=untracked |
| A.1 I2/add | `stash apply`, `stash pop` | ok → f=v2 | STASH_APPLY_WOULD_OVERWRITE → f/ f/u=untracked |
| A.1 I6/add | `cherry-pick t` | ok → f=v2 | WTD untracked=[f] → f=occupant |
| A.1 I6/add | `stash apply` | ok → f=v2 | STASH_APPLY_WOULD_OVERWRITE → f=occupant |
| A.1 I7/add | `cherry-pick t` | ok → f=v2 | WTD untracked=[f] → f@->nowhere |

### TDD steps

1. RED — find-would-overwrite.test.ts (memory adapter), one `it` each: an added path beneath an untracked file →
   `untracked: [component]`; beneath a dangling symlink → `untracked: [component]`; at a directory of ignored
   files → nothing; at an ignored file → nothing; beneath a file the merge deletes (`removed`) → nothing; a tracked
   changed path beneath a file → `localChanges: [path]`. Fails: `isUntrackedPresent` reports beneath-file and
   beneath-link paths absent and a directory present; the tracked row reports nothing.
2. GREEN — implement as above.
3. GUARD — find-would-overwrite.test.ts existing rows and find-would-overwrite.properties.test.ts green (three-arg
   calls, default `removed`).
4. RED — interop rows above (cherry-pick and stash files). RED: every row whose main cell is `NOT_A_DIRECTORY`,
   the S3a/S3e `/add` rows (main overwrites the untracked link: main column `ok`), and I2/I6/I7 `/add` (main
   refuses). GUARD: none expected; mark any whose main cell equals git as GUARD.
5. GREEN — pass the removed set from both callers.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/find-would-overwrite.properties.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/application/commands/merge.test.ts test/integration/cherry-pick-interop.test.ts test/integration/stash-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/find-would-overwrite.ts src/application/primitives/apply-merge-to-worktree.ts src/application/commands/merge.ts test/unit/application/primitives/find-would-overwrite.test.ts test/integration/cherry-pick-interop.test.ts test/integration/stash-interop.test.ts && npm run check:spelling`

### Commit

`fix(merge): refuse an untracked file or link in a leading path before a cherry-pick or stash apply writes`

## Part 5 — `pull` into an unborn branch protects ignored occupants

### Context

Files this part edits:
- `src/application/primitives/apply-changeset.ts` — `ApplyChangesetOpts.ignoredOccupants`, the `protected` policy.
- `src/application/primitives/materialize-tree.ts` — `MaterializeTreeOpts.ignoredOccupants`, forwarded.
- `src/application/commands/internal/pull-into-void.ts` — passes `protect`.
- `test/unit/application/primitives/apply-changeset.test.ts`, `test/unit/application/commands/pull.test.ts` — rows.
- `test/integration/pull-fetch-head-interop.test.ts` — into-unborn rows (it has the `git http-backend` transport,
  test/integration/http-backend-transport.ts).

PUBLIC: `ignoredOccupants?: 'overwrite' | 'protect'` on `ApplyChangesetOpts` (apply-changeset.ts:71-77) and
`MaterializeTreeOpts` (materialize-tree.ts:68-107), both re-exported (primitives/index.ts:7, :64). TSDoc each:
"`protect` refuses an ignored occupant like an untracked one (git's `overwrite_ignore = 0`); default
`overwrite`." Surface gate: api.json only (regenerated in Part 23).

Current code: `checkDirty` builds `isIgnoredPath: createIgnoredProbe(ctx)` (apply-changeset.ts:349 region);
`applyAllEntries` (:712) calls `clearOccupants(ctx, workdir, writes, force ? 'every' : 'ignored')` (:727);
`OccupantPolicy = 'every' | 'ignored'` (:691); `materializeTree` forwards `{ changeset, force, workdir,
checkoutMetadata }` to `applyChangesetWithAttributes` (materialize-tree.ts:396-404); `checkoutFromEmptyTree`
(pull-into-void.ts:38-55) calls `materializeTree({ targetTree, currentIndex, force: false, paths })`.

New behaviour (design P5; ADR-1077): under `protect`, `checkDirty`'s `ClashScope.isIgnoredPath` is
`async () => false` (so `holdsSurvivor` counts ignored children as survivors, and an ignored file obstruction or
at-path file is refused `untracked`), and `clearOccupants` runs a new `protected` member of `OccupantPolicy` that
removes nothing (`OccupantPolicy = 'every' | 'ignored' | 'protected'`; exhaustive switch). Policy pick:
`force ? 'every' : ignoredOccupants === 'protect' ? 'protected' : 'ignored'` (write it as a small named function,
no nested ternary). `pull-into-void.ts` passes `ignoredOccupants: 'protect'`.

Pinned rows (this part; `pull self t (into unborn)` — the peer pulls `t` from itself into an unborn branch):

| row | commands | git 2.55 (pinned) | tsgit main |
|---|---|---|---|
| A.1 S1/add | `pull self t (into unborn)` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S1/update | `pull self t (into unborn)` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S2/add | `pull self t (into unborn)` | 1 lose-untracked:f → f/ f/u=untracked | WTD untracked=[f] → f/ f/u=untracked |
| A.1 S2/update | `pull self t (into unborn)` | 1 lose-untracked:f → f/ f/u=untracked | WTD untracked=[f] → f/ f/u=untracked |
| A.1 S3a/add | `pull self t (into unborn)` | 1 untracked:d → d@->nowhere | WTD untracked=[d] → d@->nowhere |
| A.1 S3a/update | `pull self t (into unborn)` | 1 untracked:d → d@->nowhere | WTD untracked=[d] → d@->nowhere |
| A.1 S3b/add | `pull self t (into unborn)` | 1 untracked:f → f@->nowhere | WTD untracked=[f] → f@->nowhere |
| A.1 S3b/update | `pull self t (into unborn)` | 1 untracked:f → f@->nowhere | WTD untracked=[f] → f@->nowhere |
| A.1 S3c/add | `pull self t (into unborn)` | 1 lose-untracked:l → l/ l/u=untracked | WTD untracked=[l] → l/ l/u=untracked |
| A.1 S3c/update | `pull self t (into unborn)` | 1 lose-untracked:l → l/ l/u=untracked | WTD untracked=[l] → l/ l/u=untracked |
| A.1 S3d/add | `pull self t (into unborn)` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S3d/update | `pull self t (into unborn)` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S3e/add | `pull self t (into unborn)` | 1 untracked:d → d@->nowhere | WTD untracked=[d] → d@->nowhere |
| A.1 S3e/update | `pull self t (into unborn)` | 1 untracked:d → d@->nowhere | WTD untracked=[d] → d@->nowhere |
| A.1 S3f/add | `pull self t (into unborn)` | 1 untracked:f → f=occupant | WTD untracked=[f] → f=occupant |
| A.1 S3f/update | `pull self t (into unborn)` | 1 untracked:f → f=occupant | WTD untracked=[f] → f=occupant |
| A.1 D1/delete | `pull self t (into unborn)` | ok → d=occupant other=o | ok → d=occupant other=o |
| A.1 D2/delete | `pull self t (into unborn)` | ok → f/ f/u=untracked other=o | ok → f/ f/u=untracked other=o |
| A.1 D3/delete | `pull self t (into unborn)` | ok → l/ l/u=untracked other=o | ok → l/ l/u=untracked other=o |
| A.1 D4/delete | `pull self t (into unborn)` | ok → d=occupant other=o | ok → d=occupant other=o |
| A.1 I1/add | `pull self t (into unborn)` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 I1/update | `pull self t (into unborn)` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 I2/add | `pull self t (into unborn)` | 1 lose-untracked:f → f/ f/u=untracked | ok → f=v2 |
| A.1 I2/update | `pull self t (into unborn)` | 1 lose-untracked:f → f/ f/u=untracked | ok → f=v2 |
| A.1 I3/add | `pull self t (into unborn)` | 1 untracked:d → d@->nowhere | ok → d/ d/x=v2 |
| A.1 I3/update | `pull self t (into unborn)` | 1 untracked:d → d@->nowhere | ok → d/ d/x=v2 |
| A.1 I4/add | `pull self t (into unborn)` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 I4/update | `pull self t (into unborn)` | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 I5/add | `pull self t (into unborn)` | 1 lose-untracked:l → l/ l/u=untracked | ok → l@->t-v2 |
| A.1 I5/update | `pull self t (into unborn)` | 1 lose-untracked:l → l/ l/u=untracked | ok → l@->t-v2 |
| A.1 I6/add | `pull self t (into unborn)` | 1 untracked:f → f=occupant | WTD untracked=[f] → f=occupant |

### TDD steps

1. RED — apply-changeset.test.ts: `Given an ignored file where an added file is due, When an unforced apply runs
   with ignoredOccupants protect, Then it refuses untracked [f]`; same for a directory of ignored files
   (`untracked: [f]`) and an ignored leading file (`untracked: [d]`). Fails: the option is ignored; the apply
   overwrites (or, for the leading file, throws `NOT_A_DIRECTORY`).
2. GREEN — option + probe + `protected` policy in apply-changeset.ts.
3. RED — materialize-tree forwarding: test/unit/application/commands/pull.test.ts `Given a pull into an unborn branch
   over an ignored file at an incoming path, Then it refuses WORKING_TREE_DIRTY untracked [f] and writes nothing`.
   Fails: `materializeTree` does not forward the option and pull-into-void does not set it.
4. GREEN — forward in materialize-tree.ts; set `protect` in pull-into-void.ts.
5. RED — interop rows above. RED: rows whose main cell differs (I1–I5 into unborn: main overwrites or
   `NOT_A_DIRECTORY`; I6). GUARD: the rest.
6. GUARD — test/unit/application/primitives/materialize-tree.test.ts green (default unchanged).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/commands/pull.test.ts test/integration/pull-fetch-head-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts src/application/primitives/materialize-tree.ts src/application/commands/internal/pull-into-void.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/commands/pull.test.ts test/integration/pull-fetch-head-interop.test.ts && npm run check:spelling`

### Commit

`fix(pull): refuse an ignored occupant when pulling into an unborn branch, as git does`

## Part 6 — Sparse re-inclusion leaves occupants

### Context

Files this part edits:
- `src/application/commands/internal/apply-sparse-checkout.ts` — `includedChange`, `buildChangeset`, the warning.
- `test/unit/application/commands/internal/apply-sparse-checkout.test.ts` — rows.
- `test/integration/sparse-checkout-file-interop.test.ts` — /sparse rows.

Current code: `includedChange(ctx, workdir, entry)` (apply-sparse-checkout.ts:140-147) probes with
`ctx.fs.exists` (follows links; cannot see a leading file): present → `noopEntry` (:129), else `addEntry` (:119).
`buildChangeset` (:156-169) loops `part.included`. `assembleEntries` (:181-195) already clears skip-worktree for an
included entry not written (`clearSkipWorktree`). `applySparseCheckout` (:202-229) applies with `force: true`.

New behaviour (design P6; R6; ADR-1078 + the pinned warning in this plan's preamble): one
`createLeadingPathScanner(ctx)` per `buildChangeset`, passed to `includedChange`. An included non-lossy entry is
`noopEntry` when `lstatIfReachable(ctx.fs, abs)` finds anything (no follow: a dangling symlink counts) OR
`scanner.obstructingLeadingComponent(entry.path)` is defined; else `addEntry`. Collect the obstruction component of
every entry kept for a LEADING obstruction (not for an at-path occupant), in included-entry order sorted by
`comparePaths`, and when the list is non-empty emit ONE
`ctx.logger?.warn?.(…)` with git's text: `The following paths were already present and thus not updated despite
sparse patterns:\n` + each component as `\t<component>\n` + `\nAfter fixing the above paths, you may want to run
\`git sparse-checkout reapply\`.` (git's `warning: ` prefix is the logger's concern, not the message's). Name the
text as a module constant. Interop compares state only (ADR-1078).

Pinned rows (this part; each shape runs `sparse-checkout disable` and `sparse-checkout set /keep /<p>` — tsgit's
equivalents through the facade the existing file already uses):

| row | commands | git 2.55 (pinned) | tsgit main |
|---|---|---|---|
| A.1 S1/sparse | `sparse-checkout disable`, `sparse-checkout set /keep /d` | ok + warn `already present` → d=occupant | NOT_A_DIRECTORY → d=occupant |
| A.1 S2/sparse | `sparse-checkout disable`, `sparse-checkout set /keep /f` | ok → f/ f/u=untracked | ok → f/ f/u=untracked |
| A.1 S3a/sparse | `sparse-checkout disable`, `sparse-checkout set /keep /d` | ok + warn `already present` → d@->nowhere | ok → d/ d/x=v1 |
| A.1 S3b/sparse | `sparse-checkout disable`, `sparse-checkout set /keep /f` | ok → f@->nowhere | ok → f=v1 |
| A.1 S3c/sparse | `sparse-checkout disable`, `sparse-checkout set /keep /l` | ok → l/ l/u=untracked | ok → l/ l/u=untracked |
| A.1 S3d/sparse | `sparse-checkout disable`, `sparse-checkout set /keep /d` | ok + warn `already present` → d=occupant | NOT_A_DIRECTORY → d=occupant |

### TDD steps

1. RED — apply-sparse-checkout.test.ts (memory adapter): `Given a regular file where a re-included entry's leading
   directory is due` → nothing written, the file kept, skip-worktree cleared, one warn naming `d`; `Given a
   dangling symlink at a re-included path` → link kept, no warn; `Given two re-included entries under one file` →
   one warn listing `d` twice. Fails: `ctx.fs.exists` reads beneath-file and dangling-link paths as absent, so the
   entry is an `add` (the write throws `NOT_A_DIRECTORY` or replaces the link).
2. GREEN — implement as above.
3. RED — interop rows above. RED: S1, S3a, S3b, S3d. GUARD: S2, S3c.
4. GUARD — whole apply-sparse-checkout.test.ts green.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/integration/sparse-checkout-file-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/apply-sparse-checkout.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/integration/sparse-checkout-file-interop.test.ts && npm run check:spelling`

### Commit

`fix(sparse-checkout): leave an occupant in place when re-including a path, as git does`

## Part 7 — `untrackedOccupants` and `unmergedPaths` options

### Context

Files this part edits:
- `src/application/primitives/apply-changeset.ts` — the two options in the pre-flight.
- `src/application/primitives/materialize-tree.ts` — the two options, the unmerged projection.
- Read-only: src/application/primitives/internal/occupant-clash.ts (`classifyOccupant`, `holdsSurvivor`, both
  exported by Part 1).
- `test/unit/application/primitives/apply-changeset.test.ts`, `test/unit/application/primitives/materialize-tree.test.ts`.

PUBLIC (ADR-1081): `untrackedOccupants?: 'overwrite' | 'protect'` and `unmergedPaths?: 'hidden' | 'reset'` on
both `ApplyChangesetOpts` and `MaterializeTreeOpts`, optional, defaults `overwrite` / `hidden` (today's
behaviour). TSDoc each with its git counterpart: `protect` = the untracked-protecting hard reset (git's
`reset_head` with `UNPACK_RESET_PROTECT_UNTRACKED`); `reset` = an unmerged path is reset to the target without the
up-to-date check. Surface gate: api.json only (Part 23).

Current code: `applyChangesetInScope` (apply-changeset.ts:787-814) runs the pre-flight only `if (!force)` (:802).
`computeChangeset` (src/application/primitives/compute-changeset.ts:128) reads stage-0 entries only (:50-52), so an
unmerged path is invisible: it shows up as an `add` when the target has it and as nothing when it does not.
`materializeTree` (materialize-tree.ts:368-425) → `planMaterialize` (:222) → `computeChangeset(plan.indexForDiff,
plan.target)` (:388) → `upgradeNoopsToUpdates` under `forceRewriteAll` (:389-390); `mergeNewIndexEntries`
(:166-182) builds the new index from the target (unmerged stages already drop out when `paths` is undefined).

New behaviour (design P8a/P8b; DC-B):
- `unmergedPaths: 'reset'` in `materializeTree`: for every path with only stage > 0 entries in `currentIndex`, the
  changeset carries an `update` (target has the path: `id`/`mode` from the target) or a `delete` (target lacks it:
  `mode` = the lowest stage's mode) with `previousId: undefined` and `previousMode: undefined` (for the delete, set
  `previousMode` to that lowest stage's mode so a gitlink keeps the `removeEmptyDirectory` branch). Replace the
  `add` computeChangeset produced for that path. Write it as one helper (`projectUnmergedPaths(changeset,
  currentIndex, target)`), < 20 lines.
- `applyChangeset` pre-flight decision (one named function, exhaustive):
  - `!force` → the full unforced pre-flight (today's `assertNoDirtyOverwrite`) — PLUS, when
    `unmergedPaths === 'reset'`, an update/delete entry with `previousId === undefined` gets the directory-survivor
    rule only: a directory at its path holding a survivor (`holdsSurvivor`) → `untracked: [path]`; anything else
    (file, symlink, directory of ignored files, nothing) → clear. Without `'reset'` those entries keep today's early
    `return undefined`.
  - `force && untrackedOccupants === 'protect'` → an untracked-only pre-flight: `add` entries through
    `classifyOccupant({ kind: 'add' })` (a leading file or symlink → component; a file or symlink at the path →
    path; a directory holding an untracked file → path; ignored → clear); `delete` entries meeting a directory that
    holds a survivor → `untracked: [path]`; `update` entries skipped; unmerged entries (`previousId === undefined`)
    get the survivor rule. Every offending path is reported (no narrowing), sorted. Refuses
    `CHECKOUT_OVERWRITE_DIRTY` with `localChanges: []`.
  - `force` otherwise → no pre-flight (today).
- `materializeTree` forwards both options to the apply.

### TDD steps

1. RED — materialize-tree.test.ts: `Given a conflicted path the target has, When materialised with unmergedPaths
   reset, Then the work file takes the target content and the index holds one stage-0 entry`; and the
   target-lacks-it row (the file is deleted, no index entry). Fails: today the conflicted path is an `add`, refused
   as untracked when unforced (or, the delete row, left on disk).
2. GREEN — `projectUnmergedPaths` + forwarding.
3. RED — apply-changeset.test.ts, one `it` per guard: unmerged update at a directory holding an untracked file,
   unforced + reset → `untracked: [path]`; same at a directory of ignored files → applies; same at a modified file →
   applies (no up-to-date check). Fails: `previousId === undefined` returns before any probe (applies, deleting the
   untracked file through the writer).
4. GREEN — the unmerged rule in the pre-flight.
5. RED — apply-changeset.test.ts, protected forced pre-flight, one `it` per branch: add beneath an untracked file →
   `untracked: [d]`; add beneath a dangling symlink → `[d]`; add at an untracked file → `[f]`; add at a symlink →
   `[f]`; add at a directory with an untracked file → `[f]`; add at a directory of ignored files → applies; add at an
   ignored file → applies; delete at a directory holding an untracked file → `[f]`; update at a directory holding
   an untracked file → applies (the writer removes it); two offending paths → both, sorted. Fails: `force` skips
   every pre-flight.
6. GREEN — the protected pre-flight.

### Gate

`npx vitest run test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/materialize-tree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts src/application/primitives/materialize-tree.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/materialize-tree.test.ts && npm run check:spelling`

### Commit

`fix(checkout): add untracked-protecting and unmerged-reset modes to the tree apply, as git's resets use`

## Part 8 — `merge --abort` resets as `reset --merge`

### Context

Files this part edits:
- `src/application/commands/internal/reset-worktree.ts` — add `mergeResetWorktreeToCommit`.
- `src/application/commands/abort-merge.ts` — `mergeAbort` (:56) calls it.
- `test/unit/application/commands/internal/reset-worktree.test.ts` — helper rows.
- `test/unit/application/commands/abort-merge.test.ts` — wiring + nothing written on refusal.
- `test/integration/merge-abort-interop.test.ts` — the A.2 `merge --abort` rows, U3, U4, the autostash row.

Current code: `hardResetWorktreeToCommit(ctx, commitId)` (reset-worktree.ts:21-42): loads the sparse matcher,
reads the commit, takes `acquireIndexLock`, `materializeTree({ targetTree, currentIndex, force: true,
forceRewriteAll: true, sparse })`, commits the index `'replace'`, releases. It STAYS (DC-A). `mergeAbort`
(abort-merge.ts:39-65): reads `MERGE_HEAD` / `ORIG_HEAD`, refuses a detached HEAD, `takeMergeAutostash` (:55;
src/application/commands/internal/merge-autostash.ts:23, removes `MERGE_AUTOSTASH` and returns the oid), the reset
(:56), `updateRef(HEAD, origHead, 'reset: moving to HEAD')`, `removeBranchState`, then `applyAutostash`.
`asMergeDirtyError` (src/application/commands/merge.ts:1033) maps `CHECKOUT_OVERWRITE_DIRTY` to
`WORKING_TREE_DIRTY`; src/application/commands/internal/pull-into-void.ts:18 already imports it from '../merge.js'
(precedent for the import). `comparePaths` from src/domain/diff/index.ts; `workingTreeDirty` from
src/domain/commands/error.ts:592.

New helper (design P8a; R9; internal):

```ts
export const mergeResetWorktreeToCommit = async (ctx: Context, commitId: ObjectId): Promise<void>
```
Same lock/sparse/commit ceremony as `hardResetWorktreeToCommit` (extract the shared part into one private
helper taking the `materializeTree` mode; no duplicated block), with `materializeTree({ targetTree,
currentIndex, force: false, unmergedPaths: 'reset', sparse })` — no `forceRewriteAll`, so a path whose index
entry equals the target is `noop` and its occupant or local change stays. On `CHECKOUT_OVERWRITE_DIRTY` it throws
`workingTreeDirty` with ONLY the first path of `localChanges ∪ untracked` in `comparePaths` order, in its own
class (Y3: `f`, not `g`; U3: `a` both ways). The refusal comes before any write and before the index commit, so
HEAD, `ORIG_HEAD`, `MERGE_HEAD`, the stages and the work tree stay. `mergeAbort` keeps taking `MERGE_AUTOSTASH`
before the reset (a refused abort neither applies nor stores it, A.5).

Pinned rows (rows tagged Part 13 need the displacement and land there; do not add them here):

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| S1/same | `merge --abort` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 8 |
| S1/reset-updates | `merge --abort` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m | Part 8 |
| S1/reset-adds | `merge --abort` | 128 untracked:d (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m | Part 8 |
| S1/reset-deletes | `merge --abort` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 8 |
| S2/same | `merge --abort` | ok → f/ f/u=untracked keep=m | ok → f=v1 keep=m | Part 8 |
| S2/reset-updates | `merge --abort` | 128 local:f (first only) → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m | Part 8 |
| S2/reset-adds | `merge --abort` | 128 lose-untracked:f (first only) → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m | Part 8 |
| S2/reset-deletes | `merge --abort` | 128 lose-untracked:f (first only) → f/ f/u=untracked keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) | Part 8 |
| S3a/same | `merge --abort` | ok → d@->nowhere keep=m | ok → d/ d/x=v1 keep=m | Part 8 |
| S3a/reset-updates | `merge --abort` | ok → d/ d/x=v1 keep=m | ok → d/ d/x=v1 keep=m | Part 8 |
| S3a/reset-adds | `merge --abort` | 128 untracked:d (first only) → d@->nowhere keep=(markers) | ok → d/ d/x=v1 keep=m | Part 8 |
| S3a/reset-deletes | `merge --abort` | ok → d@->nowhere keep=m | ok → d@->nowhere keep=m | Part 8 |
| S3b/same | `merge --abort` | ok → f@->nowhere keep=m | ok → f=v1 keep=m | Part 8 |
| S3b/reset-updates | `merge --abort` | 128 local:f (first only) → f@->nowhere keep=(markers) | ok → f=v1 keep=m | Part 8 |
| S3b/reset-adds | `merge --abort` | 128 untracked:f (first only) → f@->nowhere keep=(markers) | ok → f=v1 keep=m | Part 8 |
| S3b/reset-deletes | `merge --abort` | 128 local:f (first only) → f@->nowhere keep=(markers) | ok → keep=m | Part 8 |
| S3c/same | `merge --abort` | ok → keep=m l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 8 |
| S3c/reset-updates | `merge --abort` | 128 local:l (first only) → keep=(markers) l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 8 |
| S3c/reset-adds | `merge --abort` | 128 lose-untracked:l (first only) → keep=(markers) l/ l/u=untracked | ok → keep=m l@->t-v1 | Part 8 |
| S3c/reset-deletes | `merge --abort` | 128 lose-untracked:l (first only) → keep=(markers) l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 8 |
| S3d/same | `merge --abort` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 8 |
| S3d/reset-updates | `merge --abort` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 8 |
| S3d/reset-adds | `merge --abort` | 128 untracked:d (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 8 |
| S3d/reset-deletes | `merge --abort` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 8 |
| S3e/same | `merge --abort` | ok → d@->nowhere keep=m | ok → d/ d/l@->t-v1 keep=m | Part 8 |
| S3e/reset-updates | `merge --abort` | ok → d/ d/l@->t-v1 keep=m | ok → d/ d/l@->t-v1 keep=m | Part 8 |
| S3e/reset-adds | `merge --abort` | 128 untracked:d (first only) → d@->nowhere keep=(markers) | ok → d/ d/l@->t-v1 keep=m | Part 8 |
| S3e/reset-deletes | `merge --abort` | ok → d@->nowhere keep=m | ok → d@->nowhere keep=m | Part 8 |
| S3f/same | `merge --abort` | ok → f=occupant keep=m | ok → f@->t-v1 keep=m | Part 8 |
| S3f/reset-updates | `merge --abort` | 128 local:f (first only) → f=occupant keep=(markers) | ok → f@->t-v1 keep=m | Part 8 |
| S3f/reset-adds | `merge --abort` | 128 untracked:f (first only) → f=occupant keep=(markers) | ok → f@->t-v1 keep=m | Part 8 |
| S3f/reset-deletes | `merge --abort` | 128 local:f (first only) → f=occupant keep=(markers) | ok → keep=m | Part 8 |
| I1/same | `merge --abort` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 8 |
| I1/reset-updates | `merge --abort` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m | Part 8 |
| I1/reset-deletes | `merge --abort` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 8 |
| I2/same | `merge --abort` | ok → f/ f/u=untracked keep=m | ok → f=v1 keep=m | Part 8 |
| I2/reset-updates | `merge --abort` | 128 local:f (first only) → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m | Part 8 |
| I2/reset-adds | `merge --abort` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 8 |
| I2/reset-deletes | `merge --abort` | 128 local:f (first only) → f/ f/u=untracked keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) | Part 8 |
| I4/same | `merge --abort` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 8 |
| I4/reset-updates | `merge --abort` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 8 |
| I4/reset-deletes | `merge --abort` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 8 |
| M1/same | `merge --abort` | ok → f=modified keep=m | ok → f=v1 keep=m | Part 8 |
| M1/reset-updates | `merge --abort` | 128 local:f (first only) → f=modified keep=(markers) | ok → f=v1 keep=m | Part 8 |
| Y3/same | `merge --abort` | ok → f/ f/u=untracked g=occupant keep=m | ok → f=v1 g=v1 keep=m | Part 8 |
| Y3/reset-updates | `merge --abort` | 128 local:f (first only) → f/ f/u=untracked g=occupant keep=(markers) | ok → f=v1 g=v1 keep=m | Part 8 |
| Y3/reset-adds | `merge --abort` | 128 lose-untracked:f (first only) → f/ f/u=untracked g=occupant keep=(markers) | ok → f=v1 g=v1 keep=m | Part 8 |
| Y3/reset-deletes | `merge --abort` | 128 lose-untracked:f (first only) → f/ f/u=untracked g=occupant keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) | Part 8 |

| scenario | git 2.55 (pinned) |
|---|---|
| `merge --autostash t` stops on a conflict, a directory replaces the updated `f`, `merge --abort` | exit 128 local:f; `MERGE_AUTOSTASH` gone, stash list empty, the stashed change to `dirty` not re-applied; `MERGE_HEAD` kept |

| row | stop, then occupant | command | git 2.55 (pinned) |
|---|---|---|---|
| U3 | `merge t` stopped (`t` deletes `a`, changes `z`); `a=occ` untracked, z/u over `z` | `merge --abort` | 128 untracked:a ("Untracked working tree file 'a' would be overwritten") |
| U3 | swapped (`t` deletes `z`, changes `a`); `z=occ`, a/u over `a` | `merge --abort` | 128 local:a (`Entry 'a' not uptodate`) |
| U4 | `merge t` stopped on conflicted `keep`; keep/u over `keep` | `merge --abort` | 128 lose-untracked:keep ("Updating 'keep' would lose untracked files in it"); `MERGE_HEAD`, stages kept |
| U4 | same; keep/ign, ignored | `merge --abort` | 0, `keep=m` |
| U4 | same; `keep` a file, or a symlink | `merge --abort` | 0, `keep=m` |

### TDD steps

1. RED — reset-worktree.test.ts `describe('mergeResetWorktreeToCommit')`: an untracked file at a path the index
   and target agree on stays; a local modification at such a path stays; an untracked file where the target adds
   a path refuses `WORKING_TREE_DIRTY` `untracked: [path]` and leaves the work tree and index; two offending paths
   of different classes → only the first in path order, in its class (one `it` with a local `a` before an
   untracked `z`, one with an untracked `a` before a local `z`); an unmerged path holding a directory with an
   untracked file → `untracked: [path]`; the same holding only ignored files → reset. Fails: the helper does not
   exist.
2. GREEN — implement it.
3. RED — abort-merge.test.ts: a refused abort leaves `MERGE_HEAD`, `ORIG_HEAD`, HEAD and the unmerged stages, and
   `MERGE_AUTOSTASH` is gone with nothing applied. Fails: `mergeAbort` hard-resets and succeeds.
4. GREEN — `mergeAbort` calls `mergeResetWorktreeToCommit`.
5. RED — interop rows above (RED where the main cell differs, GUARD where equal).
6. GUARD — the existing `hardResetWorktreeToCommit` rows of reset-worktree.test.ts stay green.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/internal/reset-worktree.test.ts test/unit/application/commands/abort-merge.test.ts test/integration/merge-abort-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/reset-worktree.ts src/application/commands/abort-merge.ts test/unit/application/commands/internal/reset-worktree.test.ts test/unit/application/commands/abort-merge.test.ts test/integration/merge-abort-interop.test.ts && npm run check:spelling`

### Commit

`fix(merge): reset as git's reset --merge on merge --abort, keeping occupants of untouched paths`

## Part 9 — Sequencer `--abort` / `--skip` reset as `reset --merge`

### Context

Files this part edits:
- `src/application/commands/internal/abort-sequencer-reset.ts` — `skipSequencerReset`, `abortSequencerReset`.
- `test/unit/application/commands/internal/abort-sequencer-reset.test.ts` (NEW).
- `test/integration/cherry-pick-interop.test.ts`, `test/integration/revert-interop.test.ts` — the `--abort` /
  `--skip` rows, U2, U4, the A.5 multi-pick rows.

Read-only: callers src/application/commands/cherry-pick.ts and revert.ts (`--skip` → `skipSequencerReset`;
`--abort` → `abortSequencerReset`) and src/application/commands/internal/replay-sequence.ts:462 (multi-pick abort).

Current code (abort-sequencer-reset.ts:29-46): `skipSequencerReset(ctx, head)` = `writeOrigHead(head)` THEN
`hardResetWorktreeToCommit(head)` THEN `removeBranchState`; `abortSequencerReset(ctx, { target })` =
`writeOrigHead(resolveRef(HEAD))` THEN `hardResetWorktreeToCommit(target)` THEN `updateRef(HEAD, target,
resetMovingTo(target))`, `removeBranchState`, `clearSequencer`.

New behaviour (design P8a "Ordering fix"; RC9e): both call `mergeResetWorktreeToCommit` (Part 8) FIRST and write
`ORIG_HEAD` after it succeeds (capture the HEAD oid before the reset, write it after). A refusal therefore leaves
HEAD, `ORIG_HEAD` (absent stays absent), sequencer/, `CHERRY_PICK_HEAD` / `REVERT_HEAD` unchanged.

Pinned rows (Part 13 rows land there):

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| S1/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 9 |
| S1/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m | Part 9 |
| S1/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:d (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m | Part 9 |
| S1/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 9 |
| S2/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f/ f/u=untracked keep=m | ok → f=v1 keep=m | Part 9 |
| S2/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m | Part 9 |
| S2/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:f (first only) → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m | Part 9 |
| S2/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:f (first only) → f/ f/u=untracked keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) | Part 9 |
| S3a/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d@->nowhere keep=m | ok → d/ d/x=v1 keep=m | Part 9 |
| S3a/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d/ d/x=v1 keep=m | ok → d/ d/x=v1 keep=m | Part 9 |
| S3a/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:d (first only) → d@->nowhere keep=(markers) | ok → d/ d/x=v1 keep=m | Part 9 |
| S3a/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d@->nowhere keep=m | ok → d@->nowhere keep=m | Part 9 |
| S3b/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f@->nowhere keep=m | ok → f=v1 keep=m | Part 9 |
| S3b/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f@->nowhere keep=(markers) | ok → f=v1 keep=m | Part 9 |
| S3b/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:f (first only) → f@->nowhere keep=(markers) | ok → f=v1 keep=m | Part 9 |
| S3b/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f@->nowhere keep=(markers) | ok → keep=m | Part 9 |
| S3c/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → keep=m l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 9 |
| S3c/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:l (first only) → keep=(markers) l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 9 |
| S3c/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:l (first only) → keep=(markers) l/ l/u=untracked | ok → keep=m l@->t-v1 | Part 9 |
| S3c/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:l (first only) → keep=(markers) l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 9 |
| S3d/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 9 |
| S3d/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 9 |
| S3d/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:d (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 9 |
| S3d/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 9 |
| S3e/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d@->nowhere keep=m | ok → d/ d/l@->t-v1 keep=m | Part 9 |
| S3e/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d/ d/l@->t-v1 keep=m | ok → d/ d/l@->t-v1 keep=m | Part 9 |
| S3e/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:d (first only) → d@->nowhere keep=(markers) | ok → d/ d/l@->t-v1 keep=m | Part 9 |
| S3e/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d@->nowhere keep=m | ok → d@->nowhere keep=m | Part 9 |
| S3f/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f=occupant keep=m | ok → f@->t-v1 keep=m | Part 9 |
| S3f/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f=occupant keep=(markers) | ok → f@->t-v1 keep=m | Part 9 |
| S3f/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:f (first only) → f=occupant keep=(markers) | ok → f@->t-v1 keep=m | Part 9 |
| S3f/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f=occupant keep=(markers) | ok → keep=m | Part 9 |
| I1/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 9 |
| I1/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m | Part 9 |
| I1/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 9 |
| I2/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f/ f/u=untracked keep=m | ok → f=v1 keep=m | Part 9 |
| I2/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m | Part 9 |
| I2/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 9 |
| I2/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f/ f/u=untracked keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) | Part 9 |
| I4/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 9 |
| I4/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 9 |
| I4/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 9 |
| M1/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f=modified keep=m | ok → f=v1 keep=m | Part 9 |
| M1/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f=modified keep=(markers) | ok → f=v1 keep=m | Part 9 |
| Y3/same | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f/ f/u=untracked g=occupant keep=m | ok → f=v1 g=v1 keep=m | Part 9 |
| Y3/reset-updates | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f/ f/u=untracked g=occupant keep=(markers) | ok → f=v1 g=v1 keep=m | Part 9 |
| Y3/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:f (first only) → f/ f/u=untracked g=occupant keep=(markers) | ok → f=v1 g=v1 keep=m | Part 9 |
| Y3/reset-deletes | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:f (first only) → f/ f/u=untracked g=occupant keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) | Part 9 |

| scenario | git 2.55 (pinned) |
|---|---|
| `cherry-pick A C`: `A` applied, `C` stopped; a directory replaces `f` (which `A` changed); `cherry-pick --abort` | exit 128 local:f; HEAD, `ORIG_HEAD`, sequencer/, `CHERRY_PICK_HEAD` unchanged |
| same stop, `cherry-pick --skip` | exit 0: the index entry of `f` equals HEAD, so it is untouched; `ORIG_HEAD` = HEAD; sequence finished |

| row | stop, then occupant | command | git 2.55 (pinned) |
|---|---|---|---|
| U2 | `cherry-pick A C` stopped on `C` (keep conflict, `f=v2` staged); f/u over `f` | `cherry-pick --skip` | 128 local:f (`Entry 'f' not uptodate`); HEAD, `ORIG_HEAD` (absent), sequencer/, `CHERRY_PICK_HEAD` unchanged |
| U2 | `revert A C` stopped on `C`; f/u over `f` | `revert --skip`, `revert --abort` | 128 local:f; HEAD, `ORIG_HEAD` (absent), sequencer/, `REVERT_HEAD` unchanged |
| U4 | `cherry-pick A C` / `revert A C` stopped; keep/u over `keep` | `--abort`, `--skip` (each) | 128 lose-untracked:keep; state kept |

### TDD steps

1. RED — abort-sequencer-reset.test.ts (memory adapter, a stopped pick with a directory over a changed `f`):
   `skipSequencerReset` refuses `WORKING_TREE_DIRTY` `localChanges: [f]` and writes no `ORIG_HEAD`; on success it
   writes `ORIG_HEAD` = the HEAD it left; `abortSequencerReset` refuses with HEAD, `ORIG_HEAD` and `sequencer/`
   unchanged, and on success writes `ORIG_HEAD` after the reset. Fails: `ORIG_HEAD` is written before the reset and
   the forced reset deletes the occupant instead of refusing.
2. GREEN — reorder and switch to `mergeResetWorktreeToCommit`.
3. RED — interop rows above (RED/GUARD by the main column; the A.5 rows were "not run" on main: RED).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/internal/abort-sequencer-reset.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts test/integration/cherry-pick-interop.test.ts test/integration/revert-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/abort-sequencer-reset.ts test/unit/application/commands/internal/abort-sequencer-reset.test.ts test/integration/cherry-pick-interop.test.ts test/integration/revert-interop.test.ts && npm run check:spelling`

### Commit

`fix(sequencer): reset as git's reset --merge on --abort and --skip, writing ORIG_HEAD only after it`

## Part 10 — Rebase abort and skip as an untracked-protecting hard reset

### Context

Files this part edits:
- `src/application/commands/internal/reset-worktree.ts` — add `protectedResetWorktreeToCommit`.
- `src/application/commands/rebase.ts` — callers :875 (`skipRescheduled`), :978 (`rebaseSkip`), :1000
  (`rebaseAbort`), :1842 (`rebaseSkipInteractive`).
- `test/unit/application/commands/internal/reset-worktree.test.ts`, `test/integration/rebase-interop.test.ts`.

New helper (design P8b; R10; internal):

```ts
export const protectedResetWorktreeToCommit = async (ctx: Context, commitId: ObjectId): Promise<void>
```
The shared ceremony of Part 8 with `materializeTree({ force: true, forceRewriteAll: true, untrackedOccupants:
'protect', unmergedPaths: 'reset', sparse })` (Part 7 options). A `CHECKOUT_OVERWRITE_DIRTY` refusal is rethrown
through `asMergeDirtyError` with EVERY path (no narrowing: Y3 /reset-adds lists `f` and `g`). The refusal is
before any write: abort and skip keep rebase-merge/, HEAD and the todo. `rebase.ts:875` (skip of a rescheduled
pick) and `:1842` (skip of an `edit` stop) reset to HEAD with it (A.5 U1a).

Current callers: each `await hardResetWorktreeToCommit(ctx, <oid>)` line becomes
`await protectedResetWorktreeToCommit(ctx, <oid>)`; nothing else in the caller changes (the refusal propagates
before any later write in each caller: check that `rebaseAbort` :992-1006, `rebaseSkip` :968-988,
`skipRescheduled` :873-877 and `rebaseSkipInteractive` :1840-1855 all reset before writing state).

Pinned rows (Part 14 rows need the displacement and land there; `rebase --skip (pick changes entry)` is the
skip of a rescheduled pick, A.5 U1):

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| S1/reset-adds | `rebase --abort (merge)` | 128 untracked:d → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m | Part 10 |
| S1/reset-adds | `rebase --skip (merge)` | ok → d=occupant keep=t | ok → d=occupant keep=t | Part 10 |
| S1/reset-adds | `rebase --skip (pick changes entry)` | 128 untracked:d → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=t | Part 10 |
| S1/reset-deletes | `rebase --abort (merge)` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 10 |
| S1/reset-deletes | `rebase --skip (pick changes entry)` | ok → d=occupant keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 10 |
| S2/same | `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 10 |
| S2/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t | Part 10 |
| S2/reset-updates | `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 10 |
| S2/reset-updates | `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t | Part 10 |
| S2/reset-updates | `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t | Part 10 |
| S2/reset-adds | `rebase --abort (merge)` | 128 lose-untracked:f → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m | Part 10 |
| S2/reset-adds | `rebase --skip (merge)` | ok → f/ f/u=untracked keep=t | ok → f/ f/u=untracked keep=t | Part 10 |
| S2/reset-adds | `rebase --skip (pick changes entry)` | 128 lose-untracked:f → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=t | Part 10 |
| S2/reset-deletes | `rebase --abort (merge)`, `rebase --skip (pick changes entry)` | 128 lose-untracked:f → f/ f/u=untracked keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) | Part 10 |
| S2/reset-deletes | `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t | Part 10 |
| S3a/same | `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | ok → d/ d/x=v1 keep=m | Part 10 |
| S3a/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | ok → d/ d/x=v1 keep=t | Part 10 |
| S3a/reset-updates | `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | ok → d/ d/x=v1 keep=m | Part 10 |
| S3a/reset-updates | `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | ok → d/ d/x=v2 keep=t | Part 10 |
| S3a/reset-updates | `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | ok → d/ d/x=v1 keep=t | Part 10 |
| S3a/reset-adds | `rebase --abort (merge)` | 128 untracked:d → d@->nowhere keep=(markers) | ok → d/ d/x=v1 keep=m | Part 10 |
| S3a/reset-adds | `rebase --skip (merge)` | ok → d@->nowhere keep=t | ok → d@->nowhere keep=t | Part 10 |
| S3a/reset-adds | `rebase --skip (pick changes entry)` | 128 untracked:d → d@->nowhere keep=(markers) | ok → d/ d/x=v1 keep=t | Part 10 |
| S3a/reset-deletes | `rebase --abort (merge)` | ok → d@->nowhere keep=m | ok → d@->nowhere keep=m | Part 10 |
| S3a/reset-deletes | `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | ok → d/ d/x=v2 keep=t | Part 10 |
| S3a/reset-deletes | `rebase --skip (pick changes entry)` | ok → d@->nowhere keep=t | ok → d@->nowhere keep=t | Part 10 |
| S3b/same | `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 10 |
| S3b/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t | Part 10 |
| S3b/reset-updates | `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 10 |
| S3b/reset-updates | `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t | Part 10 |
| S3b/reset-updates | `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t | Part 10 |
| S3b/reset-adds | `rebase --abort (merge)` | 128 untracked:f → f@->nowhere keep=(markers) | ok → f=v1 keep=m | Part 10 |
| S3b/reset-adds | `rebase --skip (merge)` | ok → f@->nowhere keep=t | ok → f@->nowhere keep=t | Part 10 |
| S3b/reset-adds | `rebase --skip (pick changes entry)` | 128 untracked:f → f@->nowhere keep=(markers) | ok → f=v1 keep=t | Part 10 |
| S3b/reset-deletes | `rebase --abort (merge)` | ok → keep=m | ok → keep=m | Part 10 |
| S3b/reset-deletes | `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t | Part 10 |
| S3b/reset-deletes | `rebase --skip (pick changes entry)` | ok → keep=t | ok → keep=t | Part 10 |
| S3c/reset-adds | `rebase --abort (merge)` | 128 lose-untracked:l → keep=(markers) l/ l/u=untracked | ok → keep=m l@->t-v1 | Part 10 |
| S3c/reset-adds | `rebase --skip (merge)` | ok → keep=t l/ l/u=untracked | ok → keep=t l/ l/u=untracked | Part 10 |
| S3c/reset-adds | `rebase --skip (pick changes entry)` | 128 lose-untracked:l → keep=(markers) l/ l/u=untracked | ok → keep=t l@->t-v1 | Part 10 |
| S3c/reset-deletes | `rebase --abort (merge)`, `rebase --skip (pick changes entry)` | 128 lose-untracked:l → keep=(markers) l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 10 |
| S3d/reset-adds | `rebase --abort (merge)`, `rebase --skip (pick changes entry)` | 128 untracked:d → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 10 |
| S3d/reset-adds | `rebase --skip (merge)` | ok → d=occupant keep=t | ok → d=occupant keep=t | Part 10 |
| S3d/reset-deletes | `rebase --abort (merge)` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 10 |
| S3d/reset-deletes | `rebase --skip (pick changes entry)` | ok → d=occupant keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 10 |
| S3e/same | `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | ok → d/ d/l@->t-v1 keep=m | Part 10 |
| S3e/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | ok → d/ d/l@->t-v1 keep=t | Part 10 |
| S3e/reset-updates | `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | ok → d/ d/l@->t-v1 keep=m | Part 10 |
| S3e/reset-updates | `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | ok → d/ d/l@->t-v2 keep=t | Part 10 |
| S3e/reset-updates | `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | ok → d/ d/l@->t-v1 keep=t | Part 10 |
| S3e/reset-adds | `rebase --abort (merge)` | 128 untracked:d → d@->nowhere keep=(markers) | ok → d/ d/l@->t-v1 keep=m | Part 10 |
| S3e/reset-adds | `rebase --skip (merge)` | ok → d@->nowhere keep=t | ok → d@->nowhere keep=t | Part 10 |
| S3e/reset-adds | `rebase --skip (pick changes entry)` | 128 untracked:d → d@->nowhere keep=(markers) | ok → d/ d/l@->t-v1 keep=t | Part 10 |
| S3e/reset-deletes | `rebase --abort (merge)` | ok → d@->nowhere keep=m | ok → d@->nowhere keep=m | Part 10 |
| S3e/reset-deletes | `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | ok → d/ d/l@->t-v2 keep=t | Part 10 |
| S3e/reset-deletes | `rebase --skip (pick changes entry)` | ok → d@->nowhere keep=t | ok → d@->nowhere keep=t | Part 10 |
| S3f/same | `rebase --abort (merge)` | ok → f@->t-v1 keep=m | ok → f@->t-v1 keep=m | Part 10 |
| S3f/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → f@->t-v1 keep=t | ok → f@->t-v1 keep=t | Part 10 |
| S3f/reset-updates | `rebase --abort (merge)` | ok → f@->t-v1 keep=m | ok → f@->t-v1 keep=m | Part 10 |
| S3f/reset-updates | `rebase --skip (merge)` | ok → f@->t-v2 keep=t | ok → f@->t-v2 keep=t | Part 10 |
| S3f/reset-updates | `rebase --skip (pick changes entry)` | ok → f@->t-v1 keep=t | ok → f@->t-v1 keep=t | Part 10 |
| S3f/reset-adds | `rebase --abort (merge)` | 128 untracked:f → f=occupant keep=(markers) | ok → f@->t-v1 keep=m | Part 10 |
| S3f/reset-adds | `rebase --skip (merge)` | ok → f=occupant keep=t | ok → f=occupant keep=t | Part 10 |
| S3f/reset-adds | `rebase --skip (pick changes entry)` | 128 untracked:f → f=occupant keep=(markers) | ok → f@->t-v1 keep=t | Part 10 |
| S3f/reset-deletes | `rebase --abort (merge)` | ok → keep=m | ok → keep=m | Part 10 |
| S3f/reset-deletes | `rebase --skip (merge)` | ok → f@->t-v2 keep=t | ok → f@->t-v2 keep=t | Part 10 |
| S3f/reset-deletes | `rebase --skip (pick changes entry)` | ok → keep=t | ok → keep=t | Part 10 |
| I1/reset-adds | `rebase --skip (merge)` | ok → d=occupant keep=t | ok → d=occupant keep=t | Part 10 |
| I1/reset-deletes | `rebase --abort (merge)` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 10 |
| I1/reset-deletes | `rebase --skip (pick changes entry)` | ok → d=occupant keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 10 |
| I2/same | `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 10 |
| I2/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t | Part 10 |
| I2/reset-updates | `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 10 |
| I2/reset-updates | `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t | Part 10 |
| I2/reset-updates | `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t | Part 10 |
| I2/reset-adds | `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 10 |
| I2/reset-adds | `rebase --skip (merge)` | ok → f/ f/u=untracked keep=t | ok → f/ f/u=untracked keep=t | Part 10 |
| I2/reset-adds | `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t | Part 10 |
| I2/reset-deletes | `rebase --abort (merge)` | ok + warn `unable to unlink` → f/ f/u=untracked keep=m | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) | Part 10 |
| I2/reset-deletes | `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t | Part 10 |
| I2/reset-deletes | `rebase --skip (pick changes entry)` | ok + warn `unable to unlink` → f/ f/u=untracked keep=t | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) | Part 10 |
| I4/reset-adds | `rebase --skip (merge)` | ok → d=occupant keep=t | ok → d=occupant keep=t | Part 10 |
| I4/reset-deletes | `rebase --abort (merge)` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 10 |
| I4/reset-deletes | `rebase --skip (pick changes entry)` | ok → d=occupant keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 10 |
| M1/same | `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 10 |
| M1/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t | Part 10 |
| M1/reset-updates | `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m | Part 10 |
| M1/reset-updates | `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t | Part 10 |
| M1/reset-updates | `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t | Part 10 |
| Y3/same | `rebase --abort (merge)` | ok → f=v1 g=v1 keep=m | ok → f=v1 g=v1 keep=m | Part 10 |
| Y3/same | `rebase --skip (merge)` | ok → f=v1 g=v1 keep=t | ok → f=v1 g=v1 keep=t | Part 10 |
| Y3/reset-updates | `rebase --abort (merge)` | ok → f=v1 g=v1 keep=m | ok → f=v1 g=v1 keep=m | Part 10 |
| Y3/reset-updates | `rebase --skip (merge)` | ok → f=v2 g=v2 keep=t | ok → f=v2 g=v2 keep=t | Part 10 |
| Y3/reset-adds | `rebase --abort (merge)` | 128 lose-untracked:f + untracked:g → f/ f/u=untracked g=occupant keep=(markers) | ok → f=v1 g=v1 keep=m | Part 10 |
| Y3/reset-adds | `rebase --skip (merge)` | ok → f/ f/u=untracked g=occupant keep=t | ok → f/ f/u=untracked g=occupant keep=t | Part 10 |
| Y3/reset-deletes | `rebase --abort (merge)` | 128 lose-untracked:f → f/ f/u=untracked g=occupant keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) | Part 10 |
| Y3/reset-deletes | `rebase --skip (merge)` | ok → f=v2 g=v2 keep=t | ok → f=v2 g=v2 keep=t | Part 10 |

| row | stop, then occupant | command | git 2.55 (pinned) |
|---|---|---|---|
| U1a | `rebase -i u` stopped on `edit X`; `git rm f`, then f/u | `rebase --skip` | 128 lose-untracked:f ("could not discard worktree changes"); HEAD, todo (`pick Y`), `done` (`edit X`) kept |
| U1a | same stop; `git rm --cached f`, `f=occ` untracked | `rebase --skip` | 128 untracked:f ("would be overwritten by reset"); state kept |
| U1a | same stop; f/u over tracked `f` (index keeps `f`) | `rebase --skip` | 0, `f=v1` (directory removed), rebase finished |
| U4 | `rebase u` stopped on conflicted `keep`; keep/u | `rebase --abort`, `rebase --skip` | 128 lose-untracked:keep; HEAD and rebase-merge/ kept |
| U4 | same stop; `keep=occ` file | `rebase --abort` | 0, `keep=m` |

### TDD steps

1. RED — reset-worktree.test.ts `describe('protectedResetWorktreeToCommit')`, one `it` per branch: add beneath an
   untracked file → refuses `untracked: [d]`; add beneath a symlink → `[d]`; add at a file → `[f]`; add at a
   symlink → `[f]`; add at a directory with an untracked file → `[f]`; add at a directory with only ignored files
   → reset; add at an ignored file → reset; delete at a directory with an untracked file → `[f]`; a locally
   modified tracked file → rewritten; an unmerged path holding a directory with an untracked file → `[path]`, a
   file there → rewritten; two offending paths → both listed. Fails: the helper does not exist.
2. GREEN — implement it.
3. RED — interop rows above (U1a rows: each tool runs its own `rebase -i`, reuse the "Given an edit stop" describe
   at test/integration/rebase-interop.test.ts:711).
4. GREEN — switch the four callers.
5. GUARD — test/unit/application/commands/rebase.test.ts whole file green (the callers' success paths unchanged).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/internal/reset-worktree.test.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/reset-worktree.ts src/application/commands/rebase.ts test/unit/application/commands/internal/reset-worktree.test.ts test/integration/rebase-interop.test.ts && npm run check:spelling`

### Commit

`fix(rebase): refuse an untracked occupant on rebase --abort and --skip, as git's protecting reset does`

## Part 11 — The rebase-merges `reset` step protects untracked occupants and reschedules

### Context

Files this part edits:
- `src/application/commands/internal/reset-worktree.ts` — `WorktreeRefusal`, `attemptProtectedResetWorktreeToCommit`.
- `src/application/commands/internal/rebase-merges-steps.ts` — `moveHead` (:69-77), `resetToLabel` (:80-88).
- `src/application/commands/rebase.ts` — `LineOutcome` (:544), `replayLine` reset arm (:559-561), `replayFrom` (:623-650).
- `src/application/commands/internal/rebase-state.ts` — `writeRescheduledLine`.
- `test/unit/application/commands/internal/rebase-merges-steps.test.ts`, `test/integration/rebase-merges-interop.test.ts`.

Current code: `moveHead(ctx, target, message)` (rebase-merges-steps.ts:69-77) = `hardResetWorktreeToCommit(target)`
then the HEAD update; used by `resetToLabel` (git's `do_reset`) and `fastForwardHead` (:91-95, used by
`recreateMerge` :183 and the flat `replayOne` fast-forward arm, rebase.ts:383). A refusal today would throw out of
`replayFrom` with no state written.

New behaviour (design P8b "A refused `reset` step leaves the rebase stopped, with `reset <label>` at the head of
`git-rebase-todo` and at the end of `done`"; ADR-1085's typed-outcome rule applied to the reset step; DC-G):

```ts
// reset-worktree.ts (internal; Part 21 reuses WorktreeRefusal)
export interface WorktreeRefusal extends WouldOverwriteClasses { readonly kind: 'refused' }
export type ResetOutcome = { readonly kind: 'reset' } | WorktreeRefusal;
export const attemptProtectedResetWorktreeToCommit: (ctx: Context, commitId: ObjectId) => Promise<ResetOutcome>;
// protectedResetWorktreeToCommit (Part 10) becomes its throwing wrapper.
```
- `moveHead` takes the protected reset for BOTH users (git's `do_reset` and `fast_forward_to` never overwrite an
  untracked file). `resetToLabel` returns `{ kind: 'moved'; head } | WorktreeRefusal` (HEAD untouched on
  refusal); `fastForwardHead` keeps throwing (`merge -C` keeps its throw, design P11 "Not touched").
- `LineOutcome` gains `WorktreeRefusal`; `replayFrom`, on `refused` from a `reset` line at index `i`, calls
  `writeRescheduledLine(ctx, { headName, onto, origHead, done: [...rc.doneBefore, ...rc.todo.slice(0, i + 1)],
  remaining: rc.todo.slice(i), backupHeader: rc.backupHeader })` then throws
  `workingTreeDirty({ localChanges, untracked })` (asMergeDirtyError's data).
- `writeRescheduledLine` (rebase-state.ts, next to `writeRescheduledPick` :191) writes `git-rebase-todo`,
  `done`, `end` (= done.length − 1 + remaining.length) and `msgnum` (= done.length), the backup only when
  `backupHeader` is set, and nothing else (no `REBASE_HEAD`, no `author-script`). Only `done`, `git-rebase-todo`
  and HEAD are pinned by git (A.5): the interop row compares those, the work tree and the index — never the file
  list.

Pinned rows (the reset step runs on `rebase --continue` after the planted `keep` conflict is resolved, each tool
running its own `rebase --rebase-merges u`; Part 14 rows land there):

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| S1/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a | Part 11 |
| S1/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a | Part 11 |
| S1/reset-adds | `rebase-merges reset step` | 1 untracked:d → d=occupant keep=a | NOT_A_DIRECTORY → d=occupant keep=u | Part 11 |
| S1/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a | Part 11 |
| S2/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a | Part 11 |
| S2/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a | Part 11 |
| S2/reset-adds | `rebase-merges reset step` | 1 lose-untracked:f → f/ f/u=untracked keep=a | ok → keep=a other=o | Part 11 |
| S2/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a | Part 11 |
| S3a/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/x] → d@->nowhere keep=a | Part 11 |
| S3a/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/x] → d@->nowhere keep=a | Part 11 |
| S3a/reset-adds | `rebase-merges reset step` | 1 untracked:d → d@->nowhere keep=a | ok → keep=a other=o | Part 11 |
| S3a/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/x] → d@->nowhere keep=a | Part 11 |
| S3b/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → f@->nowhere keep=a | WTD local=[f] → f@->nowhere keep=a | Part 11 |
| S3b/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → f@->nowhere keep=a | WTD local=[f] → f@->nowhere keep=a | Part 11 |
| S3b/reset-adds | `rebase-merges reset step` | 1 untracked:f → f@->nowhere keep=a | ok → keep=a other=o | Part 11 |
| S3b/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → f@->nowhere keep=a | WTD local=[f] → f@->nowhere keep=a | Part 11 |
| S3c/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → keep=a l/ l/u=untracked | WTD local=[l] → keep=a l/ l/u=untracked | Part 11 |
| S3c/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → keep=a l/ l/u=untracked | WTD local=[l] → keep=a l/ l/u=untracked | Part 11 |
| S3c/reset-adds | `rebase-merges reset step` | 1 lose-untracked:l → keep=a l/ l/u=untracked | ok → keep=a other=o | Part 11 |
| S3c/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → keep=a l/ l/u=untracked | WTD local=[l] → keep=a l/ l/u=untracked | Part 11 |
| S3d/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a | Part 11 |
| S3d/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a | Part 11 |
| S3d/reset-adds | `rebase-merges reset step` | 1 untracked:d → d=occupant keep=a | NOT_A_DIRECTORY → d=occupant keep=a | Part 11 |
| S3d/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a | Part 11 |
| S3e/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/l] → d@->nowhere keep=a | Part 11 |
| S3e/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/l] → d@->nowhere keep=a | Part 11 |
| S3e/reset-adds | `rebase-merges reset step` | 1 untracked:d → d@->nowhere keep=a | ok → keep=a other=o | Part 11 |
| S3e/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/l] → d@->nowhere keep=a | Part 11 |
| S3f/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → f=occupant keep=a | WTD local=[f] → f=occupant keep=a | Part 11 |
| S3f/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → f=occupant keep=a | WTD local=[f] → f=occupant keep=a | Part 11 |
| S3f/reset-adds | `rebase-merges reset step` | 1 untracked:f → f=occupant keep=a | ok → keep=a other=o | Part 11 |
| S3f/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → f=occupant keep=a | WTD local=[f] → f=occupant keep=a | Part 11 |
| I1/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a | Part 11 |
| I1/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a | Part 11 |
| I1/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a | Part 11 |
| I2/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a | Part 11 |
| I2/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a | Part 11 |
| I2/reset-adds | `rebase-merges reset step` | ok → keep=a other=o | ok → keep=a other=o | Part 11 |
| I2/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a | Part 11 |
| I4/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a | Part 11 |
| I4/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a | Part 11 |
| I4/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a | Part 11 |
| M1/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → f=modified keep=a | WTD local=[f] → f=modified keep=a | Part 11 |
| M1/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → f=modified keep=a | WTD local=[f] → f=modified keep=a | Part 11 |
| Y3/same | `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked g=occupant keep=a | WTD local=[f,g] → f/ f/u=untracked g=occupant keep=a | Part 11 |
| Y3/reset-updates | `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked g=occupant keep=a | WTD local=[f,g] → f/ f/u=untracked g=occupant keep=a | Part 11 |
| Y3/reset-adds | `rebase-merges reset step` | 1 lose-untracked:f + untracked:g → f/ f/u=untracked g=occupant keep=a | ok → keep=a other=o | Part 11 |
| Y3/reset-deletes | `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked g=occupant keep=a | WTD local=[f,g] → f/ f/u=untracked g=occupant keep=a | Part 11 |

| scenario | git 2.55 (pinned) |
|---|---|
| rebase-merges `reset onto` refused (S2 /reset-adds) | exit 1 lose-untracked:f; `reset onto` heads `git-rebase-todo` and ends `done`; HEAD detached at the last pick |

### TDD steps

1. RED — rebase-merges-steps.test.ts: `resetToLabel` over an untracked file where the label's tree adds a path
   returns `refused` with `untracked: [path]`, HEAD and the index unchanged. Fails: `moveHead` force-resets and
   overwrites the file.
2. GREEN — `attemptProtectedResetWorktreeToCommit`, `moveHead`, `resetToLabel`.
3. RED — rebase-merges-interop.test.ts rows above (S-shape `/reset-adds` rows and the A.5 row RED: main overwrites
   or crashes; `unresolved (continue precondition)` rows GUARD).
4. GREEN — `LineOutcome`, the `refused` arm of `replayFrom`, `writeRescheduledLine`.
5. GUARD — test/unit/application/commands/internal/rebase-state.test.ts and rebase.test.ts green.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/internal/rebase-merges-steps.test.ts test/unit/application/commands/internal/rebase-state.test.ts test/unit/application/commands/rebase.test.ts test/unit/application/commands/internal/reset-worktree.test.ts test/integration/rebase-merges-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/reset-worktree.ts src/application/commands/internal/rebase-merges-steps.ts src/application/commands/rebase.ts src/application/commands/internal/rebase-state.ts test/unit/application/commands/internal/rebase-merges-steps.test.ts test/integration/rebase-merges-interop.test.ts && npm run check:spelling`

### Commit

`fix(rebase): refuse an untracked occupant on a rebase-merges reset step and keep it in the todo`

## Part 12 — Rebase start checks out before HEAD moves

### Context

Files this part edits:
- `src/application/commands/internal/reset-worktree.ts` — add `checkoutWorktreeToCommit`.
- `src/application/commands/rebase.ts` — `detachHead` (:327-349), `detachInteractive` (:1123-1138),
  `fastForwardOnto` (:1142-1153).
- `test/unit/application/commands/internal/reset-worktree.test.ts`, `test/unit/application/commands/rebase.test.ts`,
  `test/integration/rebase-interop.test.ts`.

Current code: each of the three moves HEAD first (`getRefStore(ctx).applyRefUpdates`) and then calls
`hardResetWorktreeToCommit` (forced). `startReplay` (:784-808) writes `ORIG_HEAD` (:796) before `detachHead`;
`rebaseRunInteractive` (:1675) writes `ORIG_HEAD` before `detachInteractive`. git: "could not detach HEAD", HEAD
and the branch unmoved, no rebase-merge/.

New helper (design P8c; R11; internal):

```ts
export const checkoutWorktreeToCommit = async (ctx: Context, target: ObjectId): Promise<void>
```
The shared ceremony with `materializeTree({ targetTree, currentIndex, force: false, headTree: <current HEAD's
tree>, sparse })` (git's unforced two-way checkout); a refusal rethrown through `asMergeDirtyError` with all paths.
The three callers run it BEFORE their HEAD update (and `detachHead` before `restageCarried`). The dirty-tree
precondition already refuses every tracked change (those rows are SAME), so it refuses only untracked occupants and
overwrites ignored ones. `ORIG_HEAD` ordering: git writes `ORIG_HEAD` before the checkout too (no row pins it
otherwise) — leave `writeOrigHead` where it is. (Part 21 turns this helper into a wrapper over
`attemptCheckoutWorktreeToCommit`; do not anticipate it.)

Pinned rows (Part 14 rows land there):

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| S1/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s | Part 12 |
| S1/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 | Part 12 |
| S1/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s | Part 12 |
| S1/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 | Part 12 |
| S1/reset-adds | `rebase t (start)`, `rebase -i t (start)` | 1 untracked:d → d=occupant keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 | Part 12 |
| S1/reset-adds | `rebase t (fast-forward)` | 1 untracked:d → d=occupant keep=k0 | NOT_A_DIRECTORY → d=occupant keep=k0 | Part 12 |
| S1/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s | Part 12 |
| S1/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 | Part 12 |
| S2/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s | Part 12 |
| S2/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 | Part 12 |
| S2/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s | Part 12 |
| S2/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 | Part 12 |
| S2/reset-adds | `rebase t (start)`, `rebase -i t (start)` | 1 lose-untracked:f → f/ f/u=untracked keep=k0 side=s | ok → f=v1 keep=k0 side=s | Part 12 |
| S2/reset-adds | `rebase t (fast-forward)` | 1 lose-untracked:f → f/ f/u=untracked keep=k0 | ok → f=v1 keep=k0 | Part 12 |
| S2/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s | Part 12 |
| S2/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 | Part 12 |
| S3a/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/x] → d@->nowhere keep=k0 side=s | Part 12 |
| S3a/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/x] → d@->nowhere keep=k0 | Part 12 |
| S3a/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/x] → d@->nowhere keep=k0 side=s | Part 12 |
| S3a/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/x] → d@->nowhere keep=k0 | Part 12 |
| S3a/reset-adds | `rebase t (start)`, `rebase -i t (start)` | 1 untracked:d → d@->nowhere keep=k0 side=s | ok → d/ d/x=v1 keep=k0 side=s | Part 12 |
| S3a/reset-adds | `rebase t (fast-forward)` | 1 untracked:d → d@->nowhere keep=k0 | ok → d/ d/x=v1 keep=k0 | Part 12 |
| S3a/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/x] → d@->nowhere keep=k0 side=s | Part 12 |
| S3a/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/x] → d@->nowhere keep=k0 | Part 12 |
| S3b/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f@->nowhere keep=k0 side=s | WTD local=[f] → f@->nowhere keep=k0 side=s | Part 12 |
| S3b/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → f@->nowhere keep=k0 | WTD local=[f] → f@->nowhere keep=k0 | Part 12 |
| S3b/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f@->nowhere keep=k0 side=s | WTD local=[f] → f@->nowhere keep=k0 side=s | Part 12 |
| S3b/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → f@->nowhere keep=k0 | WTD local=[f] → f@->nowhere keep=k0 | Part 12 |
| S3b/reset-adds | `rebase t (start)`, `rebase -i t (start)` | 1 untracked:f → f@->nowhere keep=k0 side=s | ok → f=v1 keep=k0 side=s | Part 12 |
| S3b/reset-adds | `rebase t (fast-forward)` | 1 untracked:f → f@->nowhere keep=k0 | ok → f=v1 keep=k0 | Part 12 |
| S3b/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f@->nowhere keep=k0 side=s | WTD local=[f] → f@->nowhere keep=k0 side=s | Part 12 |
| S3b/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → f@->nowhere keep=k0 | WTD local=[f] → f@->nowhere keep=k0 | Part 12 |
| S3c/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked side=s | WTD local=[l] → keep=k0 l/ l/u=untracked side=s | Part 12 |
| S3c/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked | WTD local=[l] → keep=k0 l/ l/u=untracked | Part 12 |
| S3c/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked side=s | WTD local=[l] → keep=k0 l/ l/u=untracked side=s | Part 12 |
| S3c/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked | WTD local=[l] → keep=k0 l/ l/u=untracked | Part 12 |
| S3c/reset-adds | `rebase t (start)`, `rebase -i t (start)` | 1 lose-untracked:l → keep=k0 l/ l/u=untracked side=s | ok → keep=k0 l@->t-v1 side=s | Part 12 |
| S3c/reset-adds | `rebase t (fast-forward)` | 1 lose-untracked:l → keep=k0 l/ l/u=untracked | ok → keep=k0 l@->t-v1 | Part 12 |
| S3c/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked side=s | WTD local=[l] → keep=k0 l/ l/u=untracked side=s | Part 12 |
| S3c/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked | WTD local=[l] → keep=k0 l/ l/u=untracked | Part 12 |
| S3d/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s | Part 12 |
| S3d/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 | Part 12 |
| S3d/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s | Part 12 |
| S3d/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 | Part 12 |
| S3d/reset-adds | `rebase t (start)`, `rebase -i t (start)` | 1 untracked:d → d=occupant keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 | Part 12 |
| S3d/reset-adds | `rebase t (fast-forward)` | 1 untracked:d → d=occupant keep=k0 | NOT_A_DIRECTORY → d=occupant keep=k0 | Part 12 |
| S3d/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s | Part 12 |
| S3d/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 | Part 12 |
| S3e/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/l] → d@->nowhere keep=k0 side=s | Part 12 |
| S3e/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/l] → d@->nowhere keep=k0 | Part 12 |
| S3e/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/l] → d@->nowhere keep=k0 side=s | Part 12 |
| S3e/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/l] → d@->nowhere keep=k0 | Part 12 |
| S3e/reset-adds | `rebase t (start)`, `rebase -i t (start)` | 1 untracked:d → d@->nowhere keep=k0 side=s | ok → d/ d/l@->t-v1 keep=k0 side=s | Part 12 |
| S3e/reset-adds | `rebase t (fast-forward)` | 1 untracked:d → d@->nowhere keep=k0 | ok → d/ d/l@->t-v1 keep=k0 | Part 12 |
| S3e/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/l] → d@->nowhere keep=k0 side=s | Part 12 |
| S3e/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/l] → d@->nowhere keep=k0 | Part 12 |
| S3f/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f=occupant keep=k0 side=s | WTD local=[f] → f=occupant keep=k0 side=s | Part 12 |
| S3f/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → f=occupant keep=k0 | WTD local=[f] → f=occupant keep=k0 | Part 12 |
| S3f/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f=occupant keep=k0 side=s | WTD local=[f] → f=occupant keep=k0 side=s | Part 12 |
| S3f/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → f=occupant keep=k0 | WTD local=[f] → f=occupant keep=k0 | Part 12 |
| S3f/reset-adds | `rebase t (start)`, `rebase -i t (start)` | 1 untracked:f → f=occupant keep=k0 side=s | ok → f@->t-v1 keep=k0 side=s | Part 12 |
| S3f/reset-adds | `rebase t (fast-forward)` | 1 untracked:f → f=occupant keep=k0 | ok → f@->t-v1 keep=k0 | Part 12 |
| S3f/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f=occupant keep=k0 side=s | WTD local=[f] → f=occupant keep=k0 side=s | Part 12 |
| S3f/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → f=occupant keep=k0 | WTD local=[f] → f=occupant keep=k0 | Part 12 |
| I1/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s | Part 12 |
| I1/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 | Part 12 |
| I1/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s | Part 12 |
| I1/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 | Part 12 |
| I1/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s | Part 12 |
| I1/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 | Part 12 |
| I2/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s | Part 12 |
| I2/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 | Part 12 |
| I2/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s | Part 12 |
| I2/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 | Part 12 |
| I2/reset-adds | `rebase t (start)`, `rebase -i t (start)` | ok → f=v1 keep=k0 side=s | ok → f=v1 keep=k0 side=s | Part 12 |
| I2/reset-adds | `rebase t (fast-forward)` | ok → f=v1 keep=k0 | ok → f=v1 keep=k0 | Part 12 |
| I2/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s | Part 12 |
| I2/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 | Part 12 |
| I4/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s | Part 12 |
| I4/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 | Part 12 |
| I4/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s | Part 12 |
| I4/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 | Part 12 |
| I4/reset-deletes | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s | Part 12 |
| I4/reset-deletes | `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 | Part 12 |
| M1/same | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f=modified keep=k0 side=s | WTD local=[f] → f=modified keep=k0 side=s | Part 12 |
| M1/same | `rebase t (fast-forward)` | 1 unstaged (precondition) → f=modified keep=k0 | WTD local=[f] → f=modified keep=k0 | Part 12 |
| M1/reset-updates | `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f=modified keep=k0 side=s | WTD local=[f] → f=modified keep=k0 side=s | Part 12 |
| M1/reset-updates | `rebase t (fast-forward)` | 1 unstaged (precondition) → f=modified keep=k0 | WTD local=[f] → f=modified keep=k0 | Part 12 |

### TDD steps

1. RED — reset-worktree.test.ts `describe('checkoutWorktreeToCommit')`: an untracked file where the target adds a
   path refuses `untracked: [path]` with HEAD, index and work tree unchanged; an ignored file there is overwritten;
   an untracked file at a path both trees agree on stays. Fails: the helper does not exist.
2. GREEN — implement it.
3. RED — rebase.test.ts: `rebase.run` over an untracked occupant refuses `WORKING_TREE_DIRTY`, HEAD still on the
   branch, no `.git/rebase-merge/` (flat and interactive, one `it` each; and the fast-forward pick of
   `fastForwardOnto` refusing with HEAD unmoved). Fails: HEAD is detached first and the forced reset overwrites.
4. GREEN — reorder the three callers onto `checkoutWorktreeToCommit`.
5. RED — interop rows above.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/internal/reset-worktree.test.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/reset-worktree.ts src/application/commands/rebase.ts test/unit/application/commands/internal/reset-worktree.test.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:spelling`

### Commit

`fix(rebase): check out the onto commit before moving HEAD, refusing an untracked occupant as git does`

## Part 13 — Displace a leading regular file before the write wave

### Context

Files this part edits:
- `src/application/primitives/apply-changeset.ts` — `clearOccupants`, `applyAllEntries`.
- `test/unit/application/primitives/apply-changeset.test.ts` — displacement rows (`traceWritesUnder` :3094).
- `test/integration/checkout-occupant-displacement-interop.test.ts` — forced leading-file rows.
- `test/integration/merge-abort-interop.test.ts`, `test/integration/cherry-pick-interop.test.ts`,
  `test/integration/revert-interop.test.ts` — the deferred I1/I4 rows.

Current code: `clearOccupants(ctx, workdir, writes, policy)` (apply-changeset.ts:693-710) creates its OWN scanner
and ignore probe, handles only `add` non-gitlink non-lossy entries, skips a symlinked leading path, and clears a
directory at the path (`every` → `rmRecursive`; `ignored` → `removeIgnoredBelow` :678). `applyAllEntries`
(:712-738) runs the delete wave, then `clearOccupants(… policy)` (policy chosen by Part 5's function), then the
write wave with the shared `scanner` created in `applyChangesetInScope` (:806). The writers auto-create missing
parents but refuse a file in the way (`NOT_A_DIRECTORY`, every adapter).

New behaviour (design P1, leading-file half; ADR-1075; R1, R8): `clearOccupants` receives the shared scanner from
`applyAllEntries` (one memo per apply: R8) and processes every non-lossy `add` AND `update` entry:

```ts
for (const entry of writes) {
  if (isLossy(entry)) continue;
  const obstruction = await scanner.obstructingLeadingComponent(entry.path);
  if (obstruction?.kind === 'file') { await displaceFile(ctx, obstruction.path, policy, probe, scanner); continue; }
  if (obstruction !== undefined) continue;          // a leading symlink: the write unlinks it, as today
  if (entry.kind !== 'add' || entry.mode === FILE_MODE.GITLINK) continue;   // Part 14 lifts the `add` limit
  await clearDirectoryAt(ctx, joinPath(workdir, entry.path), policy, probe);  // today's directory clear
}
```
`displaceFile`: `every` → `ctx.fs.rm(abs)`; `ignored` → remove only when `isIgnoredPath(abs, false)` (the
pre-flight refused every other one); `protected` → nothing; then `scanner.invalidate(obstruction.path)` so the memo
drops the stale `other`. Two entries under one file (d/x, d/y) displace it once: the second scan sees the
invalidated prefix as `missing`. Each helper < 20 lines; exhaustive switch over `OccupantPolicy`.

Pinned rows (A.1 forced leading-file rows + I1/I4 /add unforced; plus every A.2 row tagged Part 13):

| row | commands | git 2.55 (pinned) | tsgit main |
|---|---|---|---|
| A.1 S1/add | `checkout -f t`, `reset --hard t`, `checkout t -- d/x` | ok → d/ d/x=v2 | NOT_A_DIRECTORY → d=occupant |
| A.1 S1/update | `checkout -f t`, `reset --hard t`, `checkout t -- d/x` | ok → d/ d/x=v2 | NOT_A_DIRECTORY → d=occupant |
| A.1 S1/same | `reset --hard HEAD`, `checkout -- d/x`, `checkout HEAD -- d/x` | ok → d/ d/x=v1 | NOT_A_DIRECTORY → d=occupant |
| A.1 S3d/add | `checkout -f t`, `reset --hard t`, `checkout t -- d/l` | ok → d/ d/l@->t-v2 | NOT_A_DIRECTORY → d=occupant |
| A.1 S3d/update | `checkout -f t`, `reset --hard t`, `checkout t -- d/l` | ok → d/ d/l@->t-v2 | NOT_A_DIRECTORY → d=occupant |
| A.1 S3d/same | `reset --hard HEAD`, `checkout -- d/l`, `checkout HEAD -- d/l` | ok → d/ d/l@->t-v1 | NOT_A_DIRECTORY → d=occupant |
| A.1 X4/add | `checkout -f t` | ok → d/ d/s/ | NOT_A_DIRECTORY → d=occupant |
| A.1 I1/add | `checkout t`, `cherry-pick t` | ok → d/ d/x=v2 | NOT_A_DIRECTORY → d=occupant |
| A.1 I4/add | `checkout t`, `cherry-pick t` | ok → d/ d/l@->t-v2 | NOT_A_DIRECTORY → d=occupant |

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| I1/reset-adds | `merge --abort` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 13 |
| I4/reset-adds | `merge --abort` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 13 |

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| I1/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 13 |
| I4/reset-adds | `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 13 |

### TDD steps

1. RED — apply-changeset.test.ts, on BOTH write paths (pooled default and one-at-a-time via `traceWritesUnder`'s
   filter-process config): a forced add beneath a regular file writes `d/x` and removes `d` before the first write
   (assert the trace order); a forced update beneath a file (index `d/x`, work tree file `d`); a forced symlink
   entry beneath a file (`d/l`); a forced gitlink beneath a file (`d/s` → `d/` and `d/s/`); an unforced add beneath
   an ignored file → displaced; `protect` → not removed (pre-flight already refused: assert the refusal); `d/x` and
   `d/y` under one file → one `rm`; clone path: an all-`add` changeset with nothing on disk calls `lstat` once per
   distinct prefix (spy). Fails: `NOT_A_DIRECTORY` from the writer (the clone-path row is a GUARD if it already
   holds: record it as GUARD).
2. GREEN — shared scanner + the loop above + `displaceFile`.
3. RED — interop rows above (all RED except rows whose main cell already equals git).
4. GUARD — the whole apply-changeset.test.ts and checkout-leading-symlink-interop.test.ts green.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/primitives/apply-changeset.test.ts test/integration/checkout-occupant-displacement-interop.test.ts test/integration/checkout-leading-symlink-interop.test.ts test/integration/merge-abort-interop.test.ts test/integration/cherry-pick-interop.test.ts test/integration/revert-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/checkout-occupant-displacement-interop.test.ts test/integration/merge-abort-interop.test.ts test/integration/cherry-pick-interop.test.ts test/integration/revert-interop.test.ts && npm run check:spelling`

### Commit

`fix(checkout): replace a regular file in a leading path by a directory on a forced write, as git does`

## Part 14 — Clear a directory at an updated path before the write wave

### Context

Files this part edits:
- `src/application/primitives/apply-changeset.ts` — `clearOccupants` (Part 13's loop).
- `test/unit/application/primitives/apply-changeset.test.ts`.
- `test/integration/checkout-occupant-displacement-interop.test.ts` — forced directory rows.
- `test/integration/checkout-leading-symlink-interop.test.ts` — S3c, S3d /same `reset --hard HEAD` and
  `checkout -- p` rows.
- `test/integration/rebase-interop.test.ts`, `test/integration/rebase-merges-interop.test.ts` — every A.2 row
  tagged Part 14.

Current code after Part 13: the loop clears a directory only for `add` entries. RC2: an `update` (or the forced
/same rewrite) whose path is now a directory reaches the in-core writer, whose `rmIfExists`
(write-working-tree-file.ts:46) cannot remove a populated directory (`DIRECTORY_NOT_EMPTY`), and the symlink
writer never removes one (the streamed regular writer's `clearOccupant`, :271, already does — S2 pool/one are
SAME).

New behaviour (design P1, directory half): drop the `entry.kind !== 'add'` condition — every non-lossy,
non-gitlink `add` or `update` entry with no leading obstruction gets `clearDirectoryAt` under the policy (`every`
→ `rmRecursive`; `ignored` → `removeIgnoredBelow`; `protected` → nothing), then `scanner.invalidate(entry.path)`.
A gitlink keeps its directory (git keeps a directory at a gitlink). Unforced `update` entries never meet a
populated non-ignored directory here: Part 2's pre-flight refused it.

Pinned rows:

| row | commands | git 2.55 (pinned) | tsgit main |
|---|---|---|---|
| A.1 S2/add | `checkout -f t`, `reset --hard t`, `checkout t -- f` | ok → f=v2 | ok → f=v2 |
| A.1 S2/update | `checkout -f t`, `reset --hard t`, `checkout t -- f` | ok → f=v2 | pool+one: ok → f=v2 / in-core: DIRECTORY_NOT_EMPTY → f/ f/u=untracked |
| A.1 S2/same | `reset --hard HEAD`, `checkout -- f`, `checkout HEAD -- f` | ok → f=v1 | pool+one: ok → f=v1 / in-core: DIRECTORY_NOT_EMPTY → f/ f/u=untracked |
| A.1 S3a/add | `checkout -f t`, `reset --hard t`, `checkout t -- d/x` | ok → d/ d/x=v2 | ok → d/ d/x=v2 |
| A.1 S3a/update | `checkout -f t`, `reset --hard t`, `checkout t -- d/x` | ok → d/ d/x=v2 | ok → d/ d/x=v2 |
| A.1 S3a/same | `reset --hard HEAD`, `checkout -- d/x`, `checkout HEAD -- d/x` | ok → d/ d/x=v1 | ok → d/ d/x=v1 |
| A.1 S3b/add | `checkout -f t`, `reset --hard t`, `checkout t -- f` | ok → f=v2 | ok → f=v2 |
| A.1 S3b/update | `checkout -f t`, `reset --hard t`, `checkout t -- f` | ok → f=v2 | ok → f=v2 |
| A.1 S3b/same | `reset --hard HEAD`, `checkout -- f`, `checkout HEAD -- f` | ok → f=v1 | ok → f=v1 |
| A.1 S3c/add | `checkout -f t`, `reset --hard t`, `checkout t -- l` | ok → l@->t-v2 | ok → l@->t-v2 |
| A.1 S3c/update | `checkout -f t`, `reset --hard t`, `checkout t -- l` | ok → l@->t-v2 | DIRECTORY_NOT_EMPTY → l/ l/u=untracked |
| A.1 S3c/same | `reset --hard HEAD`, `checkout -- l`, `checkout HEAD -- l` | ok → l@->t-v1 | DIRECTORY_NOT_EMPTY → l/ l/u=untracked |
| A.1 S3e/add | `checkout -f t`, `reset --hard t`, `checkout t -- d/l` | ok → d/ d/l@->t-v2 | ok → d/ d/l@->t-v2 |
| A.1 S3e/update | `checkout -f t`, `reset --hard t`, `checkout t -- d/l` | ok → d/ d/l@->t-v2 | ok → d/ d/l@->t-v2 |
| A.1 S3e/same | `reset --hard HEAD`, `checkout -- d/l`, `checkout HEAD -- d/l` | ok → d/ d/l@->t-v1 | ok → d/ d/l@->t-v1 |
| A.1 S3f/add | `checkout -f t`, `reset --hard t`, `checkout t -- f` | ok → f@->t-v2 | ok → f@->t-v2 |
| A.1 S3f/update | `checkout -f t`, `reset --hard t`, `checkout t -- f` | ok → f@->t-v2 | ok → f@->t-v2 |
| A.1 S3f/same | `reset --hard HEAD`, `checkout -- f`, `checkout HEAD -- f` | ok → f@->t-v1 | ok → f@->t-v1 |
| A.1 X3/update | `checkout -f t` | ok → f=v2 | ok → f=v2 |

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| S1/same | `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 14 |
| S1/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=t | Part 14 |
| S1/reset-updates | `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 14 |
| S1/reset-updates | `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=t | Part 14 |
| S1/reset-updates | `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=t | Part 14 |
| S1/reset-deletes | `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=t | Part 14 |
| S3c/same | `rebase --abort (merge)` | ok → keep=m l@->t-v1 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 14 |
| S3c/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → keep=t l@->t-v1 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 14 |
| S3c/reset-updates | `rebase --abort (merge)` | ok → keep=m l@->t-v1 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 14 |
| S3c/reset-updates | `rebase --skip (merge)` | ok → keep=t l@->t-v2 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 14 |
| S3c/reset-updates | `rebase --skip (pick changes entry)` | ok → keep=t l@->t-v1 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 14 |
| S3c/reset-deletes | `rebase --skip (merge)` | ok → keep=t l@->t-v2 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked | Part 14 |
| S3d/same | `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| S3d/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| S3d/reset-updates | `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| S3d/reset-updates | `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| S3d/reset-updates | `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| S3d/reset-deletes | `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| I1/same | `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 14 |
| I1/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=t | Part 14 |
| I1/reset-updates | `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 14 |
| I1/reset-updates | `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=t | Part 14 |
| I1/reset-updates | `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=t | Part 14 |
| I1/reset-adds | `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m | Part 14 |
| I1/reset-adds | `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=t | Part 14 |
| I1/reset-deletes | `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=t | Part 14 |
| I4/same | `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| I4/same | `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| I4/reset-updates | `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| I4/reset-updates | `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| I4/reset-updates | `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| I4/reset-adds | `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| I4/reset-adds | `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |
| I4/reset-deletes | `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) | Part 14 |

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| I1/reset-adds | `rebase-merges reset step` | ok → keep=a other=o | NOT_A_DIRECTORY → d=occupant keep=u | Part 14 |
| I4/reset-adds | `rebase-merges reset step` | ok → keep=a other=o | NOT_A_DIRECTORY → d=occupant keep=a | Part 14 |

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| I1/reset-adds | `rebase t (start)`, `rebase -i t (start)` | ok → d/ d/x=v1 keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 | Part 14 |
| I1/reset-adds | `rebase t (fast-forward)` | ok → d/ d/x=v1 keep=k0 | NOT_A_DIRECTORY → d=occupant keep=k0 | Part 14 |
| I4/reset-adds | `rebase t (start)`, `rebase -i t (start)` | ok → d/ d/l@->t-v1 keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 | Part 14 |
| I4/reset-adds | `rebase t (fast-forward)` | ok → d/ d/l@->t-v1 keep=k0 | NOT_A_DIRECTORY → d=occupant keep=k0 | Part 14 |

### TDD steps

1. RED — apply-changeset.test.ts on both write paths: a forced update of a symlink entry at a populated directory →
   link written, directory gone; a forced in-core (`core.autocrlf=true`) update of a regular entry at a populated
   directory → file written; a forced update of a gitlink at a populated directory → directory kept. Fails:
   `DIRECTORY_NOT_EMPTY` from the in-core / symlink writer (the gitlink row is a GUARD).
2. GREEN — lift the `add` restriction.
3. RED — interop rows above (RED where main differs).
4. GUARD — whole apply-changeset.test.ts green.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/primitives/apply-changeset.test.ts test/integration/checkout-occupant-displacement-interop.test.ts test/integration/checkout-leading-symlink-interop.test.ts test/integration/rebase-interop.test.ts test/integration/rebase-merges-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/checkout-occupant-displacement-interop.test.ts test/integration/checkout-leading-symlink-interop.test.ts test/integration/rebase-interop.test.ts test/integration/rebase-merges-interop.test.ts && npm run check:spelling`

### Commit

`fix(checkout): remove a directory standing where a forced write updates an entry, as git does`

## Part 15 — Path restore drops colliding index entries

### Context

Files this part edits:
- `src/application/primitives/materialize-tree.ts` — `preserveOutOfScope` (:153-159).
- `test/unit/application/primitives/materialize-tree.test.ts`.
- `test/integration/checkout-file-directory-swap-interop.test.ts` — T1, T2, T3.

Current code: `preserveOutOfScope(currentIndex, scopedPaths)` returns `[]` when `scopedPaths` is undefined, else
every index entry whose path is not in scope (`mergeNewIndexEntries` :166 prepends them). RC11: a tracked `d` kept
beside a restored d/x, tracked d/x, d/y kept beside a restored `d`.

New behaviour (design P10; R14): `preserveOutOfScope` also drops an out-of-scope entry whose path is a leading
directory of a restored target entry (`t.path` starts with `e.path + '/'`) or lies beneath one (`e.path` starts
with `t.path + '/'`). Pass `plan.target` in; build a `Set` of the target paths and their leading directories once
(no quadratic scan). The work tree needs nothing new: Part 13 displaces T1's tracked file `d`; the delete/clear
removes T3's d/.

Pinned rows:

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| `T1 tracked file `d`; `t` tracks `d/x`` | `checkout t -- d/x`, `checkout t -- d` | ok → d/ d/x=v2; index `d/x` only | NOT_A_DIRECTORY (every write path) → d=tracked; index `d` | Part 15 |
| `T1 tracked file `d`; `t` tracks `d/x`` | `checkout -f t`, `reset --hard t` | ok → d/ d/x=v2; index `d/x` only | same (SAME) | Part 15 |
| `T2 tracked file `d` modified; `t` tracks `d/x`` | `checkout t -- d/x` | ok → d/ d/x=v2 (the local change to `d` is gone); index `d/x` only | NOT_A_DIRECTORY (every write path) → d=modified; index `d` | Part 15 |
| `T3 tracked `d/x`, `d/y`; `t` tracks a file `d`` | `checkout t -- d` | ok → d=file; index `d` only | ok → d=file; index `d`, `d/x`, `d/y` (file/directory collision) | Part 15 |

### TDD steps

1. RED — materialize-tree.test.ts: restoring `d/x` from a tree over an index tracking a file `d` → new index holds
   `d/x` only; restoring `d` over an index tracking `d/x`, `d/y` → `d` only. Fails: `preserveOutOfScope` keeps the
   colliding entries.
2. GREEN — implement.
3. RED — interop rows T1, T2, T3 (T1 `checkout -f t` / `reset --hard t`: GUARD, main SAME).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/primitives/materialize-tree.test.ts test/integration/checkout-file-directory-swap-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/materialize-tree.ts test/unit/application/primitives/materialize-tree.test.ts test/integration/checkout-file-directory-swap-interop.test.ts && npm run check:spelling`

### Commit

`fix(checkout): drop index entries a restored path collides with, as git's path restore does`

## Part 16 — `stash push` builds git's work-tree tree

### Context

Files this part edits:
- `src/application/commands/stash.ts` — `classifyEntry` (:252-271), `classifyTracked` (:278-296), `projectEntry`
  (:327-343), `findLocalChanges` (:409-420).
- `test/unit/application/commands/stash.test.ts`.
- `test/integration/stash-interop.test.ts` — A.3 rows, comparing `git ls-tree -r stash@{0}` (W) and
  `stash@{0}^2` (I) too.

Current code: `classifyTracked(ctx, index, provider)` maps every index entry through `classifyEntry` (stage-0 only;
skip-worktree and gitlink → `unchanged`; a symlinked leading path → `pathspecBeyondSymlink(entry.path)`; else
`compareAndRefresh` → `delta.status`). `projectEntry` drops `absent`, keeps `unchanged`, hashes the rest via
`hashFileAt` → `cleanedContent` (:195), which `read`s a directory (EISDIR → `PERMISSION_DENIED`).
`findLocalChanges` has `base` (`BaseState`, with `bTree`: HEAD's tree) in scope.

New path set and classes (design P7 table, verbatim; R12):

```
// any index entry:  directory at a non-gitlink path      → 'unchanged' (W keeps the index entry)
// index and HEAD:    beyond a symlink                     → refuse PATHSPEC_BEYOND_SYMLINK (unchanged)
//                    file in a leading path, or absent    → 'absent'    (W drops it, unchanged)
// index only:        unreachable or absent (any reason)   → 'unchanged' (W keeps the index entry, no refusal)
// HEAD only:         beyond a symlink                     → refuse PATHSPEC_BEYOND_SYMLINK
//                    file or symlink present              → hashed into W (mode from lstat)
//                    directory, absent or unreachable     → not in W
// otherwise:         compareAndRefresh (unchanged)
```
`classifyTracked` enumerates every stage-0 index entry plus every HEAD entry (`flattenEscapedTree(ctx,
base.bTree)`) absent from the index; pass `base` from `findLocalChanges`. The directory probe is the `lstat`
`compareAndRefresh` already pays (or `lstatIfReachable` before it); the leading-path probe is the shared scanner's
`obstructingLeadingComponent`. A HEAD-only path hashed into W needs a `TrackedEntry` form that `projectEntry`
hashes (e.g. a synthetic stage-0 entry with `state: 'modified'`); keep `TrackedEntry` a discriminated shape, no
boolean flag. The I tree is unchanged (it matched git on every pair). `resetAfterPush` stays git's `reset --hard`
(Parts 3, 13, 14 already give it git's displacement and the Y3 /reset-deletes warning).

Pinned rows (A.3; `W[...]` = `git ls-tree -r stash@{0}` as `mode:oid:path`, symlink mode printed `000`):

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| S1/same | `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| S1/reset-updates | `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| S1/reset-adds | `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| S1/reset-deletes | `stash push` | ok → d=occupant keep=k0 W[644:8c13:d/x 644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| S2/same | `stash push` | ok → f=v1 keep=k0 W[644:6267:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 | Part 16 |
| S2/reset-updates | `stash push` | ok → f=v1 keep=k0 W[644:8c13:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 | Part 16 |
| S2/reset-adds | `stash push` | ok → f=v1 keep=k0 W[644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] | Part 16 |
| S2/reset-deletes | `stash push` | ok + warn `unable to unlink` → f/ f/u=untracked keep=k0 W[644:8c13:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 | Part 16 |
| S3a/same | `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 | Part 16 |
| S3a/reset-updates | `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 | Part 16 |
| S3a/reset-adds | `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | Part 16 |
| S3a/reset-deletes | `stash push` | ok → d@->nowhere keep=k0 W[644:8c13:d/x 644:9b37:keep] | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 | Part 16 |
| S3b/same | `stash push` | ok → f=v1 keep=k0 W[000:5425:f 644:9b37:keep] | ok → f=v1 keep=k0 W[000:5425:f 644:9b37:keep] | Part 16 |
| S3b/reset-updates | `stash push` | ok → f=v1 keep=k0 W[000:5425:f 644:9b37:keep] | ok → f=v1 keep=k0 W[000:5425:f 644:9b37:keep] | Part 16 |
| S3b/reset-adds | `stash push` | ok → f=v1 keep=k0 W[000:5425:f 644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] | Part 16 |
| S3b/reset-deletes | `stash push` | ok → keep=k0 W[000:5425:f 644:9b37:keep] | ok → keep=k0 W[000:5425:f 644:9b37:keep] | Part 16 |
| S3c/same | `stash push` | ok → keep=k0 l@->t-v1 W[644:9b37:keep 000:5b45:l] | PERMISSION_DENIED → keep=k0 l/ l/u=untracked | Part 16 |
| S3c/reset-updates | `stash push` | ok → keep=k0 l@->t-v1 W[644:9b37:keep 000:d085:l] | PERMISSION_DENIED → keep=k0 l/ l/u=untracked | Part 16 |
| S3c/reset-adds | `stash push` | ok → keep=k0 l@->t-v1 W[644:9b37:keep] | ok → keep=k0 l@->t-v1 W[644:9b37:keep] | Part 16 |
| S3c/reset-deletes | `stash push` | ok + warn `unable to unlink` → keep=k0 l/ l/u=untracked W[644:9b37:keep 000:d085:l] | PERMISSION_DENIED → keep=k0 l/ l/u=untracked | Part 16 |
| S3d/same | `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| S3d/reset-updates | `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| S3d/reset-adds | `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| S3d/reset-deletes | `stash push` | ok → d=occupant keep=k0 W[000:d085:d/l 644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| S3e/same | `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 | Part 16 |
| S3e/reset-updates | `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 | Part 16 |
| S3e/reset-adds | `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | Part 16 |
| S3e/reset-deletes | `stash push` | ok → d@->nowhere keep=k0 W[000:d085:d/l 644:9b37:keep] | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 | Part 16 |
| S3f/same | `stash push` | ok → f@->t-v1 keep=k0 W[644:69bf:f 644:9b37:keep] | ok → f@->t-v1 keep=k0 W[644:69bf:f 644:9b37:keep] | Part 16 |
| S3f/reset-updates | `stash push` | ok → f@->t-v1 keep=k0 W[644:69bf:f 644:9b37:keep] | ok → f@->t-v1 keep=k0 W[644:69bf:f 644:9b37:keep] | Part 16 |
| S3f/reset-adds | `stash push` | ok → f@->t-v1 keep=k0 W[644:69bf:f 644:9b37:keep] | ok → f@->t-v1 keep=k0 W[644:9b37:keep] | Part 16 |
| S3f/reset-deletes | `stash push` | ok → keep=k0 W[644:69bf:f 644:9b37:keep] | ok → keep=k0 W[644:69bf:f 644:9b37:keep] | Part 16 |
| I1/same | `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| I1/reset-updates | `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| I1/reset-adds | `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| I1/reset-deletes | `stash push` | ok → d=occupant keep=k0 W[644:8c13:d/x 644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| I2/same | `stash push` | ok → f=v1 keep=k0 W[644:6267:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 | Part 16 |
| I2/reset-updates | `stash push` | ok → f=v1 keep=k0 W[644:8c13:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 | Part 16 |
| I2/reset-adds | `stash push` | ok → f=v1 keep=k0 W[644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] | Part 16 |
| I2/reset-deletes | `stash push` | ok + warn `unable to unlink` → f/ f/u=untracked keep=k0 W[644:8c13:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 | Part 16 |
| I4/same | `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| I4/reset-updates | `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| I4/reset-adds | `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| I4/reset-deletes | `stash push` | ok → d=occupant keep=k0 W[000:d085:d/l 644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] | Part 16 |
| N0/same | `stash push` | ok → f=v1 keep=k0 | ok → f=v1 keep=k0 | Part 16 |
| N0/reset-updates | `stash push` | ok → f=v1 keep=k0 W[644:8c13:f 644:9b37:keep] | ok → f=v1 keep=k0 W[644:8c13:f 644:9b37:keep] | Part 16 |
| N0/reset-adds | `stash push` | ok → f=v1 keep=k0 W[644:6267:f 644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] | Part 16 |
| N0/reset-deletes | `stash push` | ok → keep=k0 W[644:8c13:f 644:9b37:keep] | ok → keep=k0 W[644:8c13:f 644:9b37:keep] | Part 16 |
| M1/same | `stash push` | ok → f=v1 keep=k0 W[644:2e09:f 644:9b37:keep] | ok → f=v1 keep=k0 W[644:2e09:f 644:9b37:keep] | Part 16 |
| M1/reset-updates | `stash push` | ok → f=v1 keep=k0 W[644:2e09:f 644:9b37:keep] | ok → f=v1 keep=k0 W[644:2e09:f 644:9b37:keep] | Part 16 |
| N1/same | `stash push` | ok → f=v1 keep=k0 W[644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] | Part 16 |
| N1/reset-updates | `stash push` | ok → f=v1 keep=k0 W[644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] | Part 16 |
| N1/reset-adds | `stash push` | ok → f=v1 keep=k0 W[644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] | Part 16 |
| N1/reset-deletes | `stash push` | ok → keep=k0 W[644:8c13:f 644:9b37:keep] | ok → keep=k0 W[644:9b37:keep] | Part 16 |
| Y3/same | `stash push` | ok → f=v1 g=v1 keep=k0 W[644:6267:f 644:69bf:g 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked g=occupant keep=k0 | Part 16 |
| Y3/reset-updates | `stash push` | ok → f=v1 g=v1 keep=k0 W[644:8c13:f 644:69bf:g 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked g=occupant keep=k0 | Part 16 |
| Y3/reset-adds | `stash push` | ok → f=v1 g=v1 keep=k0 W[644:69bf:g 644:9b37:keep] | ok → f=v1 g=v1 keep=k0 W[644:9b37:keep] | Part 16 |
| Y3/reset-deletes | `stash push` | ok + warn `unable to unlink` → f/ f/u=untracked keep=k0 W[644:8c13:f 644:69bf:g 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked g=occupant keep=k0 | Part 16 |

### TDD steps

1. RED — stash.test.ts, one `it` per class: a directory at a tracked path → W keeps the index entry, no
   `PERMISSION_DENIED`; an index-only entry whose file is missing → W keeps it; an index-only entry beyond a symlink
   → kept, no refusal; a HEAD-only path with a file present → hashed into W with its lstat mode; a HEAD-only path
   beyond a symlink → `PATHSPEC_BEYOND_SYMLINK`; a HEAD-only path with a directory → not in W. Fails: the
   directory row throws `PERMISSION_DENIED`, the index-only rows drop or refuse, HEAD-only paths never reach W.
2. GREEN — implement the classes (split `classifyEntry` per source: index-and-HEAD, index-only, HEAD-only; each
   < 20 lines).
3. RED — interop rows above (RED/GUARD by the main column).
4. GUARD — whole stash.test.ts green (SHA-pinned rows unchanged).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/stash.test.ts test/integration/stash-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/stash-interop.test.ts && npm run check:spelling`

### Commit

`fix(stash): build the work-tree tree from git's path set, keeping index entries a directory hides`

## Part 17 — A true merge snapshots local changes before its strategies

### Context

Files this part edits:
- `src/application/commands/stash.ts` — `stashCommitWriter` (:538-569) identity option; the beyond-symlink refusal
  moves after the index commit; new internal `snapshotLocalChanges`.
- `src/application/commands/merge.ts` — `twoHeadMerge` (:666-698), `twoHeadStrategy` (:725-738), `manyHeadMerge`
  (:913-950): `entersTrivialBranch` and the snapshot.
- `test/unit/application/commands/stash.test.ts`, `test/unit/application/commands/merge.test.ts`.
- `test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts` — the Q rows below, the S3a/S3e /same
  snapshot refusal, SHA1/SHA2.

Current code: `twoHeadMerge` → after the up-to-date / fast-forward / `--ff-only` exits, `underAutostash(ctx, opts,
async () => { carried = await refuseDirtyIndex(ctx, ourId); …; return twoHeadStrategy(…) })`. `twoHeadStrategy`
gates `tryTrivialMerge` (:884, which itself needs `bases.length === 1` and `carried.length === 0`) on
`allowsTrivialMerge(commit.opts.strategies)` (src/application/commands/internal/merge-strategies.ts:61) alone.
`manyHeadMerge` runs `refuseDirtyIndex` then `manyHeadStrategy` (:969). `SettledMerge` (:306) carries `commit?`
(:241, `false` = `--no-commit`) and `squash?` (:233). `resolveMergeAuthor(ctx, opts)` (:2123) and
`resolveMergeCommitter(opts, author)` (:2145). stash.ts: `stashAndReset` (:489-517) = `resolveBase` →
`acquireIndexLock` → `findLocalChanges` (:409) → `hasLocalChanges` (:422) → `createStashCommits` (:576-596: index
commit, untracked, W tree, WIP commit) → record → reset. `stashCommitWriter` uses `resolveReflogIdentity` for author
and committer. `classifyEntry` (:252) throws `pathspecBeyondSymlink` BEFORE any commit is written; git's
`stash create` writes the `index on` commit first and dies while building W (A.5 S3a /same: one unreachable
`index on main: 4caedad d` commit).

New behaviour (design P9 steps 1–2; ADR-1082; R13; DC-F):
- `stashCommitWriter(ctx, base, opts, identities?: { readonly author: AuthorIdentity; readonly committer:
  AuthorIdentity })` — absent → `resolveReflogIdentity` for both, as today (`stash push`, `createAutostash`).
- `classifyEntry` reports a beyond-symlink index-and-HEAD entry as a `TrackedEntry` state that counts as a local
  change and makes `projectEntry` throw `pathspecBeyondSymlink(path)` — so the refusal comes after the index commit,
  for `stash push` too (git's order; stash push rows keep their outcome).
- `export const snapshotLocalChanges = (ctx, workDir, identities): Promise<ObjectId | undefined>` (internal: imported
  by merge.ts only) = `stashAndReset`'s first half under the same lock (DC-F): `findLocalChanges(ctx, {}, base)`,
  `undefined` when `!hasLocalChanges`, else `createStashCommits` with the identities, returning the WIP commit; no
  ref written, no reset. Untracked files and stat-only changes write nothing (Q5, Q6, Q18).
- merge.ts: `entersTrivialBranch(commit, bases)` = one remote head (two-head path only), `bases.length === 1`,
  `commit.opts.commit !== false`, `commit.opts.squash !== true`, `allowsTrivialMerge(strategies)`. In
  `twoHeadMerge`'s `underAutostash` body: `carried = refuseDirtyIndex(…)` (unchanged in this part; Part 19 moves it);
  if `entersTrivialBranch` → `tryTrivialMerge`, returning its result when defined (Q13: no snapshot); then
  `snapshot = await snapshotLocalChanges(ctx, workDir, { author, committer })` with `author =
  resolveMergeAuthor(ctx, input)`, `committer = resolveMergeCommitter(input, author)`; then the strategies.
  `manyHeadMerge` takes the snapshot after its `refuseDirtyIndex` (never the trivial branch). `twoHeadStrategy`
  loses its own trivial gate. This part only takes the snapshot; Part 18 threads it into `tryStrategies`.
- Messages, parents and trees come from the existing writer unchanged (`index on <branch>: <abbrev> <subject>` + LF;
  `WIP on …` without trailing LF; `(no branch)` when detached; parents `[HEAD]` and `[HEAD, index]`; never an
  untracked commit).
- Interop identities: git peer `GIT_AUTHOR_*` = Ada 1700000000 +0000, `GIT_COMMITTER_*` = Bob 1700000100 +0000;
  tsgit `merge` with `author` / `committer` inputs set to the same values. Each row compares the work tree, the
  index, the outcome and the SET of objects no ref reaches (`git cat-file --batch-all-objects --batch-check` before
  and after, minus `git rev-list --objects --all`).

Pinned rows (A.5 Q; this part):

| row | before `merge` | command | git 2.55 (pinned): exit; objects no ref reaches; tree after |
|---|---|---|---|
| Q1 | `dirty` modified | `merge t` (non-ff) | 0; snapshot (`3c5e344` index, `6a3c50b` WIP, W `e5d7737`, blob `2680cfd`) |
| Q2 | clean | `merge t` | 0; nothing |
| Q5 | untracked file only | `merge t` | 0; nothing |
| Q6 | `dirty` touched, content unchanged | `merge t` | 0; nothing |
| Q7 | `dirty` modified, `t` a descendant | `merge t` (ff) | 0; nothing |
| Q8 | `dirty` modified | `merge --squash t` | 0; snapshot + result tree |
| Q9 | as Q7 | `merge --squash t` | 0; nothing |
| Q10 | `dirty` modified | `merge --no-commit t` | 0; snapshot + result tree |
| Q11 | `dirty` modified | `merge -s ours -s ort t` | 0; snapshot |
| Q13 | `dirty` modified | `merge -s resolve t` (trivial) | 0; nothing (in-index merge) |
| Q15 | `dirty` modified, detached HEAD | `merge t` | 0; snapshot named `index on (no branch): bd40de3 side subject` / `WIP on (no branch): …` |
| Q17 | `dirty` modified; `keep` conflicts | `merge t` | 1; snapshot + ort's conflict trees; no restore |
| Q18 | untracked file + `dirty` modified | `merge t` | 0; snapshot (two commits only) |
| Q19 | `dirty` modified | `merge --ff-only t` (non-ff) | 128; nothing |
| Q20 | `dirty` modified; two-sided | `merge -s resolve t` | 0; snapshot |
| Q23 | `dirty` modified | `merge t t2` (octopus) | 0; snapshot + an intermediate tree |
| S3a /same | `d -> nowhere` over tracked d/x (with or without `dirty` modified) | `merge t` | 128 `'d/x' is beyond a symbolic link`, `Cannot save the current worktree state`, `stash failed`; one `index on main: 4caedad d` commit; tree untouched |
| SHA1 | as Q1, author = committer = Ada 1700000000 | `git stash create` / tsgit `stash push` | `387b9e532a2c…` |
| SHA2 | as Q4, same identity | same | `f0f8389d5b28…` |

S3e /same (dangling symlink `d` over a tracked d/l) follows the S3a /same row (design A.2 `merge t (non-ff)`
S3e /same: exit 128 beyond-symlink before merging).

### TDD steps

1. RED — stash.test.ts: `stashCommitWriter` with `{ author, committer }` apart writes commits whose author and
   committer differ as given; a beyond-symlink tracked path makes `stash push` refuse `PATHSPEC_BEYOND_SYMLINK`
   AFTER one `index on` commit exists in the object store; `snapshotLocalChanges` writes no ref and resets nothing,
   and returns `undefined` on a clean tree. Fails: no identity parameter / the refusal precedes the commit / no
   function.
2. GREEN — stash.ts changes.
3. GUARD — the stash.test.ts SHA rows (tsgit `stash push` already writes `git stash create`'s SHAs with one identity:
   SHA1 `387b9e532a2c…`, SHA2 `f0f8389d5b28…`).
4. RED — merge.test.ts, one `it` per guard of `entersTrivialBranch` (one base + committing + all strategies allow →
   no snapshot; `--no-commit`, `--squash`, two bases, two heads each → snapshot), a clean tree → no snapshot, the
   snapshot is written before the first strategy (spy order), the merge's author and committer reach the snapshot.
   Fails: no snapshot is ever written.
5. GREEN — merge.ts changes.
6. RED — interop rows above (RED: Q1, Q8, Q10, Q15, Q17, Q18, Q20, Q23, S3a/S3e `/same`; GUARD: Q2, Q5, Q6, Q7, Q9,
   Q13, Q19, SHA1, SHA2 — main writes nothing there, as git).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/stash.test.ts test/unit/application/commands/merge.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts test/integration/stash-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts src/application/commands/merge.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/merge.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts && npm run check:spelling`

### Commit

`fix(merge): snapshot local changes as git stash create does before a true merge's strategies`

## Part 18 — The strategy loop rewinds and restores as git does

### Context

Files this part edits:
- `src/application/commands/merge.ts` — `tryStrategies` (:767-788), `commitCleanAttempt` (:791-801),
  `materialiseNonConflictTree` (:1045-1058), `assertNothingOverwritten` (:1763-1775) consumers.
- `src/application/commands/stash.ts` — new internal `restoreSnapshot(ctx, workDir, snapshot)` over
  `applyStashCommit` (:842) with `restoreIndex: true` (git's `stash apply --index`).
- `test/unit/application/commands/merge.test.ts`, `test/unit/application/commands/stash.test.ts`.
- `test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts` — Q12, Q14, Q16, Q25, Q27, Q28, Q29,
  Q33 and the A.2 `merge t (non-ff…)` rows.

Read-only: `hardResetWorktreeToCommit` (src/application/commands/internal/reset-worktree.ts:21) — the rewind (DC-A).

Current code: `tryStrategies(ctx, commit, attempt)`: for each strategy, `clean` → `commitCleanAttempt` (any
refusal escapes the loop: RC10c), `conflict` → `preferConflict(best, tried)`; after the loop `best.persist()`;
else throw `mergeStrategyFailed` (one) / `noMergeStrategyHandled` (several). A clean write refusal throws
`WORKING_TREE_DIRTY` from `materialiseNonConflictTree` (via `asMergeDirtyError`); a conflict write refusal throws
from `refuseUnwritableConflicts` → `assertNothingOverwritten`. The fast-forward path (`fastForward`) also uses
`materialiseNonConflictTree` and must keep throwing (A.1 `merge t (ff)` rows: no restore).

New behaviour (design P9 step 3; R15; DC-H):
- The clean write's refusal becomes a typed outcome: `attemptNonConflictTree` returns `{ kind: 'written'; entries }
  | WouldOverwriteRefusal` (`{ kind: 'refused', localChanges, untracked }`); `materialiseNonConflictTree` stays its
  throwing wrapper for the fast-forward. `commitCleanAttempt` returns `MergeEnding | StrategyRefusal`; a conflict
  `persist` whose pre-flight refuses likewise returns the refusal. A refusal = the strategy FAILED; the loop moves on.
- `rewind(ctx, commit, snapshot)` = `hardResetWorktreeToCommit(ctx, commit.ourId)` then, when `snapshot` is
  defined, `restoreSnapshot` (re-applies W with its index). Run it: before every strategy after the first; after the
  loop when the best conflicting strategy was not the last one tried, before persisting it; and when nothing handled
  the merge, before throwing.
- Failure mapping when nothing handled it: exactly one strategy tried and it is `ort`-family (`ort`, `recursive`,
  `subtree`) with a refusal → `workingTreeDirty` with that refusal's paths (Q16; unchanged class); one other strategy
  → `mergeStrategyFailed(strategy)`; several → `noMergeStrategyHandled(strategies)`.
- `snapshot` comes from Part 17's call site, passed into `tryStrategies` (and `manyHeadStrategy`'s loop).
- `assertNoneBeyondSymlink` (:1779) stays for the merge's own changed paths.
- Net effect pinned (design P9 "Observed net effect"): a directory at a tracked path is replaced by HEAD's file or
  link; a file in a leading path is removed; local modifications and staged changes survive; the restore writes no
  object beyond the snapshot.

Pinned rows:

| row | before `merge` | command | git 2.55 (pinned): exit; objects no ref reaches; tree after |
|---|---|---|---|
| Q12 | `dirty` modified | `merge -s octopus -s ort t` | 0; snapshot; rewound tree keeps `dirty=mod` |
| Q14 | f/u over tracked `f` | `merge -s octopus -s ort t` | 0; `index on` + `WIP on` (W = HEAD's tree); the rewind deletes f/u, `ort` merges (`f=v2`). A second run repeated it. |
| Q16 | `dirty` modified, f/u over tracked `f` | `merge t` | 2 local:f + `Merge with strategy ort failed`; snapshot + result tree; restored `f=v1`, `dirty=mod`, f/u gone |
| Q25 | f/u over tracked `f` | `merge -s ort -s ort t` | 0; as Q14 (the first `ort` refuses local:f) |
| Q27 | as Q16 | `merge --no-commit t` | 2; as Q16 |
| Q28 | as Q16 | `merge --squash t` | 2; as Q16 |
| Q29 | f/u over tracked `f`; two-sided | `merge -s resolve t` | 2 `Entry 'f' not uptodate` + `Merge with strategy resolve failed`; snapshot; restored, f/u gone |
| Q33 | as Q16 | `merge -s resolve t` (trivial trees) | 2 `Entry 'f' not uptodate` + `Merge with strategy resolve failed`; snapshot |

| row | commands | git 2.55 (pinned) | tsgit main | lands in |
|---|---|---|---|---|
| S1/same | `merge t (non-ff)` | ok → d=occupant keep=k0 side=s | ok → d=occupant keep=k0 side=s | Part 18 |
| S1/same | `merge t (non-ff, conflicting)` | 1 conflict → d=occupant keep=(markers) side=s | conflict → d=occupant keep=(markers) side=s | Part 18 |
| S1/reset-updates | `merge t (non-ff)` | 2 local:d/x → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| S1/reset-updates | `merge t (non-ff, conflicting)` | 2 local:d/x → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| S1/reset-adds | `merge t (non-ff)` | 2 local:d/x → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| S1/reset-adds | `merge t (non-ff, conflicting)` | 2 local:d/x → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| S1/reset-deletes | `merge t (non-ff)` | 2 untracked:d → d=occupant keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| S1/reset-deletes | `merge t (non-ff, conflicting)` | 2 untracked:d → d=occupant keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| S2/same | `merge t (non-ff)` | ok → f/ f/u=untracked keep=k0 side=s | ok → f/ f/u=untracked keep=k0 side=s | Part 18 |
| S2/same | `merge t (non-ff, conflicting)` | 1 conflict → f/ f/u=untracked keep=(markers) side=s | conflict → f/ f/u=untracked keep=(markers) side=s | Part 18 |
| S2/reset-updates | `merge t (non-ff)` | 2 local:f → f=v1 keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked keep=k0 side=s | Part 18 |
| S2/reset-updates | `merge t (non-ff, conflicting)` | 2 local:f → f=v1 keep=m side=s | WTD local=[f] → f/ f/u=untracked keep=m side=s | Part 18 |
| S2/reset-adds | `merge t (non-ff)` | 2 lose-untracked:f → f=v1 keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked keep=k0 side=s | Part 18 |
| S2/reset-adds | `merge t (non-ff, conflicting)` | 2 lose-untracked:f → f=v1 keep=m side=s | WTD local=[f] → f/ f/u=untracked keep=m side=s | Part 18 |
| S2/reset-deletes | `merge t (non-ff)` | 2 lose-untracked:f → f/ f/u=untracked keep=k0 side=s | WTD untracked=[f] → f/ f/u=untracked keep=k0 side=s | Part 18 |
| S2/reset-deletes | `merge t (non-ff, conflicting)` | 2 lose-untracked:f → f/ f/u=untracked keep=m side=s | WTD untracked=[f] → f/ f/u=untracked keep=m side=s | Part 18 |
| S3a/same | `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | ok → d@->nowhere keep=k0 side=s | Part 18 |
| S3a/same | `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | conflict → d@->nowhere keep=(markers) side=s | Part 18 |
| S3a/reset-updates | `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | WTD local=[d/x] → d@->nowhere keep=k0 side=s | Part 18 |
| S3a/reset-updates | `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | WTD local=[d/x] → d@->nowhere keep=m side=s | Part 18 |
| S3a/reset-adds | `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | WTD local=[d/x] → d@->nowhere keep=k0 side=s | Part 18 |
| S3a/reset-adds | `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | WTD local=[d/x] → d@->nowhere keep=m side=s | Part 18 |
| S3a/reset-deletes | `merge t (non-ff)` | 2 untracked:d → d@->nowhere keep=k0 side=s | WTD untracked=[d] → d@->nowhere keep=k0 side=s | Part 18 |
| S3a/reset-deletes | `merge t (non-ff, conflicting)` | 2 untracked:d → d@->nowhere keep=m side=s | conflict → d/ d/x=v2 keep=(markers) side=s | Part 18 |
| S3b/same | `merge t (non-ff)` | ok → f@->nowhere keep=k0 side=s | ok → f@->nowhere keep=k0 side=s | Part 18 |
| S3b/same | `merge t (non-ff, conflicting)` | 1 conflict → f@->nowhere keep=(markers) side=s | conflict → f@->nowhere keep=(markers) side=s | Part 18 |
| S3b/reset-updates | `merge t (non-ff)` | 2 local:f → f@->nowhere keep=k0 side=s | WTD local=[f] → f@->nowhere keep=k0 side=s | Part 18 |
| S3b/reset-updates | `merge t (non-ff, conflicting)` | 2 local:f → f@->nowhere keep=m side=s | WTD local=[f] → f@->nowhere keep=m side=s | Part 18 |
| S3b/reset-adds | `merge t (non-ff)` | 2 local:f → f@->nowhere keep=k0 side=s | WTD local=[f] → f@->nowhere keep=k0 side=s | Part 18 |
| S3b/reset-adds | `merge t (non-ff, conflicting)` | 2 local:f → f@->nowhere keep=m side=s | WTD local=[f] → f@->nowhere keep=m side=s | Part 18 |
| S3b/reset-deletes | `merge t (non-ff)` | 2 untracked:f → f@->nowhere keep=k0 side=s | WTD untracked=[f] → f@->nowhere keep=k0 side=s | Part 18 |
| S3b/reset-deletes | `merge t (non-ff, conflicting)` | 2 untracked:f → f@->nowhere keep=m side=s | WTD untracked=[f] → f@->nowhere keep=m side=s | Part 18 |
| S3c/same | `merge t (non-ff)` | ok → keep=k0 l/ l/u=untracked side=s | ok → keep=k0 l/ l/u=untracked side=s | Part 18 |
| S3c/same | `merge t (non-ff, conflicting)` | 1 conflict → keep=(markers) l/ l/u=untracked side=s | conflict → keep=(markers) l/ l/u=untracked side=s | Part 18 |
| S3c/reset-updates | `merge t (non-ff)` | 2 local:l → keep=k0 l@->t-v1 side=s | PERMISSION_DENIED → keep=k0 l/ l/u=untracked side=s | Part 18 |
| S3c/reset-updates | `merge t (non-ff, conflicting)` | 2 local:l → keep=m l@->t-v1 side=s | WTD local=[l] → keep=m l/ l/u=untracked side=s | Part 18 |
| S3c/reset-adds | `merge t (non-ff)` | 2 lose-untracked:l → keep=k0 l@->t-v1 side=s | PERMISSION_DENIED → keep=k0 l/ l/u=untracked side=s | Part 18 |
| S3c/reset-adds | `merge t (non-ff, conflicting)` | 2 lose-untracked:l → keep=m l@->t-v1 side=s | WTD local=[l] → keep=m l/ l/u=untracked side=s | Part 18 |
| S3c/reset-deletes | `merge t (non-ff)` | 2 lose-untracked:l → keep=k0 l/ l/u=untracked side=s | WTD untracked=[l] → keep=k0 l/ l/u=untracked side=s | Part 18 |
| S3c/reset-deletes | `merge t (non-ff, conflicting)` | 2 lose-untracked:l → keep=m l/ l/u=untracked side=s | WTD untracked=[l] → keep=m l/ l/u=untracked side=s | Part 18 |
| S3d/same | `merge t (non-ff)` | ok → d=occupant keep=k0 side=s | ok → d=occupant keep=k0 side=s | Part 18 |
| S3d/same | `merge t (non-ff, conflicting)` | 1 conflict → d=occupant keep=(markers) side=s | conflict → d=occupant keep=(markers) side=s | Part 18 |
| S3d/reset-updates | `merge t (non-ff)` | 2 local:d/l → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| S3d/reset-updates | `merge t (non-ff, conflicting)` | 2 local:d/l → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| S3d/reset-adds | `merge t (non-ff)` | 2 local:d/l → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| S3d/reset-adds | `merge t (non-ff, conflicting)` | 2 local:d/l → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| S3d/reset-deletes | `merge t (non-ff)` | 2 untracked:d → d=occupant keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| S3d/reset-deletes | `merge t (non-ff, conflicting)` | 2 untracked:d → d=occupant keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| S3e/same | `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | ok → d@->nowhere keep=k0 side=s | Part 18 |
| S3e/same | `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | conflict → d@->nowhere keep=(markers) side=s | Part 18 |
| S3e/reset-updates | `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | WTD local=[d/l] → d@->nowhere keep=k0 side=s | Part 18 |
| S3e/reset-updates | `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | WTD local=[d/l] → d@->nowhere keep=m side=s | Part 18 |
| S3e/reset-adds | `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | WTD local=[d/l] → d@->nowhere keep=k0 side=s | Part 18 |
| S3e/reset-adds | `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | WTD local=[d/l] → d@->nowhere keep=m side=s | Part 18 |
| S3e/reset-deletes | `merge t (non-ff)` | 2 untracked:d → d@->nowhere keep=k0 side=s | WTD untracked=[d] → d@->nowhere keep=k0 side=s | Part 18 |
| S3e/reset-deletes | `merge t (non-ff, conflicting)` | 2 untracked:d → d@->nowhere keep=m side=s | conflict → d/ d/l@->t-v2 keep=(markers) side=s | Part 18 |
| S3f/same | `merge t (non-ff)` | ok → f=occupant keep=k0 side=s | ok → f=occupant keep=k0 side=s | Part 18 |
| S3f/same | `merge t (non-ff, conflicting)` | 1 conflict → f=occupant keep=(markers) side=s | conflict → f=occupant keep=(markers) side=s | Part 18 |
| S3f/reset-updates | `merge t (non-ff)` | 2 local:f → f=occupant keep=k0 side=s | WTD local=[f] → f=occupant keep=k0 side=s | Part 18 |
| S3f/reset-updates | `merge t (non-ff, conflicting)` | 2 local:f → f=occupant keep=m side=s | WTD local=[f] → f=occupant keep=m side=s | Part 18 |
| S3f/reset-adds | `merge t (non-ff)` | 2 local:f → f=occupant keep=k0 side=s | WTD local=[f] → f=occupant keep=k0 side=s | Part 18 |
| S3f/reset-adds | `merge t (non-ff, conflicting)` | 2 local:f → f=occupant keep=m side=s | WTD local=[f] → f=occupant keep=m side=s | Part 18 |
| S3f/reset-deletes | `merge t (non-ff)` | 2 untracked:f → f=occupant keep=k0 side=s | WTD untracked=[f] → f=occupant keep=k0 side=s | Part 18 |
| S3f/reset-deletes | `merge t (non-ff, conflicting)` | 2 untracked:f → f=occupant keep=m side=s | WTD untracked=[f] → f=occupant keep=m side=s | Part 18 |
| I1/same | `merge t (non-ff)` | ok → d=occupant keep=k0 side=s | ok → d=occupant keep=k0 side=s | Part 18 |
| I1/same | `merge t (non-ff, conflicting)` | 1 conflict → d=occupant keep=(markers) side=s | conflict → d=occupant keep=(markers) side=s | Part 18 |
| I1/reset-updates | `merge t (non-ff)` | 2 local:d/x → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| I1/reset-updates | `merge t (non-ff, conflicting)` | 2 local:d/x → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| I1/reset-adds | `merge t (non-ff)` | 2 local:d/x → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| I1/reset-adds | `merge t (non-ff, conflicting)` | 2 local:d/x → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| I1/reset-deletes | `merge t (non-ff)` | ok → d/ d/x=v2 keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| I1/reset-deletes | `merge t (non-ff, conflicting)` | 1 conflict → d/ d/x=v2 keep=(markers) side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| I2/same | `merge t (non-ff)` | ok → f/ f/u=untracked keep=k0 side=s | ok → f/ f/u=untracked keep=k0 side=s | Part 18 |
| I2/same | `merge t (non-ff, conflicting)` | 1 conflict → f/ f/u=untracked keep=(markers) side=s | conflict → f/ f/u=untracked keep=(markers) side=s | Part 18 |
| I2/reset-updates | `merge t (non-ff)` | 2 local:f → f=v1 keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked keep=k0 side=s | Part 18 |
| I2/reset-updates | `merge t (non-ff, conflicting)` | 2 local:f → f=v1 keep=m side=s | WTD local=[f] → f/ f/u=untracked keep=m side=s | Part 18 |
| I2/reset-adds | `merge t (non-ff)` | 2 local:f → f=v1 keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked keep=k0 side=s | Part 18 |
| I2/reset-adds | `merge t (non-ff, conflicting)` | 2 local:f → f=v1 keep=m side=s | WTD local=[f] → f/ f/u=untracked keep=m side=s | Part 18 |
| I2/reset-deletes | `merge t (non-ff)` | ok → f=v2 keep=k0 side=s | ok → f=v2 keep=k0 side=s | Part 18 |
| I2/reset-deletes | `merge t (non-ff, conflicting)` | 1 conflict → f=v2 keep=(markers) side=s | WTD untracked=[f] → f/ f/u=untracked keep=m side=s | Part 18 |
| I4/same | `merge t (non-ff)` | ok → d=occupant keep=k0 side=s | ok → d=occupant keep=k0 side=s | Part 18 |
| I4/same | `merge t (non-ff, conflicting)` | 1 conflict → d=occupant keep=(markers) side=s | conflict → d=occupant keep=(markers) side=s | Part 18 |
| I4/reset-updates | `merge t (non-ff)` | 2 local:d/l → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| I4/reset-updates | `merge t (non-ff, conflicting)` | 2 local:d/l → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| I4/reset-adds | `merge t (non-ff)` | 2 local:d/l → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| I4/reset-adds | `merge t (non-ff, conflicting)` | 2 local:d/l → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| I4/reset-deletes | `merge t (non-ff)` | ok → d/ d/l@->t-v2 keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s | Part 18 |
| I4/reset-deletes | `merge t (non-ff, conflicting)` | 1 conflict → d/ d/l@->t-v2 keep=(markers) side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s | Part 18 |
| M1/same | `merge t (non-ff)` | ok → f=modified keep=k0 side=s | ok → f=modified keep=k0 side=s | Part 18 |
| M1/same | `merge t (non-ff, conflicting)` | 1 conflict → f=modified keep=(markers) side=s | conflict → f=modified keep=(markers) side=s | Part 18 |
| M1/reset-updates | `merge t (non-ff)` | 2 local:f → f=modified keep=k0 side=s | WTD local=[f] → f=modified keep=k0 side=s | Part 18 |
| M1/reset-updates | `merge t (non-ff, conflicting)` | 2 local:f → f=modified keep=m side=s | WTD local=[f] → f=modified keep=m side=s | Part 18 |
| Y3/same | `merge t (non-ff)` | ok → f/ f/u=untracked g=occupant keep=k0 side=s | ok → f/ f/u=untracked g=occupant keep=k0 side=s | Part 18 |
| Y3/same | `merge t (non-ff, conflicting)` | 1 conflict → f/ f/u=untracked g=occupant keep=(markers) side=s | conflict → f/ f/u=untracked g=occupant keep=(markers) side=s | Part 18 |
| Y3/reset-updates | `merge t (non-ff)` | 2 local:f,g → f=v1 g=occupant keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked g=occupant keep=k0 side=s | Part 18 |
| Y3/reset-updates | `merge t (non-ff, conflicting)` | 2 local:f,g → f=v1 g=occupant keep=m side=s | WTD local=[f,g] → f/ f/u=untracked g=occupant keep=m side=s | Part 18 |
| Y3/reset-adds | `merge t (non-ff)` | 2 local:g → f=v1 g=occupant keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked g=occupant keep=k0 side=s | Part 18 |
| Y3/reset-adds | `merge t (non-ff, conflicting)` | 2 local:g → f=v1 g=occupant keep=m side=s | WTD local=[f,g] → f/ f/u=untracked g=occupant keep=m side=s | Part 18 |
| Y3/reset-deletes | `merge t (non-ff)` | 2 lose-untracked:f + untracked:g → f/ f/u=untracked g=occupant keep=k0 side=s | WTD untracked=[f,g] → f/ f/u=untracked g=occupant keep=k0 side=s | Part 18 |
| Y3/reset-deletes | `merge t (non-ff, conflicting)` | 2 lose-untracked:f + untracked:g → f/ f/u=untracked g=occupant keep=m side=s | WTD untracked=[f,g] → f/ f/u=untracked g=occupant keep=m side=s | Part 18 |

### TDD steps

1. RED — stash.test.ts: `restoreSnapshot` re-applies a snapshot's work-tree and index changes over a tree reset to
   HEAD (`M ` and `MM` survive). Fails: no function.
2. GREEN — `restoreSnapshot`.
3. RED — merge.test.ts, one `it` each: no rewind before the first strategy; a rewind before the second; a refused
   clean write moves to the next strategy (`-s ort -s ort` over a directory at a tracked path → merged); the best
   conflict is persisted after a rewind unless it was the last strategy tried; nothing handled → rewind then the
   three-way failure mapping (one ort refusal → `WORKING_TREE_DIRTY` with paths; one `resolve` → `MERGE_STRATEGY_FAILED`
   with `strategy: 'resolve'`; two → `NO_MERGE_STRATEGY_HANDLED` with both names). Fails: the refusal escapes the
   loop and no rewind exists.
4. GREEN — typed refusal + `rewind` + mapping.
5. RED — interop rows above (A.2 rows with a main cell equal to git are GUARD).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/merge.test.ts test/unit/application/commands/stash.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/merge.ts src/application/commands/stash.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/stash.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts && npm run check:spelling`

### Commit

`fix(merge): rewind and restore local changes between strategies and after a refusal, as git does`

## Part 19 — A staged change fails each strategy after the snapshot

### Context

Files this part edits:
- `src/application/commands/merge.ts` — `refuseDirtyIndex` (:715-722) and its two calls (:693, :946), the
  strategy attempts.
- `test/unit/application/commands/merge.test.ts`.
- `test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts` — Q3, Q4, Q21, Q22, Q24, Q26, Q30, Q31,
  Q32.

Current code: `refuseDirtyIndex(ctx, ourId)` throws `workingTreeDirty({ localChanges: refused })` before every
strategy list, returning the `carried` gitlinks otherwise (`indexDifferences`, src/application/commands/internal/
clean-work-tree.ts).

New behaviour (design P9 step 1 and step 3; R16): on the trivial branch (`entersTrivialBranch`, Part 17)
`refuseDirtyIndex` keeps refusing before any snapshot (Q21, Q31: SAME). Off it, compute `indexDifferences` once
(after the snapshot) for `carried`; each strategy attempt (after the rewind, Part 18) fails when the index differs
from HEAD outside the carried gitlinks: an `ort`-family strategy fails with the staged paths as its refusal data,
`ours`, octopus and `resolve` fail bare. Part 18's mapping then gives: one ort → `WORKING_TREE_DIRTY` with the staged
paths (Q3, Q26); one other → `MERGE_STRATEGY_FAILED` (Q22, Q24, Q32); several → `NO_MERGE_STRATEGY_HANDLED` (Q30).
The snapshot was written first (Q3, Q4: restored `M  dirty` / `MM dirty`).

Pinned rows:

| row | before `merge` | command | git 2.55 (pinned): exit; objects no ref reaches; tree after |
|---|---|---|---|
| Q3 | `dirty` staged | `merge t` | 2 local:dirty + `Merge with strategy ort failed`; snapshot (I = W tree); restored `M  dirty` |
| Q4 | `dirty` staged, then changed again | `merge t` | 2 as Q3; snapshot (I tree, W tree, blob); restored `MM dirty` |
| Q21 | `dirty` staged | `merge -s resolve t` (trivial) | 2 local:dirty, no strategy line; nothing |
| Q22 | `dirty` staged | `merge -s ours t` | 2 `Merge with strategy ours failed`; snapshot |
| Q24 | `dirty` staged | `merge t t2` | 2 `Merge with strategy octopus failed`; snapshot |
| Q26 | `dirty` staged | `merge --squash t` | 2 as Q3; snapshot |
| Q30 | `dirty` staged | `merge -s ort -s ours t` | 2 local:dirty + `No merge strategy handled the merge`; snapshot |
| Q31 | `dirty` staged; two-sided | `merge -s resolve t` | 2 local:dirty, no strategy line; nothing |
| Q32 | `dirty` staged | `merge --no-commit -s resolve t` | 2 `Merge with strategy resolve failed`; snapshot |

### TDD steps

1. RED — merge.test.ts, one `it` per strategy family: a staged change with one `ort` → snapshot written, then
   `WORKING_TREE_DIRTY` with the staged path; with `ours` → `MERGE_STRATEGY_FAILED`; with octopus (two heads) →
   `MERGE_STRATEGY_FAILED` naming `octopus`; with `-s ort -s ours` → `NO_MERGE_STRATEGY_HANDLED`; on the trivial
   branch → `WORKING_TREE_DIRTY` and no snapshot. Fails: `refuseDirtyIndex` refuses before any snapshot for every list.
2. GREEN — move the check into the attempts.
3. RED — interop rows above (Q21, Q31 GUARD).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/merge.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/merge.ts test/unit/application/commands/merge.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts && npm run check:spelling`

### Commit

`fix(merge): fail each strategy on a staged change after the snapshot instead of refusing up front`

## Part 20 — The empty-commit policy file and `rewritten-list` as git writes them

### Context

Files this part edits:
- `src/application/commands/internal/rebase-state.ts` — `RebaseStop` (:60), `RescheduledPick` (:100),
  `writeRebaseStop` (:156; `rewritten-list` :173, `drop_redundant_commits` :175), `writeRescheduledPick` (:191;
  :206), the header comment (:11).
- `src/application/commands/rebase.ts` — `ReplayContext` (:444), `startReplay` (:784), `InteractiveContext`
  (:1320), `rebaseRunInteractive` (:1675), forwarders `persistStop` (:462), `persistInteractiveStop` (:1348),
  `refuseDirtyIndexBeforeFirstPick` (:601).
- `test/unit/application/commands/internal/rebase-state.test.ts` (:173 marker files; :285, :334 reschedule list),
  `test/unit/application/commands/rebase.test.ts` (:734 flat dirty-index reschedule keeps the file),
  `test/integration/rebase-interop.test.ts` (`MARKERS` / `markersOf` :789-791, `gitRebaseOntoMain` :792).

New behaviour (design P12; RC13):

```ts
export type RedundantCommitPolicy = 'drop' | 'stop';
// RebaseStop and RescheduledPick gain:
readonly redundantCommits?: RedundantCommitPolicy;   // set on a start only; unset on a resume = file left as is
// writeRebaseStop / writeRescheduledPick:
if (stop.redundantCommits === 'drop') await write('drop_redundant_commits', '');
if (stop.rewritten.length > 0) await write('rewritten-list', serializeRewritten(stop.rewritten)); // writeRebaseStop
```
`ReplayContext.redundantCommits` = `'drop'` in `startReplay` only (next to `backupHeader`);
`InteractiveContext.redundantCommits` = `'stop'` in `rebaseRunInteractive` only. Contexts built on `--continue` /
`--skip` leave it unset. The three forwarders pass it. tsgit never writes or removes `keep_redundant_commits`.
`readRewrittenList` already reads a missing file as `[]`. Not changed: how a pick made empty replays (OS5,
ADR-1086). Generalise `markersOf` into a sorted rebase-merge/ listing helper and compare it between the tools.

Pinned rows (A.5 E; E14/E15 are reschedules and land in Parts 22/23):

| row | setup → command | rebase-merge/ at the stop (pinned) | continue (pinned) |
|---|---|---|---|
| E1 | `rebase u` (flat), conflict stop on `W` | stop files + `drop_redundant_commits`; no `rewritten-list` | 0, `E` dropped: `Y W U base` |
| E6 | `rebase -i u`, every line `pick`, conflict stop on `W` | stop files only; no `rewritten-list` | exit 1, stopped on `E` |
| E6b | `rebase -i u`, `edit W`, stopped on `W`; amend; continue | stop files only | exit 1, stopped on `E` |
| E12 | tsgit main `rebase.run({ upstream: 'u' })` (flat), conflict stop on `W` | stop files + `drop_redundant_commits` + `rewritten-list` (empty) | — |
| E13 | tsgit main `rebase.run({ upstream: 'u', interactive: [pick W, pick E, pick Y] })`, conflict stop on `W`; resolved; **git** `rebase --continue` | as E12 | 0, `E` dropped: `Y W U base`. Control (same state, `drop_redundant_commits` removed): exit 1, stopped on `E`, as E6 |

### TDD steps

1. RED — rebase-state.test.ts: `writeRebaseStop` with `redundantCommits: 'drop'` writes the file, with `'stop'` does
   not, with it unset leaves an existing file untouched; an empty `rewritten` writes no `rewritten-list`, a non-empty
   one writes it; the same three policy rows for `writeRescheduledPick`. Fails: both writers write
   `drop_redundant_commits` unconditionally and `rewritten-list` always.
2. GREEN — the writers. Update the :173 / :285 / :334 rows' expected file lists to the pinned bytes (they encoded the
   old unconditional writes).
3. RED — rebase.test.ts: a flat start stop has `drop_redundant_commits`, an interactive start stop does not, a resumed
   stop rewrites no policy file (seed the file, continue, assert it unchanged). Fails: every stop writes it.
4. GREEN — the contexts and forwarders.
5. RED — interop rows above (E1, E6, E6b: each tool starts its own rebase, compare listings; E13 cross-tool: a tsgit
   `rebase -i` conflict stop resolved and finished by `git rebase --continue` stops on the emptied `E` as from E6).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/internal/rebase-state.test.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/rebase-state.ts src/application/commands/rebase.ts test/unit/application/commands/internal/rebase-state.test.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:spelling`

### Commit

`fix(rebase): write the empty-commit policy file only on a flat start and rewritten-list once non-empty`

## Part 21 — A replay refusal is a typed outcome

### Context

Files this part edits:
- `src/application/commands/internal/reset-worktree.ts` — `CheckoutOutcome`, `attemptCheckoutWorktreeToCommit`;
  `checkoutWorktreeToCommit` (Part 12) becomes its throwing wrapper. `WorktreeRefusal` exists (Part 11).
- `src/application/commands/internal/rebase-merges-steps.ts` — `MergeTreesOutcome` (:118) + `mergeIntoLockedIndex`
  (:151-152 returns `refused` instead of throwing), `mergeLabelInto` (:204) throws on `refused` and returns
  `Exclude<MergeTreesOutcome, WorktreeRefusal>`.
- `src/application/commands/rebase.ts` — `ReplayOutcome` (:191), `LineOutcome` (:544), `replayOne` (:375),
  `fastForwardOnto` (:1142) → `FastForwardOutcome`, `Step` / `Produced` (:1191 / :1196), `produceOnto` (:1202),
  `stepPick` / `stepEdit` / `stepReword` (:1228 / :1246 / :1270), `meldGroupMember` (:1431) → `MeldOutcome`,
  `replayFrom` (:623), `replayStep` (:1620), `replayMeld` (:1570).
- `test/unit/application/commands/internal/reset-worktree.test.ts`,
  `test/unit/application/commands/internal/rebase-merges-steps.test.ts`, `test/unit/application/commands/rebase.test.ts`.

The design's union table (P11), verbatim:

| union | member added | producer that now returns `refused` |
|---|---|---|
| `MergeTreesOutcome` | `WorktreeRefusal` | `mergeIntoLockedIndex`: `return { kind: 'refused', localChanges, untracked }` replaces `throw workingTreeDirty(…)` |
| `CheckoutOutcome` (new) = `{ kind: 'checked-out' } \| WorktreeRefusal` | — | `attemptCheckoutWorktreeToCommit`: the unforced two-way checkout returns the refusal before HEAD moves |
| `FastForwardOutcome` (new) = `{ kind: 'moved' } \| WorktreeRefusal` | — | `fastForwardOnto(ctx, target, reflog)`: checkout first, HEAD only on `checked-out` |
| `ReplayOutcome` (and `LineOutcome`) | `WorktreeRefusal` | `replayOne`: its fast-forward arm and its merge arm pass the refusal up |
| `Produced` | `WorktreeRefusal` | `produceOnto`: fast-forward and merge arms |
| `Step` | `WorktreeRefusal` | `stepPick` / `stepEdit` / `stepReword`: `if (produced.kind !== 'committed') return produced;` |
| `MeldOutcome` (new name for `meldGroupMember`'s inline return) | `WorktreeRefusal` | `meldGroupMember` |

- Flat fast-forward: `replayOne` calls `fastForwardOnto` (reflog `rebaseFastForwardReflog(reflogAction)`; the
  interactive loop passes `REBASE_FAST_FORWARD`) through a helper `fastForwardReplayed` (→ `ReplayOutcome` with
  `id`); `produceOnto` through `fastForwardProduced` (→ `Produced` with `created`). `fastForwardHead` stays for
  `recreateMerge` only.
- Pass-through: `replayOne`, `produceOnto`, `meldGroupMember` replace their conflict line with
  `if (outcome.kind !== 'clean') return outcome;`; `mergeUnderLock`, `replayLine`, `stepInstruction` return the union
  unchanged.
- Loop consumers IN THIS PART: `replayFrom`, `replayStep` and `replayMeld` turn a `refused` into
  `throw workingTreeDirty({ localChanges, untracked })` — main's public behaviour, unchanged. Parts 22–24 replace
  those three throws with the reschedule. `replayFrom`'s per-line handling moves to `advanceFlat`, an exhaustive
  `switch (outcome.kind)`, so `replayFrom` stays < 20 lines.

### TDD steps

1. RED — reset-worktree.test.ts: `attemptCheckoutWorktreeToCommit` returns `refused` with the paths and writes
   nothing; `checkoutWorktreeToCommit` throws the same data. Fails: no `attempt…` function.
2. GREEN — reset-worktree.ts.
3. RED — rebase-merges-steps.test.ts: `mergeTreesUnderLock` returns `{ kind: 'refused', localChanges, untracked }`
   with both classes and leaves the index unlocked (the existing refusal row, now an outcome); a `merge -C` line still
   throws `WORKING_TREE_DIRTY` through `mergeLabelInto`. Fails: it throws.
4. GREEN — rebase-merges-steps.ts.
5. GREEN — the unions, helpers and loop throws in rebase.ts (no new RED: the public refusal data is unchanged,
   which step 6 guards).
6. GUARD — whole rebase.test.ts and test/integration/rebase-interop.test.ts green (public behaviour unchanged).

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/internal/reset-worktree.test.ts test/unit/application/commands/internal/rebase-merges-steps.test.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/reset-worktree.ts src/application/commands/internal/rebase-merges-steps.ts src/application/commands/rebase.ts test/unit/application/commands/internal/reset-worktree.test.ts test/unit/application/commands/internal/rebase-merges-steps.test.ts test/unit/application/commands/rebase.test.ts && npm run check:spelling`

### Commit

`fix(rebase): return an occupant refusal as a typed replay outcome and fast-forward without overwriting`

## Part 22 — A refused flat-rebase line is rescheduled

### Context

Files this part edits:
- `src/application/commands/internal/rebase-state.ts` — `RescheduledPick` (:100), `writeRescheduledPick` (:191),
  `writeStopMarkers` (:214), `readRebaseProgress` (:280).
- `src/application/commands/rebase.ts` — `RefusedLine`, `RescheduleSides`, `refuseRescheduled`, `refuseFlatLine`,
  `advanceFlat` (Part 21), `continueRescheduled` / `retryRescheduledPick` / `skipRescheduled` (:850-877).
- `test/unit/application/commands/internal/rebase-state.test.ts`, `test/unit/application/commands/rebase.test.ts`
  (`seedStagedGitlink` and the reschedule file-list row :722; `describe('rebase over a rescheduled pick with two
  picks')` :3808), `test/integration/rebase-interop.test.ts`.

New behaviour (design P11 "Writer", "Loops", "Detection", "Retry"; ADR-1083/1084):
- `RescheduledPick` gains optional `stoppedAuthor`, `rewritten`, `meld` (`currentFixups`, `rewrittenPending`,
  `messageSquash`, `messageFixup`); `redundantCommits` exists (Part 20). Without them the dirty-index reschedule keeps
  today's bytes (its pinned unit row has no `author-script` and no `rewritten-list`). `writeRescheduledPick` writes
  `author-script` (`serializeAuthorScript`) when `stoppedAuthor` is set, `rewritten-list` only when `rewritten` is
  non-empty, the meld files through `writeStopMarkers` (which also removes `amend`; widen its parameter to the marker
  fields both shapes share), and REMOVES `message`, `patch`, `stopped-sha` (files a previous stop left). It rewrites
  `head-name`, `onto`, `orig-head`, `interactive`, `no-reschedule-failed-exec` with the same bytes; the backup only
  when `backupHeader` is set.
- Detection (DC11 (a)): `readRebaseProgress` sets `rescheduled` when `message` is absent (not `author-script`).
- `refuseRescheduled(ctx, run, line, refusal): Promise<never>` writes the reschedule (`headName: run.branch ??
  'detached HEAD'`, `onto`, `origHead`, `backupHeader`, `redundantCommits`, `...line` with `line.commit` →
  `pickSha`, `line.author` → `stoppedAuthor`) then throws `workingTreeDirty(refusal)` (main's data).
  `RefusedLine = { done: doneBefore + todo[0..index] (refused line last); remaining: todo[index..]; commit; author;
  rewritten; meld? }`. `refuseFlatLine` builds it from `rc.todo[i]` with the loop's `rewritten`.
- Retry: `continueRescheduled` / `skipRescheduled` seed `rewritten` from `readRewrittenList` (as `rebaseSkip`
  :968 does) instead of `[]`; `doneBefore` = the `done` read from disk (already ends with the refused line), so the
  retry appends it once more. The staged-change refusal of `continueRescheduled` (`end` re-counted) is unchanged.
  `--skip` runs the protected reset (Part 10) first. Interactive dispatch is Part 23.
- A fast-forward refused before HEAD moves: HEAD stays at W and `rewritten-list` records `W W` (F2).

Pinned rows (A.5 R flat rows and E14):

| row | setup → command | git 2.55 (pinned) |
|---|---|---|
| N | `rebase u` (flat), `W` conflicts on `keep`; resolved and staged; `n=occ`; `rebase --continue` | exit 1 untracked:n after committing W'. `done` = `pick W; pick X`. Todo = `pick X`. `end` 2, `msgnum` 2. `rewritten-list` = `W W'`. Files as R1 plus `drop_redundant_commits`. Then `rm n` + `--skip`: 0, c5eb286 |
| S | `n=occ` before a flat `rebase u` (`X` adds `n`, `Z` deletes it) | exit 1 untracked:n. HEAD = W'. `done` = `pick W; pick X`. Todo = `pick X; pick Z`. `end` 3, `msgnum` 2. `rewritten-list` = `W W'`. Then `rm n` + `--continue`: 0 |
| F2 | flat `rebase --onto W base`, `main` = `W`, `X` (adds `n`), `Z` (deletes `n`); `n=occ` (`W` replays empty and is dropped, `X` would fast-forward) | exit 1 untracked:n. HEAD = W. `done` = `pick W; pick X`. Todo = `pick X; pick Z`. `end` 3, `msgnum` 2. `rewritten-list` = `W W`. Files as R1 plus `drop_redundant_commits` |

| row | setup → command | rebase-merge/ at the stop (pinned) | continue (pinned) |
|---|---|---|---|
| E14 | `n=occ` before a flat `rebase u` (`X` adds `n`, `Z` deletes it): reschedule at the start (S's shape) | `author-script done drop_redundant_commits end git-rebase-todo git-rebase-todo.backup head-name interactive msgnum no-reschedule-failed-exec onto orig-head rewritten-list` | — |

Common to every R row (A.5 R preamble): every git refusal prints "The following untracked working tree files would
be overwritten by merge: n" and exits 1; a git reschedule never leaves `amend`, `message`, `patch`, `stopped-sha`,
`MERGE_MSG` or `AUTO_MERGE`. History: `base` (`keep`); `u` = `U` (`uu`) on `base`; `main` = `W` (`w`), `X` (adds `n`),
then `Y` (`y`) or `Z` (deletes `n`); the occupant is an untracked `n=occ`. Rows compare `done`, `git-rebase-todo`,
`end`, `msgnum`, `author-script`, `rewritten-list` byte for byte (oids full in the test, cut to 7 in the pin), the
rebase-merge/ file list, `REBASE_HEAD`, HEAD, work tree and index; then run the follow-up and compare the end state
(HEAD oid with pinned dates, branch, history).

### TDD steps

1. RED — rebase-state.test.ts: `writeRescheduledPick` with and without `stoppedAuthor`; with an empty and a non-empty
   `rewritten`; with meld files; removing a seeded `amend` / `message` / `patch` / `stopped-sha`;
   `readRebaseProgress` on a stop (`rescheduled: false`), a dirty-index reschedule and an occupant reschedule (both
   `true`). Fails: the writer ignores the new fields and removes nothing; detection keys on `author-script`.
2. GREEN — rebase-state.ts.
3. RED — rebase.test.ts: a flat start refused at the second pick writes the reschedule (one `it` per written and per
   removed file) and throws `WORKING_TREE_DIRTY` with `untracked: [n]`; a refusal after a successful pick records
   that pick's rewrite; the retry seeds `rewritten` from `rewritten-list`; a second refusal appends the line to `done`
   once more; a flat fast-forward refusal leaves HEAD unmoved and writes `W W`. Fails: the throw leaves no
   `rebase-merge/` (start) or the previous stop's files.
4. GREEN — `refuseRescheduled`, `refuseFlatLine` in `advanceFlat`, the retry seeding.
5. RED — interop rows above.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/internal/rebase-state.test.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/rebase-state.ts src/application/commands/rebase.ts test/unit/application/commands/internal/rebase-state.test.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:spelling`

### Commit

`fix(rebase): reschedule a flat-rebase line an untracked occupant refuses, as git does`

## Part 23 — A refused interactive line is rescheduled

### Context

Files this part edits:
- `src/application/commands/rebase.ts` — `replayStep` (:1620) `refused` → `refuseInteractiveLine`;
  `continueRescheduled` / `skipRescheduled` dispatch on `isInteractiveState` (:1722).
- `test/unit/application/commands/rebase.test.ts`, `test/integration/rebase-interop.test.ts` (the "Given an edit
  stop" describe :711 runs each tool's own `rebase -i`; add `describe('Given a rebase line refused by an untracked
  occupant')`).

New behaviour (design P11 "Loops", "Retry"): `refuseInteractiveLine(ctx, line, replay, refusal)` reschedules at
`ic.todo[i]` with `replay.rewritten` through Part 22's `refuseRescheduled` (author = the refused commit's author:
V pins Xavier's `GIT_AUTHOR_DATE='@1700000500 +0000'`). Retry dispatch: an interactive state (`isInteractiveState`)
replays through `replayInteractive` with an `InteractiveContext` built as `rebaseContinueInteractive` (:1735)
builds it (`commitEntries(done)` / `commitEntries(remaining)`), seeded with `readRewrittenList`; a flat state keeps
`replayFrom`. `--skip` of a rescheduled interactive line runs the protected reset first (Part 10), so U1b refuses and
keeps the state.

Pinned rows:

| row | setup → command | git 2.55 (pinned) |
|---|---|---|
| R1 | `rebase -i u`, todo `edit W; pick X; pick Y`, stopped on `W`; `n=occ`; `rebase --continue` | exit 1 untracked:n. HEAD = W' detached. `REBASE_HEAD` = X. Files: `author-script done end git-rebase-todo git-rebase-todo.backup head-name interactive msgnum no-reschedule-failed-exec onto orig-head rewritten-list`. `done` = `edit W; pick X`. Todo = `pick X; pick Y`. `end` 3, `msgnum` 2. `rewritten-list` = `W W'` |
| R1 → | `rm n`; `rebase --skip` | 0: `X`, `Y` replayed on W', branch at 88371f8 |
| R2 | R1's refusal; `rm n`; `rebase --continue` | 0, 88371f8 |
| R3 | R1's refusal, occupant kept; `rebase --continue` | exit 1 untracked:n. `done` = `edit W; pick X; pick X`. Todo unchanged. `end` 4, `msgnum` 3. The rest as R1 |
| R4 | R1's refusal, occupant kept; `rebase --skip` | as R3 |
| M | todo `edit W; pick X; pick Y` with `Y` adding `n` (no `Z`); `n=occ` at the stop; `rebase --continue` | exit 1 untracked:n. HEAD = X'. `done` = `edit W; pick X; pick Y`. Todo = `pick Y`. `end` 3, `msgnum` 3. `rewritten-list` = `W W'; X X'`. Then `rm n` + `--continue`: 0, history `Y; X; W; U; base` |
| T | M's refusal; `rm n`; `z` staged; `rebase --continue` | exit 1 "you have staged changes in your working tree". `end` 4 (re-counted), the rest kept |
| F | `rebase -i base`, todo `edit W; pick X; pick Y` (`W` fast-forwarded, HEAD = W); `n=occ`; `rebase --continue` (`X` would fast-forward) | exit 1 untracked:n. HEAD = W. `done` = `edit W; pick X`. Todo = `pick X; pick Y`. `rewritten-list` = `W W` |
| V | `n=occ` before `rebase -i u`, todo `pick W; <verb> X; pick Z`, `X` by Xavier | every verb (`pick`, `edit`, `reword`, `squash`, `fixup`): exit 1 untracked:n. HEAD = W'. `REBASE_HEAD` = X. `<verb> X` ends `done` and heads the todo. `author-script` = Xavier's (`GIT_AUTHOR_DATE='@1700000500 +0000'`). `end` 3, `msgnum` 2. `pick` / `edit` / `reword`: `rewritten-list` = `W W'`. `squash` / `fixup`: no `rewritten-list`, but `current-fixups` = `<verb> X`, `rewritten-pending` = W, `message-squash` (squash: W's and X's messages; fixup: W's); fixup adds `message-fixup` (W's). `rm n` + `--continue`: 0 (`edit`: stops on `edit X`) |

| row | stop, then occupant | command | git 2.55 (pinned) |
|---|---|---|---|
| U1b | rescheduled pick (A.5 R1: todo and `done` both carry `pick X`); `rm n`, `git rm keep`, then keep/u | `rebase --skip` | 128 lose-untracked:keep; state kept |
| U1b | same; `rm n`, `git rm --cached f`, `f=occ` | `rebase --skip` | 128 untracked:f; state kept |
| U1b | same; `rm n` | `rebase --skip` | 0; `X` re-picked (`n=n`), finished |

| row | setup → command | rebase-merge/ at the stop (pinned) | continue (pinned) |
|---|---|---|---|
| E15 | the same before `rebase -i u` (every line `pick`) | E14 without `drop_redundant_commits` | — |

V in this part covers `pick`, `edit` and `reword` (tsgit's `reword` needs its message input — pass one; git's row
used the editor-free default); `squash` / `fixup` land in Part 24.

### TDD steps

1. RED — rebase.test.ts: an interactive continue refused at `pick X` writes the reschedule (R1 bytes: `done` =
   `edit W; pick X`, todo `pick X; pick Y`, `end` 3, `msgnum` 2, `rewritten-list` `W W'`, `REBASE_HEAD` X) and
   throws; an interactive start refused (V `pick`/`edit`/`reword`) writes it; a fast-forwarded interactive pick (F)
   refuses before HEAD moves. Fails: the throw leaves the `edit` stop's files / no `rebase-merge/`.
2. GREEN — `refuseInteractiveLine` in `replayStep`.
3. RED — rebase.test.ts: the retry of an interactive reschedule goes through the interactive loop (an `edit` line
   after the retried pick stops for editing), and a staged change still refuses the retry with `end` re-counted.
   Fails: `retryRescheduledPick` always replays flat.
4. GREEN — the dispatch.
5. RED — interop rows above.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/rebase.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:spelling`

### Commit

`fix(rebase): reschedule an interactive-rebase line an untracked occupant refuses, as git does`

## Part 24 — A refused meld member is rescheduled; api.json

### Context

Files this part edits:
- `src/application/commands/rebase.ts` — `replayMeld` (:1570) `refused` → `refuseInteractiveLine` with the group's
  files; the retry's meld-group reopen (`meldGroupFrom` :1527 is the fresh-group builder).
- `test/unit/application/commands/rebase.test.ts`, `test/integration/rebase-interop.test.ts` — V `squash` / `fixup`.
- `reports/api.json` — regenerated (public options of Parts 5 and 7: ADR-1077, ADR-1081).

New behaviour (design P11 "Loops", "Retry"): inside an open meld group the reschedule carries the group's files
instead of `rewritten-list`, shaped by `meldStopFields` (:1594): `current-fixups` lists the group with the refused
member, `rewritten-pending` the group's sources, `message-squash` the template with the member's message (squash),
and `message-fixup` the base message (fixup-only group); no `amend`, no `rewritten-list` (V squash and fixup).
Retry: a rescheduled meld member reopens its group from `current-fixups` minus that member (members' messages read
from their commits, `skip` for fixups), `pending` from `rewritten-pending`, `baseMessage` from the first pending
commit's message — so the retry adds the member back once. The V rows check the group files against git's bytes at
the refusal (A.5 R pins `rewritten-pending` = W) and after the retry.

Pinned rows: the V row of Part 23's table, for the `squash` and `fixup` verbs.

| row | setup → command | git 2.55 (pinned) |
|---|---|---|
| V | `n=occ` before `rebase -i u`, todo `pick W; <verb> X; pick Z`, `X` by Xavier | every verb (`pick`, `edit`, `reword`, `squash`, `fixup`): exit 1 untracked:n. HEAD = W'. `REBASE_HEAD` = X. `<verb> X` ends `done` and heads the todo. `author-script` = Xavier's (`GIT_AUTHOR_DATE='@1700000500 +0000'`). `end` 3, `msgnum` 2. `pick` / `edit` / `reword`: `rewritten-list` = `W W'`. `squash` / `fixup`: no `rewritten-list`, but `current-fixups` = `<verb> X`, `rewritten-pending` = W, `message-squash` (squash: W's and X's messages; fixup: W's); fixup adds `message-fixup` (W's). `rm n` + `--continue`: 0 (`edit`: stops on `edit X`) |

api.json: `npx typedoc --json reports/api.json --disableSources --out reports/api-tmp && rm -rf reports/api-tmp`
(the typedoc-id diff is large and normal). It is a prepush gate (`check:doc-typedoc`), not a validate gate: commit
the regenerated file with this part.

### TDD steps

1. RED — rebase.test.ts: a squash member refused writes `current-fixups` (with the member), `rewritten-pending`,
   `message-squash`, no `rewritten-list`, no `amend`; a fixup-only group also writes `message-fixup`; the retry
   reopens the group and the finished history equals a run with no refusal. Fails: `replayMeld` throws with the
   previous stop's files.
2. GREEN — `replayMeld` + the reopen.
3. RED — interop V squash/fixup rows.
4. GREEN — regenerate `reports/api.json`; GUARD — `git diff --no-ext-diff --stat reports/api.json` shows the
   `ignoredOccupants`, `untrackedOccupants`, `unmergedPaths` members.

### Gate

`PATH="<git-2.55-bin>:$PATH" npx vitest run test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/rebase.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts && npm run check:spelling`

### Commit

`fix(rebase): reschedule a squash or fixup member an untracked occupant refuses, as git does`
