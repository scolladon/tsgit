# ADR-326: Re-shape the exported section-op InText primitives to raw-name form

## Status

Accepted (at `bb7b607e`)

## Context

`removeConfigSectionInText(text, section, subsection)` and `renameConfigSectionInText(text, section, fromSub, toSub)` assume one section family per call. Cross-family renames (`s → t.y`, `s.x → t`, pinned in the design matrix) and raw old-name matching (ADR-324) do not fit that shape.

Alternatives: additive new primitives keeping the old ones alive (two surfaces forever expressing one rule), or keeping the old signatures as thin deprecated wrappers (dead weight with no in-tree callers).

## Decision

Breaking re-shape of both exported primitives: `removeConfigSectionInText(text, oldName)` and `renameConfigSectionInText(text, oldName, to)` where `oldName` is the raw dotted name (ADR-324) and `to` is the parsed `{section, subsection?}` new-name form. The library is pre-1.0; all in-tree callers update in the same change and `reports/api.json` regenerates.

## Consequences

### Positive

- One surface, one rule; the primitive signatures mirror git's own asymmetry (raw old side, parsed new side).

### Negative

- Breaking change for external callers of the two primitives (accepted pre-1.0).

### Neutral

- The porcelain (`configRenameSection` / `configRemoveSection`) keeps its string-name inputs; only the InText primitive shapes change.
