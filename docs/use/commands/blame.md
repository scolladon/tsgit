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
  readonly worktree?: boolean;                            // blame the working tree (git's bare `git blame`); mutually exclusive with rev
  readonly range?: { readonly start: number; readonly end: number }; // 1-based inclusive line window (git -L)
}

interface BlameResult {
  readonly path: FilePath;                  // the queried path (final name)
  readonly lines: ReadonlyArray<BlameLine>; // every reported line, in final-file order
}

// Fields shared by every line, committed or not.
interface BlameLineBase {
  readonly finalLine: number;               // 1-based line number in the queried file
  readonly sourceLine: number;              // 1-based line number in the originating blob
  readonly sourcePath: FilePath;            // path the file had in the originating version (rename-aware)
  readonly previous?: { readonly commit: ObjectId; readonly path: FilePath }; // where the committed base lives
  readonly content: Uint8Array;             // the line's bytes (newline-terminated except a final no-LF line)
}

interface CommittedBlameLine extends BlameLineBase {
  readonly committed: true;
  readonly commit: ObjectId;                // commit this line is blamed to
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly summary: string;                 // commit subject (first message line)
  readonly boundary: boolean;               // blamed commit is a root (no parents)
}

// git's zero-oid "Not Committed Yet" pseudo-commit. The library emits none of
// git's fabricated oid / identity / timestamp / summary — `committed: false`
// signals it; the caller reconstructs the display (see below).
interface UncommittedBlameLine extends BlameLineBase {
  readonly committed: false;
}

type BlameLine = CommittedBlameLine | UncommittedBlameLine;
```

## Behaviour

- **Committed content (default):** blames `rev` (default `HEAD`); on a clean tree
  this equals `git blame -- <path>`. Omitting `rev` keeps the committed-rev
  semantics ([ADR-258](../../adr/258-blame-targets-committed-rev.md)) — it does
  **not** silently switch to the worktree.
- **Working tree (`worktree: true`):** git's bare `git blame <path>`
  ([ADR-270](../../adr/270-blame-worktree-explicit-opt-in.md)). Lines matching the
  committed history blame to their real commits; **uncommitted** lines (modified,
  or in a staged-but-never-committed file) blame to git's zero-oid "Not Committed
  Yet" pseudo-commit, reported as `committed: false`
  ([ADR-271](../../adr/271-blame-uncommitted-line-discriminated-union.md)). The
  library emits none of git's fabricated `00000000` / `Not Committed Yet` /
  current-time / `Version of <p> from <p>` — reconstruct them from `committed:
  false` (see the example). Mutually exclusive with `rev` (`INVALID_OPTION`).
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
- **Refusals:** a path absent from `rev` refuses (`PATH_NOT_IN_TREE`). In
  `worktree` mode, an untracked path (in neither HEAD nor the index) refuses
  `PATH_NOT_IN_TREE`, a tracked path missing from disk refuses
  `WORKTREE_FILE_ABSENT`, an unborn HEAD refuses `REF_NOT_FOUND`, and a path
  escaping the repository (`..`, absolute, `.git`) refuses `PATHSPEC_OUTSIDE_REPO`.

## Examples

```ts
const { lines } = await repo.blame('src/index.ts');
// caller renders git's default line from the data, narrowing on `committed`:
for (const line of lines) {
  const text = new TextDecoder().decode(line.content).replace(/\n$/, '');
  const sha = line.committed
    ? (line.boundary ? '^' : '') + line.commit.slice(0, 7)
    : '00000000'; // the "Not Committed Yet" pseudo-commit
  const who = line.committed ? line.author.name : 'Not Committed Yet';
  console.log(`${sha} (${who} ${line.finalLine}) ${text}`);
}

await repo.blame('src/index.ts', { rev: 'v2.0' });                   // as of a tag
await repo.blame('src/index.ts', { range: { start: 10, end: 20 } }); // -L 10,20
await repo.blame('src/index.ts', { worktree: true });                // bare `git blame` (uncommitted lines → committed: false)
```

## See also

- Primitives: [`readObject`](../primitives/read-object.md), [`readBlob`](../primitives/read-blob.md), [`diffTrees`](../primitives/diff-trees.md)
- Related commands: [`log`](log.md), [`show`](show.md), [`diff`](diff.md)
- ADRs: [257](../../adr/257-blame-denormalized-per-line-records.md), [258](../../adr/258-blame-targets-committed-rev.md)
- Roadmap: Phase 23 — Inspection (v3)
