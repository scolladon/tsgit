# ADR-322: Section ops address the empty subsection via git's trailing-dot name form

## Status

Accepted (at `bb7b607e`)

## Context

With exact subsection identity (`[s]` ≠ `[s ""]`), `configRenameSection` / `configRemoveSection` need a way to address the empty-subsection form. Entry reads/writes already have one — `parseConfigKey('s..k')` yields `subsection: ''` — but `parseSectionName` refuses every form that could name `[s ""]`. git addresses it with a trailing-dot section name: `--remove-section s.` removes only `[s ""]`, `s.""` means the literal two-quote-char subsection and misses ("no such section"), both pinned against git 2.54.0.

Alternatives considered: a structured `{section, subsection}` porcelain input (new surface for one form; ADR-249 binds outputs, not inputs, so faithfulness does not require it), or leaving the empty form non-addressable in section ops (the pinned rename/remove rows could then only be exercised at primitive level).

## Decision

Extend `parseSectionName` to git's name grammar: a trailing-dot input (`'s.'`) parses to `{section: 's', subsection: ''}` instead of refusing. No new porcelain surface; the form flows through the existing `oldName` / `sectionName` string inputs. `'s.""'` keeps its natural parse (subsection `'""'`), which matches nothing — mirroring git's refusal byte-for-byte via the existing `CONFIG_SECTION_NOT_FOUND` shape.

## Consequences

### Positive

- Byte-faithful to git's section-name grammar; the pinned rename/remove matrix is exercisable end-to-end at porcelain level.
- Two-line change; no new types, no API surface growth.

### Negative

- The dotted-name grammar gains a non-obvious case (`'s.'` ≠ `'s'`) that callers must learn — same asymmetry git has.

### Neutral

- `CONFIG_SECTION_NOT_FOUND` carries the dotted name (`'s.'`) unchanged.
