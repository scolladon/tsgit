# ADR-385: `streamBlob` always streams — no size threshold, never keyed off `core.bigFileThreshold`

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-383](383-stream-blob-primitive.md)

## Context

git has `core.bigFileThreshold` (default 512 MiB) above which it changes its *internal*
handling of blobs. A naive assumption is that a streaming read should mirror that
threshold. Whether `streamBlob` should gate streaming behind any threshold — git's or a
tsgit constant or a caller-supplied one — is a load-bearing choice, and it intersects
the prime directive.

Faithfulness pinned against `git version 2.54.0` in a `mktemp` throwaway (scrubbed
`GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `commit.gpgsign=false`):

| Probe | Result | Verdict |
|---|---|---|
| `git hash-object f` vs `git -c core.bigFileThreshold=1 hash-object f` | identical SHA | SHA is not threshold-bound |
| commit a blob, `git -c core.bigFileThreshold=1 gc`, `git rev-parse HEAD:f` | stable before/after | on-disk object is not threshold-bound |
| git-config(1) on what it controls | "stored deflated, without attempting delta compression … treated as if binary" | affects packing/delta + diff, never object identity |

So `bigFileThreshold` is an internal memory/packing strategy with **no** observable
object-identity consequence. There is no git byte-output that a threshold would have to
match — `git cat-file -p` streams the same raw content regardless.

## Options considered

1. **(chosen) No threshold — `streamBlob` always streams**; the caller decides when to
   call it — pros: keeps `streamBlob` a pure capability; nothing to tune; no
   faithfulness coupling to a non-faithfulness-bound knob / cons: a caller streaming a
   tiny blob pays a marginally heavier path than `readBlob` (their choice).
2. **A tsgit constant** (e.g. auto-escalate above 16 MiB) — Rejected: only meaningful
   if `readBlob` auto-escalated (rejected in ADR-383); invents a magic threshold.
3. **Caller-supplied `minStreamBytes`** — Rejected for the same reason; adds an option
   that only matters under the rejected auto-escalation shape.

## Decision

`streamBlob` always streams. No streaming decision is ever keyed off
`core.bigFileThreshold` (or any size threshold). tsgit does not honour
`core.bigFileThreshold` anywhere (out of scope; it is a write/packing concern).

## Consequences

### Positive

- No magic threshold; no faithfulness coupling to an internal-only git knob.

### Negative

- Streaming a small blob is marginally heavier than `readBlob` (caller's call).

### Neutral

- If escalation is ever wanted, it lives inside `streamBlob`, not in `readBlob`.
