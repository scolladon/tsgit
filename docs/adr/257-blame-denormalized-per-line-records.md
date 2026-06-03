# ADR-257: `blame` returns denormalized per-line authorship records

## Status

Accepted (at `33fa9f4f`)

## Context

Tier-1 `blame` returns, for each line of a file, the commit that last touched it
plus that commit's authorship. `git blame --porcelain` is itself a **normalized**
wire format: a commit-metadata block emitted once per commit (on first
occurrence) followed by a flat per-line list keyed `<sha> <orig> <final>
<count>`. The structured result must choose a shape:

- **A. Normalized** — `{ path, commits: Map<oid, BlameCommit>, lines: BlameLine[] }`.
  Metadata once per commit; each line references a commit oid. DRY; mirrors
  porcelain's own structure.
- **B. Denormalized per-line** — each `BlameLine` carries the full
  author / committer / summary / boundary / previous inline. A single flat array
  is the whole result; metadata repeats for every line of a same-commit run.
- **C. Porcelain-style groups** — `{ path, groups: BlameGroup[] }`, each group a
  commit plus its consecutive lines.

This is a structured-output shape decision (ADR-249's rule binds the data, not a
rendered line — none of the options render anything). The forces: per-line
consumption ergonomics (a caller iterating lines wants authorship in hand
without a second map lookup) versus duplication of commit metadata across long
runs of same-commit lines.

## Decision

Adopt **B — denormalized per-line records**. The result is a single flat array:

```ts
interface BlameLine {
  readonly finalLine: number;        // 1-based, position in the queried file
  readonly sourceLine: number;       // 1-based, position in the blamed commit's blob
  readonly commit: ObjectId;         // the blamed commit
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly summary: string;          // commit subject (first message line)
  readonly boundary: boolean;        // blamed commit is a root (no parents)
  readonly sourcePath: FilePath;     // path the file had in the blamed commit (rename-aware)
  readonly previous?: { readonly commit: ObjectId; readonly path: FilePath };
  readonly content: Uint8Array;      // the line's bytes (newline-terminated except a final no-LF line)
}

interface BlameResult {
  readonly path: FilePath;           // the queried path (final name)
  readonly lines: ReadonlyArray<BlameLine>;
}
```

Reconstructing `git blame --porcelain` from this is the caller's concern: group
consecutive equal `commit` oids, emit the metadata block on a group's first
occurrence (deduping is the renderer's job, from the per-line fields), and emit
`<commit> <sourceLine> <finalLine> <count>`.

## Consequences

### Positive

- Per-line ergonomics: a consumer maps `lines` straight to a rendered row or a UI
  gutter annotation with authorship already attached — no oid→metadata lookup.
- One flat array is the entire payload; `-L` filtering (ADR keeps range as a
  selector) is a plain `Array.filter` with no companion map to keep consistent.
- Reconstructs every porcelain field (the renderer dedups), so faithfulness
  pinning is unaffected by the shape choice.

### Negative

- Commit metadata is duplicated across every line of a same-commit run — larger
  in-memory result for files dominated by one commit. Accepted: blame results are
  bounded by file length, and the per-line records are shallow (identities are
  shared references, not deep copies).

### Neutral

- A caller wanting the normalized view builds it trivially
  (`new Map(lines.map(l => [l.commit, …]))`); the inverse (normalized → per-line)
  costs a lookup per line. Denormalized is the lower-friction default.
- `previous` is recorded per line but is stable per `(commit, sourcePath)` in v1
  (no `-C` line-copy detection), so all lines of a commit carry the same value.
