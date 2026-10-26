# Plan — forced-checkout-same-commit

> Source: design doc `docs/design/forced-checkout-same-commit.md` · ADRs 1087, 1088, 1089, 1090, 1091, 1092, 1093, 1094, 1095
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

## Conventions every part follows

Read this section before your part. It is the shared context the part blocks do not repeat.

- Work only in the worktree root (the directory holding this plan). Commands are repo-relative.
- Interop tests must resolve `git` to 2.55.0: prefix every vitest run that touches an interop file with
  `PATH="$HOME/.local/git-2.55.0/bin:$PATH"` (the machine default is 2.56). The interop helpers
  (test/integration/interop-helpers.ts: makePeerPair, initBothRepos, runGit, tryRunGitWithExit, git,
  lsStage, topReflogSubject, GIT_AVAILABLE) already scrub every GIT_* variable (SAFE_ENV) and fixtures
  commit through COMMIT_ENV (fixed Ada identity and dates). Signing stays off. No new suite asserts
  `git --version` (no house precedent; see DC-D).
- Peer pairs are built with git plumbing in both repositories (test/integration/occupant-displacement-fixtures.ts:
  commitOn, buildHistory, KEEP, v1, link1, gitlink, regular, symlink, the Occupant planters, listing,
  indexState). Racy entries are avoided without sleeping: after the history is built, back-date every work
  file (utimesSync to now − 10 s) and run `git update-index --refresh` in both peers, then plant the shape
  (helper settleIndex, added in Part 3).
- Every part is RED-first, one RED per function or per interop row, each run before the code that satisfies
  it; a REFACTOR never changes behaviour. A test that already passes at its step is a GUARD and must cite the
  row or test that proves it (a design Appendix A row, or an existing test file:line). Never write a GUARD
  that encodes an unpinned tsgit claim.
- Interop rows compare tsgit to git, never to a hand-written expectation, except refusal data that git
  renders as text: reconstruct git's bytes from tsgit's structured fields (ADR-249) and compare.
- Lesson 017: a test whose expectation keeps an occupant, refuses or crashes must first be reproduced through
  the public command against git 2.55 (the Appendix A rows already pin the ones this plan asks for).
- Test conventions: describe('Given …') > describe('When …') > it('Then …'), AAA section comments, the
  system under test is `sut`, memory adapter for unit tests (createMemoryContext from
  src/adapters/memory/memory-adapter.ts), MemoryHookRunner (src/adapters/memory/memory-hook-runner.ts,
  `.calls`) to observe hooks, `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime` to move the
  memory adapter's mtime clock (pattern: test/unit/application/commands/stash-pool.test.ts:19-38, :122).
  Error assertions read `err.data` through try/catch, never a bare `toThrow(Class)`.
- No provenance refs (phase, ADR, backlog, design-row ids) in source or test code or titles; describe the
  behaviour instead. No suppression directives of any kind. No swallowed errors. Functions under 20 lines,
  nesting ≤ 2, named constants, no boolean parameters — refuse those smells in code you touch.
- Every new export in this plan is INTERNAL (consumed only inside src/). No new public symbol, error code,
  command or option. The one public surface touched is the TSDoc of `MaterializeTreeOpts.forceRewriteAll`
  and `MaterializeTreeResult.written` (Part 2): reports/api.json embeds that text (reports/api.json:110829),
  so Part 2 regenerates it with `npm run docs:json` and commits it (prepush `check:doc-typedoc` gate).
- Lesson 015 family run (every interop file that drives checkout, reset, stash push or rebase/merge
  abort/skip — 43 files at plan time; report the count you ran):
  `PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run $(grep -lE '\.checkout\(|reset\(\{|stash\.push|stashPush|\.abort\(|\.skip\(' test/integration/*.test.ts) > "${TMPDIR:-/tmp}/forced-checkout-family.log" 2>&1 || { tail -n 80 "${TMPDIR:-/tmp}/forced-checkout-family.log"; false; }; tail -n 8 "${TMPDIR:-/tmp}/forced-checkout-family.log"`
  (a red run exits non-zero; never commit on it).
- Size caps have under 100 B of headroom. Every part with a src delta runs
  `rm -rf dist .wireit && npm run check:size && npm run check:tarball` and, when a row fails, raises that
  row's cap in .size-limit.json (or the tarball budget the failing script names) by the measured overshoot
  rounded up to the next 0.1 kB, reading every failing row, in the same commit.
- Long outputs go to a file under `${TMPDIR:-/tmp}` and are read back with tail/grep.
- Commit: `git commit -m "<message>"` with the exact message in the part's Commit block, after the gate is
  green. Stage only the part's files (plus reports/api.json or .size-limit.json when its gate says so).
- User docs (docs/use/commands/checkout.md, reset.md, stash.md) are NOT edited by any part: the
  documentation phase owns them (see the handoff section at the end).
- check:spelling is red at plan time on this branch: the design doc and ADR-1087 carry four words cspell does
  not know (list them with `npx cspell --no-progress --words-only --unique docs/design/forced-checkout-same-commit.md "docs/adr/108*.md"`).
  Part 1 folds the fix: add those words to the `words` array of cspell.json (alphabetical position) and stage
  it with Part 1's commit.
- Blocker protocol: `{ unit, reason, ≤3 options }` — never spin, never guess.
- Files shared across parts are intentional (plan-lint overlap warnings): checkout.ts, stash.ts, reset.ts and
  materialize-tree.ts each host several independently pinned git behaviours (stale pass vs flag carry, forced
  switch vs HEAD stay vs refresh vs path-restore refusal, stash refresh vs ref tail vs hook vs gate). Merging
  them would exceed the 5-cycle / 6-file ceiling and couple the conditional Part 11 to unconditional work.
  Each part edits a distinct function or region named in its Context block.

## Part 1 — share git's index-stat judge without an import cycle

### Context

Goal (ADR-1088, design P1 first bullet): the stale-entry pass of Part 2 and the occupant check must use ONE
`ie_match_stat` judge. Today it is private to occupant-clash. Pure refactor: no behaviour change.

Files this part edits:
- `src/application/primitives/internal/is-entry-stat-clean.ts` — gains the judge.
- `src/application/primitives/internal/occupant-clash.ts` — loses it, imports it back.
- `src/application/primitives/compare-working-tree-entry.ts` — gains the racy content-check factory.
- `test/unit/application/primitives/internal/is-entry-stat-clean.test.ts` — direct rows for the moved judge.
- `test/unit/application/primitives/compare-working-tree-entry.test.ts` — rows for the factory.

What moves (occupant-clash.ts today):
- :139 `const UNREACHABLE = Symbol('unreachable')`
- :141-152 `lstatBeyondLink(ctx, absPath): Promise<FileStat | undefined | typeof UNREACHABLE>` — lstatIfPresent
  (internal/fs-probes.ts), maps errorDataCode(err) === 'NOT_A_DIRECTORY' to UNREACHABLE, rethrows the rest.
- :154-167 `matchesCachedStat(ctx, { entry, indexMtime }: TrackedStat, absPath, stat): Promise<boolean>` —
  deriveWorkingMode(stat) !== entry.mode or !matchesContentStat → false; indexMtime defined and !isRacy → true;
  else buildCheckinAttributeProvider(ctx) + compareFile(…, scopeOf(provider)) → !isWorkingTreeModified(status).
- Consumer: classifyThroughLink, occupant-clash.ts:172-184.

The import-cycle trap (proven at plan time): compare-working-tree-entry.ts:36-40 imports
is-entry-stat-clean.ts (isEntryStatClean, matchesContentStat, IndexMtime). Moving matchesCachedStat verbatim
into is-entry-stat-clean.ts would make it import compareFile/scopeOf/isWorkingTreeModified back from
compare-working-tree-entry.ts — a runtime cycle that .dependency-cruiser.cjs rule `no-circular` (:76-81)
rejects in `npm run check:architecture`. Plan (DC-A, recommended option a): inject the racy branch.

Target shape:

```ts
// is-entry-stat-clean.ts — exported
export const UNREACHABLE = Symbol('unreachable');
export interface CachedStat { readonly entry: IndexEntry; readonly indexMtime: IndexMtime | undefined }
/** Decides a racy, stat-matching entry by its content. */
export type RacyContentCheck = (entry: IndexEntry, absPath: string, stat: FileStat) => Promise<boolean>;
export const lstatBeyondLink = (ctx: Context, absPath: string) => …;          // moved as is
export const matchesCachedStat = async (
  cached: CachedStat, absPath: string, stat: FileStat, contentMatches: RacyContentCheck,
): Promise<boolean> => …;                                                       // ctx no longer needed

// compare-working-tree-entry.ts — exported
/** git's racy branch of ie_match_stat: content decides, checkin attributes built once per checker. */
export const racyContentMatcher = (ctx: Context): RacyContentCheck => {
  const provider = lazily(() => buildCheckinAttributeProvider(ctx));
  return async (entry, absPath, stat) =>
    !isWorkingTreeModified((await compareFile(ctx, entry, absPath, stat, scopeOf(await provider()))).status);
};
```

