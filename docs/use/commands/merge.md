# `merge`

Three-way merge of `target` into `HEAD`, plus the in-progress state-machine verbs. `repo.merge` is a frozen namespace — `run` / `continue` / `abort` (git `merge` / `merge --continue` / `merge --abort`). Conflicts **do not throw**: `run` writes the working tree, index, and merge-state files and returns a discriminated `MergeResult`; the caller resolves and finalises with `continue` (or gives up with `abort`).

## Signature

```ts
repo.merge.run(input: MergeRunInput): Promise<MergeResult>;
repo.merge.continue(input?: MergeContinueInput): Promise<MergeContinueResult>;
repo.merge.abort(): Promise<MergeAbortResult>;

interface MergeRunInput {
  readonly rev: string;
  readonly message?: string;
  readonly fastForward?: 'only' | 'never' | 'allow'; // default 'allow'
  readonly autostash?: boolean; // git's --autostash / --no-autostash; default merge.autostash
  readonly log?: boolean | number; // git's --log[=<n>] / --no-log; default merge.log
  readonly squash?: boolean; // git's --squash
  readonly commit?: boolean; // git's --commit / --no-commit
  readonly strategy?: string | ReadonlyArray<string>; // git's -s <strategy>, once or several times
  readonly strategyOptions?: ReadonlyArray<string>; // git's -X <option>, in order
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

type MergeResult =
  | { kind: 'up-to-date'; id: ObjectId }
  | { kind: 'fast-forward'; id: ObjectId; branch: RefName }
  | { kind: 'merge'; id: ObjectId; branch: RefName; parents: ReadonlyArray<ObjectId> }
  | { kind: 'conflict';
      conflicts: ReadonlyArray<MergeConflictDescriptor>;
      mergeHead: ObjectId;
      origHead: ObjectId;
    }
  | { kind: 'squashed'; origHead: ObjectId; conflicts?: ReadonlyArray<MergeConflictDescriptor> }
  | { kind: 'stopped'; mergeHead: ObjectId; origHead: ObjectId };
```

