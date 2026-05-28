# `isIgnored`

Per-path ignore lookup with rule provenance. Mirrors `git check-ignore -v`.

## Signature

```ts
repo.primitives.isIgnored(
  queries: ReadonlyArray<{ path: FilePath; isDirectory?: boolean }>,
): Promise<ReadonlyArray<IsIgnoredMatch>>;

interface IsIgnoredMatch {
  readonly path: FilePath;
  readonly ignored: boolean;
  readonly source?: {
    readonly kind: 'global' | 'info' | 'gitignore';
    readonly basedir: FilePath | '';
    readonly line: number;
    readonly pattern: string;
  };
}
```

## Behaviour

- One result per input, in input order.
- `source` is populated only when `ignored === true` (matches `git check-ignore -v`'s output rule). A negated rule (`!keep.log`) makes the path NOT ignored and omits `source`.
- `kind` distinguishes the three sources whose `basedir` is the empty string at the repo root: global excludes file, `.git/info/exclude`, and the repo-root `.gitignore`.
- Per-directory `.gitignore` files are loaded lazily — only those on the ancestor chain of a queried path are read.
- `isDirectory` defaults to `false`; pass `true` to match directory-only rules like `build/`.

## Example

```ts
const matches = await repo.primitives.isIgnored([
  { path: 'logs/app.log' as FilePath },
  { path: 'src/index.ts' as FilePath },
]);
for (const m of matches) {
  if (m.ignored) console.log(`${m.path} — ignored by ${m.source?.pattern}`);
}
```

## Throws

- `OPERATION_ABORTED` — `ctx.signal` is aborted at entry or between queries.

## See also

- Related primitives: [`walkWorkingTree`](walk-working-tree.md)
- ADRs: [`ADR-163`](../../adr/163-is-ignored-detailed-match.md)
- Roadmap: Phase 20.2 — Standalone primitives
