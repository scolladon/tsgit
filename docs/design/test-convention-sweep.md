# Test-convention conformance sweep — `sut`/`result`, AAA, GWT-with-zone-regrouping across all tiers

## Goal & scope

Align every legacy test file to the project **test convention** (CLAUDE.md
§Test Conventions) on **three axes**, without changing a single assertion. This
is a pure **conformance sweep**: naming and structure change, behaviour does
not. The proof of behaviour-preservation is a green `npm run validate`.

The three axes (all decided by the user; this doc designs the precise criteria):

1. **`sut` / `result` naming.** `sut` binds the *unit under test* (a function
   reference, a constructed object, or an operator instance); the *outcome* binds
   to `result`. The anti-pattern to fix: `const sut = <call>(…)` where `sut` then
   holds the outcome and is only read as data (`expect(sut…)`, `sut.field`).
2. **AAA body.** Every test body carries `// Arrange` / `// Act` / `// Assert`
   section markers, with the `sut` set up in Arrange, invoked in Act, and the
   `expect(…)` in Assert.
3. **GWT structure with zone regrouping.** `describe('Given …')` >
   `describe('When …')` > `it('Then …')`; the 2-level shortcut
   `describe('Given …, When …')` > `it('Then …')` is allowed only when a single
   expectation lives under the When. **Actively cluster** tests that share the
   same Given+When into one describe "zone" per subject+event — do not merely
   rename in place; regroup so each subject+event is one coherent zone with
   multiple `it('Then …')` leaves.

**North star (already-correct exemplar):** `test/unit/operators/map.test.ts` —
module wrapper `describe('map')` > `describe('Given …')` >
`describe('When sut is iterated')` > `it.each(…)('Then $label', …)`, with
`// Arrange`/`// Act`/`// Assert`, `const sut = map(mapper)` (the operator
instance — the unit under test), `const result = await toArray(sut(fromArray(input)))`.
Copy this shape.

**Scope (user decision, non-negotiable): the whole test surface in ONE PR** —
`test/**` across all tiers: unit, integration, parity, perf, runtime-parity, and
the `*.properties.test.ts` siblings (structure conformed, property bodies kept).
Tier magnitude and how many files carry the smell (heuristic scan for
`const sut = <call>(…)` followed by a `expect(sut…)` data-read — an over-count
that includes some legitimate factory cases, but directionally accurate):

| Tier / subtree | `.test.ts` files | files flagged (heuristic) |
|---|---:|---:|
| `test/unit/application/` | 217 | ~119 |
| `test/unit/domain/` | 195 | ~90 |
| `test/unit/adapters/` | 34 | ~11 |
| `test/unit/repository/` | 11 | ~5 |
| `test/unit/operators/` | 13 | ~4 |
| `test/unit/transport/` | 3 | ~3 |
| `test/unit/ports/` | 2 | ~2 |
| `test/unit/api-surface/` + root | ~9 | ~4 |
| `test/integration/` | 102 | ~27 |
| `test/parity/` | 2 | ~2 |
| `test/runtime-parity/` | 5 | ~3 |
| `*.properties.test.ts` (all tiers) | 68 | ~11 |

~281 files carry the smell to some degree — concentrated in the `unit`
`application` and `domain` subtrees. The per-file procedure (§4) is **mechanical
and repeatable** so it scales, and the batching plan (§5) partitions it into
atomic, reviewable commits.

## 1. The invariant: behaviour-preserving, tests only

**No `src/` change.** Production code, object SHAs, ref/reflog contents, on-disk
state files, refusal conditions and message formats are untouched, so the
git-faithfulness prime directive (ADR-226) is unaffected **by construction**. No
new git behaviour is pinned here, so the empirical-pinning procedure
(`.claude/workflow/faithfulness.md`) does not apply.

The property preserved across every edit is precise:

> **The set of `(Arrange → Act → Assert)` triples the suite executes, and the
> exact `expect(…)` each triple runs, is unchanged. Only the *names* bound
> (`sut`/`result`), the *section comments*, and the *describe/it nesting* move.**

