# `revParse`

Resolve a revision argument to the revisions `git rev-parse` prints for it, in git's order. Accepts ref names, oids (full or short), `HEAD`, `@{N}`, `@{date}`, `<ref>~N`, `<ref>^`, `<ref>^N`, the range forms `A..B`, `A...B`, `^<rev>`, and the parent forms `X^@`, `X^!`, `X^-<n>`.

## Signature

```ts
repo.revParse(expression: string): Promise<readonly RevParseEntry[]>;

type RevParseEntry =
  | { readonly kind: 'object'; readonly id: ObjectId; readonly negated: boolean } // `negated`: git prints `^` before it
  | { readonly kind: 'path'; readonly path: string }; // no revision, but a path git prints unchanged
```

A plain name answers one entry. Rendering is the caller's: `git rev-parse`'s stdout is one line per entry, `^<id>` when `negated`, the path as given for a `path` entry.

## Paths

An argument that names no revision but reads as a pathspec (`f*`, `:(top)x`) or names an existing path answers `{ kind: 'path', path }` with the argument as given, as `git rev-parse` prints it. The path is looked up against the caller's directory in the worktree (`ctx.cwd`); `:/x` looks up `x` from the worktree top, `:!x` / `:^x` look up `x`, and a bare `:/`, `:!` or `:^` always names one.

## Ranges

| Argument | Entries, in order |
|---|---|
| `^A` | `^A` |
| `A..B` | `B`, `^A` |
| `..B` / `A..` | the empty side reads `HEAD` |
| `A...B` | `B`, `A`, then `^` each merge base, newest first |
| `X^@` | X's parents |
| `X^!` | `X`, then `^` each of its parents |
| `X^-<n>` / `X^-` | `X`, then `^` its n-th parent (`^-` is `^-1`) |

`X` keeps the id it was spelt as (a tag stays the tag), and its parents are the ones a shallow boundary leaves. Both range sides and `X` are read commit-ish: an abbreviated id shared by a commit and a non-commit names the commit. A side naming nothing — or, for `A...B` and the parent forms, one that is no commit, or `^-<n>` past the last parent — reads the whole argument as one name instead, which then refuses. A bare `..` is a path, never a range.

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
const [head] = await repo.revParse('HEAD');            // { kind: 'object', id, negated: false }
const [oldHead] = await repo.revParse('HEAD@{1}');
const [second] = await repo.revParse('main^2');
const range = await repo.revParse('v1.0.0..main');     // [{ kind: 'object', id: main }, { kind: 'object', id: v1.0.0, negated: true }]
const stdout = range
  .map((entry) => (entry.kind === 'path' ? entry.path : `${entry.negated ? '^' : ''}${entry.id}`))
  .join('\n');
const [file] = await repo.revParse('README.md');        // { kind: 'path', path: 'README.md' }
```

## Throws

A refusal reached after git has already printed lines carries them as `printed` in its error data (`OBJECT_NOT_FOUND`, `REVPARSE_UNRESOLVED`, `PATH_NOT_IN_TREE`): an argument naming neither a revision nor a path carries itself as a `path` entry, and a symmetric range with a side that is no commit carries both sides before it.

- `REVPARSE_UNRESOLVED` — name does not resolve, or `@{date}` form unparseable.
- `AMBIGUOUS_OID_PREFIX` — short oid matches multiple objects.
- `REFLOG_ENTRY_OUT_OF_RANGE` — `@{N}` beyond the reflog length.
- `CONFIG_BAD_NUMERIC_VALUE` — a malformed `core.maxTreeDepth` / `core.deltaBaseCacheLimit` (the repo-settings class), checked by an explicit call right after the operational gate and before the expression is parsed, transcribing git's own per-builtin prologue. See [`internals.md`](../primitives/internals.md#assertrepossettingsvalid).

## See also

- Primitives: [`resolveRef`](../primitives/resolve-ref.md), [`readReflogLenient`](../primitives/internals.md#readrefloglenient)
- Related commands: [`log`](log.md), [`reflog`](reflog.md), [`checkout`](checkout.md)
