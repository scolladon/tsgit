# 575 — Full per-pack registry degradation (header, unopenable pack, corrupt idx)

- **Status:** accepted
- **Date:** 2026-08-07
- **Design:** docs/design/pack-v3-read-compliance.md · **Supersedes/Refines:** refines ADR-226; extends ADR-572/573

## Context

Git's `is_pack_valid` treats *any* failure to open or validate a pack as "this pack is
absent", per pack. Beyond the version gate, two adjacent pre-existing tsgit divergences
were pinned (Pin H): a `.idx` whose `.pack` was deleted (git warns and treats the pack as
absent; tsgit surfaces the adapter's ENOENT), and a corrupt `.idx` (git skips that pack
and still serves loose objects; tsgit's memoised scan rejects, failing **every** read
through that `Context`).

## Options considered

1. **Header-invalid only** — strict minimum per the backlog brief; leaves the
   idx-without-pack divergence one line from its fix.
2. **Header + unopenable pack** (designer's recommendation) — also skip on ENOENT/EACCES
   from the 12-byte probe; closes Pin H row 1 in the catch clause already being written.
3. **Full per-pack degradation** — additionally, a `.idx` that fails to parse skips that
   pack instead of rejecting the whole scan (Pin H row 2). Largest blast radius: converts
   a currently-fatal condition to non-fatal registry-wide; existing unit tests assert
   today's reject-the-scan behaviour and must flip.

## Decision

**User ratified option 3 — full per-pack degradation**, deviating from the
recommendation. The skip discriminator (`isSkippablePackFault`) recognises: invalid pack
header (signature / truncation / version outside 2|3), a pack file that cannot be opened
for the header probe, and — at the scan layer — a `.idx` that fails to read or parse,
which excludes that pack from the generation instead of rejecting the scan. Every
recognised skip logs a structured `ctx.logger?.warn?.` with the pack name; anything
unrecognised still re-throws.

## Consequences

The registry degrades per-pack like git everywhere; loose objects and sibling packs are
never poisoned by one bad pack (or bad idx). Existing unit tests pinning
reject-the-whole-scan for a corrupt idx are inverted as part of this change, and the twin
interop matrix gains idx-corruption rows pinned against real git. This forecloses
treating registry-scan failure as a store-integrity signal; `fsck`-grade integrity
reporting is a separate surface (see ADR-572's documented enumeration gap).
