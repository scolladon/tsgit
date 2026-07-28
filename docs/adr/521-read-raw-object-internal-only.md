# 521 — readRawObject is internal-only

- **Status:** accepted
- **Date:** 2026-07-28
- **Design:** docs/design/raw-tree-cursor-diff.md

## Context

The raw walk needs undecoded object bytes: `readRawObject(ctx, id): { type, content }` — `resolveObject`'s pre-parse product. A new public export triggers six surface gates (primitives barrel, facade binding, doc-coverage page, browser scenario, README count, `reports/api.json`), and users who need bytes already have `repo.primitives.catFileBatch` and `streamBlob`.

## Options considered

1. **Internal (recommended)** — exported from `read-object.ts` for in-tree consumers only; no public contract.
2. **Barrel-only** — semver surface with no consumer.
3. **Fully public** — six gates for an unrequested capability; YAGNI.

## Decision

**Ratified by user — Option 1.** `readRawObject` is exported from `src/application/primitives/read-object.ts` but not from the primitives barrel and not bound on `repo.primitives`.

## Consequences

No `api.json` regeneration or doc/browser/README gates for this change. Publication remains a one-ADR decision away if a consumer materialises.
