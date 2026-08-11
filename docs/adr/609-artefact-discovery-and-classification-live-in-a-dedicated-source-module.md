# 609 — Artefact discovery and fault classification live in a dedicated source module

- **Status:** accepted (adopted-as-recommended)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (DC-7, §D3) · **Refines:** ADR-577, ADR-598

## Context

Both artefacts are named entirely from data the registry already holds — a pack base name
the scan already vetted, or the midx's stored trailer rendered as hex — so **neither format
ever contributes a path component**. Presence is read off the single `readdir` the scan
already performs, at no extra syscall. What needed deciding is where the discovery, the
bounded read and the fault classification live, given that ADR-604 gives them a second
consumer beyond `fsck`.

## Options considered

1. **Everything inline in the `fsck` passes** — no new module / duplicates discovery and
   bounds into two passes, and has no home for the accelerator.
2. **Domain parser + a dedicated source module** (designer's recommendation) — one loader,
   one bound, one classifier shared by both consumers.
3. **New registry accessors, memoised per generation** — ADR-581's shape / adds public
   surface and a memo for what would be a single caller.

## Decision

Option 2. Domain holds the context-free parsers (bytes plus a `digestLength` in, structure
out, no I/O and no policy — ADR-577's rule). A dedicated application-layer source module
owns discovery, the bounded read, and fault classification, and is consumed by the `fsck`
passes **and** by `buildOffsetTable`.

Presence comes from the scan's `readdir` listing filtered on `entry.isFile`, which excludes
symlinks and directories exactly as the existing `.idx` filter does — a stronger posture
than open-by-path, at no cost, so a symlinked artefact pointing outside the repository is
never opened.

## Consequences

Option 3 becomes correct the moment a third consumer wants a *shared memoised verdict*;
this ADR does not foreclose that move, it declines to pre-pay for it. Per-pack artefact
loads under ADR-604 are single-flighted with the existing promise-memo pattern: a rejection
is never memoised, and `dispose()` stays terminal.
