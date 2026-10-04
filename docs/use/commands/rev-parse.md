# `revParse`

Resolve a revision argument to the revisions `git rev-parse` prints for it, in git's order. Accepts ref names, oids (full or short), `HEAD`, `@{N}`, `@{date}`, `<ref>~N`, `<ref>^`, `<ref>^N`, and the range forms `A..B`, `A...B`, `^<rev>`.

## Signature

```ts
repo.revParse(expression: string): Promise<readonly RevParseEntry[]>;

interface RevParseEntry {
  readonly id: ObjectId;
  readonly negated: boolean; // git prints `^` before it
}
```

A plain name answers one entry. Rendering is the caller's: `git rev-parse`'s stdout is one line per entry, `^<id>` when `negated`.

## Ranges

| Argument | Entries, in order |
|---|---|
| `^A` | `^A` |
| `A..B` | `B`, `^A` |
| `..B` / `A..` | the empty side reads `HEAD` |
| `A...B` | `B`, `A`, then `^` each merge base, newest first |

Both sides are read commit-ish: an abbreviated id shared by a commit and a non-commit names the commit. A side naming nothing — or, for `A...B`, a side that is no commit — reads the whole argument as one name instead, which then refuses. A bare `..` is a path, never a range.

## Supported syntax

| Form | Example | Resolves to |
|---|---|---|
| Ref name | `main` | tip of branch |
| Symbolic ref | `HEAD` | current branch tip |
| Tag | `v1.0.0` | tag's target (peeled) |
| Full oid | `9f86d08...` | the oid itself |
| Short oid | `9f86d08` | the unambiguous oid (`AMBIGUOUS_OID_PREFIX` on collision) |
| `@{N}` | `HEAD@{2}` | reflog entry N moves back |
| `@{date}` | `main@{yesterday}` | ref's value at the given date |
| `~N` | `main~3` | N first-parents back |
| `^` / `^N` | `main^2` | Nth parent (1-based) |
| Combined | `HEAD~3^2` | parent of the third ancestor |

## Behaviour

- **Lenient reflog reads.** `@{N}` and `@{date}` read the reflog leniently: a malformed line is skipped, and `@{N}`'s numbering counts only the surviving entries — matching git.
- **`@{date}` before the log begins** clamps to the oldest surviving entry's pre-state (`oldId`), or its post-state (`newId`) when that pre-state is the null id — the ref's creation entry — matching git.

## Examples

```ts
const [head] = await repo.revParse('HEAD');            // { id, negated: false }
const [oldHead] = await repo.revParse('HEAD@{1}');
const [second] = await repo.revParse('main^2');
const range = await repo.revParse('v1.0.0..main');     // [{ id: main }, { id: v1.0.0, negated: true }]
const stdout = range.map(({ id, negated }) => (negated ? `^${id}` : id)).join('\n');
```

## Throws

- `REVPARSE_UNRESOLVED` — name does not resolve, or `@{date}` form unparseable.
- `AMBIGUOUS_OID_PREFIX` — short oid matches multiple objects.
- `REFLOG_ENTRY_OUT_OF_RANGE` — `@{N}` beyond the reflog length.
- `CONFIG_BAD_NUMERIC_VALUE` — a malformed `core.maxTreeDepth` / `core.deltaBaseCacheLimit` (the repo-settings class), checked by an explicit call right after the operational gate and before the expression is parsed, transcribing git's own per-builtin prologue. See [`internals.md`](../primitives/internals.md#assertrepossettingsvalid).

## See also

- Primitives: [`resolveRef`](../primitives/resolve-ref.md), [`readReflogLenient`](../primitives/internals.md#readrefloglenient)
- Related commands: [`log`](log.md), [`reflog`](reflog.md), [`checkout`](checkout.md)
