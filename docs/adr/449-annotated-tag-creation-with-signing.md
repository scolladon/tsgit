# 449 — Annotated-tag creation is built together with tag signing

- **Status:** accepted
- **Date:** 2026-07-03
- **Design:** docs/design/gpg-signing.md · **Relates:** ADR-249 (structured data only), ADR-448 (tag body signature)
- **Decision class:** D-scope (adopted-as-recommended, no user judgment)

## Context

A signed tag is inherently an **annotated** tag object (tagger, message, and object write).
The current `tagCreate` command (`src/application/commands/tag.ts:63`) creates only
**lightweight** tags (a ref pointing at an object) — there is no annotated-tag creation path
at all. Signing cannot be added without first having the tagger/message/object-write
machinery.

## Options considered

1. **Build annotated creation + signing together** *(design recommendation)* — deliver the
   annotated-tag path (`tag -a`) and the signing path (`tag -s`) in the same item, signing
   composed on top of annotated creation.
2. **Carve annotated creation out first as a prerequisite** — land `tag -a` in a separate
   preceding item, then signing. Same code, finer delivery boundary.
3. **Sign only** — impossible; there is no annotated object to attach a signature to.

## Decision

**Option 1, adopted as recommended (no user judgment).** Annotated-tag creation is a hard
prerequisite for signing and is delivered in this item. The planner sequences annotated-tag
creation as its own TDD part(s) *before* the signing part, so the delivery boundary of
Option 2 is preserved at the commit granularity without splitting the backlog item. The tag
command exposes structured fields only (ADR-249) — no render options.

## Consequences

### Positive
- Signed tags become possible; annotated-tag creation (a standalone capability) also lands.

### Negative
- The item is larger than "signing" alone would suggest; the annotated-creation surface is
  new domain + command territory.

### Neutral
- The commit history still shows annotated-creation and signing as distinct atomic parts
  (planner ordering), so bisectability is retained.
