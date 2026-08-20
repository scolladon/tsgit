# 696 — Extension enum values reuse the config error family

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/sha256-object-format.md (candidate D6) · **Refines:** ADR-668

## Context

`extensions.objectFormat` and `extensions.refStorage` are **enums** (`sha1`/`sha256` and
`files`/`reftable`). Their measured refusals are config-value refusals, distinct from the
acceptance-gate refusals of ADR-668: git emits
`error: invalid value for 'extensions.objectFormat': '<v>'` followed by
`fatal: bad config line N in file <F>`, and a valueless entry produces
`error: missing value for '...'`.

## Options considered

1. **Reuse `CONFIG_MISSING_VALUE` for the valueless arm and add `CONFIG_INVALID_ENUM_VALUE`**
   (design recommendation) — pros: joins the existing config-error family, where these refusals
   actually belong; `refStorage` is the second caller, so the code is general from day one.
2. **One new `OBJECT_FORMAT_INVALID`** — cons: specific to one key, with `refStorage` needing its
   own twin immediately.
3. **Two new codes**, one per key — cons: two codes for one grammar.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

`CONFIG_INVALID_ENUM_VALUE` joins the config error family; the valueless arm reuses
`CONFIG_MISSING_VALUE`. Both `objectFormat` and `refStorage` raise them.

## Consequences

- These refusals are config-value refusals, not acceptance refusals: an extension git *knows* but
  whose *value* is malformed is a different condition from an extension tsgit cannot back
  (ADR-685) and from a version tsgit will not accept (ADR-668). Three tiers, three families.
- `CONFIG_INVALID_ENUM_VALUE` carries the key, source and offending value, matching the
  neighbouring config codes' payload convention.
- Any future enum-valued config key reuses it rather than adding a code.
