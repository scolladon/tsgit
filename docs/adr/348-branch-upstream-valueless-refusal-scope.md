# ADR-348: Valueless `branch.<name>.remote`/`.merge` refuse at `pull`'s upstream resolution only

## Status

Accepted (at `53b61b42`)

## Context

git dies with the `missing value` shape on a valueless `branch.<name>.remote` or `branch.<name>.merge` (pinned, git 2.54.0, exit 128) — and at **multiple** sites: `git status` (ahead/behind tracking), `git pull`, and `git rev-parse @{upstream}` all read the branch's upstream and die. Notably a valueless `branch.<name>.remote` dies **even though** an `origin` default would otherwise apply, and `branch.<name>.merge` dies independently of `.remote`.

In tsgit's command set, the canonical death site is `pull`'s `resolveUpstream`, which reads both keys (`opts.remote ?? tracking?.remote ?? 'origin'`, `opts.ref ?? shortMergeRef(tracking?.merge)`) before falling through to `NO_UPSTREAM_CONFIGURED`. The other readers — `remote rename`/`remove`'s `listBranchReferrers` (a pure equality filter) and submodule base-url's `resolveBaseUrl` (`?? 'origin'`) — are not git's pinned death command for these keys, and tsgit's `status` does not compute upstream tracking, so it has no read to die at.

## Decision

Guard `['remote','merge']` with a **single** multi-key `assertNoValuelessConfig(ctx, 'branch', <name>, ['remote','merge'])` call **early in `pull`'s `resolveUpstream`**, before the `?? 'origin'` and `?? merge` fallbacks substitute defaults — so a valueless `remote` refuses despite the would-be `origin` default, and the first valueless key by config-file line is reported (matching git's per-entry callback order, ADR-327). Do **not** guard the `listBranchReferrers` / `resolveBaseUrl` reads or add upstream-tracking to `status` in this change.

## Consequences

### Positive

- `pull` matches git's valueless-upstream refusal, including the both-valueless file-line ordering, via one reused enabler call.
- Bounded diff: one guard at the canonical death site.

### Negative

- `remote rename`/`remove` and submodule base-url reads of `branch.<name>.remote` stay unguarded; a valueless value there does not refuse as git would. Documented; a follow-up if a real consumer needs it.

### Neutral

- tsgit's `status` not refusing is a consequence of it not computing upstream tracking at all (a pre-existing scope gap), not of this guard placement.
