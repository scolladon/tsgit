# ADR-376: Plain `-C` copy sources = files modified in the diff only

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)
- **Refines:** [ADR-375](375-find-copies-harder-enum.md)

## Context

Under plain `-C` (`copies: 'on'`), the copy-source set must match git exactly. Pinned
against git 2.54.0: plain `-C` copies **only** from files that are themselves part of
the diff (git reuses the `rename_src` set — changed files), and does **NOT** scan
unchanged files as copy sources (matrix #C1b: a destination that is an 84% copy of an
**unchanged** file yields a plain `A`, no copy, under `-C`; the copy appears only under
`--find-copies-harder`).

## Options considered

1. **(chosen) Sources = files modified in the diff; unchanged excluded** — faithful to
   git's plain-`-C` `rename_src` reuse (pinned #C1b). Pros: byte-faithful; preserves the
   `-C` vs `--find-copies-harder` cost/semantics distinction. Cons: two code paths
   (`'on'` vs `'harder'`).
2. **Treat all preimage paths as sources for plain `-C` too** — one code path.
   Rejected: emits copies git never reports (a faithfulness regression) and erases the
   distinction ADR-369 requires pinning.

## Decision

`copies: 'on'` builds the copy-source set from the **preimage blobs of paths changed in
the diff** (modifies plus the deletes already in the rename source set). Unchanged paths
are copy sources **only** under `copies: 'harder'`. A copy source is scored against its
**preimage** content and is never consumed from the diff.

## Consequences

- Plain `-C` reproduces git's `A`-not-`C` outcome for an unchanged source (pinned #C1b).
- The two source-set builders (`'on'` vs `'harder'`) are distinct, gated by ADR-375's
  enum.
- The cost gap between `'on'` and `'harder'` (and its limit interaction, ADR-377) is
  preserved.
