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
- Each queried path is parsed as `git check-ignore` parses an argument. The path is normalized: `.` and empty components drop, and `..` removes the component before it. The normalized path is the one judged, so `sub/../top.log` is judged as `top.log`. `path` in the result is the path as asked.
- An empty path is refused, as `git check-ignore` refuses it (`empty string is not a valid pathspec`): the call throws `EMPTY_PATHSPEC`, whatever the other queries are.
- A path that climbs above the repository root (`../x`, `sub/../../x`) is refused, as `git check-ignore` refuses it (`is outside repository`): the call throws `PATHSPEC_OUTSIDE_REPO`. So is an absolute path. git answers an absolute path that lies inside the work tree; `isIgnored` takes work-tree-relative paths only.
- A path that normalizes to the empty path (`.`, `sub/..`) names the work tree itself. Only a rule holding no slash at all can match it, as in git: it is ignored under `*` and not under `/*` or `*/`.
- A path whose leading directory is a symbolic link is refused, as `git check-ignore` refuses it (`pathspec '<path>' is beyond a symbolic link`): the call throws `PATHSPEC_BEYOND_SYMLINK`. The link may point anywhere, inside the repository or outside it, or at nothing. A link that is the last component of the path is answered like any other path. A leading directory the file system refuses to examine is not taken for a link.
- Every query is parsed before any is matched, after the global excludes file and `.git/info/exclude` are read and before any `.gitignore` is. A refused call reads no `.gitignore` and returns no partial result; the first refused query, in query order, decides the error.
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
- `EMPTY_PATHSPEC` — a queried path is empty. Nothing is answered.
- `PATHSPEC_OUTSIDE_REPO { path }` — a queried path climbs above the repository root, or is absolute. `path` is the query as asked. Nothing is answered.
- `PATHSPEC_BEYOND_SYMLINK { path }` — a leading directory of a queried path is a symbolic link. `path` is the query as asked. Nothing is answered.

## See also

- Related primitives: [`walkWorkingTree`](walk-working-tree.md)
- ADRs: [`ADR-163`](../../adr/163-is-ignored-detailed-match.md)
- Roadmap: Phase 20.2 — Standalone primitives
