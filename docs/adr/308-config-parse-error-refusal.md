# ADR-308: Malformed config values throw `CONFIG_PARSE_ERROR` (git-faithful refusal)

## Status

Accepted (at `1c96a0c7`)

## Context

Canonical git refuses to run *any* command when a config file contains a malformed value — an unknown escape (`\x`), or a quote span left open at end of line — with `fatal: bad config line N in file F`. tsgit's shared INI tokenizer (`parseIniSections`, reused by `readConfig`, scoped config reads, `git config` porcelain, `.gitmodules`, and sequencer state) silently skips malformed lines instead.

With the quoted-value grammar now implemented in the reader (backlog 24.9c), the parser can *detect* these malformations for the first time, forcing the choice: refuse like git, or stay lenient. Refusal conditions are part of the prime directive's byte-for-byte observable behaviour (ADR-226).

Options considered:

- **A: throw, git-faithful** — `parseIniSections` throws a structured `CONFIG_PARSE_ERROR { line, source? }` (1-based physical line; optional file label supplied by the caller). Every reader inherits the refusal.
- **B: keep lenient skip** — diverges from git; would need its own divergence rationale.
- **C: throw only from `readConfig`** — inconsistent: `.gitmodules` and scoped reads would silently differ from git.

## Decision

Option A. Malformed *values* (unknown escape, unclosed quote) throw `CONFIG_PARSE_ERROR` with the failing physical line number and, when the caller provides one, the source label — the data from which a consumer reconstructs git's `fatal: bad config line N in file F` per ADR-249. The error is structured; tsgit emits no display string.

Scope is value-level malformations only — the reach of 24.9c. Non-value malformations (orphan keys, malformed section headers, valueless keys) keep today's lenient skip; widening refusal parity to the whole grammar is a separate backlog concern.

`readConfig`'s per-`Context` cache may cache the rejection; that is correct — git equally fails every command until the file is fixed, and any config write invalidates the cache.

## Consequences

### Positive

- Refusal parity with canonical git on bad config, pinned by interop (same failing line number).
- One behaviour across all five reader surfaces — no per-caller drift.
- Structured error carries exactly the data git's message needs (`line`, `source`).

### Negative

- A repo whose config was previously "readable" (malformed lines silently dropped) now refuses — strictly more faithful, but a behaviour change for out-of-grammar files.

### Neutral

- Lenient handling of non-value malformations is unchanged; the divergence surface shrinks but is not eliminated.