- lazily lives in src/application/primitives/internal/lazily.ts; buildCheckinAttributeProvider in
  internal/read-gitattributes.ts:339 (read-gitattributes does not import compare-working-tree-entry: no cycle).
- occupant-clash keeps `TrackedStat` exported (its TrackedLookup type uses it); make it
  `export type TrackedStat = CachedStat` so its shape stays identical for callers.
- classifyThroughLink passes `racyContentMatcher(ctx)` per call — the same "one provider per verdict" as today.
- Existing coverage of the judge: test/unit/application/primitives/internal/occupant-clash.test.ts:510-620
  (arrangeTracked helper :518-530, INDEX_WRITTEN_AFTER_ENTRY = { seconds: 4_000_000_000 } :512, racy rows
  :579-620 using { seconds: 0 }). They must stay green untouched.
- Unit fixture to build an entry from a real memory stat: indexEntryFromStat
  (internal/index-entry-from-stat.ts:38) after ctx.fs.lstat.

### TDD steps

Pure refactor: every new test is a GUARD (the code exists, it only moves).
1. GUARD — run test/unit/application/primitives/internal/occupant-clash.test.ts and is-entry-stat-clean.test.ts
   green before touching code (baseline).
2. REFACTOR — move UNREACHABLE, lstatBeyondLink, matchesCachedStat into is-entry-stat-clean.ts with the
   injected RacyContentCheck; add racyContentMatcher to compare-working-tree-entry.ts; occupant-clash imports
   both. Re-run step 1: green (proves no behaviour change).
