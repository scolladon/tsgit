# ADR-332: The unified key scanner preserves the mid-key comment refusal

## Status

Accepted (at `6811dfb9`)

## Context

24.9h gave the no-`=` path a key grammar (`VALUELESS_KEY_RE`); the `=` path took `line.slice(0, eqAt).trim()` with **no** validation. git uses one char-wise key scanner for both. Unifying them risks accidentally regressing today's refusal of a mid-key comment (`ab#cd = v`), which both tsgit and git currently refuse (`effectiveEqualsIndex` routes `ab#cd` to the valueless path, where `VALUELESS_KEY_RE` fails on the `#`).

## Options considered

1. **(recommended) The scanner refuses a `#`/`;` after a key prefix and before `=`** — "anything else" → `CONFIG_PARSE_ERROR`. Matches git and current tsgit. Leading-`#` whole-line comments (`stripInlineComment`) and value-side `#` (`parseConfigValue`) are unaffected.
2. **Treat any pre-`=` `#`/`;` as a comment** — regresses tsgit to lenient, diverges from git. Rejected.

## Decision

A single `scanKey` (replacing `VALUELESS_KEY_RE` + `effectiveEqualsIndex` + the unvalidated slice) reads `[a-zA-Z][a-zA-Z0-9-]*`, skips space/TAB only, then requires `=` (→ value via `parseConfigValue`) or EOL (→ valueless `null`); any other char — **including** a mid-key `#`/`;` — refuses with `CONFIG_PARSE_ERROR { line, source }`. The pinned acceptance/refusal set is preserved exactly: `ab#cd` / `ab;cd` / `ab # cd` / `key#=v` fatal; `#whole = line` whole-line comment; `k = v # trailing` value-comment.

## Consequences

### Positive

- One source of the key grammar; the `=`-path bad keys (`bad!key`, `9key`, `under_score`, `-key`, `key.dot`, `key@at`, `key x`) now refuse like git, closing the refusal gap.

### Negative

- Files with previously-accepted garbage `=`-keys now refuse on read — faithful (git refuses too), but a behaviour change for malformed inputs.

### Neutral

- Well-formed configs are unaffected; the scanner's accepted set equals today's for valid keys.
