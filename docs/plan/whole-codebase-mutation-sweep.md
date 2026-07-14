# Implementation plan — whole-codebase mutation sweep

Tests-only. Each part = one partition run through the fixed protocol, landing as
one atomic `test(mutation): <module>` commit (or `chore(mutation): annotate
equivalents in <module>` when a part yields only equivalence annotations).
`npm run validate` green before each commit.

**TDD framing (inverted):** a surviving mutant that survives the vitest-4
hand-verification filter is the **RED** (a hole in the test net); the targeted
kill test is the **GREEN**. A provably-equivalent survivor is neither red nor
green — it is annotated `// equivalent-mutant: <why>` with one line of proof.

## Fixed per-part protocol (context block for every part)

1. **Run** — `./node_modules/.bin/stryker run --incremental --mutate
   "src/<part>/**/*.ts,!…/*.test.ts,!…/*.properties.test.ts,!…/index.ts,!…/*.d.ts"`
   (detached + poll; start only after the sandbox copy completes; no `npm install`
   mid-run).
2. **Collect** survivors + no-coverage from `reports/mutation/mutation-report.json`
   (file:line, mutatorName, replacement, source line).
3. **Filter (vitest-4, mandatory)** — for each survivor: hand-apply the
   replacement to the source, `npx vitest run <named-test-file>`, restore. FAILING
   run ⇒ false survivor (already killed), no test. PASSING run ⇒ real survivor.
4. **Resolve** — real survivor ⇒ kill test (error-DATA assertions, isolated guard
   tests, try/catch over `toThrow`, property lens where the four CLAUDE.md lenses
   fit). Provably-equivalent ⇒ inline `// equivalent-mutant:` annotation.
5. **Validate** — `npm run validate` green.
6. **Commit** — `test(mutation): <module>` (atomic, per module).

## Part order — domain bucket (break 99 → conservative raise)

Big subdirs (own run): `diff` · `protocol` · `merge` · `archive` · `storage` ·
`objects` · `fsck` · `commands` · `range-diff`.
Medium subdirs (own run): `refs` · `git-index` · `attributes` · `notes` ·
`reflog` · `sparse` · `pathspec` · `ignore` · `bundle`.
Small subdirs (grouped runs, ~5–8 files each): `name-rev` (✓ validated — 2
pre-documented equivalents, 0 real) · `bisect` · `rebase` · `submodule` · `grep`
· `snapshot` · `describe` · `commit` · `blame` · `sequencer` · `shortlog` ·
`repository` · `hooks` · `worktree` · domain root files.

## Part order — infra bucket (break 90)

`ports` (0.88k) · `operators` (0.23k) · `transport` (0.4k) · `progress.ts` —
one or two grouped runs.

## Part order — adapters bucket (break 85; node + memory, browser excluded)

`adapters/node` (bulk) split by area · `adapters/memory` · `adapter-detect.ts`.

## Part order — application bucket (break 95 — largest, last)

`application/commands` and `application/primitives`, partitioned by subdir; the
33.6k-LOC surface is walked subdir-by-subdir, refined as reached.

## Close-out (after all buckets swept)

- Re-tighten `mutation-budgets.json` per ADR 493 (conservative data-driven):
  raise `high`/`low` to the measured swept floor; raise each `break` with margin
  above the equivalent-mutant floor + CI noise. Justify every number in the PR
  body against measured survivor counts.
- Tick backlog 26.12; `npm run validate`; PR.