A rename never changes what is asserted. A regroup never merges two distinct
Arrange/Act pairs. An added `// Act` marker never changes a statement. Because
`vitest` runs every `it()` regardless of its describe nesting, restructuring the
`describe` tree cannot change which tests run or what they assert — a green
`npm run validate` (which runs the whole suite plus `check:test-pyramid`) is
therefore a *sufficient* behaviour-preservation proof.

## 2. What the machine gate does — and does NOT — enforce

> **UPDATE (ADR-506 Decisions E/F, user-requested):** the gaps this section documents
> (axis-1 un-gated; only the unit tier gated) are **closed by the harness extension** —
> see §10. The description below is the *pre-extension* gate; the sweep conforms against it,
> then §10 extends it so all three axes are enforced on **every** tier going forward.

Pinned against the harness (`tooling/audit-test-pyramid.ts`,
`test-pyramid-budgets.json`). `check:test-pyramid` runs inside `npm run validate`
and gates these heuristics — **all scoped to `tier: 'unit'`**, all
`gating: true` (blocking):

| Heuristic | What it enforces | Axis it backstops |
|---|---|---|
| `gwtTitle` | `describe` titles `^Given `/`^When `; `it` titles `^Then .+` | Axis 3 (titles only) |
| `aaaBody` | markers **`Arrange` + `Assert`** present (NOT `Act`) | Axis 2 (partial) |
| `emptyAaaSection` | a *present* marker whose section has a statement-bearing line | Axis 2 |
| `sutNaming` | binds `sut`; bans `subject`/`objectUnderTest`/`systemUnderTest`/`cut` | Axis 1 (**name only**) |
| `bareClassToThrow` | no `.toThrow(SomeClass)` — assert error `.data` | (faithfulness of error tests) |
| `underAssertedUnit` | ≥1 `expect` per `it` | (no empty tests) |

Three consequences are load-bearing for this design:

- **Axis 1 is NOT machine-gated.** `sutNaming` (`detect-banned-sut-name.ts`) only
  checks the *identifier* is `sut` and bans aliases; it does **not** check that
  `sut` binds the unit-under-test rather than the outcome. `const sut = crc32(data)`
  passes `sutNaming` today. Axis 1 is therefore proven by **construction +
  review**, never by the gate.
- **Axis 2 is only half-gated.** `aaaBody.required = ['Arrange', 'Assert']` — the
  `// Act` marker is **not** required by the gate, but IS required by the
  convention (CLAUDE.md AAA). Adding `// Act` is convention-alignment the gate
  will not catch if omitted; `emptyAaaSection` *will* fire if `// Act` is written
  above an empty section. See §3.2.
- **Only the unit tier is gated at all.** `test/integration/**`,
  `test/parity/**`, `test/perf/**`, `test/runtime-parity/**` have **no**
  GWT/AAA/`sut` heuristic (their only heuristics — `integrationProof`,
  `overMockedIntegration` — are `gating: false`). On the non-unit tiers all three
  axes rest entirely on the per-file procedure and the review phase.

So the sweep's safety net is: **green `validate` proves behaviour + no unit-tier
regression on axes 2–3 titles**; the **review phase** (with axis-1 as its named
focus) proves axis-1 semantics and non-unit-tier conformance. Mutation is
zero-signal here (§6).

## 3. The three conformance axes — precise criteria

### 3.1 Axis 1 — `sut` binds the unit under test; `result` binds the outcome

The unit under test is the **thing you invoke or exercise** — a function, an
operator instance, a constructed object, a static method. The convention text is
prescriptive: *"`sut` MUST bind the unit under test (the function reference, the
constructed object, or the operator being exercised)."* Therefore:

**RESOLVED — Decision A/B (user): drop `sut` for function/static-factory invocations.**
The rule is deliberately simple and uniform:

- **Function under test (incl. `this`-free static factories) → NO `sut`; bind the
  outcome to `result`.** `const result = crc32(data); expect(result).toBe(…)`,
  `const result = ObjectId.from(hex); expect(result).toBe(hex)`,
  `const result = await applyMergeToWorktree(ctx, {…}); expect(result.clean)…`. In
  practice the anti-pattern `const sut = <function-call>(…)` becomes a near-pure
  **rename `sut` → `result`** across that test — the callee self-names the unit, so no
  intermediate `sut` binding is introduced. (`sutNaming` permits an absent `sut`.)
