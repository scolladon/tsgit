# `bundle`

Package and inspect git objects in a transportable bundle file — the structured
equivalent of `git bundle`. Exposed as a nested namespace: `repo.bundle.create`,
`repo.bundle.verify`, and `repo.bundle.listHeads`.

**Through-line:** `create` is the producer — it returns bytes plus structured
metadata; the caller writes those bytes wherever it likes (no path argument).
`verify` and `listHeads` are consumers — they take a `{ path }` and the library
opens the file itself through `ctx.fs`. This split mirrors the `archive`
producer-returns-bytes convention (ADR-422, ADR-428).

## Signature

```ts
repo.bundle.create(opts: BundleCreateOptions): Promise<BundleCreateResult>;
repo.bundle.verify(input: BundleVerifyInput): Promise<BundleVerifyResult>;
repo.bundle.listHeads(input: BundleListHeadsInput): Promise<BundleListHeadsResult>;

// --- create ---

type BundleRevArg =
  | { readonly tip: string }
  | { readonly exclude: string }
  | { readonly range: readonly [string, string] }
  | { readonly symmetricRange: readonly [string, string] };

interface BundleCreateOptions {
  readonly revs?: ReadonlyArray<BundleRevArg>;
  readonly all?: boolean;
  readonly branches?: boolean;
  readonly tags?: boolean;
}

interface BundleCreateResult {
  readonly version:       BundleVersion;              // always 2
  readonly bytes:         Uint8Array;                 // header ++ packfile
  readonly refs:          ReadonlyArray<BundleRef>;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>; // oid-sorted
  readonly objectCount:   number;
  readonly packSha:       string;
}

interface BundleRef {
  readonly oid:  ObjectId;
  readonly name: RefName;
}

interface BundlePrerequisite {
  readonly oid:     ObjectId;
  readonly comment: string;  // first subject line of the boundary commit
}

// --- verify ---

interface BundleVerifyInput {
  readonly path: string;
}

interface BundleVerifyResult {
  readonly version:               BundleVersion;
  readonly hashAlgorithm:         BundleHashAlgorithm;   // 'sha1'
  readonly refs:                  ReadonlyArray<BundleRef>;
  readonly prerequisites:         ReadonlyArray<BundlePrerequisite>;
  readonly missingPrerequisites:  ReadonlyArray<ObjectId>;
  readonly prerequisitesPresent:  boolean;
  readonly recordsCompleteHistory: boolean;
}

// --- listHeads ---

interface BundleListHeadsInput {
  readonly path:   string;
  readonly names?: ReadonlyArray<RefName>;  // exact full-name filter; omit = all
}

interface BundleListHeadsResult {
  readonly version: BundleVersion;
  readonly refs:    ReadonlyArray<BundleRef>;
}
```

## Actions

### `create`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `revs` | `ReadonlyArray<BundleRevArg>` | `undefined` | Per-rev selection list (see Rev grammar below). |
| `all` | `boolean` | `undefined` | Include every `refs/*` ref sorted by full name, then `HEAD` last. |
| `branches` | `boolean` | `undefined` | Include every `refs/heads/*` ref sorted by full name. |
| `tags` | `boolean` | `undefined` | Include every `refs/tags/*` ref sorted by full name. |

**Rev grammar** (field shapes inside `BundleRevArg`):

| Shape | Equivalent git syntax | Effect |
|---|---|---|
| `{ tip: 'main' }` | `main` | Include the ref (or bare rev) and add it to the pack. |
| `{ exclude: 'main~2' }` | `^main~2` | Exclude commits reachable from this rev. |
| `{ range: ['A', 'B'] }` | `A..B` | Equivalent to `{ tip: 'B', exclude: 'A' }`. |
| `{ symmetricRange: ['A', 'B'] }` | `A...B` | Includes both tips; prerequisites = merge-base frontier. |

At least one `{ tip }` or pseudo-ref flag (`all`/`branches`/`tags`) must resolve
to a named ref — `create` throws `BUNDLE_EMPTY` `reason: 'no-refs'` otherwise
(bare-rev-only tips produce no ref lines).

### `verify`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | `string` | (required) | Filesystem path to the `.bundle` file. |

Reads the bundle header **and** performs a full embedded-pack parse (inflate
every entry + verify the pack trailer). Missing prerequisites are surfaced in
`missingPrerequisites` — this is not a thrown error (use `prerequisitesPresent`
to gate an unbundle).

### `listHeads`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | `string` | (required) | Filesystem path to the `.bundle` file. |
| `names` | `ReadonlyArray<RefName>` | `undefined` | Exact full-name filter (e.g. `['refs/tags/v1.0']`). Omit to return all. |

