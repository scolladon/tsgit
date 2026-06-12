# ADR-324: Section-op old names match raw header bytes, never a parsed form

## Status

Accepted (at `bb7b607e`)

## Context

Pinning git 2.54.0's `--rename-section` / `--remove-section` shows the old-name side is a **raw, byte-exact, case-sensitive lookup**: each header reduces to its dotted name (`[s]` → `s`, `[s "x"]` → `s.x`, `[s ""]` → `s.`, `[ ""]` → `.`, deprecated `[s.X]` → `s.X`) and is compared byte-for-byte with the input — even though reads are case-insensitive on the section part. This produces rows no parsed model reproduces: `[S]` is not found by `s`, and `a.b` removes both `[a.b]` and `[a "b"]`.

Alternatives: a parsed `{section, subsection}` match made case-sensitive (misses the ambiguity and deprecated-header rows; needs a divergence ADR), or the status-quo parsed case-insensitive match (diverges on five pinned rows).

## Decision

Implement raw-name matching: a `rawSectionName(header)` reduction compared byte-for-byte with the caller's old name. `parseSectionName`, the same-family rename guard, and the false "git cannot rename top-level sections" docstring are deleted. The new-name side keeps git's asymmetric model: validated first-dot parsing (`parseNewSectionName`).

## Consequences

### Positive

- One rule subsumes every pinned row — trailing-dot, plain names, empty-name family, case sensitivity, deprecated headers, ambiguity rows — with no special cases.
- Net code deletion (parser + guard removed).

### Negative

- The faithful ambiguity is surprising: `a.b` addresses both `[a.b]` and `[a "b"]` — documented on the primitives.
- Case-insensitive section-op callers (`Remote.origin`) now get `CONFIG_SECTION_NOT_FOUND`, converging with git.

### Neutral

- Entry writes keep their parsed, case-insensitive section comparison — pinned correct for that surface.
