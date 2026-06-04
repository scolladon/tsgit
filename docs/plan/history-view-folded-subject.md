# Plan — history/commit view + folded subject

Implements `design/history-view-folded-subject.md` + ADR-261. Four slices,
top-to-bottom, each an atomic commit landing on a green `npm run validate`. TDD:
Red (test fails for the stated reason) → Green (minimal impl) → Refactor.

Conventions: GWT describe/it split, AAA body, `sut`, 100% coverage, 0 killable
mutants, no ignore directives, no phase/ADR refs in source or test code.

---

## Slice 1 — `refactor(primitives)`: extract the shared commit reader

Behaviour-preserving prep so the two walkers co-own one read-object-→-skip-non-
commit-→-`ignoreMissing` implementation (ADR-261). No new test — the existing
`walk-commits.test.ts` suite is the regression oracle.

**Files**

- **new** `src/application/primitives/internal/read-commit.ts`:
  ```ts
  import type { Commit, ObjectId } from '../../../domain/objects/index.js';
  import { TsgitError } from '../../../domain/error.js';
  import type { Context } from '../../../ports/context.js';
  import { readObject } from '../read-object.js';

  export interface ReadCommitOptions {
    readonly verifyHash: boolean;
    readonly ignoreMissing: boolean;
    /** Sink recording oids skipped under `ignoreMissing` (the caller's read-dedup memo). */
    readonly missing: Set<string>;
  }

  /**
   * Lenient commit read for ancestry walks: resolves `id`, returning `undefined`
   * for a non-commit object and — under `ignoreMissing` — for a missing one
   * (its oid recorded in `missing`). Any other read failure propagates unchanged.
   */
  export const readCommit = async (
    ctx: Context,
    id: ObjectId,
    opts: ReadCommitOptions,
  ): Promise<Commit | undefined> => {
    try {
      const object = await readObject(ctx, id, { verifyHash: opts.verifyHash });
      return object.type === 'commit' ? object : undefined;
    } catch (error) {
      if (opts.ignoreMissing && isObjectNotFound(error)) {
        opts.missing.add(id);
        return undefined;
      }
      throw error;
    }
  };

  const isObjectNotFound = (error: unknown): boolean =>
    error instanceof TsgitError && error.data.code === 'OBJECT_NOT_FOUND';
  ```
- **edit** `src/application/primitives/walk-commits.ts`: delete the local
  `fetchCommit` + `isObjectNotFound`; import `readCommit`; the one call site
  becomes
  `await readCommit(ctx, id, { verifyHash, ignoreMissing, missing: state.missing })`.
  Leave the walk loop, `enqueueParents`, `pickNext`, and every `// Stryker
  disable` annotation untouched.

**Verify**: `npx vitest run test/unit/application/primitives/walk-commits.test.ts`
stays green (all existing cases, including the ignoreMissing / non-commit /
hash-mismatch / propagation ones, now exercise `read-commit.ts`). Then
`npm run validate`.

**Commit**: `refactor(primitives): extract the shared commit reader for walk primitives`

---

## Slice 2 — `feat(commit-message)`: `foldSubject` (git `%s`)

The folded-subject projection: leading paragraph collapsed to one space-joined
line, each line trailing-trimmed (ASCII `isspace`), stopping at the first blank
line.

### Red — example tests (`test/unit/domain/objects/commit-message.test.ts`)

Add a `describe('foldSubject', …)` block (GWT/AAA, `sut`). Importing the
not-yet-defined `foldSubject` fails the run. Cases (one expectation each; the
blank-line-break and trailing-trim branches are **isolated** per guard so neither
mutant survives alone):

| Given | message | `sut` |
|-------|---------|-------|
| a two-line subject | `'a\nb'` | `'a b'` |
| a body after the first blank line | `'s\n\nbody'` | `'s'` |
| a line with trailing spaces before a fold | `'a  \nb'` | `'a b'` |
| a continuation line with leading whitespace | `'a\n  b'` | `'a   b'` |
| a leading blank line | `'\nbody'` | `''` |
| a trailing tab on the only line | `'a\t'` | `'a'` |
| a trailing vertical tab | `'a\v'` | `'a'` |
| a trailing form feed | `'a\f'` | `'a'` |
| CRLF endings (trailing `\r` trimmed, unlike subjectLine) | `'a\r\nb'` | `'a b'` |
| a single-line message | `'solo'` | `'solo'` |
| an empty message | `''` | `''` |
| only a non-breaking space (non-ASCII, kept) | `' '` | `' '` |

### Green — implement (`src/domain/objects/commit-message.ts`)

Beside `subjectLine` / `stripspace`, reusing the file-local
`TRAILING_ASCII_WHITESPACE`:

