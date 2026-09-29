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
  padding. An over-run is corrupt. git words the under-run mismatch as `hash mismatch for <path>`
  plus `object corrupt or missing`. tsgit maps it to the same structured `hash-mismatch` finding
  it uses for the small-file path.
- Like git, `fsck` never types a loose object that `read_loose_object` refuses or whose hash
  disagrees with its path, whatever the cause:
  - a wrong path;
  - an under-run or an in-window over-run;
  - either big-file route;
  - an undecodable stream.

  git's `fsck_loose` returns before `parse_object_buffer`, which gives two outcomes:
  - Unreferenced, the object is reported for its content only, with no `dangling` or
    `unreachable` line.
  - Referenced, it is reported `missing <type>`. The type is read from the referencing edge, no
    `broken link` line accompanies it, and the missing bit is added to the exit code (3).

  `--connectivity-only` keeps ADR-590's handling.

  Both outcomes apply only when no pack holds a copy of the id. git's `check_object` stops at
  `has_object_pack` ("it is in pack - forget about it"), which has three consequences:
  - A referenced corrupt packed entry is never reported `missing`.
  - A tag whose target is present but unreadable still reports `tagged`.
  - A bad loose file shadowing a good packed copy leaves that object typed from the pack.
- Known gap: git checks each packed entry's CRC against the `.idx` (`index CRC mismatch`,
  `cannot unpack`) and sets ERROR_PACK (exit 4). tsgit's fsck has no per-entry CRC pass. It
  reports such an entry through content validation (`bad-object`, exit 1). `EXIT_PACK` stays
  wired only to whole-pack failures.
- **Divergence: the padding bytes.** git's `unpack_loose_rest` pads an under-run through
  `xmallocz`, which is not zero-initialised. For the same fixture, the padding git hashes, and
  so the hash-path mismatch oid it reports, can differ from run to run (3 of 150 runs at claims
  1024 and 1025). tsgit pads with zero bytes, which gives one stable value for a case git cannot
  reproduce. Interop rows therefore pin only the deterministic part of git's output: the
  `hash-path mismatch, found at: <path>` line and the exit code. tsgit's zero-padded value is
  pinned against tsgit alone.
- Accepted cost, as in git: an under-running commit, tree or tag is zero-pad hashed up to its
  claim under any config. Only blobs are gated by `core.bigFileThreshold`. A ~40-byte loose
  commit claiming just under 2 GiB costs one ~2 GiB SHA pass per object, like git's `xmallocz` of the
  declared size.
- Known gap, not probed against git: a claim at or above the 2 GiB inflate ceiling is reported as
  `unterminatedHeader`. For commits, trees and tags this is reachable under default config; for
  blobs, only when `core.bigFileThreshold` is set above 2 GiB.
- Divergence: an invalid `core.bigFileThreshold` is fatal in git but read as absent by tsgit,
  the existing precedent for `core.packedGitLimit` and `core.deltaBaseCacheLimit`.
