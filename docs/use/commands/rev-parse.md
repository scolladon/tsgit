# `revParse`

Resolve a revision expression to an `ObjectId`. Accepts ref names, oids (full or short), `HEAD`, `@{N}`, `@{date}`, `<ref>~N`, `<ref>^`, `<ref>^N`.

## Signature

```ts
repo.revParse(expression: string): Promise<ObjectId>;
```

## Supported syntax

| Form | Example | Resolves to |
|---|---|---|
| Ref name | `main` | tip of branch |
| Symbolic ref | `HEAD` | current branch tip |
| Tag | `v1.0.0` | tag's target (peeled) |
| Full oid | `9f86d08...` | the oid itself |
| Short oid | `9f86d08` | the unambiguous oid (`REVPARSE_AMBIGUOUS` on collision) |
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
const head = await repo.revParse('HEAD');
const oldHead = await repo.revParse('HEAD@{1}');
const beforeRelease = await repo.revParse('v1.0.0~5');
const second = await repo.revParse('main^2');
```

## Throws

- `REVPARSE_UNRESOLVED` — name does not resolve, or `@{date}` form unparseable.
- `REVPARSE_AMBIGUOUS` — short oid matches multiple objects.
- `REFLOG_ENTRY_OUT_OF_RANGE` — `@{N}` beyond the reflog length.

## See also

- Primitives: [`resolveRef`](../primitives/resolve-ref.md), [`readReflogLenient`](../primitives/internals.md#readrefloglenient)
- Related commands: [`log`](log.md), [`reflog`](reflog.md), [`checkout`](checkout.md)
