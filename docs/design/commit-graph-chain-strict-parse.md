# Commit-graph chain file: malformed-line family

## Context

Backlog 32.13 recorded, on git 2.55, that a `commit-graph-chain` with a blank line
mid-file makes git warn and refuse the chain while tsgit skipped the blank line and
loaded every layer. The parser it named was replaced when alternates landed: the
chain loader (`loadChain` in `src/application/primitives/internal/commit-graph-chain.ts`)
now follows git's `load_commit_graph_chain_fd_st` line by line and stops at the first
line that is not a hash.

## Re-pin on git 2.56.0

Two-layer chain (base: three commits, tip: one commit). Which layers git serves is
read from `git log --format=%T` after overwriting every root tree in both layer files:
a commit served from the graph prints the overwritten tree.

| Chain body | Warning on `log` / `rev-list` | Layers served | `commit-graph verify` |
|---|---|---|---|
| blank line first | `invalid commit-graph chain: line '' not a hash` | none | warning, exit 1 |
| blank line between the layers | same | base | warning + `error: one or more commit-graph chain files could not be loaded`, exit 1 |
| blank or whitespace line last | none | both | clean, exit 0 |
| whitespace-only line between the layers | `… line '   ' not a hash` | base | warning + error, exit 1 |
| CRLF endings, or a space after the first hash | `unable to find all commit-graph files` | none | warning, exit 1 |
| a third hash with no layer file | `unable to find all commit-graph files` | both | warning + error, exit 1 |
| empty file | none | none | clean, exit 0 |

`git fsck` prints the loader warning twice (the read side, then verify) and sets
bit 16 of its exit code exactly when `commit-graph verify` fails.

Two facts correct the backlog entry. git does not drop the whole chain: it serves
the layers loaded before the bad line. A trailing blank or whitespace line is never
read at all, because git reads `size / (hexsz + 1)` lines.

## tsgit on the same rows

tsgit at `45ad1d97` matches every row:

- `fsck` reports the same `chain-line-not-hash`, `chain-layer-missing` and
  `chain-incomplete` findings that `commit-graph verify` prints, with the same exit bit.
- The read side logs the same warning (the offending line travels in the logger
  context as `line`) and serves the same layer prefix.

No source change is needed.

## Change

Pin the family so a regression shows up as a red row:

1. `test/integration/fsck-commit-graph-interop.test.ts`: add the rows above to
   `CHAIN_ROWS`, compared against `git commit-graph verify`.
2. `test/integration/commit-graph-read-interop.test.ts`: one table compares tsgit's
   warnings and served commits to git's warnings and to the commits git serves from
   the graph, read with the root-tree overwrite above.
3. `test/unit/application/primitives/internal/commit-graph-chain.test.ts`: a blank
   first line, followed by a line long enough to be read, is the not-a-hash verdict
   and stops the walk before that line.

## Decision candidates

None. A refused chain is already structured data on `fsck` (its findings) and a logger
warning with context on the read side. git itself only reports it on stderr.
