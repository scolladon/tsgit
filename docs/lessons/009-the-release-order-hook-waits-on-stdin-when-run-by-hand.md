---
subjects:
  - .claude/hooks/check-release-order.sh
phases: [documentation]
kind: gotcha
trigger: running .claude/hooks/check-release-order.sh by hand as a docs gate
evidence:
  - .claude/hooks/check-release-order.sh
source: { run: pathspec-glob-dialect, phase: documentation, date: 2026-10-23 }
status: active
supersedes: []
last-verified: 2026-10-23
---
# 009 — The release-order hook waits on stdin when run by hand

## Context

The docs gate chains `cspell` and `.claude/hooks/check-release-order.sh`. Run from a shell with
no input, the hook sat for minutes and the command was moved to the background; killing it let
the rest of the chain run behind the session's back and race a second `git commit` on the index lock.

## Lesson

The script is a Stop hook: it reads the hook payload from stdin (`INPUT=$(cat)`) before it
checks anything, so a manual run blocks until stdin closes.

## How to apply

Run it by hand as `echo '{}' | .claude/hooks/check-release-order.sh`.
Never chain a commit after it in a command that might be backgrounded.

## Evidence

`.claude/hooks/check-release-order.sh` — reads `INPUT=$(cat)` before the release-order check.
