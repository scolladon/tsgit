# `blame`

Line-by-line **authorship** for a file at a committed revision, faithful to
`git blame`. The history is walked backwards: for each suspect commit the file is
diffed against every parent; lines unchanged from a parent pass down to that
parent, and lines that differ from **all** parents (or reach a root commit) are
blamed there. The result is **structured data** — the library renders no
`^abc1234 (Author …)` or `--porcelain` text. Assembling that display from the
per-line fields is the caller's job, per the
[structured-output rule](../../adr/249-describe-structured-data-only.md).

## Signature

```ts
repo.blame(path: string, opts?: BlameOptions): Promise<BlameResult>;

interface BlameOptions {
  readonly rev?: string;                                  // commit-ish to blame as-of; default 'HEAD'
  readonly range?: { readonly start: number; readonly end: number }; // 1-based inclusive line window (git -L)
}

interface BlameResult {
  readonly path: FilePath;                  // the queried path (final name)
  readonly lines: ReadonlyArray<BlameLine>; // every reported line, in final-file order
}

interface BlameLine {
  readonly finalLine: number;               // 1-based line number in the queried file
  readonly sourceLine: number;              // 1-based line number in the blamed commit's version
  readonly commit: ObjectId;                // commit this line is blamed to
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly summary: string;                 // commit subject (first message line)
  readonly boundary: boolean;               // blamed commit is a root (no parents)
  readonly sourcePath: FilePath;            // path the file had in the blamed commit (rename-aware)
  readonly previous?: { readonly commit: ObjectId; readonly path: FilePath }; // parent the content came from
  readonly content: Uint8Array;             // the line's bytes (newline-terminated except a final no-LF line)
}
```

## Behaviour

- **Committed content:** blames `rev` (default `HEAD`); on a clean tree this
  equals `git blame -- <path>`. The working-tree "Not Committed Yet"
  pseudo-commit is **not** synthesised (a deliberate divergence,
  [ADR-258](../../adr/258-blame-targets-committed-rev.md)).
- **Denormalized per line:** each `BlameLine` carries its blamed commit's
  author / committer / summary / boundary / previous inline; the renderer dedups
  per-commit headers (`--porcelain`) from the per-line fields
  ([ADR-257](../../adr/257-blame-denormalized-per-line-records.md)).
- **Merges:** a line is blamed to the parent it is unchanged from; only lines
  differing from **every** parent stay on the merge.
- **Renames:** whole-file renames are followed by default — when the path is
  absent in a parent, the file is located under its previous name and
  `sourcePath` reflects it. Reuses exact-content rename detection, so a pure
  `git mv` is followed; a rename-with-edit in one commit is not (treated as a
  fresh introduction).
- **`range` (`-L`):** restricts the reported lines to a 1-based inclusive window;
  `end` past the last line is clamped. A start below 1, a start past the last
  line, an inverted range, or a non-integer bound refuses (`INVALID_OPTION`).
- **Refusals:** a path absent from `rev` refuses (`PATH_NOT_IN_TREE`).

## Examples

```ts
const { lines } = await repo.blame('src/index.ts');
// caller renders git's default line from the data:
for (const line of lines) {
  const sha = (line.boundary ? '^' : '') + line.commit.slice(0, 7);
  const text = new TextDecoder().decode(line.content).replace(/\n$/, '');
  console.log(`${sha} (${line.author.name} ${line.finalLine}) ${text}`);
}

await repo.blame('src/index.ts', { rev: 'v2.0' });               // as of a tag
await repo.blame('src/index.ts', { range: { start: 10, end: 20 } }); // -L 10,20
```

## See also

- Primitives: [`readObject`](../primitives/read-object.md), [`readBlob`](../primitives/read-blob.md), [`diffTrees`](../primitives/diff-trees.md)
- Related commands: [`log`](log.md), [`show`](show.md), [`diff`](diff.md)
- ADRs: [257](../../adr/257-blame-denormalized-per-line-records.md), [258](../../adr/258-blame-targets-committed-rev.md)
- Roadmap: Phase 23 — Inspection (v3)