- **Object/factory under test → `sut` = the object; `result` = a read/return.**
  `const sut = new NodeHashService('sha256'); expect(sut.digestLength)…` and
  `const sut = openRepository(…); const result = await sut.status()` are **already
  correct** — `sut` IS the object exercised. Leave the `sut`.
- **Test *input* never binds to `sut`.** `const sut = new Uint8Array([1,2,3])`
  fed to `crc32` is mis-named: rename the input to a descriptive name (`data`);
  the outcome is `result`.
- **Instance methods on a constructed object are NOT detached.** Never rewrite
  `const sut = openRepository(…); sut.status()` to `const sut = instance.method`
  — that strips `this` and is an object-under-test exclusion (§4). `sut` stays the
  instance; the method call under Act yields `result`.

For a **throwing / rejecting** test the Act and Assert fuse: bind `sut` to the
unit and keep the guard inline — `const sut = ObjectId.from;
expect(() => sut(hex)).toThrow(expect.objectContaining({ data: … }))` under a
`// Act & Assert` (or `// Arrange … // Act / Assert`) marker. Never weaken the
error assertion to a bare `toThrow(Class)` (gated by `bareClassToThrow`).

Static factories (`ObjectId.from`, `RefName.from`, `FilePath.from`) are resolved
by **Decision B**. These branded-type factories are verified `this`-free
(`src/domain/objects/object-id.ts`: `ObjectId.from` is a plain function on a
const object; `fromRaw` calls `ObjectId.from` by module name, never `this`), so
detaching the method reference is safe.

### 3.2 Axis 2 — AAA section markers, all three, no empty section

