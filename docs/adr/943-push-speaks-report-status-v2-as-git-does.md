---
subjects:
  - src/application/commands/push.ts
  - src/application/commands/internal/receive-pack-client.ts
---
# 943 — Push speaks report-status-v2 and applies its ref rewrites, as git does

- **Status:** accepted
- **Date:** 2026-10-05
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-942, ADR-226

## Context

git's send-pack asks for `report-status-v2` whenever the receiver advertises it, which every git
receive-pack does (`send-pack.c:618-633`). Under v2 a `proc-receive` hook may answer one command with
`option refname`, `option old-oid`, `option new-oid` and `option forced-update` lines, so one pushed
ref can report under a different name or several names (the AGit flow, `refs/for/<branch>`). git
updates remote-tracking refs from those rewritten reports (`send-pack.c:192-231`). tsgit requested
`report-status` (v1) only.

## Options considered

1. **Speak v2 and apply the option lines** to the per-ref reports and the tracking refs, as git does.
2. **Keep v1**, recording the divergence (identical without a `proc-receive` hook).
3. **Speak v2 but ignore the option lines** — tracking refs silently diverge from git.

## Decision

**Option 1, adopted under ADR-226** (it is what git does; the user has ratified the faithful option
on every comparable push decision, ADR-942). Push requests `report-status-v2` when advertised, falls
back to `report-status` otherwise, parses the option lines, and reports each rewritten ref as its own
`PushedRef` with the rewritten name and ids (`forcedUpdate` when the hook says so). Remote-tracking
refs are updated from the rewritten reports, as `update_tracking_ref` does.

## Consequences

- Public `PushedRef` gains the fields the option lines carry (marked `!`); `reports/api.json` and
  `docs/use/commands/push.md` are updated.
- Interop rows run a real `proc-receive` hook (AGit-style) and compare per-ref reports and tracking
  refs with git's.
