---
subjects:
  - docs/design/grep-diff-attribute-binary.md
  - src/application/commands/grep.ts
  - src/application/commands/internal/grep-binary-override.ts
phases: [design, review]
kind: trap
trigger: a design states a requirement or an ADR as a one-line rule distilled from a pinned behaviour matrix
evidence:
  - docs/design/grep-diff-attribute-binary.md
  - test/unit/application/commands/grep.test.ts
  - test/integration/grep-interop.test.ts
source: { run: grep-diff-attribute-binary, phase: review, date: 2026-11-12 }
status: active
supersedes: []
last-verified: 2026-11-12
---
# 037 — A rule summarising a pinned matrix is re-checked against every row

## Context

The design for grep's `diff` attribute pinned a matrix against git 2.56.0. One of its rows
said a path-less blob turns binary under `diff.default.binary=true`. Requirement 3 then
summarised the targets that read no attribute as "their verdict stays the sniff", and
ADR-1179 repeated it for tree objects. The plan, five parts and a green gate followed the
summary. The code reviewer re-probed git and found tree objects and path-less blobs still
take the `default` driver: `Binary file HEAD^{tree}:f1 matches`. The matrix row had been
right all along, but nothing read it once the summary existed.

## Lesson

A summary rule is a second claim about git, and a plan built on it inherits it. When the rule
and a matrix row disagree, every later phase reads the rule, so the fault only surfaces
through a fresh probe. Two axes that look identical ("reads no attribute" and "uses no driver")
were collapsed into one sentence.

## How to apply

Before committing a design, walk every pinned row and name the requirement that produces it.
A row that no requirement produces, or that a requirement contradicts, blocks the commit.
Write requirements per axis the pins vary, never one sentence covering two axes.
Pin each summary rule's negative cases too: the targets the rule excludes, under each config.

## Evidence

`docs/design/grep-diff-attribute-binary.md` keeps the default-driver matrix row and the corrected Requirement 3.
`test/unit/application/commands/grep.test.ts` ("Given a target that names no path and a default driver configured") and the `diff.default.binary` rows in `test/integration/grep-interop.test.ts` turn red when tree and path-less targets are given no override.