## Options (`run`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `target` | `string` | (required) | Ref name, oid, or `'HEAD'` of the branch to merge in. |
| `message` | `string` | auto | Override the merge-commit message. |
| `fastForward` | `'only' \| 'never' \| 'allow'` | `'allow'` | Fast-forward policy (see below). |
| `autostash` | `boolean` | `merge.autostash` | Stash a dirty tree before the merge (`MERGE_AUTOSTASH`) and re-apply it when the merge concludes, or on the `commit` / `merge.abort` that ends a conflict stop (a conflicting or refused re-apply stores the autostash in the stash list and warns, as git does); a `reset` or `checkout` that drops the merge state files it in the stash list (`autostash`) instead. |
| `log` | `boolean \| number` | `merge.log` / `merge.summary` | Follow the message (the default title, or `message`) with git's shortlog of each head: `* <head>:` then the subjects of the commits it brings in over HEAD, newest first, merges skipped. `true` lists 20, a number at most that many (`(<n> commits)` and `...` past it), `false` / `0` none; a negative count defers to the config. `merge.branchdesc` adds a local branch's `branch.<name>.description` under its header. A negative `merge.log` refuses with `CONFIG_NEGATIVE_LENGTH`, a non-integer with `CONFIG_BAD_NUMERIC_VALUE`. |
| `squash` | `boolean` | `false` | git's `--squash`: the merge (or the fast-forward) is checked out into the index and working tree and `SQUASH_MSG` lists every commit brought in, in git's `medium` format; no `MERGE_HEAD`, HEAD not moved, `{ kind: 'squashed', origHead }` returned and `post-merge` run with `1`. A later `commit` concludes it as a single-parent commit and removes `SQUASH_MSG`. Refuses with `INCOMPATIBLE_OPTIONS` (`['--squash', '--no-ff']`) under `fastForward: 'never'` or `merge.ff = false`. A squash whose merge conflicts keeps git's squash state — conflict stages and marked files, `SQUASH_MSG`, `MERGE_MSG` holding only the `# Conflicts:` block, `ORIG_HEAD`, no `MERGE_HEAD` — and returns `{ kind: 'squashed', origHead, conflicts }`. An autostash is re-applied after a squashed fast-forward only; any other squash, clean or conflicted, keeps it in `MERGE_AUTOSTASH` for the concluding `commit`, as git does. A `commit` with an empty message after resolving takes `SQUASH_MSG` then `MERGE_MSG`, comment lines stripped, as git's editor does. |
| `commit` | `boolean` | `true` | git's `--commit` / `--no-commit`. `false` stops a merge that would commit: the merged tree is staged and checked out, `MERGE_HEAD`, `MERGE_MSG` and `MERGE_MODE` are kept, HEAD is not moved, no `post-merge` runs and an autostash stays in `MERGE_AUTOSTASH`; `{ kind: 'stopped', mergeHead, origHead }` is returned. A fast-forward still fast-forwards unless `fastForward: 'never'`. A later `commit` (an empty message takes `MERGE_MSG`) concludes it. `true` with `squash` refuses with `INCOMPATIBLE_OPTIONS` (`['--squash', '--commit']`). |
| `strategy` | `string \| ReadonlyArray<string>` | `pull.twohead` (one head) / `pull.octopus` (several) — space-separated, each name refused as an unknown `-s` is — else `ort` / `octopus` | git's `-s`, once or several times. Several are tried in turn as git does: the first to merge cleanly commits (its name in the reflog note); else the last of those leaving the fewest conflicts (unmerged paths plus their index stages) prepares the resolution; else `NO_MERGE_STRATEGY_HANDLED`. Any `ours` in the list forbids the fast-forward; the trivial in-index merge runs only when every strategy is `resolve` or `octopus`. A valueless `pull.twohead` / `pull.octopus` refuses with `CONFIG_MISSING_VALUE`. Each: `ort`; `recursive` (run as `ort`, logged as `recursive`); `resolve` and `octopus`, which first try git's trivial in-index merge (logged `In-index merge`) when the merge would commit over one base, then `resolve` merges each path as `git-merge-one-file` does while `octopus` on one head fails; `ours`, which commits HEAD's tree with every head as a parent and never fast-forwards. `ort` / `recursive` / `resolve` on several heads, `resolve` with no common base (`allowUnrelatedHistories`) and `octopus` on one non-trivial head fail with `MERGE_STRATEGY_FAILED`. `subtree` refuses with `UNSUPPORTED_OPERATION`; any other name with `UNKNOWN_MERGE_STRATEGY`. Conflict markers of `resolve` carry tsgit's labels where git names its temporary files. |
| `strategyOptions` | `ReadonlyArray<string>` | none | git's `-X`, applied in order, read only when a strategy runs (a fast-forward or up-to-date merge never reads them). `ort` / `recursive` honour `no-renames`, `find-renames[=<n>]` and `rename-threshold=<n>` over `merge.renames` / `diff.renames` — `<n>` in git's `-M` grammar (`77`, `77%`, `0.77`; `0` or empty is the 50% default). `renormalize` / `no-renormalize` (the last one named wins over `merge.renormalize`) turn blob renormalization on or off, see [Renormalize](#renormalize). The options `ours`, `theirs`, `subtree[=<path>]`, `ignore-space-at-eol`, `ignore-space-change`, `ignore-all-space`, `ignore-cr-at-eol`, `diff-algorithm=<a>`, `patience` and `histogram` are accepted too; anything else refuses with `UNKNOWN_STRATEGY_OPTION`. `resolve` fails with `MERGE_STRATEGY_FAILED` when it has a file-level merge to make (git hands the options to `read-tree`, which refuses them); `octopus` and `ours` ignore them. |
| `author` / `committer` | `AuthorIdentity` | from config | Identities for the merge commit. |

### `fastForward`

| Value | git equivalent | Behaviour |
|---|---|---|
| `'allow'` (default) | `--ff` | Fast-forward when possible, else a true merge. |
| `'only'` | `--ff-only` | Refuse with `NON_FAST_FORWARD` when a true merge would be required. |
| `'never'` | `--no-ff` | Always create a merge commit, even when a fast-forward is possible. |

When the walk between HEAD and the merged commit reaches a parent that fails to parse (absent, or another kind of object), `run` logs git's two `error:` lines through `ctx.logger.error` and answers `up-to-date` in every mode: git's `reduce_heads` comes back empty, so `git merge` prints `Already up to date.` and exits 0. `ORIG_HEAD` is still written.

### Signing

`sign: true` signs the merge commit as `git merge -S` does, with `signKey` naming the key
(`-S<keyid>`, else `user.signingKey`); `sign: false` is `--no-gpg-sign`, and leaving it unset
follows `commit.gpgSign`. A signer refusal throws `SIGNING_FAILED` after the merge is
materialised, leaving `MERGE_HEAD`, `MERGE_MODE` and `MERGE_MSG` (without its final newline) for
a `commit` to finish, as git's merge dies there.

### `branch.<branch>.mergeoptions`

git's per-branch merge command line applies to every merge onto that branch (and to `pull`'s merge),
read before the caller's options: a caller's option wins, while its `strategy`, `strategyOptions`
and `message` add to the branch's (`-s` / `-X` in order, each `-m` a paragraph of its own). The value
is split as git's `split_cmdline` does — single quotes literal, a backslash escaping the next
character outside them. Note git's config parser strips double quotes first, so quote a word with
single quotes (or `\"`). The options `merge` models apply (`--ff` / `--no-ff` / `--ff-only`,
`--[no-]squash`, `--[no-]commit`, `-s`, `-X`, `-m`, `--[no-]log[=<n>]`,
`--[no-]allow-unrelated-histories`, `--[no-]autostash`, `-S[<key>]` / `--[no-]gpg-sign`); options that shape only git's output
(`-n`, `--stat`, `-v`, `-q`, `--progress`, …) are accepted, and so is `--no-verify`, since `merge`
runs no `pre-merge-commit` or `commit-msg` hook; the others git knows refuse with
`UNSUPPORTED_OPERATION`. A long option may be abbreviated to any prefix only it starts, as git's
`parse_options` allows (`--squ` is `--squash`). Refusals, before any merge state is written:

