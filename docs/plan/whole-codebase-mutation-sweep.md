# Implementation plan — whole-codebase mutation sweep

Tests-only. Each part = one bucket swept as a series of partition runs through the
fixed protocol below, each partition landing as one atomic `test(mutation):
<module>` commit (or `chore(mutation): annotate equivalents in <module>` when a
partition yields only equivalence annotations). `npm run validate` green before
each commit.

**TDD framing (inverted):** a surviving mutant that survives the vitest-4
hand-verification filter is the **RED** (a hole in the test net); the targeted
kill test is the **GREEN**. A provably-equivalent survivor is neither red nor
green — it is annotated `// Stryker disable next-line <mutators>: equivalent —
<why>` with one line of proof (the suppressing convention).

## Fixed per-partition protocol (shared by every part)

1. **Run** — `./node_modules/.bin/stryker run --incremental --mutate
   "src/<part>/**/*.ts,!…/*.test.ts,!…/*.properties.test.ts,!…/index.ts,!…/*.d.ts"`
   (detached + poll; start only after the sandbox copy completes; no `npm install`
   mid-run).
2. **Collect** survivors + no-coverage from `reports/mutation/mutation-report.json`
   (file:line, mutatorName, replacement, source line); snapshot before the next
   run overwrites it.
3. **Filter (vitest-4, mandatory)** — for each survivor: hand-apply the
   replacement to the source, `npx vitest run <named-test-file>`, restore. FAILING
   run ⇒ false survivor (already killed), no test. PASSING run ⇒ real survivor.
4. **Resolve** — real survivor ⇒ kill test (error-DATA assertions, isolated guard
   tests, try/catch over `toThrow`, property lens where the four CLAUDE.md lenses
   fit). Provably-equivalent ⇒ suppressing `Stryker disable` annotation with proof.
   Genuine infinite-loop timeout ⇒ counted, tallied, never suppressed.
5. **Validate** — `npm run validate` green.
6. **Commit** — `test(mutation): <module>` (atomic, per module).

## Part 1 — domain bucket (break 99 → conservative raise)

### Context

The fixed per-partition protocol above, applied over `src/domain/`. Big subdirs
(own run): `diff` (2.2k) · `protocol` (1.7k) · `merge` · `archive` · `storage` ·
`objects` · `fsck` · `commands` · `range-diff`. Medium subdirs (own run): `refs`
· `git-index` · `attributes` · `notes` · `reflog` · `sparse` · `pathspec` ·
`ignore` · `bundle`. Small subdirs (grouped runs, ~5–8 files each): `name-rev`
(✓ validated — 2 pre-documented equivalents to convert to the suppressing form,
0 real) · `bisect` · `rebase` · `submodule` · `grep` · `snapshot` · `describe` ·
`commit` · `blame` · `sequencer` · `shortlog` · `repository` · `hooks` ·
`worktree` · domain root files. First grouped run
(storage/fsck/worktree/name-rev/repository) already landed — triage its report
first.

### TDD steps

Per the fixed protocol: each vitest-4-verified real survivor is the RED; the
targeted kill test is the GREEN; refactor step is the equivalence annotation
pass over provable survivors.

### Gate

`npm run validate` before each commit; targeted `npx vitest run <touched-tests>
&& npm run check:types && ./node_modules/.bin/biome check <touched-files>` per
fix batch.

### Commit

One `test(mutation): domain/<subdir>` (or `chore(mutation): annotate equivalents
in domain/<subdir>`) per partition.

## Part 2 — infra bucket (break 90)

### Context

The fixed per-partition protocol over `ports` (0.84k) · `operators` (0.22k) ·
`transport` (0.38k) · `progress.ts` — one or two grouped runs.

### TDD steps

Same inverted-TDD protocol as Part 1.

### Gate

Same gates as Part 1.

### Commit

One `test(mutation): <area>` commit per partition.

## Part 3 — adapters bucket (break 85; node + memory, browser excluded)

### Context

The fixed per-partition protocol over `adapters/node` (2.0k, bulk — split by
area) · `adapters/memory` (0.96k) · `adapters/snapshot-resolvers` ·
`adapter-detect.ts` and root adapter files. `adapters/browser` stays excluded
(e2e-only surface).

### TDD steps

Same inverted-TDD protocol as Part 1.

### Gate

Same gates as Part 1.

### Commit

One `test(mutation): adapters/<area>` commit per partition.

## Part 4 — application bucket (break 95 — largest, last)

### Context

The fixed per-partition protocol over `application/commands` (18.5k) and
`application/primitives` (14.7k), partitioned by subdir; the surface is walked
subdir-by-subdir, refined as reached.

### TDD steps

Same inverted-TDD protocol as Part 1.

### Gate

Same gates as Part 1.

### Commit

One `test(mutation): application/<subdir>` commit per partition.

## Close-out (after all buckets swept)

- Re-tighten `mutation-budgets.json` (conservative data-driven): raise
  `high`/`low` to the measured swept floor; raise each `break` with margin
  above the equivalent-mutant floor + CI noise. Justify every number in the PR
  body against measured survivor counts.
- Tick backlog entry; `npm run validate`; PR.
