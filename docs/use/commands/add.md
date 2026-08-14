# `add`

Stage paths into `.git/index`. Two modes: literal paths (each validated and staged) or `all: true` (walk the working tree, stage every change).

## Signature

```ts
repo.add(
  paths: ReadonlyArray<string>,
  opts?: { force?: boolean; all?: boolean },
): Promise<AddResult>;

interface AddResult {
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly removed: ReadonlyArray<FilePath>;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `paths` | `ReadonlyArray<string>` | (required) | Literal paths or pathspec globs. **MUST be empty when `all: true`.** |
| `opts.all` | `boolean` | `false` | Bulk mode — walk the working tree and stage every change. |
| `opts.force` | `boolean` | `false` | Stage ignored paths anyway. |

> Breaking a stale `.git/index.lock` is repository-environment policy, set once on `openRepository({ config: { breakStaleLockMs } })` — not a per-call option. It applies to every index-mutating command.

## Pathspec syntax

`*`, `?`, `**` are globs. `!`-prefixed entries exclude (last match wins, `.gitignore` semantics). Anything else is a literal that matches the exact path **and** its descendants. Character classes (`[abc]`) and magic prefixes (`:(top)`, `:(literal)`) are not supported in v1.

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

- `PATHSPEC_NO_MATCH` — a literal pattern matched nothing. (Glob no-match is a silent no-op.)
- `PATHSPEC_BEYOND_SYMLINK` — a literal or glob pathspec whose leading directory is a symbolic link. Not raised in bulk (`all: true`) mode.
- `INVALID_INDEX_ENTRY` — a path this call would stage fails git's own index-entry name rules. Aborts the whole call; nothing is staged.
- `INVALID_OPTION { option: 'all' }` — `all: true` with a non-empty pathspec.
- `WORKING_TREE_FILE_TOO_LARGE` — a file exceeds `MAX_WORKING_TREE_BLOB_BYTES` (256 MiB).
- `BARE_REPOSITORY` — `add` is not valid in a bare repository.
- `EMPTY_PATHSPEC` — `paths` is empty and `all` is not set.

## Entry name validation

Every path this call would stage — literal, glob-matched, or walked in bulk
(`all: true`) mode — is checked at the staging boundary against git's own
`verify_path` rule set, the same check `.git/index` parsing enforces: a
`.git` alias (any case, trailing dot/space, the NTFS `git~1` short name, a
`.git:`-stream form, or an HFS+ ignorable-codepoint spelling), or a
`.gitmodules` entry staged as a symlink, throws `INVALID_INDEX_ENTRY` and
aborts the entire call before anything reaches the index — nothing partial
is staged, matching `git add`'s all-or-nothing index write.

Everything else git accepts is accepted too: a name carrying a backslash, a
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
clean filter to the worktree file before comparing the result to the cleaned blob
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
- Recipes: [stage with globs](../recipes.md#stage-with-globs), [bulk add --all](../recipes.md#bulk-add-all)
- ADRs: [029](../../adr/029-add-all-ignore-stub.md), [030](../../adr/030-add-all-walk-strategy.md), [031](../../adr/031-add-all-symlink-gitlink-policy.md), [032](../../adr/032-add-all-large-file-guard.md), [037](../../adr/037-pathspec-auto-detect.md), [038](../../adr/038-pathspec-exclusion.md), [627](../../adr/627-boolean-config-values-are-refused-as-git-refuses-them.md), [625](../../adr/625-git-parity-containment-posture.md), [626](../../adr/626-pathspec-beyond-symlink-error-code.md)