| Value | Code |
|---|---|
| unclosed quote / trailing `\` | `BAD_BRANCH_MERGE_OPTIONS` (`Bad branch.<b>.mergeoptions string: …`) |
| an option git does not know | `UNKNOWN_OPTION` (`option` spelt with its dashes) |
| an abbreviation more than one option starts | `AMBIGUOUS_OPTION` (`candidates`: the last two, as git names them) |
| a missing or malformed value | `INVALID_OPTION` (`requires a value`, `takes no value`, …) |

## Working tree and index

A **fast-forward** and a **clean true-merge** both check the result out: the working tree and index advance to the merged tree, exactly like `git merge` (a true merge additionally creates the merge commit on top). If a path the merge would change has uncommitted working-tree modifications — or an untracked file would be clobbered by an incoming add — `run` refuses with `WORKING_TREE_DIRTY` and leaves HEAD, the index, and the working tree untouched. A **conflicting** true-merge refuses the same way: before any conflict is materialised, every path the merge would change is checked, and `run` refuses with `WORKING_TREE_DIRTY` if writing the conflict would overwrite a tracked-and-modified or untracked path — atomically and pre-write, so HEAD, the index, and the working tree are untouched and no `MERGE_HEAD` is written. The offending paths are split across the error's two arrays: `localChanges` for tracked-dirty paths, `untracked` for untracked clashes. The checkout follows git's two-way rule: a path HEAD and the result agree on keeps whatever the index and working tree hold there (a staged change survives a fast-forward), while a staged change on a path the result moves refuses with `WORKING_TREE_DIRTY`.

**A true merge snapshots local changes first.** When the merge is not a fast-forward, not up to date and not a successful trivial in-index merge, and the index or a tracked work-tree path differs from HEAD, the merge writes the objects `git stash create` writes (an `index on` commit, then the `WIP on` commit; no ref, no reset) before its first strategy. The snapshot's author and committer are the merge's. `--squash`, `--no-commit` and any strategy list take it too; untracked files and stat-only changes write nothing, and a tracked path beyond a symlink refuses `PATHSPEC_BEYOND_SYMLINK` after the snapshot's index commit, before any strategy. Between strategies, before re-running a best conflicting strategy that was not the last one tried, and after no strategy handled the merge, the work tree and index are reset hard to HEAD and the snapshot is re-applied with its index: an occupant a stash cannot record is replaced by HEAD content, while local modifications and staged changes survive. A strategy-level refusal (would-overwrite, dirty index) hands over to the next strategy. A staged change refuses a trivial-branch merge (one head, one base, committing, every strategy allowing the trivial merge) with `WORKING_TREE_DIRTY` before any snapshot; otherwise every strategy fails on it: one `ort`-family strategy (`ort`, `recursive`, `subtree`) gives `WORKING_TREE_DIRTY` with the staged paths, one `ours`, `octopus` or `resolve` gives `MERGE_STRATEGY_FAILED`, several give `NO_MERGE_STRATEGY_HANDLED`. A fast-forward never snapshots.

The same whole-set, pre-write discipline also covers path safety on the conflicting branch: every outcome and conflict path the merge is about to write — every one of them, not only the path a straightforward per-entry write would reach first — is checked against git's own index-entry name rules (an absolute path; a `.`, `..`, or empty segment; a `.git`/`.gitmodules` alias) before any of them is written. A single hostile path anywhere in the batch refuses the whole write with `INVALID_INDEX_ENTRY`, atomically: HEAD, the index and the working tree stay untouched and no `MERGE_HEAD` is written, exactly like the `WORKING_TREE_DIRTY` guard above. Under a Windows host (node runtime on win32, whatever filesystem the caller passes) a path containing `\` is refused with `INVALID_INDEX_ENTRY` and reason `backslash rejected under Windows path syntax`, as git for Windows does; parsing an index, `write-tree` and `archive` do not refuse it.

Materialising a path whose leading directory is a symlink now matches git: the symlink is unlinked and a real directory created before the file is written — whether the link resolves inside or outside the repository — and a delete through one is skipped silently, leaving the symlink untouched.

The index write keeps git's extensions: `TREE` is invalidated along the paths the merge changed, `REUC` is dropped, `UNTR` is kept only while the tracked set is unchanged, and unknown extensions are dropped.

## Conflict handling

When the merge cannot resolve cleanly, `run` returns `{ kind: 'conflict', conflicts, mergeHead, origHead }`:

- Per-path conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) are written to the
  working tree. The open marker is labelled `HEAD` and the close marker the merged
  rev (`>>>>>>> <rev>`), exactly as git labels them. A path's
  `conflict-marker-size` gitattributes value sets the marker run length (default 7).
- The index gains stage-1/2/3 entries for each conflict.
- `.git/MERGE_HEAD`, `.git/MERGE_MSG`, `.git/ORIG_HEAD` persist the merge state.

Resolve the working-tree files, `repo.add` the resolved paths, then `repo.merge.continue({ message })` (equivalently `repo.commit({ message })`, which reads `MERGE_HEAD` for the second parent and clears the merge-state files atomically).

Unsupported conflict types (`gitlink`) reject upfront with `UNSUPPORTED_OPERATION` before any disk write.

A modify/delete conflict whose surviving side is a gitlink leaves an empty directory at the path and records the gitlink in the index stages; the submodule commit lives in the submodule's own store, so no content is written.

### Renames

As git's `ort` strategy does, the merge first pairs the paths each side deleted with the paths it added
(exact matches, then content similarity at git's 50% default), and a file renamed on one side and
edited on the other merges into the renamed path. Only paths the other side changed are rename
sources, and the empty file never is. `merge.renames` (falling back to `diff.renames`, on by default)
turns detection off, and `strategyOptions` (`no-renames`, `find-renames[=<n>]`,
`rename-threshold=<n>`) override it and set the similarity threshold; `merge.renameLimit` (falling back to `diff.renameLimit`; a non-positive value
means 7000) caps the similarity pass. A malformed value refuses the merge with
`CONFIG_BAD_BOOLEAN_VALUE`, `CONFIG_BAD_NUMERIC_VALUE` or `CONFIG_MISSING_VALUE`. When a rename
puts the sides at different paths, each conflict-marker label carries its side's path
(`<<<<<<< HEAD:old`, `>>>>>>> side:new`), as git writes them. The same detection runs under
`pull`, `cherry-pick`, `revert`, `rebase` and `stash apply`; the `resolve` and `octopus`
strategies never detect renames.

Rename conflicts stop the merge with git's index stages and files:

- **rename/delete** — one side renamed, the other deleted the source: a `rename-delete` conflict at
  the new path, stage 1 the base and the renaming side's stage, its file left in the tree.
- **rename/rename (1 to 2)** — both sides renamed the source to different paths: a `rename-rename`
  conflict on each of the three paths, stage 1 at the source, stage 2 and 3 at each side's target.
- **rename/add** and **rename/rename (2 to 1)** — the renamed file meets another file at its
  target: an `add-add` conflict between the two, the source deleted.
- Both sides renaming the source to the **same path** merge it there, three-way.

### Renormalize

`-X renormalize` (or `merge.renormalize=true`, with `-X no-renormalize` overriding it) makes `ort` compare and merge blobs as they would be checked in. As in git's `ll_merge`:

- **Content merge.** The base, ours and theirs blobs of a three-way content merge are each passed through the checkout conversion then the check-in conversion (`core.autocrlf`, `core.eol`, `text`/`eol`/`ident`, clean and smudge drivers), under the attributes of the merged tree, **before** the `merge` attribute dispatches a driver, so external, `union` and binary drivers see normalised bytes. The merged result is stored as is. A history that differs only by line endings merges clean.
- **Attributes.** Read from the merged tree's root `.gitattributes` only (a nested one never governs), index first, falling back to the worktree file. When the file merged without a content merge, its result governs; when it needed one (clean or conflicted), the base version governs, else ours. This is merge-ort's own behaviour, reproduced.
- **Modify/delete.** A side that changed a file only by normalisation is treated as unchanged, so the other side's delete wins cleanly (`BlobUnchanged`: same mode, and equal ids or equal normalised bytes). A rename involved keeps the conflict, as in git.
- **Where it applies.** Everything built on `ort`: `merge`, `pull`, `cherry-pick`, `revert`, `rebase` and `stash apply`/`pop`. Only `merge` takes `-X`; the others read `merge.renormalize` from config. A malformed `merge.renormalize` refuses merge-family commands with `CONFIG_BAD_BOOLEAN_VALUE`.

### Working tree writes

Merge results are written through the checkout conversion, as git checks the merged blob out: `core.autocrlf` / `core.eol` / `text` / `eol` LF to CRLF, `ident` expansion and the smudge filter, for clean outcomes, conflict-marker bytes and distinct-type sides alike. Attributes come from the result index, falling back to the worktree. All deletions run before the first write, so a deleted `.gitattributes` does not govern the writes. Symlinks and gitlinks are not converted.

### Content-conflict boundaries follow git's line-diff engine

The built-in 3-way line merge derives each side's changed base ranges from the
same git-faithful line-diff pipeline [`diff`](diff.md) uses for `withStat`
(record cleanup, the cost-capped divide-and-conquer split, and
indent-heuristic change compaction) — so a conflict's boundaries match `git
merge`'s own change groups, not an independently-diffed hunk set.

Two sides' changes conflict whenever their edited ranges overlap, or merely
**touch** — share a base boundary with no unchanged line between them —
mirroring git's `xdl_do_merge`: the only condition that keeps two changes from
conflicting is one ending strictly before the other begins. A zero-length
insertion sitting exactly at the other side's edge conflicts too.

### Distinct types (file vs symlink)

When both sides **change** to different kinds — one a regular file and one a symlink — the conflict is `distinct-types`. The regular side is renamed to `<path>~<label>` (that side's conflict label with `/` flattened to `_`, made unique with `_0`, `_1`, … against tracked paths) while the symlink keeps the original path. Each side lands at its recorded path — no content merge, and the behaviour is identical whether or not a merge base exists:

- **No base (add/add).** Both sides add; each lands as a single-stage entry at its recorded path (`ourPath` / `theirPath`), with stages 2/3 only.
- **With base (both sides changed).** The base's stage-1 entry travels with the side whose kind matches the base: base file ⇒ stage 1 at the renamed regular side's path (so that path carries two stages); base symlink ⇒ stage 1 at the original path alongside the symlink side's stage. The conflict carries `basePath` recording where stage 1 was emitted.

An untracked working file at the rename target refuses with `WORKING_TREE_DIRTY` before anything is written (the target lands in the error's `untracked` array, covered by the conflict-wide guard above).

### File vs directory

When one side holds a file at a path where the other holds a directory, the conflict is `file-directory`. The file is moved to `<path>~<label>` (the side's conflict label, made unique as for `distinct-types`) and the directory's contents stay in place. The index carries the file at stage 2 or 3 under the new name, plus the base entry when there is one.

The merge refuses, writing nothing, when:

- the file/directory conflict would discard local edits (`WORKING_TREE_DIRTY`);
- a conflict rename lands on a path git rejects (for example the NTFS short name `git~1`, `INVALID_INDEX_ENTRY`);
- a changed path lies beyond a symlink in the work tree.

Each conflict side is validated with the mode it is written with.

### Byte-exact paths

The merge engine carries non-UTF-8 path names as raw bytes through the three-way tree merge, renames, the index and the work tree. The `MERGE_MSG` conflict list is written with those raw bytes. Public results (`conflicts[].path`, `merged` paths) report the U+FFFD view; a lossy entry is never written to or unlinked on disk.

### Both-added paths

When both sides **add** the same path (no merge-base entry):

- **Regular-file pairs** content-merge against an empty base — markers wrap only
  the truly conflicting regions, and a `merge=union` (or clean external) driver
  resolves the path cleanly. The conflict keeps `type: 'add-add'` and carries
  `contentVerdict` (`'content'`, `'binary'`, or `'clean'` when the bytes merged
  but the file modes disagree) alongside the materialised `conflictContent`.
  The index gains stage-2/3 entries only (no base → no stage 1).
- **Symlink vs symlink** (and any pair involving a gitlink) keeps ours in the
  working tree with plain stage-2/3 entries.

### Same-kind files with kind-changed base

When both sides are regular files but the merge base is a different kind (symlink or other):

- The content merge runs with the base treated as **absent for content** (two-way merge; `union` resolves cleanly), yet the base's stage-1 entry is recorded per the standard merge rules.
- The conflict type is `'content'` with the merged bytes in `conflictContent`.
- Clean content + equal modes → resolved (no conflict).
- Clean content + differing modes → conflict, `contentVerdict: 'clean'`, worktree carries ours' mode (executable bit preserved).

### Symlink vs symlink (both changed)

When both sides are symlinks, the conflict is a bare `'content'` conflict (no markers, no `conflictContent`):

- All three stages (base, ours, theirs) are recorded at the path.
- The working tree keeps **ours' symlink** as-is — link targets are never merged.
- This applies whether or not the base is a symlink.

### Conflict writes (worktree mode preservation)

All conflict materialisation is mode-aware. Conflicted paths appear in the working tree with their merged/surviving side's mode:

- Marker-file conflicts (`conflictContent`) carry ours' or the resolved mode, preserving the executable bit.
- Bare take-ours conflicts (symlink pairs, distinct-types outcomes) re-create the kind correctly — symlinks as symlinks (mode 120000), not as regular files.

The same behaviour applies wherever the shared 3-way merge runs: `stash apply`,
`cherry-pick`, `revert`, and `rebase`.

## Custom merge drivers

The per-path content merge honours `.gitattributes` `merge=<driver>` selection,
shared with `stash apply` / `cherry-pick` / `revert` / `rebase`:

- `merge` (or unspecified) → the built-in 3-way line merge. This boolean/
  unspecified form consults no config.
- `merge=text` → a configured `[merge "text"] driver` runs instead; only when
  none is configured does it fall back to the built-in 3-way line merge.
- `merge=union` → a configured `[merge "union"] driver` runs instead; only when
  none is configured does it fall back to the built-in line merge, resolving
  each overlapping region by keeping **both** sides concatenated (no conflict
  markers) — git's `XDL_MERGE_FAVOR_UNION`.
- `merge=binary` → a configured `[merge "binary"] driver` runs instead; only
  when none is configured does it fall back to taking *ours* and declaring a
  conflict.
- `-merge` (incl. via the `binary` macro) → take *ours* and declare a conflict.
  This boolean/macro form consults **no** config, even when a
  `[merge "binary"] driver` is configured.
- `merge=<name>` (any other name) with `[merge "<name>"] driver = <cmd>` in the
  config → run the command (`%O %A %B %L %P %S %X %Y` substituted; exit 0 ⇒
  clean, non-zero ⇒ conflict). `%L` is the resolved `conflict-marker-size`
  (default 7); `%S` / `%X` / `%Y` are the base / ours / theirs conflict labels.

Any real 3-way content merge eagerly loads the whole `[merge "*"]` table before
resolving any path: if a **subsectioned** `merge.<name>.driver`,
`merge.<name>.name`, or `merge.<name>.recursive` is present but valueless (git
NULL), the content merge refuses `CONFIG_MISSING_VALUE` (`{ key, source, line }`
— the first valueless key by config-file line). This fires regardless of
whether any path's `.gitattributes` `merge=<name>` attribute selects that
driver — a configured-but-unused valueless driver refuses too. A subsectionless
`[merge] <key>` (no `"<name>"` header) is inert and never triggers it, matching
git. The scan itself only runs for a real content merge: a fast-forward and
read commands never load the table.

A `[merge "<name>"]` section that registers a `name` and/or `recursive` key
but no `driver` command instead refuses **lazily** — only when a path's
`merge=<name>` actually selects it — with `MERGE_DRIVER_MISSING_COMMAND`
(`{ name }`, rendered as `custom merge driver <name> lacks command line.`). An
unused driverless section stays inert. A section that is absent, empty (header
only), or carries only unrecognised keys keeps the built-in fallback selected
by name (`binary`/`union`/`text`, any other name → text).

In Node the driver runs by default; pass `openRepository({ command: false })` to
disable external drivers (they fall back to the built-in merge). The browser /
memory adapters have no command runner, so external drivers always fall back
there. See the [RUNBOOK](../../../RUNBOOK.md) "Operating custom merge drivers" section.

## State machine — `merge.continue` and `merge.abort`

A conflicting merge leaves the repository in an "in-progress" state recorded by `.git/MERGE_HEAD`, `.git/MERGE_MSG`, and `.git/ORIG_HEAD`. Two verbs end that state:

```ts
interface MergeContinueInput {
  readonly message?: string;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  readonly noVerify?: boolean;
}
type MergeContinueResult = CommitResult;
interface MergeAbortResult { readonly origHead: ObjectId; readonly branch: RefName; }
```

- `repo.merge.abort()` — reset the working tree, index, and current branch back to `ORIG_HEAD` as git's `reset --merge` does, then delete `MERGE_HEAD` and `MERGE_MSG`. `ORIG_HEAD` is preserved so `reset --hard ORIG_HEAD` remains a meaningful follow-up (ADR-173). Returns `{ origHead, branch }`.
- `repo.merge.continue({ message?, author?, committer?, noVerify? })` — finalise the resolution as a two-parent merge commit. Equivalent to `repo.commit({ ... })` plus a precondition that `MERGE_HEAD` exists. An empty/omitted `message` falls back to `MERGE_MSG`'s draft.

Both refuse with `NO_OPERATION_IN_PROGRESS` (`operation: 'merge'`) when `MERGE_HEAD` is absent. `merge.abort` additionally requires `ORIG_HEAD` to be present.

`merge.abort` follows git's `reset --merge`. A path whose index entry equals `ORIG_HEAD`'s keeps its occupant or local change; every other path is checked as an unforced checkout is (see [`checkout`](checkout.md#behaviour)). A refusal is `WORKING_TREE_DIRTY` naming only the first offending path in path order, whatever its class, and leaves the work tree, index, HEAD, `ORIG_HEAD`, `MERGE_HEAD` and `MERGE_MSG` as they were. An unmerged path is reset without the up-to-date check, except that a directory holding an untracked file there refuses (`untracked`); a file, a symlink or a directory of ignored files there is overwritten, and an unmerged gitlink's directory is left in place with a warning. `MERGE_AUTOSTASH` is consumed before the reset, so a refused abort neither applies nor stores it.

```ts
const m = await repo.merge.run({ rev: 'feature/x' });
if (m.kind === 'conflict') {
  // Option A — give up on the merge.
  await repo.merge.abort();

  // Option B — resolve, stage, then continue.
  // … edit working-tree files, call repo.add(paths) …
  await repo.merge.continue({ message: 'resolve merge' });
}
```

## Examples

```ts
const result = await repo.merge.run({
  rev: 'feature/x',
  author: { name: 'A', email: 'a@b', timestamp: 0, timezoneOffset: '+0000' },
});

