# `readFileAt`

Read a file's **bytes as of a revision** — the structured equivalent of
`git show <rev>:<path>` / `git cat-file blob <rev>:<path>`. Collapses the
resolve → peel → descend → read dance into one call and guarantees the addressed
object is a **blob**, returning the file's content plus its tree-entry metadata
(oid + mode). The library renders nothing; the caller owns any display
([ADR-262](../../adr/262-read-file-at-command-surface.md)).

## Signature

```ts
repo.readFileAt(rev: string, path: string, options?: ReadObjectOptions): Promise<ReadFileAtResult>;

interface ReadFileAtResult {
  readonly id: ObjectId;        // the addressed blob's object id
  readonly mode: FileMode;      // 100644 | 100755 | 120000
  readonly content: Uint8Array; // the blob's raw, verbatim committed bytes
}

interface ReadObjectOptions {
  readonly verifyHash?: boolean; // re-check the blob's content hash
  readonly maxBytes?: number;    // cap the file read (OBJECT_TOO_LARGE when exceeded)
}
```

## Behaviour

- **Full rev grammar:** `rev` accepts any `revParse` expression — `HEAD`, a short
  branch/tag name (`main`, `v1.0`), navigation (`HEAD~3`, `dev^2`), an abbreviated
  oid, or a reflog selector (`@{yesterday}`). Resolution mirrors git's
  `<rev>:<path>` object name: resolve `rev`, peel to its root tree, descend
  `path`'s `/`-separated components to the addressed entry.
- **Committed content:** reads a committed revision only; the bytes equal
  `git cat-file blob <rev>:<path>`. The working-tree / index are out of scope
  (read those via `repo.snapshot.*`).
- **`mode`** is the file's tree-entry mode (`100644` regular, `100755`
  executable, `120000` symlink) — the same value `git ls-tree` reports. For a
  symlink the content is the link-target bytes.
- **`maxBytes`** bounds **only** the final blob read (the file), not the
  intermediate tree reads.
- **Refusals:**
  - a missing path component, or a non-tree used as an intermediate directory,
    refuses with `PATH_NOT_IN_TREE`;
  - a path addressing a **directory** (sub-tree) or a **gitlink** (submodule)
    refuses with `UNEXPECTED_OBJECT_TYPE` (`expected: 'blob'`) — as
    `git cat-file blob <rev>:<dir>` refuses;
  - an oversized read refuses with `OBJECT_TOO_LARGE`;
  - an unresolvable `rev` refuses with `REVPARSE_UNRESOLVED` / `AMBIGUOUS_OID_PREFIX`.

## Examples

```ts
const file = await repo.readFileAt('HEAD', 'src/index.ts');
const text = new TextDecoder().decode(file.content);

await repo.readFileAt('v2.0', 'README.md');                 // as of a tag
await repo.readFileAt('HEAD~3', 'src/index.ts');            // three commits back
await repo.readFileAt('HEAD', 'big.bin', { maxBytes: 1 << 20 }); // cap the read

const link = await repo.readFileAt('HEAD', 'link');
if (link.mode === '120000') {
  const target = new TextDecoder().decode(link.content);    // symlink target
}
```

## See also

- Primitives: [`readBlob`](../primitives/read-blob.md), [`readTree`](../primitives/read-tree.md), [`readObject`](../primitives/read-object.md)
- Related commands: [`show`](show.md), [`catFile`](cat-file.md), [`revParse`](rev-parse.md)
- ADRs: [262](../../adr/262-read-file-at-command-surface.md), [249](../../adr/249-describe-structured-data-only.md)
- Roadmap: Phase 23 — Inspection (v3)
