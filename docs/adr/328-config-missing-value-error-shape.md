# ADR-328: `CONFIG_MISSING_VALUE { key, source, line }` carries an absolute `source`

## Status

Accepted (at `f72d2177`)

## Context

git's lazy refusal for a valueless string-typed key is a two-line message: `error: missing value for '<key>'` then `fatal: bad config variable '<key>' in file '<F>' at line <N>` (exit 128). Per ADR-249 the library emits **no** rendered string — it refuses with a structured `TsgitError` whose data lets an interop test reconstruct both lines and diff against real git.

Two sub-questions: which error code, and what does `source` hold given tsgit resolves an **absolute** config path (`${commonGitDir}/config`) while git prints the path **relative to CWD** (`.git/config` in the pinned matrix, even from a subdir)?

The structured precedent is `CONFIG_PARSE_ERROR { code, line, source? }` (ADR-308) — a *parse-time* `bad config line N` malformation.

## Decision

A **new** `CommandError` variant `CONFIG_MISSING_VALUE { code, key, source, line }`, factory `configMissingValue(key, source, line)` in `domain/commands/error.ts`. `key` is the fully-qualified config key (`'user.name'`, `'remote.origin.url'`); `line` is 1-based; `source` is tsgit's **resolved absolute config path** — the same value `CONFIG_PARSE_ERROR` already carries, keeping the two config errors' `source` semantics identical.

The interop test **normalizes** the `file '<F>'` token (reconstructs the repo-relative form from the known tmpdir, or compares on suffix) before comparing; the `key` and `line` segments compare verbatim. The byte-exact repo-relative path token is a caller-side rendering concern (ADR-249), not part of the faithfulness contract.

A new code (not an extension of `CONFIG_PARSE_ERROR`) because a use-time typed-read failure and a parse-time line malformation are different causes with different git messages; conflating them loses discriminated-union clarity.

## Consequences

### Positive

- One refusal shape reused across every in-scope site (identity, remote-URL) and every deferred site (ADR-329); reconstruction of git's two lines is mechanical.
- Consistent `source` semantics with `CONFIG_PARSE_ERROR`; no second path-resolution rule, no dependence on caller CWD (which the library does not track).
- Respects ADR-249: the library owns the data (`key`/`source`/`line`), the caller owns rendering.

### Negative

- The interop test must normalize the path token rather than asserting byte-equality of `file '<F>'`; a documented, contained comparison subtlety.

### Neutral

- The int-typed valueless shape (`bad numeric config value '' … invalid unit` — single line, no `error:` prefix, no line N) is a **different** message with no `key`-at-`line` framing; if ever needed it gets its own code, not this variant (ADR-329 defers it — no int key is merged today).
