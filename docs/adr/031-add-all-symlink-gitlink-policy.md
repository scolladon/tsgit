# ADR-031: Symlinks stage as `120000`; embedded `.git` directories are skipped

## Status

Accepted (at `5ecd61a`)

## Context

The §14.1 walk must answer two semantic questions:

1. **Symlinks** — should the walker follow them, refuse them, or
   stage the link itself?
2. **Embedded repos / submodules** — should a nested `.git` direct­ory
   produce a gitlink (`160000`) entry pointing to the embedded HEAD,
   should the directory be silently skipped, or should `add` fail
   with a typed error?

### Symlink considerations

Following symlinks during the walk lets an attacker plant a symlink
pointing outside the working tree and either escape containment or
amplify the read load (`/dev/zero`, `/proc/self/cwd` loops, etc.).
Git's behaviour is to **never** follow symlinks during `add`; the
link itself is the staged object (mode `120000`, content = link
target bytes). The existing literal-path mode in `add.ts` already
does this — every symlink leaf is `lstat`-ed (not `stat`-ed) and the
target string is the blob content.

Mirroring the literal-path behaviour in bulk mode is the obvious
choice: same semantics regardless of whether the user passed paths
explicitly or asked for `--all`. It also avoids reopening the
symlink-safety questions Phase 13 settled.

### Gitlink considerations

v1 declares submodules out of scope:
`materializeFile` (`commands/internal/working-tree.ts:92`) throws
`UNSUPPORTED_OPERATION` for mode `160000`. The repository facade has
no submodule init/sync flow.

Three plausible policies for an embedded `.git`:

1. **Stage as gitlink (`160000`):** would require reading the
   embedded `HEAD`, resolving its tip, and writing an entry that
   `checkout` / `materializeFile` cannot honour. Generates a broken
   index by construction.
2. **Fail with a typed error:** clean, but it makes
   `add --all` unusable for any project that happens to contain a
   nested clone (common during dev: `vendor/`, manual git checkouts
   under `tools/`). Git's default is more forgiving.
3. **Silently skip the directory:** matches Git's default ("you
   added an embedded repository; add a submodule entry if you want
   it tracked"). The user experience is "your nested repo's files
   don't appear in `git status`, please run `git submodule add` if
   intentional".

## Decision

Adopt option (3) for gitlinks and `lstat`-only for symlinks:

- Symlinks: `lstat` everywhere; never `stat`. Yield the symlink
  leaf with `isSymbolicLink: true`; `addAll` stages mode `120000`
  with the link target as blob content. Identical to literal-path
  mode.
- Embedded `.git` directories: when `readdir` returns a `.git`
  child in any directory below `workDir`, the WHOLE directory is
  treated as opaque — yield nothing inside it. No gitlink entry is
  created.
- `.git` at the workDir root: skipped as always (it's our own
  metadata directory, not an embedded repo).

`isForbiddenGitComponent` from `commands/internal/working-tree.ts`
is reused for the case-insensitive + NTFS-trimmed match. The check
runs against `DirEntry.name`, not against the joined path.

## Consequences

### Positive

- Aligns with Git's default behaviour — no surprise for users
  porting from `git add -A`.
- Avoids producing index entries that `checkout` cannot honour.
- Keeps symlink-safety guarantees Phase 13 established (Phase 13.1+
  symlink-safe writes, ADR-019 dirty-tree guard).

### Negative

- A user who genuinely wants to register a submodule via `add --all`
  cannot. v1 has no submodule story, so this is consistent with the
  rest of the v1 surface but worth flagging in the README. (`v2`
  may revisit.)
- The "silently skip" rule loses information — a developer who
  forgot to `git submodule add` won't see a warning. Git's UI does
  warn (`warning: adding embedded git repository`); we don't have a
  warning channel today (progress reporter is for progress, not
  diagnostics). Tracked as a follow-up; not a §14.1 blocker.

### Neutral

- Symlink-to-directory yields the symlink leaf (no descent). This
  matches the literal-path mode and avoids an entire class of
  cycle/escape bugs.
