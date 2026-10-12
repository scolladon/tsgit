# `objectSources`

List the object stores the repository reads — its own `objects/` directory first, then every usable alternate — and the alternates it listed but could not use. An unusable alternate is skipped and reported here; a read never fails because of it.

## Signature

```ts
repo.primitives.objectSources(): Promise<ObjectSourcesView>;

interface ObjectSourcesView {
  readonly sources: ReadonlyArray<{ readonly objectsDir: string; readonly local: boolean }>;
  readonly unusable: ReadonlyArray<AlternateDiagnostic>;
}

interface AlternateDiagnostic {
  readonly reason:
    | 'unresolvable'
    | 'not-a-directory'
    | 'unreadable-list'
    | 'nesting-too-deep'
    | 'unreachable';
  readonly path: string;     // the alternate (or objects dir) the diagnostic is about
  readonly listedIn: string; // the objects dir whose `info/alternates` named it
  readonly code?: string;    // adapter error code, when one explains the reason
}
```

`local` is `true` for the repository's own object directory only.

## The five reasons

| `reason` | Meaning | What git prints |
| --- | --- | --- |
| `unresolvable` | The listed path cannot be canonicalised (a missing intermediate component, `ENOTDIR`, …). | `error: unable to normalize alternate object path: <path>` |
| `not-a-directory` | The path resolves but is not a directory (missing leaf, regular file). | `error: object directory <path> does not exist; check .git/objects/info/alternates` |
| `unreadable-list` | `info/alternates` exists but cannot be read (`EACCES`, `EISDIR`). A missing file is silent. | `warning: unable to access '<file>': Permission denied` |
| `nesting-too-deep` | The holder sits at alternate depth 5, so its own alternates are ignored. | `error: <objects dir>: ignoring alternate object stores, nesting too deep` |
| `unreachable` | The adapter cannot reach the path at all (outside its confinement). tsgit-specific; git has no equivalent. | — |

The library renders none of these messages; building them from `reason` and `path` is the caller's job.

## Example

```ts
const { sources, unusable } = await repo.primitives.objectSources();

for (const { objectsDir, local } of sources) {
  console.log(local ? 'local' : 'alternate', objectsDir);
}
for (const { reason, path, listedIn } of unusable) {
  console.warn(`${reason}: ${path} (listed in ${listedIn})`);
}
```

## See also

- Related primitive: [`readObject`](read-object.md) — reads from every source listed here.
