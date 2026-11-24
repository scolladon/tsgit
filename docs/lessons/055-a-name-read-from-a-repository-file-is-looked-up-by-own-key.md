---
subjects:
  - src/domain/glob/wildmatch.ts
phases: [implementation, review]
kind: trap
trigger: indexing an object literal used as a lookup table with text parsed from a repository file
evidence:
  - src/domain/glob/wildmatch.ts:97
  - test/unit/domain/glob/wildmatch.test.ts:404
source: { run: wildmatch-bracket-class, phase: implementation, date: 2026-11-23 }
status: active
supersedes: []
last-verified: 2026-11-24
---
# 055 — A name read from a repository file is looked up by own key

## Context

The named classes of a bracket expression (`[[:alpha:]]`) were resolved by indexing an object
literal with the name between the colons. git aborts the whole pattern on a name it does not
know. The object literal knew more names than it listed: `[[:constructor:]]` and two other names
inherited from `Object.prototype` resolved to functions that returned a truthy value for every
byte, so the set matched everything, and `[[:__proto__:]]` resolved to an object and threw when
called. The table already served ref globs and pathspecs on main; moving the ignore family onto
it made the name reachable from a `.gitignore` in a cloned repository.

## Lesson

An object literal answers for every key on its prototype chain. Text that someone else writes
can name one of them.

## How to apply

Hold a table keyed by parsed text in a `Map`, or test the key as an own key before reading it.
Add rows for `constructor`, `toString`, `valueOf`, `hasOwnProperty` and `__proto__` beside the unknown-name row.
Check the browser floor before reaching for `Object.hasOwn`: a `Map` needs no newer runtime.

## Evidence

`src/domain/glob/wildmatch.ts:97` — `CLASS_TESTS`, a `Map` from class name to byte test.
`test/unit/domain/glob/wildmatch.test.ts:404` — the rows where a name inherited from the object prototype yields no tokens.
