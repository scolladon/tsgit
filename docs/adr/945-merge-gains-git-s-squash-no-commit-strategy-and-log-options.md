---
subjects:
  - src/application/commands/merge.ts
  - src/application/commands/pull.ts
---
# 945 — Merge gains git's squash, no-commit, strategy and log options, and honours mergeoptions

- **Status:** accepted
- **Date:** 2026-10-06
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-226, ADR-249

## Context

git applies `branch.<b>.mergeoptions` (a merge command line) to every `merge` on that branch, and to
`pull` through the merge it runs. Its values include options tsgit's merge did not have: `--squash`,
`--no-commit`, `-s <strategy>`, `-X <option>`, `--log[=<n>]`. An unknown option dies (exit 129).

## Options considered

1. **Honour the options tsgit already models; refuse the rest** with a new code.
2. **Implement the missing merge options, then honour every option** git's merge accepts.
3. **Leave mergeoptions unread** and add a backlog entry.

## Decision

**User-ratified — option 2.** `merge` (and `pull`'s merge) gains structured equivalents of git's
options, each with git's exact semantics and on-disk effects:

- `squash?: boolean` — `--squash` (no MERGE_HEAD, `SQUASH_MSG`, no commit);
- `commit?: boolean` — `false` is `--no-commit` (stop before committing, MERGE_HEAD + MERGE_MSG kept);
- `strategy?: string` — `-s` (`ort`, `recursive`, `resolve`, `octopus`, `ours`, `subtree`, as git
  accepts and maps them);
- `strategyOptions?: readonly string[]` — `-X` (`ours`, `theirs`, `ignore-space-change`, …, as the
  chosen strategy accepts them);
- `log?: boolean | number` — `--log[=<n>]` shortlog in the message (`merge.log` config too).

`branch.<b>.mergeoptions` is parsed with git's `split_cmdline` and applied before the caller's own
options, which win, as on git's command line. An option git does not know refuses as git does.

**Amendment (2026-10-06) — result shape.** A merge that ends without a commit reports one of two new
`MergeResult` variants, mirroring git's two distinct on-disk states: `{ kind: 'squashed', origHead }`
(`--squash`: `SQUASH_MSG` written, no `MERGE_HEAD`, HEAD not moved, even when a fast-forward was
possible) and `{ kind: 'stopped', mergeHead, origHead }` (`--no-commit`: `MERGE_HEAD` + `MERGE_MSG`
kept for the caller's commit; a fast-forward still fast-forwards unless `fastForward: 'never'`).
A squash that conflicts keeps git's squash state (`SQUASH_MSG`, no `MERGE_HEAD`, `ORIG_HEAD`, conflict
stages, `MERGE_MSG` carrying the `# Conflicts:` block) and reports `{ kind: 'squashed', origHead,
conflicts }` — the same variant, with the conflicted paths present.

## Consequences

- Breaking-safe additive public options (`feat(merge)!` where error codes are added);
  `reports/api.json` and `docs/use/commands/merge.md` / `pull.md` updated.
- Interop rows compare commit SHAs, `SQUASH_MSG` / `MERGE_MSG` bytes, index and refs with git for each
  option and for mergeoptions-driven merges and pulls.
