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

**Ratified by the user: option 2, amended after review.** The receive path lands its verified
quarantine copy at the content-addressed name the way git's finalize step does, per artefact:

- a free name takes the copy by rename;
- an occupant whose bytes are identical to the copy keeps its place — same inode, same mtime —
  and the copy is discarded as a handled outcome;
- an occupant whose bytes differ is refused with `PACK_ARTIFACT_MISMATCH` naming the artefact,
  never overwritten;
- then every sibling (`.idx`, `.rev`, the `.promisor` sentinel) is written where its name is
  free, kept where an identical file already sits, and refused where a differing one does — the
  sentinel is kept whatever it holds, since git writes free-form text there.

The comparison is by content, in bounded windows, so a pack larger than memory is never held at
once. The check happens before any rename, so nothing is clobbered. A cross-tool interop test
receives one pack twice and asserts the second call succeeds with the artefacts unchanged, that a
planted foreign file and a zero-byte index are refused, and that missing siblings are recreated,
with real git reproducing every sequence in the same fixture. `fetch-missing`'s former
`FILE_EXISTS` tolerance is removed as dead code: the receive path now adopts an identical pack
itself, and a differing artefact is a refusal there too. The user chose to run the mutation
harness standalone on the `src/` diff before the PR, since this run waived it.

**Amended 2026-09-05 (review).** The first ruling adopted an existing destination by path alone,
on the design's pin that git's already-present test is "path existence, never content". That pin
came from a loose-object control and does not carry to packs: pinned against git 2.55.0, a
planted foreign `.pack` at the content-addressed name makes `index-pack` refuse with "differ in
contents" (exit 128), a zero-byte `.idx` beside a real pack is refused the same way, and a
`.pack` whose siblings went missing gets them silently recreated. The per-artefact
compare-and-complete rule above replaces the path-only rule; ADR-728's quarantine posture is
untouched.

## Consequences

Receiving an already-present pack is idempotent and silent, as in git; a receive that finds a
differing artefact at a content-addressed name refuses loudly, as in git, instead of adopting
corruption or tampering as success. Because every artefact is attempted and tolerated rather
than pre-checked, two concurrent receives of the same pack both succeed whichever lands first.
The refusal is a new public error code (`PACK_ARTIFACT_MISMATCH`, with the artefact path), so the
error reference and the committed API snapshot carry it. ADR-728's temp-file posture is
unchanged: the quarantine copy is unlinked as a handled outcome.
