---
subjects:
  - test/integration/glob-bracket-class-interop.test.ts
  - .claude/workflow/probes.md
phases: [design, implementation, validation]
kind: gotcha
trigger: a probe or an interop row passes git check-ignore a path whose first byte is a colon
evidence:
  - test/integration/glob-bracket-class-interop.test.ts:63-71
  - test/integration/glob-bracket-class-interop.test.ts:107-109
source: { run: wildmatch-bracket-class, phase: validation, date: 2026-11-24 }
status: active
supersedes: []
last-verified: 2026-11-24
---
# 058 — A check-ignore probe never asks about a path led by a colon

## Context

Mutation triage probed the set `[[a:]` against the paths `a`, `[` and `:`. git answered "not
ignored" for `:`, although `:` is a member of that set. `git check-ignore` reads its arguments
as pathspecs, and a leading `:` opens pathspec magic: the argument was never the path `:`. The
design had met the same answer a day earlier and listed it as a constraint on its rows. The
probe script written at triage did not carry the constraint, and printed a "no" per
`core.ignorecase` value that says nothing about the set.

## Lesson

A git command that takes pathspecs does not test the path as typed when it starts with `:`.
Its answer there says nothing about the pattern.

## How to apply

Ask about such a path through `git check-attr`, which takes plain paths, or leave it out of ignore rows.
Keep these paths in a column of their own in a shared table, as the interop suite does.
Treat a "no" on a path led by a colon as no evidence, and ask again with another member of the set.

## Evidence

`test/integration/glob-bracket-class-interop.test.ts:63-71` — `GlobCase`, with the paths only an attribute check can ask about.
`test/integration/glob-bracket-class-interop.test.ts:107-109` — three rows that put `:` and `:]` in that column.
