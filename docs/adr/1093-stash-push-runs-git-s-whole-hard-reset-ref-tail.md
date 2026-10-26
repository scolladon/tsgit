---
subjects:
  - src/application/commands/stash.ts
  - src/application/commands/reset.ts
---
# 1093 — `stash push` runs git's whole hard-reset ref tail

- **Status:** accepted
- **Date:** 2026-10-26
- **Design:** docs/design/forced-checkout-same-commit.md (DC6, F11, F16) · **Supersedes/Refines:** refines ADR-1091

## Context

After it saves a stash, git's `stash push` runs a child `reset --hard`. That child writes ORIG_HEAD = HEAD (attached
or detached), appends the `reset: moving to HEAD` HEAD reflog entry when HEAD is attached, and removes branch state.
tsgit does none of this.

## Options considered

1. **Run the whole tail through a `recordHardReset` helper extracted from `reset.ts`.**
2. **Write only the reflog line.**

## Decision

**Adopted as recommended (no user judgment): option 1.** It reuses the three steps `reset` already runs. Option 2
would leave a proven ORIG_HEAD gap on the call site this change edits.

## Consequences

- `reset` and `stash push` share one ref-tail helper.
