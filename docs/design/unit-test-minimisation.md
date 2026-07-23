# Unit test minimisation — one `it('Then …')` per distinct behaviour

## Goal & scope

Reduce the unit tier to **one `it('Then …')` per distinct behaviour** without
losing a single coverage line or resurrecting a single killed mutant. Two
mechanical moves do the reduction:

- **Collapse** tests that prove the *same behaviour with different inputs* into
  one parameterised `it.each`.
- **Delete** tests whose inputs and assertions are a *strict subset* of a test
  that remains.

Everything else is **kept verbatim**. The outcome bar is unchanged from `main`:
100% line/branch/function/statement coverage AND only provably-equivalent
mutants surviving (documented inline per the existing `// Stryker disable
next-line … equivalent` convention). Intention-revealing GWT titles are
preserved — the parameterised form keeps a distinct `Then` per case.

**Baseline dependency.** `main` already meets this bar: the 26.12 whole-codebase
mutation sweep (`docs/design/whole-codebase-mutation-sweep.md`) killed every
killable mutant across `src/`, leaving only documented-equivalent survivors, and
`test:coverage` is green at 100%. This work therefore *preserves* an already-met
outcome; it never has to *establish* it. "Preserve" has a concrete referent (§3),
which is what makes proof-by-construction sufficient.

**Scope (user decision, non-negotiable):** the whole unit tier in ONE PR —
`test/unit/**/*.test.ts`. 484 files, ~208k LOC, ~8.8k `it()` blocks. The
methodology below is **mechanical and repeatable** so it scales across all 484
files and partitions cleanly for the plan phase.

Per-subtree magnitude (files / LOC / `it`), and whether the subtree's production
code is inside the **coverage `include` set** (`vitest.config.ts` — the reliable
local guard, see §3.3):

| Subtree (`test/unit/`) | files | LOC | `it` | coverage-gated src? |
|---|---:|---:|---:|---|
| `application/` | 217 | 122k | 4896 | **no** (mutation-only guard) |
| `domain/` | 195 | 64k | 2945 | **yes** |
| `adapters/` (node + memory) | 34 | 13k | 528 | **yes** |
| `operators/` | 13 | 2.4k | 130 | **yes** |
| `repository/` | 11 | 3k | 164 | **no** (`src/repository.ts` excluded) |
| `transport/` | 3 | 1.4k | 74 | **no** |
| `ports/` | 2 | 0.3k | 17 | **yes** |
| `api-surface/` | 2 | 0.2k | 6 | **no** |
| root `test/unit/*.test.ts` | 7 | — | — | mixed |

~38 unit files already use `it.each`/`test.each` — the target pattern is not
new to this codebase; `test/unit/domain/attributes/conflict-marker-size.test.ts`
is the canonical exemplar (§2).

## The invariant: behaviour-preserving, tests only

**No `src/` change.** This is a pure test-suite refactor. Production code, object
SHAs, ref/reflog contents, on-disk state files, refusal conditions and message
formats are untouched, so the git-faithfulness prime directive (ADR-226) is
unaffected by construction. Each kept/collapsed test must still assert the
**exact same observable git behaviour** it asserts today — minimisation may
never weaken a faithfulness assertion (never swap an error-data assertion for a
bare-class `toThrow`, never drop a byte-exact `toEqual` for a shape check). No
new git behaviour is pinned here, so the empirical-pinning procedure
(`.claude/workflow/faithfulness.md`) does not apply; interop/parity suites live
outside `test/unit/**` and are out of scope entirely.

The property we must preserve across every edit is therefore precise:

> **The multiset of executed `(Arrange → Act → Assert)` triples the unit suite
> runs does not shrink, and no assertion is weakened.**

Coverage-preservation and mutation-kill-preservation both follow from that one
property (§3). It is the spine of the whole methodology.

## Why the outcome bar cannot be freshly *measured* (and what we do instead)

The outcome bar names two guarantees. Only one is locally measurable:

