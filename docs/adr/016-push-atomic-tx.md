# ADR-016: Push Atomic Capability — Negotiate If Advertised, Tolerate Partial

## Status

Accepted (at `d7ecbac`)

## Context

The smart-HTTP receive-pack protocol carries an `atomic` capability. When
the server advertises it and the client requests it, the server commits
ALL ref updates in a single transaction: if any per-ref hook rejects, the
server rolls every update back. Without `atomic`, ref updates apply
individually and a failure on one update does not affect the others.

For a single-ref push (the overwhelmingly common case in v1), the choice
is irrelevant — one update, all-or-nothing semantics either way.

For a multi-ref push, the trade-off is:
- **`atomic` requested**: the user gets transactional semantics. A failure
  on one ref aborts every ref. Cleanup on the client side is trivial: the
  pre-existing cached remote-tracking refs are still correct.
- **`atomic` not requested**: per-ref success is independent. The client
  sees a mixed `[ok, ng, ok]` response and must update its remote-tracking
  cache only for the `ok` refs.

The capability is purely server-side; the client either appends `atomic`
to the request's first pkt-line capability list or omits it.

## Decision

Phase 12.3 always **requests `atomic`** when the server advertises it
(simple intersection in `selectPushCapabilities`). If the server does not
advertise it, we omit it and tolerate the partial-success semantics.

The push command handles both cases identically at the application
level:

1. POST the pack.
2. Parse `parseReceivePackResponse` → `{ unpackOk, refUpdates }`.
3. For each `accepted: true` entry, update the corresponding
   `refs/remotes/<remote>/<branch>` cache atomically (`updateRef`).
4. For each `accepted: false` entry, leave the cache untouched and
   surface `status: 'rejected'`.

If `unpackOk === false`, throw `PUSH_REJECTED` with the server's
`unpackError` message — every refspec is implicitly rejected and no
cache update happens.

## Consequences

### Positive

- **Free safety upgrade.** Servers that advertise `atomic` give the user
  transactional multi-ref pushes without any extra API surface.
- **Multi-server compatibility.** Hosts that do not advertise the
  capability (older Bitbucket, some self-hosted gitea versions) still
  work — at the cost of weaker semantics, which the user can detect
  via the `pushedRefs` array's mixed statuses.
- **Identical client-side code path.** The capability bit changes
  server behaviour, not ours. No branching on `hasAtomic` in the
  command body.
- **Cache update is correct under both modes.** With `atomic`, all
  refs succeed or all fail — no partial cache update. Without, we
  update per accepted ref — the cache for each `ng` ref stays at the
  previous (still valid) value.

### Negative

- **No client-side "atomic emulation" when the server lacks the
  capability.** A partial multi-ref push leaves the user with a mixed
  state. Documenting this is the only mitigation; rolling back via a
  second push is out of scope (and unreliable: the server may not let
  us roll back).

### Neutral

- **`atomic` is per-request, not per-session.** Each push request
  re-negotiates capabilities. No state carried across pushes.
- **Reporting via `PushedRef.status`.** The caller distinguishes
  partial vs full success by inspecting the result array. This is
  the same contract canonical git uses for its scripted output.

### Alternatives considered

- **Never request `atomic` (simpler).** Drops a free safety feature on
  servers that advertise it. Rejected.
- **Always require `atomic` (fail if absent).** Surprises users on
  servers without the capability — they would see a `PUSH_REJECTED`
  for a perfectly valid configuration. Rejected; opt-out via the
  capability filter would be the next-best knob if a user explicitly
  needs it.
- **Per-ref retry on failure (client-side rollback).** Out of scope.
  Push is one round-trip; adding retry semantics belongs in a
  higher-level orchestration layer.
