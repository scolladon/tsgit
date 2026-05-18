# Phase 13.4a — Implementation plan

Derived from `docs/design/phase-13-4a-merge-clean-tree-walk.md`. TDD
discipline: write tests first, watch them fail, then green.

## Step order

### 1. `flattenTree` primitive — DONE

Already shipped earlier in this PR before the workflow rewind:

- `src/application/primitives/flatten-tree.ts`
- `test/unit/application/primitives/flatten-tree.test.ts` (5 tests, all
  pass)

The primitive walks a tree and produces a `FlatTree` map.

### 2. Extend `MERGE_HAS_CONFLICTS` error — DONE

Already shipped: added `paths: ReadonlyArray<FilePath>` to
`MERGE_HAS_CONFLICTS` data; factory takes `paths` as optional second
arg defaulting to `[]`. Two new tests in `error.test.ts` (default
paths + explicit paths variant). Existing single-arg call sites still
compile.

### 3. Write merge-command tests (RED)

`test/unit/application/commands/merge.test.ts` extension. Three new
tests under TDD:

- **Clean merge — non-conflicting paths**: HEAD has `a.txt`. They
  add `b.txt`. Base is the common ancestor. After merge, the resulting
  commit's tree contains BOTH `a.txt` AND `b.txt`. Assert the merged
  tree id is NOT `ourTree` (proves we synthesised, not fell back).
- **Clean merge — same-file modifications on different lines** (if
  in scope; defer to a follow-up sub-test if line-merge fixture is
  heavy): assert merged content includes BOTH ours and theirs.
- **Conflicting merge — same file, divergent content** throws
  `MERGE_HAS_CONFLICTS` with `data.paths` listing the conflicting
  path.

These tests should FAIL against the current `merge.ts` (which still
writes HEAD's tree).

Commit: `test(merge): clean-merge tree walk + conflict throw (RED)`.

### 4. Reimplement `merge.ts` (GREEN)

Restore the implementation that:

- Reads ourTree / theirTree / baseTree.
- Flattens via `flattenTree`.
- Calls `mergeTrees(base, ours, theirs, contentMerger)`.
- On clean: synthesises merged tree via a local `writeNestedTree`
  helper; uses that tree in the commit.
- On conflict: throws `mergeHasConflicts(conflicts.length, paths)`.

Tests pass. Commit: `feat(merge): clean-merge tree walk wires mergeTrees`.

### 5. Reviews × 3 passes (each: code + perf + security + test)

Pass 1: parallel reviewers — code (typescript-reviewer), perf, security,
test-quality. Address every HIGH.

Pass 2: re-run code + perf + security + test on the fixes. Address.

Pass 3: final pass — code + perf + security + test. Address.

### 6. Harness green

`npm run validate` — 14 / 14. Stryker on touched files; document any
surviving mutants as `// equivalent-mutant` or kill them.

### 7. Docs + push + PR

- BACKLOG: keep §13.4 open (this is 13.4a only; 13.4b is conflict
  handling).
- README: don't add a row yet — wait until 13.4 is complete.
- MIGRATION: append the clean-merge example.
- Push and open PR.

## Risk gates

| Step | Risk | Mitigation |
|---|---|---|
| 3 | Test fixtures (commit-of-commit-of-blobs) are tedious to build | Lean on existing `seedTwoCommits`-style helpers in merge.test.ts |
| 4 | `mergeTrees` signature has `base` as optional FlatTree — flatten only when defined | Check existing test invocations for the contract |
| 4 | `writeNestedTree` reinvents synthesise — duplication smell | Documented inline; the variation is path-validation cost, not algorithm. If reuse becomes attractive in 13.4b, factor then. |
| 5 | Reviewers may flag the duplicate-tree-builder pattern | Cite design pass-3 note: synth runs path validation, our outcomes come from a parsed tree so paths are pre-validated; double validation is YAGNI |

## Self-review log

### Pass 1 → Pass 2

- Originally listed reviews as one pass × 4 reviewers. Project policy
  is reviews × 3 passes. Updated to "3 passes (each: 4 reviewers in
  parallel)".
- Step 3 listed only two tests; added the conflict-throw test
  explicitly because that's the acceptance-criterion test for the
  conflict half of 13.4a.

### Pass 2 → Pass 3

- Risk table added — pass-3 reviewers want explicit risk notes
  rather than implicit "I'll handle it".
- Step 4 explicit on the synth-vs-local choice; without that,
  pass-3 reviewers would ask "why not reuse synthesizeTreeFromIndex?"
  and the answer would arrive too late.

### Pass 3 → Pass 4 (final)

- Step 1 + Step 2 marked DONE explicitly so reviewers see they
  predate the workflow rewind and don't need redoing.
- Step 7 explicitly says BACKLOG stays OPEN (this is 13.4a, not
  full 13.4).