- **Coverage — measurable and reliable.** `npm run test:coverage` runs `vitest
  run --project unit --coverage` and enforces 100% on
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**` (`index.ts` /
  `*.d.ts` excluded). It aggregates the *whole* unit suite, so a dropped test
  that removed a line's last executor fails the gate. This is our primary
  backstop for the coverage-gated subtrees.

- **Mutation — NOT freshly measurable here.** Two independently-verified facts:
  1. **CI mutation is zero-signal for a test-only PR.** The PR mutation job
     (`tooling/run-stryker-pr.ts` ← `.github/scripts/compute-mutation-scope.sh`)
     scopes Stryker to the diff filtered by `grep -E '^src/.*\.ts$'` — **changed
     test files are excluded outright**. A test-only PR yields an empty
     mutate-list ⇒ `run-stryker-pr` prints "No src/ files … skipping mutation"
     and exits 0. The CI mutation gate audits *nothing* for this PR.
  2. **Local whole-tree/bucket Stryker under-reports and is non-deterministic**
     (stryker-js#5928; `.claude/workflow/mutation.md`). A raw before/after
     killed-count delta is untrustworthy — false survivors *and* false
     NoCoverage flip run-to-run.

Therefore "only provably-equivalent mutants surviving" is preserved **by
construction, not by measurement** (§3), audited by coverage plus *targeted*
hand-verification of the specific mutants at risk. This is the load-bearing
tension resolution — see Decision 1.

## 1. Operational classification — KEEP / COLLAPSE / DELETE

Apply this decision procedure to every `it()` under one `describe('When …')`.
Define, for a test `T`, its **acts** (the SUT call(s) in the Act section) and its
**oracle** (the `expect(…)` assertion *expression*, ignoring the row literals —
e.g. `expect(parseCapabilities(x)).toEqual(y)` has oracle
`parse → toEqual array`). Its **distinguishing inputs** are the concrete
argument/state literals that make this row differ from its siblings.

```
For each group of it() blocks that share ONE act under a common — or
unifiable (§2) — Given+When:

  (a) KEEP verbatim
      if the test's act OR oracle differs from every sibling
      (different SUT called, or a structurally different expect expression),
      OR the test isolates a guard / boundary that no other kept test isolates.

  (b) COLLAPSE into one it.each
      if 3+ siblings share the SAME act AND the SAME oracle SHAPE, differing
      only in the row literals (inputs and/or expected).
      The it.each row matrix MUST be the UNION of every sibling's distinguishing
      inputs and expected oracles — no input dropped, no assertion weakened.

  (c) DELETE
      if T's (inputs × assertions) is a STRICT SUBSET of a single retained
      test R: every argument/state T exercises, R also exercises, AND every
      assertion T makes, R also makes (same oracle, same expected). Removing T
      removes no unique triple.