3. GUARD rows in is-entry-stat-clean.test.ts (module's own suite, needed for narrowed mutation runs), each
   passing because the moved code already implements it (cite occupant-clash.test.ts:532-620 for the same
   verdicts through classifyThroughLink):
   - matchesCachedStat: mode differs → false (contentMatches never called — assert with vi.fn);
     a content-stat field differs → false; non-racy match → true without calling contentMatches;
     racy match → returns contentMatches' verdict (true and false rows); indexMtime undefined → defers to
     contentMatches.
   - lstatBeyondLink: absent path → undefined; a regular file standing as a leading directory →
     UNREACHABLE; a present path → its stat; any other error rethrown (fs stub throwing a non-NOT_A_DIRECTORY
     TsgitError, assert err.data.code).
4. GUARD rows in compare-working-tree-entry.test.ts for racyContentMatcher: equal content → true; differing
   content at the same size → false; two calls build the attribute provider once (spy on the fs read of
   .gitattributes or on readConfig — whichever the existing tests in that file already spy on).
5. REFACTOR — none beyond step 2.

### Gate

```bash
npx vitest run test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts \
  && npm run check:types && npm run check:architecture \
  && ./node_modules/.bin/biome check src/application/primitives/internal/is-entry-stat-clean.ts src/application/primitives/internal/occupant-clash.ts src/application/primitives/compare-working-tree-entry.ts test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts \
  && npm run check:spelling
```
Then the lesson 015 family run (Conventions) — occupant classification is on every checkout/merge/reset path.
Then the size step (Conventions).

### Commit

`refactor(checkout): share git's index-stat judge between the occupant check and its callers`

## Part 2 — `forceRewriteAll` rewrites only stale entries

### Context

Goal (design P1, RC1/RC2; R2, R4; ADR-1087): replace `upgradeNoopsToUpdates` (every noop → update) with git's
one-way merge rule: a noop becomes an update only when its work-tree path is not up to date. This flips
every current `forceRewriteAll` caller at once (reset --hard, path restore from index and from a tree,
stash push's reset, the merge rewind, rebase abort/skip and the rebase-merges reset): clean paths stop
being rewritten. The forced switch gets the option only in Part 4.

Files this part creates or edits:
- `src/application/primitives/internal/stale-entries.ts` (new, internal).
- `test/unit/application/primitives/internal/stale-entries.test.ts` (new).
- `src/application/primitives/materialize-tree.ts`.
- `test/unit/application/primitives/materialize-tree.test.ts`.
- `src/application/commands/internal/reset-worktree.ts` (doc only: module doc :1-4 "with forceRewriteAll so
  dirty / no-op'd paths don't survive" → state git's stale-only rule; the ResetMode pick :26-29 unchanged).
- `test/integration/rebase-reset-interop.test.ts` (RB row).

New module shape:

```ts
/** git's one-way merge: a noop whose work-tree path is not up to date becomes an update. */
export const upgradeStaleNoops = async (
  ctx: Context,
  entries: ReadonlyArray<ChangesetEntry>,
  index: GitIndex,            // plan.indexForDiff: its stage-0 entries carry the cached stat
  workdir: string,
): Promise<ReadonlyArray<ChangesetEntry>>;
```
- One verdict per `noop` through boundedMapFor(ctx, 'ioBound', …) (internal/concurrency.ts:53); input order
  kept. Look up the index entry by indexPathKey (domain/git-index/index-path-key.ts) over stage-0 entries.
- isUpToDate(entry): skip-worktree → true (never judged); isLossy(entry) → true (unaddressable; the apply
  never writes a lossy path, apply-changeset.ts:470); lstatBeyondLink → undefined or UNREACHABLE → false;
  gitlink (FILE_MODE.GITLINK) → stat.isDirectory; else matchesCachedStat({ entry, indexMtime:
  index.indexMtime }, absPath, stat, check) with ONE `racyContentMatcher(ctx)` built per pass (Part 1).
  assumeValid is ignored (matchesCachedStat never reads it).
- Upgraded entries keep previousId/previousMode (the index's), so the displacement wave of #331 runs as is.
- materialize-tree.ts edits: :488-494 becomes computeChangeset → projectUnmergedPaths (when reset) → when
  `forceRewriteAll === true`, `{ entries, stats: tallyStats(entries) }` from upgradeStaleNoops (tallyStats
  :236 stays private there) → apply. Delete upgradeNoopsToUpdates (:290-299). workdir from
  requireWorkTree(ctx, 'materializeTree') (already used at :504) — compute once.
- TSDoc rewrites in materialize-tree.ts (public, embedded in reports/api.json): the stat-source contract
  :14-28 (drop "reset --hard therefore MUST set forceRewriteAll: true so every noop upgrades"; state that an
  up-to-date noop keeps its donor entry and a stale one is rewritten), `forceRewriteAll` :84-95 ("every entry
  whose work-tree stat is not up to date is rewritten even when the index already records the target; an
  up-to-date one is left alone; a skip-worktree entry is never judged"), and `MaterializeTreeResult.written`
  :132 (counts rewrites only).
- Memory adapter facts: lstat follows intermediate symlinks (proven by occupant-clash.test.ts:532-543,
  classifyThroughLink 'clear'); FileStat ino is always 0 and mtime is Date.now() at write; build up-to-date
  entries with indexEntryFromStat(await ctx.fs.lstat(abs), mode, id, path) and an index whose indexMtime is
  { seconds: 4_000_000_000, nanoseconds: 0 } (non-racy); omit indexMtime to force the racy branch.
- Existing materialize-tree.test.ts rows that pin the old semantics (:144-178 "rewritten anyway", :181-215,
  :249-296 progress totals, :1180-1200, :1300-1305): their arranged entries carry a zero stat or no work file,
  so they stay stale and keep passing; retitle :144 and :181 to state "stale" instead of "unconditionally".
- Caller tests that MAY flip because a clean path is no longer rewritten (run them; any flip must be a clean
  path's count or inode, cite design A.1 "C × reset --hard: rewrote —" or A.2 "C × checkout -- f keep: rewrote
  —" in the updated comment; any other flip is a defect → blocker): test/unit/application/commands/checkout.test.ts
  changedPaths rows :343 :494 :802 :840 :937 :1149 :1188 :1213 :1485 :2033 :2051 :2402;
  test/unit/application/commands/reset.test.ts:660 (comment says "re-writes a.txt via forceRewriteAll");
  stash, rebase, merge unit suites. Edit only what flips.
- RB row (design "RB (git only)" + R4): in rebase-reset-interop.test.ts, a stopped rebase (reuse the file's
  pickChangesEntry/rebase setup :87-140) with a clean bystander and a touched bystander (utimesSync +5 s);
  `rebase --abort` on both; compare which of the two bystanders kept its inode+mtime (clean kept, touched
  rewritten in git) and the listing.

### TDD steps

1. RED — materialize-tree.test.ts: "Given an up-to-date noop entry and forceRewriteAll, When materializeTree
   runs, Then nothing is written and the donor entry is kept" (entry from lstat, non-racy indexMtime). Fails
   today: written is 1 and newIndexEntries carries a fresh stat (upgradeNoopsToUpdates).
2. RED — rebase-reset-interop.test.ts RB row. Fails today: tsgit rewrites the clean bystander (new mtime),
   git keeps it.
3. GREEN — stale-entries.ts (ENOENT/UNREACHABLE stale, judge otherwise, one racyContentMatcher per pass) and
   the materialize-tree wiring; delete upgradeNoopsToUpdates. Steps 1-2 green; materialize-tree.test.ts:144
   (edited noop rewritten) stays green as a GUARD.
4. GUARD rows in stale-entries.test.ts, each passing through step 3's code: absent file → update; a regular
   file where a leading directory stands (ENOTDIR) → update; touched file (stat differs) → update; exec-bit
   change → update; assumeValid entry with an edited file → update (assumeValid ignored); racy entry with equal
   content → noop and with different same-size content → update; up-to-date file reached through a leading
   symlink to the moved directory → noop (cite occupant-clash.test.ts:532-543); two racy entries build the
   attribute provider once (spy as in Part 1 step 4).
5. RED — skip-worktree noop with no work file stays noop. Fails after step 3: ENOENT reads stale. GREEN: the
   skip-worktree guard.
6. RED — lossy noop (entry with pathBytes, see materialize-tree.test.ts:1290-1305 for a lossy fixture) stays
   noop. Fails: the decoded path is absent → stale. GREEN: the isLossy guard.
7. RED — gitlink noop with an empty directory at its path stays noop. Fails: matchesCachedStat sees a directory
   mode ≠ 160000 → stale. GREEN: the gitlink rule. Then GUARD: gitlink with a regular file at its path → update.
8. REFACTOR — TSDoc rewrites listed in Context; reset-worktree.ts module doc; retitle the two
   materialize-tree rows; run the whole unit project and fix only clean-path flips (Context list).

### Gate

```bash
npx vitest run --project unit > "${TMPDIR:-/tmp}/forced-checkout-p2-unit.log" 2>&1 || { tail -n 80 "${TMPDIR:-/tmp}/forced-checkout-p2-unit.log"; false; }
npm run check:types && npm run check:architecture && npm run check:dead-code \
  && ./node_modules/.bin/biome check src/application/primitives/internal/stale-entries.ts src/application/primitives/materialize-tree.ts src/application/commands/internal/reset-worktree.ts test/unit/application/primitives/internal/stale-entries.test.ts test/unit/application/primitives/materialize-tree.test.ts test/integration/rebase-reset-interop.test.ts <every caller test you edited> \
  && npm run check:spelling
npm run docs:json   # TSDoc changed: stage reports/api.json in this commit
```
Then the lesson 015 family run (Conventions; it includes rebase-reset-interop.test.ts) and the size step.

### Commit

`fix(reset): rewrite only stale entries on a hard reset, path restore, stash push and rebase reset as git does`

## Part 3 — `reset --hard` keeps assume-unchanged and resets a conflict the target lacks

### Context

Goal (design P2 + P3 reset row; R3, R4, R5; RC3, RC4): a rewritten entry whose id+mode equal the old stage-0
entry keeps the old `assumeValid` flag (git's copy_cache_entry keeps CE_VALID); `reset --hard` resets an
unmerged path to the target (a conflicted path absent from the target is removed). Pins reset --hard against
git across the A.1 shapes. Also lands the interop fixtures every later part reuses.

Files:
- `src/application/primitives/materialize-tree.ts` — pickEntry :209-216 / mergeNewIndexEntries :218-234.
- `test/unit/application/primitives/materialize-tree.test.ts`.
- `src/application/commands/reset.ts` — hardResetFromCommit :153-206: add `unmergedPaths: 'reset'` to the
  materializeTree call :179-193; rewrite the comment :183-186 (git rewrites only stale entries; a dirty
  noop is stale and is rewritten).
- `test/unit/application/commands/reset.test.ts`.
- `test/integration/reset-interop.test.ts` — new describe block (the file's existing rows build ours with
  repo.commit; the new block builds both peers with the plumbing fixtures).
- `test/integration/occupant-displacement-fixtures.ts` — new helpers.

Flag carry shape:

```ts
const pickEntry = (entry, writtenByPath, oldByPath): IndexEntry | undefined => {
  const key = indexPathKey(entry);
  const written = writtenByPath.get(key);
  const old = oldByPath.get(key);
  if (written === undefined) return old;
  return keepsAssumeValid(old, written) ? withAssumeValid(written) : written;
};
// keepsAssumeValid: old?.flags.assumeValid === true && old.id === written.id && old.mode === written.mode
```
IndexEntryFlags / STAGE0_FLAGS: src/domain/git-index/index-entry.ts:4-19. A written entry comes from
indexEntryFromStat with STAGE0_FLAGS (internal/index-entry-from-stat.ts:38-58).

Fixture helpers to add (exported, used by Parts 3-11):
- touchedAt(rel): utimesSync(+5 s). chmodAt(rel): chmod 0o755. linkAt(rel, target): rm then symlinkSync.
  fileWith(rel, content).
- skipWorktreeAt(rel, occupant): `git update-index --skip-worktree rel` then occupant (mirror
  assumingUnchanged :166-171).
- unmergedAt(rel): stages 1-3 (base/ours/theirs blobs via hash-object -w) through
  `git update-index --index-info` (lines `<mode> <oid> <stage>\t<path>`), work file 'conflicted\n'.
  unmergedAbsentAt(rel): stages 2-3 only, for a path absent from HEAD, work file 'conflicted\n'.
- settleIndex(dir): back-date every tracked work file (utimesSync now − 10 s) then
  `git update-index -q --refresh`.
- statSnapshot(dir): Map path → { ino, mtimeMs } over the work tree (no .git); rewrittenPaths(before, after):
  sorted paths present in both whose ino or mtimeMs changed.
- staleEntries(dir): paths whose `git ls-files --debug` ino, size or mtime second differ from lstat.
- modeListing(dir): listing(dir) with an `(+x)` suffix on executable regular files. flagListing(dir):
  `git ls-files -v`.

A.1 shape → planter map (both peers; `tracked` = entries of main besides KEEP; history via buildHistory with
due = tracked + regular('other')):

| shape | tracked | planter |
|---|---|---|
| C | v1 f | none |
| E | v1 f | fileWith f 'edited\n' |
| T | v1 f | touchedAt f |
| M | v1 f | chmodAt f |
| Dw | v1 f | rm f |
| AU | v1 f | assumingUnchanged(f, fileWith f 'edited\n') |
| SW | v1 f | skipWorktreeAt(f, fileWith f 'edited\n') |
| S3a | v1 a/payload | replacing(a/payload, danglingLinkAt a) |
| S3g | v1 a/payload | copiedBehindLink(a, held) |
| S3i | v1 a/payload | movedBehindLink(a, held) |
| S1 | v1 d/x | replacing(d/x, fileAt d) |
| S2 | v1 f | replacing(f, directoryHolding(f, u)) |
| S2e | v1 f | replacing(f, emptyDirectoryAt f) |
| S3b | v1 f | replacing(f, danglingLinkAt f) |
| LF | v1 f, v1 g | linkAt(f, g) |
| S3f | link1 l | replacing(l, fileWith l 't-v1') |
| S3c | link1 l | replacing(l, directoryHolding(l, u)) |
| S3d | link1 d/l | replacing(d/l, fileAt d) |
| LR | link1 l | linkAt(l, elsewhere) |
| GL | gitlink s | none (reset leaves an empty s/) |
| GLf | gitlink s | replacing(s, fileAt s) |
| ST | v1 f | fileWith f 'staged\n' + git add f |
| SA | v1 f | fileWith n 'new\n' + git add n |
| SD | v1 f | git rm -q f |
| SDk | v1 f | git rm -q --cached f |
| U | v1 f | fileWith u 'untracked\n' |
| UM | v1 f | unmergedAt f |
| UMn | v1 f | unmergedAbsentAt n |

Rows planted through `git add` carry a racy entry for the planted path; their verdict comes from the id
change, not the stat.

Reset rows: every shape × `reset --hard HEAD` (git: runGit reset -q --hard HEAD; tsgit:
repo.reset({ mode: 'hard', rev: 'HEAD' })), comparing modeListing, indexState, flagListing, staleEntries and
rewrittenPaths between the tools (design A.1 last two columns are git's outcome). Unit fixture for an unmerged
index in memory: write entries with acquireIndexLock (src/application/primitives/internal/index-lock.ts) and
lock.commit(entries, 'replace'); seedConflictedMerge in test/unit/application/commands/internal/reset-worktree.test.ts:145
shows a merge-built alternative.

### TDD steps

1. RED — materialize-tree.test.ts: "Given an assume-unchanged entry whose file was edited and forceRewriteAll,
   Then the rewritten entry keeps assumeValid". Fails: the written entry carries STAGE0_FLAGS.
2. RED — reset-interop AU row (git keeps `h`, design A.1 AU "flags: git h f ts H f"). Fails for the same reason.
3. GREEN — keepsAssumeValid in pickEntry. GUARDs: an AU entry whose id changes (ST-like update) keeps fresh
   flags; an AU entry whose mode changes keeps fresh flags (both pass: the guard compares id and mode — isolated
   rows, one per condition).
4. RED — reset.test.ts: "Given stages 2-3 of n absent from the target and a work file n, When reset --hard
   HEAD, Then n leaves the work tree and the index". Fails: unmergedPaths defaults to hidden, n survives.
5. RED — reset-interop UMn row (design A.1 UMn: git removes n). Same failure.
6. GREEN — `unmergedPaths: 'reset'` in hardResetFromCommit.
7. GUARD — the remaining reset-interop rows, each passing since Part 2 (cite design A.1 reset columns): C, T,
   E, M, Dw, SW (no rewrite, S flag kept), S3i (link kept), S3a, S3g, S1, S2, S2e, S3b, LF, S3f, S3c, S3d, LR,
   GL, GLf, ST, SA, SD, SDk, U, UM. A row that fails here is a Part 2 defect: fix it in stale-entries.ts only
   if the fix is local, else blocker.
8. REFACTOR — reset.ts comment :183-186; keep pickEntry under 20 lines.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/primitives/materialize-tree.test.ts test/unit/application/commands/reset.test.ts test/integration/reset-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/materialize-tree.ts src/application/commands/reset.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/commands/reset.test.ts test/integration/reset-interop.test.ts test/integration/occupant-displacement-fixtures.ts \
  && npm run check:spelling
```
Then the lesson 015 family run and the size step.

### Commit

`fix(reset): keep the assume-unchanged flag and reset a conflicted path the target lacks as git does`

## Part 4 — a forced switch rewrites every stale entry

### Context

Goal (design P3 checkout row, RC1, RC4; R1, R5; the 32.27 literal shape): the forced switch passes
`forceRewriteAll: true` and `unmergedPaths: 'reset'` so a same-commit or other-commit `checkout -f` rewrites
every stale stage-0 entry, displaces occupants (#331's wave, reused) and drops a conflict the target lacks.
The unforced switch does NOT get the option (git's two-way merge keeps entries HEAD, index and target agree on).

Files:
- `src/application/commands/checkout.ts` — switchBranch :248-322; the materializeTree call :285-293.
- `test/unit/application/commands/checkout-forced-switch.test.ts` (new).
- `test/integration/checkout-forced-same-commit-interop.test.ts` (new; header `@proves` with surface
  repo.checkout, bucket cross-tool-interop, interopSurface checkout — copy the block from
  test/integration/checkout-occupant-displacement-interop.test.ts:1-13).
- `test/integration/checkout-leading-symlink-interop.test.ts` — the `checkout -f HEAD` row :172-200 gains a
  populated-index variant.
- `test/bench/checkout.bench.ts` — two scenarios.

switchBranch is ~75 lines today (smell). REFACTOR it in this part: extract the locked block :275-302 into
`materializeSwitch(ctx, request): Promise<MaterializeResult>` (request carries opts, target id, branchName,
oid, oldOid, matcher) so Parts 5 and 7 edit small functions. The option spread:
`...(opts.force === true ? FORCED_RESET : {})` with
`const FORCED_RESET = { forceRewriteAll: true, unmergedPaths: 'reset' } as const` (named constant).
headTreeOption (:236-246) already returns {} when forced.

Interop rows: `describe.each` over the 28 shapes of Part 3's planter map × five spellings:
`-f HEAD` (repo.checkout({ rev: 'HEAD', force: true })), `-f main`, `-f <main oid>` (rev-parse main on the
peer; plumbing histories are identical), `-f t`, detached `-f HEAD` (both peers first `checkout -q --detach`;
tsgit side via git too, before opening the repo). Order per row: build history → detach (when the spelling
asks) → settleIndex → plant → statSnapshot → run → compare. Per row compare modeListing, indexState, flagListing,
staleEntries, rewrittenPaths. HEAD symref and HEAD reflog (count + topReflogSubject) are compared for `-f main`,
`-f <oid>`, `-f t` only; the two HEAD spellings get them in Part 5. Plant after settleIndex.

Design A.1 outcome classes for the forced spellings (work tree, flags, stale set, rewritten set):
- SAME today (GUARD): C, S3i, GL, ST, SA, SD, SDk, U, UM, SW.
- DIFF today (RED): E, T, M, Dw, AU, S3a, S3g, S1, S2, S2e, S3b, LF, S3f, S3c, S3d, LR, GLf, UMn.

Leading-symlink variant: same arrange as :176-185 but keep the index populated (skip `read-tree --empty`):
git replaces the link `a` with a directory holding payload and leaves the outside directory empty
(design brief, 32.27); tsgit keeps the link today.

Bench (design Performance): add tieredScenario blocks following :48-71 —
'When checkout() forces HEAD on a clean tree, Then measure tsgit' (repo.checkout({ rev: 'HEAD', force: true }))
and 'When reset() hard-resets HEAD on a clean tree, Then measure tsgit' (repo.reset({ mode: 'hard', rev: 'HEAD' })).
Run each once locally to prove it executes; the A/B against main is the validation phase's (DC-F).

### TDD steps

1. RED — checkout-forced-switch.test.ts: "Given a tracked file edited in the work tree, When checkout forces
   the current branch, Then the file is rewritten to the committed content". Fails: every path classifies noop.
2. RED — same file: "Given stages 2-3 of n absent from the target, When checkout forces the current branch,
   Then n leaves the work tree and the index". Fails: unmergedPaths hidden.
3. RED — interop DIFF rows (list above) and the leading-symlink populated-index variant. Fail as design A.1
   tsgit columns show.
4. GREEN — FORCED_RESET spread in the forced path. GUARD: interop SAME rows; unforced switch with an edited file
   whose path HEAD and target agree on keeps the edit (cite design A.2 "E, S3a × unforced: same").
5. REFACTOR — extract materializeSwitch; bench scenarios.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/checkout-forced-switch.test.ts test/unit/application/commands/checkout.test.ts test/integration/checkout-forced-same-commit-interop.test.ts test/integration/checkout-leading-symlink-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/checkout.ts test/unit/application/commands/checkout-forced-switch.test.ts test/integration/checkout-forced-same-commit-interop.test.ts test/integration/checkout-leading-symlink-interop.test.ts test/bench/checkout.bench.ts \
  && npm run check:spelling
```
Then the lesson 015 family run and the size step.

### Commit

`fix(checkout): rewrite every stale entry and reset conflicts on a forced switch as git does`

## Part 5 — a bare `HEAD` or `@` stays on the branch

### Context

Goal (design P4, RC5; R6): `checkout HEAD` / `checkout @`, forced or not, attached or detached, without
`detach` and without `createBranch`, moves no ref and writes no reflog entry; HEAD stays attached. Branch-state
removal and post-checkout (old = new oid, flag '1') still run. `HEAD~0`, `detach: true` and `-b x HEAD` keep
today's behaviour.

Files:
- `src/application/commands/checkout.ts` — switchBranch :248-322 (after Part 4's extraction), moveHead
  :223-230, the result :316-321.
- `test/unit/application/commands/checkout-head-stay.test.ts` (new).
- `test/integration/checkout-forced-same-commit-interop.test.ts`.

Shape:

```ts
/** git's update_refs_for_switch: a bare HEAD name moves nothing. */
const HEAD_SPELLINGS: ReadonlySet<string> = new Set(['HEAD', '@']);
const staysOnHead = (opts: CheckoutSwitchOptions): boolean =>
  HEAD_SPELLINGS.has(opts.rev) && opts.detach !== true && opts.createBranch === undefined;
```
When it holds: skip moveHead; result `branch` = priorHead.target when priorHead.kind === 'symbolic' and it
starts with HEADS_PREFIX (see headCheckoutLabel :192-195), else undefined; `detached` = branch === undefined.
removeBranchState(ctx, 'announce') and runInformationalHook(… [oldOid, oid, BRANCH_FLAG]) unchanged.
Extract the post-materialise tail (:304-321) into `finishSwitch` so switchBranch stays small.
opts.rev is the raw argument (before previousCheckoutArg :170).

Unit observation: readReflog(ctx, 'HEAD') from src/application/primitives/reflog-store.ts:25; readHeadRaw
from internal/repo-state; MemoryHookRunner calls (pattern checkout.test.ts:1609-1626).

Interop rows (design A.2 sets 3-4 and A.1 HEAD table): enable the HEAD symref + reflog comparison on the Part 4
`-f HEAD` and detached `-f HEAD` rows; add C-shape rows for `checkout HEAD` (unforced), `checkout @`,
`checkout -f @`, `checkout HEAD~0`, `checkout --detach HEAD`, `checkout -f --detach HEAD`,
`checkout -b nb HEAD`, detached `checkout HEAD`; set 4: MERGE_HEAD and CHERRY_PICK_HEAD (= HEAD oid),
MERGE_MSG, MERGE_MODE, ORIG_HEAD written into both .git dirs, then `checkout -f HEAD` and `checkout -f main`;
compare which of the five remain (git: only ORIG_HEAD).

### TDD steps

One RED per guard, each run before its line:
1. RED — "Given HEAD on main, When checkout rev HEAD, Then HEAD stays on main and no reflog entry is added".
   Fails: resolveSwitch gives onBranch undefined, so HEAD detaches and moveHead logs.
   RED — "Given a detached HEAD, When checkout rev HEAD, Then no reflog entry is added and the result reports
   branch undefined, detached true". Fails: moveHead logs `checkout: moving from <oid> to HEAD`.
   GREEN — staysOnHead with the HEAD_SPELLINGS check only ({'HEAD'} first), skip moveHead, derive the result
   branch from priorHead.
2. RED — same with rev '@'. Fails: '@' not in the set. GREEN — add '@'.
3. RED — "rev HEAD with detach: true detaches and logs `checkout: moving from main to HEAD`". Fails after step
   1 (stays). GREEN — the detach guard.
4. RED — "rev HEAD with createBranch nb attaches nb and logs `checkout: moving from main to nb`". Fails after
   step 1. GREEN — the createBranch guard.
5. GUARDs — post-checkout fires with [oid, oid, '1'] on a stay; MERGE_HEAD is removed on a stay (cite design
   A.2 set 4 row); HEAD~0 detaches (cite A.2).
6. Interop: RED — `-f HEAD`, `checkout HEAD`, `@`, `-f @`, detached `checkout HEAD` rows (design A.1/A.2 tsgit
   columns differ) — write them before step 1's GREEN; GUARD — HEAD~0, --detach, -f --detach, -b nb, set 4
   state files.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/checkout-head-stay.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/checkout-branch-state.test.ts test/integration/checkout-forced-same-commit-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/checkout.ts test/unit/application/commands/checkout-head-stay.test.ts test/integration/checkout-forced-same-commit-interop.test.ts \
  && npm run check:spelling
```
Then the lesson 015 family run and the size step.

### Commit

`fix(checkout): stay on the branch for a bare HEAD or @ as git does`

## Part 6 — `stash push` opens with git's refresh-and-write step

### Context

Goal (design P7, RC9; R9, R11; ADR-1091 F12, ADR-1092): stashPush first runs git's refresh_and_write_cache —
lock, read, refuse an unmerged index with MERGE_HAS_CONFLICTS { count, paths }, refresh stat-dirty
content-clean entries, write the index only when something refreshed — before the pending-operation gate and
before any object, ref or reflog write. Even "no local changes" refreshes (A.2 T × stash push).
Ordered before Part 7 because it creates the shared refresh module.

Files:
- `src/application/commands/internal/refresh-index.ts` (new, internal).
- `src/application/commands/internal/write-index-cache-tree.ts` — QUIET_SCAN (:20-21) moves to the new
  module and is imported back (scanQuietly :47-48 keeps using it).
- `src/application/commands/stash.ts` — stashPush :570-577.
- `test/unit/application/commands/internal/refresh-index.test.ts` (new).
- `test/unit/application/commands/stash-unmerged-index.test.ts`.
- `test/integration/stash-push-reset-interop.test.ts` (new; `@proves` surface repo.stash.push, bucket
  cross-tool-interop, interopSurface stash; DC-B).

Module shape (house pattern: write-index-cache-tree.ts:76-90 underIndexLock):

```ts
export const QUIET_SCAN = (): void => undefined;     // git's REFRESH_QUIET
/** git's refresh_and_write_cache: refuses an unmerged index, refreshes stat-only drift, writes iff refreshed. */
export const refreshAndWriteIndex = (ctx: Context): Promise<void> =>
  withFilterProcessPool(ctx, async () => {           // DC-E: the scan may run clean filters
    const lock = await acquireIndexLock(ctx);
    try {
      const read = await readIndex(ctx);
      rejectUnmergedIndex(read.entries);
      const { currentIndex, verified, refreshedCount } = await refreshedIndex(ctx, read);
      if (refreshedCount > 0) await lock.commit(currentIndex.entries, 'update', { verified });
    } finally { await lock.release(); }
  });
// refreshedIndex(ctx, index): scanTrackedEntries(ctx, index, index.entries, QUIET_SCAN) then
// { currentIndex: { ...index, entries: withRefreshedStat(index, scan.refreshed) }, verified: verifiedBy(scan), … }
// Keep refreshedIndex module-private in this part; Part 7 exports it (no unused export in between).
```
- scanTrackedEntries / verifiedBy: src/application/primitives/internal/scan-tracked-entries.ts:102-116;
  withRefreshedStat: internal/index-lock.ts:302-310; CommitOptions.verified :60-66; acquireIndexLock from
  primitives/internal/index-lock.ts; withFilterProcessPool from primitives/internal/filter-process-pool.ts;
  rejectUnmergedIndex: commands/internal/unmerged-index.ts:6-12 (one path per unmerged path, index order).
- The refresh set is compareAndRefresh's (compare-working-tree-entry.ts:295-301, :332-349): never
  assume-valid, skip-worktree, gitlink, intent-to-add; a content-dirty entry is not refreshed.
- stashPush becomes: gateStash → refreshAndWriteIndex → assertNoPendingOperation → stashAndReset (createAutostash
  :580-584 unchanged).
- Memory adapter: a touched clean file needs the Date clock moved past the entry's second
  (vi.useFakeTimers({ toFake: ['Date'] }) + setSystemTime) then a rewrite of the same bytes.
- Interop setup (design A.3): history base f=v1, g=g1, keep=k on main via commitOn; unmergedAt / unmergedAbsentAt
  from Part 3 fixtures; M1 = real `git merge side` conflicted on f in both peers (git drives the setup in both).
  "Nothing written" = loose object count (files under .git/objects excluding pack and info), refs/stash absent,
  .git/index bytes, work tree listing, HEAD and main reflogs equal before and after. git's refusal bytes:
  stdout `${p}: needs merge\n` per path, stderr `error: could not write index\n`, exit 1 — reconstruct stdout
  from tsgit's err.data.paths.

### TDD steps

1. RED — stash-unmerged-index.test.ts: "Given stages 1-3 of f, When stash push runs, Then it refuses
   MERGE_HAS_CONFLICTS { count: 1, paths: ['f'] } and writes no object or ref" (assert refs/stash absent and the
   object count). Fails: tsgit stashes (design A.3 F12a tsgit column).
2. RED — same file: "Given a conflicted merge with MERGE_HEAD, When stash push runs, Then it refuses
   MERGE_HAS_CONFLICTS, not OPERATION_IN_PROGRESS". Fails: the gate refuses first (A.3 TM1).
3. RED — interop F12a, F12b (-u), F12c (--keep-index), F12d (stages 2-3), F12e, M1 rows. Fail as A.3 tsgit
   columns show.
4. GREEN — refresh-index.ts with the refusal only + stashPush wiring before the gate. Steps 1-3 green.
5. RED — refresh-index.test.ts (through refreshAndWriteIndex): "Given a touched clean tracked file, Then the index
   records its new stat". Fails: step 4 only refuses. Also interop T × stash push row (A.2: no local changes,
   f not stale after). GREEN — refreshedIndex + unconditional commit.
6. RED — "Given nothing drifted, Then the index file is not rewritten" (index bytes and mtime unchanged).
   Fails after step 5's unconditional commit. GREEN — commit only when refreshedCount > 0.
7. GUARDs (refresh-index.test.ts): a content-dirty file stays stale; an assume-unchanged touched file stays
   stale; a skip-worktree entry stays stale (each passes: compareAndRefresh's shouldRefresh, cite
   compare-working-tree-entry.ts:295-301 and A.4 `all`). Interop C × stash push (nothing to stash) and
   E × stash push (only f rewritten, keep kept — Part 2's rule, cite A.2) are GUARDs.
8. REFACTOR — QUIET_SCAN import back into write-index-cache-tree.ts.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/internal/refresh-index.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/unit/application/commands/stash.test.ts test/integration/stash-push-reset-interop.test.ts test/integration/commit-cache-tree-interop.test.ts \
  && npm run check:types && npm run check:architecture && npm run check:dead-code \
  && ./node_modules/.bin/biome check src/application/commands/internal/refresh-index.ts src/application/commands/internal/write-index-cache-tree.ts src/application/commands/stash.ts test/unit/application/commands/internal/refresh-index.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/integration/stash-push-reset-interop.test.ts \
  && npm run check:spelling
```
Then the lesson 015 family run (stash push family) and the size step.

### Commit

`fix(stash): refresh the index and refuse an unmerged one before stash push as git does`

## Part 7 — an unforced switch refreshes drifted index stats

### Context

Goal (design P5, RC6; R7; ADR-1090): the unforced switch hands materializeTree the index refreshed by git's
refresh_index rule, so kept and untouched entries leave with fresh stats; a refused switch writes nothing.
The forced switch does not refresh (its stale pass rewrites stat-dirty entries).

Files:
- `src/application/commands/checkout.ts` — materializeSwitch (extracted in Part 4 from :279-302).
- `src/application/commands/internal/refresh-index.ts` — export refreshedIndex (Part 6 kept it private).
- `test/unit/application/commands/internal/refresh-index.test.ts` — direct refreshedIndex rows.
- `test/unit/application/commands/checkout-index-refresh.test.ts` (new).
- `test/integration/checkout-forced-same-commit-interop.test.ts`.
- `test/bench/checkout.bench.ts`.

Shape inside materializeSwitch, under the lock:

```ts
const read = await readIndex(ctx);
if (opts.force !== true) rejectUnmergedIndex(read.entries);
const { currentIndex, verified } = await indexForSwitch(ctx, opts, read);  // forced: { currentIndex: read }
// … materializeTree({ currentIndex, … }) unchanged …
await lock.commit(result.newIndexEntries, 'replace', verified === undefined ? {} : { verified });
```
- A refusal inside materializeTree (CHECKOUT_OVERWRITE_DIRTY) leaves through the finally/release without a
  commit, so the refresh is dropped (A.4 `refuse`). lock.commit's racy smudge (internal/index-lock.ts:430-445)
  is the only racy rule; `verified` spares re-reads.
- Interop (design A.2 set 5 + A.4): history for A.4 = base f, a, s, g, keep on main; t = base + g=g2 + other.
  Rows: T × unforced `checkout HEAD` (needs Part 5's stay — HEAD/reflog equal), `checkout main`, `checkout t`,
  `checkout --detach main`; A.4 `all` (f touched; a assume-unchanged + touched; s skip-worktree + touched; keep
  edited; g touched; `checkout t`), `refuse` (f touched, g edited; git exit 1, tsgit CHECKOUT_OVERWRITE_DIRTY
  { localChanges: ['g'] }; .git/index bytes unchanged both), `same` (f touched, `checkout main` on main).
  Compare staleEntries and flagListing.
- Bench: 'When checkout() switches to the current branch without force on a clean tree, Then measure tsgit'
  (repo.checkout({ rev: <current branch> })) — the ADR-1090 cost row.

### TDD steps

1. RED — checkout-index-refresh.test.ts: "Given a touched clean tracked file, When an unforced checkout of the
   current branch runs, Then the committed index records the file's new stat". Fails: the noop keeps the donor
   stat (A.4 `same` tsgit column).
2. RED — interop T × checkout main/t/--detach main/HEAD and A.4 `all`, `same` rows. Fail as A.2/A.4 tsgit
   columns show.
3. GREEN — export refreshedIndex; indexForSwitch; commit with verified.
4. GUARD — "Given a touched clean tracked file, When a forced checkout of the current branch runs, Then
   changedPaths is 1": the forced path skips the refresh, so the stale pass rewrites the file (a refresh first
   would make it up to date and report 0). Passes because indexForSwitch returns the index as read when
   forced; git rewrites it too (design A.1 T row, pinned in Part 4's interop table).
5. GUARDs — "a refused unforced switch leaves the index bytes" (A.4 `refuse`: both tools leave f stale);
   refreshedIndex rows: touched clean entry refreshed, dirty / assume-unchanged / skip-worktree kept stale
   (cite A.4 `all`).
6. REFACTOR — bench scenario; keep materializeSwitch under 20 lines (extract indexForSwitch).

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/checkout-index-refresh.test.ts test/unit/application/commands/internal/refresh-index.test.ts test/unit/application/commands/checkout.test.ts test/integration/checkout-forced-same-commit-interop.test.ts \
  && npm run check:types && npm run check:dead-code \
  && ./node_modules/.bin/biome check src/application/commands/checkout.ts src/application/commands/internal/refresh-index.ts test/unit/application/commands/checkout-index-refresh.test.ts test/unit/application/commands/internal/refresh-index.test.ts test/integration/checkout-forced-same-commit-interop.test.ts test/bench/checkout.bench.ts \
  && npm run check:spelling
```
Then the lesson 015 family run and the size step.

### Commit

`fix(checkout): refresh drifted index stats on an unforced switch as git does`

## Part 8 — a path restore from the index refuses a matched unmerged path

### Context

Goal (design P6, RC7; R8; ADR-1091 F10): `checkout -- <pathspec>` (source index) whose pathspec matches an
unmerged path refuses MERGE_HAS_CONFLICTS { count, paths } naming each matched unmerged path once in index
order; index, work tree and hooks untouched. An unmatched pathspec refuses first (PATHSPEC_NO_MATCH). A tree
source never refuses for an unmerged path.

Files:
- `src/application/commands/checkout.ts` — restoreUnderIndexLock :383-401 (after refuseUnmatched :393/:394),
  plus the comment rewrites at materializePathRestoreFromIndex :466-471 and materializePathRestoreLocked
  :490-494, :498-503 (Part 2 made them false: a restore rewrites only stale matched entries, so `written` is
  no longer `pathSet.size`; the commit stays unconditional).
- `test/unit/application/commands/checkout-path-restore-unmerged.test.ts` (new).
- `test/integration/checkout-forced-same-commit-interop.test.ts`.

Shape:

```ts
// git's checkout_paths: a matched unmerged entry refuses the whole restore before anything is written.
if (source === undefined) rejectUnmergedIndex(currentIndex.entries.filter((e) => pathSet.has(escapedPathOf(e))));
```
pathSet holds escaped paths (escapedPathOf, domain/git-index/index-path-key.ts). The throw leaves before
pathRestore's post-checkout (:369). Error data: mergeHasConflicts (domain/commands/error.ts:709-721);
PATHSPEC_NO_MATCH data { pattern, patterns } (error.ts:595-596).

Interop rows (design A.3 + A.2 path-restore rows), history base f=v1, g=g1, keep=k; keep edited to 'edited\n';
post-checkout hook appending "$*" to $GIT_DIR/hook-log in both peers (pattern:
test/integration/checkout-unborn-path-restore-interop.test.ts:26-38). Refusal rows assert git exit 1 and
stderr = paths.map((p) => `error: path '${p}' is unmerged\n`).join(''), tsgit { code: 'MERGE_HAS_CONFLICTS',
count, paths }, .git/index bytes unchanged both, listing unchanged, hook-log empty both.
- Refuse: F10a `-- f`, F10b `-- f keep`, F10c `-- .`, F10d unmerged f and g `-- .` (f then g), F10g stages 2-3
  `-- n keep`, F10i `-- 'k*' f`.
- Proceed: F10h `-- keep` (stages of f kept, hook `<h> <h> 0`).
- Unmatched first: F10k `-- missing f` (git stderr only the pathspec line; tsgit PATHSPEC_NO_MATCH pattern missing).
- Tree source: F10e `HEAD -- f keep`, F10f `HEAD -- .`, F10j/F10m `HEAD -- n` (no match), F10l `HEAD -- .`
  keeps n's stages.
- Stale-only restore rows: C, T, AU, S2, ST × `-- f keep` and `HEAD -- f keep` (Part 3 planters), compare
  rewrittenPaths, modeListing, flagListing.

### TDD steps

1. RED — unit: "Given stages 1-3 of f, When checkout paths ['f'] from the index, Then MERGE_HAS_CONFLICTS
   { count: 1, paths: ['f'] } and the index is unchanged". Fails: the restore drops f's stages (A.3 F10a tsgit).
2. RED — interop F10a, F10b, F10c, F10d, F10g, F10i. Same failure.
3. GREEN — the filtered rejectUnmergedIndex call.
4. GUARDs (each passes through step 3; cite the A.3 row): stages 2-3 refuse (F10g); two unmerged paths in index
   order (F10d; rejectUnmergedIndex's Set keeps first-seen order); a spec missing the unmerged path proceeds
   (F10h); unmatched refuses first (F10k: refuseUnmatched runs before); no post-checkout on refusal; a tree
   source never refuses (F10e, F10f, F10l: the guard is source-gated — write this row to fail if the
   `source === undefined` condition were dropped).
5. GUARD — stale-only restore rows (since Parts 2-3; cite A.2 C/T/AU/S2/ST × path restore).
6. REFACTOR — the three comment rewrites.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/checkout-path-restore-unmerged.test.ts test/unit/application/commands/checkout.test.ts test/integration/checkout-forced-same-commit-interop.test.ts test/integration/checkout-unborn-path-restore-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/checkout.ts test/unit/application/commands/checkout-path-restore-unmerged.test.ts test/integration/checkout-forced-same-commit-interop.test.ts \
  && npm run check:spelling
```
Then the lesson 015 family run and the size step.

### Commit

`fix(checkout): refuse a path restore that matches an unmerged path as git does`

## Part 9 — `stash push` writes git's hard-reset ref tail

### Context

Goal (design P8, RC8; R10; ADR-1091 F11, ADR-1093 / DC6): after a stash is saved, stashPush runs the same ref
tail as `reset --hard HEAD`: ORIG_HEAD ← HEAD (attached and detached), `updateRef('HEAD', head, { reflogMessage:
'reset: moving to HEAD' })` (attached: one HEAD entry old = new, branch log untouched; detached no-move: none),
removeBranchState(ctx, 'silent'). createAutostash does none of it.

Files:
- `src/application/commands/internal/reset-refs.ts` (new, internal).
- `test/unit/application/commands/internal/reset-refs.test.ts` (new).
- `src/application/commands/reset.ts` — :88-108: the tail :95-99 and recordOrigHead :103-108 move out.
- `src/application/commands/stash.ts` — stashPush :570-577.
- `test/unit/application/commands/stash.test.ts`.
- `test/integration/stash-push-reset-interop.test.ts`.

Shape:

```ts
/** git's reset_refs and remove_branch_state, as every `reset` (and stash push's child reset) runs them. */
export const recordHardReset = async (ctx: Context, id: ObjectId, rev: string): Promise<void> => {
  await recordOrigHead(ctx);                                   // moved verbatim from reset.ts:104-108
  await updateRef(ctx, 'HEAD' as RefName, id, { reflogMessage: resetMovingTo(rev) });
  await removeBranchState(ctx, 'silent');
};
```
- Imports: resolveRefOrMissing (primitives/resolve-ref.ts), writeOrigHead / clearOrigHead
  (commands/internal/merge-state.ts:72-76), updateRef (primitives/update-ref.ts:49), resetMovingTo
  (domain/reflog/reflog-messages.ts:39), removeBranchState (commands/internal/branch-state.ts:81).
- reset keeps its `branch` computation (:88-94) and calls `recordHardReset(ctx, id, opts.rev)` (every mode,
  as today).
- stashPush: `const saved = await stashAndReset(…); if (saved.kind === 'saved') await finishStashReset(ctx, opts);
  return saved;` where finishStashReset resolves HEAD (resolveRef) and calls recordHardReset(ctx, head, 'HEAD').
  Order matches git: stash ref + its reflog → reset → ORIG_HEAD / HEAD reflog.
- With the pending gate still in place (until Part 11) removeBranchState never meets a marker here.
- Interop rows (design A.3): F11a f edited `stash push -q`; F11b `-u`; F11e detached; F11g two pushes (two
  entries); O1/O4 ORIG_HEAD = HEAD. Compare HEAD reflog entries by old oid, new oid and message (not identity
  or timestamp: tsgit's reflog identity comes from config and clock, not COMMIT_ENV), main reflog count,
  ORIG_HEAD content, refs/stash reflog message.

### TDD steps

1. RED — stash.test.ts: "Given HEAD on main and an edited file, When stash push saves, Then HEAD's reflog gains
   `reset: moving to HEAD` with old = new = HEAD and main's reflog is unchanged". Fails: no ref tail.
2. RED — "… Then ORIG_HEAD names HEAD". Fails: no ORIG_HEAD.
3. RED — interop F11a, F11b, F11g, O1, O4 rows. Fail as A.3 tsgit columns show.
4. GREEN — extract recordHardReset into reset-refs.ts (reset.ts calls it), wire finishStashReset.
5. GUARDs — detached push writes no HEAD entry but writes ORIG_HEAD (F11e/O4; updateRef skips a detached
   no-move, cite reset-interop.test.ts:184-210); "nothing to stash" writes no ORIG_HEAD and no entry (the tail
   runs only on 'saved'); createAutostash writes neither (it does not call stashPush); reset-refs.test.ts rows
   for recordHardReset (attached entry, detached none, unborn HEAD clears ORIG_HEAD, MERGE_HEAD removed) — pass
   because the code is moved, cite reset-interop.test.ts R1/R2 rows and reset-branch-state.test.ts.
6. REFACTOR — none beyond the extraction.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/internal/reset-refs.test.ts test/unit/application/commands/reset.test.ts test/unit/application/commands/reset-branch-state.test.ts test/unit/application/commands/stash.test.ts test/integration/stash-push-reset-interop.test.ts test/integration/reset-interop.test.ts \
  && npm run check:types && npm run check:architecture && npm run check:dead-code \
  && ./node_modules/.bin/biome check src/application/commands/internal/reset-refs.ts src/application/commands/reset.ts src/application/commands/stash.ts test/unit/application/commands/internal/reset-refs.test.ts test/unit/application/commands/stash.test.ts test/integration/stash-push-reset-interop.test.ts \
  && npm run check:spelling
```
Then the lesson 015 family run and the size step.

### Commit

`fix(stash): write ORIG_HEAD and the HEAD reset reflog entry after stash push as git does`

## Part 10 — `stash push --keep-index` fires `post-checkout`

### Context

Goal (ADR-1094 / DC7, design F14): after a saved `stash push` with keepIndex, fire
`post-checkout <head> <head> 0` (file flag), after the ref tail. A push without keepIndex fires nothing.

Files:
- `src/application/commands/internal/post-checkout.ts` (new, internal; DC-C): exports
  `BRANCH_FLAG = '1'` and `FILE_FLAG = '0'` with the TSDoc now at checkout.ts:106.
- `src/application/commands/checkout.ts` — drop its local constants :106-108, import them.
- `src/application/commands/stash.ts` — finishStashReset (Part 9).
- `test/unit/application/commands/stash.test.ts`.
- `test/integration/stash-push-reset-interop.test.ts`.

finishStashReset gains: `if (opts.keepIndex === true) await runInformationalHook(ctx, 'post-checkout', { args:
[head, head, FILE_FLAG] })` (runInformationalHook: primitives/run-hook.ts:120). Interop rows (design A.3):
F11c (keep staged as s, f edited, `stash push -q --keep-index`) and F11d (`-u --keep-index`), hook appending
"$*" to $GIT_DIR/hook-log in both peers; compare hook-log, ls-files -s and listing.

### TDD steps

1. RED — stash.test.ts: "Given a staged and an unstaged change, When stash push keeps the index, Then
   post-checkout fires once with [head, head, '0']". Fails: no hook call.
2. RED — interop F11c, F11d. Fail: tsgit fires nothing (A.3 T11c).
3. GREEN — the keepIndex hook call; move the flag constants.
4. GUARDs — a push without keepIndex fires no post-checkout (cite A.3 F11a: no hook); "nothing to stash" with
   keepIndex fires none (the tail runs only on 'saved'); checkout's existing hook rows still pass with the
   moved constants (checkout.test.ts:1609-1720).

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/stash.test.ts test/unit/application/commands/checkout.test.ts test/integration/stash-push-reset-interop.test.ts test/integration/hooks-coverage-interop.test.ts \
  && npm run check:types && npm run check:architecture && npm run check:dead-code \
  && ./node_modules/.bin/biome check src/application/commands/internal/post-checkout.ts src/application/commands/checkout.ts src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/stash-push-reset-interop.test.ts \
  && npm run check:spelling
```
Then the lesson 015 family run and the size step.

### Commit

`fix(stash): fire post-checkout after stash push --keep-index as git does`

## Part 11 — `stash push` has no pending-operation gate (conditional)

### Context

Goal (ADR-1095 / DC8, design F15): drop `assertNoPendingOperation(ctx)` from stashPush (stash.ts, the line
after refreshAndWriteIndex). git stashes, resets and clears MERGE_HEAD, CHERRY_PICK_HEAD and REVERT_HEAD,
keeps REBASE_HEAD. stashApply's own gate (:951) stays. The conflicted merge stays refused by Part 6's opening
step.

CONDITION (ADR-1095, binding): BEFORE removing the gate, pin against git 2.55 one real resolved cherry-pick and
one real stopped rebase, as interop RED rows, and compare git's outcome to the design K rows:
- real resolved cherry-pick: `git cherry-pick side` conflicting on f, resolve f and `git add f`, edit keep,
  `git stash push -q` → expected per K: exit 0, stash saved, CHERRY_PICK_HEAD removed, ORIG_HEAD written,
  HEAD log `reset: moving to HEAD`.
- real stopped rebase: `rebase -i` with an `edit` stop (GIT_SEQUENCE_EDITOR rewriting the first pick to edit;
  rebase-merge/ present), edit keep, `git stash push -q` → expected per K: exit 0, stash saved, REBASE_HEAD kept,
  rebase-merge/ kept.
If git's outcome disagrees with either expectation, STOP: commit nothing for this part and return
`{ unit: 'Part 11', reason: '<row>: git <observed> vs design K <expected>', options: [keep the gate and
warn-and-ask, drop the gate for the agreeing operations only, amend ADR-1095] }`.

Files:
- `src/application/commands/stash.ts` — stashPush.
- `test/unit/application/commands/stash.test.ts`.
- `test/integration/stash-push-reset-interop.test.ts`.

Interop rows: the two real-operation rows above; M2 (real merge, f resolved and added, keep edited → git exit 0,
MERGE_HEAD, MERGE_MODE, MERGE_MSG removed, HEAD log entry); K × { MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD,
REBASE_HEAD } planted = HEAD oid with f edited (first three removed, REBASE_HEAD kept, ORIG_HEAD written).
Compare per tool: exit/outcome, refs/stash present, each marker file present, sequencer/ and rebase-merge/
present, HEAD reflog top message, ORIG_HEAD.
removeBranchState → sequencerPostCommitCleanup (commands/internal/branch-state.ts:65-85) does the clearing.
If, after the drop, tsgit diverges from git on a row and the fix is not confined to stash.ts, return a
blocker with the failing row instead of editing branch-state.ts (shared by reset and checkout).

### TDD steps

1. RED (git-side pin first) — interop real cherry-pick and real stopped rebase rows. Run them before any src
   change: confirm git matches the K expectations (else the blocker above); tsgit fails them with
   OPERATION_IN_PROGRESS.
2. RED — interop M2 and the four K rows. Fail: OPERATION_IN_PROGRESS (A.3 M2/K tsgit columns).
3. RED — stash.test.ts: "Given MERGE_HEAD naming HEAD and an edited file, When stash push runs, Then the stash
   is saved and MERGE_HEAD is removed". Fails: OPERATION_IN_PROGRESS.
4. GREEN — delete the gate call (the import stays: stashApply uses it).
5. GUARD — "Given REBASE_HEAD, Then the stash is saved and REBASE_HEAD stays" (passes through
   sequencerPostCommitCleanup's marker list; cite A.3 K REBASE_HEAD); a conflicted merge still refuses
   MERGE_HAS_CONFLICTS (Part 6 step 2).

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/stash.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/integration/stash-push-reset-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/stash-push-reset-interop.test.ts \
  && npm run check:spelling
```
Then the lesson 015 family run and the size step. Phase gate after the last part:
`PATH="$HOME/.local/git-2.55.0/bin:$PATH" npm run validate`.

### Commit

`fix(stash): stash push during a resolved pending operation as git does`

## Requirement map

| requirement | parts |
|---|---|
| R1 forced switch rewrites stale, keeps up-to-date | 2 (rule), 4 (forced switch) |
| R2 git's up-to-date rule | 1 (judge), 2 (pass) |
| R3 assume-unchanged kept on rewrite | 3 |
| R4 every forceRewriteAll caller stale-only, TSDoc | 2 (all callers, TSDoc), 3 (reset pins), 6 (stash pins), 8 (path-restore pins) |
| R5 conflicts reset by forced switch and reset --hard; merge rewind hidden | 3 (reset), 4 (switch); ADR-1089 keeps reset-worktree.ts:54-55 as is |
| R6 bare HEAD / @ stays | 5 |
| R7 unforced refresh | 7 |
| R8 path restore refuses a matched unmerged path | 8 |
| R9 stash push refuses an unmerged index first | 6 |
| R10 stash push ref tail | 9 |
| R11 stash push opening refresh | 6 |
| R12 SAME rows stay SAME | every part's GUARD rows + the lesson 015 family run |
| DC6 / DC7 / DC8 | 9 / 10 / 11 (conditional) |

## Decision candidates

Choices the design and ADRs do not settle; each part above assumes the recommendation.

| # | Choice | Alternatives | Recommendation | Why |
|---|---|---|---|---|
| DC-A | Where the shared stat judge lives, given ADR-1088's location creates a runtime import cycle (is-entry-stat-clean.ts → compare-working-tree-entry.ts → is-entry-stat-clean.ts; compare-working-tree-entry.ts:36-40 already imports it, and .dependency-cruiser.cjs `no-circular` rejects the loop) | (a) keep ADR-1088's home and inject the racy content check (`RacyContentCheck`, built by `racyContentMatcher(ctx)` in compare-working-tree-entry.ts); (b) amend ADR-1088 to its option 2, a new internal/index-stat-match.ts holding both functions; (c) host both in compare-working-tree-entry.ts | (a) | Keeps the accepted ADR intact, no new module, and the injected check is exactly where "build the provider once per pass" lives. (b) needs an ADR amendment; (c) grows an already-large module. |
| DC-B | Where the stash push interop rows live | (a) new test/integration/stash-push-reset-interop.test.ts with plumbing-built peers; (b) extend stash-interop.test.ts as the design says | (a) | stash-interop.test.ts builds ours with repo.commit; the new rows need the plumbing fixtures, unmerged planters and hook logs, and Parts 6, 9, 10 and 11 all extend them. |
| DC-C | Home of the post-checkout flag constants shared by checkout and stash | (a) new commands/internal/post-checkout.ts; (b) export them from checkout.ts and import into stash.ts | (a) | Avoids a stash → checkout command-to-command import. |
| DC-D | Version assertion in the new interop suites (the design says "as the #331 suites do", but those suites have none) | (a) none, the gate's PATH pins 2.55; (b) assert `git --version` reports 2.55.0 | (a) | No house precedent. (b) turns every row red on the next CI git upgrade even where behaviour is identical. |
| DC-E | Whether refreshAndWriteIndex runs inside withFilterProcessPool | (a) wrap it, as write-index-cache-tree.ts:76-86 does; (b) do not | (a) | The refresh scan can hash through a clean filter. The house refresh path wraps that in a pool. |
| DC-F | When the bench A/B runs | (a) parts add the scenarios and run each once, and the validation/perf phase runs `npm run bench:ab -- main HEAD 3 checkout.bench.ts stash.bench.ts` on a quiet machine; (b) A/B after every hot-path part | (a) | A/B needs the final tree and a quiet machine. Running it per part costs time and the numbers do not compose. |

Factual correction, no choice: ADR-1087 says "api.json is unchanged". The type surface is unchanged, but
reports/api.json embeds the `forceRewriteAll` TSDoc text (reports/api.json:110829), and R4 requires that text to
change. Part 2 therefore regenerates and commits reports/api.json. The change is still non-breaking and still
ships as `fix`.

## Handoff to the documentation phase

- docs/use/commands/checkout.md: a bare HEAD or @ stays on the branch and writes no reflog entry; a forced
  switch rewrites stale entries and resets conflicts; an unforced switch refreshes the index; a path restore
  from the index refuses MERGE_HAS_CONFLICTS on a matched unmerged path (add it to the error list).
- docs/use/commands/reset.md: `hard` rewrites only stale entries, keeps assume-unchanged, never touches
  skip-worktree, and resets conflicts.
- docs/use/commands/stash.md: push refreshes the index first and refuses MERGE_HAS_CONFLICTS on an unmerged
  index; it writes ORIG_HEAD and the HEAD `reset: moving to HEAD` entry; `--keep-index` fires post-checkout;
  push works during a resolved pending operation (only if Part 11 lands).
