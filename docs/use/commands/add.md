# `add`

Stage paths into `.git/index`. Two modes: literal paths (each validated and staged) or `all: true` (walk the working tree, stage every change).

## Signature

```ts
repo.add(
  paths: ReadonlyArray<string>,
  opts?: { force?: boolean; all?: boolean; renormalize?: boolean },
): Promise<AddResult>;

interface AddResult {
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly removed: ReadonlyArray<FilePath>;
  readonly eolNotices: ReadonlyArray<EolNotice>;
  // pathspecs, as typed and in argument order, that matched only skip-worktree entries
  readonly sparse: ReadonlyArray<string>;
  // ignored entries a positive pathspec reached: sorted by bytes, deduplicated, never a tracked path
  readonly ignored: ReadonlyArray<FilePath>;
}

// core.safecrlf=warn notice: one per path whose line endings would not round-trip
interface EolNotice {
  readonly path: FilePath;
  readonly loss: 'crlf-to-lf' | 'lf-to-crlf';
  readonly crlf: number;   // CRLF sequences in the CRLF step's input
  readonly loneLf: number; // LF bytes not preceded by CR in that input
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `paths` | `ReadonlyArray<string>` | (required) | Literal paths or [pathspec globs](#pathspec-syntax). **MUST be empty when `all: true`.** |
| `opts.all` | `boolean` | `false` | Bulk mode — walk the working tree and stage every change. |
| `opts.force` | `boolean` | `false` | git's `-f`: no ignore rule applies, on any route. `ignored` is then `[]`. |
| `opts.renormalize` | `boolean` | `false` | Re-clean every tracked path the pathspec names under the current attributes and config (`git add --renormalize`). See [Renormalize](#renormalize). |

> Breaking a stale `.git/index.lock` is repository-environment policy, set once on `openRepository({ config: { breakStaleLockMs } })` — not a per-call option. It applies to every index-mutating command.

## Pathspec syntax

A pathspec is a literal unless it holds `*`, `?`, `[` or `\`. A literal matches the exact path **and** its descendants. Anything else is git's pathspec glob (`wildmatch` with no flags), tried after the verbatim-prefix rule (the body taken as a path or directory prefix): `*` and `?` **cross `/`**, `[…]` is a bracket class (`!`/`^` negate, ranges, the `[:class:]` names), `\x` matches `x`, and the pattern is anchored at both ends. Matching is byte-wise: `?` and `[…]` consume one byte of the path's UTF-8, so `?.txt` does not match `é.txt`. `!`-prefixed entries exclude (last match wins). Magic prefixes (`:(top)`, `:(literal)`) are not supported. gitignore, gitattributes and sparse patterns keep their own dialect.

On a POSIX host a `\` in a pathspec is a matching escape only: it is never looked up on disk. Under Windows path syntax a pathspec holding `\` is refused with `PATHSPEC_OUTSIDE_REPO`.

An unmatched positive pathspec refuses the whole call with `PATHSPEC_NO_MATCH` under the index lock, before any object write: the index is unchanged and no loose object is left behind. A pathspec whose spelled path exists on disk is not refused when it is a glob, or a literal that ignore rules do not hide (an empty directory stages nothing and succeeds); a literal naming an ignored path is reported in `ignored` rather than staged (see [Ignored paths](#ignored-paths)). Index entries count as matches, so a glob also selects tracked paths under an ignored directory and conflicted (unmerged) paths, which `add` stages as git's index-side pass does.

## Skip-worktree entries

Skip-worktree entries are never restaged, removed or cleared, on any route (literal, glob, `.`, `all: true`). A positive pathspec that matches only skip-worktree entries is not refused: it is listed in `sparse` (spelling as typed, argument order, duplicates kept, `.` included) and every other match is staged. git prints the sparse-checkout advice for these and exits 1.

## Ignored paths

Ignored entries a positive pathspec reaches (an ignored directory, or an ignored untracked file; never a tracked path) are not staged. They are listed in `ignored` (paths, sorted by bytes, deduplicated) and everything else the call matched is staged. This includes an ignored untracked literal, which is reported instead of staged. `force: true` disables every ignore rule on every route, so nothing is reported.

An unmatched positive pathspec still refuses first with `PATHSPEC_NO_MATCH`, ahead of both reports; a refused call stages nothing.

`add` returns normally when `sparse` or `ignored` is non-empty. git exits 1 in those cases; deriving that status from the two fields is the caller's job, as is rendering git's advice:

```ts
const { sparse, ignored } = await repo.add(['.']);
if (sparse.length > 0 || ignored.length > 0) process.exitCode = 1; // caller policy
```

A literal-only pathspec carrying a `!` exclusion takes the walk route and honours the exclusion.

## Gitlinks

A gitlink (submodule) entry whose checked-out HEAD differs from the recorded id is staged and reported in `modified` by `.`, `<path>`, `<path>/`, a glob or `all: true`, whether or not an ignore rule names it. HEAD is read from the repository `<path>/.git` leads to (a directory or a gitfile), not from the `.gitmodules` name. Nothing is staged when HEAD equals the recorded id, the directory is empty, the checkout has no commit, or HEAD cannot be resolved. A skip-worktree gitlink is left alone. The gitlink's own directory is never walked into, whatever its `.git` is (a directory, a gitfile, a symlink or nothing at all): the files inside belong to the submodule and are never staged as paths of this repository.

A `<path>/.git` that leads to no repository (missing gitdir, garbage HEAD, unparsable gitfile, a gitdir or common dir lacking `objects/` or `refs/`, an invalid repository format) refuses with `NOT_A_REPOSITORY`, before any write. A malformed config refuses with its config error instead.

## Embedded repositories

An untracked directory that holds a repository is staged as a `160000` gitlink at that repository's HEAD and reported in `added`, as git's directory walk does. This holds for `.`, `<dir>`, `<dir>/`, a glob that reaches `<dir>/` (`s*`, `su?/`, `*sub/`; not `*b` or `su?`), `all: true` and `force`. A tracked regular file or symlink whose path is now such a repository is staged as a type change to `160000` and reported in `modified`, ignored or not, whenever the pathspec selects the tracked path (`*b` reaches it by its own path).

- **What counts as a repository.** `<dir>/.git` is a directory, a gitfile or a symlink to either, and it leads to a usable repository (HEAD, `objects/` and `refs/`, through `commondir`). A `.git` that leads to none leaves `<dir>` a plain directory: its files are walked and staged, `.git` itself never is. So is a directory whose `.git`, followed, is not a regular file (FIFO, device, socket) or is a regular file over 1 MiB. A directory with an index entry beneath it is walked as a tree whatever `.git` it holds.
- **Nothing beneath is staged.** The files of an untracked repository, and any repository nested in it, are never staged. A literal naming a path inside one stages nothing and is not refused. An ignore rule hitting a path strictly inside one is not reported in `ignored`; a rule on the repository itself still is, and it is staged only under `force`.
- **Bounded reads.** A nested repository's `HEAD` is judged from its first 255 bytes and resolved from the whole ref line when that fits 4101 bytes; a longer one resolves to no commit. Its `commondir` is read up to 1 MiB and cut at its first NUL.
- **No commit.** A selected repository whose HEAD does not resolve (unborn branch, unparsable ref, a repository format git refuses) refuses with `NO_COMMIT_CHECKED_OUT`, naming the first such directory in path order, after the unmatched-pathspec and gitlink refusals. Nothing is written: git writes the blobs sorted before the repository and then dies; `add` refuses before any blob write. An excluded or unselected repository never refuses. A HEAD naming a missing object is staged as is.
- **Tracked gitlink with a large `.git`.** A tracked gitlink whose `.git` is a regular file over 1 MiB refuses with `GITFILE_TOO_LARGE`. A FIFO or device `.git` keeps the recorded commit.

`--renormalize` is unchanged. git's `warning: adding embedded git repository` advice has no field; the gitlink is in `added` (or `modified`).

## Examples

```ts
// Literal paths
await repo.add(['README.md', 'src/index.ts']);

// Globs — stage every .ts except tests
await repo.add(['*.ts', '!*.test.ts']);

// Bulk mode — stage every change in the working tree
const result = await repo.add([], { all: true });
console.log(result.added.length, result.modified.length, result.removed.length);
```

## Throws

- `PATHSPEC_NO_MATCH { pattern, patterns }` — a positive pathspec, literal or glob, matched nothing; `pattern` is the first unmatched spelling and `patterns` holds it alone. Nothing is staged or written.
- `GITFILE_NOT_A_REPOSITORY { path }` — a gitlink's `.git` is a gitfile whose pointer leads to no repository; `path` is the gitfile, `<sub>/.git`. Nothing is staged.
- `NOT_A_REPOSITORY { path }` — a gitlink's `<path>/.git` directory or symlink leads to no repository; `path` is git's spelling (`sub/.git`, `sub/../.git/modules/sub`, or the absolute pointer). Nothing is staged.
- `NO_COMMIT_CHECKED_OUT { path }` — a selected untracked repository has no resolvable HEAD; `path` is git's spelling with a trailing slash (`sub/`). Nothing is staged or written.
- `GITFILE_TOO_LARGE { path }` — a tracked gitlink's `.git` is a regular file over 1 MiB; `path` is `<sub>/.git`. Nothing is staged.
- `PATHSPEC_BEYOND_SYMLINK` — a literal or glob pathspec whose leading directory is a symbolic link. Not raised in bulk (`all: true`) mode.
- `INVALID_INDEX_ENTRY` — a path this call would stage fails git's own index-entry name rules. Aborts the whole call; nothing is staged.
- `INVALID_OPTION { option: 'all' }` — `all: true` with a non-empty pathspec.
- `WORKING_TREE_FILE_TOO_LARGE` — a file exceeds `MAX_WORKING_TREE_BLOB_BYTES` (256 MiB).
- `EOL_ROUND_TRIP_UNSAFE { path, loss, crlf, loneLf }` — `core.safecrlf=true` and a path's line endings would not survive the round trip. See [Line-ending conversion](#line-ending-conversion-coreautocrlf-coreeol-text-eol-ident).
- `CONFIG_BAD_BOOLEAN_VALUE` — `core.autocrlf` or `core.safecrlf` holds a value git's boolean grammar refuses (`core.autocrlf` also accepts `input`, `core.safecrlf` also accepts `warn`). Checked before anything is staged, as on every command.
- `WORK_TREE_REQUIRED` — the repository has no work tree (bare, or opened without one).
- `EMPTY_PATHSPEC` — `paths` is empty and `all` is not set.

## Index write

When nothing was staged (every path already matches the index), `add` leaves the index file unwritten, as git's `SKIP_IF_UNCHANGED` does. A write keeps git's index extensions: the `TREE` cache is invalidated along each re-staged path and the rest is carried; unknown extensions are dropped. Resolving a conflict also records its stages in `REUC` (see [Conflicts](#conflicts)).

## Directory and file replacement

A non-directory (symlink or regular file) that replaced a tracked directory is staged by `add <it>` and drops every index entry beneath it, whichever route names it: a literal, a `<dir>` / `.` / glob pathspec, or `all: true`. Entries the pathspec selects that are gone from disk are reported in `removed` (git's `remove` lines); excluded and skip-worktree entries beneath it are dropped without being reported. A path that already held a stage-0 entry is replaced in place with no such drop, as in git.

The mirror holds too: a directory that replaced a tracked file or symlink drops that entry when anything beneath it is staged. It is silent for `add a/b` and reported in `removed` for `add a`, `.` or `all: true`. `add a/b` (or `add a a/b`) when `a` is now a regular file stages the removal of `a/b` instead of refusing.

`removed` lists only what git reports with `remove` lines; silent drops show only in the resulting index.

## Conflicts

`add` keeps every stage of an unmerged path it does not stage. Staging an unmerged path collapses it to stage 0, reports it in `modified` whatever its content, and records its prior stages in the index's resolve-undo (`REUC`) extension, merged with the records already there (git's `ls-files --resolve-undo`). A path held at stage 0 beside conflict stages (an `update-index --index-info` can build that) is re-staged in place: its conflict stages stay, no resolve-undo record is written, and it is reported in `modified`.

Exclusions follow git 2.55 on conflicts: an exact exclusion (`!f`) does not shield an unmerged path that another pathspec element covers, so the path is staged; a glob or leading-directory exclusion (`!*.txt`, `!d/`) shields it.

## Entry name validation

Every path this call would stage — literal, glob-matched, or walked in bulk
(`all: true`) mode — is checked at the staging boundary against git's own
`verify_path` rule set, the same check `.git/index` parsing enforces: a
`.git` alias (any case, trailing dot/space, the NTFS `git~1` short name, a
`.git:`-stream form, or an HFS+ ignorable-codepoint spelling), or a
`.gitmodules` entry staged as a symlink, throws `INVALID_INDEX_ENTRY` and
aborts the entire call before anything reaches the index — nothing partial
is staged, matching `git add`'s all-or-nothing index write.

The `.gitmodules` symlink check also covers the aliases git 2.55 refuses (the NTFS spelling after a backslash, the generic 8.3 short name), and a `.git` alias behind a component-leading `\` is admitted on POSIX as git does. Under a Windows host (node runtime on win32, whatever filesystem the caller passes) a path containing `\` is refused with `INVALID_INDEX_ENTRY` and reason `backslash rejected under Windows path syntax`, as git for Windows does; parsing an index, `write-tree` and `archive` do not refuse it.

Everything else git accepts is accepted too on POSIX: a name carrying a backslash, a
C0/C1 control byte, a BIDI/isolate Unicode control character, or a mid-path
`:` stages exactly as `git add` stages it (only a *leading* `:` is
pathspec-magic syntax, refused as such).

A literal or glob pathspec whose leading directory is a symbolic link
refuses with `PATHSPEC_BEYOND_SYMLINK` before any file is read — matching
git's `fatal: pathspec … is beyond a symbolic link`. This check is
shape-based, not containment-based: it fires identically whether the link
points outside the repository or at a sibling directory inside it. It does
not run in bulk mode, where `git add -A` stores the symlink itself rather
than refusing.

## Byte-exact paths and removals

An index entry whose path is not valid UTF-8 is kept byte-exact: the raw bytes are what `.git/index` and the trees record, and the public result and `IndexEntry.path` show the U+FFFD view (see [`readIndex`](../primitives/read-index.md)). A literal pathspec never names such a lossy entry; it matches only entries whose bytes decode to the pathspec. A lone surrogate in a caller-supplied string normalises to U+FFFD before matching.

A pathspec that matches a tracked path missing from disk stages its deletion, as `git add <pathspec>` does — ignored tracked paths included. A path beyond a symlinked directory counts as removed.

## Line-ending conversion (`core.autocrlf`, `core.eol`, `text`, `eol`, `ident`)

Worktree bytes go through git's check-in conversion before they are hashed, so the stored blob is what `git add` stores. The step order is clean filter driver, then CRLF, then `ident`.

- **Sources.** `core.autocrlf` (`true` / `false` / `input`), `core.eol`, and the `text`, `text=auto`, `eol=lf|crlf`, `crlf` and `ident` attributes. Attributes come from the worktree `.gitattributes` first, falling back to the index blob when the worktree has none, plus `.git/info/attributes` and `core.attributesFile`.
- **Binary content.** `text=auto` and the `core.autocrlf` default skip content git's heuristic classes binary (NUL, lone CR). `text` and `eol=*` convert regardless. `-text` and `binary` never convert. An `eol` attribute alone implies `text`.
- **CRLF already in the index.** Under the `auto` family only, a path whose index blob is text and already holds a CRLF is not normalised. The rule reads the path's stage 0 entry, else its stage 2 entry (an unmerged path). `renormalize` ignores it.
- **`ident`.** `$Id: <hex> $` collapses to `$Id$` on the way in.
- **Symlinks and gitlinks** are never converted.
- **Unchanged paths** short-circuit on the index stat and never convert.
- **Literal staging.** Each literal path is stat-ed once and staged through the concurrency pool. The staging read is bounded by the probed size, as git's `index_core`: a file that grew since the probe is staged truncated to the probed size, and one that shrank is refused.
- **Tracked first.** Whichever way paths are given, tracked paths are staged first in index order, then untracked ones (index order for literals, walk order for bulk mode), so notices and the first refusal land in git's order.

### `core.safecrlf`

The round-trip check runs only when a conversion writes an object — never on `renormalize`, `status`, `blame` or checkout.

| Value | Result |
|---|---|
| `warn` (default, also unset) | The path is staged; an [`EolNotice`](#signature) is appended to `eolNotices`. |
| `false` | Staged; `eolNotices` is `[]`. |
| `true` | Throws `EOL_ROUND_TRIP_UNSAFE { path, loss, crlf, loneLf }` for the first offending path and stages nothing. |

`loss: 'crlf-to-lf'` is git's `CRLF would be replaced by LF in <path>` (or the `warning: in the working copy of '<path>', CRLF will be replaced by LF the next time Git touches it`); `'lf-to-crlf'` is the swapped wording. When both losses apply (mixed endings) `crlf-to-lf` is checked first, as in git; one notice per path. `crlf` and `loneLf` are tsgit-only counts; git prints neither. The library emits no text: build git's line from `path` + `loss` if you want it, and nothing is written to the logger.

Under `core.safecrlf=true`, bulk and pathspec adds convert and write one path at a time in order and stop at the first loss, so the blobs left behind in the object store match git's (the paths before the offender are written, later ones are never hashed). Under `warn` and `false` writes stay concurrent.

```ts
const { eolNotices } = await repo.add(['.'], { all: false });
for (const n of eolNotices) {
  console.warn(`${n.path}: ${n.loss}`); // caller renders; the library does not
}
```

## Renormalize

`repo.add(paths, { renormalize: true })` (with `all: true` and `[]` for the whole tree) re-cleans every tracked stage-0 regular file or symlink the pathspec names, under the current attributes and config, with no stat shortcut. It never adds untracked paths, never removes anything, never touches the worktree, skips `skip-worktree` entries, ignores the index-CRLF rule and never raises a `core.safecrlf` refusal or notice (`eolNotices` is `[]`). A tracked path missing from disk, or a lossy (non-UTF-8) entry, aborts the call with `PATHSPEC_NO_MATCH`.

## Clean filter drivers (`filter=<name>`)

When a path carries a `filter=<name>` attribute in `.gitattributes` and
`[filter "<name>"].clean` is configured, `add` runs the clean command over the
worktree bytes before hashing and storing the blob — the committed object holds
the **cleaned** content, not the raw worktree bytes.

- **Clean is a stdin → stdout transform.** The worktree bytes are fed to the
  command's stdin; the captured stdout becomes the committed blob.
- **Symlinks are not filtered.** Only regular-file content is passed through
  the clean command; symlink targets are staged verbatim, as git does.
- **`required` failure semantics.** If the clean command exits non-zero:
  - `filter.<name>.required = true` — the stage is **refused**: `add` throws
    `CLEAN_FILTER_FAILED` (`{ path, filter, exitCode }`). Nothing is staged.
  - `required` absent or `false` — the failure is a warning; raw worktree bytes
    are staged and `add` succeeds (git's fallback behaviour).
- **Named-but-unconfigured driver.** If `filter=<name>` is set but no `[filter
  "<name>"]` section (or no `clean` key) exists in the config, the path is staged
  raw — identity clean.
- **Independent of `diff=`.** Clean/smudge and textconv are orthogonal. A path
  with `filter=<name>` only is diffed against raw committed bytes; textconv only
  applies to paths carrying `diff=<name>`.
- **A malformed `required` value throws, but only when a path actually
  converts.** `filter.<d>.required` set to a value git's boolean grammar
  refuses throws `CONFIG_BAD_BOOLEAN_VALUE` — checked across every `[filter
  "<d>"]` section once `add` starts converting a path, even one unrelated to
  the driver that mismatched. A path whose stat is unchanged from the index
  (the `ie_match_stat` short-circuit below) never converts, so it never
  triggers this check — matching git.
- **Stat-clean short-circuit (`ie_match_stat`).** A path whose stat
  (`mtime`/`ctime`/`size`/`ino`) matches the index's recorded fields and whose
  mode is unchanged is re-staged as-is: no read, no clean filter, no re-hash.
  This only changes cost, never `AddResult` — a stat-clean path was already
  neither `added` nor `modified`.

**Status and diff after clean.** `status` and working-tree diffs re-apply the
clean filter and the line-ending conversion to the worktree file before comparing the result to the cleaned blob
OID in the index — so a file that was checked out via smudge and then left
unmodified shows as unchanged.

**Node.** The clean command runs through the `CommandRunner` port (same trust
model as merge drivers and hooks). In the browser / memory adapters, or in Node
with `openRepository({ command: false })`, no driver is wired and worktree bytes
are staged raw. See the [RUNBOOK](../../../RUNBOOK.md) "Operating filter and textconv drivers"
section.

## See also

- Primitives: [`walkWorkingTree`](../primitives/walk-working-tree.md), [`readIndex`](../primitives/read-index.md), [`writeObject`](../primitives/write-object.md)
- Related commands: [`rm`](rm.md), [`checkout`](checkout.md) — share the pathspec syntax
- Recipes: [stage with globs](../recipes.md#stage-with-globs), [bulk add --all](../recipes.md#bulk-add---all)
- ADRs: [029](../../adr/029-add-all-ignore-stub.md), [030](../../adr/030-add-all-walk-strategy.md), [031](../../adr/031-add-all-symlink-gitlink-policy.md) (superseded), [1054](../../adr/1054-add-stages-an-embedded-repository-as-a-gitlink-as-git-does.md), [032](../../adr/032-add-all-large-file-guard.md), [037](../../adr/037-pathspec-auto-detect.md), [038](../../adr/038-pathspec-exclusion.md), [627](../../adr/627-boolean-config-values-are-refused-as-git-refuses-them.md), [625](../../adr/625-git-parity-containment-posture.md), [626](../../adr/626-pathspec-beyond-symlink-error-code.md), [950](../../adr/950-conversion-extends-the-clean-smudge-pipeline.md), [952](../../adr/952-the-safecrlf-refusal-carries-path-loss-and-line-ending-counts.md), [953](../../adr/953-safecrlf-warnings-are-notices-on-the-command-result.md), [954](../../adr/954-safecrlf-true-serialises-conversion-and-object-writes-in-index-order.md), [956](../../adr/956-renormalize-covers-every-merge-ort-consumer-and-add-renormalize.md), [990](../../adr/990-add-applies-the-directory-file-replacement-on-every-route.md), [991](../../adr/991-add-folds-the-mirror-directory-file-replacement.md), [992](../../adr/992-the-directory-file-rule-is-a-pure-domain-module.md), [993](../../adr/993-add-stages-the-removal-beneath-a-regular-file.md), [994](../../adr/994-add-removed-lists-only-what-git-reports.md), [995](../../adr/995-add-bench-covers-a-large-index.md), [996](../../adr/996-add-keeps-every-stage-of-other-unmerged-paths.md), [997](../../adr/997-add-reports-a-staged-unmerged-path-as-modified.md), [998](../../adr/998-an-exclusion-does-not-shield-an-unmerged-path.md), [999](../../adr/999-add-writes-resolve-undo-when-it-resolves-a-conflict.md), [1000](../../adr/1000-only-an-exact-exclusion-yields-to-another-cover.md), [1001](../../adr/1001-an-exact-literal-silences-the-drop-beneath-a-resolved-path.md), [1002](../../adr/1002-resolve-undo-merges-after-the-extension-carry.md), [1046](../../adr/1046-add-reports-ignored-and-sparse-entries-in-additive-result-fields.md), [1047](../../adr/1047-add-force-disables-every-ignore-rule-as-gits-f-does.md), [1048](../../adr/1048-the-ignored-report-ships-as-a-fix.md), [1049](../../adr/1049-a-gitlinks-head-is-read-from-the-repository-under-path-git.md), [1050](../../adr/1050-a-gitlink-whose-git-leads-nowhere-refuses-not-a-repository.md), [1053](../../adr/1053-a-literal-only-add-with-an-exclusion-takes-the-walk-route.md)
