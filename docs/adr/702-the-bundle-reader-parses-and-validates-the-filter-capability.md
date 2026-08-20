# 702 — The bundle reader parses and validates the `@filter` capability

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/sha256-object-format.md (candidate N2) · **Refines:** ADR-683

## Context

git 2.55.0's bundle format has exactly two capabilities: `@object-format` and `@filter`. `filter`
forces v3 **even on a SHA-1 repository**, and git validates it eagerly — `@filter=bogus` gives
`fatal: invalid filter-spec 'bogus'`, exit 128, the only fatal in the header-refusal table.

tsgit has a filter vocabulary already (`src/domain/protocol/object-filter.ts`) but no bundle
filter concept at all, so a filtered bundle is currently read as though unfiltered.

## Options considered

1. **Parse it, validate against the existing filter vocabulary, and expose it** — pros: matches
   git's eager validation, and surfaces a fact the caller needs (the bundle is partial).
2. **Parse and ignore** — cons: this is exactly the silent-acceptance shape the whole change
   exists to remove: a partial bundle read as complete, with no signal.
3. **Refuse any filtered bundle** — cons: over-refuses a bundle git reads fine, and tsgit already
   has promisor/partial-clone plumbing, so the capability is not foreign to it.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

The bundle header parser reads `@filter`, validates the spec against
`src/domain/protocol/object-filter.ts`'s vocabulary, refuses an invalid spec as git does, and
exposes the parsed filter on the bundle's structured read result.

## Consequences

- `@filter` is a **third v3 trigger** independent of the object format — see the ADR-683
  correction; it is why "v3 when SHA-256" was an incomplete rule.
- Reusing the existing filter vocabulary means one grammar with one set of tests, not a
  bundle-specific parallel parser.
- Exposing the filter is a structured-data addition (ADR-249): the library reports that the
  bundle is partial and how; deciding what to do about it is the caller's.
