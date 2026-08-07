# 576 — PackHeader.version stays number

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/design/pack-v3-read-compliance.md · **Supersedes/Refines:** none

## Context

`PackHeader` is a public export recorded in `reports/api.json`. Widening the accepted
version set to {2, 3} raises the question of whether the type should say so.

## Options considered

1. **Stays `number`** (designer's recommendation) — no public type change, no report churn.
2. **Narrows to `2 | 3`** — makes the read set visible in the type, but no consumer narrows
   on it, and it couples a public type to a git constant that would need a breaking change
   the day v4 is defined.
3. **Drop `version` from the shape** — outright breaking; destroys the caller's ability to
   observe what was read.

## Decision

Adopted as recommended: `version` stays `number` and is returned verbatim — a v3 pack
reports `version: 3`, never normalised to 2. "Treated identically" is the absence of any
downstream branch on the field, not a rewrite of it.

## Consequences

Zero public-surface delta; `reports/api.json` unchanged. The version constants
(`SUPPORTED_PACK_VERSIONS`, `GENERATED_PACK_VERSION`) are module exports of
`pack-entry.ts`, deliberately kept out of the storage barrel.
