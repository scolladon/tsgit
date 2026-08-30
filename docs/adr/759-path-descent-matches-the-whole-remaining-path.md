---
subjects:
  - src/application/primitives/internal/resolve-tree-path.ts
---
# 759 — Path descent matches the whole remaining path

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (DC-E) · **Supersedes/Refines:** refines ADR-753

## Context

ADR-753 stops the object-parse layer refusing an entry name that contains a separator.
That makes a question reachable that the refusal used to hide: how is such an entry
addressed? Measured, git 2.55.0, over a tree holding one entry literally named `a/b`:

```
git rev-parse <tree>:a/b   →  c1b0730e…   (resolves the literal entry)
git rev-parse <tree>:a     →  fatal: path 'a' does not exist in '<tree>'
```

git's tree walk compares the whole remaining path against entry names, so a
separator-bearing name is addressable by its full text. tsgit's descent splits the path
on separators and looks for a subtree, so it reports the object as not found. Before
ADR-753 the same input threw an invalid-name error; after it, the descent would report
not-found. Both disagree with git.

## Options considered

1. **Match git — on a descent miss, also compare the whole remaining path against entry names** — pros: closes the divergence rather than exchanging it for a quieter one / cons: an extra comparison on the miss path of a measured hot descent, and it grows this work into path-addressing semantics.
2. **Record the divergence and leave the descent segment-only** — pros: cheap and bounded; no well-formed repository has such an entry, since git's own fsck refuses it / cons: a pinned gap on a published surface.
3. **Reverse the separator half of ADR-753 and keep refusing at parse** — cons: re-introduces a refusal git does not have, which is what ADR-753 exists to remove.

## Decision

**Ratified by the user: option 1.** When descending a path fails to match a segment, the
descent also tries the whole remaining path as a literal entry name, as git does. A
separator-bearing entry name is addressable by its full text on every surface built on
the descent.

## Consequences

### Positive

- `rev-parse <tree>:<path>`, `read-file-at` and `blame` agree with git for these trees instead of exchanging one divergence for another.

### Negative

- The descent's miss path does one more byte comparison per level. It is on a measured hot path, so the change is written to leave the hit path untouched and is covered by the existing descent benchmarks.

### Neutral

- Such trees remain fsck-refused by git and by tsgit, so this affects deliberately hand-built objects, not repositories in normal use.
