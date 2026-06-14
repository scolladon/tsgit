# ADR-335: Chained section headers parse with content under the last header

## Status

Accepted (at `6811dfb9`)

## Context

The same-line tokenizer rework (ADR-330) handles a `[section]` header followed by an **entry** on one physical line. git's char-wise parser also allows a header to be followed by **another header** on the same line (`[a][b]`), opening a new section each time, with any following content landing under the **last** header. tsgit refused these — the same-line scanner ran `scanKey` on the `[` of the second span, which failed the first-char-alpha rule. Pinned against git 2.54: `[a][b]\nx=1` → `b.x=1` (`a` empty); `[a][b]k=1` → `b.k=1`; `[a][b][c] k=1` → `c.k=1`; subsection chains `[a "s"][b]`/`[a][b "s"]` → `b.k`/`b.s.k`; malformed chains (`[a][b`, `[a][]`, `[a][ b]`) → `fatal: bad config line 1`. The writer keys a line on its **first** header and copies the rest as a raw tail, so `rename a→c` on `[a][b]\nx=1` → `[c]\n\t[b]\nx=1`, `set b.x` works, `remove-section b` is a no-op — all already faithful once the reader accepts the construct. This was a faithfulness gap surfaced in review; the user directed it into this PR rather than a backlog follow-up.

## Options considered

1. **(recommended) Recognise chained headers** — `emitHeaderLine` loops over `[`-spans on a line, emitting one header token per span (same physical `line`); content keys to the last; the writer is unchanged. Faithful to the pinned matrix.
2. **Keep refusing chained headers** — a refusal git does not have (and tsgit already mis-recorded a garbage section on `main`). Rejected: prime-directive violation.

## Decision

`emitHeaderLine` recognises chained `[…][…]` spans, emitting a header token per span at the same physical line; following content (entry, comment, or EOL) keys to the **last** header. The chain is scanned **in place** via an offset into `line` (no per-iteration `slice`), so a K-header line is O(line length) — matching git's streaming parser. The writer is unchanged: it keys each line on its first header and copies the remainder as a raw tail, reproducing git's `rename`/`remove`/`set` bytes. Malformed second-or-later spans refuse with `CONFIG_PARSE_ERROR { line, source }` at git's 1-based line.

## Consequences

### Positive

- Faithful chained-header reads; the writer's first-header keying reproduces git's surgery bytes with no writer change.

### Negative

- The token model now allows multiple `header` tokens at one physical `line` index (a consumer iterating headers must not assume one per line).

### Neutral

- Real-world configs never use chained headers; this only affects hand-authored / adversarial input. Linear cost is preserved (an initial quadratic cut was caught in review and fixed).
