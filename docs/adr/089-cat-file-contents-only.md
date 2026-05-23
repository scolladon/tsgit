# ADR-089: Ship contents-only payload mode; defer `--batch-check` and raw

## Status

Accepted (at `cfacf2b`)

## Context

`git cat-file` has three batch payload modes:

- `--batch` — `<sha> <type> <size>\n<contents>\n` per entry.
- `--batch-check` — `<sha> <type> <size>\n` per entry (no contents).
- `--batch` with `%(rest)`-style format strings — fully customizable.

For a TypeScript library, each mode is a different return shape:

- **Contents** — the entry carries the parsed `GitObject` and a `size`
  metadata field. This is what `readObject` already produces; the
  primitive is a thin loop over it.
- **Info-only** — entry carries `{ id, type, size }`. The big win is
  skipping inflate + parse on the body. That requires a separate
  resolver path (or a `mode: 'info'` flag threaded through
  `readObject` / `resolveObject`). Not free.
- **Raw bytes** — entry carries the decompressed payload (no parse).
  Same "second path through resolver" issue, plus muddies the type
  on the caller's side (`Uint8Array` is not a discriminated `type`).

The backlog entry asks for "a high-throughput readers" primitive
without specifying the modes. The single proven need today is "give
me the parsed object for a sequence of ids, fast" — which contents
mode answers. Info-only and raw remain interesting but speculative.

## Decision

Ship one payload mode in v1 of 17.6: **contents**.

`CatFileBatchEntry` always carries `{ type, size, object }` on the
`ok: true` branch — no `mode` discriminator on the input. The type
is shaped so that adding `mode?: 'contents' | 'info'` later is a
non-breaking extension: a future `info` mode would return a narrower
union variant (`{ ok: true; id; type; size }`, no `object`).

Raw-bytes mode is deferred indefinitely: parsing cost has not been
demonstrated as a bottleneck, and adding it would create two resolver
paths (one parsing, one not) that we would have to keep in sync for
hash verification, lazy-fetch, and security caps.

## Consequences

### Positive

- One mode, one shape, one test surface — keeps 17.6 small and
  shippable.
- Implementation is a thin loop over `readObject`; no resolver fork.
- The union shape leaves room for a future `info` mode without a
  breaking change.

### Negative

- Indexers that need *only* type + size pay the parse cost. Real
  measurements (Phase 11 benchmarks) show parse is a small fraction
  of total per-id cost (inflate + delta application dominate), so the
  tax is bounded.
- We are not yet at full git-`cat-file` feature parity. Acceptable —
  the backlog entry asks for an equivalent "for high-throughput
  readers," not a CLI clone.

### Neutral

- An `info` mode can be added later by introducing a narrower
  resolver path that reads the header only. The current design
  doesn't preclude it.
