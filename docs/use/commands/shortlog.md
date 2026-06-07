# `shortlog`

Summarise reachable commits grouped by author (or committer) identity — git's
`git shortlog`. Returns **structured data only**: per-identity-name groups, each
commit carrying `{ id, email, subject }` (git's cleaned shortlog oneline), oldest
first; groups byte-sorted by name. The `-e` / `-n` / `-s` renderings are caller
projections (see [Behaviour](#behaviour)).

## Signature

```ts
repo.shortlog(opts?: ShortlogOptions): Promise<ReadonlyArray<ShortlogGroup>>;

type ShortlogBy = 'author' | 'committer';

interface ShortlogOptions {
  readonly rev?: string;                       // commit-ish, full grammar; default 'HEAD'
  readonly excluding?: ReadonlyArray<string>;  // negative range stops (git's A..B / ^X)
  readonly by?: ShortlogBy;                     // grouping identity; default 'author'
}

interface ShortlogGroup {
  readonly name: string;                            // the chosen identity's name
  readonly commits: ReadonlyArray<ShortlogCommit>;  // oldest first
}

interface ShortlogCommit {
  readonly id: ObjectId;
  readonly email: string;   // the chosen identity's email (per commit)
  readonly subject: string; // git's cleaned shortlog oneline
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `rev` | `string` | `'HEAD'` | Commit-ish to start the walk from; resolved through the full rev grammar (`~`/`^`/`@{…}`/oid-prefix/annotated-tag peel). |
| `excluding` | `ReadonlyArray<string>` | `[]` | Commit-ish stops removed from the walk — git's `A..B` / `^X` negative ranges. |
| `by` | `'author' \| 'committer'` | `'author'` | Which identity keys the grouping (git's default vs `-c`). |

## Behaviour

- **Grouping key — name only.** Commits sharing the chosen identity's *name* merge
  into one group regardless of email (git's default); each commit keeps its own
  `email`. Grouping is case- and byte-sensitive (`Alice` ≠ `alice`).
- **Group order — byte-wise ascending by name** (git's `strcmp` over UTF-8 bytes,
  not JS UTF-16 sort).
- **Within a group — oldest first** (the reverse of the default `git log` walk).
- **Merges are included** (like `git log`).
- **Subject — git's cleaned oneline.** The leading paragraph is folded to one
  space-joined line (git's `%s`), then a leading `[PATCH…]` prefix is stripped
  through its first `]` (case-sensitive — `[BUGFIX]` / `[patch]` are kept). This
  is the defining `shortlog` datum; use [`log`](log.md) for the raw message.
- **Caller projections** (the library ships data, not rendering):
  - **`-s` (summary):** `group.commits.length`.
  - **`-n` (numbered):** re-sort groups by `commits.length` descending.
  - **`-e` (email):** re-partition each group by `commit.email`, then byte-sort the
    resulting `name <email>` sub-groups.
- **`.mailmap`** canonicalisation is not applied (no mailmap support yet); raw
  commit identities are used.

## Examples

```ts
// Contributor summary of the current branch (counts via group.commits.length)
const groups = await repo.shortlog();
for (const g of groups) console.log(`${g.name} (${g.commits.length})`);

// Group by committer instead of author
const byCommitter = await repo.shortlog({ by: 'committer' });

// Summarise a range: commits in `feature` not yet in `main`
const incoming = await repo.shortlog({ rev: 'feature/x', excluding: ['main'] });

// Reconstruct `shortlog -e`: split each name-group by email
const eGroups = (await repo.shortlog()).flatMap((g) => {
  const byEmail = new Map<string, typeof g.commits[number][]>();
  for (const c of g.commits) (byEmail.get(c.email) ?? byEmail.set(c.email, []).get(c.email)!).push(c);
  return [...byEmail].map(([email, commits]) => ({ name: g.name, email, commits }));
});
```

## Throws

- `OBJECT_NOT_FOUND` / `INVALID_REF` — `rev` (or an `excluding` entry) does not
  resolve, including an unborn `HEAD`.

## See also

- Primitives: [`walkCommitsByDate`](../primitives/walk-commits-by-date.md)
- Related commands: [`log`](log.md), [`describe`](describe.md)
