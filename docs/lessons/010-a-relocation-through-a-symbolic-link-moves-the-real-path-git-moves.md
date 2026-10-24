---
subjects:
  - src/application/commands/internal/submodule-absorb.ts
  - src/application/primitives/internal/real-path.ts
phases: [design, implementation, review]
kind: gotcha
trigger: code renames, compares or writes beside a repository path that `.git` reaches through a symbolic link
evidence:
  - src/application/commands/internal/submodule-absorb.ts
  - src/application/primitives/internal/real-path.ts
  - test/integration/gitlink-consumers-interop.test.ts
source: { run: status-gitlink-parity, phase: review, date: 2026-10-24 }
status: active
supersedes: []
last-verified: 2026-10-24
---
# 010 — A relocation through a symbolic link moves the real path git moves

## Context

`rm` absorbs an embedded submodule repository into `.git/modules/<name>`. The first port renamed
`<path>/.git` itself; when `.git` was a symbolic link it moved the link. The review's second pass
resolved one hop and compared the result with the git directory as plain strings; the third pass
found that a two-hop chain still moved a work-tree link, that a canonical spelling of the
superproject's own `.git` (`/private/var` for `/var`, any symlinked ancestor) was moved out of the
repository, and that git's prefix test has no separator, so a sibling spelled `.gitx` counts as
inside. Each fix opened the next case because each resolved one layer of what git's
`real_pathdup` resolves at once.

## Lesson

git compares and moves real paths: every component resolved, every hop followed, then a bare
`starts_with` against the real common dir. Anything less — the link text, one hop, a lexical
compare with a separator — moves directories git never touches or refuses moves git makes.

## How to apply

Resolve both sides with `realPathOf` (the alternates' `strbuf_realpath` port) before any compare.
Compare with git's bare `startsWith`, no separator appended.
Rename the resolved target through a filesystem that reaches it (`worktreeScopedFs(ctx, real)`).
Refuse before `mkdir`, `rename` or the link removal when the chain cannot be resolved.
Pin four twins: a chain, the canonical spelling of the own `.git`, a `.gitx` sibling, a link to a plain file.

## Evidence

`src/application/commands/internal/submodule-absorb.ts` — `relocateGitDir`, `isInsideGitDir`.
`src/application/primitives/internal/real-path.ts` — `realPathOf`.
`test/integration/gitlink-consumers-interop.test.ts` — the rm twins named `a .git linking …`.
