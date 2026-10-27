---
subjects:
  - src/application/commands/stash.ts
---
# 1099 — `stash push --include-untracked` writes git's empty-tree untracked commit

- **Status:** accepted
- **Date:** 2026-10-27
- **Design:** docs/design/stash-apply-dir-file-replacement.md (DC4, F10) · **Supersedes/Refines:** refines ADR-226, ADR-211

## Context

`git stash push -u` with tracked changes but no untracked file still writes the untracked commit U: the empty tree
`4b825dc642cb6eb9a060e54bf8d69288fbee4904`, no parent, subject `untracked files on <branch>: <short> <subject>`;
the stash commit W then has three parents (A.4 E1, E2). tsgit writes U only when an untracked path was found, so W
has two parents and the stash's U tree differs from git's. The gap was proven by this run's probes on the function
the run already edits (`createStashCommits`), which is the standing fold rule's case. A clean tree with `-u` still
saves nothing in both tools (A.4 E0).

## Options considered

1. **Fold: write U whenever `includeUntracked` is set** (designer's recommendation) — pros: byte-faithful stash
   commits (ADR-226); one condition changes / cons: a push behaviour inside an apply fix; W gains a third parent for
   `-u` users, visible to a consumer reading parents.
2. **Keep out, report an impact** — pros: the change stays apply-only / cons: a proven, one-line gap on the same
   function deferred against the fold rule; the apply interop rows cannot assert equal W/I/U trees.

## Decision

**Adopted as recommended (no user judgment): option 1.** It follows ADR-226 and the standing rule to fold a
proven gap in the same function (the rule ADR-1095 applied to the push twin). `createStashCommits` writes U with the
empty tree when `includeUntracked` is set and no untracked path was found; `hasLocalChanges` is unchanged, so
nothing to stash still saves nothing.

## Consequences

- W, I and U trees are equal between git and tsgit on every `-u` push the interop rows pin.
- A consumer that read W's parent count to detect `-u` sees three parents whenever `-u` was asked, as with git.
