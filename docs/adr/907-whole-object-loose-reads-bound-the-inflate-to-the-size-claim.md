---
subjects:
  - src/application/primitives/read-object.ts
  - src/application/primitives/internal/blob-source.ts
  - src/application/commands/fsck.ts
supersedes:
  - adr: "863"
    scope: "whole-object reads of a size-lying loose blob serve its real bytes"
---
# 907 — Whole-object loose reads bound the inflate to the size claim, like git

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/diff-core-parity-hardening.md (item 1, H1) · **Supersedes:** ADR-863 (whole-object blob reads only)

## Context

A loose blob whose header claims 6 bytes but inflates to 200 MB passed the declared-size gate
and was inflated in full (20 such blobs: ~8.4 s / ~580 MB). git's whole-object read
(`unpack_loose_rest`) inflates at most header + claim and refuses an overrun, while its
streaming routes (`cat-file` content, `show` of a blob, checkout) serve the real bytes.
ADR-863 served the real bytes on every route.

## Options considered

1. **git's tiers** — whole-object reads bound to the claim (refuse an overrun past git's
   32-byte header window, truncate inside it); streaming routes keep real bytes; a short body
   keeps ADR-863's residual. *Recommended by the design.*
2. Refuse every overrun on every route.
3. Bound rename/break hydration only.

## Decision

**Option 1 — ratified by the user.** `fsck` reports a size-lying blob as git does.

Superseded from ADR-863: whole-object reads of a size-lying loose blob serving its real bytes.
Carried forward from ADR-863: streaming routes serving real bytes; commit/tree/tag refusal;
the short-body residual; ADR-854's cache value shape.

## Consequences

- The hostile rename case drops to git's order of magnitude.

## Amendment — fsck follows `read_loose_object` for every type (2026-09-28)

- `fsck` checks commits, trees and tags the same way it checks blobs, as git does:
  - an under-run is hashed with padding;
  - an over-run inside the 32-byte window is truncated to the claim and hashed;
  - an over-run past the window is corrupt.

  `readObject` keeps ADR-863's refusal of a size-lying commit, tree or tag. Only `fsck`'s
  verdict changes.
- A loose blob whose claim exceeds `core.bigFileThreshold` (default 512 MiB, strict `>`) takes
  git's `check_stream_oid` route. `fsck` hashes the declared header plus the real bytes with no
  padding. An over-run is corrupt, and the object is left untyped for reachability.
- **Divergence: the padding bytes.** git's `unpack_loose_rest` pads an under-run through
  `xmallocz`, which is not zero-initialised. For the same fixture, the padding git hashes, and
  so the hash-path mismatch oid it reports, can differ from run to run (3 of 150 runs at claims
  1024 and 1025). tsgit pads with zero bytes, which gives one stable value for a case git cannot
  reproduce. Interop rows therefore pin only the deterministic part of git's output: the
  `hash-path mismatch, found at: <path>` line and the exit code. tsgit's zero-padded value is
  pinned against tsgit alone.
- Known gap: the 2 GiB zero-pad ceiling can only be reached when `core.bigFileThreshold` is
  configured above 2 GiB. That case has not been probed against git.
- Divergence: an invalid `core.bigFileThreshold` is fatal in git but read as absent by tsgit,
  the existing precedent for `core.packedGitLimit` and `core.deltaBaseCacheLimit`.
