---
subjects:
  - src/application/commands/archive.ts
---
# 765 — Archive refuses what git archive refuses

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (review round 1) · **Supersedes/Refines:** completes ADR-753's route enumeration

## Context

ADR-753 moved the name-shape refusal out of the object-parse layer and enumerated the
routes that already validate a path before materialising it. That enumeration covered the
index and working-tree sinks and was checked twice. It missed a sink that reaches neither:
`archive` walks a tree and writes entry names straight into tar and zip member paths.

Three of the four review dimensions found it independently. Measured on this branch, a
tree entry named `../../etc/evil` is emitted as an archive member of exactly that name.
Real git refuses: `git archive --format=tar` exits 128 with `error: invalid path
'../../etc/evil'` / `fatal: failed to unpack tree object`, while `git ls-tree` on the same
tree exits 0 — the refusal is at the archive boundary specifically, which is precisely the
layering this work established.

This sink is the serious one because the filesystem adapters' containment check cannot
help: `archive` produces bytes and never touches the filesystem, so the traversal lands on
whoever extracts the archive.

## Options considered

1. **Validate entry paths in the archive stream, matching git** — pros: closes the sink where git closes it; reuses the existing path validator / cons: none identified.
2. **Rely on the extractor to be safe** — cons: ships a serializer that produces a traversal payload and blames the consumer.
3. **Restore the parse-layer refusal for this case** — cons: re-introduces a refusal git does not have at parse, undoing a ratified decision to fix one surface.

## Decision

**Adopted as recommended (no user judgment) — this is ADR-753's own rule applied to a
route its enumeration missed.** The archive entry stream validates each entry path with
the same validator the index and working-tree sinks use, before yielding it. A refusal is
raised at the same point git raises it, and the archive is not produced.

## Consequences

### Positive

- The library stops being able to emit a traversal payload from a hostile tree.
- The route enumeration in ADR-753 is completed rather than left believed-complete.

### Negative

- `archive` gains a refusal it did not have. It is git's refusal, pinned against `git archive`'s exit status in the interop suite, so it is parity rather than policy.

### Neutral

- The enumeration being wrong twice on this branch is itself the lesson: a route list is evidence only for the routes it names, and sinks that bypass both the index and the filesystem are the ones it keeps missing.
