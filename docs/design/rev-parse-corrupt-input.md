# Design — rev-parse and commit-ish resolution against corrupt input

> Brief: backlog 32.19. (1) `resolveCommitIsh` sweeps past a ref candidate whose object cannot be read or peeled and lands on a lower namespace; git takes the first candidate and refuses. (2) An unreadable `objects/<xx>` during the abbreviation check is rethrown; git logs `error: unable to open …` and carries on. Fix both on every route that reaches the changed code, pinned on git 2.56.0.
> Status: draft → self-reviewed ×3 → revised against ADRs 1141–1147

## Context

**Ladder.** `refname-ambiguity.ts` `resolveAmbiguousLadder` implements `get_oid_basic`. It walks `refCandidates(name)` (`refs/tags/<n>` comes before `refs/heads/<n>`). The first candidate that counts wins. Then it counts the rest and runs `isUniqueAbbreviation`, and warns `refname '<n>' is ambiguous.`. Two resolvers feed it:

- `revision-name.ts` `resolveCandidate` never peels (git's `dwim_ref`). `rev-parse`, `merge` (through `revision-expression.ts`) and `checkout`/`tag` use it.
- `commit-ish.ts` `peeledCandidate` peels each candidate (`readRefCandidate(ctx, c, { peel: true })`). It folds every peel fault in `isAbsentCandidate` (`OBJECT_NOT_FOUND` plus `UNREADABLE_REF_CODES`) to `{ kind: 'missing' }`. **This is the sweep.** `readRefCandidate` already handles ref-read faults itself (`isUnreadableRef` → `unreadableCandidate`). So `isAbsentCandidate` only ever sees faults that happen *after* the ref resolved, during peeling.

`resolveCommitIsh` is called from `sequencer-revisions.ts` `addSeed` (cherry-pick, revert), `describe.ts:86`, `blame.ts:183,193,224`, `rebase.ts:1290` (interactive instruction `oid`) and `rebase-merges-steps.ts` `lookupLabel`. In `resolve-ref.ts:14` the name appears only in a doc comment.

**Peel.** `primitives/internal/peel.ts` `peel` (git's `repo_peel_to_type` / `peel_onion`) is shared by `rev-parse.ts` and `internal/resolve-rev.ts`. `resolve-rev.ts` is used by `log`, `diff`, `grep`, `archive`, `shortlog`, `whatchanged` and `worktree`. `readHop` → `parseTypedPeelHop` throws `INVALID_OBJECT_ID` when a tag's `object` line is not an object id.

**Misspelt reread.** After a miss, `rev-parse.ts` `rereadMisspelt` re-runs `evaluateTyped` (git's `maybe_die_on_misspelt_object_name`). Failures that "name no object" are those in `misspelt-revision.ts` `UNRESOLVED_CODES`.

**Abbreviation scan.** `resolve-oid-prefix.ts` `scanLooseIn` is shared by `resolveOidPrefix` and `abbreviate-object-id.ts` `rivalsSharing`. It folds `isMissingFanoutDir` (`FILE_NOT_FOUND`, `NOT_A_DIRECTORY`, borrowed from `loose-oid-cache.ts`) and rethrows everything else. `loose-oid-cache.ts` `listSuffixes`, the read path, has the same fold and stays untouched.

**ADRs that constrain this design:**

- ADR-226 (prime directive) and ADR-249 (structured data, no rendered text).
- ADR-199 (merge shares rev-parse's DWIM).
- ADR-222 (`resolveOidPrefix`).
- ADR-509 (per-session loose-oid cache equates git's per-process `odb_loose_cache` with `ctx.session`).
- ADR-887 (an unreadable pack directory is an empty listing plus a logged fault, never a refusal; errors without a code thrown again).
- ADR-1030 (no rendered refusal lines; the interop test rebuilds them).
- ADR-233 (interactive rebase todo is a data list).
- ADRs 1141–1147, ratified from this design's decision candidates (see "Decision candidates" for the trail).

**Log pattern.** The existing log pattern is `rev-parse-ambiguity-interop.test.ts`: `logger.error` → `error: <message>`, `logger.warn` → `warning:`/`hint:`, plus structured context. It is pinned as "once per read git makes".

## Requirements

- R1. No commit-ish ladder sweeps. The first namespace whose ref resolves wins, whatever its object holds. Peel and read faults surface on the winner (Fixture A, Fixture M).
- R2. Each route refuses the way git does (exit-code class, on-disk state untouched). Its refusal data must be enough for an interop test to rebuild git's `fatal:`/`error:` line from fields, per the matrix below.
- R3. `refname '<n>' is ambiguous.` is emitted exactly as often as git emits it on every pinned route. That includes the two re-reads git makes: rev-parse's quiet misspelt reread and the sequencer's second `repo_get_oid`.
- R4. During a prefix scan, a fanout directory that cannot be listed is skipped. Every coded fault except `FILE_NOT_FOUND` is logged as structured data; `FILE_NOT_FOUND` is silent; an error without a code is rethrown. The log count matches git's per route.
- R5. `core.warnAmbiguousRefs=false` keeps the abbreviation check off: no scan, no log (pinned, already true).
- R6. A refusal leaves no `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `MERGE_HEAD` or `sequencer/`, and HEAD and the index are unchanged.

## Design

### Faithfulness matrix — git 2.56.0 as data

Every row was run at least twice in a scrubbed `mktemp -d` throwaway, and both runs were identical. Scripts and logs are in `<scratchpad>`:

- git: `pin-git.sh`, `pin-git-2.sh` … `pin-git-7.sh`, each with its `.log`.
- tsgit at 751166b5: `pin-tsgit.mjs`, `pin-tsgit-2.mjs`, `pin-tsgit-5.mjs`.

`W` is `warning: refname 'x' is ambiguous.`; `W×2` means git prints it twice.

**Fixtures:**

- **A:** commits c1 (branch `x`) and c2 (`main`). `refs/tags/x` is written by hand to a tag object (`hash-object -t tag -w --literally`) whose `object` line is one of:
  - `non-hex`: 40 × `z`
  - `truncated`: `abc`
  - `absent`: 40 × `a`, well-formed but missing
  - `valid`: c1, as a control
- **M:** the same, but `refs/tags/x` holds a missing oid directly (40 × `b`).
- **TT:** `refs/tags/t` → a valid tag object pointing at a tree.

| Route | non-hex / truncated / M | absent | tsgit today (all corrupt variants) |
|---|---|---|---|
| `rev-parse x` | 0, prints the tag oid (M: the `b…` oid), `W` | same | ✓ matches |
| `rev-parse x^{commit}` / `x^{blob}` | 128, stdout `x^{commit}`, `W`, `fatal: ambiguous argument 'x^{commit}': unknown revision…` | same | non-hex/truncated: throws `INVALID_OBJECT_ID {value}` with no printed path. absent/M: `OBJECT_NOT_FOUND` + printed path but **`W×2`** |
| `log -1` / `diff` / `grep hi` `x^{commit}` (reach of `peel`) | 128, `W`, `fatal: ambiguous argument 'x^{commit}'…` | (not pinned) | `INVALID_OBJECT_ID` |
| `cherry-pick x`, `cherry-pick x main`, `revert x` | 128, `W`, `fatal: bad object x`, no state | 128, `W×2`, `error: x: can't cherry-pick a tag`, `fatal: cherry-pick failed` (`revert failed`), no state | **sweeps:** picks or reverts c1, writes `CHERRY_PICK_HEAD`/`REVERT_HEAD` or a conflict |
| `blame x -- f` | 128, `W`, `fatal: bad object x` | 128, `W`, `fatal: Non commit x?` | **sweeps:** blames c1 |
| `describe x` / `describe --always x` | 128, `W`, `fatal: x is neither a commit nor blob` | same | throws `INVALID_OBJECT_ID`/`OBJECT_NOT_FOUND` (from `buildNameMap`, by accident), no `W` |
| `describe t` (tag of a tree), `describe <tree oid>`, `describe <absent 40-hex>` (review pins, x2) | 128, `fatal: <rev> is neither a commit nor blob` | — | `NO_REACHABLE_NAMES` for the first two, `OBJECT_NOT_FOUND` for the absent id |
| `blame t -- f` (tag of a tree), `blame <tree oid> -- f`, `blame outer -- f` (outer → a tag whose object line does not parse; review pins, x2) | 128, `fatal: Non commit <rev>?` | — | `UNEXPECTED_OBJECT_TYPE` for the first two, `INVALID_OBJECT_ID` for outer |
| `merge x` | 1, `W`, `merge: x - not something we can merge` | same | throws `INVALID_OBJECT_ID`/`OBJECT_NOT_FOUND` (from `resolveMergeParent`'s `peelChain`) |
| `rebase -i`, todo `pick x` | 1, `W`, `error: invalid line 1: pick x`, `rebase-merge/` kept (absent adds `error: Could not read aaa…`) | — | sweeps (`resolveCommitIsh`) |
| `rebase -i`, todo `reset x` | 1, `W`, `error: could not resolve 'x'` | — | sweeps (`lookupLabel` → `resolveCommitIsh`) |
| control `valid`: `cherry-pick x`, `x..side`, `^x side`, `revert x` | `W×2` (`setup_revisions`, then `sequencer_pick_revisions`' `repo_get_oid` at `sequencer.c:5690`) | — | **`W` once** |
| control `valid`: `rev-parse x^{blob}` | `W` once, peel `error:` twice | — | **`W×2`**, peel `error:` twice |
| control `valid`: `rev-parse x~5` | `W×2` (`^`/`~` drops the quiet flag) | — | `W×2` ✓ |
| TT `cherry-pick t` / `t main` | 128, `error: t: can't cherry-pick a tag`, `fatal: cherry-pick failed` | — | `CANNOT_PICK_NON_COMMIT {type:'tree'}` ✗ |
| dangling-symref control (`refs/heads/d` → nowhere, tag `d`): `rev-parse d^{blob}` / `d~5` | `ignoring dangling symref refs/heads/d` printed **twice**: the quiet reread suppresses only the refname warning | — | (current behaviour re-emits; keep) |

**Fixture B:** one commit (`962da73…`), branch `abcd`, and `objects/ab` set to `mkdir` + `chmod 000`. `E` is `error: unable to open .git/objects/ab: Permission denied`; `ENOTDIR` is the same line ending `Not a directory`.

| Route | git 2.56 | tsgit today |
|---|---|---|
| `rev-parse abcd`, `abcd^{commit}`, `--verify abcd`, `show -s abcd`, `describe --always abcd`, `merge abcd` (abcd at HEAD), `blame abcd -- f` | 0, the commit, **E×2** | throws `PERMISSION_DENIED {path}` |
| `merge abcd` with abcd AHEAD of HEAD, no `-m` (fast-forward, `--ff-only`, `--no-ff`, `--squash`, `-q`, `--no-commit` alike); `merge abcd abce`, two ahead parents | **E×3**; **E×5** | throws (after the fanout fix: E×2 / E×3 — the default message never re-read the parents) |
| `merge -m m abcd` ahead; `merge -m m abcd abce` | **E×2**; **E×3** | throws |
| `merge x` with tag `x` and branch `x` at a commit ahead, no `-m`; with `-m` | **W×2**; **W×1** | W×1 |
| `cherry-pick abcd`, `revert abcd` | own outcome, **E×3** | throws |
| `-c core.warnAmbiguousRefs=false rev-parse abcd` | 0, no stderr | ✓ ok, no log |
| `objects/ab` is a regular file: `rev-parse abcd` / `cherry-pick abcd` | 0, **ENOTDIR×2** / **×3** | ok, **no log** (folded silently) |
| no branch `abcd`: `rev-parse abcd` | 128, stdout `abcd`, **E×3**, `fatal: ambiguous argument 'abcd'…` | throws `PERMISSION_DENIED` |
| no branch: `rev-parse --verify abcd` / `cherry-pick abcd` | 128, **E×2**, `Needed a single revision` / `fatal: bad revision 'abcd'` | throws |
| packed clone (no loose objects), `objects/71` `chmod 000`: `rev-parse 71484c2`, `rev-parse --short HEAD`, `describe --always` | 0, **E×1** | `revParse` / `abbreviateObjectId` throw `PERMISSION_DENIED` |
| packed clone: `rev-parse 71ff` (absent prefix) | 128, **E×3** | throws |
| packed clone: `cat-file -t HEAD` | 0, no stderr | (out of scope) |

**Mechanism, from the sources.** In `odb/source-loose.c` `odb_source_loose_cache`, `for_each_file_in_obj_subdir` (`object-file.c:1041`) fails to open the directory with `errno != ENOENT` → `error_errno("unable to open %s")`. Its return value is ignored and the subdir's `subdir_seen` bit is **set anyway**, so the failed directory is cached as empty for the rest of the process.

`object-name.c:455` `get_short_oid` scans once. On `MISSING_OBJECT` it calls `odb_reprepare` (which flushes the cache) and scans again. Per `get_short_oid` call that gives:

| Call | Logs |
|---|---|
| first in the process, miss | 2 |
| first in the process, hit | 1 |
| later call, miss (cached silent, then flush + rescan) | 1 |
| later call, hit | 0 |

That accounts for every count above:

- `rev-parse abcd` = one miss (2).
- cherry-pick = 2 + the `sequencer.c:5690` re-read (1) = 3.
- No-ref `rev-parse abcd` = 2 + the misspelt reread (1) = 3.
- Packed hit = 1.
- `--short` = 1. `find_unique_abbrev` has no reprepare.

`get_oid_basic` (`object-name.c:751`) only runs the abbreviation `get_short_oid` when `warn_ambiguous_refs && !(flags & GET_OID_QUIETLY) && refs_found == 1`. So the quiet misspelt reread of a name that resolves as a ref scans nothing and warns nothing.

The full-oid branch (`object-name.c:688`) is not gated by `GET_OID_QUIETLY`.

### D1 — the commit-ish ladder takes the first candidate, unpeeled

`commit-ish.ts`:

- Drop `peeledCandidate` and `isAbsentCandidate`.
- Feed the ladder, `warnIfRefNamesObjectId` and `resolvePriorCheckout` with the never-peeling resolver. `resolveCandidate` can move from `revision-name.ts` to a shared export, or be re-declared as `(c) => readRefCandidate(ctx, c)`.
- Export two functions:

```ts
/** git's `repo_get_oid` over a commit-ish argument: the winner, unpeeled — never swept. */
export const resolveCommitIshObject = (ctx: Context, target: string): Promise<ObjectId>;
/** {@link resolveCommitIshObject} peeled through tags; a peel fault propagates. */
export const resolveCommitIsh = async (ctx: Context, target: string): Promise<ObjectId> =>
  peelTags(ctx, await resolveCommitIshObject(ctx, target));   // via readRefCandidate's peel or a peel-chain helper
```

`rebase` (todo `oid`) and `rebase-merges` (`lookupLabel`) keep `resolveCommitIsh`, so their refusal is the propagated read fault: the todo is a data list (ADR-233) and tsgit refuses before writing state (ADR-1141).

`describe` does not propagate. It resolves the winner unpeeled, then peels it to a commit; a read or peel fault of that target refuses with a new `DESCRIBE_NEITHER_COMMIT_NOR_BLOB { revision }` on every corrupt variant (non-hex, truncated, absent, M). git: `builtin/describe.c:580` `die("%s is neither a commit nor blob")`, reached when `lookup_commit_reference_gently` fails and `odb_read_object_info` is not a blob (ADR-1141).

The ambiguity warning now fires on all these routes as git's does, before the refusal, because the corrupt tag candidate now counts.

### D2 — the sequencer follows `setup_revisions` and then `sequencer_pick_revisions`

`sequencer-revisions.ts`:

1. `addSeed`'s plain-name arm resolves with `resolveCommitIshObject`.
2. **`get_reference`:** the named object must read. A read fault (`INVALID_OBJECT_ID`, `OBJECT_NOT_FOUND`, or any parse fault of the named object itself) refuses with a new `BAD_OBJECT { revision }`. git's `revision.c:369` `die("bad object %s", name)` maps to it.
3. **`assertPicksCommit` does git's second `repo_get_oid`:** re-read the name with `evaluateRevision(ctx, name)`, which emits the second `W`, the third `E`, and covers range sides (`x..side`, `^x`). Then peel to a commit. A non-commit **or** a peel fault refuses with `CANNOT_PICK_NON_COMMIT { revision, type }`, where `type` is the **unpeeled** object's type. That makes TT report `tag` and `absent` report `tag`, as git does (`odb_read_object_info` on the named oid).
4. Tips and seeds keep the peeled commit ids, so the walk is unchanged.

All of this runs before `openReplayRun` writes any state. The interop row asserts R6.

`blame.ts` has two tiers (ADR-1141):

| Condition | Variants | Refusal | git |
|---|---|---|---|
| the named object does not read (`get_reference`) | non-hex, truncated, M | `BAD_OBJECT { revision }` | `fatal: bad object x` |
| the named object reads as a tag, its target is missing | absent | new `BLAME_NON_COMMIT { revision }` | `fatal: Non commit x?` |

blame makes no second read, so it warns once (pinned `W`).

`DESCRIBE_NEITHER_COMMIT_NOR_BLOB` and `BLAME_NON_COMMIT` join `domain/commands/error.ts` the way D7 adds `BAD_OBJECT`: a union member beside `CANNOT_PICK_NON_COMMIT`, each carrying only `revision` (the name as the caller typed it, `'HEAD'` when describe defaults), a factory beside `cannotPickNonCommit` (`describeNeitherCommitNorBlob(revision)`, `blameNonCommit(revision)`), and a message case in `domain/error.ts`. The API report changes with them.

### D3 — a tag that does not parse names no object under `peel`

`peel.ts` `readHop`: a hop whose object fails to parse (`INVALID_OBJECT_ID` from the tag `object` line) yields `undefined`, which is git's `parse_object` returning NULL in `peel_onion`. `peel` already turns that into `objectNotFound(walk.id)`. Once it does, `rev-parse` prints the argument as a path and refuses through its existing names-no-object path, and `log`, `diff`, `grep` and the other `resolve-rev` consumers refuse `OBJECT_NOT_FOUND`. All of these match the pinned `ambiguous argument` rows.

Only the pinned code is folded. Other parse codes keep propagating; a new code joins only with its own pin.

### D4 — the misspelt reread is quiet for the refname check

`rereadMisspelt` reads quietly unless `dropsQuietRead(arg)`, and threads that through `evaluateTyped` → `evaluate` → `resolveBase` → `resolveRevisionName` → `resolveRefLadder`/`resolveSubstitutedRefLadder` → `resolveAmbiguousLadder`. When the read is quiet, `resolveAmbiguousLadder` still runs `countFound` (git's `expand_ref` reads every namespace, so a later dangling candidate's skip line prints again — pinned: `rev-parse d^{blob}` prints it twice) and skips only `isAmbiguous` (the warning **and** the abbreviation scan), as `get_oid_basic`'s `&&` short-circuit does.

These stay as they are:

- `warnSkipped` ("ignoring dangling symref", pinned re-emitted twice).
- `warnIfRefNamesObjectId` (git's full-oid branch is ungated).
- `reportPeelMismatch`.

The mechanism is DC-7. This fixes the `W×2` in `revParse x^{commit}` (absent, M) and `x^{blob}` (valid).

### D5 — merge maps a peel fault to its "not something we can merge"

`merge.ts` `resolveMergeParent`: when `peelChain` fails with `OBJECT_NOT_FOUND`, `INVALID_OBJECT_ID` or another read fault of the chain, throw `refNotFound(name)`. That is the same refusal the function already gives a non-commit, and it rebuilds `merge: x - not something we can merge` with exit 1. This is DC-5, folding a route that never reaches `resolveCommitIsh`.

**merge reads each surviving parent again for its default message** (found by the fixture B rows, pinned twice on 2.56.0). git's `collect_parents` resolves every argument (`get_merge_parent`), reduces the heads (`reduce_parents`: a parent HEAD already reaches is dropped), and then — only when no `-m` is given, or a shortlog is asked for — calls `merge_name` on each surviving parent, which resolves the name once more (`get_merge_parent` again). That second read emits the ambiguity warning a second time and, on a miss, one more fanout log. `settleMessage` therefore records where the message came from (`messageSource: 'given' | 'supplied-heads' | 'generated'`), and `rereadParentsForMessage` resolves each surviving parent again (`resolveRevisionExpression` on its spelt name) when it is `'generated'`: in `twoHeadMerge` right after the up-to-date checks (a subsumed parent is never re-read) and before the unrelated-histories refusal, as in git; in the octopus path over the already-reduced survivors. Heads a caller described (`pull`'s FETCH_HEAD path) are not re-read, as git's `handle_fetch_head` does not.

### D6 — an unreadable fanout directory is skipped, logged, and counted as git counts

`resolve-oid-prefix.ts` `scanLooseIn` gets its own classifier. Do not change `isMissingFanoutDir`, because `loose-oid-cache.ts` `listSuffixes` shares it.

| Fault | Handling |
|---|---|
| `FILE_NOT_FOUND` | `[]`, silent (git's `ENOENT`) |
| any other coded fault (`PERMISSION_DENIED`, `NOT_A_DIRECTORY`, …) | `[]` + one structured log (DC-2) |
| no code | rethrown, as ADR-887 does |

**Counts (DC-3):**

- A per-session memo of fanout directories whose listing failed, `WeakMap<Session, Set<string>>`, keyed like `loose-oid-cache.ts`. That is git's `subdir_seen` bit set on failure. A memoised directory answers `[]` without reading the directory and without logging.
- `resolveOidPrefix` (not `abbreviateObjectId`) does git's `odb_reprepare` retry: when no candidate is found and this call consulted a failed directory (freshly or from the memo), it drops those entries and scans once more; a miss over readable directories is not scanned again (every pinned count is unchanged).

This reproduces every Fixture B count, given D2 (the sequencer's second read) and D4 (the quiet reread scans nothing when the name resolves as a ref).

Successful listings stay uncached, so a hit is never served from a stale listing.

**Log shape (DC-2).** The recommended shape:

```ts
ctx.logger?.error?.(`unable to open ${dir}`, { path: dir, code });
```

The interop test rebuilds `error: unable to open ${relative(repo, path)}: ${ERRNO_TEXT[code]}`. A test-local map gives `PERMISSION_DENIED` → `Permission denied` and `NOT_A_DIRECTORY` → `Not a directory`; those are the macOS and Linux strings.

### D7 — `BAD_OBJECT` refusal

Add it to `domain/commands/error.ts`: a member of the union next to `CANNOT_PICK_NON_COMMIT` (around line 332) and a factory `badObject(revision: string)` next to `cannotPickNonCommit` (line 880). Add a message case to `domain/error.ts` (next to line 681). Because the error union is public, the API report (`api.json`) changes too.

### Routes reaching the changed code (all walked)

| Changed code | Routes |
|---|---|
| D1 ladder | cherry-pick, revert, describe, blame, rebase todo `pick`/`reset` label, `@{-n}` prior-checkout arm, full-oid warning arm |
| D2 | cherry-pick, revert (single, list, range sides); blame (`BAD_OBJECT` / `BLAME_NON_COMMIT`, named-revision call only) |
| D3 peel | rev-parse `^{type}`, log/diff/grep/archive/shortlog/whatchanged/worktree via `resolve-rev` |
| D4 | rev-parse command-line misspelt path only |
| D5 | merge, single head and octopus (`resolveRemotes`) |
| D6 | every `resolveOidPrefix` caller (rev-parse, commit-ish, merge, `sequencer-state.ts:77`, `rebase-state.ts:331`), and `abbreviateObjectId` if DC-4 folds it (21 callers) |

### Parts

Each part is one atomic commit, RED → GREEN per function.

**P1 — peel: an unparseable hop names no object (D3).**

- Files: `src/application/primitives/internal/peel.ts`, `readHop(ctx, table, oid): Promise<PeelHopObject | undefined>` (catch `INVALID_OBJECT_ID` only). Consumers: `src/application/commands/rev-parse.ts` `peelTo`/`withPrinted`; `internal/resolve-rev.ts`.
- Tests: `test/unit/application/primitives/internal/peel.test.ts`, `test/unit/application/commands/rev-parse-peel-errors.test.ts`.
- Interop: rows `revParse x^{commit}` non-hex/truncated (stdout path + fatal), and `log`/`diff` `x^{commit}` if the suite reaches them.

**P2 — quiet misspelt reread (D4, DC-7).**

- Files: `rev-parse.ts` `rereadMisspelt`, `evaluateTyped`, `evaluate`, `resolveBase`; `internal/revision-name.ts` `resolveRevisionName(ctx, name, accepts?)` → takes an options object `{ accepts?, mode? }` (update every caller); `internal/refname-ambiguity.ts` `resolveAmbiguousLadder`, `resolveRefLadder`, `resolveSubstitutedRefLadder`, `isAmbiguous`.
- Tests: `test/unit/application/commands/internal/refname-ambiguity.test.ts`, `test/unit/application/commands/rev-parse-misspelt-name.test.ts`.
- Interop: `x^{blob}` valid (`W` once), absent/M `x^{commit}` (`W` once), `x~5` (`W×2`), dangling-symref controls.

**P3 — commit-ish ladder takes the first candidate; describe's refusal (D1, DC-1 → ADR-1141).**

- Files: `src/application/commands/internal/commit-ish.ts`: delete `peeledCandidate` and `isAbsentCandidate`, plus the `UNREADABLE_REF_CODES` and `errorDataCode` imports if they become unused; add `resolveCommitIshObject`. `src/application/primitives/resolve-ref.ts:14` doc comment (keep it accurate).
- Peel helper: `readRefCandidate(..., { peel: true })` is no longer per-candidate. Use `peelChain(ctx, id, readObject, tagHop)` from `primitives/internal/peel-chain.ts` (as `merge.ts` `resolveMergeParent` does), or export `peelTags` from `primitives/resolve-ref.ts` (private today, line 247).
- Describe's refusal. Today `describe.ts` `describe` (overloaded, `(ctx, rev?, opts?) → Promise<DescribeResult | NameRevResult | undefined>`) calls `resolveCommitIsh(ctx, rev ?? DEFAULT_REV)` at line 86, and the corrupt candidate is swept. With the sweep gone the fault would escape from that call, not from `buildNameMap`, so it has to be mapped there. Replace line 86 with a private `resolveDescribeTarget(ctx, revision: string): Promise<ObjectId>` in `describe.ts`:

  ```ts
  const named = await resolveCommitIshObject(ctx, revision);  // the ladder warns here first
  // peel inside a try: OBJECT_NOT_FOUND / INVALID_OBJECT_ID → describeNeitherCommitNorBlob(revision); any other error rethrown
  ```

  The ladder call stays outside the `try`, so a name that resolves nowhere keeps `REF_NOT_FOUND`, and only a read or peel fault of the resolved target becomes the new code. That covers non-hex and truncated (the named tag does not parse), M (the named object is missing) and absent (the tag's target is missing). The ambiguity warning is emitted before the refusal because the ladder runs before the peel. A peel that ends on a non-commit keeps today's behaviour (Out of scope).
- Error code: `DESCRIBE_NEITHER_COMMIT_NOR_BLOB` union member and `describeNeitherCommitNorBlob` in `src/domain/commands/error.ts` (beside `CANNOT_PICK_NON_COMMIT`, line 332, and `cannotPickNonCommit`, line 880); message case `${data.revision} is neither a commit nor blob` in `src/domain/error.ts` (beside line 681). API report.
- `describeContains` (`--contains`, through `nameRevPeeled`) does not reach `resolveCommitIsh` and is untouched.
- Tests: `test/unit/application/commands/internal/commit-ish.test.ts`; `test/unit/application/commands/describe.test.ts` (`DESCRIBE_NEITHER_COMMIT_NOR_BLOB { revision }` for each fault in isolation, the `W` logged before it, a peel error without a code rethrown, an unresolvable name still `REF_NOT_FOUND`).
- Interop: describe and `describe --always` rows (non-hex, truncated, absent, M), rebuilt to `fatal: x is neither a commit nor blob` after `W`; the rebase todo `pick x` refuses before state (pin on tsgit in RED; it is unprobed today).

**P4 — sequencer `BAD_OBJECT`, unpeeled type, second read (D2, D7, DC-1 → ADR-1141, DC-6 → ADR-1146).**

- Files: `src/domain/commands/error.ts` (union + `badObject`), `src/domain/error.ts` (message case), `src/application/commands/internal/sequencer-revisions.ts` `addSeed(ctx, arg, seeds)` (line 93; its plain-name arm picks `resolveCommitIsh` at line 109), `assertPicksCommit(ctx, { name, id })` (line 87), `resolveSeeds` (line 79).
- The `get_reference` read (D2 step 2) is a helper P5 reuses: `readNamedObject(ctx, id, revision): Promise<GitObject>` exported from `commit-ish.ts`. It reads the unpeeled winner with `readObject` and maps `INVALID_OBJECT_ID`, `OBJECT_NOT_FOUND` or another parse fault of that object to `badObject(revision)`; an error without a code is rethrown.
- Tests: `test/unit/application/commands/internal/sequencer-revisions.test.ts`, `cherry-pick.test.ts`.
- Interop: cherry-pick / revert rows for every variant, TT, the valid `W×2` controls, R6 state.
- Also update the API report.

**P5 — blame `BAD_OBJECT` and `BLAME_NON_COMMIT` (D2 blame tiers, DC-1 → ADR-1141).**

- Files: `src/application/commands/blame.ts`. `blame(ctx, path, opts?) → Promise<BlameResult>` resolves `opts.rev ?? DEFAULT_REV` with `resolveCommitIsh` at line 193 and hands the id to `seed(sb, commit, path, rev, range)` (line 351). Replace that call with a private `resolveBlameTarget(ctx, revision: string): Promise<ObjectId>`:

  ```ts
  const named = await resolveCommitIshObject(ctx, revision);  // W first
  await readNamedObject(ctx, named, revision);                // does not read → BAD_OBJECT (non-hex, truncated, M)
  // peel inside a try: OBJECT_NOT_FOUND on a tag hop → blameNonCommit(revision) (absent); any other error rethrown
  ```

  git's conditions: the named object does not parse or is missing → `revision.c:369` `bad object`; the named object reads as a tag but its target is missing → `Non commit x?`. The two bare-repository/worktree `DEFAULT_REV` sites (lines 183 and 224, inside `seedWorkingTree`) keep `resolveCommitIsh`; a corrupt `HEAD` is unpinned (Out of scope).
- Error code: `BLAME_NON_COMMIT` union member and `blameNonCommit` in `src/domain/commands/error.ts` (beside `CANNOT_PICK_NON_COMMIT`); message case `Non commit ${data.revision}?` in `src/domain/error.ts`. API report.
- Tests: `test/unit/application/commands/blame.test.ts`: `BAD_OBJECT { revision }` for a named tag that does not parse and for a ref to a missing oid, each isolated; `BLAME_NON_COMMIT { revision }` for a tag whose target is missing; the `W` logged before each; an error without a code rethrown.
- Interop: blame rows (non-hex, truncated, M → `fatal: bad object x`; absent → `fatal: Non commit x?`), each after one `W`.

**P6 — merge peel fault → `REF_NOT_FOUND` (D5, DC-5).**

- Files: `src/application/commands/merge.ts` `resolveMergeParent`.
- Tests: `test/unit/application/commands/merge.test.ts`.
- Interop: merge rows (exit-1 class).

**P7 — fanout fault classifier + log (D6, DC-2, DC-4).**

- Files: `src/application/primitives/resolve-oid-prefix.ts` `scanLooseIn(ctx, source, prefix)`; reuse `errorDataCode`.
- Tests: `test/unit/application/primitives/resolve-oid-prefix.test.ts`, `abbreviate-object-id.test.ts`.
- Interop: `posix-only` suite skeleton, with rows that need only single-scan counts (packed hit, `--short`).

**P8 — failed-directory memo + miss rescan (DC-3).**

- Files: `resolve-oid-prefix.ts` (`resolveOidPrefix`, a new private memo keyed on `ctx.session` — see `primitives/internal/loose-oid-cache.ts` `fanoutCache` for the pattern).
- Tests: `resolve-oid-prefix.test.ts` (counts 2/1/1/0 matrix).
- Interop: remaining Fixture B rows (E×2, E×3, no-ref, regular file, `warnAmbiguousRefs=false`).

## Decision candidates

Each row is now ratified; the `Outcome` column gives the ADR and how it was decided.

| # | Choice | Alternatives (≤3) | Recommendation | Why | Outcome |
|---|---|---|---|---|---|
| DC-1 | Refusal for a corrupt commit-ish candidate | (a) propagate the underlying fault everywhere (`INVALID_OBJECT_ID {value}` / `OBJECT_NOT_FOUND {id}`); (b) git's two tiers on the routes where git names them: new `BAD_OBJECT {revision}` for the `get_reference` die (cherry-pick, revert, blame), the existing `CANNOT_PICK_NON_COMMIT {revision,type}` for parses-but-does-not-peel, the existing `REF_NOT_FOUND {name}` for merge; describe, blame-absent and the rebase todo propagate the fault; (c) (b) plus new git-named codes for `describe` (`neither a commit nor blob`) and `blame` (`Non commit`) | (b) | Rebuilds git's line on every route that already has a code, adds one code, and keeps describe/blame refusal parity without inventing two codes. With (a), cherry-pick `absent` would refuse with `OBJECT_NOT_FOUND` where git's condition is "not a commit". | ADR-1141: the user chose **(c)**, not the recommended (b). Adds `DESCRIBE_NEITHER_COMMIT_NOR_BLOB` and `BLAME_NON_COMMIT` (D1, D2, P3, P5). |
| DC-2 | Log shape for an unreadable fanout directory | (a) `logger.error('unable to open <dir>', { path, code })`, git's words minus the errno text; (b) ADR-887 style `logger.warn('resolveOidPrefix: unreadable loose directory', { dir, ...faultContext })`; (c) keep refusing (status quo) | (a) | Matches the `error:` channel mapping that `rev-parse-ambiguity-interop` already rebuilds. The errno text is the consumer's to render. (c) contradicts git's exit 0. | ADR-1142: (a) adopted. |
| DC-3 | Count parity for the fanout log | (a) per-session memo of failed directories + rescan on a `resolveOidPrefix` miss (git's `subdir_seen` + `odb_reprepare`); (b) stateless: log per scan + rescan on miss; (c) one log per resolution | (a) | Only (a) matches every pinned count (2, 3, 1, 3). (b) gives 4 for no-ref `rev-parse abcd` and for cherry-pick. (c) gives 1 where git gives 2. Cost: for a long-lived Context, counts on a later command run below git's per-process counts, the same equation ADR-509 already accepts. | ADR-1143: (a) adopted. |
| DC-4 | Where the fault policy lives | (a) in `scanLooseIn`, which also covers `abbreviateObjectId`; (b) only in `resolveOidPrefix`'s call | (a) | Same function, same fault. Proven: git `rev-parse --short HEAD` → exit 0 + E×1, while tsgit `abbreviateObjectId` throws `PERMISSION_DENIED` (`<scratchpad>/pin-tsgit-2.log` "B/packed"). With the memo, a `log` over many commits logs once, as git does. | ADR-1144: (a) adopted. |
| DC-5 | Fold `merge` (a separate resolver, `resolveMergeParent`) | (a) fold D5; (b) leave it out of the perimeter and report it as IMPACT | (a) | Same input, same "corrupt commit-ish" behaviour; pinned on both tools; a one-function change. | ADR-1145: (a) adopted. |
| DC-6 | Sequencer's second `repo_get_oid` | (a) fold D2 step 3 (`W×2`, E×3, range sides too); (b) skip it | (a) | Without it, the absent-row stderr and the `valid` control (`W` once vs `W×2`) both diverge on the route this change rewrites, and so does B's E×3. | ADR-1146: (a) adopted. |
| DC-7 | How the quiet read reaches the ladder | (a) thread a closed union `RevisionReadMode = 'reporting' \| 'quiet'` down to `resolveAmbiguousLadder` (as an options object, never a boolean parameter); (b) wrap `ctx.logger` with a filter during the reread | (a) | (b) cannot skip the abbreviation scan, which git also skips, so the reread's E count would be wrong. It also filters by message text. | ADR-1147: (a) adopted. |

## Test strategy

**RED first, per part.** Every interop row below is first committed and seen red against 751166b5's behaviour, inside the same part as its GREEN; the gate is never committed red. Fixtures are built with real git through `interop-helpers.ts` (`GIT_AVAILABLE`, `runGit`, `git`, `tryRunGitWithExit`, `runGitEnv`). Build each tsgit `Context` **after** the git writes: the per-session fanout cache does not see subprocess writes. Pin `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`.

**Interop suites:**

- **New `test/integration/commit-ish-corrupt-candidate-interop.test.ts`** (Fixture A ×4 variants, M, TT; one fresh repo per row because routes write state). Rows:
  - cherry-pick (single, list), revert, blame, describe, merge, `revParse x` / `x^{commit}` / `x^{blob}`, `x~5` control, `x..side` / `^x side` warning counts.
  - Each row compares `{ refused, diagnostics, state }`.
  - Diagnostics are rebuilt from `logger.warn` (`warning: <message>`), from `logger.error` (`error: <message>`), and from the refusal data:

    | Refusal data | Rebuilt line(s) |
    |---|---|
    | `BAD_OBJECT` | `fatal: bad object ${revision}` |
    | `DESCRIBE_NEITHER_COMMIT_NOR_BLOB` | `fatal: ${revision} is neither a commit nor blob` |
    | `BLAME_NON_COMMIT` | `fatal: Non commit ${revision}?` |
    | `CANNOT_PICK_NON_COMMIT` | `error: ${revision}: can't cherry-pick a ${type}` + `fatal: cherry-pick failed` / `revert failed` |
    | `REF_NOT_FOUND` on merge | `merge: ${name} - not something we can merge` |
    | rev-parse `OBJECT_NOT_FOUND` + `printed` | stdout + the `ambiguous argument` fatal, reusing `rev-parse-dwim-interop.test.ts`'s rebuild |

  - Every describe and blame row rebuilds git's line from its refusal data, like the other routes. Only the rebase todo rows (propagated fault, ADR-1141 with ADR-233) assert refusal + code + R6.
  - `state` is the presence of `CHERRY_PICK_HEAD`/`REVERT_HEAD`/`MERGE_HEAD`/`sequencer`, plus HEAD and `status --porcelain`.
- **Extend `test/integration/rev-parse-dwim-interop.test.ts`** with the dangling-symref reread control (`d^{blob}`, `d~5`), so D4 provably keeps the twice-emitted `ignoring dangling symref`.
- **New `test/integration/posix-only/rev-parse-unreadable-fanout-interop.test.ts`** for Fixture B: `chmod 000` dir, regular-file fanout, no-ref, packed clone, `warnAmbiguousRefs=false`. Routes: revParse (plain, `^{commit}`), cherry-pick, revert, blame, describe, merge, abbreviateObjectId. Each row compares the rebuilt `error: unable to open …` lines and their **count**.
  - It is gated like `posix-only/status-refresh-readonly-interop.test.ts`: `describe.skipIf(!GIT_AVAILABLE || IS_ROOT)`, and `afterEach` restores `0o755`.
  - It runs only in the `posix-integration` vitest project (CI job), not under `npm run validate`.
  - On Windows `chmod 000` is a no-op and ENOTDIR's mapping is unpinned, so both shapes stay posix-only.

**Unit tests** (GWT, AAA, `sut`; memory adapter, with a coded-fault `fs.readdir` stub for D6):

| Unit test file | Covers |
|---|---|
| `commit-ish.test.ts` | no sweep (all three faults), `resolveCommitIshObject` unpeeled, the warning now counted |
| `sequencer-revisions.test.ts` | `BAD_OBJECT`, unpeeled `type`, the second read |
| `blame.test.ts` | `BAD_OBJECT`, `BLAME_NON_COMMIT` |
| `describe.test.ts` | `DESCRIBE_NEITHER_COMMIT_NOR_BLOB`, the warning before it |
| `peel.test.ts` and `rev-parse-peel-errors.test.ts` | D3 |
| `rev-parse-misspelt-name.test.ts` and `refname-ambiguity.test.ts` | quiet mode: no warning, no scan, `warnSkipped` kept |
| `merge.test.ts` | D5 |
| `resolve-oid-prefix.test.ts` | each fault class in isolation, the memo, rescan on miss only, rethrow of an error without a code |
| `abbreviate-object-id.test.ts` | DC-4 |

**Properties:** none. No parser, matcher or round-trip pair is touched. `readHop`'s catch and `scanLooseIn`'s classifier are fault routing, not grammar, so none of the four lenses applies.

**Mutation:** run Stryker narrowed to each touched module's eponymous suites (`.claude/workflow/mutation.md`).

## Out of scope

- `loose-oid-cache.ts` `listSuffixes` (the object-read path) keeps throwing a fanout fault. git's `cat-file` on a loose object behind `chmod 000` is unpinned. Proof to pin: `git cat-file -t <loose oid under 000 dir>` vs `readObject`.
- `fsck`, `gc`, `count-objects` loose scans have their own fault handling and are untouched.
- `rev-parse --verify` / `Needed a single revision`: tsgit's `revParse` has no verify mode.
- describe of a commit-ish that peels cleanly to a tree or a blob (git's `describe_blob` / the same `neither` die): unpinned. Proof to pin: `git describe <tag-of-tree>` vs `describe`.
- blame's `DEFAULT_REV` sites over a corrupt `HEAD` commit: unpinned. Proof to pin: `git blame f` with `HEAD` on a missing commit vs `blame`.
- The rebase todo's `invalid line` and kept `rebase-merge/` state model: ADR-233 makes the todo a data list. tsgit refuses before starting.
- Refusals that touch no ladder: `show`/`log`/`rev-list` of a bare corrupt name (`bad object x`) go through `resolve-rev` without a peel and are unchanged.
- Parse codes other than `INVALID_OBJECT_ID` in `readHop` (D3): unpinned.
