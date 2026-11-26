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
- Each leading directory of a path is tested root-first, as a directory, against the rule files above it; the first one a rule excludes decides, as in git. The path is then ignored and `source` names that directory's rule, not a rule on the path itself.
- Nothing at or beneath an excluded directory is read: a negation beneath it, or a `.gitignore` inside it, cannot re-include the path. A `.gitignore` inside an excluded directory is never opened, so one that is oversized, unreadable or a directory cannot make the call throw.
- Rule files are read on demand: only the `.gitignore` files on the chain above the first excluded directory are opened.
- A leading directory is tested as a directory whatever stands at that path on disk. The query's own `isDirectory` is still the caller's declaration.
- `source.pattern` is the rule line as written, after git's trailing-space trim, with `!`, `/` and `\` escapes kept, as `git check-ignore -v` prints it.
- Patterns are git's wildmatch with `WM_PATHNAME` (`[…]` sets, `\` escapes, a byte-wise `?`), and matching honours `core.ignorecase` (ASCII case folding). A pattern git cannot parse matches nothing. In `.gitattributes`, a line whose pattern starts with `!` is ignored; write a literal leading `!` as `\!`.
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

With `build/` in the root `.gitignore`, `build/keep.js` is ignored and `source.pattern` is `build/`, even when `build/.gitignore` holds `!keep.js`.

## Throws

- `OPERATION_ABORTED` — `ctx.signal` is aborted at entry or between queries.

## See also

- Related primitives: [`walkWorkingTree`](walk-working-tree.md)
- ADRs: [`ADR-163`](../../adr/163-is-ignored-detailed-match.md)
- Roadmap: Phase 20.2 — Standalone primitives
