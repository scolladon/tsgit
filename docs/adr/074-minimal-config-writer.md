# ADR-074: `.git/config` writes use targeted `[core]` line surgery, not a full INI writer

## Status

Accepted (at `c85927a`)

## Context

Sparse checkout must persist `core.sparseCheckout` and
`core.sparseCheckoutCone` to `.git/config`. tsgit has **no config writer**
today — `bootstrap` renders the whole file once at `init` (`renderConfig`),
and nothing ever modifies it afterwards. `config-read.ts` only *reads*.

So 17.3 must introduce config-write capability. Two shapes:

1. **A full INI writer** — parse `.git/config` to an AST, mutate, re-render.
   Faithful round-tripping of comments, blank lines, key casing and section
   order is hard; a naive re-render reformats or drops them.
2. **Targeted line surgery** — locate the `[core]` section in the raw text,
   replace an existing key's value or insert the key after the header, append
   a `[core]` section if none exists. Everything else in the file is copied
   through untouched.

## Decision

Implement **targeted `[core]` line surgery** — option 2 — as a pure function
`setCoreConfigEntry(text, key, value)`, wrapped by an `updateCoreConfig`
primitive that reads `.git/config`, folds the entries through, writes the
result, and invalidates the per-`Context` `readConfig` cache.

A general INI writer is **explicitly not built** in 17.3. The only keys 17.3
writes live in `[core]`; a focused, well-tested line-surgery function covers
that need without the round-tripping hazards of a full re-render.

## Consequences

### Positive

- Comments, blank lines, key order and unrelated sections in `.git/config`
  survive a write byte-for-byte — only the targeted `[core]` key changes.
- Small, pure, exhaustively unit-testable surface
  (`setCoreConfigEntry` arms: replace / insert-under-existing-`[core]` /
  create-`[core]` / case-insensitive key match).
- No premature general-purpose abstraction.

### Negative

- Not a reusable general config writer — a future feature that must write a
  non-`core` section will extend or generalise this.
- `updateCoreConfig` is a read-modify-write with no `config.lock` (tsgit has
  none; `bootstrap` writes config unlocked too). Concurrent writers race
  last-writer-wins — a documented edge.

### Neutral

- `updateCoreConfig` invalidates the `readConfig` `WeakMap` cache for the
  context, so a write followed by a read in the same process sees the new
  value. The existing test-only `__resetConfigCacheForTests` is generalised
  to a public `invalidateConfigCache(ctx)`.
- Booleans are written as the literal strings `true` / `false`.
