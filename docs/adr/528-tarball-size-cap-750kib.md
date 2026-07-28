# ADR-528: Raise the tarball `SIZE_CAP` to 750 KiB

## Status

Accepted (at `9e128c04`) — adopted-as-recommended (no user judgment)

## Context

The bundle must ship in the npm tarball (CDNs serve exclusively from it), adding
a measured +133 107 B that gzip cannot dedupe against `dist/esm/` (32 KiB window
vs a 1.8 MB tar stream). The packed tarball goes from 538 829 B to 671 936 B,
failing `tooling/verify-tarball.sh`'s current `SIZE_CAP` of 563 200 (550 KiB) —
the raise is forced; only the number is a choice. ADR-469 set the cap by
`measured × 1.1–1.15`, rounded to a clean KiB boundary, and rejected caps in the
single-digit-headroom fragility band. The old cap had drifted to 4.3 % headroom
already.

## Decision

`SIZE_CAP` becomes 768 000 bytes (750 KiB): 14.3 % headroom over the measured
671 936 B, per ADR-469's own method. 700 KiB (6.7 %) sits in the rejected
fragility band; 800 KiB (22 %) is loose enough to hide a real regression.

## Consequences

### Positive

- `check:tarball`/`verify:tarball` stay meaningful: tight by choice, headroom by
  method rather than guesswork.

### Negative

- A genuinely oversized future artefact has 133 KiB more room to hide in than
  under the old cap.

### Neutral

- Orthogonal to the artefact's path (ADR-525): the tarball grows identically
  wherever the file sits.
