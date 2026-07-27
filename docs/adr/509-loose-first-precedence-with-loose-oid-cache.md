# 509 — Keep loose-first object-store precedence; amortise the probe with a per-fanout-dir loose-oid cache

- **Status:** accepted
- **Date:** 2026-07-27
- **Design:** docs/design/close-isogit-perf-gap.md · **Supersedes/Refines:** refines ADR-226; upholds checkcontainment-hot-path DC-7

## Context

On packed repos every `resolveObject` call pays a per-object loose probe (`fs.exists` → realpath-follow + internally-thrown ENOENT) before falling back to the pack — 14% of log-walk samples land in `handleErrorFromBinding`. The brief proposed reordering to pack-first as "more git-faithful", but the empirical pin (git 2.55.0, both-stores case with a corrupt loose copy) shows git consults the loose store on content reads and surfaces its inflate error even when a valid pack copy exists. Pack-first would silently skip the corrupt copy — an observable divergence.

## Options considered

1. **Pack-first reorder** — pros: kills the probe entirely / cons: diverges from the pinned precedence (ADR-226), needs a divergence ADR; observable stderr difference in the both-stores/corrupt case.
2. **Loose-first + per-fanout-dir loose-oid cache (recommended)** — pros: preserves pinned precedence exactly; replaces per-object realpath+ENOENT with ≤256 lazy `readdir`s per walk (git's own `odb_loose_cache` mechanism); generation-counter invalidation already exists / cons: cache invalidation surface.
3. **Loose-first + cheaper per-object probe** — pros: minimal change / cons: no amortisation; this shape previously regressed cold single reads.

## Decision

**Option 2 (user-ratified).** `resolveObject` keeps loose-before-pack precedence. The per-object existence probe is replaced by a lazily-built, per-fanout-dir (`objects/xx`) in-memory sorted oid-set populated by one `readdir`, invalidated via the existing generation counter. A membership hit still reads through `ctx.fs.read` (containment gate and corrupt-loose behaviour unchanged).

## Consequences

Packed walks no longer pay per-object loose I/O; faithfulness pin (corrupt-loose error surfaced in the both-stores case) holds byte-for-byte. Commits us to keeping the fanout cache coherent with loose-object writes (generation bump on write/prune). Forecloses pack-first reordering unless a future ADR revisits it.
