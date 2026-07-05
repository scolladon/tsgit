# 450 — Smart-HTTP protocol v2 for discovery and fetch, v1 as fallback

- **Status:** accepted
- **Date:** 2026-07-04
- **Design:** docs/design/incremental-fetch-negotiation.md · **Supersedes:** ADR-005 (clone protocol v1-only deferral) · **Refines:** ADR-010 (fetch haves strategy) · **Relates:** ADR-226 (git-faithfulness)
- **Decision class:** D-scope (user judgment) — deviates from the design's recommendation

## Context

Backlog 25.3 must deliver **incremental fetch negotiation**. The pinned defect is a v1
request-framing bug (ADR-451): `want C1 / have C0 / done` returns no pack, so "remote
advanced → fetch new objects" is broken while `clone` and no-op `fetch` work. The minimal
fix is ~3 lines. ADR-005 shipped smart-HTTP **v1 only** and deferred v2 — *"a future phase
… will revisit the decision when filter capabilities become required"*; ADR-010 deferred
multi-round negotiation. v2 has no implementation: `decodePktStream` accepts a `v2` flag and
recognizes delim/response-end frames, but no `ls-refs` / v2-`fetch` parsers exist. The
choice is between the minimal v1 framing fix and building the v2 surface ADR-005 anticipated.

## Options considered

1. **Framing fix, keep single-round v1** *(design recommendation)* — correct the spurious
   `0000` flush before `done`; keep ADR-010's single-round strategy. ~3 lines, byte-identical
   packs/refs, smallest surface.
2. **Full v1 multi-round negotiation** — reopen ADR-010 Strategy 2 (progressive have-batches
   across POSTs). Large surface for zero observable-result difference vs option 1.
3. **Full protocol v2 (`ls-refs` + `fetch`)** *(user choice)* — v2 primary for discovery +
   fetch (hence clone) via `Git-Protocol: version=2`, with a corrected v1 as fallback.
   Matches the backlog title, unblocks the `filter`/partial-clone path ADR-005 foreclosed.

## Decision

**Option 3, ratified by the user**, overriding the design recommendation. tsgit opts into v2
via `Git-Protocol: version=2`; discovery uses the v2 **`ls-refs`** command, fetch/clone uses
the v2 **`fetch`** command (`acknowledgments`/`packfile` sections, `ack`/`ready`/`done`).
When the server does not advertise v2, fall back to a corrected v1 (ADR-451). This supersedes
ADR-005's v1-only deferral for discovery + fetch; `pull` composes over the corrected fetch
with no change. Triggers the **scope-fold rule**: the design is revised to specify the v2
path before planning.

## Consequences

### Positive
- Real protocol v2 (`ls-refs` + `fetch` with section responses); incremental fetch on both
  the v2 primary and the corrected-v1 fallback paths.
- Unblocks the `filter` / partial-clone capabilities ADR-005 §Negative foreclosed.
- Wire-faithful to canonical git against modern hosts, which advertise v2.

### Negative
- Substantial new wire-parsing surface (~600 LOC by ADR-005's estimate): v2 capability parser,
  `ls-refs` path, v2 `fetch` builder, delim/section-aware response parser.
- Clone's discovery gains a v2 variant — a regression surface for a working command, mitigated
  by the mandatory v1 fallback and interop pins on **both** clone-over-v2 and fetch-over-v2.
- The interop harness must forward `Git-Protocol` → `GIT_PROTOCOL` (CGI env), or
  `git-http-backend` silently downgrades to v1 and the v2 path goes unexercised.

### Neutral
- `decodePktStream`'s `v2` flag (kept "for the future implementation" by ADR-005) is now used.
- `MAX_HAVES = 256` (ADR-010) still bounds the v1-fallback request body; v2 negotiation is
  round-based.
- SSH stays v1; SSH gets incremental fetch via the corrected fallback (ADR-451). v2-over-SSH
  is out of scope for smart-HTTP v2.
