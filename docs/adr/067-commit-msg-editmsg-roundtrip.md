# ADR-067: `commit-msg` round-trips the message through `.git/COMMIT_EDITMSG`

## Status

Accepted (at `acb9c62`)

## Context

The `commit-msg` hook receives the proposed commit message, may **reject** it
(non-zero exit) **or rewrite it** (edit the message in place), after which the
commit proceeds with the possibly-modified message.

Canonical git implements this by writing the message to a file
(`.git/COMMIT_EDITMSG`), invoking the hook with that file's path as its single
argument, and then re-reading the file. In tsgit the commit message arrives as
`CommitOptions.message` — there is no editor and no message file yet.

Three ways to hand the message to the hook were considered:

- **File round-trip** (`.git/COMMIT_EDITMSG`) — git's own mechanism; the hook
  edits the file, tsgit re-reads it.
- **stdin** — pipe the message in. But a `commit-msg` hook expects a *path
  argument* (`$1`), so existing hooks would break; and stdin gives the hook no
  way to write a rewrite back.
- **environment variable** — same rewrite-back problem; env is read-only to the
  caller after spawn.

## Decision

`commit` round-trips the message through `.git/COMMIT_EDITMSG`, exactly as git:

1. After the message is resolved (and after the tree-equality `nothingToCommit`
   guard — no point validating a message for a commit that will not happen),
   write it to `${gitDir}/COMMIT_EDITMSG`.
2. Run the `commit-msg` hook with the **absolute** `COMMIT_EDITMSG` path as
   `argv[1]`. The absolute form is used (rather than a `.git/…`-relative path)
   so it is correct for custom `gitDir`s and worktrees.
3. Re-read the file and re-run `sanitizeMessage`. A hook that empties the
   message re-triggers `EMPTY_COMMIT_MESSAGE` unless `allowEmptyMessage` is set.
4. The hook-rewritten message feeds both the commit object and the reflog
   subject line.

The round-trip is skipped entirely when `noVerify` is set or no `HookRunner` is
wired. The `COMMIT_EDITMSG` file is left on disk afterwards (git leaves it too —
it doubles as the editor template for the next commit).

## Consequences

### Positive

- Git-faithful: an existing `commit-msg` hook (e.g. Conventional-Commits
  linters, `commitlint`, ticket-number injectors) works unchanged — they all
  read and write `$1`.
- A hook can both reject and rewrite, the full `commit-msg` contract.

### Negative

- Every verified commit on Node performs one extra small file write + read,
  even when no `commit-msg` hook exists. Negligible (sub-millisecond) and itself
  git-faithful — git always writes `COMMIT_EDITMSG`.
- `.git/COMMIT_EDITMSG` is created/overwritten as a side effect of `commit`;
  callers inspecting the git dir will see it.

### Neutral

- The re-sanitised, hook-modified message — not the caller's original — is what
  lands in the commit object and the reflog.
- `pre-commit` needs no file round-trip (it takes no arguments and no message);
  only `commit-msg` uses `COMMIT_EDITMSG`.
