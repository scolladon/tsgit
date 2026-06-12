# Mutation — tsgit override (Stryker; replaces the mutation Procedure body)

The engine preamble already probed the config and the engine invariants still bind
(run-lock, PR-waits-for-triage, docs-in-parallel, never destroy the worktree mid-run).

## Run

- **Line-range scoping is the default**: derive each file's contiguous changed regions
  from `git diff --no-ext-diff main...HEAD` and pass one `<file>:<start>-<end>` entry
  per region — the same file may appear several times. Widen to the whole file only
  when the diff blankets it (mostly-changed file, or a file-wide mechanical rename
  where ranges add noise). **Post-refactor runs scope whole files** (the refactor
  moved lines), with the triage step filtering survivors back to feature-changed
  logic.

```bash
./node_modules/.bin/stryker run --incremental \
  --mutate "src/a.ts:42-118,src/a.ts:300-340,src/b.ts"   # run in background + write run-lock
```

- ONE `--mutate` flag with a comma list — repeated flags override each other.
- **Always `--incremental`** — `stryker.config.json` wires
  `incrementalFile: reports/stryker-incremental.json` (gitignored, never committed),
  so the post-triage re-run only re-tests affected mutants. Inconsistent-looking
  results (stale kills, impossible survivors) → rebuild with `--force`.
- Never the full tree (intractable locally; the dry run also flakes on the
  compileGlob perf test).
- **Concurrency safety:** start the run only AFTER Stryker's sandbox copy completes;
  never run `npm install` in the worktree while the run executes.

## Triage (feeds forge:mutation-triager)

- Filter survivors/no-coverage to the diff's lines only — pre-existing-line survivors
  are out of scope.
- **vitest-4 false-survivor caveat** (stryker-js#5928): local Stryker under-reports
  kills — false survivors AND false NoCoverage. Before writing any kill test:
  hand-apply the mutant's replacement to the source, run the named unit test file
  (`npx vitest run <file>`), restore. A FAILING run proves the mutant is already
  killed — record it as a false survivor, no test needed. Only a genuinely passing
  run makes the survivor real. For deeper checks, the sandbox honours
  `__STRYKER_ACTIVE_MUTANT__`.
- Equivalent mutants: inline `// equivalent-mutant: <why>` with one line of proof —
  no central catalogue. Typical provable cases: loop bounds where out-of-bounds reads
  return `undefined` with identical outcome; search start offsets in homogeneous data.
- Kill-test patterns: assert error DATA (code/reason/value) not just the class —
  StringLiteral mutants survive type-only checks; isolated tests per guard condition
  in `if (A || B)`; try/catch + direct `.data` assertions over `toThrow(objectContaining)`.
- Commit kills as `test(mutation): <module>`; re-run `npm run validate`.

## CI

The `mutation` CI job is a real per-bucket budget gate (score counts timeouts +
survivors; app ≥95) but stays non-blocking at merge — the local triage above is the
gate. Avoid mutable-index loops; minimise equivalent guards.
