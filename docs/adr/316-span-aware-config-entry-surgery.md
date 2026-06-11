# ADR-316: Span-aware config entry surgery with git's insertion point and empty-block pruning

## Status

Accepted (at `3d9c158c`)

## Context

The config writer's line surgery (`update-config.ts`) classifies each physical line independently. An entry whose value spans backslash continuations is one logical entry to the reader (`parseConfigValue` consumes the tail via `nextLineIdx`) but several unrelated lines to the writer: replace orphans the tail, unset leaves it behind, append inserts between head and tail, and a tail that looks like a `key =` line or a `[header]` is misclassified outright.

Pinning git 2.54.0 (scrubbed env) to fix this exposed two pre-existing **single-line** divergences in the same functions:

- git inserts a new key at the **end of the last matching section block**; tsgit inserts right after the header (tsgit-written remote sections carry `fetch` before `url`, inverted vs git).
- git **removes a block's header** when unset/unset-all leaves it with no entries and no comments (blank lines go too; comments — including a header-line inline comment — protect it); tsgit always leaves the header.

The span rewrite must choose an insertion line and a post-removal shape anyway, so each fix either lands here or is contradicted by new code.

## Decision

Rebuild the four span-aware write operations (replace, insert-new, append, remove) on a shared structural tokenizer (`tokenizeConfig` in `config-read.ts`, factored from `parseIniSections` so reader and writer share one grammar), and fold both pinned single-line fixes into the same rewrite:

1. Replace/remove operate on the entry's full physical span `[startLine, endLine)`.
2. New keys (set-absent and append/`--add` alike) land at the end of the **last** matching block; existing keys are replaced where they live (first match).
3. After removal, a block left with no entries and no comments is pruned entirely, blank lines included.

## Consequences

### Positive

- Every write operation produces the bytes canonical git would, on multi-line and single-line files alike (prime directive, ADR-226).
- tsgit-written `remote`/`branch` sections now match git's key order.
- One grammar for reader and writer — the writer can no longer disagree with `parseConfigValue` about what a line is.

### Negative

- Byte change vs previous tsgit output for existing-section inserts and emptied sections (previous output was the divergence).

### Neutral

- `tokenizeConfig` stays internal (not barrel-exported); the public surface is unchanged.
- `matchesSection` semantics (including the 24.9k `[s ""]`/`[s]` conflation) are preserved verbatim.
