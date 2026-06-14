# ADR-330: A same-line entry token carries a `sharesHeaderLine` marker

## Status

Accepted (at `6811dfb9`)

## Context

git's char-wise config parser lets a `[section]` header and an entry share one physical line (`[a] key = v`, `[a] key`). tsgit's `ConfigToken` model holds the invariant "one physical line → one token", and that token is the writer's surgery unit (the token-stream writer of 24.9i). A same-line entry breaks the invariant: its `startLine` is the header's line, yet the header occupies that line's leading bytes. The pinned git matrix requires the writer to **split** that line on replace (`[a] key = v` + `set a.key x2` → `[a]⏎⇥key = x2`) and to prune-or-keep it correctly on unset.

## Options considered

1. **(recommended) Add a shares-header-line marker (+ start column) to the `entry` token** — the entry keeps physical-line `startLine`/`endLine`; the writer's existing span splice gains one branch that re-emits the header before the rendered entry. Pros: smallest delta to the 24.9i token/span model; preserves raw-tail byte fidelity for the verbatim-copy section ops. Cons: the writer learns one shared-line branch.
2. **Normalise on tokenize** (synthetic sub-line entry + a parallel header-endOffset map) — pros: entry tokens look whole-line; cons: leaks offset state outside the token stream.
3. **Pre-split the input text** so every entry owns a whole line — pros: uniform tokens; cons: corrupts byte-offset fidelity for the verbatim raw-tail copy (rename C1), breaking byte parity.

## Decision

A same-line `entry` token carries `startLine === header.line` plus a marker that it shares the header's physical line (and the column where its content begins). Span semantics are unchanged for whole-line entries. On **replace** of a shared-line entry, the writer rewrites that physical line as `renderSectionHeader(...) + '\n' + renderEntry(...)` — the split git performs. On **unset**, the empty-block rule (24.9i) decides prune-vs-keep; when the block survives, the writer re-emits the header alone then the surviving body verbatim. **New** keys and **non-matching** keys leave the shared header line verbatim.

## Consequences

### Positive

- Reuses the 24.9i span model; one localized writer branch.
- Preserves raw-tail byte fidelity for the verbatim-copy section ops (ADR-331).

### Negative

- The `entry` arm of the exported `ConfigToken` widens — `reports/api.json` regenerates.

### Neutral

- The writer never emits same-line entries itself; the marker exists only to surgery hand-authored ones faithfully.
