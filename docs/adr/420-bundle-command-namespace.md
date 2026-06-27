# 420 — bundle is one repo.bundle namespace (create / verify / listHeads)

- **Status:** accepted
- **Date:** 2026-06-27
- **Design:** docs/design/bundle.md · **Relates:** ADR-249 (structured output)
- **Decision class:** D-SURFACE adopted-as-recommended (no user judgment)

## Context

`git bundle` is a single command with three sub-operations (`create`, `verify`,
`list-heads`). The library surface can mirror that as one namespace, or flatten the
operations into independent Tier-1 commands. The facade already exposes grouped
sub-operations elsewhere (`branch`, `config`), and each top-level command name counts
toward the advertised Tier-1 total.

## Options considered

1. **One `repo.bundle` namespace** with `create` / `verify` / `listHeads` *(designer
   recommendation)* — pros: mirrors `git bundle <sub>`; matches the `branch`/`config`
   nested-facade precedent; one Tier-1 count; the three ops share a parser/serializer
   module cleanly; cons: a nested shape rather than a flat function.
2. **Three flat commands** `bundleCreate` / `bundleVerify` / `bundleListHeads` — pros:
   flat, discoverable; cons: triples the Tier-1 count for one git command; diverges from
   the grouped-facade precedent.
3. **Three `bundle-create` … kebab commands** — same cons as (2) plus an unusual name
   shape for the facade.

## Decision

**Option 1 — adopted as the design recommended.** A single Tier-1 `bundle` namespace
exposes `create`, `verify`, and `listHeads`. The facade binding, surface snapshot, and
doc-coverage page treat `bundle` as one command.

## Consequences

- One row in the Tier-1 count; one doc-coverage page; one browser-surface scenario
  exercising all three ops.
- The three operations live behind one application module and share the bundle
  header parser/serializer.
