# ADR-336: Enforce git's unquoted section-name grammar

## Status

Accepted (at `6811dfb9`)

## Context

`scanPlainHeaderPrefix` accepted any non-empty **trimmed** inner as a plain (no-quote) section name, so `[a ]`/`[ a]`/`[a b]` were recorded as sections (`a`, `a`, `a b`) where git refuses. Worse, a lenient `trimmed.startsWith('[')` comment-skip in `tokenizeLine` silently swallowed every bracket-shaped non-header (`[foo` unclosed, `[]` empty, `[ core ]`) as a comment — so such a file produced phantom orphan entries instead of git's refusal. Pinned against git 2.54: a plain section name is `[A-Za-z0-9.-]+` — alnum + dot + dash, digit-first allowed (`[1a]` accepted, unlike keys), no underscore, NO interior/leading/trailing whitespace, immediately before `]`. Everything else (`[a ]`, `[ a]`, `[a b]`, `[]`, `[ core ]`, `[a_b]`, `[foo`) is `fatal: bad config line N`. The review flagged the `[a ]` case; the user directed the full grammar into this PR (not a backlog follow-up).

## Options considered

1. **(recommended) Enforce the grammar + drop the lenient skip** — validate the untrimmed inner; refuse non-matching bracket lines like git. Faithful to the pinned matrix.
2. **Keep the trim-accept + lenient skip** — accepts whitespace section names and silently drops malformed bracket lines, both divergent from git. Rejected: prime-directive violation.

## Decision

`scanPlainHeaderPrefix` matches the **untrimmed** inner against `^[A-Za-z0-9.-]+$`; on a non-match the line is not a plain header and falls to the key path, where `scanKey` refuses it with `CONFIG_PARSE_ERROR { line, source }` (git's `bad config line N`). The lenient `[`-prefix comment-skip is removed, so every bracket-shaped non-header refuses like git. The **quoted** branch (`[a "s"]`, ADR-312's whitespace-before-quote rule) is unchanged. The `[section.subsection]` legacy dotted-header (git lowercases the dotted subsection; tsgit parses the whole inner as one section) remains the sole unquoted out-of-scope item.

## Consequences

### Positive

- Faithful refusal of malformed unquoted headers; no more phantom orphans from bracket-shaped comment-lookalikes.

### Negative

- A wider blast radius than the flagged `[a ]`: seven existing tests that had enshrined the trim-accept / lenient-skip leniency were rewritten to assert git-faithful refusal (each re-pinned against real git). No coverage was dropped.

### Neutral

- Canonical configs (`[core]`, `[user]`, `[remote "x"]`, …) are unaffected — only whitespace / empty / invalid-char unquoted headers change from accept/skip to refuse.
