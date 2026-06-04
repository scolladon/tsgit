# Plan — consolidate the date-ordered commit priority-queue

Behaviour-preserving refactor (ADR-259). Three atomic slices, each kept green by
the **existing** suite — there is no new behaviour to drive, so the TDD safety net
is "the relevant tests pass before and after, output byte-identical". Each slice:
edit → run the touched test files → `npm run validate` → commit.

## Slice 1 — Relocate the canonical module to `domain/commit/`

The blame module is already the generic, fully-mutation-killed shape; relocate it
verbatim so it is no longer coupled to `blame`.

1. `git mv src/domain/blame/priority-queue.ts src/domain/commit/priority-queue.ts`
2. `git mv test/unit/domain/blame/priority-queue.test.ts test/unit/domain/commit/priority-queue.test.ts`
3. In the moved test, update the import path
   `../../../../src/domain/blame/priority-queue.js` →
   `../../../../src/domain/commit/priority-queue.js`.
4. In `src/application/commands/blame.ts`, update the import
   `../../domain/blame/priority-queue.js` → `../../domain/commit/priority-queue.js`.
5. Confirm no other importer remains:
   `grep -rn "blame/priority-queue" src test` → no matches.
6. `npx vitest run test/unit/domain/commit/priority-queue.test.ts` → green.
7. `npm run validate` → green.

Commit: `refactor(commit): relocate commit priority-queue to domain/commit`

## Slice 2 — Fold `describe` onto the shared queue

`commands/describe.ts` carries an inline payload-free copy.

1. Add `import { enqueue, type QueueEntry } from '../../domain/commit/priority-queue.js';`
   (alongside the existing imports).
2. Delete the local `interface QueueEntry { oid; date }`, the local `enqueue`, and
   the local `precedes` (with its `// Stryker disable` equivalence comment).
3. Change `WalkState.queue: QueueEntry[]` → `QueueEntry<undefined>[]`.
4. The two pops `state.queue.shift() as QueueEntry` → `as QueueEntry<undefined>`.
5. Add `value: undefined` to the three enqueue calls (seed, `enqueueParents`,
   `finishDepth`).
6. `npx vitest run test/unit/application/commands/describe` (+ the describe interop
   file) → green.
7. `npm run validate` → green.

Commit: `refactor(describe): use shared commit priority-queue`

## Slice 3 — Fold `merge-base` onto the shared queue

`primitives/merge-base.ts` carries an inline payload-free copy with the field
named `id`.

1. Add `import { enqueue, type QueueEntry } from '../../domain/commit/priority-queue.js';`.
2. Delete the local `interface QueueEntry { id; date }`, the local `precedes` and
   `enqueue` (both with their `// Stryker disable` equivalence comments).
3. `mark`: `enqueue(queue, { id, date: dateOf(await read(id)) })` →
   `enqueue(queue, { oid: id, date: dateOf(await read(id)), value: undefined })`.
4. `hasNonStale`: `flags.get(entry.id)` → `flags.get(entry.oid)`.
5. `paint`: type `const queue: QueueEntry[]` → `QueueEntry<undefined>[]`; the pop
   `const { id } = queue.shift()!` → `const { oid: id } = queue.shift()!`
   (destructure alias keeps the well-named local `id` everywhere else in `paint`).
6. `npx vitest run test/unit/application/primitives/merge-base` (+ the merge-base
   interop file) → green.
7. `npm run validate` → green.

Commit: `refactor(merge-base): use shared commit priority-queue`

## After the slices

- **Step 6 reviews** (typescript / security / tests), scoped to `git diff main...HEAD`.
- **Step 7 architecture pass**, seeded by this diff. Likely a no-op (the refactor
  *is* the consolidation) — record the justification.
- **Step 8 mutation**: scope Stryker to the four touched files
  (`domain/commit/priority-queue.ts`, `commands/describe.ts`,
  `primitives/merge-base.ts`, `commands/blame.ts`) and target 0 killable
  survivors. Expect the shared module fully killed by the relocated test; the
  consumers' pre-existing equivalent-mutant annotations on *other* logic are
  untouched, and the two inline-queue suppressions are gone with the deleted code.
- **Step 9 docs + PR**: flip the `23.3a` backlog entry to `[x]`, update any doc
  that referenced `domain/blame/priority-queue`, open the PR.

## Risks

- **Stale relative import**: the test and consumer import paths must all point at
  `domain/commit/`. Slice 1 step 5's grep is the guard.
- **`value: undefined` omission**: with required `value: T`, a missing
  `value: undefined` is a compile error (`check:types`), caught by `validate`
  before commit — not a silent gap.