```ts
/**
 * A commit's folded subject — git's `%s` (`format_subject`): the leading
 * paragraph collapsed to a single line, joining consecutive non-blank lines
 * with one space. Each line's trailing ASCII whitespace is stripped (git's
 * `is_blank_line`); the first blank line ends the subject, so the body never
 * appears. Leading whitespace on a continuation line is preserved.
 */
export const foldSubject = (message: string): string => {
  const lines: string[] = [];
  for (const raw of message.split('\n')) {
    const line = raw.replace(TRAILING_ASCII_WHITESPACE, '');
    if (line === '') break;
    lines.push(line);
  }
  return lines.join(' ');
};
```

### Properties (`test/unit/domain/objects/commit-message.properties.test.ts`)

Add `describe('foldSubject properties', …)`. Reuse `arbCommitMessage()`; add an
`arbNonBlankLine()` to the sibling `arbitraries.ts` (a `\n`-free string with at
least one non-whitespace ASCII char — e.g. `fc.tuple(bodyChar, fc.string no-\n)`
mapped to a guaranteed-non-blank line):

- idempotent: `foldSubject(foldSubject(m)) === foldSubject(m)` — `numRuns: 200`;
- no newline: `!foldSubject(m).includes('\n')` — `numRuns: 200`;
- body-independent: for an `arbNonBlankLine()` `subject` + an `arbCommitMessage()`
  `body`, `foldSubject(`${subject}\n\n${body}`) === foldSubject(subject)` —
  `numRuns: 100`;
- never throws — `numRuns: 100`.

**Verify**: `npx vitest run test/unit/domain/objects/commit-message.test.ts
test/unit/domain/objects/commit-message.properties.test.ts`, then
`npm run validate`.

**Commit**: `feat(commit-message): foldSubject — git %s folded subject`

---

## Slice 3 — `feat(primitives)`: `walkCommitsByDate`

The all-parents, commit-date-ordered (newest first, oid-asc tie-break) walk.

### Red — example tests (`test/unit/application/primitives/walk-commits-by-date.test.ts`)

New suite mirroring `walk-commits.test.ts` (own `AUTHOR`, `linearChain`,
`buildDiamond`, `collect` helpers; `buildSeededContext` from `./fixtures.js`).
The diamond fixture uses **strictly increasing** dates `a=1<b=2<c=3<d=4` so the
date order is deterministic. Importing the not-yet-defined `walkCommitsByDate`
fails the run. Cases:

- **empty `from`** → `INVALID_WALK_INPUT`;
- **over-cap `from`** (1025 synthetic oids) → `INVALID_WALK_INPUT` (`/too many/`);
- **at-cap `from`** (1024 synthetic oids) → passes validation, first read throws
  `OBJECT_NOT_FOUND` (kills the `>`→`>=` boundary, proves the loop entered);
- **linear 5-chain** from head → 5 commits, ids newest-first
  (`[c4,c3,c2,c1,c0]`);
- **diamond** from `d` → exact `[d, c, b, a]` (newest-first comparator + all-
  parents reach; a FIFO/topo mutant yields `[d,b,c,a]`);
