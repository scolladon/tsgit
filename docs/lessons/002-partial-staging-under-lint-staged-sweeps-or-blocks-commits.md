---
subjects:
  - .husky/**
  - package.json
phases: [implementation, review, validation]
kind: gotcha
trigger: committing with --only or hunk-level staging while other changes are staged or unstaged in the same worktree
evidence:
  - .husky/pre-commit
  - package.json
source: { run: lift-delta-chain-read-cap, phase: implementation, date: 2026-10-20 }
status: active
supersedes: []
last-verified: 2026-10-21
---
# 002 — Partial staging under lint-staged sweeps or blocks commits

## Context

Two incidents in one run. First, `git commit --only <src-file>` while an agent had nine
ADR edits staged: the lint-staged pre-commit hook re-staged everything it had backed up, and
the source commit swept the ADRs in under a `test(mutation)` message. Second, hunk-level
staging of zero-context hunks through `git apply --cached`: the hook hid the unstaged part of each
partially staged file, ran biome on that snapshot and reported errors the real file does not
have, so the commit was refused. Both histories had to be rebuilt.

## Lesson

The hook in `.husky/pre-commit` runs lint-staged, which backs up, hides and restores
working-tree state around its tasks. That dance assumes whole files: `--only` scopes git's
commit but not the hook's re-staging, and a partially staged file is linted in a state that
exists nowhere else. Zero-context hunks add a second trap: a pure insertion applied with
zero context lands at the stated line even after an earlier hunk has shifted the file.

## How to apply

Commit whole files; one batch of files per commit, never `--only` or hunk staging under this hook.
When two batches touch one file, rebuild them from deterministic edits on a restored tree, in order.
Snapshot the intended final content first and `cmp` the tree against it after the last commit.
Never `--no-verify`; a refused commit is a signal to re-stage, not to bypass.

## Evidence

`.husky/pre-commit` and the `lint-staged` block of `package.json` — the hook and its tasks.
`.husky/commit-msg` — a commitlint refusal after lint-staged ran leaves a `lint-staged automatic backup` stash behind; three sat on the shared stash list after the gc size-lying run.
