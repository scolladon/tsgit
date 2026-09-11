# Spike — Config validation tier vs git's die-set (NDC-2)

> Brief: `docs/design/session-caches-per-command-floor.md` NDC-2 asks *where* a malformed
> `core.deltaBaseCacheLimit` is refused. Pin C2 shows git 2.55.0 dying in 46 of 60 commands and
> running in 14; the design proposed the operational gate plus a lazy twin and accepted five
> over-refused verbs. The question here is whether tsgit's existing gate tiers already reproduce
> git's split closely enough that "this `[core]` class is validated by tier X" needs no exemption
> list at all — and, if not, what layer shape does.
> Surfaced by: 31.2 design review · relates to ADR-637 (`core.maxTreeDepth`), ADR-850, ADR-852, ADR-858
> Status: findings complete. Three candidate mechanisms, one recommended. **No ADR is authored here;
> the decision candidates are listed in §9 for the session.**

## TL;DR

- **Git has no die-set list.** `core.deltaBaseCacheLimit` is read in exactly one library function,
  `prepare_repo_settings` (`repo-settings.c:142`), through the config-set (last-wins, dies on a
  malformed value). The 46/14 split is the set of commands that *reach* that function: 37
  builtins call it explicitly, and every object read, index read, pack enumeration and
  commit-graph load reaches it transitively. Source-pinned in §3.
- **`core.maxTreeDepth` is read in the same function** (`repo-settings.c:103`) and nowhere else.
  Across 86 probed commands × the two keys, the outcomes are identical in every cell (§5.1).
  The design calls `core.maxTreeDepth` the house pattern; it is the *first instance of the same
  drift*, not a pattern to copy.
