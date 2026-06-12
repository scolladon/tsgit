# ADR-323: Fold the adjacent section-addressing gaps into the empty-subsection fix

## Status

Accepted (at `bb7b607e`)

## Context

Pinning the empty-subsection identity surfaced two adjacent gaps that the original design scoped out as backlog follow-ups:

1. **Plain-name and cross-family section ops** — git's `--rename-section` / `--remove-section` accept subsectionless names (`s`) and rename freely across section families (`s → t`, `s. → t`, `s → s.`, pinned against git 2.54.0); tsgit's `parseSectionName` requires the dotted form and a same-family guard refuses cross-family renames. (Overlaps backlog 24.9n.)
2. **Empty-section-name axis** — git represents an empty section name with an empty subsection (`..k` writes `[ ""]`, `--list` prints `..k=x`); tsgit's `parseConfigKey` refuses the empty section outright.

The design recommended deferring both to keep 24.9k a two-line matcher fix; folding them in widens it into an addressing-grammar rework across `parseSectionName`, the family guard, and `parseConfigKey`.

## Decision

Fold both gaps into this change. One PR delivers the complete section-identity and section-addressing grammar: exact `[s]` ≠ `[s ""]` identity in both write matchers, trailing-dot addressing (ADR-322), plain-name section ops, cross-family renames, and the empty-section-name key shape — each pinned against git 2.54.0 with interop twins.

## Consequences

### Positive

- The whole addressing grammar lands coherently in one review pass instead of three partial states shipping months apart.
- Backlog 24.9n (flat-section rename/remove) is absorbed and closed by the same PR.
- The pinned matrices for all three axes are produced by one session against one git version.

### Negative

- The PR grows from a two-line matcher fix to a grammar rework across key/name parsing, matchers, and the family guard — more review surface and more interop rows in one change.

### Neutral

- The empty-*value* and refusal-shape axes (24.9l, 24.9m) remain separate backlog items; this fold stops at addressing/identity.
