# `whatchanged`

Walk reachable commits and pair each with the raw changes it introduced — git's
`git whatchanged` (the modern alias for `git log --raw --no-merges`). Returns
**structured data only**: each entry reuses [`log`](log.md)'s commit projection
plus a `TreeDiff` of the changes against the first parent (root: against the
empty tree). Merge commits are excluded from the output. The `--raw` line
rendering (`:<mode> <mode> <sha> <sha> <status>\t<path>`) is a caller projection
(see [Behaviour](#behaviour)).

## Signature

```ts
repo.whatchanged(opts?: WhatchangedOptions): Promise<ReadonlyArray<WhatchangedEntry>>;

type LogOrder = 'date' | 'first-parent';

interface WhatchangedOptions {
  readonly rev?: string;                       // commit-ish start, full grammar; default 'HEAD'
  readonly order?: LogOrder;                    // walk order; default 'date'
  readonly limit?: number;                      // cap on emitted entries (git -n)
  readonly excluding?: ReadonlyArray<string>;   // negative range stops (git's A..B / ^X)
  readonly before?: Date;                       // only commits with committer time < before
}

interface WhatchangedEntry extends LogEntry {   // id, tree, parents, author, committer, message
  readonly changes: TreeDiff;                   // raw changes vs first parent (root: vs empty tree)
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `rev` | `string` | `'HEAD'` | Commit-ish to start the walk from; resolved through the full rev grammar (`~`/`^`/`@{…}`/oid-prefix/annotated-tag peel). |
| `order` | `'date' \| 'first-parent'` | `'date'` | `'date'` walks every reachable commit across all parents, newest committer-date first (git's default); `'first-parent'` follows only the first parent (`git log --first-parent`). |
| `limit` | `number` | _none_ | Stop after this many **emitted** entries (git's `-n`). Excluded merges never consume a slot. |
| `excluding` | `ReadonlyArray<string>` | `[]` | Commit-ish stops removed from the walk — git's `A..B` / `^X` negative ranges. |
| `before` | `Date` | _none_ | Keep only commits whose `committer.timestamp` is strictly before this instant. |

## Behaviour

- **Merges are excluded.** Commits with two or more parents are filtered from the
  output (git's `--no-merges` default), but still traversed for reachability — so
  commits on a merged side branch still appear. Per-parent / combined merge diffs
  (`-m` / `-c`) are not offered here; use [`show`](show.md) for those.
- **First-parent diff.** Each entry's `changes` is the `TreeDiff` of the commit's
  tree against its first parent's tree; a root commit diffs against the empty
  tree (its full add-set). An empty commit yields `{ changes: [] }`.
- **Rename detection is on** (git's `diff.renames` default): a rename surfaces as
  one `rename` change, not a delete + add — both exact (R100) and content-similarity
  (git's default ≥50%) renames. This matches [`show`](show.md) and diverges from
  [`diff`](diff.md)'s opt-in.
- **Raw paths are recursive** — nested files surface as full-path changes, never
  a single sub-tree entry.
- **`message` is the raw commit message** (with its trailing newline), identical
  to [`log`](log.md) — no subject folding.
- **Caller projection — the `--raw` line.** The library ships structured changes,
  not rendering. Reconstruct git's raw line per change:

  ```ts
  const ZERO_OID = '0'.repeat(40);
  // similarity → git's two-digit-padded integer percent (R100, R087, C072, …)
  const pct = (s) => String(Math.trunc((s.score * 100) / s.maxScore)).padStart(3, '0');
  const rawLine = (c) => {
    switch (c.type) {
      case 'add':    return `:000000 ${c.newMode} ${ZERO_OID} ${c.newId} A\t${c.newPath}`;
      case 'delete': return `:${c.oldMode} 000000 ${c.oldId} ${ZERO_OID} D\t${c.oldPath}`;
      case 'modify': return `:${c.oldMode} ${c.newMode} ${c.oldId} ${c.newId} M\t${c.path}`;
      case 'type-change': return `:${c.oldMode} ${c.newMode} ${c.oldId} ${c.newId} T\t${c.path}`;
      case 'rename': return `:${c.oldMode} ${c.newMode} ${c.oldId} ${c.newId} R${pct(c.similarity)}\t${c.oldPath}\t${c.newPath}`;
      case 'copy':   return `:${c.oldMode} ${c.newMode} ${c.oldId} ${c.newId} C${pct(c.similarity)}\t${c.oldPath}\t${c.newPath}`;
    }
  };
  ```

  (A `rename`/`copy` carries both sides plus a `similarity` score; R100 is the
  exact-match special case where `similarity.score === maxScore`.)

## Examples

```ts
// Recent changes on the current branch, newest first
const entries = await repo.whatchanged({ limit: 10 });
for (const e of entries) {
  console.log(e.id, e.message.split('\n')[0]);
  for (const c of e.changes.changes) console.log('  ', c.type, c);
}

// Only the changes a feature branch adds over main, first-parent
const incoming = await repo.whatchanged({
  rev: 'feature/x',
  excluding: ['main'],
  order: 'first-parent',
});
```

## Throws

- `OBJECT_NOT_FOUND` / `INVALID_REF` — `rev` (or an `excluding` entry) does not
  resolve, including an unborn `HEAD`.

## See also

- Primitives: [`walkCommitsByDate`](../primitives/walk-commits-by-date.md)
- Related commands: [`log`](log.md), [`show`](show.md), [`diff`](diff.md)
