---
subjects:
  - src/application/primitives/fetch-pack.ts
---
# 804 — A re-received identical pack is tolerated before the rename, as git does

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/bench-snapshot-summary-adr-lint.md (D5) · **Supersedes/Refines:** refines ADR-728

## Context

Pinned against git 2.55.0 in an isolated throwaway: receiving a byte-identical pack a second
time exits 0, prints nothing, and leaves the existing `.pack`, `.idx` and `.rev` untouched, whether
through `index-pack --stdin`, a fetch with the unpack limit forcing a pack, or a push into a
bare repository. tsgit diverges twice: `materializePack` renames the quarantined pack into place
unconditionally, clobbering the destination, and the sibling writer then refuses the `.idx` with
`FILE_EXISTS`. `clone` and `fetch` surface that refusal; only `fetch-missing` tolerates it, and the
one test that claims to cover the tolerance pre-creates only the `.pack`, which the rename
overwrites, so its assertion cannot tell the two outcomes apart. ADR-728 pinned the quarantine
lifecycle and explicitly did not pin the already-present destination. The prime directive
(ADR-226) binds every change; this is a user-visible divergence, not a bench artefact.

## Options considered

1. **Bench-only in this PR; escalate the receive-path fix as a follow-up** — pros: the smallest
   PR / cons: leaves a pinned divergence in place, as the sole exception to the no-follow-ups
   rule.
2. **Fix it here, before the rename** (designer's recommendation) — `materializePack` treats an
   occupied `pack-<sha>.*` destination as already done, checked before the rename so nothing is
   clobbered, with a cross-tool interop test pinning git's silent exit 0 / cons: touches `src/`
   in a run whose mutation harness is waived.
3. **Catch `FILE_EXISTS` after the rename and return the existing artefacts** — cons: keeps a
   clobber-then-recover ordering git never performs.

## Decision

**Ratified by the user: option 2.** When the content-addressed destination pack already exists,
the receive path discards its quarantine copy and returns the existing artefacts without
renaming or rewriting anything; the check happens before the rename. A cross-tool interop test
receives one pack twice and asserts the second call succeeds with the artefacts unchanged, with
real git reproducing the same sequence in the same fixture. The `fetch-missing` tolerance test
is repaired to pre-create the sibling the writer actually collides on. The user chose to run the
mutation harness standalone on the `src/` diff before the PR, since this run waived it.

## Consequences

Receiving an already-present pack is idempotent and silent, as in git. The existing-pack check
is by path, matching git's own already-present test (which keeps even a tampered loose object).
ADR-728's temp-file posture is unchanged: the quarantine copy is unlinked as a handled outcome.
