---
subjects:
  - src/domain/ignore/matcher-stack.ts
  - src/application/primitives/internal/ignore-evaluator.ts
  - test/bench/ignore-leading-directory.bench.ts
---
# 1278 — The ignore session keeps one outcome per directory chain

- **Status:** accepted
- **Date:** 2026-11-26
- **Design:** docs/design/is-ignored-leading-directory.md (What implementation measured) · **Supersedes/Refines:** applies ADR-1273; refines ADR-1272 and ADR-1275

## Context

The session of ADR-1272 kept one verdict per directory and, for every path, walked the path's
leading directories twice: once to settle them, once to find the first excluded one. Each
entry of a walk therefore paid a string build, two lookups and an `await` per leading
directory.

Measured after the four plan parts landed, in one process, on 20 220 walked entries (200
directories, 100 files each, 40 root rules), median of 41 rounds, three runs, load 5:

| Tree | main's predicate | session as landed | one outcome per chain (prototype) |
|---|---|---|---|
| entries two levels deep | 24.3 to 26.7 ms | 33.3 to 37.5 ms, 1.37 to 1.41 times main | 21.1 to 23.1 ms, 0.87 times main |
| entries five levels deep | 33.5 to 38.9 ms | 52.5 to 63.2 ms, 1.57 to 1.63 times main | 23.4 to 26.8 ms, 0.69 times main |

The three variants gave the same count of ignored entries. The A/B run of the command benches
(best of three alternated rounds, main against the branch) read `status` on the 20 000-file
tree at 96.5 ms against 100.5 ms, inside its 10 % threshold; `add` and `stash` moved by less
than 4 % either way. The cost grows with depth, and the bench trees are shallow.

git keeps its exclude stack for the directory it is in and reuses it for every entry of that
directory (`prep_exclude` pops only what is not a prefix of the next path), so it pays the
leading directories once per directory, not once per entry.

## Options considered

1. **Keep one outcome per directory chain: a directory's outcome is its parent's when the
   parent's chain is excluded, else its own test; a path asks only its parent's outcome**
   (recommended).
2. Keep one verdict per directory, build the list of leading directories once per path and
   skip the `await` for a directory already judged.
3. Leave the session as landed: the command benches stay inside their threshold.

## Decision

**Adopted-as-recommended (no user judgment)** — ADR-1273, which the user ratified, has a
regression on the walk path fixed in this change, and the measurement above shows one.
Option 1.

The pure functions of ADR-1272 change shape with it: `parentDirectoryOf`, `chainExclusion`
(an excluded chain above decides, else `directoryExclusion`) and `matchBeneathChain` (the
chain's exclusion decides, else the full path) replace `leadingDirectoriesOf` and
`matchBeneathLeadingDirectories`. The session keeps one promise per directory and no second
map. The shared append-only stack of ADR-1275 is unchanged, and so is every verdict.

The bench pair of ADR-1273 is measured again on the new session, and its gate is set between
that ratio and the ratio of the session it replaces, which did the leading directories of
every entry again.

Refused: option 2 still pays per leading directory of every entry, and its skip is a branch no
test can tell apart. Option 3 ships a walk predicate about one and a half times dearer on a
deep tree.

## Consequences

### Positive

- The walk predicate costs less than main's in the measurement, at both depths.
- One lookup and one `await` per entry, whatever the depth.

### Negative

- The first question about a deep directory resolves its chain by recursion, one frame per
  leading directory.
- The unit rows and properties of the two replaced functions are rewritten over the new ones.
