# 693 — The object algorithm reaches `Context` by both channels, and the option wins

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/sha256-object-format.md (candidate D1) · **Refines:** ADR-681

## Context

The object algorithm must reach `Context.hashConfig` and `Context.hash`. Two channels exist and
neither covers every case alone: `extensions.objectFormat` is read by the Stage-2 open-time
layout read, but the two **synchronous** adapter factories (`createNodeContext`,
`createBrowserContext`) can never detect it without becoming `async`, and `init`'s layout is
synthetic — there is no repository to read the format from yet.

## Options considered

1. **Widen the layout channel only** — cons: the sync factories and `init` cannot use it.
2. **An explicit `algorithm` option only** — cons: opening an existing SHA-256 repository would
   require the caller to already know its format, which is exactly the misread this closes.
3. **Both, with the option overriding, and a contradiction refused** (design recommendation).

## Decision

**Option 3 — adopted as recommended (no user judgment).**

The Stage-2 read supplies the algorithm for discovered repositories; the explicit option supplies
it for the synchronous factories and for `init`. When both are present and **disagree**, the open
refuses rather than silently preferring one.

## Consequences

- The existing public `algorithm` option keeps working and stops corrupting data (ADR-681).
- Refusing the contradiction is what prevents a caller "successfully" opening a SHA-256
  repository as SHA-1 — the class of silent misread this whole change exists to remove.
- The refusal is a config/option conflict, not an acceptance-gate refusal, so it sits outside the
  ADR-682 tier.