switch (result.kind) {
  case 'up-to-date':
    break;
  case 'fast-forward':
    console.log('advanced to', result.id);
    break;
  case 'merge':
    console.log('merge commit', result.id);
    break;
  case 'conflict':
    // edit each conflicted file, then:
    await repo.add(result.conflicts.map(c => c.path));
    await repo.merge.continue({ message: 'resolve merge' });
    break;
}
```

## Throws

- `UNSUPPORTED_OPERATION` — conflict type not supported in v1 (e.g. rename/rename), or HEAD is detached. Also surfaced by `merge.abort` when HEAD is detached.
- `NON_FAST_FORWARD` — `fastForward: 'only'` and no fast-forward is possible.
- `WORKING_TREE_DIRTY` — the index differs from HEAD (a staged change git's `index_has_changes` refuses before any strategy runs — a gitlink difference its configured `ignore = all` hides is let through and rides into the result), or a fast-forward, clean, or conflicting merge would overwrite uncommitted working-tree changes (or clobber an untracked file); nothing is written. Tracked-dirty paths arrive in `localChanges`, untracked clashes in `untracked`, classified as in [`checkout`](checkout.md#behaviour). A file or symlink in a leading path of an incoming add is an untracked clash naming that component.
- `INVALID_INDEX_ENTRY` — a conflicting merge's outcome or conflict path fails git's own index-entry name rules (absolute path; `.`, `..`, or empty segment; `.git`/`.gitmodules` alias). Every path the write is about to touch is checked in one pass before any of them is written, so a hostile path anywhere in the batch refuses the whole conflict write, atomically.
- `REF_NOT_FOUND` — `target` does not resolve.
- `MERGE_STRATEGY_FAILED` — the one strategy given failed, including on a staged change after the snapshot (`ours`, `octopus`, `resolve`).
- `NO_MERGE_STRATEGY_HANDLED` — several strategies were given and none handled the merge.
- `PATHSPEC_BEYOND_SYMLINK` — a tracked path with local changes lies beyond a symlinked directory, found while the merge snapshots them.
- `NO_OPERATION_IN_PROGRESS` — `merge.continue` / `merge.abort` called outside an in-progress merge.
- `BAD_BRANCH_MERGE_OPTIONS` / `UNKNOWN_OPTION` / `AMBIGUOUS_OPTION` / `INVALID_OPTION` — `branch.<branch>.mergeoptions` does not split or parse as git's merge command line.

## See also

- Primitives: [`mergeBase`](../primitives/merge-base.md), [`diffTrees`](../primitives/diff-trees.md)
- Related commands: [`commit`](commit.md) (clears merge state), [`reset`](reset.md) (`mode: 'hard'` to `ORIG_HEAD` is the manual equivalent of `merge.abort`)
- ADRs: [025](../../adr/025-merge-parallel-blob-reads.md), [026](../../adr/026-merge-conflict-returns-not-throws.md), [027](../../adr/027-merge-conflict-write-order.md), [028](../../adr/028-merge-msg-content.md), [076](../../adr/076-merge-conflict-materialization.md), [170](../../adr/170-abort-merge-hard-reset-semantics.md), [171](../../adr/171-no-operation-in-progress-error.md), [172](../../adr/172-flat-abort-continue-surface.md), [173](../../adr/173-abort-merge-preserves-orig-head.md), [174](../../adr/174-continue-merge-delegates-to-commit.md), [263](../../adr/263-merge-namespace-reshape.md), [264](../../adr/264-fast-forward-tristate.md), [265](../../adr/265-merge-internal-reflog-channel.md), [293](../../adr/293-merge-materialises-non-conflict-outcomes.md), [318](../../adr/318-distinct-types-with-base-shape.md), [319](../../adr/319-symlink-pair-content-conflict.md), [320](../../adr/320-content-verdict-on-content-conflicts.md), [321](../../adr/321-mode-aware-conflict-writes.md), [627](../../adr/627-delete-through-symlinked-leading-directory-skips.md), [628](../../adr/628-checkout-unlinks-symlinked-leading-component.md), [950](../../adr/950-conversion-extends-the-clean-smudge-pipeline.md), [956](../../adr/956-renormalize-covers-every-merge-ort-consumer-and-add-renormalize.md)
```