- **equal-date tie-break** → two roots with equal committer dates pop
  oid-ascending (kills `precedes`'s `a.oid < b.oid`); build two commits with the
  same `ts` but different messages so their oids differ, walk from both seeds,
  assert the lower oid precedes;
- **diamond dedup** → shared base `a` appears exactly once (isolates
  `seen.has(parent)` true / `until.has(parent)` false);
- **duplicate seed** `from:[x, x]` → `x` yielded once (pins the deduped seed
  iteration; a raw-`from` loop yields twice);
- **seed that is also an ancestor** `from:[d, a]` (diamond) → `a` yielded once
  (pins `new Set(options.from)` seeding; an empty-seeded mutant re-enqueues `a`);
- **`until=[a]`** from `d` → `a` excluded (length 3, `a` absent; isolates
  `until.has(parent)` true / `seen.has(parent)` false);
- **`until` seed never read** → from `[x]` with `until=[x]` where `x` is a
  *missing* oid and `ignoreMissing:false` → zero commits, **no throw** (proves
  the until-gate fires before the eager read; a read-then-skip impl throws
  `OBJECT_NOT_FOUND`);
- **`shallow={tip}`** → yields only the tip;
- **`ignoreMissing` + missing parent** → child yielded, no throw;
- **missing parent, no `ignoreMissing`** → `OBJECT_NOT_FOUND`;
- **non-commit seed** (a written tree oid) → skipped (zero commits);
- **corrupted loose object, default `verifyHash`** → `OBJECT_HASH_MISMATCH`
  (pins `verifyHash ?? true`'s default; a `?? false` mutant would parse it);
- **`verifyHash:false` over impostor bytes** → walk succeeds, parsed content is
  the impostor's (covers the non-nullish `verifyHash` branch);
- **already-aborted signal** → zero yields, `OPERATION_ABORTED`;
- **abort between two yields** → `OPERATION_ABORTED` at the next loop head.

### Green — implement

**`src/application/primitives/types.ts`** — add beside `WalkCommitsOptions`:
```ts
export interface WalkCommitsByDateOptions {
  readonly from: ReadonlyArray<ObjectId>;
  readonly until?: ReadonlyArray<ObjectId>;
  readonly shallow?: ReadonlySet<ObjectId>;
  readonly ignoreMissing?: boolean;
  readonly verifyHash?: boolean;
}
```
(picked up by the barrel's `export type * from './types.js'`).

**`src/application/primitives/walk-commits-by-date.ts`** — new module:
```ts
import { invalidWalkInput, operationAborted } from '../../domain/error.js';
import { enqueue, type QueueEntry } from '../../domain/commit/priority-queue.js';
import type { Commit, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readCommit } from './internal/read-commit.js';
import type { WalkCommitsByDateOptions } from './types.js';
import {
  exceedsMaxWalkSeeds, isEmptyFrom,
  REASON_WALK_EMPTY_FROM, REASON_WALK_TOO_MANY_SEEDS,
} from './validators.js';

export async function* walkCommitsByDate(
  ctx: Context,
  options: WalkCommitsByDateOptions,
): AsyncIterable<Commit> {
  if (isEmptyFrom(options.from)) throw invalidWalkInput(REASON_WALK_EMPTY_FROM);
  if (exceedsMaxWalkSeeds(options.from)) throw invalidWalkInput(REASON_WALK_TOO_MANY_SEEDS);

  const until = new Set<ObjectId>(options.until ?? []);
  const shallow = options.shallow ?? new Set<ObjectId>();
  const seen = new Set<ObjectId>(options.from);
  const queue: QueueEntry<Commit>[] = [];
  const verifyHash = options.verifyHash ?? true;
  const ignoreMissing = options.ignoreMissing ?? false;
  // `seen` already prevents any re-read, so readCommit's missing-memo is inert
  // here; it satisfies the shared reader's contract without a second set.
  const missing = new Set<string>();
  const read = (id: ObjectId): Promise<Commit | undefined> =>
    readCommit(ctx, id, { verifyHash, ignoreMissing, missing });

  // Iterate the deduped `seen` set, not raw `from`, so a duplicate seed enqueues
  // once — parity with `walkCommits`, whose pop-time `visited` check dedups
  // seeds (this pop loop has none, by design).
  for (const seed of seen) {
    if (until.has(seed)) continue;
    await enqueueCommit(queue, seed, read);
  }

  while (queue.length > 0) {
    if (ctx.signal?.aborted) throw operationAborted();
    const { value: commit } = queue.shift() as QueueEntry<Commit>;
    yield commit;
    if (shallow.has(commit.id)) continue;
    for (const parent of commit.data.parents) {
      if (seen.has(parent) || until.has(parent)) continue;
      seen.add(parent);
      await enqueueCommit(queue, parent, read);
    }
  }
}

const enqueueCommit = async (
  queue: QueueEntry<Commit>[],
  id: ObjectId,
  read: (id: ObjectId) => Promise<Commit | undefined>,
): Promise<void> => {
  const commit = await read(id);
  if (commit !== undefined) {
    enqueue(queue, { oid: id, date: commit.data.committer.timestamp, value: commit });
  }
};
```

Notes:
- `seen` is seeded with **all** `from` (not just the un-`until`'d ones) so a seed
  that is also another seed's parent is never re-enqueued. An `until` seed is
  skipped before reading; it is still in `seen`, which is harmless (it is never a
  yield candidate).
- the pop loop has **no** until/visited skip — the gates upstream guarantee the
  queue holds only yieldable, deduped commits.

**`src/application/primitives/index.ts`** — add
`export { walkCommitsByDate } from './walk-commits-by-date.js';` (alphabetical,
right after the `walkCommits` line).

**`src/repository.ts`** — two edits mirroring `walkCommits`:
- in the `Repository['primitives']` interface, add
  `readonly walkCommitsByDate: BindCtx<typeof primitives.walkCommitsByDate>;`
  (after `walkCommits`);
- in the binding object, add
  ```ts
  walkCommitsByDate: ((options) => {
    guard();
    return primitives.walkCommitsByDate(ctx, options);
  }) as Repository['primitives']['walkCommitsByDate'],
  ```

### Regenerate the API report

`src/application/primitives/index.ts` and `src/repository.ts` are typedoc entry
points, so the new export + binding change `reports/api.json`. Run
`npm run docs:json`, then `git add reports/api.json` so the prepush
`check:doc-typedoc` (`git diff --exit-code -- reports/api.json`) is clean. The id
churn is expected (memory: api.json prepush gate).

**Verify**: `npx vitest run test/unit/application/primitives/walk-commits-by-date.test.ts`,
then `npm run validate`.

**Commit**: `feat(primitives): walkCommitsByDate — all-parents date-ordered history walk`
(includes the regenerated `reports/api.json`).

---

## Slice 4 — `test(interop)`: faithfulness goldens vs canonical git

`test/integration/history-interop.test.ts`, `describe.skipIf(!GIT_AVAILABLE)`,
using `runGit` / `runGitEnv` / `GIT_AVAILABLE` from `./interop-helpers.js` and
the memory adapter or `openRepository` from `../../src/index.node.js`.

Build one **diamond with a merge commit** in a real git repo, via canonical
`git` (scrubbed `GIT_*`, signing off, per-commit `GIT_AUTHOR_DATE` /
`GIT_COMMITTER_DATE`) — a merge is required so the walk-order assertion actually
distinguishes the **all-parents** reach from first-parent:

- `base` (date 1000) → branch `b` commit (date 2000) and branch `c` commit
  (date 3000) → `merge` (date 4000, parents `b` & `c`); **strictly-distinct
  decreasing** dates keep the order unambiguous (independent of git's equal-date
  heap order);
- the branch-`b` commit carries a **multi-line subject**
  (`"Fix the parser\nin two lines"`); the branch-`c` commit carries a
  **trailing-whitespace subject** (`"trailing ws  "`) — the two shapes that
  separate `%s` from a naive first-line split.

Open the **same** repo through `openRepository({ cwd })` and assert:

1. **walk order** — the `walkCommitsByDate({ from: [tip] })` oid sequence equals
   `git rev-list --date-order <tip>` (split on `\n`, drop the trailing blank);
2. **folded subject** — for every walked commit,
   `foldSubject(commit.data.message)` equals
   `git log -1 --format=%s <oid>`.trimEnd-of-the-single-trailing-`\n` (git appends
   one `\n` to `--format`; compare against the line).

Strictly-decreasing dates keep the order independent of git's unspecified
equal-date heap order; the deterministic tie-break stays a unit-test concern.
`foldSubject` is imported by direct domain path (`src/domain/objects/commit-message.js`),
not the barrel (it is not publicly exported).

**Verify**: `npx vitest run test/integration/history-interop.test.ts`, then
`npm run validate`.

**Commit**: `test(interop): date-order history walk + folded subject vs canonical git`

---

## Post-slices

- **Step 6** reviews ×3 (typescript / security / tests), fix-all-until-converged.
- **Step 7** architecture pass — candidates already logged: (a) simplify the now-
  vestigial `pickNext(_order)` in `walk-commits.ts`; (b) weigh folding
  `describe`'s bespoke date walk onto `walkCommitsByDate` (expected: defer — not
  rule-of-three, entangled bookkeeping). Behaviour-preserving; scoped re-review.
- **Step 8** mutation on every touched file to 0 killable.
- **Step 9** docs refresh (`README`/`RUNBOOK`/`CONTRIBUTING` + get-started/use/
  understand as relevant), flip `docs/BACKLOG.md` **23.4b** `[ ]`→`[x]`, push,
  `gh pr create`.

## Files touched (summary)

| file | slice | kind |
|------|-------|------|
| `src/application/primitives/internal/read-commit.ts` | 1 | new |
| `src/application/primitives/walk-commits.ts` | 1 | edit (extract) |
| `src/domain/objects/commit-message.ts` | 2 | edit (+`foldSubject`) |
| `test/unit/domain/objects/commit-message.test.ts` | 2 | edit |
| `test/unit/domain/objects/commit-message.properties.test.ts` | 2 | edit |
| `test/unit/domain/objects/arbitraries.ts` | 2 | edit (+`arbNonBlankLine`) |
| `src/application/primitives/types.ts` | 3 | edit (+options) |
| `src/application/primitives/walk-commits-by-date.ts` | 3 | new |
| `src/application/primitives/index.ts` | 3 | edit (export) |
| `src/repository.ts` | 3 | edit (binding) |
| `reports/api.json` | 3 | regenerated |
| `test/unit/application/primitives/walk-commits-by-date.test.ts` | 3 | new |
| `test/integration/history-interop.test.ts` | 4 | new |
