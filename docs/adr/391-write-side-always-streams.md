# ADR-391: The write side always streams regular-file blobs — no size threshold

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-385](385-no-streaming-threshold.md)

## Context

The checkout consumer can either stream every regular-file write or buffer small files
and stream only large ones. The read side already always streams with no threshold
(ADR-385); the question is whether the write side mirrors that or auto-escalates.

## Options considered

1. **(chosen) Always stream every regular-file write** — pros: one code path; mirrors
   ADR-385's always-stream read posture; no magic threshold; no faithfulness coupling;
   the read→write pipeline is uniform / cons: streaming a tiny file carries marginally
   more overhead than a buffered `write` (negligible, and symlink/gitlink already stay
   buffered).
2. **Buffer below a tsgit constant (e.g. 16 MiB), stream above** — Rejected: a second
   code path and a magic threshold, justified only by a measured per-small-file cost
   that has not been shown; if ever needed it is a documented tsgit policy, never
   `core.bigFileThreshold`.
3. **Escalate off a caller option** — Rejected: adds a knob no current consumer needs.

## Decision

Every regular-file (100644 / 100755) working-tree materialisation streams via
`streamBlob` → `writeStream` (ADR-390). Symlink (120000) and gitlink (160000) modes stay
buffered — their content is a tiny path string or nothing, so streaming would be
pointless complexity.

## Consequences

### Positive

- Single uniform path; consistent with the read side; no threshold to tune.

### Negative

- Marginal per-small-file overhead vs a buffered write (negligible).

### Neutral

- If a per-small-file cost ever surfaces, a buffer-small/stream-large split is a future
  documented option.
