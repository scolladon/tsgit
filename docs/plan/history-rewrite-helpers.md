# Plan — centralise the history-rewrite command helpers

Behaviour-preserving extraction. Read `docs/design/history-rewrite-helpers.md`
first. The four helpers move verbatim into
`src/application/commands/internal/history-rewrite.ts`; the three command files
delete their local copies and import them.

## Slice ordering rationale (jscpd + knip safe)

`check:duplicates` (jscpd, 5% threshold) tolerates today's **3** identical copies
on green `main`. `check:dead-code` (knip) analyses only `src/**` — a test import
does **not** count as production usage, so the module must have ≥1 production
consumer in the very commit that creates it. Therefore:

| commit | identical instances after | module production-consumed? |
|--------|---------------------------|------------------------------|
| A — module + test + migrate `cherry-pick` | module, revert, rebase = 3 | yes (cherry-pick) |
| B — migrate `revert` | module, rebase = 2 | yes |
| C — migrate `rebase` | module = 1 (no clone) | yes |

Duplicated-line count is monotonically non-increasing from the green baseline, so
every commit passes jscpd; the module is production-consumed from commit A, so
every commit passes knip.

---

## Slice A — shared module + unit test + migrate `cherry-pick.ts`

Commit: `refactor(history-rewrite): centralise commit-read + symbolic-HEAD helpers`

### A.1 — Red: unit test against the not-yet-existent module

Write `test/unit/application/commands/internal/history-rewrite.test.ts`
(mirror `current-identity.test.ts`: memory ctx + `init`, GWT split, AAA, `sut`):

- `readCommitData`
  - Given a commit oid → Then returns its `CommitData` (assert `.tree` / `.parents`
    / `.message` on a seeded commit).
  - Given a blob oid → Then throws `UNEXPECTED_OBJECT_TYPE`; assert `caught.data`
    (`code`, `expected: 'commit'`, `actual: 'blob'`, `id`) via try/catch — not a
    bare `toThrow(class)`.
- `treeOf` — Given a commit → Then returns its tree oid (equals the seeded tree).
- `subjectOf` — Given `'a\nb\nc'` → `'a'`; Given `'solo'` → `'solo'`; Given `''` →
  `''` (parameterised `it.each` or three `it`s, GWT each).
- `requireSymbolicHead`
  - Given symbolic HEAD (fresh `init`) → Then returns the branch `RefName`.
  - Given detached HEAD (write HEAD to a raw oid) → Then throws
    `UNSUPPORTED_OPERATION`; assert `caught.data` carries the `verb` + reason
    `'cannot run with detached HEAD'` via try/catch.

Run: `npx vitest run test/unit/application/commands/internal/history-rewrite.test.ts`
→ fails (module not found). **Red confirmed.**

### A.2 — Green: create the module

Create `src/application/commands/internal/history-rewrite.ts`. Move the four
declarations verbatim; relative imports shift to the `internal/` depth (match
`current-identity.ts`):

```ts
import { unsupportedOperation } from '../../../domain/index.js';
import type { CommitData } from '../../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../../primitives/read-object.js';
import { readHeadRaw } from '../../primitives/internal/repo-state.js';

export const readCommitData = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return obj.data;
};

export const treeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> =>
  (await readCommitData(ctx, commitId)).tree;

export const subjectOf = (message: string): string => message.split('\n')[0] as string;

/** Read the symbolic HEAD branch, refusing a detached HEAD for `verb`. */
export const requireSymbolicHead = async (ctx: Context, verb: string): Promise<RefName> => {
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation(verb, 'cannot run with detached HEAD');
  }
  return head.target;
};
```

A module-level doc comment names the shared concern (commit-shape readers + the
symbolic-HEAD guard shared by cherry-pick / revert / rebase). No phase/ADR/backlog
refs in the source.

Re-run the test file → passes. **Green confirmed.**

### A.3 — Migrate `cherry-pick.ts`

- Delete the local `readCommitData` / `treeOf` / `subjectOf` (lines ~110–119) and
  `requireSymbolicHead` (lines ~571–578).
- Add `import { readCommitData, requireSymbolicHead, subjectOf, treeOf } from
  './internal/history-rewrite.js';` (alphabetised within the `./internal/*` group,
  matching the file's existing import order).
- Prune imports now orphaned: `unexpectedObjectType` (only the moved
  `readCommitData` used it). Re-check `readObject`, `readHeadRaw`,
  `unsupportedOperation` — drop each **iff** no remaining reference in the file
  (verify with a grep, not assumption).

### A.4 — Validate + commit

`npm run validate` → green. Commit slice A.

---

## Slice B — migrate `revert.ts`

Commit: `refactor(revert): consume shared history-rewrite helpers`

- Delete the local `readCommitData` / `treeOf` / `subjectOf` (~102–111) and
  `requireSymbolicHead` (~536–543).
- Add the same `./internal/history-rewrite.js` import.
- Prune orphaned imports (`unexpectedObjectType`; re-check `readObject`,
  `readHeadRaw`, `unsupportedOperation` per grep).
- `npm run validate` → green. Commit.

---

## Slice C — migrate `rebase.ts`

Commit: `refactor(rebase): consume shared history-rewrite helpers`

- Delete the local `readCommitData` / `treeOf` / `subjectOf` (~133–142). `rebase.ts`
  has **no** `requireSymbolicHead` and keeps its own `shortOid`.
- Add `import { readCommitData, subjectOf, treeOf } from
  './internal/history-rewrite.js';` (three symbols — no `requireSymbolicHead`).
- Prune orphaned imports (`unexpectedObjectType`; re-check `readObject` — rebase
  uses `unsupportedOperation` independently, so it stays).
- `npm run validate` → green. Commit. Duplication is now gone (single instance).

---

## Step 6–8 (handled by the workflow, not slices)

- **Review ×3** — typescript / security / tests on `git diff main...HEAD`.
- **Architecture refactor pass** — re-evaluate `isMergeCommit` (the one remaining
  cross-file 1-liner, 2 copies, divergent comments): fold into the family **iff**
  cohesive, else backlog follow-up. May be a no-op with written justification.
- **Mutation** — `stryker run --mutate src/application/commands/internal/history-rewrite.ts`;
  the `subjectOf` `split('\n')[0]` always-defined branch and the `obj.type` guard
  are the likely survivors — kill via the empty-message + blob-oid tests already
  planned.

## Step 9 — docs + backlog

- Flip `docs/BACKLOG.md` 22.3a `[ ]` → `[x]` with a one-line outcome note.
- No README/RUNBOOK/CONTRIBUTING change — this is an internal refactor with no
  public-API surface change (confirm `reports/api.json` is unchanged; if the
  prepush doc-typedoc gate regenerates it, commit the regenerated artefact).
