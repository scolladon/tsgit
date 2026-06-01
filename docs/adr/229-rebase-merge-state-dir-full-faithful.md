# ADR-229: full byte-faithful `.git/rebase-merge/` state + cross-tool resume

## Status

Accepted (at `06489642`)

## Context

On a conflict stop, the merge backend writes a 17-file `.git/rebase-merge/`
directory plus `.git/REBASE_HEAD`. The cherry-pick sequencer (ADR-218) set the
precedent of a **git-byte-faithful, bidirectionally cross-tool-resumable** state
dir. For rebase the same bar means reproducing far more files (`author-script`,
`patch`, `rewritten-list`, the `git-rebase-todo.backup` help block, several empty
flag markers) than the resume-critical core.

Three options were surfaced in the planning conversation:

1. **Resume-critical subset** — only the files `--continue`/`--abort` consume;
   auxiliary/cosmetic files deferred (documented gap).
2. **Full byte-faithful** — all 17 files, enabling the same bidirectional
   cross-tool resume the sequencer has.
3. **tsgit-private minimal** — smallest, not cross-tool resumable, full
   divergence.

## Decision

**Option 2 — full byte-faithful `.git/rebase-merge/`.** Every file the merge
backend writes is reproduced byte-for-byte (verified `od -c`), including
`head-name`, `onto`, `orig-head`, `git-rebase-todo`(+`.backup`), `done`,
`message`, `author-script`, `end`, `msgnum`, `interactive`, `rewritten-list`,
`patch`, `stopped-sha`, and the empty flag markers, plus `.git/REBASE_HEAD`. This
delivers bidirectional cross-tool resume parity: a tsgit-started rebase finishes
under `git rebase --continue`, and a git-started rebase finishes under
`repo.rebase.continue`.

`author-script` follows git's `sq_quote` shell quoting and the `@<unix> <tz>`
internal date format. The `git-rebase-todo.backup` `# Commands:` help block is
git-version-sensitive cosmetic text; it is reproduced as a constant and is **not**
consumed by resume, so the cross-tool pins target the resume-critical files.

## Consequences

### Positive

- Maximal faithfulness, consistent with ADR-218/226; full cross-tool resume.
- A user (or another tool) inspecting a tsgit stop sees exactly git's bytes.

### Negative

- The largest state surface in the codebase; `patch`/`rewritten-list`/`.backup`
  add work beyond what tsgit's own resume strictly needs.
- The `.backup` help block tracks a specific git version's wording.

### Neutral

- The rebase todo grammar (`pick <oid> # <subject>`) differs from the sequencer
  grammar (`pick <oid> <subject>`), so it lives in its own `domain/rebase/todo`,
  not the shared `domain/sequencer`.
