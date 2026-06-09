# ADR-295: Reflog codec — empty message ⇔ no tab

## Status

Accepted (at `d346826a3c11535a5915627d30613870a69961d0`)

## Context

`git worktree add` writes the new worktree's `logs/HEAD` with a first entry that
has an **empty message and no tab separator**:

```
0000…0000 <oid> <ident> <t> <tz>\n        # no '\t', no message
```

This is git's canonical reflog rule (`log_ref_write_fd`): the `\t` and message
are appended only `if (msg && *msg)`. tsgit's `serializeReflogLine` always emits
`\t${message}`, so an empty message would produce `…<tz>\t\n` — one byte off
git. Symmetrically, `parseReflogLine` requires a tab and would reject git's
tab-less line. No tsgit caller had produced an empty reflog message before, so
the gap was latent; worktree `add` is the first.

Alternative: hand-format the worktree `logs/HEAD` bytes in a worktree-only admin
writer, leaving the shared codec untouched. That duplicates reflog formatting
and leaves tsgit's reader unable to parse git's tab-less line — a latent
faithfulness gap.

## Decision

Make the shared `domain/reflog/reflog-format` codec faithful to git's rule:

- `serializeReflogLine` appends `\t${message}` **only when `message !== ''`**;
  an empty message yields `<old> <new> <ident>\n`.
- `parseReflogLine` tolerates a tab-less line, parsing it as an entry with an
  empty message.

The round-trip `parse(serialize(x)) ≡ x` then holds for empty-message entries
too — pinned by a property test alongside the existing examples.

## Consequences

### Positive

- Worktree `logs/HEAD` reproduces git byte-for-byte through the normal
  `reflog-store`/`appendReflog` path — no duplicate formatter.
- tsgit can now read git's empty-message reflog entries (a faithfulness
  improvement beyond worktree).

### Negative

- Touches a shared, mutation-tested domain file. Mitigated: behaviour changes
  only for the empty-message case, which no existing caller produces, so all
  current reflogs are unaffected.

### Neutral

- The empty-message form is reachable in tsgit only via worktree `add` for now.
