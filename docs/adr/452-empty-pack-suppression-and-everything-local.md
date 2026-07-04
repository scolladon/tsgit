# 452 — Suppress empty-pack artifacts; short-circuit fully-local fetches

- **Status:** accepted
- **Date:** 2026-07-04
- **Design:** docs/design/incremental-fetch-negotiation.md · **Relates:** ADR-450 (v2 primary), ADR-451 (v1 fallback), ADR-226 (git-faithfulness)
- **Decision class:** D-faithfulness (adopted-as-recommended, no user judgment)

## Context

Once negotiation is correct (ADR-450, ADR-451), a no-op fetch — the client already has every
wanted oid — returns an **empty, 0-object pack** (confirmed on the wire: `objectCount=0`, the
32-byte empty-pack trailer). Two faithfulness gaps follow: (1) writing that empty pack as an
on-disk artifact diverges from git, which writes nothing; (2) git does not even send the request
when every want is already local — it short-circuits via `everything_local`. Both paths (v2 and
the v1 fallback) hit this once framing is correct.

## Options considered

1. **Do nothing** — write the empty pack, always POST. *Rejected: faithfulness violation
   (spurious empty artifact).*
2. **Suppress the empty-pack write only** — minimal no-regression; still sends the POST.
3. **Suppress empty-pack write + `everything_local` short-circuit** *(design recommendation)* —
   also skip the POST when every want is already local, mirroring git; requires a cheap per-want
   existence probe.

## Decision

**Option 3, adopted as recommended (no user judgment)** — aligns with the git-faithfulness prime
directive (ADR-226). `fetchPack` never writes a pack/index artifact when the response is a
0-object pack (refs/reflogs still update — there is nothing to store). `fetch` short-circuits
when every wanted oid is present locally, via a new local-only `hasObject` probe (design D1:
pack-registry lookup ∨ loose-fs `exists`; no inflate, no promisor fallback). Protocol-agnostic —
applies to v2 and the v1 fallback alike.

## Consequences

### Positive
- No spurious empty `.pack`/`.idx` artifacts (faithful to git).
- No needless network round for a fully-local fetch (faithful to git's `everything_local`) — a
  latency win for the common up-to-date case.

### Negative
- Needs a per-want existence probe; the design adds a dedicated `hasObject` primitive rather than
  reusing `readObject` (which would fire a promisor network fetch and fully inflate for a boolean).

### Neutral
- The guard is orthogonal to negotiation strategy; it composes with both paths and with `pull`'s
  over-the-wire fast-forward.