- **tsgit has three gate tiers plus a per-consumer tier, and none of them is git's repo-settings
  tier.** The eager operational gate over-refuses this class on **three** verbs whose git
  counterparts never touch the object store — `branch.list`, `tag.list`, `branch.rename` — not
  five: `remote.*` is on the acceptance tier and already agrees, and `notes.list` / `packRefs`
  die in git whenever there is a note or a loose ref, which is when tsgit's counterparts read an
  object too (the design's "runs" rows for those two were empty-fixture artefacts, §5.3).
- The eager gate also **mis-orders** the class against the streaming classes in 19 of 24 probed
  commands; the unit test that pins "maxTreeDepth first" measured one of the 5 minority commands
  and generalised (§6).
- **The faithful boundary is tsgit's object-store entry (`getPackRegistry`), `readIndex`, and the
  commit-graph loader**, plus explicit calls transcribing git's four whole-command
  `prepare_repo_settings` calls (`rev-parse`, `worktree`, `sparse-checkout`, `stash`) and seven
  verbs where git reaches the store for a check tsgit performs differently. With those
  transcribed the residual is the 5-command ordering split, nothing else (§7, M2).
- Cost is modest and list-free: ~12 source files, no public option or type, no depcruise cycle,
  two unit ordering tests rewritten, one interop matrix added. Re-verification when git changes is
  two greps of git's source, not a 60-row matrix (§8).

## 1. Question

Backlog 31.2 makes the delta-base cache honour `core.deltaBaseCacheLimit` (ADR-852, ADR-858). A
malformed value must be refused the way git refuses it. The design's NDC-2 offers (a) eager at the
operational gate + lazy twin, (b) lazy only, (c) eager with a different ordering, and records a
pinned divergence for each. The user asked whether a *layer* could carry this instead of a
per-command exemption list, on the premise that git's own die-set is emergent. This spike
verifies the premise from git's source, tabulates tsgit's verbs against the gate each calls,
measures git for every tsgit-relevant verb (the C2 pin covered 60 git commands; this covers the
tsgit surface), and evaluates candidate mechanisms including the one floated: each `[core]` class
declares which tier validates it.

## 2. Method

- **git source**: `git clone --depth 1 --branch v2.55.0` into the scratchpad; `git describe` →
  `v2.55.0`. Every claim about *where* a key is read or which function a builtin reaches is a
  grep of that tree, cited `file:line`. Config keys are written in canonical case throughout; git
  prints them lowercased in its messages, and the C source spells them lowercased too.
- **git behaviour**: two probe scripts against the installed `git 2.55.0`, `GIT_*` scrubbed,
  isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, signing off, every
  fixture rebuilt from scratch in a `mktemp -d` per cell. Probe 1: 86 commands × 12 config states
  (clean + 11 malformed classes: `core.deltaBaseCacheLimit=-1`, `core.maxTreeDepth=abc`,
  `core.sparseCheckout=not-a-bool`, `core.compression=99`, valueless `core.excludesFile`,
  `core.logAllRefUpdates=bogus`, `diff.x.cachetextconv=bogus`, valueless `core.hooksPath`,
  `core.bare=bogus`, `extensions.worktreeConfig=bogus`, `core.repositoryFormatVersion=99`), on a
  two-commit fixture with a lightweight tag, a side branch, a note, a stash and packed objects.
  Probe 2: four two-class orderings × 24 commands; the surviving verbs × four fixture variants
  (packed/loose × lightweight/annotated tag); an empty fixture (nothing loose to pack, no notes
  ref); an eight-variant ref-kind bisect for `pack-refs --all` (nothing / branch / lightweight
  tag / annotated tag / note / stash / packed objects / pre-packed `main`). Each cell records exit
  code and the first `fatal:` line.
- **tsgit**: every exported verb in `src/application/commands/*.ts` and the namespace bindings in
  `commands/internal/*-namespace.ts`, traced to the gate it calls (directly, or through a
  per-file prologue such as `assertSparseReady`, `syncLevel`, `fetchMissingInternal`); every
  object-store, index and commit-graph entry point located; the tests that pin the current
  placement listed by line.

## 3. Git's mechanism, from source

### 3.1 Where the two keys are read

| Key | Read site | Accessor | Semantics |
|---|---|---|---|
| `core.deltaBaseCacheLimit` | `repo-settings.c:142` in `prepare_repo_settings` | `repo_config_get_ulong` (config-set) | last-wins; `git_config_ulong` → `die_bad_number` on a malformed value (`config.c:1253-1259`) |
| `core.deltaBaseCacheLimit` | `builtin/index-pack.c:1693` | streaming `git_config` callback of index-pack only | first-encountered; only `index-pack` |
| `core.deltaBaseCacheLimit` | `builtin/gc.c:219` in `gc_config` | `repo_config_get_ulong` | gc reads it *before* `prepare_repo_settings` — the one command where the key is named ahead of `core.maxTreeDepth` (§6) |
| `core.maxTreeDepth` | `repo-settings.c:103` in `prepare_repo_settings` | `repo_cfg_int` (config-set) | last-wins; **no other read site exists in the tree** |

`prepare_repo_settings` also reads 21 other keys through the same config-set path
(`commitGraph.changedPathsVersion`, `commitGraph.generationVersion`, `commitGraph.readChangedPaths`, `core.commitGraph`, `core.multiPackIndex`, `core.packedGitLimit`,
`core.packedGitWindowSize`, `core.untrackedCache`, `core.useReplaceRefs`, `feature.experimental`, `feature.manyFiles`,
`fetch.negotiationAlgorithm`, `fetch.writeCommitGraph`, `gc.writeCommitGraph`, `index.skipHash`, `index.sparse`, `index.version`,
`pack.readReverseIndex`, `pack.useBitmapBoundaryTraversal`, `pack.usePathWalk`,
`pack.useSparse`). tsgit validates none of them today. That list is the *repo-settings class*.

### 3.2 Who reaches `prepare_repo_settings`

`grep -rl prepare_repo_settings --include='*.c'` minus tests: 37 builtins and 12 library files.

| Route | Sites | What a command has to do to arrive there |
|---|---|---|
| Explicit, in the builtin | `builtin/{add, apply, blame, cat-file, check-attr, checkout-index, checkout, clean, commit, describe, diff-files, diff-index, diff-tree, diff, fetch, fsck, fsmonitor--daemon, gc, grep, log, ls-files, merge-ours, merge, pack-objects, pull, read-tree, rebase, refs, reset, rev-parse, revert, rm, sparse-checkout, stash, update-index, worktree, write-tree}.c` | be one of these 37 commands — four of them call it at the top of `cmd_*`, before any subcommand dispatch: `rev-parse.c:782` (`cmd_rev_parse`), `worktree.c:1489` (`cmd_worktree`), `stash.c:2488` (`cmd_stash`), `sparse-checkout.c:1206` (`cmd_sparse_checkout`); the rest call it on a sub-path (`log.c:678` is `cmd_show`, not `cmd_log_reflog`) |
| Any object read | `replace-object.c:103` `replace_refs_enabled` ← `lookup_replace_object` (`replace-object.h:48`) ← `odb_read_object` (default flags include `OBJECT_INFO_LOOKUP_REPLACE`, `odb.c:750`) and `parse_object` (`object.c:331`) | read one object, loose or packed |
| Packed-store enumeration | `midx.c:742` `prepare_multi_pack_index_one` ← `prepare_packed_git` (`packfile.c:1076`) | enumerate packs — including `repo_find_unique_abbrev`, which `tag -d` (`builtin/tag.c:134`) and `branch -d` (`builtin/branch.c:319`) call to print `was <abbrev>` |
| Delta / window access | `packfile.c:736`, `:1797` (`unpack_entry`) | map a pack window or unpack a delta |
| Index read/write | `repository.c:449` (`repo_read_index`), `read-cache.c` ×5 | read or write the index |
| Commit-graph, midx, bitmap, sparse index, unpack-trees, bloom, fetch negotiation | `commit-graph.c` ×3, `pack-bitmap.c`, the `.rev` reverse-index loader, `sparse-index.c`, `unpack-trees.c`, `bloom.c`, `fetch-negotiator.c` | load any of those structures |

**Confirmed: there is no list.** A command dies on this class iff its `cmd_*` calls
`prepare_repo_settings` or its work touches the object store, the index, or a derived structure.
`branch --list` and `tag -l` do neither (`builtin/branch.c:795` and `tag.c:549` run their config
callbacks, which chain to `git_default_config`, and list refs without parsing objects);
`for-each-ref` and `show-ref` parse the objects they print and die.

### 3.3 How ordering arises

`repo_config(r, fn)` does not re-read files: it iterates the already-loaded config-set in file
order (`config.c`: `repo_config` calls the set's iterator). So the streaming classes
(`core.sparseCheckout`, `core.compression`, …, handled in `git_default_core_config`) are named
when the builtin runs `git_default_config`; the repo-settings class is named when the builtin
reaches `prepare_repo_settings`. Which is reported first is the *order of those two calls inside
that builtin* — `builtin/commit.c:1605` and `builtin/diff.c:461` call `prepare_repo_settings`
before their config pass; `builtin/log.c:678` (`cmd_show`) and `builtin/rev-parse.c:782` call it
after. No per-key ordering rule exists in git.

## 4. Table 1 — every tsgit Tier-1 verb and the gate it actually calls

Gates (`src/application/primitives/internal/repo-state.ts`): **bare** = `assertRepository`
(`:98-103`: usable HEAD + discovery booleans `core.bare`, `extensions.worktreeConfig`);
**accepted** = `assertAcceptedRepository` (`:278-281`: bare + ownership trust + format refusal;
**no** eager config check); **operational** = `assertOperationalRepository` (`:320-325`: usable
HEAD + memoised {accepted + `assertEagerConfigValid`}); **none** = no repository gate. The
`commands/internal/repo-state.ts` shim re-exports the same functions. 97 verbs.

| tsgit verb | Gate | Evidence (`src/application/commands/…`) |
|---|---|---|
| `config.get`, `config.getAll`, `config.getRegexp`, `config.list` | bare | `config.ts:47, 67, 94, 123` |
| `config.set`, `config.unset`, `config.unsetAll`, `config.renameSection`, `config.removeSection` | accepted | `config.ts:153, 182, 217, 244, 269` |
| `remote.list`, `remote.add`, `remote.remove`, `remote.rename`, `remote.setUrl`, `remote.show` | accepted | `remote.ts:117, 132, 172, 229, 299, 322` |
| `init` | none | `init.ts:28-40` (presence probe only, then `bootstrapRepository`) |
| `clone` | none | `clone.ts:86` (bootstrap; no gate call) |
| `bundle.listHeads` | none | `bundle-list-heads.ts:16` (reads only the bundle) |
| `bundle.verify` | none — `layoutFailsAcceptance` → `NOT_A_REPOSITORY` | `bundle-verify.ts:52-61` (pinned: git demotes a refused repo to *absent* here) |
| `add` | operational | `add.ts:114` |
| `archive` | operational | `archive.ts:36` |
| `blame` | operational | `blame.ts:144` |
| `branch.list`, `branch.create`, `branch.delete`, `branch.rename` | operational | `branch.ts:65, 118, 143, 160` |
| `bundle.create` | operational | `bundle-create.ts:294` |
| `catFile` | operational | `cat-file.ts:39` |
| `checkout` | operational | `checkout.ts:318` |
| `cherryPick.run`, `.continue`, `.skip`, `.abort` | operational | `cherry-pick.ts:430, 535, 588, 622` |
| `commit` | operational | `commit.ts:101` |
| `describe` | operational | `describe.ts:83` |
| `diff` | operational | `diff.ts:53` |
| `fetch` | operational | `fetch.ts:92` |
| `fetchMissing` | operational (via `fetchMissingInternal`) | `fetch-missing.ts:81` |
| `fsck` | operational | `fsck.ts:58` |
| `grep` | operational | `grep.ts:177` |
| `log` | operational | `log.ts:51` |
| `maintenance` | operational | `maintenance.ts:109` |
| `merge.run`, `merge.continue`, `merge.abort` | operational | `merge.ts:166`, `continue-merge.ts:34`, `abort-merge.ts:36` |
| `mv` | operational | `mv.ts:98` |
| `nameRev` | operational | `name-rev.ts:65` |
| `notes.add`, `notes.read`, `notes.list`, `notes.remove` | operational | `notes.ts:96, 129, 150, 177` |
| `packObjects` | operational | `pack-objects.ts:78` |
| `packRefs` | operational | `pack-refs.ts:33` |
| `pull` | operational | `pull.ts:95` |
| `push` | operational | `push.ts:143` |
| `rangeDiff` | operational | `range-diff.ts:114` |
| `readFileAt` | operational | `read-file-at.ts:47` |
| `rebase.run`, `.continue`, `.skip`, `.abort` | operational | `rebase.ts:458, 533, 574, 600` |
| `reflog` (show / expire) | operational | `reflog.ts:76` |
| `reset` | operational | `reset.ts:64` |
| `revList` | operational | `rev-list.ts:123` |
| `revParse` | operational | `rev-parse.ts:36` |
| `revert.run`, `.continue`, `.skip`, `.abort` | operational | `revert.ts:414, 493, 539, 565` |
| `rm` | operational | `rm.ts:68` |
| `shortlog` | operational | `shortlog.ts:40` |
| `show` | operational | `show.ts:113` |
| `sparseCheckout.list`, `.set`, `.add`, `.reapply`, `.disable` | operational (via `assertSparseReady`) | `sparse-checkout.ts:70` |
| `stash.push`, `.list`, `.apply`, `.pop`, `.drop` | operational | `stash.ts:201, 289, 436, 495, 303` |
| `status` | operational | `status.ts:126` |
| `submodule.list`, `.add`, `.init`, `.update`, `.sync`, `.deinit` | operational (`.sync` via `syncLevel`) | `submodule.ts:454, 683, 221, 813, 306, 401` |
| `tag.list`, `tag.create`, `tag.delete` | operational | `tag.ts:68, 85, 210` |
| `whatchanged` | operational | `whatchanged.ts:87` |
| `worktree.list`, `.add`, `.move`, `.remove` | operational | `worktree.ts:61, 220, 310, 343` |

Totals: bare 4 · accepted 11 · none 4 · operational 78. No gate is reached transitively through
a shared primitive: `grep assert(Operational|Accepted)?Repository\(` outside `commands/` hits
only `repo-state.ts` itself. `repo.primitives.*` (Tier 2) is ungated by design and is outside
this table; §7 notes what M2 does to it for free.

A fourth, **per-consumer tier** already exists and is the precedent for "a class declares its
own tier": `assertValidPackIntConfig` (`pack-objects.ts:79`, `bundle-create.ts:295`,
`gc-pipeline.ts:882`), `assertValidGcAutoConfig` (`gc-pipeline.ts:95`), valueless `core.hooksPath`
at `run-hook.ts:71`, `user.name`/`email` at `commit.ts:132`, `remote.<n>.url` at `fetch.ts:235` /
`push.ts:224`, `tag.gpgsign` at `tag.ts:89`, `filter.<d>.required` at `resolve-filter-driver.ts:32`.
Each of those keys refuses where git consumes it. The repo-settings class is the only git tier
with no tsgit counterpart: both of its keys tsgit validates were placed on the eager tier.

## 5. Table 2 — git's die-set beside tsgit's tiers, both directions

"git" = outcome on `core.deltaBaseCacheLimit=-1`, identical to `core.maxTreeDepth=abc` in every
row (§5.1). "tsgit today" = what the eager gate does to `core.maxTreeDepth` now and would do to
the new key under NDC-2 (a). "M2" = the object-store tier of §7 *before* the explicit-call
transcription; "M2+" = after it. **D** = refuses, **R** = runs.

### 5.1 The two keys are one class

Probe 1, 86 commands: the `core.deltaBaseCacheLimit=-1` and `core.maxTreeDepth=abc` columns agree
in all 86 cells (exit code and whether the fatal names the key). Probe 2, ordering: with both
malformed, `core.maxTreeDepth` is named first in 23 of 24 commands in either file order; `gc`
names `deltaBaseCacheLimit` first (`builtin/gc.c:219` precedes its `prepare_repo_settings`).
Whatever tier tsgit gives one of these keys is the tier it is giving the other.

### 5.2 Where tsgit and git disagree

| git command | tsgit verb | git | tsgit today | agree | M2 | M2+ | why |
|---|---|---|---|---|---|---|---|
| `branch --list` | `branch.list` | R | D | **no** | R | R | git lists refs without parsing objects; tsgit `branchList` reads refs only (`branch.ts:64-79`) |
| `tag -l` | `tag.list` | R | D | **no** | R | R | same (`tag.ts:67-82`) |
| `branch -m` | `branch.rename` | R | D | **no** | R | R | rename touches refs and reflogs only; git and tsgit alike |
| `rev-parse <any>` | `revParse` | D | D | yes | **R** for a ref or oid form | D | git: explicit `rev-parse.c:782`; tsgit `resolveBase` returns from the ref store without a read (`rev-parse.ts:61-79`); `HEAD~1`/`HEAD:a` forms read objects and refuse either way |
| `reflog show` | `reflog` | D | D | yes | **R** | D | git's `reflog show` is `log -g` (`cmd_log_reflog`, `log.c:780`): it parses each entry's commit; tsgit show reads the reflog file only (`expire` walks commits and refuses either way) |
| `worktree list/move/remove` | `worktree.list`, `.move`, `.remove` | D | D | yes | **R** | D | git: `worktree.c:1489` in `cmd_worktree`, once for every subcommand; tsgit reads `worktrees/*` files and renames (`.remove` runs `status` on the child only when not forced, `worktree.ts:347-349`) |
| `sparse-checkout list` | `sparseCheckout.list` | D | D | yes | **R** | D | git: `sparse-checkout.c:1206` in `cmd_sparse_checkout`; tsgit reads config + the sparse file; `set/add/reapply/disable` read the index and refuse either way |
| `stash list` | `stash.list` | D | D | yes | **R** | D | git: `stash.c:2488`; tsgit `readStashStack` reads the stash reflog only |
| `branch <new>` | `branch.create` | D | D | yes | **R** | D | git verifies the start point through the object store; tsgit `resolveBranchTarget` resolves the ref only (`branch.ts:227-241`) — see §9 DC-C |
| `branch -d` | `branch.delete` | D | D | yes | **R** | D | git: merged-ness (`branch.c:161`) + `was <abbrev>` (`:319`); tsgit `refExists` + `updateRef` |
| `tag -d` | `tag.delete` | D | D | yes | **R** | D | git: `was <abbrev>` (`tag.c:134`); tsgit `refExists` + `updateRef` |
| `tag <new>` (lightweight) | `tag.create` | D | D | yes | **R** | D | git types the target through the store (`tag.c:658`, `:404`); tsgit's lightweight path is `resolveRef` + `updateRef` (`tag.ts:91-92`), and only the annotated path reads the target (`resolveObjectType`, `tag.ts:182`) |
| `submodule init` / `sync` | `submodule.init`, `.sync` | D | D | yes | **R** | D | git's `submodule--helper` reads the index before listing modules (`submodule--helper.c:237`); tsgit reads `.gitmodules` from the worktree (`submodule.ts:102-113`) and writes config |
| `remote -v` etc. (6) | `remote.*` | R | R | yes | R | R | acceptance tier, no eager check — the design's NDC-2 counted `remote` among the over-refused verbs; it is not |
| `config` (all forms) | `config.*` | R | R | yes | R | R | bare / acceptance tier |
| `init` | `init` | R | R | yes | R | R | ungated bootstrap |
| `bundle verify`, `bundle list-heads` | `bundle.verify`, `.listHeads` | R | R | yes | R | R | ungated (pinned in `max-tree-depth-config-interop.test.ts:381-400`) |

### 5.3 Fixture-conditional rows (the design's C2 "runs" that are really "runs when idle")

| git command | fixture | git | tsgit today | M2 | mechanism |
|---|---|---|---|---|---|
| `pack-refs --all` | nothing loose to pack | R | D (over-refuse) | R | git iterates zero refs and reads nothing; tsgit `peelToNonTag` (`ref-store.ts:845-863`) is not reached |
| `pack-refs --all` | ≥1 loose ref of any kind (branch, lightweight or annotated tag, note, stash; objects loose or packed — all 8 variants probed) | **D** | D | D | git peels every packed ref through the object store; tsgit calls `readObject` per packable entry |
| `notes list` | no notes ref | R | D (over-refuse) | R | nothing to read on either side |
| `notes list` | a note exists | **D** | D | D | git parses the notes tree; tsgit `loadNotesTree` → `readObject` |

Under an object-store tier these two verbs agree with git in *both* fixtures without any
per-verb code — the strongest single piece of evidence for that placement. The design's C2 row
is not wrong, it is conditional, and the condition is "touches an object".

### 5.4 Rows that agree today and keep agreeing

Every other operational verb reads an object, the index or the commit-graph before it writes,
and its git counterpart dies: `add`, `archive`, `blame`, `bundle.create`, `catFile`, `checkout`,
`cherryPick.*`, `commit`, `describe`, `diff`, `fetch`, `fetchMissing` (no git counterpart; reads
through the registry), `fsck`, `grep`, `log`, `maintenance` (`gc` / `maintenance run`),
`merge.*`, `mv`, `nameRev`, `notes.add/read/remove`, `packObjects`, `pull`, `push`, `rangeDiff`,
`readFileAt` (`rev-parse HEAD:a` probed D), `rebase.*`, `reset`, `revList`, `revert.*`, `rm`,
`shortlog`, `show`, `stash.push/apply/pop/drop`, `status`, `submodule.list/add/update/deinit`,
`tag.create` with `annotate`/`message` (reads the target to type it; the lightweight form is in
§5.2), `whatchanged`, `worktree.add`. One boundary caveat
for M2: `walk-commits.ts:78` prefers the commit-graph header and `read-commit-graph.ts:131` loads
the graph with a raw `ctx.fs.read`, so a walk over a fully-graphed repository can finish without
ever constructing the registry — the graph loader must carry the check exactly as
`commit-graph.c` does (three `prepare_repo_settings` sites).

### 5.5 git commands with no Tier-1 counterpart (rows not forced)

Runs in git, no tsgit verb: `symbolic-ref`, `check-ref-format`, `hash-object` (without `-w`;
`primitives.hashBlob` is Tier 2 and ungated — agrees), `count-objects`, `var`, `prune`,
`bisect log`. Dies in git, no tsgit verb: `for-each-ref`, `show-ref`, `update-ref`
(`primitives.updateRef`, Tier 2, ungated — runs; out of scope, recorded), `ls-files`,
`hash-object -w`, `write-tree`, `read-tree`, `merge-base`, `ls-tree`, `check-ignore`, `check-attr`
(the Tier-2 twins `readIndex`, `writeObject`, `writeTree`, `mergeBase`, `walkTree`, `isIgnored`
would refuse under M2 because they enter the store or the index), `switch` (≈ `checkout`),
`repack`, `clean`, `apply`, `verify-pack`, `index-pack`, `ls-remote`.

### 5.6 Two pre-existing divergences the probe surfaced on *other* classes

Recorded, not acted on here. `remote -v/add/remove/rename/set-url/show` and `ls-remote` die on
`core.logAllRefUpdates=bogus` in git (probe 1, the `core.logAllRefUpdates` column) while tsgit's acceptance tier
runs — one class, the other direction. And `hash-object`, `count-objects`, `var` die on the
streaming classes; tsgit has no Tier-1 counterpart, so nothing to fix.

## 6. Is `core.maxTreeDepth` a faithful house pattern?

No, on two counts, both measured.

**Tier.** Same class as the new key (§3.1, §5.1). `assertEagerConfigValid` (`repo-state.ts:211-244`)
throws it on every operational verb, so `branch.list`, `tag.list` and `branch.rename` refuse a
malformed `core.maxTreeDepth` today where git 2.55.0 runs (probe 2C: `branch --list` and `tag -l`
exit 0 on `core.maxTreeDepth=abc`; probe 1: `branch -m` exit 0). The lazy twin
`resolveMaxTreeDepth` (`internal/resolve-max-tree-depth.ts`, 8 call sites) is the part that *is*
at git's boundary — every caller is a tree walk.

**Ordering.** The gate throws `core.maxTreeDepth` before the five streaming classes
unconditionally, and `repo-state.test.ts:1356-1402` pins "maxTreeDepth wins over an earlier-line
`loosecompression` / `sparseCheckout`" with a comment that it was measured. Probe 2A, 24
commands, either file order:

| Named first by git | Commands |
|---|---|
| the streaming class (`core.sparseCheckout` / zlib level) | `log`, `rev-parse`, `cat-file`, `for-each-ref`, `show-ref`, `branch <new>`, `tag <new>`, `notes list`, `checkout`, `add`, `describe`, `rev-list`, `reflog show`, `worktree list`, `stash list`, `sparse-checkout list`, `archive`, `fsck`, `gc` — **19** |
| `core.maxTreeDepth` | `status`, `commit`, `diff`, `bundle create`, `rebase` — **5** |

The measurement behind the pin was taken on a minority-set command (`status` or `commit`) and
generalised. This is the same 5/19 split as the design's C3 for the new key, because it is the
same mechanism (§3.3). No single eager order can match both sets; only the boundary placement
reproduces the 19 for free.

## 7. Candidate mechanisms

Re-tiering caveat, applied throughout: **a mechanism that moves a *verb* between gates changes
every refusal that verb makes; a mechanism that moves a *class* between tiers changes only that
class's refusal.** M1–M3 all keep every verb on the gate Table 1 shows; only the class moves. The
per-verb consequences below therefore enumerate the class's own outcome per verb; every other
refusal (discovery booleans, ownership, format, the five streaming classes, work-tree,
pending-operation) is byte-identical under all three. A per-command exemption list (the shape
the user first asked for) is dominated by M2 on every axis and is not a candidate.

### M1 — Eager at the operational gate (design NDC-2 (a); the current `core.maxTreeDepth` shape)

`assertEagerConfigValid` runs `findLastInvalidDeltaBaseCacheLimit` after the streaming pick
(skipped when `cacheBudgets.deltaBaseCacheMaxBytes` is set, C5); `resolveDeltaBaseCacheLimit`
guards the primitive path.

- Pros: one boundary, one memoised verdict, the smallest diff, already fully specified in the
  design (P3). No list.
- Cons: refuses `branch.list`, `tag.list`, `branch.rename` where git runs (3 verbs, not 5);
  refuses `packRefs` / `notes.list` on the idle fixture where git runs; names the class before
  the streaming classes in 19 commands where git names it after (or, with the design's
  "after" ordering for the new key, after in the 5 where git names it first — and then the two
  keys of one git class sit at opposite ends of one tsgit function). Every divergence must be
  re-pinned against the 60-command C2 matrix whenever a git builtin adds or drops a
  `prepare_repo_settings` call.
- Per-verb consequences: none change relative to today for `core.maxTreeDepth`; the new key
  inherits exactly the maxTreeDepth outcome per verb (§5.1).
- Cost: `config-read.ts`, `repo-state.ts`, new `internal/resolve-delta-base-cache-limit.ts`,
  `pack-registry.ts`, `read-object.ts` (async registry). No public option. depcruise: inward
  edges only. Tests: `repo-state.test.ts` (+C3/C5), `config-interop` (+C1–C4 with three
  over-refused verbs recorded as divergence).

### M2 — The class declares its tier: a repo-settings tier at the object-store boundary (recommended)

The floated shape, made concrete. A `[core]` class = `{ core.maxTreeDepth, core.deltaBaseCacheLimit }`
(extensible to the 21 other keys of §3.1 as they are honoured), validated by one function —
`assertRepoSettingsValid(ctx)` in a new `primitives/internal/repo-settings-gate.ts` — which
runs the two last-wins finders (the new key's skipped under C5), throws
`CONFIG_BAD_NUMERIC_VALUE`, and is memoised per session in `config-read.ts` beside
`gateVerdictCache` so `invalidateConfigCache` drops both (the reason that memo lives there,
`config-read.ts:256-279`). It is called from:

1. the object-store entry — inside the async `createPackRegistry` the design's P3 already
   introduces, so every registry construction is covered, loose or packed: the three
   `read-object.ts` entries (`:154,166,228`), `fetch-missing.ts:66`'s own `createPackRegistry`,
   and the ~17 `getPackRegistry` callers (`hasObject`, `resolveOidPrefix`, `enumerateObjects`,
   `closure-engine`, `blob-source`, the fsck/gc internals);
2. `readIndex` (`read-index.ts`), git's `repo_read_index` route;
3. the commit-graph loader (`read-commit-graph.ts:131`), git's `commit-graph.c` route (§5.4);
4. **explicit calls transcribing git's four whole-command `prepare_repo_settings` calls** — one
   per prologue, right after the operational gate: `revParse` (`rev-parse.c:782`), `worktree.*`
   (`worktree.c:1489`, shared prologue), `sparseCheckout.*` (`sparse-checkout.c:1206`, in
   `assertSparseReady`), `stash.*` (`stash.c:2488`, shared prologue);
5. **explicit calls where git reaches the store for a check tsgit performs differently** —
   `reflog` (show parses each entry's commit in git), `branch.create`, `branch.delete`,
   `tag.create` (lightweight), `tag.delete`, `submodule.init`, `submodule.sync` (§5.2).

Without groups 4–5, thirteen verbs would run where git dies: `revParse` (ref and oid forms),
`reflog` (show), `worktree.list`, `worktree.move`, `worktree.remove` (forced),
`sparseCheckout.list`, `stash.list`, `branch.create`, `branch.delete`, `tag.create`
(lightweight), `tag.delete`, `submodule.init`, `submodule.sync`.

`findLastInvalidMaxTreeDepth` leaves `assertEagerConfigValid`; `resolveMaxTreeDepth` keeps its
refusal (harmless redundancy on the primitive path, exactly as today).

Groups 4 and 5 are per-verb calls. They are not an exemption list: they are the faithful
transcription of git's own per-builtin `prepare_repo_settings` calls, in the same shape as
`requireWorkTree(ctx, op)` transcribes git's `NEED_WORK_TREE`. Group 5 is the honest part to
argue about — see §9 DC-C.

- Pros: reproduces git's die-set *and* its fixture dependence (§5.3) with no matrix; reproduces
  the majority ordering (19/24) with no ordering code; puts both keys of one git class on one
  tsgit tier; gives every Tier-2 store/index/graph primitive the refusal git's plumbing has, for
  free; re-verification when git changes is `git grep -l prepare_repo_settings builtin/` and the
  key list of `repo-settings.c`, both greppable.
- Cons: touches ~12 source files instead of 5; re-opens ADR-637's placement of
  `core.maxTreeDepth` (DC-B); the refusal fires at first store/index/graph touch rather than at
  the gate, so the implementation must assert per verb that the first touch precedes the first
  write (true for every verb read in this spike, and the transcribed prologues make it trivially
  true for the thirteen that would otherwise touch neither; the plan should pin the rest against
  the `@writes` surface audit rather than trust this reading); residual ordering mismatch in `status`,
  `commit`, `diff`, `bundle.create`, `rebase` (git names the class first there; tsgit names the
  streaming class first) — the same 5 as M1-with-majority-order, without the rule.
- **Per-verb consequences** (class outcome only; nothing else moves):
  - `branch.list`, `tag.list`, `branch.rename`: newly **run** on a malformed value — faithful
    (§5.2). No existing test pins the over-refusal (`branch.test.ts`, `tag.test.ts` carry no
    `CONFIG_BAD_NUMERIC_VALUE` case); `max-tree-depth-config-interop.test.ts` gains three
    "git exits 0 and tsgit succeeds" rows.
  - `packRefs`, `notes.list`: newly run on the idle fixture, still refuse otherwise — faithful
    both ways (§5.3). `pack-refs.test.ts` / `notes.test.ts` pin neither today.
  - the thirteen transcribed verbs (`revParse`, `reflog`, `worktree.list/.move/.remove`,
    `sparseCheckout.list`, `stash.list`, `branch.create`, `branch.delete`, `tag.create`,
    `tag.delete`, `submodule.init`, `submodule.sync`) and the other verbs sharing those
    prologues: same
    outcome as today (refuse), now via the explicit call; only the two-class *order* changes,
    to git's majority.
  - the ~64 remaining operational verbs: same outcome, fired at the first store/index/graph
    touch instead of the gate; order changes to git's majority except the 5 above.
  - `config.*`, `remote.*`, `init`, `clone`, `bundle.verify/listHeads`: untouched.
- Cost: `config-read.ts` (parse + finder + second memo), `repo-state.ts` (−1 finder),
  new `internal/repo-settings-gate.ts`, `pack-registry.ts` / `read-object.ts` (P3's async
  constructor, one call), `read-index.ts`, `internal/read-commit-graph.ts`, `rev-parse.ts`,
  `reflog.ts`, `worktree.ts`, `sparse-checkout.ts`, `stash.ts`, `branch.ts`, `tag.ts`,
  `submodule.ts`. No public option, no public type. depcruise: `read-index.ts` /
  `read-commit-graph.ts` / `pack-registry.ts` → `internal/repo-settings-gate.ts` →
  `config-read.ts`, whose import closure contains no object-store, index or graph module (pinned
  in the design's ledger), so `no-circular` holds; commands → `primitives/internal` has precedent
  (`merge.ts:41`). Tests: move `repo-state.test.ts:1265-1442` (7 cases) to the gate's own file,
  **rewrite** the two ordering cases (`:1356-1402`) as an interop matrix with the 19/5 split;
  add one first-touch refusal test each to `read-object`, `read-index`, `read-commit-graph`;
  one zero-extra-stat assertion under `instrumentedContext` (the finders read the epoch-trusted
  tokens, so R2's floor is unchanged); `config-interop` C2 on the tsgit surface both fixtures.
  Mutation: the memo's single-flight and eviction mirror `memoizeGateVerdict`'s existing kill
  tests.

### M3 — Lazy only, at the consumer (design NDC-2 (b))

`resolveDeltaBaseCacheLimit` at registry construction; nothing at the gate; `core.maxTreeDepth`
untouched.

- Pros: smallest possible diff; the check is where the value is consumed.
- Cons: the thirteen verbs M2 transcribes run where git dies, and the design's floor `revParse('HEAD')`
  path is one of them (fail-open on the most common command); index-only and graph-only paths are
  uncovered; the two keys of one git class stay on two tsgit tiers; a command can start work
  before refusing. Everything M2's boundary gives, minus the transcription — M2 with groups 2–5
  deleted.
- Per-verb consequences: `branch.list`, `tag.list`, `branch.rename` run (faithful); `packRefs`,
  `notes.list` fixture-faithful; the thirteen verbs above newly run (divergence); the rest
  unchanged in outcome.
- Cost: `config-read.ts`, `resolve-delta-base-cache-limit.ts`, `pack-registry.ts`,
  `read-object.ts`; tests as M1 minus `repo-state`; re-verification as M1.

### Recommendation

**M2.** It is the only mechanism whose die-set is a *function* of the same thing git's is
(touching the store, the index, a derived structure, or an explicit builtin call), so it needs
no matrix to maintain and gets the fixture dependence right by construction. M1 is what tsgit
already does for `core.maxTreeDepth`, and §6 shows that shape is already drifted on tier and on
order; adding a second key to it doubles the drift. M3 is M2 without the part that keeps
`revParse`, `reflog` and `worktree.list` faithful.

## 8. Answer to the load-bearing question

Does tsgit's tier split already reproduce git's die-set closely enough that "the operational tier
validates this class" needs no exemption list? **No.** The residual, exactly:

- tsgit **full tier** verbs whose git counterpart runs: `branch.list`, `tag.list`,
  `branch.rename` (unconditionally), and `packRefs`, `notes.list` (when there is nothing to pack /
  no notes ref).
- tsgit **bare or acceptance tier** verbs whose git counterpart dies on this class: none.
  `config.*` and `remote.*` agree with git on this class in every probed form.
- ordering: the operational tier names the class first in 19 commands where git names the
  streaming class first.

The acceptance and bare tiers line up with git for this class; the operational tier does not, and
no tier of tsgit's corresponds to `prepare_repo_settings`. M2 adds that tier as a class
property; with it the residual is the 5-command ordering split only.

## 9. Decision candidates for the session (not decided here)

| # | Choice | Alternatives (≤3) | Recommendation |
|---|---|---|---|
| DC-A | Mechanism for the repo-settings class | M1 eager gate · **M2 class-declared tier at the store/index/graph boundary + transcribed explicit calls** · M3 lazy only | M2 |
| DC-B | Whether `core.maxTreeDepth` moves with it (re-opens ADR-637's placement, keeps its grammar and lazy twin) | move now, in 31.2 · leave, class of one · move in a follow-up | move now — §5.1 shows it is the same class, §6 shows its current placement carries the same drift, and the unit ordering tests it would touch pin a minority-set measurement |
| DC-C | Group-5 verbs (`reflog` show, `branch.create`, `branch.delete`, lightweight `tag.create`, `tag.delete`, `submodule.init/.sync`), where git reaches the store for a check or a display tsgit does differently | transcribe the explicit call (refusal parity) · record as residual (structural honesty) · close the underlying gap where one exists (`branch.create` does not verify its start point is a commit — `git branch x <tree-oid>` refuses, tsgit does not; a real missing refusal, surfaced here, not this item's scope) | transcribe the call now; raise the `branch.create` verification gap with the session rather than filing it silently |

## 10. Repro

git source: `git clone --depth 1 --branch v2.55.0 https://github.com/git/git.git`, then
`grep -rni 'deltaBaseCacheLimit\|maxTreeDepth' --include='*.c'` and
`grep -rl prepare_repo_settings --include='*.c' | grep -v '^t/'`.

Probe shape (per cell, throwaway `mktemp -d`, `GIT_*` scrubbed, `HOME` isolated,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `commit.gpgsign=false`):

```sh
git init -q -b main r && cd r
echo one > a && git add a && git commit -qm c1 && echo two > a && git commit -qam c2
git tag t1 && git notes add -m n HEAD && git branch side && git -c pack.threads=1 repack -adq
git config --file .git/config core.deltaBaseCacheLimit -1      # or core.maxTreeDepth abc, …
git branch --list; echo $?                                       # 0
git pack-refs --all; echo $?                                     # 128 (a loose ref exists)
git config --file .git/config core.sparseCheckout not-a-bool     # second class, later line
git config --file .git/config core.maxTreeDepth abc
git log -1 2>&1 | head -1                                        # names core.sparseCheckout first
git status 2>&1 | head -1                                        # names core.maxTreeDepth first
```

The two probe scripts (86 × 12 and the ordering/fixture matrix) live in the session scratchpad
and are not committed; the pivoted results are reproduced in §5–§6 verbatim.
