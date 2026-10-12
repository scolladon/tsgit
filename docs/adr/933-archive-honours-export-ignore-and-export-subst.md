---
subjects:
  - src/application/commands/archive.ts
---
# 933 — `archive` honours `export-ignore` and `export-subst`

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-249, ADR-415, ADR-416, ADR-930

## Context

git's `archive` omits paths carrying `export-ignore` and, for files carrying `export-subst`,
expands `$Format:…$` placeholders against the archived commit (`archive.c`,
`convert_to_archive` → `format_subst` → `pretty.c:repo_format_commit_message`); the
`!export-subst` conjunct is part of git's streaming condition (ADR-930). tsgit's `archive`
models neither. ADR-249 forbids rendering options on the command surface.

## Options considered

1. **Backlog item** — cons: `archive` output differs from git's for any repository using either attribute.
2. **`export-ignore` now, `export-subst` later**.
3. **Both now** — pros: archive content matches git's.

## Decision

**User-ratified — option 3.** Both attributes are honoured as git does, resolved through the
existing `.gitattributes` resolution. `export-subst` expansion is **archive content**, not
display: the expanded bytes are what git writes into the archive, so producing them is
faithfulness to output data (ADR-226), not a rendering option — ADR-249 is not engaged, and the
command gains no format option. The expander implements the placeholder set git's
`format_subst` accepts, with git's limits (e.g. the `%(describe)` cap per archive).

## Consequences

- A commit-message placeholder expander lives in the domain as a pure function, with a property-test sibling.
- Interop pins compare archive entry lists and expanded file bytes with git's.
