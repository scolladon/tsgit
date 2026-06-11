# ADR-317: Rename/remove-section surgery stays line-based (span-unaware, like git)

## Status

Accepted (at `3d9c158c`)

## Context

While making entry surgery span-aware (ADR-316), the obvious question was whether `renameConfigSectionInText` / `removeConfigSectionInText` share the multi-line bug. Pinning git 2.54.0 showed git's own `--rename-section` / `--remove-section` machinery is line-based and span-unaware: a continuation tail whose text parses as a section heading is treated as one — rename rewrites it (changing the joined value), remove stops or starts a block at it (dropping lines the reader assigns to another section). tsgit's current output is byte-identical to git's on every pinned fixture, including the value-corrupting ones.

## Decision

Keep the physical-line machinery in rename-section / remove-section unchanged. Making them span-aware would corrupt *differently* from git — a faithfulness regression under ADR-226. The corruption fixtures are pinned as intended behaviour (unit + interop) so a future "fix" cannot land silently.

## Consequences

### Positive

- Byte-for-byte parity with git on section surgery, including its sharp edges.
- No code change; the split mirrors ADR-313's precedent (section ops are line-surgical, entry ops parse first).

### Negative

- tsgit knowingly reproduces git's value corruption when a continuation tail masquerades as a section header (rename/remove only).

### Neutral

- If upstream git ever makes these operations span-aware, the pinned fixtures will flag the divergence and this ADR gets superseded.
