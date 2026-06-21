# ADR-397: gitGrep byte-offset bridge via latin1, with u-flag refusal

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/gitgrep-pattern-grammar.md](../design/gitgrep-pattern-grammar.md)
- **Relates to:** [ADR-395](395-gitgrep-grammar-diverges-to-js-regexp.md) (JS `RegExp` grammar)

## Context

`grep` matches a JavaScript `RegExp` ([ADR-395](395-gitgrep-grammar-diverges-to-js-regexp.md))
against blob/working-tree lines that are raw `Uint8Array` bytes. `MatchSpan` must
report **byte offsets** into the raw line, so that `line.slice(start, end)` is exactly
the matched bytes. But a JS `RegExp` runs over a **UTF-16 string** and reports indices
in **code units**. For arbitrary UTF-8 content the two index spaces differ (a 2–4-byte
code point is 1–2 code units), so `regexp.exec(new TextDecoder().decode(line)).index`
is *not* a byte offset. The bridge between the byte line and the UTF-16 engine must be
chosen and pinned.

## Options considered

1. **(chosen) latin1-decode the line.** Decode each line ISO-8859-1
   (`String.fromCharCode` per byte): every byte 0x00–0xFF maps to exactly one UTF-16
   code unit, so the decoded string has one code unit per input byte and `RegExp`
   indices **are** byte offsets by construction — no remap table. Matching is
   byte-oriented (`.` matches one byte, `\w`/`\b` see raw bytes), the same model glibc
   `regexec` uses over bytes in a non-UTF-8 locale (which is how `git grep` itself
   behaves). Pros: zero remapping, fastest, byte-faithful, simplest / cons: a
   `u`-flagged `RegExp` (code-point semantics) cannot be honoured over a byte view and
   must be refused.
2. **UTF-8-decode + per-line offset map.** Decode UTF-8, keep a code-unit→byte offset
   table per line, remap every match index back to bytes. Pros: allows code-point `.`
   semantics / cons: a table + remap cost per line for no faithfulness gain (git
   doesn't do code-point `.` over bytes either); strictly more code and slower.
3. **Report code-unit offsets.** Decode UTF-8, report the `RegExp`'s native code-unit
   indices. Rejected: violates the requirement that spans are byte offsets —
   `line.slice(start, end)` would be wrong on any multi-byte line.

## Decision

The matcher **decodes each line latin1** before running the caller's `RegExp`; the
`.index` / `.index + match[0].length` it returns are used directly as byte
`start` / `end`. The `line` bytes carried in the result stay **raw** — only the
matcher's internal view is latin1; the caller decodes result bytes with whatever
encoding it wants.

Consequences that must be guarded/documented:

- **Byte-oriented matching.** `.`, `\w`, `\s`, `\b` operate over bytes, so `.` matches
  one byte of a multi-byte UTF-8 sequence, not one code point. This is the byte-faithful
  model (matches `git grep`); callers wanting code-point semantics own that translation
  ([ADR-395](395-gitgrep-grammar-diverges-to-js-regexp.md) puts grammar in the caller's
  hands). Documented, not papered over.
- **The `u` (unicode) flag is refused.** A `u`-flagged `RegExp` asserts code-point
  semantics the byte view cannot honour; `grep` rejects it with a structured
  `INVALID_OPTION`-class error ("unicode flag unsupported over byte content") — a
  guarded, pinned refusal, never a silent mismatch. `i`, `m`, `s` ride through unchanged.
- **The caller's `RegExp` is never mutated.** The matcher forces the global flag on an
  internal **clone** (stripping sticky `y`, which would drop non-leftmost spans) to
  collect all spans on a line via `matchAll`/repeated `exec`; the caller's object and
  its `lastIndex` are never read or written.

## Consequences

### Positive

- Byte offsets are correct by construction with no remap table — simplest and fastest.
- Byte-oriented matching aligns with `git grep`'s own byte behaviour.
- The result `line` stays raw bytes; encoding is the caller's choice.

### Negative

- A `u`-flagged `RegExp` is not usable; callers needing Unicode-aware matching over
  UTF-8 must pre-decode and search themselves. This is a narrow, documented refusal.

### Neutral

- Matching is byte-level; `.` spans a byte, not a code point. Intentional and faithful
  to git; surfaced in the docs and the `u`-flag guard.
