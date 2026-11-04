---
subjects:
  - src/application/commands/internal/commit-ish.ts
  - src/application/commands/internal/sequencer-revisions.ts
  - src/application/commands/blame.ts
  - src/application/commands/describe.ts
  - src/domain/commands/error.ts
---
# 1141 — a corrupt first commit-ish candidate refuses with git's codes on every route

- **Status:** accepted
- **Date:** 2026-11-04
- **Design:** docs/design/rev-parse-corrupt-input.md · **Supersedes/Refines:** refines ADR-226, ADR-249, ADR-233

## Context

`resolveCommitIsh` peels each ladder candidate and folds every peel fault (`OBJECT_NOT_FOUND` and
the unreadable-ref codes) into "not this name", so `refs/tags/x` whose tag object does not parse,
names a missing object, or is itself a ref to a missing oid is skipped and `refs/heads/x` wins:
cherry-pick, revert and blame then act on the head commit, and the sequencer writes its state. git's
`dwim_ref` takes the first namespace that resolves, whatever its object holds, and refuses on it.
Pinned twice each on git 2.56.0 (fixtures A non-hex/truncated/absent, M and TT in the design): the
`get_reference` die `fatal: bad object x` for cherry-pick, revert and blame; `error: x: can't
cherry-pick a tag` then `fatal: cherry-pick failed` when the tag parses but does not peel to a commit,
the type being the unpeeled object's; `fatal: x is neither a commit nor blob` for describe;
`fatal: Non commit x?` for blame when the tag's target is missing; `merge: x - not something we can
merge` with exit 1. Every route prints the refname-ambiguity warning first, because the corrupt
candidate counts.

## Options considered

1. **Propagate the raw read fault everywhere** (`INVALID_OBJECT_ID { value }` /
   `OBJECT_NOT_FOUND { id }`) — pros: no new code / cons: cherry-pick of a tag whose target is missing
   would refuse `OBJECT_NOT_FOUND` where git's condition is "not a commit", so the interop test cannot
   rebuild git's line from the data.
2. **git's two tiers where git names them** — a new `BAD_OBJECT { revision }` for the `get_reference`
   die, the existing `CANNOT_PICK_NON_COMMIT { revision, type }` with the unpeeled type, the existing
   `REF_NOT_FOUND` for merge; describe, blame-absent and the rebase todo propagate the raw fault —
   pros: one new code / cons: describe and blame-absent lines cannot be rebuilt. The designer's
   recommendation.
3. **Option 2 plus git-named codes for describe and blame** — pros: every pinned line rebuilds from
   fields / cons: three new public error codes.

## Decision

**User's judgment: option 3.** The commit-ish ladder never sweeps: the first candidate whose ref
resolves wins, unpeeled (`resolveCommitIshObject`), and any read or peel fault surfaces on that winner.
The refusal data per route:

- `BAD_OBJECT { revision }` where git's `get_reference` dies — cherry-pick, revert and blame when the
  named object does not parse or is missing (fixtures A non-hex/truncated and M).
- `CANNOT_PICK_NON_COMMIT { revision, type }` for cherry-pick and revert when the named object reads
  but does not peel to a commit (fixture A absent, fixture TT); `type` is the unpeeled object's type.
- `REF_NOT_FOUND { name }` for merge (ADR-1145).
- `DESCRIBE_NEITHER_COMMIT_NOR_BLOB { revision }` for describe on every corrupt variant.
- `BLAME_NON_COMMIT { revision }` for blame when the named tag reads but its target is missing.
- The rebase todo `pick` / `reset` label propagate the raw fault: the todo is a data list (ADR-233)
  and tsgit refuses before any state is written.

`revision` is the name as the caller typed it; no rendered text (ADR-249). The refusal leaves no
`CHERRY_PICK_HEAD`, `REVERT_HEAD`, `MERGE_HEAD` or `sequencer/`, and HEAD and the index unchanged.

## Consequences

- Three new public error codes (`BAD_OBJECT`, `DESCRIBE_NEITHER_COMMIT_NOR_BLOB`, `BLAME_NON_COMMIT`)
  join `domain/commands/error.ts` beside `CANNOT_PICK_NON_COMMIT`; the API report changes.
- The interop suite rebuilds every git line on every route from the structured fields and asserts the
  on-disk state untouched.
- The design revision replaces the describe and blame-absent "propagate" rows of its D1/D2 with the
  two named codes.
