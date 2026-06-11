# ADR-313: Per-operation write-path refusal shapes on malformed config files

## Status

Accepted (at `b59717f6`)

## Context

git's config *write* machinery splits in two, with different behaviour on a malformed existing file (all pinned against git 2.54):

- **`set`/`unset`** (`git_config_set_multivar_in_file_gently`) parse the file first. A malformed *header* refuses with `error: invalid section name '<partial>'` + `error: invalid config file <path>` (exit 3), where `<partial>` is the partially-accumulated section name at the failure point — section lowercased, subsection escapes decoded, accumulated up to where the grammar broke (`[s "a]` → `s.a]`, `[s "a" x]` → `s.a`, `[s"a"]` → `s`, `[s "ab\` at EOL → `s.ab`). A malformed *value* dies with the read-path shape: `fatal: bad config line N in file F` (exit 128).
- **`rename-section`/`remove-section`** (`git_config_copy_or_rename_section_in_file`) are line-based and lenient: they succeed on files with malformed headers *and* malformed values, and a malformed header simply never matches a rename/remove source (`fatal: no such section`).

tsgit today: `setConfigEntry` line-splices without parsing (writes can land on files git refuses to touch), while `unsetConfigEntry`/`renameConfigSection`/`removeConfigSection` parse first via `parseIniSections` — which, since ADR-308, makes rename/remove throw on bad values where git succeeds (a latent divergence this pinning surfaced).

Options considered:

- **A: one shape everywhere** — reuse `CONFIG_PARSE_ERROR` for all write-path refusals; simplest, but diverges from git's write-path observable (set on a bad-header file would report a line-shaped error instead of the section-name shape) and keeps rename/remove refusing where git doesn't.
- **B: mirror git's per-operation map** — set/unset parse first and throw a new structured `CONFIG_INVALID_FILE { sectionName, source }` for header malformations (consumer reconstructs git's two `error:` lines) while value malformations keep `CONFIG_PARSE_ERROR`; rename/remove drop the full parse and match line-surgically, becoming lenient like git.

## Decision

**B.** `parseIniSections` attaches the partially-accumulated header name to header-malformation `CONFIG_PARSE_ERROR`s; the set/unset write paths translate that case to `CONFIG_INVALID_FILE { sectionName, source }` before any byte is written. `renameConfigSection` / `removeConfigSection` stop full-parsing the file: source-section existence is checked with the line-based header matcher (malformed headers never match, mirroring git's `no such section`), which also repairs the ADR-308-era bad-value divergence in those two operations.

## Consequences

### Positive

- Every refusal *condition* and error *shape* on the write surface matches git per operation, pinned by interop.
- The rename/remove value-leniency divergence introduced invisibly by ADR-308 is repaired.

### Negative

- Two structured error codes for one underlying malformation, selected by path — the cost of mirroring git's internal split.

### Neutral

- The internal batch writers (`updateConfigEntries`, `updateConfigOperations`) adopt the set/unset parse-first behaviour wholesale; they only ever operate on tsgit-written files, so the distinction is unobservable there.
