---
subjects:
  - test/unit/**
  - docs/plan/**
phases: [planning, implementation, review]
kind: gotcha
trigger: a plan tells an implementer to add tests before a describe's closing line and the file has several closing braces at that indent
evidence:
  - test/unit/domain/objects/tree-entry-bytes.test.ts
  - docs/plan/fsck-raw-byte-dotgit-alias.md
source: { run: fsck-raw-byte-dotgit-alias, phase: review, date: 2026-11-06 }
status: active
supersedes: []
last-verified: 2026-11-08
---
# 031 — A test block anchored on a closing brace lands in whichever describe closes there

## Context

The plan for the dotgit alias fold told the implementer to add six new tables inside
`describe('matchesDotgitAlias')`, "before its closing L494". The file holds three
top-level describes that each close with the same two characters at the same indent,
and the implementer inserted the 172-line block before the first such line it found:
the close of `describe('hasNonOctalByte')`, at L315. Forty-six tests about the alias
fold ran, and passed, under the ancestor `hasNonOctalByte`. Every gate was green: a test
passes wherever it sits, the type checker has no opinion on describe nesting, and the
test-pyramid audit counts titles, not ancestry. The tests reviewer found it by running the
file through the JSON reporter and reading each test's ancestor titles; the fix moved
the block byte-identical into the right describe.

## Lesson

A line number is a position, not a place. A closing brace carries no name, so an
insertion anchored on one belongs to whichever block happens to close there, and nothing
downstream of the editor will notice.

## How to apply

Anchor a planned insertion on the describe's title text, never on a line number of its closing brace.
After inserting, verify the ancestry: `npx vitest run <file> --reporter=json` and read each new test's `ancestorTitles`.
A plan's line references are taken at one commit; re-locate by title or symbol after any earlier part lands.
A reviewer checks nesting with the JSON reporter, because the gate cannot: tests pass wherever they sit.
When a block must move, cut and paste it whole and diff the removed and added hunks for identity.

## Evidence

`test/unit/domain/objects/tree-entry-bytes.test.ts` — the six alias-fold tables now sit under `describe('matchesDotgitAlias')`, between the NTFS rows and the rejected-byte re-pin.
`docs/plan/fsck-raw-byte-dotgit-alias.md` — Part 2's context block, the instruction "Add new tables inside `describe('matchesDotgitAlias')`, before its closing L494" that anchored on a line.
