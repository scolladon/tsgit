# 687 — The ref backend reaches `Context` through a `RepositoryLayout` field

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DC-3) · **Refines:** ADR-678, ADR-680

## Context

`extensions.refStorage` is read by the Stage-2 open-time layout read. The selected backend must
reach `getRefStore(ctx)` without every call site re-reading config.

## Options considered

1. **A `RepositoryLayout` field** (design recommendation) — pros: follows the idiom ADR-678
   already established for layout-level verdicts a consumer acts on; resolved once at open, read
   synchronously thereafter / cons: widens a public type.
2. **An optional `Context` capability** — pros: keeps layout minimal / cons: a second place
   where open-time decisions live, and no consumer visibility.
3. **Re-read config at `getRefStore`** — pros: no type change / cons: a config read on a path
   ADR-679 requires to work on repositories whose config scope is deliberately empty.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

The resolved ref-storage backend is a `RepositoryLayout` field, set by the Stage-2 read alongside
`untrusted` and `implicitBare`.

## Consequences

- Option 3 is not merely inferior but incorrect under ADR-679: an untrusted repository has no
  readable config scope, so a config-reading backend selector would fail exactly where the gate
  must still resolve a layout.
- `repo.layout` exposes the backend, so a consumer can tell which storage a repository uses —
  additive, and `reports/api.json` is regenerated.
- The field is resolved before any ref access, which is what lets `getRefStore` stay synchronous
  in shape.