Every non-skipped `it`/`test` body carries `// Arrange`, `// Act`, `// Assert`
(convention = all three, beyond the gate's `Arrange`+`Assert` floor). Placement:
`sut` and inputs built under Arrange; the single invocation under Act producing
`result`; the `expect(…)` under Assert.

**The `emptyAaaSection` trap (27.1 gotcha).** A marker written above a
statement-less section is a blocking finding. Two rules keep the sweep clean:

- **The axis-1 fix usually *resolves* the empty-Act problem.** A body previously
  written `// Arrange & Act` because the call was the only statement splits
  naturally once `sut` and `result` separate:
  `// Arrange` → `const sut = crc32`; `// Act` → `const result = sut(data)`;
  `// Assert` → `expect(result)…`. Each section now has a statement.
- **Where Arrange genuinely has nothing** (a pure function with a literal arg and
  no set-up), use the **compound marker** `// Arrange & Act` on the single
  statement — `detect-missing-aaa.ts` honours compound forms (`// Arrange + Act`
  matches both) and `emptyAaaSection` counts a compound line as one marker.
  **Never** write a bare `// Arrange` above an empty section. Row field in
  `it.each` object rows is **`label`**, never `then` (biome `noThenProperty`).

### 3.3 Axis 3 — GWT structure with zone regrouping

Target nesting: optional outer non-GWT wrapper(s) — module and/or symbol name,
e.g. `describe('object-id')` > `describe('ObjectId.from')` (nested wrappers are
allowed as transparent wrappers) — > `describe('Given <context>')` >
`describe('When <action>')` > `it('Then <expected>')`. The 2-level shortcut
`describe('Given …, When …')` > `it('Then …')` is allowed **only** when a single
`it` lives under that When; a zone that clusters multiple leaves must **expand**
a former 2-level shortcut to the full 3-level form.

**Zone regrouping (the explicit user directive).** Do not merely rename existing
`describe`/`it` in place. **Cluster** every test that shares the *same Given
(context/Arrange) AND same When (action/act)* into **one** describe zone —
`describe('Given X') > describe('When Y')` with the shared `it('Then …')` leaves
inside it. Duplicated sibling `describe('Given X')` > `describe('When Y')` blocks
scattered through a file collapse into a single zone per subject+event.

**Zone boundary (the guard that keeps regrouping behaviour-preserving).** Two
tests share a zone **iff** their Given context and When action are genuinely
identical — same set-up class, same invocation. If the Arrange differs (a
different fixture, a different pre-condition) the Given differs → separate zone.
If the invocation differs (a different SUT or a materially different call shape)
the When differs → separate zone. This mirrors ADR-498's "one accurate
`Given`+`When`" boundary. Regrouping **moves** `it` leaves between describe
blocks; it never merges two leaves and never changes a leaf's body beyond the
axis-1/axis-2 edits.

**RESOLVED — Decision C (user): collapse to `it.each`, lossless, NO DELETE.**
Zone regrouping clusters leaves into zones; within a zone, `it.each` parameterisation
of same-act/same-oracle/different-input leaves is **applied** where 3+ siblings qualify
(reusing ADR-498's KEEP/COLLAPSE guard-rails: matrix = union of inputs, no oracle
weakened, one row per guard/boundary, no shared mutable state). Collapse is **lossless
restructuring** — the number of cases *executed* is unchanged (each row runs); only the
`it()`-block count drops, making the file lighter and clearer ("improved structure =
improved meaning"). ADR-498's strict-subset **DELETE is excluded** — the user constraint
"do not remove, change, add tests" forbids dropping any case, so every distinguishing
input survives as a KEEP leaf or a COLLAPSE row; no case is added. See ADR-506.

## 4. Exclusions the criteria MUST protect (do NOT rewrite)

- **`sut` = the object under test, read as data.**
  `const sut = new NodeHashService('sha256'); expect(sut.digestLength)…` —
  correct: `sut` IS the object exercised. Leave.
- **`sut` = a factory-returned object under test, then `sut.method()`.**
  `const sut = openRepository(…)` / `const sut = createX(…)` then `sut.status()`
  — correct. Leave.
- **Files already in canonical form** (they invoke `sut(…)` or exercise
  `sut.method()`, with AAA + GWT already clean).
- **`*.properties.test.ts` (fast-check).** Conform the *structure* (GWT/AAA/`sut`
  naming of the outer scaffolding) and keep the **property body intact** — the
  arbitraries and the `fc.assert(fc.property(…))` invariant are byte-preserved.
  Never delete or weaken a property (ADR-134/136: properties are additive and
  non-substitutable).
- **`.skip` / `.todo` / `.fails` blocks** — bodies often empty; left verbatim
  (the detectors exempt them).

## 5. The repeatable per-file procedure

Apply to each file, top to bottom. Every step is mechanical; steps 2–4 change
names/structure only.

1. **Classify each `it`.** For each test, identify: the **SUT** (the invoked
   function/object), the **input(s)** (Arrange data), the **outcome** (what
   `expect` reads), and the **Given/When** it belongs to (context + action).
2. **Axis-1 rename.** If `sut` currently holds the outcome or an input: bind
   `sut` to the SUT (function ref / object), bind the outcome to `result`, and
   rename mis-named inputs to a descriptive name. Skip files/tests already
   correct (§4). Apply Decision A (pure functions) and Decision B (static
   factories) uniformly.
3. **Axis-2 markers.** Ensure `// Arrange` / `// Act` / `// Assert` are present
   and each owns a statement; use a compound marker only where a section is
   genuinely empty (§3.2). The axis-1 split usually creates a real Act statement.
4. **Axis-3 zone regroup.** Cluster tests sharing the same Given+When into one
   zone (§3.3). Preserve every `it` leaf; do not cross a zone boundary. Use the
   2-level shortcut only for singleton Whens. Keep or add the outer module-name
   wrapper.
5. **Prove the file.** `npx vitest run <file>` (all tests still green, unchanged
   assertions) `&& biome check <file>` (lint/format) `&& npm run check:types`.
   For unit files, the file also feeds `check:test-pyramid` at the batch gate.

**Navigation/edit:** Serena is the default (`get_symbols_overview`,
`replace_content`, `replace_symbol_body`); `get_diagnostics_for_file` after each
edit (advisory — ground truth is `check:types`/`validate`).

### Worked examples (all real files in scope)

- **`crc32.test.ts`** — `const sut = crc32(data)` (result-in-sut) and
  `const sut = new Uint8Array([1,2,3,4,5])` (input mis-named). Fix (drop-sut):
  `const data = …; const result = crc32(data); expect(result)…`. The input becomes
  `data`; `// Arrange`(`const data = …`) / `// Act`(`const result = crc32(data)`).
- **`object-id.test.ts`** — `const sut = ObjectId.from(hex); expect(sut).toBe(hex)`.
  Fix (drop-sut, `this`-free static factory): `const result = ObjectId.from(hex);
  expect(result).toBe(hex)`.
- **`index-diff.test.ts`** — 20+ `const sut = diffIndexAgainstTree(idx, tree)` /
  `const sut = conflictsToIndexEntries(…)`. Fix: rename `sut`→`result` (drop-sut);
  then zone-regroup the many `conflictsToIndexEntries` Whens into one zone per Given
  and **collapse** same-oracle input families into `it.each`.
- **`apply-merge-to-worktree.test.ts`** — 18× `const sut = await
  applyMergeToWorktree(ctx, {…})`. Fix: rename to `const result = await
  applyMergeToWorktree(ctx, {…})` (drop-sut); regroup by stash/merge scenario (Given)
  and "the merge is applied" (When); collapse same-oracle scenarios into `it.each`.

## 6. Proof of behaviour preservation (and why mutation is zero-signal)

- **Behaviour — proven by construction + `validate`.** Assertions are
  byte-identical; only names and nesting move. `npm run validate` runs the full
  multi-tier suite (every `expect` re-runs) plus `check:test-pyramid`. Green =
  proof. **Never commit on a red gate.**
- **Axes 2–3 (titles) on the unit tier — mechanically gated** by
  `check:test-pyramid` (§2). The sweep must keep these green; it may not regress
  `gwtTitle`/`aaaBody`/`emptyAaaSection`/`sutNaming`.
- **Axis 1 + non-unit tiers — proven by construction + review.** No gate checks
  `sut`-binds-the-unit or the non-unit-tier structure; the review phase's named
  focus is axis-1 semantics and non-unit conformance.
- **Mutation testing is ZERO-signal for this PR.** CI's `compute-mutation-scope.sh`
  filters the PR diff to `^src/.*\.ts$`; a tests-only diff yields an empty
  mutate-list, so `run-stryker-pr` prints "No src/ files … skipping" and audits
  nothing. Local whole-tree Stryker under-reports non-deterministically
  (stryker-js#5928). The plan/validation phases must **not** chase a mutation
  score — the guarantee is by-construction (assertions unchanged) + coverage +
  green `validate`. Coverage cannot drop because no `it` is deleted.

## 7. Batching plan by subtree (for the plan phase)

**Granularity:** one **part per subsystem directory**, with a **dedicated part
per giant file** (a file that is itself a subsystem), each part = one atomic
commit `test(<tier>): conform <subtree-or-file> to sut/AAA/GWT convention` that
independently passes the part gate. Dedicated single-file parts (the >1.5k-LOC
giants, same set ADR-498 identified): `application/primitives/config-read`,
`application/primitives/update-config`,
`application/primitives/detect-similarity-renames`, `domain/fsck/validate-object`,
`application/commands/merge`, `adapters/node/node-file-system-injected`,
`domain/diff/patch-serializer`, plus the next tier
(`application/commands/{fsck,fetch,push,rebase,add}`, `domain/merge/three-way-tree`).

**Ordering — machine-gated tiers first (strongest backstop):**

1. **`test/unit/domain/`** (per-subdir parts + giants) — purest, coverage-gated,
   and `check:test-pyramid` backstops axes 2–3; proves the procedure where the
   gate is strongest.
2. **`test/unit/operators/` + `ports/` + `adapters/`** — small/mid, gated.
3. **`test/unit/repository/` + `transport/` + `api-surface/` + root files** —
   small, still pyramid-gated.
4. **`test/unit/application/`** (per-subdir parts + giants) — largest surface;
   still fully pyramid-gated, so axes 2–3 keep their backstop.
5. **`test/integration/`**, then **`test/parity/` + `test/runtime-parity/` +
   `test/perf/`** — **no** pyramid gate on the three axes; done last, once the
   procedure is proven on the gated tiers, leaning on the per-file procedure +
   review. `*.properties.test.ts` files are conformed **within** their owning
   tier's part (structure only, §4).

**Gates:**

- **Part gate** (every atomic commit):
  `npx vitest run <touched files> && npm run check:types && biome check <touched files>`.
- **Batch-boundary checkpoint** (after all parts in a tier land, and once at the
  end): `npm run validate` (includes `check:test-pyramid` and full-suite run;
  for coverage-gated subtrees, `test:coverage` stays 100% by construction — no
  test deleted). A red gate localises to that batch's atomic commits (bisectable).

## 8. Decision candidates (for the ADR conversation)

**RESOLVED (ADR-506, 2026-07-25).** 0 → **(A) new ADR-506**. A → **(B) drop `sut`** for
pure functions & `this`-free static factories (bind outcome to `result`; objects keep
`sut`) — *user judgment, deviates from the design recommendation*. B → **(A-equivalent)**
folds into A's drop-`sut` rule. C → **(B) collapse to `it.each`**, lossless, under ADR-498
guard-rails, **DELETE excluded** — *user judgment, deviates from the design recommendation*.
D → **(A) per-subsystem-dir + giants, gated tiers first**. The bodies below are retained as
the rationale of record.

### Decision 0 — standing ADR for the conformance-sweep methodology (top decision)

- **(A) New standing ADR — `ADR-506`** "Test-convention conformance-sweep
  methodology": the three axes + precise criteria, the exclusions, the per-file
  procedure, the behaviour-preservation invariant (assertions unchanged; green
  `validate`), the machine-gate map (axis-1 un-gated → review-proven), and the
  all-tiers scope. Complements ADR-110 (`sut` naming), ADR-112/114–116 (AAA
  markers), and ADR-498/499/500 (Phase-27 minimisation). **← recommended** —
  Phase-27 rework sub-item, load-bearing and reusable.
- **(B) Doc-only** (this design doc, no ADR). Cons: the axis-1-un-gated /
  review-proven contract has no durable home; future convention work re-derives it.
- **(C) Fold into ADR-498.** Cons: 498 is about *minimisation* (count-reducing);
  this is *conformance* (count-preserving) — different invariant, dilutes both.
- **ADR number:** propose **506** (501–505 are consumed by 27.4's bench work; the
  brief's "503" is stale — verified against `docs/adr/`). Re-confirm at ADR time.

### Decision A — `sut` form for a pure free function (recurs hundreds of times; MUST be uniform)

For `const sut = crc32(data); expect(sut).toBe(…)`:

- **(A) `const sut = crc32; const result = sut(data); expect(result)…`** — `sut`
  = the function reference, `result` = the outcome. **← recommended** — matches
  the convention's explicit "function reference" clause and the `map.test.ts`
  north star; fully uniform; module-level functions are `this`-free so the
  reference detaches cleanly; the Arrange/Act split falls out for free (§3.2).
- **(B) Drop `sut`; `const result = crc32(data); expect(result)…`** — the
  function name is self-evidently the SUT. Cons: violates "`sut` MUST bind the
  unit under test"; leaves the `sut` binding absent where the convention expects it.

### Decision B — `sut` form for a static factory / namespaced method (`ObjectId.from`)

For `const sut = ObjectId.from(hex); expect(sut).toBe(hex)`:

- **(A) `const sut = ObjectId.from; const result = sut(hex)`** — the method
  reference is the SUT; the branded value is `result`. **← recommended** —
  uniform with Decision A; verified `this`-free for the branded-type factories
  (`ObjectId`/`RefName`/`FilePath`), so detaching is safe. A `this`-dependent
  factory (none found) would be a blocker escalation, not a silent variation.
- **(B) `const sut = ObjectId; const result = sut.from(hex)`** — `sut` = the host
  namespace, preserving `this`. Cons: over-broad ("the SUT is `ObjectId`, all of
  it"); reads less precisely than the method.
- **(C) `const result = ObjectId.from(hex)` (no `sut`)** — qualified call
  self-names the SUT. Cons: same "no `sut` binding" objection as A(B).

### Decision C — parameterisation policy (does the sweep change test count?)

- **(A) Regroup only; preserve every `it` leaf. `it.each` collapse permitted but
  not required, and only under ADR-498's guard-rails.** **← recommended** — keeps
  the diff a pure naming/structure change, cleanly reviewable and clearly
  distinct from the 27.1/27.2 *minimisation* work; avoids re-litigating
  count-reduction the minimisation ADRs already settled per tier.
- **(B) Actively collapse same-act/same-oracle leaves into `it.each` while
  sweeping.** Cons: conflates conformance with minimisation; a resurrected-mutant
  risk re-enters (guard-rails needed) for no scope reason; larger, harder review.
- **(C) Never parameterise (pure rename + regroup, no `it.each` even where it
  clarifies).** Cons: forbids the clarifying collapse the north-star file itself
  uses; slightly rigid.

### Decision D — batching granularity + ordering

- **(A) Per-subsystem directory + per-file for giants; order machine-gated unit
  tiers (domain → operators/ports/adapters → small non-gated unit → application)
  first, then un-gated non-unit tiers (integration → parity/runtime-parity/perf)
  last.** **← recommended** — balances atomic-commit reviewability against part
  count; sequences the pyramid-gated backstop first, mirroring ADR-498's ordering.
- **(B) Per-tier mega-parts (one commit per tier).** Cons: giant, un-reviewable
  diffs; a regression is hard to localise; a mid-part `validate` failure blocks a
  huge blast radius.
- **(C) Per-file uniformly (~340 parts).** Cons: process overhead dominates for
  the many tiny files.

## 9. Non-goals

- **No `src/` production change** (not even a comment) — tests-only.
- **No assertion change** — never swap an error-`.data` assertion for a
  bare-class `toThrow`, never weaken a byte-exact `toEqual`, never drop an
  `expect`. That would be a behaviour change, out of scope.
- **No test deletion and no new tests.** Conformance preserves the leaf set
  (Decision C default). A genuine coverage/faithfulness gap found mid-sweep is a
  defect to surface, not to paper over with a smuggled test or silently drop.
- **No property-body edits** — `*.properties.test.ts` structure conforms; the
  `fc.property(…)` invariant and arbitraries are byte-preserved (§4).
- **No threshold/budget change** — `mutation-budgets.json` and the pyramid *count*
  budgets in `test-pyramid-budgets.json` are untouched. **Exception (ADR-506 E/F, §10):**
  the harness *extension* deliberately changes the pyramid detectors' tier reach, adds one
  heuristic (`sutBindsResult`), and extends the `gating` set — this is the user-requested
  lock-in, landed after all conformance parts, not a count/threshold move.

## 10. Harness extension — enforce the three axes on every tier (ADR-506 E/F)

The user asked for the structure to be enforced in future for **every kind of test**. This
closes §2's gaps by extending `check:test-pyramid` (`tooling/test-pyramid/*`,
`test-pyramid-budgets.json`), a **tooling change** proven by the detectors' own
`tooling/test/unit/test-pyramid/*.test.ts` (TDD; CI mutation stays zero-signal — tooling is
not `src/`).

- **Decision E** — extend `gwtTitle`/`aaaBody`/`emptyAaaSection`/`sutNaming` from
  `tier: 'unit'` to **all tiers**, blocking. Manifest heuristic gains a `tiers` set; each
  detector's single-tier skip becomes a membership check; detector unit tests extend to
  multi-tier.
- **Decision F** — new detector **`sutBindsResult`** flags `const sut = <bare-call>(…)`
  (result-in-`sut`), **allows** `new X(…)` and a **factory allowlist** (`openRepository`,
  `createX`, …); best-effort, gating, all tiers. Forward enforcement of Axis 1.
- **Ordering invariant** — conform first, gate last. The extension parts run **after every
  conformance part** (§7); the detectors run against the fully-conformed tree, any straggler
  they surface is fixed, and `gating` flips to blocking last, so `validate` never goes red. A
  new detector source file is added to biome's `includes` whitelist in the same part.
