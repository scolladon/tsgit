# Spike — faithfulness triage, Tiers 3–5 and the grafts/replace gap

**Date:** 2026-10-06
**Question:** where does tsgit still differ from git on merge/rebase/checkout, fetch/push/remote, object names and graph/storage, once the data-integrity and everyday-flow gaps (Tiers 1–2) are fixed?
**Method:** each item was probed against tsgit snapshot `4fcbdc53` and git 2.55.0 run with a scrubbed environment. Where a probe was not possible the item says so.

**Verdict:** the items below are real gaps, not yet fixed. They feed backlog items 32.1–32.4. Items marked **verify on main** may overlap a fix that landed afterwards: re-probe them before starting.

**Evidence labels.** *Pinned* means the report states git's result and tsgit's result for the same input. *Note only* means the report records the gap without such a comparison (read from source, or tsgit's side only): evidence is the triage note only, re-probe before fixing. Probe scripts and raw outputs are not kept in the repository; the evidence lines restate what the reports recorded.

Item ids are `<slice><number>`: A merge/rebase/sequencer/checkout, B fetch/push/remote, C object names, D graph/storage/misc. Counts: 50 items, 41 pinned, 9 note only.

---

## Tier 3 — refusal mismatches (backlog 32.1)

19 items, 17 pinned, 2 note only.

| id | gap | evidence |
|---|---|---|
| A2 | merge refuses when only `REVERT_HEAD` or `REBASE_HEAD` exists | tsgit refuses; git merges (exit 0). Pinned. |
| A6 | `checkout -- <unmerged path>` (index source) succeeds silently | tsgit succeeds silently; git fails with `path is unmerged`. Pinned. |
| A13 | octopus merge with a directory/file conflict | tsgit throws a raw `NOT_A_DIRECTORY` and leaves untracked files from the partial step. git records a conflict (exit 1) at the last step and refuses with `Should not be doing an octopus` (exit 2) at a middle step. Pinned. |
| A20 | `branch.create` from `@{-1}` tracking | tsgit throws `UPSTREAM_NOT_BRANCH` with `track: 'direct'`, and writes no tracking config with `autoSetupMerge=always`. git's result is not recorded in the note. Note only. |
| A21 | checkout with an unborn HEAD pointing at a non-heads ref | tsgit throws `REF_NOT_FOUND`; git switches and logs `(invalid)`. Pinned. |
| A22 | `checkout --detach <x>` | tsgit says `PATHSPEC_NO_MATCH`, even for a tracked file; git says `--detach does not take a path argument`. Pinned. |
| A23 | `checkout <remote>/<name>` DWIM | tsgit gives `PATHSPEC_NO_MATCH`; git creates the tracking branch. Pinned. |
| B5 | fetch `force` / `showForcedUpdates` options | tsgit has no such option; a `+` refspec is the only way to force. git's side is not recorded. Note only. **verify on main** |
| B13 | two sources for one destination in a push | tsgit sends both to the server, which rejects both; git refuses on the client before connecting. Pinned. |
| B17 | mirror refspec (`+refs/heads/*:refs/heads/*`) with `^refs/heads/feat` | tsgit maps feat's upstream to itself and `branch -d` deletes the unmerged branch; git refuses with `not fully merged`. With the standard layout both behave the same. Pinned. |
| C6 | leading `-x` argument | git dies with `option '-x' must come before non-option arguments` before checking for a file; tsgit's `revParse('-x')` returns a path entry when a file named `-x` exists. Pinned. |
| C22 | cherry-pick or revert of a tag of a tree | git reports `can't cherry-pick a tag` for any tag argument; tsgit's `CANNOT_PICK_NON_COMMIT` carries the peeled type (`tree` or `blob`). Pinned. |
| D16 | diff-driver config read too eagerly | with `diff.foo.binary=maybe` (also `cachetextconv`, `trustexitcode`, or a valueless `textconv`), git `add`, `reset` and `checkout -- path` exit 0 and tsgit refuses all three. With `diff.renames=maybe`, git `status` dies and tsgit `status` succeeds. Pinned. |
| D15 | `a/../b` pathspecs | `a/../b`, `d/../b` and `link/../b` are normalised to `b` and staged by git; tsgit throws `PATHSPEC_OUTSIDE_REPO`. The beyond-symlink refusal matches, but its message shows the basename `f` instead of `'link/f'`. Pinned. |
| D9 | linked worktree with a garbage HEAD | git `fsck` reports `badRefContent` and exits 8, `gc` succeeds; tsgit `fsck` throws `INVALID_OBJECT_ID` and `maintenance(gc)` fails the task. Pinned. |
| D10 | grep tree-ish resolution | mistyped tags make git die (`is a commit, not a tree` / `invalid object … given`) and tsgit greps the peeled object anyway. For a blob target (`<blob>`, `HEAD:f1`, a tag pointing to a blob) git greps the blob and tsgit throws `OBJECT_NOT_FOUND` for an object that exists. Pinned. |
| D19 | valueless `branch.x.merge`, local or global scope | git `branch -d` and long `status` die with `missing value` / `bad config variable`; tsgit `branch.delete` deletes and `status` succeeds. Pinned. **verify on main** |
| D22 | `walkTree` skips a non-tree subtree | on a forged tree whose `sub` entry is a blob, git `grep` and `archive` die; tsgit returns `['a']` because `strictSubtrees` defaults to false and grep, archive, checkout and notes do not turn it on. `checkout` differs only by git's `error:` line. Pinned. |
| D5 | `writeExclusive` when the parent is a file | the Node adapter returns `FILE_EXISTS`; the memory adapter and the OS return `NOT_A_DIRECTORY`. On Node, atomic writes turn that into a "lock held" refusal and `write-object` treats it as "object already exists", a silent success. Reachable only on a corrupt layout. Pinned. |

## Tier 4 — message only (backlog 32.2)

11 items, 9 pinned, 2 note only.

| id | gap | evidence |
|---|---|---|
| A14 | octopus never logs `Simple merge did not work, trying automatic merge.` or `Auto-merging <path>` | settled by reading tsgit's source. Note only. |
| A26 | blame on an unreadable parent | tsgit warns once; git warns twice. Pinned. |
| B11 | push of a missing source | tsgit throws a generic `REF_NOT_FOUND`; git prints `src refspec X does not match any` and `failed to push some refs`. Neither sends anything. Pinned. |
| C3 | `:path` refusals | git has four distinct diagnostics plus hints; tsgit throws a generic `OBJECT_NOT_FOUND` whose `id` is a fake string such as `0:absent`. Pinned. |
| C9 | pack-objects ambiguity warning | tsgit logs the full-oid-also-a-ref ambiguity warning plus its advice; git's stdin source does not. Pinned. **verify on main** |
| C10 | `excluding` in log/shortlog/whatchanged | the arguments resolve through `Promise.all`, so tsgit warns about arguments after the first bad one, which git never reaches. Pinned. |
| C19 | bogus loose object type | tsgit refuses at the same point as git but does not log the preceding `short object ID … is ambiguous` line. Pinned. **verify on main** |
| D3 | GDA2 misfit message | for a layer the chain check later refuses, git prints `error: commit-graph generations chunk is wrong size` while parsing; tsgit only warns over the layers that survive assembly. Pinned. **verify on main** |
| D7 | `mark_tagged` logs | `echo main \| git pack-objects --revs` with a mistyped tag ref present prints `is a tree, not a commit` and `bad tag pointer` and exits 0; tsgit has no write-order pass and logs nothing. With the bad tag ref inside the enumeration (`--all`, `repack -ad`), git dies at setup with `fatal: bad object refs/tags/t`. Pinned. |
| D12 | Bloom chunk warnings on read | git warns on every graph load about a short BIDX, a short BDAT, or layers with incompatible Bloom settings; tsgit never reads Bloom chunks on the read side, so it never warns. The hash-version relabel and the non-integer `changedPathsVersion` refusal already match. Pinned. |
| D6 | midx error shape | the error carries a `check` enum plus a prose `reason`; every internal consumer branches on `check`. An API-design point, no git comparison. Note only. |

## Tier 5 — edge: corrupt or forged objects, rare config (backlog 32.3)

19 items, 14 pinned, 5 note only.

| id | gap | evidence |
|---|---|---|
| A3 | stale `SQUASH_MSG` / `MERGE_MODE` on `--continue` | tsgit leaves both behind; git removes them and puts the `SQUASH_MSG` text into the commit message. Pinned. |
| A4 | `--quit` | does not exist for merge, cherry-pick or revert in tsgit. git's side is not recorded. Note only. |
| A10 | `info/grafts` in rebase linearity | tsgit never reads `info/grafts`, so a graft-linearized branch gets rebased where git says it is up to date. Shallow boundaries are already masked. Pinned. |
| A25 | blame reading a missing parent from the commit-graph | tsgit attributes lines to the wrong commit, and returns a full result where git would die. Pinned. **verify on main** |
| B3 | second backfill fetch | tsgit makes none; it matters only with servers that ignore `include-tag`. Checked from source only. Note only. |
| B9 | forged unsafe tag name | with a forged server, git exits 1 with `refusing to update ref with bad name 'refs/tags/a..b'` and still writes the tag line to `FETCH_HEAD`; tsgit succeeds, logs `* Ignoring funny ref` and leaves that line out. Pinned. |
| B15 | v2 `option` line without a matching `ok` | aborts tsgit's whole parse; git logs the error, keeps parsing, then fails. Checked from source only. Note only. |
| B20 | push and bundle create do not pass `sparse` to the object walk | git's pack-objects defaults to sparse; only the pack's object set can differ. Source reading. Note only. |
| C11 | forged tag (`type commit` pointing at a tree) | git `name-rev lie` exits 0 with `tags/lie`; tsgit refuses. `archive` fails on both sides, git with `not a tree object: <tag>` and tsgit with `OBJECT_NOT_FOUND <tree>`. Pinned. |
| C17 | tag with `type bogus` | git prints `unknown tag type` errors and carries on; tsgit throws `INVALID_TAG` with no logs, and `nameRev('HEAD')` and `describe` refuse. Pinned. |
| C18 | unparsable loose header | git refuses with an ambiguity listing (`[bad object]` plus two error lines); tsgit throws `INVALID_OBJECT_HEADER` instead of `AMBIGUOUS_OID_PREFIX`. Pinned. |
| C20 | malformed commit behind a tag | git prints `bogus commit object` errors and refuses as "no object"; tsgit throws `INVALID_COMMIT`, and `nameRev` refuses where git answers. Pinned. |
| C21 | malformed commit sharing an abbreviated prefix (a real collision found by brute force) | git picks it by header type alone and lists it as `commit  - ` in reads without a hint; tsgit throws `INVALID_COMMIT` for all five forms, losing the ambiguity refusal. Pinned. |
| C-S1 | huge `^-N` | `rev-parse main^-4294967297`: git truncates the number to 1 and answers; tsgit refuses. Pinned. |
| C-S2 | malformed `core.bigFileThreshold` in archive | git `archive` dies; tsgit succeeds. Pinned. **verify on main** |
| C-S3 | `log` with `excluding: [<blob>]` | tsgit refuses; git accepts `log main ^<blob>`. Pinned. |
| D1 | stale per-session graph cache | after the session writes a graph it never reads it (0 file reads; a fresh open does read it). No result difference found, only lost acceleration. tsgit side only. Note only. |
| D4 | ragged OIDL/CDAT tail | git loads a graph with 5 extra bytes on OIDL or CDAT (it counts whole entries); tsgit refuses with `truncated OIDL chunk: expected 60, got 65` and falls back to reading objects. Results differ only for a forged graph. Pinned. |
| D13 | `changedPaths=true` with `changedPathsVersion=0` | git 2.55 aborts with `BUG(): chunk-format.c:96` (exit 134, or `task 'commit-graph' failed`) and leaves `commit-graph.lock` / `tmp_graph_*` behind; tsgit writes a valid graph. Copying a `BUG` abort is not sensible; failing the task needs an ADR. Pinned. |

## `info/grafts` and `refs/replace/*` (backlog 32.4)

1 item, pinned.

| id | gap | evidence |
|---|---|---|
| D18 | grafts and replace refs are not honoured by history commands | tsgit does not honour `info/grafts` or `refs/replace/*` at all; the files are only read to disable the commit-graph, and ADR-542 defers them. git's `log` changes (grafted root, replaced history; a replace cycle is `fatal: replace depth too high`), while tsgit `log()` returns the raw history and logs nothing. Pinned. |
