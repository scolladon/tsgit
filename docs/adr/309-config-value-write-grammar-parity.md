# ADR-309: Config value writer adopts git's `write_pair` grammar byte-for-byte (supersedes ADR-186's quoting rules)

## Status

Accepted (at `1c96a0c7`) — supersedes the quoting/escaping rules of [ADR-186](186-config-write-quote-on-write.md)

## Context

ADR-186 introduced quote-on-write with a grammar chosen for round-trip safety: quote when the value contains `#`, `;`, leading/trailing whitespace (space *or tab*), `"`, `\`, or LF; escape `\\`/`\"`/`\n` only inside quotes; reject CR and all other control characters (`CONFIG_VALUE_INVALID`). It also asserted the reader already understood the quoting grammar — it did not (backlog 24.9c).

Canonical git's `write_pair` (pinned empirically against git 2.54.0) differs on every axis:

- **Quote predicate**: leading space, trailing space, or the value contains `;`, `#`, or CR. Nothing else — `"`/`\`/LF/TAB never trigger quoting (they are escaped instead), and tab never does (it is escaped, so there is no trimming risk).
- **Escapes are unconditional** (quoted or not): `\` → `\\`, `"` → `\"`, LF → `\n`, TAB → `\t`.
- **Acceptance**: git accepts every value byte except NUL — CR, C0 controls, and DEL are written raw (CR inside quotes) and round-trip.

`.git/config` is on-disk state, so the prime directive (ADR-226) binds its bytes; tsgit-written and git-written files must be identical for the same logical operation. ADR-186's grammar parses identically but produces different bytes (e.g. tsgit `"a\\\\b"` vs git `a\\b`) and refuses values git accepts.

## Decision

Adopt `write_pair` exactly:

- `needsQuote(value)` ⇔ starts with space ∨ ends with space ∨ contains `;` ∨ contains `#` ∨ contains CR.
- `renderValue` escapes unconditionally (`\` first, then `"`, LF→`\n`, TAB→`\t`); CR and other control bytes pass through raw; quotes wrap iff `needsQuote`.
- Value-side rejection relaxes to **NUL only** (`rejectValueControlChars`, `assertValueSafe`). The C0/DEL/CR bans existed solely because the old writer could not represent those bytes; git accepts them, so refusing them was itself a refusal-condition divergence.

Write-parity is pinned by interop: identical config bytes from tsgit and git for a matrix of special values.

ADR-186's *direction* (accept-and-quote rather than reject, option B there) stands; only its concrete quoting/escaping/rejection rules are superseded.

## Consequences

### Positive

- Byte-identical `.git/config` output vs canonical git — write-surface parity restored for config.
- Values containing CR, C0 controls, or DEL are no longer artificially rejected.
- Round-trip `parse(render(v)) ≡ v` holds for every NUL-free string, property-tested.

### Negative

- Files written by the ADR-186 grammar contain differently-quoted (still correctly parsing) values; they are not rewritten retroactively.

### Neutral

- `CONFIG_VALUE_INVALID` remains for NUL (unrepresentable in git's grammar and in argv).
- Key/section/subsection validation is untouched — header grammar parity is a separate backlog concern.
