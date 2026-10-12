---
subjects:
  - src/domain/eol
  - src/application/primitives/resolve-conversion.ts
  - src/application/primitives/internal/convert-blob.ts
  - src/application/primitives/internal/apply-clean-filter.ts
  - src/application/primitives/internal/apply-smudge-filter.ts
  - src/application/primitives/resolve-filter-driver.ts
---
# 950 — Conversion extends the clean/smudge pipeline into one composed primitive

- **Status:** accepted
- **Date:** 2026-10-12
- **Design:** docs/design/eol-conversion.md · **Supersedes/Refines:** refines ADR-406, ADR-407, ADR-408

## Context

git's `convert.c` runs every text conversion as one ordered pipeline: on the way into the
repository, filter clean → CRLF → ident; on the way out, ident → CRLF → filter smudge (pinned
§D1.10 of the design). Whether a checkout streams or converts in core depends on all three steps
together (§D1.11): a driver naming a command or an `auto` / `auto-crlf` CRLF action is in core,
everything else streams. tsgit implements only the filter step today, and composes it at a dozen
call sites (`add`, worktree comparison, checkout writes, archive, merge-family writes). EOL and
`ident` conversion must land in the same order at every one of those sites, and the merge-family
writes run neither step yet.

## Options considered

1. **Generalise the existing pipeline** — `convertToGit` / `convertToWorkingTree` primitives over
   pure `src/domain/eol` steps, resolved once per path by `resolveConversion` from a single
   attribute lookup; every site calls these instead of the filter helpers (recommended). Pros: one
   place holds git's order and the stream-vs-in-core class. Cons: every filter call site migrates.
2. **A separate EOL primitive beside the filter step at each site** — pros: smaller diff per site;
   cons: the ordering and the class decision are duplicated at ~12 sites and drift independently.
3. **A `FileSystem` port decorator converting on read and write** — pros: zero call-site changes;
   cons: a port cannot see attributes, the index blob (the index-CRLF rule) or the blob id
   (`ident`), and it would convert `.git/` reads.

## Decision

**User-ratified — option 1.** Every conversion between worktree bytes and blob bytes goes through
`convertToGit` / `convertToWorkingTree` (`src/application/primitives/internal/convert-blob.ts`)
over a `Conversion` resolved once per path by `resolveConversion`
(`src/application/primitives/resolve-conversion.ts`) from one `sourcesForPath` lookup covering
`filter`, `text`, `crlf`, `eol` and `ident`. The byte-level steps — statistics, binary classifier,
CRLF action, the two CRLF converters, the safecrlf simulation, the `ident` scanners and the
LF→CRLF stream transform — are pure functions in `src/domain/eol`, over `Uint8Array` only. No call
site composes steps itself; the streamed checkout takes its `ChunkTransform` from the same
resolver. The filter step keeps its runner and inert-fallback semantics unchanged.

## Consequences

- git's order and the stream-vs-in-core class live in one module each; a future
  `working-tree-encoding` step slots into the composed order without touching call sites.
- The existing `resolveFilterDriver` + `applyCleanFilter` / `applySmudgeFilter` callers migrate to
  the new primitives; the eager `[filter "<d>"].required` validation moves with the filter part.
- An identity conversion returns its input by reference, so unconverted repositories keep the
  zero-copy add and streamed-checkout paths; the one added cost is a lazily built attribute
  provider per converting command, measured by `bench:ab` in implementation.
