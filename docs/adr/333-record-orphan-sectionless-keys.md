# ADR-333: Record orphan (sectionless) keys under an empty section

## Status

Accepted (at `6811dfb9`)

## Context

A key before any `[section]` (`orphan = v`, `orphan`) is recorded by git and dumped on `--list`/`--get-regexp` as the **bare** key `orphan` (no dot), but is **unaddressable** by `--get`/`set` (`key does not contain a section`, exit 1/2). tsgit's `parseIniSections` drops entries when no section is open. The key grammar still applies (a malformed orphan line refuses the whole file).

## Options considered

1. **(recommended) Record orphans** — maintain an implicit empty-name `SectionBuilder` (`section: ''`, `subsection: undefined`) from file start; `qualifyKey` special-cases the orphan identity to render the bare key with no leading dot. No typed-consumer impact (`dispatchSection` never matches `''`). Pros: closes the bucket the brief groups; small. Cons: a new `qualifyKey` branch.
2. **Defer orphans to a separate backlog item** — cons: re-opens the same parser twice; leaves a grouped bucket open.

## Decision

`parseIniSections` opens an implicit orphan section (`('', undefined)`) into which pre-header key lines accumulate, reusing 24.9k's empty-section-name representation. `qualifyKey` renders `('', undefined)` as the bare `name` — **distinct** from `[ ""]`→`.name` and `[ "x"]`→`.x.name`. Orphan keys surface on `configList`/`configGetRegexp` and the token stream, and on **no** typed `ParsedConfig` field. They stay unaddressable by `configGet`/`setConfigEntry`: `parseConfigKey('orphan')` already throws `CONFIG_KEY_INVALID 'missing-name'` — the structured twin of git's `key does not contain a section`. The unified key grammar (ADR-332) applies to orphan lines.

## Consequences

### Positive

- Read parity for orphan dumps; the read/write asymmetry falls out of the existing key parser with no new code.

### Negative

- `qualifyKey` gains an orphan branch; one more identity to keep distinct from `[ ""]` (24.9k).

### Neutral

- Typed `ParsedConfig` consumers are unchanged; tsgit cannot write orphans (git's CLI cannot either).
