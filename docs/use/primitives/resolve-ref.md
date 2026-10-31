# `resolveRef`

Resolve a ref name (or symbolic ref) to an `ObjectId`. Follows symbolic refs through `HEAD`.

## Signature

```ts
repo.primitives.resolveRef(name: RefName, options?: { peel?: boolean }): Promise<ObjectId>;
```

| Option | Default | Meaning |
|---|---|---|
| `peel` | `false` | If `true` and the target is an annotated tag, peel through the tag to its commit (or tree). |

## Example

```ts
const head = await repo.primitives.resolveRef('HEAD');
const tagCommit = await repo.primitives.resolveRef('refs/tags/v1.0.0', { peel: true });
```

## Unreadable refs

A loose ref the file system refuses as too long (`PATH_TOO_LONG`) reads as an
unreadable ref, with a cycle or a malformed file: git's `lstat` failing with an
errno other than `ENOENT`. Every resolution made for reading treats it as git's
NULL, so [`status`](../commands/status.md) reports such a HEAD as unknown and
initial. `resolveRef` itself still throws the fault.

## Loose ref bodies

A loose ref body is read under git's grammar. A symbolic ref is `ref:` followed
by any run of space, tab, CR or LF, then the referent; trailing whitespace is
stripped. A direct ref is a full-width object name (40 or 64 hex digits per the
repository's hash algorithm), upper or lower case, followed by the end of the
body or whitespace; bytes after that whitespace are accepted and ignored by
resolution ([`fsck`](../commands/fsck.md) reports them as `trailingRefContent`).
Anything else is unparseable.

Resolution through a directory the permissions refuse to search still throws
`PERMISSION_DENIED`; only the listing verbs skip such a directory.

## Throws

- `REF_NOT_FOUND` — name does not resolve.
- `INVALID_REF` — syntactically invalid.
- `PATH_TOO_LONG` — the loose ref's path exceeds what the file system allows.
- `PERMISSION_DENIED` — a directory on the loose ref's path cannot be searched.

## See also

- Tier-1: [`revParse`](../commands/rev-parse.md), [`branch`](../commands/branch.md)
- Related primitives: [`updateRef`](update-ref.md)
