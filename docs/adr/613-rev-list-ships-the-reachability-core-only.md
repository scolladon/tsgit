# 613 — `rev-list` ships the reachability core only

- **Status:** accepted (ratified — new scope, no design recommendation existed)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (revision) · **Refines:** ADR-249, ADR-603

## Context

ADR-603 ships an EWAH parser, which needs a consumer. `git rev-list` is the canonical
reachability surface and the one git itself accelerates with bitmaps. git's own `rev-list`
carries roughly a hundred options; most are history filters or ordering controls, and for
most of them git **abandons** the bitmap and falls back to a walk — so they would add
surface without exercising the new path. ADR-249 independently bars every rendering-shaped
option.

## Options considered

1. **Reachability core** — `wants`, `not`/`haves`, `--objects`, `--count`, `--max-count`,
   `--first-parent`, `--all`, `--no-walk` / smallest surface that is genuinely useful.
2. **Core plus history filters** — date/author/grep/merge filters, `--boundary` / broader
   parity, but the filters defeat bitmap acceleration.
3. **Broad git parity** — ordering, `--reverse`, simplification, path limiting / needs
   machinery tsgit does not have.

## Decision

Option 1. `rev-list` ships the reachability core: the object set or count reachable from
`wants` excluding everything reachable from `not`, with `--objects` yielding trees and
blobs alongside commits.

Per ADR-249 the command returns **structured data** — object ids with type and, for
`--objects`, path — never a rendered line, and carries no `--pretty`, `--format`,
`--date`, `--abbrev` or other presentation option. Callers format.

Excluded options are excluded **permanently, with the reason recorded here** (they defeat
bitmap acceleration, or they need absent machinery), not deferred to a follow-up.

## Consequences

Pays the Tier-1 surface tax: barrel export, repository facade, facade test, documentation
page, browser parity scenario, README and a regenerated `reports/api.json`. Shares its
closure engine with ADR-614 rather than duplicating it, and is the surface whose
bitmap/walk equivalence the interop suite pins.
