# ADR-218: git-byte-faithful, bidirectionally cross-tool-resumable sequencer

## Status

Accepted (at `b4faeceb`)

## Context

A range / multi-arg `cherry-pick` that stops mid-way (conflict, empty, or merge
commit) must persist enough state to resume the *remaining* commits. git stores
this in `.git/sequencer/` (`head`, `todo`, `abort-safety`, `opts`) plus
`CHERRY_PICK_HEAD` / `MERGE_MSG`. Three faithfulness levels were possible:

1. tsgit-internal work-list (faithful *conflict* state only; sequencer is our own
   format; no cross-tool resume).
2. git-format, tsgit→git only (git resumes a tsgit-started range).
3. git-format, bidirectional (git resumes tsgit's, **and** tsgit resumes git's).

git's `todo` uses 7-char abbreviated oids; tsgit has no abbreviated-oid
resolution, so reading a git-started `todo` needs a new primitive.

## Decision

**Level 3 — bidirectional.** tsgit writes the exact git on-disk layout (verified
empirically against real git):

- `.git/sequencer/head` = pre-sequence `HEAD` `<oid>\n` (immutable per sequence).
- `.git/sequencer/todo` = `pick <oid> <subject>\n` lines, line 0 = current/next
  instruction, completed picks removed from the front. **Full 40-hex oids** (one
  deliberate deviation from git's abbreviation — verified that
  `git cherry-pick --continue` re-resolves and resumes a full-oid todo).
- `.git/sequencer/abort-safety` = current `HEAD` `<oid>\n` (advances per pick).
- `.git/sequencer/opts` = git-config `[options]` with non-default keys only
  (`no-commit`/`record-origin`/`allow-empty`), via the 20.6 config text helpers.
- **No `done` file** (git writes none for cherry-pick).
- Single-commit picks write **no** sequencer dir (only `CHERRY_PICK_HEAD`).

Reading a git-started `todo` resolves abbreviated oids through the new
`resolveOidPrefix` primitive (ADR-222).

## Consequences

### Positive

- A range can be started in tsgit and finished in git (or vice-versa) — the
  strongest possible faithfulness; `git status` mid-operation is correct.
- Reuses the existing config serializer for `opts` (one source of truth).

### Negative

- Couples tsgit to git's sequencer layout (a format git could change); mitigated
  by interop tests that pin it both directions.
- Requires the `resolveOidPrefix` primitive (ADR-222) — extra surface.

### Neutral

- Full-oid `todo` is not byte-identical to git's abbreviated form, but is
  git-parseable and abbreviation-drift-free; git rewrites the file on its next
  step anyway. Strict abbreviation parity is a documented non-goal.
