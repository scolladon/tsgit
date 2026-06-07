# Plan — `whatchanged`

TDD, per ADR-282 + `design/whatchanged.md`. Each slice is one atomic commit; run
`npm run validate` before each. Renames hardcoded on; merges excluded; entry
`extends LogEntry`.

## Slice 1 — command + unit tests `feat(whatchanged): walk commits with raw structured changes`

**Red** — `test/unit/application/commands/whatchanged.test.ts` (GWT/AAA, `sut`):

Build small histories with the existing in-test helpers (memory adapter +
`createCommit`/`writeObject`, mirroring `walk-commits-by-date.test.ts` fixtures).

Cases (each guard isolated for mutation):
- Given a linear history → each non-merge entry pairs the commit's `log` fields
  with its first-parent `changes` (assert a modify + add change set).
- Given the root commit → `changes` is the add-set vs the empty tree.
- Given a merge → the merge commit is **absent**; its side-branch ancestor is
  present (reachability preserved).
- Given a pure rename → one `rename` change (detection on), not delete+add.
- Given an empty commit (`--allow-empty` equivalent) → entry present, `changes:
  { changes: [] }`.
- Given `limit: N` with a merge inside the window → exactly `N` emitted
  (non-merge) entries; the merge does not consume a slot.
- Given `before` → commits with `committer.timestamp >= before` excluded.
- Given `excluding: [rev]` → the excluded range is removed.
- Given `order: 'first-parent'` → only the first-parent chain (minus merges).
- Given an unresolvable `rev` / `excluding` entry → refuses with the same error
  `log` throws (`OBJECT_NOT_FOUND` / unborn-HEAD refusal).

Run `npx vitest run test/unit/application/commands/whatchanged.test.ts` — fails
(module absent).

**Green** — `src/application/commands/whatchanged.ts`:

```ts
import type { TreeDiff } from '../../domain/diff/index.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { walkCommitsByDate } from '../primitives/walk-commits-by-date.js';
import { treeOf } from './internal/history-rewrite.js';
import type { LogEntry, LogOrder } from './log.js';
import { assertRepository } from './internal/repo-state.js';
import { resolveCommit } from './internal/resolve-rev.js';

export interface WhatchangedOptions { rev?; order?; limit?; excluding?; before?; }
export interface WhatchangedEntry extends LogEntry { readonly changes: TreeDiff; }

export const whatchanged = async (ctx, opts = {}): Promise<ReadonlyArray<WhatchangedEntry>> => {
  await assertRepository(ctx);
  const startId = await resolveCommit(ctx, opts.rev ?? 'HEAD');
  const exclude = await Promise.all((opts.excluding ?? []).map((r) => resolveCommit(ctx, r)));
  const walk = opts.order === 'first-parent'
    ? walkCommits(ctx, { from: [startId], until: exclude, order: 'first-parent' })
    : walkCommitsByDate(ctx, { from: [startId], until: exclude });
  const out: WhatchangedEntry[] = [];
  let yielded = 0;
  for await (const value of walk) {
    if (value.data.parents.length >= 2) continue;                 // skip merges
    if (opts.before !== undefined &&
        value.data.committer.timestamp >= opts.before.getTime() / 1000) continue;
    const parentTree = value.data.parents[0] !== undefined
      ? await treeOf(ctx, value.data.parents[0]) : undefined;
    const changes = await diffTrees(ctx, parentTree, value.data.tree,
      { recursive: true, detectRenames: true });
    out.push({ id: value.id, tree: value.data.tree, parents: value.data.parents,
      author: value.data.author, committer: value.data.committer,
      message: value.data.message, changes });
    yielded += 1;
    if (opts.limit !== undefined && yielded >= opts.limit) break;
  }
  return out;
};
```

Re-run the file → green. `npm run validate`.

## Slice 2 — facade wiring `feat(whatchanged): bind command on the Repository facade`

**Red** — add `'whatchanged'` to the facade key-set array in
`test/unit/repository/repository.test.ts` → the key-set test fails.

**Green**:
- `src/application/commands/index.ts`: `export { type WhatchangedEntry, type
  WhatchangedOptions, whatchanged } from './whatchanged.js';`
- `src/repository.ts`: `readonly whatchanged: BindCtx<typeof commands.whatchanged>;`
  (interface, after `tag`) + binding (`whatchanged: ((opts) => { guard(); return
  commands.whatchanged(ctx, opts); }) as Repository['whatchanged']`).
- Regenerate `reports/api.json` (`npm run check:doc-typedoc` writes it, or the
  documented regen path); commit the diff.

`npm run validate`.

## Slice 3 — interop `test(whatchanged): cross-tool raw-diff reconstruction`

`test/integration/whatchanged-interop.test.ts` (skipIf `!GIT_AVAILABLE`, one
shared `beforeAll` repo, 60s timeout, scrubbed `runGitEnv`). Build with real git:
root, a modify+add, a `git mv` rename, an empty commit (`commit --allow-empty`),
a `--no-ff` merge. Reconstruct each entry's raw lines from `changes`:

```
:<oldMode> <newMode> <oldOid|0*40> <newOid|0*40> <status>\t<path>[\t<newPath>]
```

per change type, join with the commit header git emits, and assert byte-equality
with `git log --raw --no-merges --abbrev=40` (default order) and a
`--first-parent` variant. Reconstruction per `DiffChange`:

- `add` → `:000000 <newMode> 0×40 <newId> A\t<newPath>`
- `delete` → `:<oldMode> 000000 <oldId> 0×40 D\t<oldPath>`
- `modify` → `:<oldMode> <newMode> <oldId> <newId> M\t<path>`
- `type-change` → `… T\t<path>`
- `rename` → `:<mode> <mode> <id> <id> R100\t<oldPath>\t<newPath>` — tsgit detects
  **exact** renames only (same blob id), which git renders as `R100`; the test
  repo uses a plain `git mv` (no edit), so git also emits `R100`. Recursive diff
  yields only 6-digit blob modes (no `040000` trees), so modes need no padding.

The change array order is git's path-sorted tree-walk order (already pinned by
`show`/`diff` interop); a byte-equal assert catches any drift.

## Slice 4 — parity `test(whatchanged): cross-adapter parity scenario`

`test/parity/scenarios/whatchanged.scenario.ts` + register in
`scenarios/index.ts`. Seed a linear history with one rename and a branch+merge;
assert the emitted entries (ids, per-entry change counts/types, merge absent) are
identical on node / memory / browser. Keep the asserted shape small + adapter-
independent (counts + status letters, not oids that vary by content — oids are
fine, content is fixed).

## Slice 5 — docs + backlog `docs(whatchanged): command page, index, backlog`

- `docs/use/commands/whatchanged.md` — house page shape (Signature / Options /
  Behaviour / Examples / Throws / See also). Behaviour: structured-only, merges
  excluded, renames-on, first-parent diff, `--raw` is a caller projection (show a
  reconstruction snippet), limit counts emitted entries.
- `docs/use/commands/README.md` — add the `whatchanged` row (alphabetical, last)
  + bump "35 entries" → "36".
- `README.md` — bump "35 Tier-1 commands" → "36".
- `docs/BACKLOG.md` — flip `23.7` `[ ]` → `[x]` with the shipped-summary line.

`npm run validate`.

## Step 7 — architecture refactor (post-feature, separate commit)

Extract the shared "first-parent changes a commit introduced" diff (today private
in `show.ts` as `diffParentToTree`) into an internal helper both `show` and
`whatchanged` call — `refactor(diff): share commit-first-parent diff helper`.
Behaviour-preserving (show's diff unchanged); re-review the refactor diff; then
mutation.
