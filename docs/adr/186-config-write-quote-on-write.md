# ADR-186: `repo.config.set` quotes values containing `#`/`;`/leading-whitespace on write

## Status

Accepted (at `ab51e0a`)

## Context

The git config file grammar treats `#` and `;` as inline-comment delimiters: `key = value # comment`. Values that contain these characters round-trip incorrectly through the reader unless they are double-quoted on write (`key = "value with # in it"`). Leading and trailing whitespace is also trimmed by the reader unless the value is quoted.

The existing tsgit writer (`src/application/primitives/update-config.ts`) emits raw values without quoting; a value containing `#` or `;` is silently mangled on read-back. This is a latent bug, surfaced by the Phase 20.6 design audit.

The Phase 20.6 design surfaced two options for handling these characters:

- **A: reject at the porcelain layer** — `repo.config.set` calls `assertValueSafe(value)` and throws `CONFIG_VALUE_INVALID` for problematic values. Writer untouched. Conservative; defers the writer refactor.
- **B: accept and quote on write** — extend the writer to emit `"value"` when the value contains `#`, `;`, leading whitespace, or trailing whitespace. Closes the latent bug. Requires implementing the quoting grammar (including escape rules for `"`, `\`, `\n`).

## Decision

Adopt option B: extend the writer to quote values when necessary. The quoting rules in v1:

- A value is quoted iff it contains any of: `#`, `;`, leading whitespace (space, tab), trailing whitespace, embedded `"`, or embedded `\`.
- Quoted values are wrapped in `"..."`.
- Inside a quoted value, `"` is escaped as `\"` and `\` as `\\`.
- Embedded newlines (`\n`) are escaped as the two-character sequence `\n` (the writer never emits a raw newline inside a value).
- Control characters other than `\n` and `\t` are rejected at the porcelain layer (`CONFIG_VALUE_INVALID`); the writer never has to handle them.
- The reader (`parseIniSections`) already understands the quoting grammar — no reader change needed beyond a round-trip test pass.

Both `repo.config.set` (porcelain) and `setConfigEntry` (primitive) use the new writer. Existing call sites in `repo.remote` (Phase 20.5) inherit the quoting automatically.

## Consequences

### Positive

- **Latent writer bug closed.** Values containing `#` / `;` now round-trip cleanly.
- **No artificial restriction at the porcelain.** Users can store a value containing `#` (e.g. `pager.log = "less -R # paginate"`) without an error.
- **Centralised quoting.** All config writes go through `renderEntry` → consistent behaviour across primitives and porcelain.
- **`repo.remote` (Phase 20.5) inherits correctness** — refspec values containing `#` now round-trip (previously a latent corruption path).

### Negative

- **Writer refactor in 20.6 instead of a follow-up.** The implementation slice grows; quoting grammar tests + round-trip property tests are added.
- **Escape edge cases** — the writer must correctly handle `"value with \"quotes\" inside"` and `"value with backslash \\\\ inside"`. Property-based round-trip tests are mandated to cover the space.
- **Inconsistency window with prior data** — values written by older tsgit versions that contained `#` are already corrupted on disk. tsgit will not retroactively fix them; the design doc documents this.

### Neutral

- **Leading/trailing whitespace preservation** — values like `key =   value   ` are now exactly recoverable. Canonical git also quotes in this case; behaviour is now parity.
- **Comment preservation** — quoting on write does not affect the surrounding `#` and `;` comments in the file (those remain untouched per the parser's preserve-on-write contract).

## Alternatives considered

- **A (reject at porcelain)** — rejected. Leaves the latent writer bug; punishes users for git's grammar instead of handling it.
- **Reject only at porcelain, leave writer raw** — same as A; rejected for the same reason.
- **Quote everything always** — considered. Cosmetically noisy (every value becomes `"..."`); diverges from canonical git which only quotes when necessary. Rejected.

## References

- ADR-181 (nested-namespace porcelain) — the surface on which `set` lives.
- Existing writer: `src/application/primitives/update-config.ts` (will be refactored).
- Existing reader: `src/domain/config/parse-ini.ts` (already grammar-compliant).
