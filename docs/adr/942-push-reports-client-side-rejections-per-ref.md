---
subjects:
  - src/application/commands/push.ts
---
# 942 — Push reports client-side rejections per ref, as git does

- **Status:** accepted
- **Date:** 2026-10-05
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-249, ADR-226

## Context

git's `set_ref_status_for_push` judges each ref before sending: not a fast-forward
(`REJECT_NONFASTFORWARD`), either end not found or not a commit (`REJECT_NEEDS_FORCE`), the
advertised commit missing locally (`REJECT_FETCH_FIRST`), or a `refs/tags/` destination that already
exists (`REJECT_ALREADY_EXISTS`). A rejected ref does not stop the push: git still sends the
accepted refs, still feeds the rejected ref's new value into `pack-objects`, and prints one status
line per ref. tsgit threw `NON_FAST_FORWARD` for the whole push and sent nothing. `PushedRef` already
carries `status: 'ok' | 'rejected'` and a free-text `reason` (the remote's `ng` message).

## Options considered

1. **Per-ref, structured** — push carries on; a rejected ref reports a structured rejection kind.
2. **Per-ref, text reason only** — same behaviour, rejection in the free-text `reason`.
3. **Keep throwing** `NON_FAST_FORWARD` for the whole push.

## Decision

**User-ratified — option 1.** Push carries on past client-side rejections exactly as git does and
returns every ref's outcome. A rejected `PushedRef` gains
`rejection: 'non-fast-forward' | 'needs-force' | 'fetch-first' | 'already-exists' | 'remote'`
(`'remote'` when the server's `ng` line rejected it, with its text kept in `reason`). The client-side
`NON_FAST_FORWARD` throw is removed.

**Amendment (2026-10-05).** The union covers every per-ref rejection git's push reports, not only the
four judged by `set_ref_status_for_push`: `'stale-info'` (`REJECT_STALE`, a `--force-with-lease`
expectation that no longer holds) and `'remote-ref-not-deletable'` (`REJECT_NODELETE`, a delete
refused because the server lacks `delete-refs`) join it, so the stale-lease case leaves
`PUSH_REJECTED` for the per-ref result as the other rejections did. An atomic push aborts every ref
on a client-side rejection, exactly as git's `atomic` push does: `atomic: true` is git's `--atomic`,
the only push that requests the `atomic` capability (superseding ADR-016's always-request), refused
with `ATOMIC_PUSH_UNSUPPORTED` when the server does not advertise it; the refs it holds back report
`'atomic-push-failed'` (`REF_STATUS_ATOMIC_PUSH_FAILED`).

## Consequences

- Breaking public change (`feat(push)!`): callers that caught `NON_FAST_FORWARD` read the per-ref
  result instead; `reports/api.json` and `docs/use/commands/push.md` are updated.
- Pack contents follow git: the rejected ref's objects are still enumerated and sent.
- Interop rows rebuild git's per-ref status lines (`! [rejected] … (non-fast-forward)`,
  `(needs force)`, `(fetch first)`, `(already exists)`) from the structured result.
