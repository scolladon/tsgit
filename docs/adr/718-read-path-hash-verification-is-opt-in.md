---
subjects:
  - src/application/primitives/read-object.ts
  - src/application/primitives/object-resolver.ts
  - src/application/primitives/walk-commits.ts
  - src/application/primitives/internal/commit-date-walk.ts
  - src/application/primitives/internal/blob-source.ts
  - src/application/commands/bundle-verify.ts
supersedes:
  - adr: "389"
    scope: "the default-on verification posture and its consistency-with-readObject premise"
---
# 718 — Read-path hash verification is opt-in

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-1) · **Supersedes/Refines:** supersedes ADR-389 (default posture only); ADR-394's `{ verifyHash }` option surface is unchanged

## Context

Every buffered and streamed object read defaults `verifyHash` to on across five
independent `?? true` sites, re-hashing bytes on every read — including delta-cache hits
of bytes tsgit itself verified and cached. An empirical pin against git 2.55.0 shows
canonical git serves wrong bytes at exit 0 on `cat-file`, `checkout`, `log`, `rev-list`
and `show` for both loose and packed objects, verifying only in `fsck`, `verify-pack`
and `bundle verify`. The default-on posture is therefore stricter than git — the same
divergence class the containment posture decision already resolved — and it is the
largest single read-path CPU cost in the current profile.

## Options considered

1. **Flip all five defaults to off; `bundle verify` passes `verifyHash: true` explicitly** (recommended, chosen) — pros: reproduces git's verify/don't-verify split exactly, makes `bundle verify` more faithful than today / cons: a corrupt object propagates on ordinary reads; a published security claim must be amended.
2. **Only skip verification on delta-cache hits** — pros: one line, ~99 % of the profiled win / cons: leaves the stricter-than-git posture and its false premise standing.
3. **Keep default-on** — pros: no change / cons: leaves the cost and the divergence in place.

## Decision

**User-ratified.** `verifyHash` defaults to **false** at all five sites
(`readObject`/`readRawObject`, the two walk layers, `streamBlob`). The option remains on
every surface; callers may opt in. `bundle-verify` passes `verifyHash: true` explicitly,
matching git's behaviour on that surface. `fsck` and the write path keep their own
independent verification. The abort poll that rode the verification step is preserved by
an explicit poll at the same point.

Superseded from ADR-389: the default-on posture and the premise that dropping
verification "would weaken faithfulness relative to the buffered API" — the pin shows
git itself does not verify on reads, so default-off is the faithful posture.
Carried forward from ADR-389: the incremental end-of-stream verification mechanism for
`streamBlob` and the `{ verifyHash }` option surface, both unchanged when a caller opts in.

## Consequences

A corrupt object read through the default path streams/returns wrong bytes exactly as
git does; detection lives in `fsck` and `bundle verify`. `docs/understand/security.md`'s
verify-on-read claim is amended in the implementing change. Tests that pinned the
default-on behaviour are inverted (explicit `verifyHash: true` coverage remains), and the
two Stryker equivalence proofs citing the old default are re-proved.
