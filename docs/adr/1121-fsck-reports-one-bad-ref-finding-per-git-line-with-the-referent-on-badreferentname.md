---
subjects:
  - src/application/commands/internal/fsck/types.ts
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/application/primitives/ref-store.ts
  - test/integration/fsck-line-helpers.ts
---
# 1121 — fsck reports one `bad-ref` finding per git line, with the referent on `badReferentName`

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (D1) · **Supersedes/Refines:** refines ADR-226 and ADR-249

## Context

Pinned on git 2.56.0 in scrubbed throwaways: a chain `a` → `b` whose `b` holds garbage prints
`refs/heads/b: badRefContent: garbage` and one `invalid sha1 pointer 0000…` line for **each** of
`a` and `b` (exit 10); a `b` holding `ref: x..y` prints
`refs/heads/b: badReferentName: points to invalid refname 'x..y'` plus the same two pointer lines.
tsgit's `FsckFinding` already has a `bad-ref` arm keyed by git's msgId that every consumer filters
on (`msgId === 'badRefOid'`), but it emits no pointer for `a` and never produces `badReferentName`.
ADR-249 forbids a rendered line: the interop test rebuilds git's text from structured fields.

## Options considered

1. **One `bad-ref` finding per git line, existing msgIds, a new optional `referent: string` on
   `badReferentName` and `symrefTargetIsNotARef`** (designer's recommendation) — pros: matches
   git's per-ref data one to one, the union and its consumers are unchanged / cons: a caller
   reassembles a chain by following the pointers itself.
2. **One finding per broken chain** (`{ ref: <referent>, cause, chain: RefName[] }`) — pros: the
   chain is explicit / cons: a grouping git does not have, and it breaks every `badRefOid` consumer.
3. **Per line without `referent`** — pros: no new field / cons: hides the one datum a caller cannot
   recover by resolving, because the ref does not parse.

## Decision

**Ratified by the user: option 1.** Every line git's refs-verify pass prints is one `bad-ref`
finding carrying git's msgId and severity: `badRefContent` on the referent (no content carried, as
today), `badReferentName` and `symrefTargetIsNotARef` on the referent with `referent` set to the
name exactly as the body wrote it (not a `RefName`), and one `badRefOid` with `target` = the zero
oid for **every** ref of the chain whose resolution fails. The interop suite rebuilds git's text
from those fields and compares it to real git.

## Consequences

- `FsckFinding`'s `bad-ref` arm gains `referent?: string`; the change is additive for consumers.
- A chain of three yields three pointer findings and one content finding, in git's order
  (content first, then pointers by name).
- A `content?` field for `badRefContent` stays a symmetric follow-up, not part of this change.
