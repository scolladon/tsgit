# Plan — write-exclusive-file-parent

> Source: design doc docs/design/write-exclusive-file-parent.md. No rulings: the user chose
> "pin + strike" before the run. One part, test-only, no `src/` delta.

## Shared facts (every part reads this first)

GWT split across describe/it, AAA comments, `sut` where a system under test is bound,
try/catch + `.data` assertions, no suppression comments, no phase/ADR/backlog ids in test code.
The contract suite runs per driver from test/unit/adapters/node/node-file-system.test.ts and
test/unit/adapters/memory/memory-file-system.test.ts; `env.fs` is the driver's adapter and
`env.rootDir` its root.

## Part 1 — pin the depth-1 file-parent refusal in the port contract

### Context

Design §Change, first bullet. Commit type: `test(fs):`.

Files edited:
- `test/unit/ports/file-system.contract.ts` — the comment at lines 831–834 ("Depth-1 … Node
  reports FILE_EXISTS …") sits above the grandparent row 'Given a file at a grandparent path
  segment, When writeExclusive, Then throws NOT_A_DIRECTORY …' (line 835). Helpers in the
  same file: `assertNotADirectory(err)` (line 291).

Read-only references: src/adapters/node/node-file-system.ts `createExclusive` (around line
1289, create-first, `mkdir` only on `ENOENT`), src/adapters/memory/memory-file-system.ts
`writeExclusive` (around line 167).

### TDD steps

1. GUARD — new row above the grandparent row: 'Given a file at the immediate parent, When
   writeExclusive, Then throws NOT_A_DIRECTORY and leaves the parent file intact'. Arrange
   `parent = ${env.rootDir}/parent.bin` written with `[1]`; act `writeExclusive(${parent}/leaf.bin, [2])`
   in try/catch; assert `assertNotADirectory(caught)` and `read(parent)` equals `[1]`. Passes on
   both drivers on main: the behaviour shipped in #317.
2. BITE CHECK — prove the row discriminates: in the worktree, temporarily put an unconditional
   `await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });` as the first
   statement of `createExclusive` (the pre-#317 shape), run the node contract suite, see the new
   row fail with `FILE_EXISTS`, then `git checkout -- src/` to discard. Never committed.
3. Delete the stale depth-1 comment; the grandparent row's own comment stays.

### Gate

`./node_modules/.bin/vitest run test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/memory/memory-file-system.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/ports/file-system.contract.ts && npm run check:spelling`

### Commit

`test(fs): pin writeExclusive's NOT_A_DIRECTORY refusal under a file parent`
