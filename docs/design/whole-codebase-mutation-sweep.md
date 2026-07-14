# Whole-codebase mutation sweep

## Goal & scope

Kill every *killable* mutant across the entire `src/` surface — not just the
per-PR touched files the CI mutation gate normally scopes. The per-PR gate proves
each change is well-tested at the moment it lands; it says nothing about files
that predate the gate or were only ever line-touched. This sweep closes that gap:
Stryker over the full tree, bucket by bucket, every survivor triaged to either a
targeted kill test or a documented provable-equivalence annotation.

**Behavior-preserving — tests only.** No `src/` production code changes except an
inline `// equivalent-mutant: <why>` comment where a survivor is provably
equivalent. The prime directive still binds: no kill test may assert non-faithful
behaviour; error-data assertions pin the exact codes/reasons git-faithful code
already produces.

**In scope:**

- The four budget buckets (`mutation-budgets.json`): `domain`, `application`,
  `adapters` (node + memory), `infra` (operators/transport/ports/progress).
- One PR accumulating all kill tests + equivalence annotations, organised by
  module so the diff stays navigable (`test(mutation): <module>` commits).
- Re-tightening the per-bucket CI `mutation-budgets.json` thresholds once the
  floor rises (see Threshold policy — the load-bearing decision).

**Out of scope (documented non-goals):**

- The `browser` adapter (`src/adapters/browser/**`) — excluded from Stryker's
  `mutate` config; its behaviour is e2e-only, not unit/mutation-reproducible.
- `index.ts` / `*.d.ts` barrels — excluded from `mutate`.
- Production behaviour changes of any kind (this is a test-hardening sweep).
- Lowering any existing threshold.

## Why not one full-tree run

The mutation override (`.claude/workflow/mutation.md`) is explicit: **never the
full tree** — it is intractable locally and the dry run flakes on the compileGlob
perf test. "Whole tree in one PR" therefore means *the union of tractable
sub-partition runs*, not one Stryker invocation. Each run is scoped to a
subdirectory (or a small group of them), `--incremental` so the accumulated
`reports/stryker-incremental.json` builds a full-tree picture across runs without
re-testing settled mutants.

## Run protocol (per partition)

```bash
./node_modules/.bin/stryker run --incremental \
  --mutate "src/<subdir>/**/*.ts,!src/<subdir>/**/*.test.ts,\
!src/<subdir>/**/*.properties.test.ts,!src/<subdir>/index.ts,\
!src/<subdir>/**/*.d.ts"
```

- **CLI `--mutate` replaces the config array**, so the negations for
  `index.ts` / test / `.d.ts` are re-stated per run.
- Run detached + poll (the sandbox reaps long foreground bash); start the run
  only after Stryker's sandbox copy completes; never `npm install` mid-run.
- Partition granularity: one subdir per run; group the many small domain subdirs
  (<300 LOC) so each run is meaningfully sized; split the large ones
  (`diff` 2.3k, `protocol` 1.85k, `merge`/`storage`/`objects`/`fsck` ~1.1–1.25k)
  onto their own runs.

## Triage protocol (per survivor)

The dominant cost, and why a mega-run is the wrong shape. For every survivor /
no-coverage Stryker reports:

1. **vitest-4 false-survivor filter (mandatory, first).** Local Stryker
   under-reports kills (stryker-js#5928 — false survivors *and* false
   NoCoverage). Before writing any test: hand-apply the mutant's replacement to
   the source, run the named unit test file (`npx vitest run <file>`), restore.
   A **failing** run proves the mutant is already killed → record as a false
   survivor, **no test written**. Only a genuinely **passing** run makes the
   survivor real.
2. **Real survivor → kill test.** Per the CLAUDE.md mutation-resistant patterns:
   assert error DATA (code/reason/value), not just the class (StringLiteral
   mutants survive type-only checks); isolated tests per guard condition in
   `if (A || B)`; try/catch + direct `.data` assertions over
   `toThrow(objectContaining)`. Same `describe`/`it`/AAA/`sut` conventions.
3. **Provably-equivalent → inline annotation.** `// equivalent-mutant: <why>`
   with one line of proof, no central catalogue. Typical provable cases: loop
   bounds where out-of-bounds reads return `undefined` with identical outcome;
   search start offsets in homogeneous data; observationally-inert guards.
   Equivalence proofs are **structure-specific** — never carry one forward across
   a data-structure change without re-proving against the new distinguishing path.
4. **Property-test lens.** When a survivor sits in a parser/decoder/matcher and
   the four CLAUDE.md lenses fit, a `*.properties.test.ts` sibling may kill a
   *family* of mutants an example test can't enumerate — prefer it there.

## Bucket order

`domain` → `infra` + `adapters` → `application`. Domain first: purest
(zero-dependency), strictest target (break 99), most tractable. Application last:
largest surface (33.6k LOC), least tractable, done once the protocol is proven.

## Threshold policy (load-bearing decision — for the ADR conversation)

The backlog says "re-tighten the per-bucket CI mutation thresholds once the sweep
lands and the floor rises." Two frictions make this non-trivial:

- **CI mutation is per-PR-scoped** (changed files only) and non-blocking. The
  threshold is checked against whatever subset a future PR touches, not the whole
  bucket. A high `break` + a small PR that touches one equivalent-mutant line
  fails the gate (one survivor tanks a small denominator).
- **Local whole-bucket scores are untrustworthy** (vitest-4 under-reporting), so
  we cannot read a reliable post-sweep whole-bucket ceiling locally. The only
  trustworthy score is CI's, which is per-PR-scoped.

The achievable whole-bucket ceiling after the sweep is
`(total − #equivalent-mutants) / total` (all real survivors killed; equivalents
still count against Stryker's score). Candidate policies:

- **(A) Data-driven, conservative** — raise `high`/`low` to reflect the swept
  state; raise `break` only to a value with clear margin above the
  equivalent-mutant floor + CI noise. Recommended.
- **(B) low/high only** — raise `low`/`high`, leave every `break` untouched
  (zero added risk of future false-fails; the sweep quality is the deliverable,
  the gate stays as-is).
- **(C) Defer** — land the kill tests now, open a follow-up to tighten thresholds
  once several post-sweep CI runs have measured the real per-PR distribution.

## Decisions (accepted)

1. **Scope realisation** — "whole tree, one PR" executed as the union of
   tractable per-subdir `--incremental` runs (not one full-tree invocation),
   reconciling the user's scope choice with the override's "never full tree".
   → ADR 492.
2. **Threshold-tightening policy** — **(A) data-driven conservative**: raise
   `high`/`low` to the measured swept floor; raise each `break` only to a value
   with clear margin above the equivalent-mutant floor + CI noise; never breach
   what a single equivalent mutant on a small future PR could. → ADR 493.
