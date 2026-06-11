# ADR-312: Malformed quoted-subsection headers refuse, git-faithfully (scoped strict grammar)

## Status

Accepted (at `b59717f6`)

## Context

Canonical git's section-header grammar (`get_extended_base_var`) is strict once a `"` appears: the quote must be preceded by whitespace, `\` escapes any single char (decoded verbatim — no named escapes), the span must close before end-of-line, and the closing quote must be followed *immediately* by `]`. Any violation — `[s "a" x]`, `[s "a" ]`, `[s"a"]`, an unclosed quote, `\` at end-of-line — makes git refuse the whole file on read: `fatal: bad config line N in file F` (pinned against git 2.54).

tsgit's `parseSectionHeader` slices between the first and last `"` verbatim: escapes are not decoded (`[s "a\"b"]` reads as `a\"b` instead of `a"b`), and the malformed forms are either mis-parsed (`[s "a" x]` → subsection `a" x`) or silently skipped where git refuses. ADR-308 settled refusal for malformed *values*; headers were explicitly deferred.

Options considered:

- **A: throw, git-faithful, scoped to quoted headers** — the strict grammar applies exactly to headers containing a `"`; violations throw the structured `CONFIG_PARSE_ERROR { line, source }` at git's die-points. Unquoted-header malformations (`[foo` without `]`, `[s ]`, non-alphanumeric section names) keep today's lenient skip as the separately-tracked whole-grammar follow-up.
- **B: decode escapes only, stay lenient** — reads diverge on broken files (tsgit proceeds confidently where git refuses every command).
- **C: full header refusal parity** — also refuse unquoted-header malformations; widens this item into the whole-grammar follow-up.

## Decision

**A.** The reader decodes `\c` → `c` inside quoted subsection names and refuses malformed quoted-subsection headers with `CONFIG_PARSE_ERROR { line, source }` — the same structured refusal ADR-308 established for values, reconstructable to git's `bad config line N in file F` per ADR-249. Every `parseIniSections` consumer (config reads, scoped reads, porcelain, `.gitmodules`, sequencer state) inherits the refusal. The writer escapes `"`/`\` (only) on render and relaxes subsection acceptance to git's (reject LF and NUL; `"`, `\`, `]`, CR become representable), restoring `parse(render(s)) ≡ s`.

## Consequences

### Positive

- Subsection names round-trip byte-for-byte with git, including in `.gitmodules` submodule names.
- Broken config files refuse identically to git instead of yielding confident wrong reads.
- Header forgery through subsection injection stays impossible (LF still rejected; quotes escaped).

### Negative

- Files accepted by tsgit yesterday (e.g. `[s "a" ]`) now throw; that is the point, but it is a behaviour break for consumers relying on the old leniency.

### Neutral

- Unquoted-header malformations stay lenient; whole-grammar refusal parity remains a tracked follow-up.
- `[s ""]` vs `[s]` matching conflation is surfaced as its own backlog entry, not fixed here.
