---
subjects:
  - test/unit/**/*.properties.test.ts
  - .claude/workflow/property-testing.md
phases: [implementation, review]
kind: trap
trigger: a property compares an implementation with a reference oracle over two inputs drawn independently
evidence:
  - test/unit/domain/pathspec/compile-glob.properties.test.ts
  - test/unit/domain/pathspec/arbitraries.ts:85-141
  - test/unit/domain/pathspec/dowild-reference.ts
source: { run: wildmatch-bracket-class, phase: implementation, date: 2026-11-24 }
status: active
supersedes: []
last-verified: 2026-11-24
---
# 057 — A property against an oracle counts how often the oracle says yes

## Context

The class-grammar property drew a pattern and a path independently and compared the compiled
matcher with a recursive port of git's `dowild`. It reported no disagreement. Counting the
oracle's answers told what that was worth: of 24 424 sampled patterns holding a bracket set, 64
matched their path, 0.26%. The property proved that both sides refuse. A matcher refusing every
set would have passed it. A property over well-formed sets followed (9 970 matches in 20 000
samples), then one whose pattern is derived from the path (7 679 matches in 60 000, 5 495 of
them through a set).

## Lesson

Two inputs drawn independently rarely satisfy a grammar together. Agreement on "no" is cheap,
and a differential property made of it guards nothing on the "yes" side.

## How to apply

Count the oracle's yes answers once, outside the suite, before trusting a differential property.
When the rate is low, derive one input from the other: a pattern built from the path, or the reverse.
Keep the independent draw for malformed input, and add the derived property for matches.

## Evidence

`test/unit/domain/pathspec/compile-glob.properties.test.ts` — the reference-oracle properties over well-formed sets and over a pattern derived from the path.
`test/unit/domain/pathspec/arbitraries.ts:85-141` — `arbBracketMembers` and `arbPathWithDerivedPattern`.
`test/unit/domain/pathspec/dowild-reference.ts` — the recursive reference the properties compare against.
