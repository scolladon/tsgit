# `archive`

Export the contents of a tree-ish as a structured entry stream — the data
equivalent of `git archive`. No tar/zip bytes are produced here; the library
returns paths, raw git modes, object ids, and blob bytes so that a caller or a
serializer (see `tarArchive` / `zipArchive`) can frame them in any container.

## Signature

```ts
repo.archive(opts: ArchiveOptions): Promise<ArchiveResult>;

interface ArchiveOptions {
  readonly treeish: string;
}

interface ArchiveResult {
  readonly tree:        ObjectId;             // resolved tree oid
  readonly commit?:     ObjectId;             // peeled commit oid; absent for bare tree
  readonly commitTime?: number;               // committer epoch seconds; absent for bare tree
  readonly entries:     AsyncIterable<ArchiveEntry>;
}

interface ArchiveEntry {
  readonly path:     FilePath;    // slash-joined repo-relative path
  readonly mode:     FileMode;    // raw git mode ('100644' | '100755' | '120000' | '40000' | '160000')
  readonly oid:      ObjectId;    // object id of this entry
  readonly content?: Uint8Array;  // blob bytes; absent for directory ('40000') and gitlink ('160000')
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `treeish` | `string` | (required) | Rev-parse expression — branch, tag, commit oid, tree oid, or any rev-grammar expression. |

## Behaviour

- **Raw modes.** `entry.mode` carries the verbatim git mode (`'100644'`, `'100755'`,
  `'120000'`, `'40000'`, `'160000'`). Rendering decisions (tar umask masking,
  zip external attributes) are left to the serializer or caller.
- **Directory and gitlink entries are emitted, content absent.** A directory
  (`mode = '40000'`) and a gitlink (`mode = '160000'`) entry is yielded with no
  `content` field. git archive emits the directory itself (before its contents)
  and the gitlink as an empty directory; it never recurses into submodules.
- **Pre-order traversal.** Directory entries appear before their contents,
  matching git's canonical on-disk tree-sort order.
- **Empty tree → empty stream.** A treeish whose root tree has no entries
  produces no entries; `result.commit` / `result.commitTime` are still set when
  the treeish is commit-ish.
- **Lazy blob hydration.** `entry.content` is read when the consumer calls
  `next()` on the async iterator — no whole-tree buffering.
- **Commit metadata.** When `treeish` resolves through a commit (direct or
  through an annotated tag), `result.commit` holds the peeled commit oid and
  `result.commitTime` holds the committer epoch seconds. Serializers use
  `commitTime` as the default archive entry mtime. Both are absent (`undefined`)
  when `treeish` is a raw tree oid.
- **Refusals match git** (thrown before the stream is opened):
  - Outside a repository → `NOT_A_REPOSITORY`.
  - Unresolvable treeish (unborn HEAD, bad ref) → from `revParse`.
  - Treeish resolves to a blob → `UNEXPECTED_OBJECT_TYPE`.

## Examples

```ts
import { openRepository } from 'tsgit';

const repo = await openRepository({ cwd: '/path/to/repo' });

// Stream entries from HEAD
const result = await repo.archive({ treeish: 'HEAD' });
for await (const entry of result.entries) {
  console.log(entry.mode, entry.path, entry.oid);
  if (entry.content !== undefined) {
    // blob bytes — write to disk, pass to a hasher, etc.
  }
}

// Consume only the first five entries
let count = 0;
for await (const entry of result.entries) {
  console.log(entry.path);
  if (++count === 5) break;
}

// Bare tree treeish — no commit metadata
const treeOid = await repo.primitives.resolveRef('HEAD^{tree}');
const treeResult = await repo.archive({ treeish: treeOid });
console.log(treeResult.commit);     // undefined
console.log(treeResult.commitTime); // undefined

// Annotated tag — peeled commit oid in result.commit
const tagResult = await repo.archive({ treeish: 'v1.0' });
console.log(tagResult.commit);     // <commit oid behind the tag>
console.log(tagResult.commitTime); // <committer epoch>
```

## Throws

- `NOT_A_REPOSITORY` — `cwd` (or `gitDir`) does not point inside a git repository.
- `OBJECT_NOT_FOUND` — `treeish` is an unresolvable ref name, an unborn HEAD, or an abbreviated oid that matches no object.
- `REVPARSE_UNRESOLVED` — `treeish` uses a reflog-selector form (`@{n}`, `@{date}`) that cannot be resolved (e.g. empty reflog).
- `UNEXPECTED_OBJECT_TYPE` — `treeish` resolves to a blob; only tree, commit, and tag are accepted.

## Serializers

`tarArchive` and `zipArchive` are pure functions that consume an `ArchiveResult` and yield `AsyncIterable<Uint8Array>` bytes byte-equal to `git archive --format=tar` and `git archive --format=zip` respectively. They are exported from the package and documented at [`../serializers/archive.md`](../serializers/archive.md).

```ts
import { tarArchive, zipArchive } from '@scolladon/tsgit';
```

## See also

- Serializers: [`tarArchive` / `zipArchive`](../serializers/archive.md)
- Primitives: [`walkTree`](../primitives/walk-tree.md), [`readBlob`](../primitives/read-blob.md), [`revParse`](rev-parse.md)
- Related commands: [`catFile`](cat-file.md), [`readFileAt`](read-file-at.md)
