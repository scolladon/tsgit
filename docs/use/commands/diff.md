# `diff`

Compare two tree-like targets. Returns either a structured `TreeDiff`
(default) or the canonical unified-diff text plus the structured view
(opt in with `format: 'patch'`).

## Signature

```ts
type DiffFormat = 'tree' | 'patch';

interface DiffOptions {
  readonly from?: string;          // ref / oid / 'HEAD'; default 'HEAD'
  readonly to?: string;            // ref / oid; default empty tree
  readonly detectRenames?: boolean;
  readonly format?: DiffFormat;    // default 'tree'
  readonly contextLines?: number;  // patch only; default 3 (matches `git diff -U3`)
  readonly pathPrefix?: { readonly old: string; readonly new: string };
                                   // patch only; default { old: 'a/', new: 'b/' }
}

interface TreeDiff {
  readonly changes: ReadonlyArray<DiffChange>;
}

interface PatchResult {
  readonly format: 'patch';
  readonly text: string;           // canonical `git diff` text
  readonly diff: TreeDiff;         // structured view bundled alongside
}

repo.diff(opts?: DiffOptions & { format?: 'tree' }): Promise<TreeDiff>;
repo.diff(opts: DiffOptions & { format: 'patch' }): Promise<PatchResult>;
```

The TypeScript overloads narrow the return type per `format`: `repo.diff()`
returns `TreeDiff`; `repo.diff({ format: 'patch' })` returns `PatchResult`.

## Examples

```ts
// Structured diff — every entry shows as added (default).
const everything = await repo.diff();

// Diff two refs.
const incoming = await repo.diff({ from: 'main', to: 'feature/x' });

// Detect renames (off by default).
const withRenames = await repo.diff({ from: 'HEAD~1', detectRenames: true });

// Canonical unified-diff text — byte-identical to `git diff --no-ext-diff --no-color`.
const patch = await repo.diff({ from: 'HEAD~1', format: 'patch' });
console.log(patch.text);
// diff --git a/foo.txt b/foo.txt
// index 3367afd..3e75765 100644
// --- a/foo.txt
// +++ b/foo.txt
// @@ -1 +1 @@
// -old
// +new

// Custom hunk context and bare-path headers.
const compact = await repo.diff({
  format: 'patch',
  contextLines: 0,
  pathPrefix: { old: '', new: '' },
});
```

## Patch output guarantees

- Output matches `git diff --no-ext-diff --no-color` byte-for-byte on the
  shapes covered by the structured `DiffChange` union (add, delete, modify,
  rename, type-change). The integration suite double-pins this against both
  a live `git` invocation and a frozen golden fixture.
- OID abbreviation is hardcoded to 7 chars (matches git's `core.abbrev`
  default).
- Binary files render as `Binary files a/X and b/X differ`; the
  `--binary` (base85) form is not produced.
- Paths containing control characters (`\n`, `\r`, NUL) are rejected with
  `INVALID_DIFF_INPUT` — tree-object parsers accept these bytes in entry
  names, so the serializer enforces the safety check at the boundary.

## See also

- Primitives: [`diffTrees`](../primitives/diff-trees.md),
  [`walkTree`](../primitives/walk-tree.md),
  [`resolveRef`](../primitives/resolve-ref.md)
- Related commands: [`log`](log.md), [`status`](status.md)
- Design: `docs/design/phase-20-3-diff-patch-format.md`
- ADRs: 166 (serializer in domain) · 167 (format discriminator) · 168
  (canonical headers) · 169 (OID abbreviation + context defaults)
