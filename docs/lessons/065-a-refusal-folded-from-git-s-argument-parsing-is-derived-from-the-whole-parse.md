---
subjects:
  - src/application/primitives/is-ignored.ts
  - src/application/primitives/**
phases: [design, review, impact-triage]
kind: gotcha
trigger: a fold copies one refusal out of the git code that parses a command's arguments into a primitive that took its input as typed
evidence:
  - src/application/primitives/is-ignored.ts
  - test/integration/is-ignored-leading-directory-interop.test.ts
  - docs/design/is-ignored-leading-directory.md
  - docs/adr/1280-is-ignored-judges-the-normalized-spelling-of-a-query.md
source: { run: is-ignored-leading-directory, phase: review, date: 2026-11-26 }
status: active
supersedes: []
last-verified: 2026-11-27
---
# 065 — A refusal folded from git's argument parsing is derived from the whole parse

## Context

Impact triage folded one refusal into `isIgnored`: `git check-ignore` dies on an argument beyond
a symbolic link. The fold was written from the four lines of `pathspec.c` that raise it. Three
review rounds then found, one round at a time, what the lines around them do. The check runs on
the normalized path, so `missing/../link/secret` got past a scan of the path as typed, and
`link/../top.log` was refused where git answers. The exclude files are read before the
arguments are parsed. An empty argument refuses first. An absolute path is outside the
repository. And the normalized path can be empty, which only a rule holding no slash matches.
Two of those divergences were introduced by the fix of the one before.

## Lesson

A refusal in git's argument parsing is one step of a sequence: what ran before it, which
spelling of the argument it tests, and which spelling the rest of the command then receives.
Copying the step without the sequence moves the divergence somewhere else.

## How to apply

Before the design, read the whole parsing function and its callers in git's source, and list every step in order with the input it sees.
Pin one row per step against git, and one row per pair of steps for their order.
Pin the degenerate outputs of every transform on the way: the empty path, an absolute path, a trailing separator.
Ask which spelling the code after the parse receives, the typed one or the transformed one, and pin a row where the two differ.
Walk outward too: what the builtin's wrapper and config callback run first, and the steps inside each function the path calls.
Fold the sequence whole, or leave the refusal out.

## Evidence

`src/application/primitives/is-ignored.ts` — `parseQueries`, `parseQuery` and `judgedPathOf`:
the sequence as it ended.
`test/integration/is-ignored-leading-directory-interop.test.ts` — the rows each round added: the
spellings, the two refusals and their order, the oversized exclude files, the empty path, the
root path under four rules.
`docs/design/is-ignored-leading-directory.md` — "What the review of the fold changed" and the
paragraph after it: what each round found.
`docs/adr/1280-is-ignored-judges-the-normalized-spelling-of-a-query.md` — the ruling the rounds
led to.
`docs/design/checkout-remote-branch-dwim.md` — "What review folded": the checkout guess listed seventeen steps of `parse_branchname_arg` and the functions it calls, and review still found four outside that list — `check_filename` run eagerly, `parse_pathspec` before the `-b` and `--detach` refusals, `setup_work_tree` in `run_builtin` before the config callback, and `for_each_remote` reading every remote key through `remote.c`'s `handle_config`.
