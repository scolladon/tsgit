# ADR-197: `pull` feeds `merge` a resolved OID + a `reflogLabel` for faithful reflog/messages

## Status

Accepted (at `1dbd41e`)

## Context

`pull` integrates the fetched tip by delegating to the existing `merge`
command — this is the backlog's explicit intent ("pull is the test that the
merge state machine composes cleanly"): a pull-initiated conflict must leave the
identical `MERGE_HEAD`/`MERGE_MSG`/`ORIG_HEAD` + conflicted-index state that a
direct merge leaves, so `abortMerge`/`continueMerge` work with zero
pull-specific code.

Two frictions:

1. `merge.resolveTarget` accepts only a 40-hex OID or a local branch
   (`refs/heads/<x>`); it does **not** resolve `refs/remotes/<remote>/<branch>`.
2. The most-git-faithful outcome (captured empirically) is:
   - merge commit message `Merge branch '<branch>' of <url>`;
   - reflog action `pull` → `pull: Fast-forward` /
     `pull: Merge made by the 'tsgit' strategy.` (stock git uses
     `GIT_REFLOG_ACTION=pull`, with no merged-ref suffix — unlike a direct
     merge's `merge <target>: …`).

Options considered: (a) pass the OID only — reflog would show a raw OID, not
faithful; (b) broaden `merge.resolveTarget` to accept arbitrary refs — fixes
target resolution but not the reflog action and broadens merge's contract;
(c) pass the OID **and** give merge an optional reflog-action override so pull
controls both the commit message and the reflog action.

The user's directive for this decision was "the most faithful to git behaviour
(principle of least surprise)".

## Decision

Adopt option (c).

- `pull` resolves `refs/remotes/<remote>/<branch>` → a 40-hex OID via
  `resolveRef` and passes it as `merge({ target: <oid> })`; `resolveTarget`
  accepts the OID unchanged. `merge.resolveTarget` is **not** broadened.
- `pull` passes `message: \`Merge branch '<branch>' of <url>\`` (overridable),
  flowing into both the merge commit and `MERGE_MSG`.
- `MergeOptions` gains an additive optional `reflogLabel?: string` — the library
  analogue of `GIT_REFLOG_ACTION`. It **replaces the whole prefix** (default
  `merge <target>`) at both reflog sites: `${label}: Fast-forward` and
  `${label}: Merge made by the 'tsgit' strategy.`. `pull` passes
  `reflogLabel: 'pull'`.

The whole-prefix replacement (not just the action word) is required because
git's pull reflog has no merged-ref suffix (`pull: …`), whereas a direct merge
does (`merge feature: …`); a single replaceable prefix reproduces both shapes.

## Consequences

### Positive

- `merge` stays the single integration engine — pull is genuine composition, so
  the 20.4 state machine works on pull conflicts for free.
- Byte-faithful reflog and commit/`MERGE_MSG` messages versus stock git.
- `reflogLabel` is a principled, reusable knob (mirrors `GIT_REFLOG_ACTION`),
  not a pull-specific hack; default preserves existing `merge` behaviour exactly.

### Negative

- Adds one public field to `MergeOptions` (small surface growth).

### Neutral

- `merge.resolveTarget` remains OID/local-branch only; merging an arbitrary ref
  by name (`merge('origin/main')`) is left as a separate future improvement.
- Both reflog substitution sites need isolated tests so each is independently
  proven (mutation-resistance).
