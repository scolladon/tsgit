# ADR-185: `repo.config.getRegexp` uses JavaScript regex semantics

## Status

Accepted (at `ab51e0a`)

## Context

Canonical `git config --get-regexp <pattern>` uses POSIX Extended Regular Expressions (POSIX-ERE) — character classes like `[:alnum:]`, no backreferences, no lookahead, anchors are line-anchored by default. The Phase 20.6 design surfaced three options for the tsgit equivalent:

- **A: native JavaScript `RegExp`** — divergence from canonical, but zero engine work.
- **B: write a POSIX-ERE → JS RegExp translator** — fidelity at the cost of multi-week side quest (POSIX-ERE has anchoring and character-class differences that don't round-trip cleanly).
- **C: reject regex, require a glob** — feature gap vs canonical, forces a glob layer (e.g. minimatch).

## Decision

`repo.config.getRegexp({ keyPattern, valuePattern?, scope? })` accepts native JavaScript `RegExp` instances. Both `keyPattern` and `valuePattern` are tested as `RegExp` predicates against the resolved entries.

Inputs are typed `RegExp` (not strings) so the caller's intent is unambiguous and TypeScript can flag string-vs-RegExp confusion at the call site.

The divergence from canonical git is:
- POSIX character classes (`[:alnum:]`, `[:alpha:]`, …) are not supported.
- POSIX BRE backslash-escaped grouping (`\(`, `\)`) is not supported.
- JS-only features (lookbehind, named capture groups, `\d` / `\w`) are available.
- Anchors: `^` and `$` follow JS semantics (string-anchored by default; `m` flag for line-anchored).

## Consequences

### Positive

- **Zero engine work** — uses the platform's built-in regex.
- **`RegExp` type at the API surface** — callers can construct, share, and test regexes with the standard tooling; no string-to-pattern parsing layer.
- **Most patterns work unchanged** — literal characters, `.*`, `[a-z]`, alternation, quantifiers behave identically across POSIX-ERE and JS RegExp at the surface.

### Negative

- **Divergence from canonical git documented as a known limitation.** A script that uses POSIX `[:alnum:]` has to be rewritten to `[A-Za-z0-9]` (or the equivalent).
- **No regex sanitization** — caller-supplied `RegExp` instances are trusted; a pathological pattern (catastrophic backtracking) is the caller's problem. tsgit does NOT wrap in a timeout or use a safe-regex library in v1.
  - Risk mitigation: documented in tsdoc; the `getRegexp` invocation is local-only (no remote-supplied patterns), so the threat model is the caller shooting themselves in the foot, not adversarial input.

### Neutral

- The `keyPattern` and `valuePattern` are independent predicates; a result is returned iff both match (or `valuePattern` is omitted). The two-predicate form mirrors canonical git's two-arg form.
- The `RegExp` flags (`i`, `m`, `g`, `u`) are honoured per JS semantics. Callers who want case-insensitive matching pass `i` explicitly; tsgit does NOT auto-apply `i` on section/name lookups (those use a normalized form internally per the parser rules).

## Alternatives considered

- **B (POSIX-ERE translator)** — rejected. Multi-week effort, partial fidelity at best, and the user-facing wins are minimal once `[:alnum:]` is documented as an unsupported edge case.
- **C (glob only)** — rejected. Strictly less expressive than the canonical `--get-regexp`; would force callers who need real regex to call `list` and filter client-side.
- **Accept strings, compile internally with `new RegExp(s)`** — rejected. Hides whether the string is meant as a regex or a literal; `RegExp` at the surface forces the caller's intent into the type.