```

**"Same behaviour, different input" precisely** = *identical act and identical
oracle shape*; only the literals move into the table. **"Distinct behaviour"** =
a different SUT call, a structurally different `expect` expression, or a
guard/boundary that must stay isolated (§3). Two tests that share an oracle
shape but assert *different named properties* (e.g. ordering vs de-duplication)
are still collapsible — but their per-row `Then` must keep the semantic label
(use object-rows, §2).

**"Strict subset" precisely** = set containment in *both* dimensions (inputs and
assertions) against **one** retained test. If T asserts even one thing R does
not, T is **not** a subset — KEEP T, or *relocate* T's extra assertion into R's
row and then delete T (relocation into a retained row is part of a legal delete,
not a new test — no new `it()` appears). Two tests that merely *overlap* (each
has a unique input) are never a delete — they are a **collapse** over the union.

### Worked example — COLLAPSE (real: `config-read.test.ts`, `[core] bare`)

Three adjacent blocks share act `readConfig` and oracle `parsed.core.bare ===
expected`, differing only by the config value:

```
// BEFORE — 3 blocks (bare=true→true, bare=false→false, bare=invalid→false)
describe('Given a config with [core] bare=true', () => {
  describe('When readConfig', () => {
    it('Then parsed.core.bare is true', async () => { /* … expect(...).toBe(true) */ });
  });
});
// …bare=false → false … ; …bare=invalid (unparseable) → defaults to false …
```

```
// AFTER — one it.each; the invalid→false GUARD row is preserved (union rule)
describe('Given a config with a [core] bare value', () => {
  describe('When readConfig', () => {
    it.each([
      { value: 'true',    expected: true,  then: 'parsed.core.bare is true' },
      { value: 'false',   expected: false, then: 'parsed.core.bare is false' },
      { value: 'invalid', expected: false, then: 'an unparseable boolean defaults to false' },
    ])('Then $then', async ({ value, expected }) => {
      // Arrange
      const sut = await writeConfig(`[core]\n\tbare = ${value}\n`);
      // Act
      const result = await readConfig(sut);
      // Assert
      expect(result.parsed.core?.bare).toBe(expected);
    });
  });
});
```

The `invalid → false` row keeps the unparseable-boolean guard as its own runtime
case (§3). Dropping it would be an illegal collapse — that literal is the only
input that kills the "parse boolean" mutants on the guard.

### Worked example — canonical AFTER shape (real, already shipped)

`test/unit/domain/attributes/conflict-marker-size.test.ts` is the reference
shape — copy it. Note: distinct **Given** per behaviour *class* (positive int /
non-positive-or-unparseable / non-valued), a homogeneous `it.each` inside each:

```
describe('Given a positive integer value', () => {
  describe('When resolved', () => {
    it.each([
      ['7', 7], ['1', 1], ['70', 70], ['+5', 5], ['00008', 8], ['2147483647', 2147483647],
    ])('Then `%s` yields %i', (raw, expected) => {
      // Arrange
      const sut: AttributeValue = { set: raw };
      // Act
      const result = resolveMarkerSize(sut);
      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

The three `describe('Given …')` blocks are **not** merged — each exercises a
distinct branch class, so they stay distinct even where two assert the same
default (`7`). That is the KEEP-vs-COLLAPSE line drawn correctly.

### Worked example — COLLAPSE preserving a semantic label (`parseCapabilities`)

Five `parseCapabilities` tests share oracle `parse(x) toEqual y` but each
documents a *named* property (ordering / key=value retention / empty / whitespace
/ dedup). A printf `%j` title would dump the input and lose the label; use an
object-row `then` field so the `Then` stays intention-revealing:

```
it.each([
  { tail: 'multi_ack_detailed side-band-64k ofs-delta', expected: ['multi_ack_detailed','side-band-64k','ofs-delta'], then: 'returns the tokens in order' },
  { tail: 'agent=git/2.43 thin-pack',                    expected: ['agent=git/2.43','thin-pack'],                     then: 'keeps key=value entries as full tokens' },
  { tail: '',                                            expected: [],                                                 then: 'returns [] for an empty tail' },
  { tail: '  side-band-64k  ofs-delta  ',                expected: ['side-band-64k','ofs-delta'],                      then: 'drops extra-whitespace empties' },
  { tail: 'side-band-64k side-band-64k',                 expected: ['side-band-64k'],                                  then: 'de-duplicates a repeated boolean cap' },
])('Then it $then', ({ tail, expected }) => { /* AAA, sut, toEqual */ });
```

### Worked example — DELETE (strict subset)

If a file has both `it('Then compileGlob("src") matches "src"')` asserting only
`{src→true, other→false}` **and** a later block asserting `{src→true,
src/foo→false, other→false, vendorsrc→false}`, the first is a strict subset of
the second (its two assertions are both present in the second) → **DELETE** the
first. If instead each block has a path the other lacks, neither is a subset →
**COLLAPSE** over the union of paths.

## 2. GWT discipline under `it.each` (machine-gated, not aspirational)

`check:test-pyramid` (in `npm run validate`, `tooling/audit-test-pyramid.ts`)
**gates** these per-unit-test heuristics — the collapsed shape must satisfy all
of them, which is exactly what "preserve intention-revealing titles" means here:

| Heuristic | Rule the collapsed form must keep |
|---|---|
| `gwtTitle` | `describe` titles match `^Given `/`^When `; the `it.each` title matches `^Then .+` — `'Then \`%s\` …'` and `'Then $then'` both pass |
| `aaaBody` | `// Arrange` and `// Assert` section comments present in the callback |
| `sutNaming` | binds `sut` (bans `subject`/`objectUnderTest`/`systemUnderTest`/`cut`) |
| `underAssertedUnit` | ≥1 `expect` per case (each expanded row is a real `it`) |
| `bareClassToThrow` | no `.toThrow(SomeClass)` — assert error `.data`, per case |

Canonical collapsed shape (the invariant all examples share):

```
describe('Given <shared context>', () => {          // Given: unchanged
  describe('When <the shared act>', () => {          // When: unchanged, one act
    it.each([ /* one row per distinguishing input, UNION of merged tests */ ])(
      'Then $then',                                  // or 'Then `%s` …' printf form
      (row) => {
        // Arrange   — build the SUT input from the row
        const sut = …;
        // Act       — the single shared act
        const result = …;
        // Assert     — the shared oracle, expected from the row
        expect(result)…;
      },
    );
  });
});
```

Because `vitest` expands `it.each` to **N independent `it()` runs**, each row is
a genuinely isolated test at runtime — this is what lets a collapse preserve
guard-isolation (§3). **`sut` binding is preserved exactly as the source file
uses it** — some files bind `sut` to the input/subject, others to the act's
result; minimisation does not relitigate that (only `sutNaming`'s banned list
matters).

**Collapse boundary — one accurate `Given` + one `When`.** The merged `describe`
context must be *truthful for every row* (one shared act, one oracle shape).
Sibling `Given` blocks **may** be unified into a single parameterised `Given`
when one accurate phrasing covers all rows (as the `[core] bare` example unifies
`bare=true`/`false`/`invalid` under "Given a config with a `[core] bare` value").
They **must stay separate** when they name **distinct behaviour classes** — as
`conflict-marker-size` keeps its positive-int / non-positive-or-unparseable /
non-valued `Given`s apart, even though two share the `7` default. If no single
truthful `Given`+`When` phrasing covers the candidate rows, do not collapse. See
Decision 4b.

## 3. Invariant-preservation proof obligation (per part)

### 3.1 Mutation-kill preservation — by construction (primary)

A mutant `M` is killed by the unit suite **iff at least one executed
`(Arrange→Act→Assert)` triple detects it**. The two moves preserve every triple:

- **COLLAPSE** relocates each sibling's Arrange/Act/Assert into a table row 1:1;
  `it.each` expands back to N independent runs ⇒ the multiset of executed triples
  is *identical* pre/post, **provided the matrix is the union of all
  distinguishing inputs and no oracle is weakened**. No killed mutant can
  resurrect.
- **DELETE** removes only triples that a retained test still executes (strict
  subset) ⇒ removes no *unique* triple. No killed mutant can resurrect.

Under this discipline, "only provably-equivalent mutants surviving" is a
**theorem**, not a measurement. The reviewer verifies the *discipline*
(matrix-is-union; delete-is-strict-subset; no weakened oracle), which is
locally checkable by reading the diff — not a Stryker score.

### 3.2 Guard-rails that make the construction sound

A collapse/delete is **illegal** (revert to KEEP) if any holds:

- It would **drop a distinguishing input** — every boundary value (min, max,
  each side of an off-by-one, empty, overflow) and every guard-triggering value
  is its own row. Collapsing boundaries into interior samples is forbidden.
- It would **merge two guard conditions into one row.** For `if (A || B)`, one
  input tripping both does not prove each guard alone (CLAUDE.md
  "Mutation-Resistant Test Patterns") — keep one row per guard condition.
- It would **weaken an error assertion** — merged error tests keep per-row
  expected `.data` (code/reason/value); never collapse to `toThrow(Class)`
  (also gated by `bareClassToThrow`). Prefer try/catch + direct `.data`
  assertions per row.
- It would **share mutable state across rows.** Each row's Arrange must be
  self-contained *inside the callback*, exactly as the original per-test Arrange
  was — never hoist a mutable fixture (temp dir, built repo, adapter instance)
  above the `it.each`. `it.each` rows run sequentially; hoisted mutable state
  bleeds between them, changing the executed triples and breaking isolation.
- The "subset" test asserts anything the retained test does not (§1).

`.skip` / `.todo` / `.fails` blocks execute no triples — they are left
**verbatim** (neither collapsed nor deleted); the pyramid detectors already
exempt them.

### 3.3 Coverage preservation — measured (backstop)

`npm run test:coverage` is the reliable mechanical guard. It stays at 100% for
the coverage-gated subtrees (`domain`, `ports`, `adapters/node`,
`adapters/memory`, `operators`). Because it aggregates the whole unit suite, it
also catches transitive loss — e.g. an `application/` test deleted in its
partition that was the *last* executor of a `domain/` branch fails the coverage
gate at that partition's checkpoint (§5). A coverage drop is a **necessary**
signal for many mutant resurrections (a mutant on a now-uncovered line
resurrects as NoCoverage); it is not *sufficient* (a mutant can resurrect while
the line stays covered if the distinguishing input was dropped) — §3.1 + §3.4
cover that gap.

### 3.4 Targeted hand-verification (backstop for risky edits)

For any collapse/delete the reviewer judges risky (touches a guard, boundary, or
error-data test), run the `.claude/workflow/mutation.md` triage tool **in
reverse** — as a preservation check:

1. Pick the specific mutant the dropped/merged input existed to kill.
2. Hand-apply that mutant's replacement to `src` (or set
   `__STRYKER_ACTIVE_MUTANT__` in the sandbox).
3. Run the collapsed test file: `npx vitest run <file>`.
4. Confirm it still **FAILS** (mutant still killed), then restore `src`.

The vitest-4 non-determinism is **harmless here**: hand-applying one mutant and
seeing the test fail is a positive, deterministic result — no reliance on
Stryker's aggregate counting. This is the only trustworthy mutation evidence
available for a test-only PR.

### 3.5 What we explicitly do NOT rely on

CI PR mutation (zero-signal, §"Why the outcome bar…") and a fresh local
whole-bucket Stryker score (under-reports, non-deterministic) are **not** proof
mechanisms. §3.1 construction + §3.3 coverage + §3.4 hand-verify are.

## 4. Property tests are out of scope

`*.properties.test.ts` files are **left byte-identical** — never deleted, never
collapsed, and never counted as a "retained test" that could make an example a
strict subset. ADR-136 is explicit: properties and examples are
non-substitutable (an example documents a literal Git on-disk encoding; a
property asserts a grammar invariant), and an example test is **never** deleted
because a property "covers" it. ADR-134 keeps them in sibling files, so they are
mechanically identifiable by suffix and simply skipped by this work.

## 5. Partitioning & ordering (for the plan phase)

**Granularity:** one **part per subsystem directory**, with **one part per file
for the giants** (a file that is itself a whole subsystem). Each part = one
atomic commit `test(unit): minimise <subtree-or-file>` that independently passes
the part gate.

Dedicated single-file parts (all >1.5k LOC):
`application/primitives/config-read.test.ts` (6990),
`application/primitives/update-config.test.ts` (6080),
`application/primitives/detect-similarity-renames.test.ts` (3854),
`domain/fsck/validate-object.test.ts` (3785),
`application/commands/merge.test.ts` (3701),
`adapters/node/node-file-system-injected.test.ts` (3175),
`domain/diff/patch-serializer.test.ts` (3098), plus the next tier
(`application/commands/{fsck,fetch,push,rebase}.test.ts`,
`domain/merge/three-way-tree.test.ts`, `application/commands/add.test.ts`).
Sub-1.5k files group by their immediate parent directory into one part, small
sibling dirs clustered to keep a part meaningfully sized (as the mutation sweep
grouped small `domain` subdirs).

**Ordering — coverage-gated tiers first (strongest backstop), application last:**

1. `domain/` (per-subdir parts + the giants) — purest, coverage-gated, strictest
   bar, most tractable; proves the methodology where the §3.3 backstop is
   strongest.
2. `operators/` + `ports/` + `adapters/` (node + memory) — small/mid,
   coverage-gated.
3. `repository/` + `transport/` + `api-surface/` + root files — small, not
   coverage-gated but tiny surface.
4. `application/` last (per-subdir parts + the giants) — largest (122k/4896),
   **not** coverage-gated for its own `src`, so it leans hardest on §3.1
   construction + §3.4 hand-verify; done once the discipline is proven on the
   coverage-guarded tiers. Its `test:coverage` checkpoint still guards *domain*
   coverage transitively.

This mirrors the whole-codebase-mutation-sweep bucket order (`domain` →
infra/adapters → `application`).

**Gates:**

- **Part gate** (every atomic commit):
  `npx vitest run <touched test files> && npm run check:types && biome check <touched files>`.
  Proves the collapsed/kept tests pass, typecheck, and lint.
- **Partition-boundary checkpoint** (after all parts in a subtree land, and once
  at the end via `npm run validate`): `npm run test:coverage`. Coverage is a
  union property only measurable by the full unit suite, so it belongs at
  boundaries; a drop localises to that partition's atomic parts (bisectable).
  `check:test-pyramid` (in `validate`) confirms the GWT/AAA/sut/assertion
  heuristics of §2 at the final gate. **Never commit on a red gate.**

The tier-ratio pyramid budget is **file-count based and warn-only**; minimisation
removes no files, so it is not at risk (a file must never be reduced to zero
tests — if every test in a file is a strict subset, that is a classification
error, re-examine).

## 6. Decision candidates (for the ADR conversation)

### Decision 1 — how to operationalise "only provably-equivalent mutants surviving"

Given CI mutation is zero-signal for a test-only PR and local Stryker
under-reports:

- **(A) Proof-by-construction + coverage backstop + targeted hand-verify**
  (§3). Mutation-kill preservation is a theorem from the union/strict-subset
  discipline; coverage catches the necessary NoCoverage signal; hand-verify the
  specific at-risk mutants deterministically. **← recommended.**
- **(B) Full local Stryker sweep per partition, before/after killed-count
  compare.** Cons: untrustworthy (vitest-4 non-determinism); a flaky delta can
  neither confirm nor deny a resurrection.
- **(C) Post-merge whole-tree sweep to confirm.** Cons: splits the guarantee
  out of the PR; defers detection past merge.

### Decision 2 — partition granularity + ordering

- **(A) Per-subsystem directory + per-file for the giants; order
  domain → operators/ports/adapters → small non-gated → application.** Balances
  atomic-commit reviewability against part count; puts the strongest backstop
  first. **← recommended.**
- **(B) Per-subtree (8 mega-parts).** Cons: giant, un-reviewable diffs; a
  coverage/hand-verify regression is hard to localise.
- **(C) Per-file uniformly (484 parts).** Cons: process overhead dominates;
  small sibling files each pay a full part gate for a handful of `it`.

### Decision 3 — standing ADR for the classification rules (ADR-498)?

- **(A) Yes — a test-methodology ADR (KEEP/COLLAPSE/DELETE decision procedure +
  guard-rails + proof-by-construction) that future 27.x items reuse.** 27.x is a
  series; the rules are load-bearing and reusable. **← recommended.**
- **(B) No — rules live only in this design doc.** Cons: 27.2+ re-derive or
  drift.
- **(C) Fold into an existing testing ADR.** Cons: none is about minimisation;
  dilutes both.

### Decision 4 — thresholds

- **4a. Minimum sibling count to justify a collapse:** 2 / **3** / 4.
  Recommend **3** — a 2→1 collapse saves little and can hurt readability; at 2,
  collapse only when the tests are mechanically identical modulo one literal,
  else KEEP.
- **4b. Collapse scope boundary:** rows must already share one `Given`+`When` /
  **rows must fit one *accurate* `Given`+`When`, unifying sibling `Given`s only
  when one truthful phrasing covers all rows** / arbitrary cross-describe
  collapse. Recommend the **middle** — permits the `[core] bare` unification
  while forbidding a misleading merged `describe`; distinct behaviour classes
  (à la `conflict-marker-size`) stay separate. One act per `it.each` regardless.
- **4c. Coverage checkpoint cadence:** per-part / **per-partition-boundary +
  final `validate`** / end-only. Recommend **per-partition-boundary + final** —
  full-suite coverage per part is redundant cost; boundary localises regressions
  to a partition's atomic commits.

## 7. Non-goals

- **No `src/` production change** (not even a comment) — this is tests-only.
- **No new tests** — minimisation only collapses/deletes/keeps existing ones. A
  genuine coverage or mutation *gap* discovered mid-work is a faithfulness/test
  defect, not this PR's job; surface it, do not paper over it with a new test
  smuggled into a minimisation commit.
- **No touching `*.properties.test.ts`** (§4), and no touching
  `test/integration/**`, `test/parity/**`, or `test/browser/**`.
- **No `sut`-semantics or AAA re-styling** beyond what a collapse mechanically
  requires — do not rename `sut`, re-order sections, or "improve" titles of kept
  tests.
- **No threshold or budget edits** (`mutation-budgets.json`,
  `test-pyramid-budgets.json`) — unlike the mutation sweep, this PR does not
  raise floors.