Header-only — the pack is never read. Filtering is exact full-name string
equality: `'refs/tags/v1.0'` matches; `'v1.0'`, `'tags/v1.0'`, and `'main'`
do not.

## Behaviour

- **Version 2 only.** `create` always produces a v2 bundle. `verify` and
  `listHeads` read v2; a `# v3 git bundle` file throws `BUNDLE_UNSUPPORTED_VERSION`.
- **Ref ordering in `create`.** Explicit `{ tip }` / `{ range }` / `{ symmetricRange }`
  refs appear in argument order. `--all` emits `refs/*` sorted by full refname,
  `HEAD` last. `--branches` / `--tags` emit the matching subset sorted.
  Annotated tags carry the tag-object oid in the ref line (unpeeled, matching git).
- **Prerequisite ordering.** The `prerequisites` array in `BundleCreateResult` is
  sorted ascending by oid — matching the on-disk byte order.
- **Object closure.** `create` excludes every object reachable from prerequisites.
  A `{ range: ['A', 'B'] }` bundle excludes A's blobs and trees; only B's new
  objects are packed.
- **`verify` is a read-only query (ADR-425/CQS).** It does not import objects
  into the repository. Use `missingPrerequisites` to decide whether the bundle
  can be applied.
- **`create` returns bytes, not a path.** Write them wherever the caller prefers:

  ```ts
  import { writeFile } from 'node:fs/promises';
  const result = await repo.bundle.create({ all: true });
  await writeFile('/backup/repo.bundle', result.bytes);
  ```

## Examples

```ts
import { openRepository } from 'tsgit';

const repo = await openRepository({ cwd: '/path/to/repo' });

// Create a full-history bundle and write it to disk
const full = await repo.bundle.create({ all: true });
// full.bytes → Uint8Array; write it wherever the caller likes

// Incremental bundle: commits reachable from main but not from v1.0
const incremental = await repo.bundle.create({
  revs: [{ range: ['v1.0', 'main'] }],
});
// incremental.prerequisites contains the boundary commit(s)

// Three-dot symmetric range (diverged tips)
const sym = await repo.bundle.create({
  revs: [{ symmetricRange: ['main', 'feature'] }],
});

// Verify a bundle file (full pack parse + prerequisite presence check)
const verifyResult = await repo.bundle.verify({ path: '/backup/repo.bundle' });
console.log(verifyResult.prerequisitesPresent); // true — all prereqs found
console.log(verifyResult.recordsCompleteHistory); // true — no prerequisites
console.log(verifyResult.hashAlgorithm);  // 'sha1'

// List all refs in a bundle (header-only, no pack read)
const headsResult = await repo.bundle.listHeads({ path: '/backup/repo.bundle' });
for (const ref of headsResult.refs) {
  console.log(ref.name, ref.oid);
}

// Filter to a single ref by exact full name
const filtered = await repo.bundle.listHeads({
  path: '/backup/repo.bundle',
  names: ['refs/tags/v1.0'],
});
```

## Throws

### `create`

- `NOT_A_REPOSITORY` — outside a git repository.
- `BUNDLE_EMPTY` `reason: 'no-refs'` — no rev arg resolves to a named ref
  (no `--all`/`--branches`/`--tags` and no `{ tip }` DWIMs to a ref).
- `BUNDLE_EMPTY` `reason: 'no-objects'` — the rev selection yields an empty
  object set (e.g. `{ range: ['main', 'main'] }`).
- `REVPARSE_UNRESOLVED` / `REVPARSE_AMBIGUOUS` — a rev argument cannot be
  resolved (propagated from `revParse`).
- `PACK_TOO_LARGE` — the object closure exceeds the built-in object-count ceiling.

### `verify` and `listHeads`

- `BUNDLE_READ_FAILED` — the file cannot be opened or read (missing or unreadable).
- `BUNDLE_BAD_HEADER` — the file does not look like a v2 or v3 bundle (not a
  bundle file, or a directory path).
- `BUNDLE_UNSUPPORTED_VERSION` — the file is a v3 bundle (not yet supported).
- `INVALID_PACK_*` / `INVALID_DELTA` — (verify only) the embedded packfile is
  corrupt; thrown when a pack entry fails to inflate or the trailer is bad.

## See also

- Related commands: [`archive`](archive.md), [`catFile`](cat-file.md)
- Primitives: [`readObject`](../primitives/read-object.md), [`walkCommits`](../primitives/walk-commits.md)
- Errors: [`../errors.md`](../errors.md)
