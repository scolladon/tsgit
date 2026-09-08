# Plan — name-hash ordering for delta-base selection

> Source: design doc `docs/design/name-hash-delta-ordering.md` · ADRs 826, 827, 828, 829,
> 830, 831, 832, 833, 834, 835
> The plan is the implementation script AND the knowledge handoff. Part agents start with
> zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## How to read the design doc

The design is **1 438 lines. Never read it whole** — an earlier agent was killed after 600 s
of zero progress doing exactly that. Read it with `sed -n '<from>,<to>p'`:

| Range | What |
|---|---|
| `152,198` | **Ratified decisions — authoritative.** Overrides any contrary recommendation later in the document, including the Decision-candidates table. 45 lines. Read first |
| `199,294` | Requirements R1–R17 — every one is verifiable by a named test |
| `297,462` | §1 the pinned matrix: §1a the hash + vector table, §1b the sort key, §1c what git names class by class, §1f the window mechanics and the sha1/sha256 bound vectors |
| `463,532` | §2 the hash module, §3 the comparator |
| `533,870` | §4 the application layer, sub-sections 4a–4i (the biggest section) |
| `871,949` | §5 the path-less table, §6 determinism and the two modes |
| `950,1000` | §7 memory, §8 public surface |
| `1053,1117` | §11 the measurement contract |
| `1118,1158` | §12 the blast radius — the partition this plan implements |
| `1187,1419` | §Test strategy — per-file case lists |

**The ADRs win over the design body where they disagree.** They do not disagree anywhere
here: the revision pass rewrote the affected sections rather than annotating them.

### Seven things the design states loosely, wrongly, or not at all

Each is resolved here. Do **not** re-litigate them.

| Design says | What this plan implements, and why |
|---|---|
| §12 part C: "test call sites: … `fetch-pack.test.ts` (3)" | **Two of those three are not the primitive.** `test/unit/application/primitives/fetch-pack.test.ts:3783-3793` declares a **local shadow** `const buildPack = async (label: string) => {…}` wrapping `buildSyntheticPack`; `:3799` and `:3800` call that shadow. Only **`:3437`** is the real primitive. Part 3 migrates **one** call site in that file — touching the other two is a defect |
| §12 part C: "`bundle-create.ts:312` → `oids.map((id) => ({ id }))`" | `bundle-create.ts:312` today reads `buildPack(ctx, { oids: closure.objects, delta: true })` — it passes the enumerator's array **directly**, there is no local `oids`. The Part 3 migration is `{ objects: closure.objects.map((id) => ({ id })), delta: true }`, and Part 9 deletes that `.map` once Part 9 has made `BundleObjectClosure.objects` carry `{ id, nameHash }` |
| §8 and §12 treat `INVALID_PACK_INPUT` as a one-line addition | It is a **discriminated-union member** and trips five surfaces, all listed in Part 3's context: `src/domain/storage/error.ts` (union + factory), `src/domain/storage/index.ts` (barrel, alphabetical), `src/domain/error.ts:~226` (`extractDetail`'s `return data.reason` group), `test/unit/domain/exhaustiveness.ts:~23` (the `never` gate — a missing case is a `check:types` failure, which is Part 3's first genuine RED), and `test/unit/domain/storage/error.test.ts` (one describe per factory) |
| §12 part J: "`searchBound` (new, exported for the unit)" — with no note on `check:dead-code` | knip's entry set is the barrels in `knip.json`; `deltify.ts` is not one. A `src/` export consumed only by a test is nonetheless **reachable**, because `knip.json`'s `vitest: { config: ['vitest.config.ts'] }` registers the suite's `include` globs as entries — and the repo already ships that shape at `src/adapters/node/path-policy.ts:196-198` (`@internal — exported only for that combinatorial test coverage`). Part 11 copies that JSDoc grammar verbatim. If `check:dead-code` still flags it, **escalate** — never a knip ignore |
| §12 part M: "a `docs/use/` page for `buildPack` if one lists `oids` (`rg -n "oids" docs/use` at plan time)" | Run at plan time. **One page**: `docs/use/primitives/internals.md:20`, which names both `input.oids` and the `(type, size, oid)` emission order. `docs/use/commands/fetch-missing.md`'s `oids` is `FetchMissingInput`, unrelated — do not touch it |
| §12's per-part gate "pack bytes byte-identical to `main`" gives no mechanism | There is none that a part agent may run: switching branches is forbidden, and a golden pack sha is toolchain-sensitive here (the deflate-padding trap class). The gate is **structural + the unmodified suite** — spelled out under "How byte-neutrality is proved" below. Read it before starting Part 2 |
| Nothing says where the four measured stages record their numbers between commits | `tooling/pack-size-compare.ts` (Part 7) is the one procedure. Every measured stage writes its row into `docs/design/name-hash-delta-ordering.md` §11b's table **in that stage's own commit** — the design's §11 is the published home, and a stage whose row is missing has not landed |

---

## Sizing rules — the cut, and why it is thirteen

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) and must earn
  it. **No standalone test-only parts for FEATURE code**: coverage, interop and property tests
  fold into the implementation part whose code they exercise. EXCEPTION: test-infra-only and
  docs-only parts (tooling config, test helpers, fixtures, harness/property suites, prose) with
  no `src/` delta ARE legitimately standalone.
- Sequential parts share one working tree and build on each other. A part that would be a pure
  test pass over already-landed code merges into its neighbour.

**Thirteen parts, and the three rules that produced them** (design §12, implemented as written,
not re-cut):

1. **Every part leaves `npm run validate` green on its own.**
2. **The breaking input change is one part with no behaviour change** (Part 3), so its diff is
   pure migration and its gate is "every existing test green modulo the type". It therefore
   lands *before* the closure engine starts emitting a hash a pass-through caller would pick up.
3. **Each measured stage is its own commit**, with the measurement run between it and the next,
   so §11's rows are commit shas rather than diff hunks. Parts 8, 10, 11 and 12 are those
   stages (ADR-831 for the first three, ADR-834 for the fourth) and **may not be merged into
   anything**, including each other.

Parts 1, 2, 4, 5, 6 are byte-neutral plumbing that must land before any stage; Part 3 is the
breaking migration; Part 7 is test-infra-only (a committed measurement driver plus the B0
baseline row) with **zero `src/` delta**, which is exactly the standalone exception; Part 13 is
docs-only, likewise.

**Legitimately mergeable pairs, deliberately left un-merged** — recorded so a reviewer does not
read the split as an oversight. `{1, 2}` are both small `src/domain/storage/` units; `{4, 5}`
are the two halves of ADR-828 in one file with one test file. Each pair would still be
independently gate-able as one part. They stay split because Part 2's diff touches
`deltify.ts` (which Part 1's does not) and Part 5 ships an option with no production caller
(which Part 4's fold does not), so merging trades two small reviewable diffs for one mixed one.

---

## Public-vs-internal, decided up front

Decided **now**, in the part that creates the symbol — never hedged to "later". `src/domain/index.ts:28`
is `export * from './storage/index.js'`, and `src/domain/index.ts` is a `knip.json` entry, so
**anything added to `src/domain/storage/index.ts` is public and lands in `reports/api.json`**.

| New symbol | Part | Verdict | Gates tripped, pre-paid in that part |
|---|---|---|---|
| `PACK_NAME_HASH_SEED`, `foldPackNameHash`, `packNameHash`, `PACK_NAME_HASH_V1`, `PathHasher` | 1 | **public** — §8; `PathHasher` is forced public by `WalkTreeOptions.pathHasher?: PathHasher` (Part 4), and `WalkTreeOptions` already has 13 `reports/api.json` mentions | `src/domain/storage/index.ts` barrel (new alphabetical block), `reports/api.json` regenerated and committed, `check:size` / `check:tarball` budgets |
| `NO_RECENCY` | 2 | **public** — §8 lists it among the new `domain/storage/index.ts` exports. `delta-policy.ts` is not in the barrel today, so this adds the module's first barrel line | same barrel, `reports/api.json` |
| `PackEmissionKey.nameHash`, `.recency` | 2 | **internal** — `PackEmissionKey` is not barrelled and has **0** `reports/api.json` mentions (verified). Type-only widening of an unpublished interface | none |
| `INVALID_PACK_INPUT` (union member) + `invalidPackInput` (factory) | 3 | **public** — `StorageError` is barrelled and published | `src/domain/storage/error.ts`, barrel value export, `src/domain/error.ts`'s `extractDetail`, `test/unit/domain/exhaustiveness.ts`, `test/unit/domain/storage/error.test.ts`, `reports/api.json`. `docs/use/errors.md` has **no mechanical gate** — it is Part 13's row |
| `PackObjectInput` + `BuildPackInput.objects` (replacing `.oids`) | 3 | **public, breaking** — 11 `reports/api.json` mentions | `src/application/primitives/index.ts:11` already re-exports `BuildPackInput`; add `PackObjectInput` beside it. `reports/api.json`. Folds into the pending major (`main` carries three `feat(…)!:` commits since `v3.6.0`) |
| `WalkTreeEntry.nameHash?`, `WalkTreeOptions.pathHasher?` | 4 | **public, additive** — both types reach the barrel through `src/application/primitives/index.ts:96` `export type * from './types.js'` | `reports/api.json` |
| `WalkTreeEntry.pathBytes?`, `WalkTreeOptions.pathBytes?` | 5 | **public, additive** — same route | `reports/api.json` |
| `ClosureObject.nameHash?` | 6 | **internal** — `closure-engine.ts` lives under `internal/` and is not barrelled | none |
| `searchBound` in `deltify.ts` | 10 | **internal**, `@internal`-tagged, exported only for the unit vectors | `check:dead-code` — see the precedent above |
| `without`, `readmit`, `WindowState` changes | 11 | **internal** — module-private in `deltify.ts` | none |
| `DELTA_FLOOR_BYTES` | 12 | **internal** — module-private const in `deltify.ts`; nothing outside decides on it | none |
| `tooling/pack-size-compare.ts` | 7 | **tooling** — not `src/`, never published | `biome.json`'s `files.includes` is a **whitelist**: a new `tooling/*.ts` file is silently unlinted until it is added. Part 7 adds it |

**`DELTA_ACCEPT_RATIO` is removed in Part 10** (design §12 row J): its only consumer is the flat
bound at `deltify.ts:163`, and `acceptsDeltaEntry` never read it despite the docblock claiming
so. It is **internal, not public** — verified: `src/domain/storage/index.ts` carries no
`delta-policy.js` line today, and Part 2 adds only `NO_RECENCY` to it. So its removal is **not** a
public break, needs no `!`, and does not move `reports/api.json`.

**`reports/api.json` moves in parts 1, 2, 3, 4, 5.** Parts 6, 8, 9, 10, 11, 12 regenerate it and
expect **no diff**; a diff there means something leaked into the public surface — stop and read
it rather than committing it.

---

## How byte-neutrality is proved, in parts 2, 3 and 6

Design §12 gives parts B, C and F the gate "pack bytes byte-identical to `main`" and no
mechanism. There is none a part agent may run: **branch switching, stashing and worktree
creation are all forbidden**, and a golden literal pack sha is not trustworthy here (deflate
output has bitten this repo before — the deflate-padding trap class). So the proof is
structural, and the suite is what enforces it:

- **Part 2** is byte-neutral because `boundCarriedContent` fills the two new key fields with the
  **same constants for every object in the sort** — `nameHash: 0`, `recency: NO_RECENCY`. Two
  comparator clauses that can never fire cannot change an order.
- **Part 3** is byte-neutral because it is a pure input-shape rename: `objects[i].id` is
  `oids[i]`, nothing else is read, and the mixed-recency guard cannot fire when no caller passes
  `recency`.
- **Part 6** is byte-neutral because no consumer reads `ClosureObject.nameHash` until Part 8.

**The enforcement, in every one of those three parts:** the whole existing pack-writing surface
passes with **no assertion's expected value edited** — only the mechanical `oids` → `objects`
rename and the `toEqual`/`toStrictEqual` object-shape updates the new optional field forces.
That surface is:

```
test/unit/application/primitives/build-pack.test.ts
test/unit/application/primitives/internal/deltify.test.ts
test/unit/application/primitives/internal/deltify-carried-content.test.ts
test/unit/application/primitives/internal/deltify-window-eviction.test.ts
test/unit/application/commands/pack-objects.test.ts
test/unit/application/commands/bundle-create.test.ts
test/unit/application/commands/maintenance.test.ts
test/integration/delta-pack-interop.test.ts
test/integration/rev-write-interop.test.ts
test/integration/maintenance-interop.test.ts
```

⚠️ **If an assertion in those files needs a new expected value in Part 2, 3 or 6, byte-neutrality
has broken. Stop and escalate — do not update the expectation.** Part 7's B0 row is the numeric
confirmation after the fact: it must re-measure `main`'s ×5.43 / ×1.58 classes on the new peer.
A B0 that lands outside those classes retroactively falsifies parts 1–6.

---

## Repo-wide facts every part needs

- **Part gate** (run before committing, from `.claude/workflow.md`'s `gates.part`):
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files> && npm run check:spelling`
- **Phase gate**: `npm run validate`, run **once by the orchestrator after Part 13** — never
  inside a part.
- ⚠️ `npm run check:types` and `npm run check:spelling` are **wireit-cached**;
  `Ran 0 scripts and skipped 1` reads exactly like a pass and has put commits on red here.
  Always **also** run the bare forms: `npx tsc --noEmit -p tsconfig.json` and
  `npx cspell --no-progress <touched-files>`.
- ⚠️ **Never read a gate through a pipe.** `… | tail` reports exit 0 on a red run. Run gates
  bare and read `echo $?`.
- ⚠️ **Confirm a scripted edit landed.** `git diff --no-ext-diff --stat` and eyeball the hunk before trusting
  any gate; an anchored replace can report success after biome re-wrapped the anchor line.
- ⚠️ **`command grep`, never bare `grep`** — the `rtk` wrapper is broken and fails *closed*, so
  an empty result is indistinguishable from "no matches".
- ⚠️ **Never call `mcp__serena__activate_project`** — serena is already activated on this
  worktree, and activating a stale path cascades `FileNotFoundError`.
- **Coverage** (`vitest.config.ts:80-90`) gates `src/domain/**`, `src/ports/**`,
  `src/adapters/node/**`, `src/adapters/memory/**`, `src/operators/**` at **100 %**
  line/branch/function/statement — `src/application/**` is **not** in `coverage.include`. So
  parts 1, 2 and 3's domain edits are coverage-gated; parts 4, 5, 6, 8, 9, 10, 11, 12 are not.
- **Stryker mutates all of `src/`** except `src/**/index.ts` and `src/adapters/browser/**`
  (`stryker.config.mjs`), and `vitest.stryker.config.ts` runs **`test/unit/**` only**. So every
  application-layer file this plan touches is mutated but **not** coverage-gated, and an effect
  visible only in `test/integration/**` leaves its mutants alive with correct-looking coverage.
  **Wherever a part's effect is pack-level, the part must add a unit-level spy on the callee's
  captured argument**, not just an integration pin. Parts 8 and 9 carry that requirement
  explicitly; it is the single highest-yield survivor class in this change.
- **Every added guard arm needs its own row in the same part.** A new `||` operand or a new
  `if` without a covering test turns the 100 % domain gate red at the next full validate.
- ⚠️ **A guard test is vacuous when an adjacent filter also excludes the fixture.** This change
  adds **three interacting filters** on the same objects — the search bound (Part 10), the
  50-byte floor (Part 12) and max-depth non-admission (Part 11). Arrange each guard test so the
  guard under test is the **only** thing that can exclude the row: a floor test must use objects
  the bound would admit, and a bound test must use objects above the floor. This exact class has
  bitten this repo before on threshold work.
- **Test conventions.** `describe('Given …')` > `describe('When …')` > `it('Then …')`; an outer
  non-GWT describe naming the module is an allowed transparent wrapper (`deltify.test.ts:53`
  `describe('deltifyEntries')` is the precedent). The 2-level `describe('Given …, When …')` >
  `it('Then …')` shortcut is allowed when only one expectation lives under the When. AAA body
  with `// Arrange` / `// Act` / `// Assert` section comments. The **function under test** is
  bound to `sut`; the result goes in `result` — never `sut`.
- **`check:test-pyramid` gates** on `underAssertedUnit`, `gwtTitle`, `aaaBody`, `sutNaming`,
  `sutBindsResult`, `bareClassToThrow`, `emptyAaaSection`. `overMockedIntegration` and
  `integrationProof` are report-only — but the house rule still holds: **no `vi.*` in
  `test/integration/**`**.
- **Error assertions on data, via try/catch** — never a bare `toThrow(Class)` (mechanically
  gated). Assert `code`, `reason` and every numeric field.
- **Property tests** live in a `*.properties.test.ts` sibling, generators in the directory's
  shared `arbitraries.ts`. The seven existing files under `test/unit/domain/storage/` all open
  `import fc from 'fast-check';` then `import { describe, expect, it } from 'vitest';`, blank
  line, then SUT and `./arbitraries.js` last. Tiered `numRuns`: **200** cheap round-trip, **100**
  default, **50** filter-heavy. **Never commit a seed.**
- **No provenance refs in code or tests** — no `§`, `Phase`, `ADR-`, `R13`, `DC-7`, `30.6`
  markers in any `src/` or `test/` file, and none in a commit message. Those tokens live in this
  plan and in `docs/` only. Comments explain *why*, in their own words.
- **No suppression directives.** No `@ts-ignore`, `v8 ignore`, `biome-ignore`, `stryker-disable`.
  A `// Stryker disable next-line <Mutator>: equivalent — <proof>` comment is the one sanctioned
  form, only for a **proven** equivalent re-proved against *this* code, and it anchors on the
  **expression line** that follows it. This plan adds none.
- **`reports/api.json` is a PREPUSH gate, not a validate gate** — `check:doc-typedoc` is
  `git diff --no-ext-diff --exit-code -- reports/api.json` with `docs:json` as its dependency. Local validate
  can be green while the push hook rejects. Run `npm run docs:json` and commit the file in every
  part the table above marks.
- **`test/integration` hooks that spawn git or build `dist/`** need an explicit
  `beforeAll(fn, 60_000)` (600 000 for a dist build) or they fail under full-validate
  concurrency.
- **Spawning real git**: scrub every `GIT_*` (`-C` does **not** override `GIT_DIR`), isolate
  `HOME`, set `GIT_CONFIG_NOSYSTEM=1`, signing off. Baseline git here is **2.55.0**. The
  standing procedure is `.claude/workflow/faithfulness.md`.
- **A per-`Context` loose-object fanout cache is invalidated only by tsgit's own `writeObject`.**
  An interop test that writes objects through real `git` subprocesses must build a **fresh
  `Context` after** those writes, or reads miss.
- **State-mutating probes run in a `mktemp` throwaway**, never in the worktree.
- **`docs/plan/*.md` is not covered by the lint-staged markdown cspell hook** (it *is* covered by
  `npm run check:spelling`'s `docs/**/*.md` glob). Run
  `npx cspell --no-progress docs/plan/name-hash-delta-ordering.md` bare. Prefer rewording over a
  `cspell.json` entry; if one is unavoidable insert at its alphabetical position — **never
  re-sort `cspell.json`**.
- **A "pre-existing" claim is verified against `main`**, never against an earlier commit on this
  branch.

---

## Decision candidates — plan mechanics only

Every design-level choice is pre-decided by ADRs 826–835. These four are plan-mechanics choices
this plan had to make; the recommendation is what the parts below implement.

| # | Choice | Options | Recommendation |
|---|---|---|---|
| **PC-1** | Where `enterTree`'s growing parameter list lands | (1) parts 4 and 5 each add a parameter, ending at seven — the design's literal shape; (2) Part 4 adds `hashState` as a sixth parameter, and Part 5's REFACTOR collapses `prefix`, `hashState` and `prefixBytes` into one `FramePrefix` value object, holding `enterTree` at five parameters; (3) introduce `FramePrefix` in Part 4 up front | **(2)**. Seven parameters is primitive obsession the house rules refuse in touched code, and the three values are one concept — a frame's inherited path in three representations. Doing it in Part 5 keeps Part 4's diff minimal and gives Part 5 a real REFACTOR step instead of a cosmetic one |
| **PC-2** | Where the `PackObjectInput` wrappers are built for `bundle-create` | (1) Part 3 writes `closure.objects.map((id) => ({ id }))` at `bundle-create.ts:312` and Part 9 deletes the `.map` once `BundleObjectClosure.objects` carries `{ id, nameHash }`; (2) Part 3 changes `BundleObjectClosure.objects`' element type at the same time; (3) leave `bundle-create` on a `.map` forever | **(1)**. Option 2 puts an enumerator change inside the part whose gate is "no behaviour change", which is precisely what design §12's rule 2 forbids. The transient `.map` costs one line for six parts |
| **PC-3** | Where the four measured rows are written down | (1) each stage commits its own row into `docs/design/name-hash-delta-ordering.md` §11b as part of that stage's commit; (2) all four rows land in Part 13; (3) a new `docs/spike/` file | **(1)**. ADR-831's whole point is that the rows are commit shas, not diff hunks; a table assembled at the end cannot be re-derived per commit, and a stage whose predicted zero read non-zero must block *its own* commit, which only (1) allows |
| **PC-4** | The `k` in R13's post-stage-2 chain band, and the X7 upper band | (1) the plan guesses them; (2) **the implementer fills them from the stage's own measured readout, with git's `verify-pack` readout of the same repository recorded beside it in a test comment**; (3) drop the bands and assert only validity | **(2)**, which is what the design already refuses to guess. Part 10 fills R13's band from the S2 readout; Part 13 sets X7's upper band from the **shipped** S4 row plus 15 % headroom. A band written before its measurement exists is a fabricated oracle |

---

## Part 1 — git's pack name hash, as a pure domain fold

### Context

Design §2 (`sed -n '463,491p'`), §1a (`sed -n '299,364p'`), ADR-828, ADR-829.
Requirements **R1**, **R2**.

**Files.**

| Action | Path | What |
|---|---|---|
| create | `src/domain/storage/pack-name-hash.ts` | the whole module |
| edit | `src/domain/storage/index.ts` | one new export block; the barrel is grouped by concern with a `// <Concern>` comment per group (see `// Delta` at `:8`, `:9-11`) |
| create | `test/unit/domain/storage/pack-name-hash.test.ts` | vectors + isolated byte cases |
| create | `test/unit/domain/storage/pack-name-hash.properties.test.ts` | three properties |
| edit | `test/unit/domain/storage/arbitraries.ts` | one exported byte-array arbitrary |
| regenerate | `reports/api.json` | `npm run docs:json`, commit the result |

**The module to write** (design §2, verbatim shape):

```ts
export const PACK_NAME_HASH_SEED = 0;
const GIT_SPACE = new Uint8Array(256);            // 0x09, 0x0a, 0x0d, 0x20 set to 1
export function foldPackNameHash(state: number, bytes: Uint8Array): number {
  let hash = state;
  for (const c of bytes) {
    if (GIT_SPACE[c] === 1) continue;
    hash = ((hash >>> 2) + (c << 24)) >>> 0;
  }
  return hash;
}
export const packNameHash = (pathBytes: Uint8Array): number =>
  foldPackNameHash(PACK_NAME_HASH_SEED, pathBytes);
export const PACK_NAME_HASH_V1: PathHasher = { seed: PACK_NAME_HASH_SEED, fold: foldPackNameHash };
```

`PathHasher` is declared **in this same module** — `{ readonly seed: number; fold(state: number,
bytes: Uint8Array): number }` — so that both the domain constant and Part 4's application-layer
walker option can name it without the domain importing outward.

**House rules bind here.** No magic values: the four skipped bytes are named constants
(`TAB`, `LINE_FEED`, `CARRIAGE_RETURN`, `SPACE`) whose values seed `GIT_SPACE`; `BYTE_VALUES = 256`
likewise. Functions stay under 20 lines. `src/domain/**` is **100 %-coverage-gated**, so both arms
of the `GIT_SPACE` test and both the empty and non-empty `bytes` cases must be covered.

**The arithmetic, proved — do not "fix" it.** For `c >= 0x80`, `c << 24` is **negative** in JS
(int32): `0xff << 24 === -16777216`. The trailing `>>> 0` is what makes the result agree with C's
`uint32` addition, and it is the whole reason the `\xff` vector reads `0xff000000` rather than a
negative number. Worked both ways: with `hash >>> 2 === 0x3fffffff` and `c === 0xff`, JS computes
`1073741823 + (-16777216) = 1056964607`; C computes `1073741823 + 4278190080 = 5351931903`, which
mod 2**32 is `1056964607`. Equal. `hash >>> 2` never exceeds `0x3fffffff` and `c << 24` never
exceeds `0xff000000` in magnitude, so no intermediate loses precision.

**The vector table — this is the oracle, copy it exactly** (design §1a; git 2.55.0's
`pack_name_hash`, compiled verbatim with the system `cc`). Write it as `it.each` over
`[label, bytes, expected]`:

| Path bytes | v1 | v2 (recorded only — ADR-829) |
|---|---|---|
| `` (empty) | `0x00000000` | `0x00000000` |
| `a` | `0x61000000` | `0x86000000` |
| `ab` | `0x7a400000` | `0x67800000` |
| `a b` (space skipped) | `0x7a400000` | `0x67800000` |
| `ab\t` (tab skipped) | `0x7a400000` | `0x67800000` |
| `\x0bab` (vertical tab **hashed**) | `0x7af00000` | `0x74800000` |
| `\x0cab` (form feed **hashed**) | `0x7b000000` | `0x6a800000` |
| `churn.txt` | `0x9a8bd300` | `0x3ac57e00` |
| `src/churn.txt` | `0x9a8be72b` | `0x395cfe00` |
| `lib/churn.txt` | `0x9a8be6f0` | `0x3b7efe00` |
| `deep/er/churn.txt` | `0x9a8be7c7` | `0x3b1f5980` |
| `README.md` | `0x83977600` | `0x5e0d7200` |
| `src/main.c` | `0x77854ac0` | `0xeef20000` |
| `src/util.c` | `0x777a4ac0` | `0xea880000` |
| `0123456789abcdef` | `0x878af8e3` | `0x9569c357` |
| `X0123456789abcdef` | `0x878af8e3` | `0x9569c358` |
| `\xc3\xa9.txt` (UTF-8 `é`) | `0x9ad1c000` | `0x3af5c000` |
| `\xff` | `0xff000000` | `0xff000000` |

Two rows are load-bearing beyond their value. `\xc3\xa9.txt` is the **only** row that folds a
state whose bit 31 is already set (after `0xc3`, `hash === 0xc3000000`), so it is what kills the
`>>> 2` → `>> 2` mutant. `\xff` is what kills a dropped final `>>> 0`.

**The 16-byte window, both sides.** `0123456789abcdef` and `X0123456789abcdef` are equal for
*these* byte values: `'X'`'s own term has been shifted right by `2 × 16 = 32` bits and left the
word. The **negative** case must also ship: with a **15**-byte tail the prefix survives —
`'X' << 24` shifted right by 30 bits is exactly `1` — so `packNameHash('X123456789abcdef')`
differs from `packNameHash('123456789abcdef')` by precisely `1`. Assert that difference
numerically, not just `not.toBe`.

⚠️ **These are vectors, not a universal law — do not generalise them into a property.** A first
draft of this plan did, and it is false. `>>> 2` truncates, so the two low bits a step discards
depend on the whole prefix, and the following `+ (c << 24)` can **carry** that difference back up
into the high bits. A prefix therefore never provably leaves the word; it only *usually* does,
which is why git's own comment says "effectively". Disproved three independent ways during Part 1:
a fast-check counterexample inside 15 trials, an from-scratch re-derivation, and git's C fold
compiled verbatim with `cc`, which reproduced a ~54 % mismatch rate over 200 000 random trials at
exactly 16 shared trailing bytes while still agreeing with every pinned vector above.

**Property file** (design §Test strategy; lenses 1 and 4 fit — a compositional fold and a
whitespace-drop invariant). Three properties, matching the seven existing
`test/unit/domain/storage/*.properties.test.ts` files' shape (`import fc from 'fast-check';`
line 1, `import { describe, expect, it } from 'vitest';` line 2, blank, then SUT then
`./arbitraries.js` last):

1. `foldPackNameHash(foldPackNameHash(seed, a), b) === packNameHash(concat(a, b))` — `numRuns: 200`
2. inserting any of the four space bytes at any index leaves the hash unchanged — `numRuns: 200`
3. the result is always an integer in `[0, 2**32)` and the function never throws — `numRuns: 200`

**Never commit a seed.** A failing property shrinks to a counterexample locally.

**The arbitrary.** `test/unit/domain/storage/arbitraries.ts` exists (600+ lines) and already
re-exports `arbObjectId` and exports `arbDeltaBaseTarget`, `arbBitSet`, `arbMidxSpec`, … It has
**no** byte-array generator for this family. Add one in the file's existing style
(`export function arbNameBytes(): fc.Arbitrary<Uint8Array>` over
`fc.uint8Array({ maxLength: 64 })`). Do **not** inline `fc.uint8Array` in the property file —
the house rule puts per-family generators in the directory's shared `arbitraries.ts`.

**v2 vectors** are recorded as **data** in `pack-name-hash.test.ts`, in their own `describe` that
asserts only their shape (each entry is a `[bytes, uint32]` pair; the table is non-empty), never
that any code produces them. ADR-829: tsgit implements v1 only; the vectors were expensive to pin
and recording them makes the later port a port rather than a re-derivation.

**Barrel + public surface.** Every symbol here is **public** (design §8) and reaches
`reports/api.json` through `src/domain/storage/index.ts` → `src/domain/index.ts:28`
(`export * from './storage/index.js'`), which is a `knip.json` entry. Add one grouped block to
the barrel following the `// Delta` precedent at `:8-11`:

```ts
// Pack name hash
export type { PathHasher } from './pack-name-hash.js';
export {
  foldPackNameHash,
  PACK_NAME_HASH_SEED,
  PACK_NAME_HASH_V1,
  packNameHash,
} from './pack-name-hash.js';
```

Then `npm run docs:json` and **commit `reports/api.json`** — `check:doc-typedoc` is a
`git diff --no-ext-diff --exit-code` prepush gate, not a validate gate, so a stale file passes
locally and rejects on push.

### TDD steps

- **RED 1 — the module does not exist.** Write `pack-name-hash.test.ts`'s vector `it.each` first
  and run `npx vitest run test/unit/domain/storage/pack-name-hash.test.ts`. Expected failure:
  `Cannot find module '../../../../src/domain/storage/pack-name-hash.js'`.
- **GREEN 1.** Create the module exactly as shaped above. Re-run — all eighteen vector rows pass.
  If a row does not, **stop**: the port is wrong, not the vector. Re-read §1a's three "details a
  port gets wrong from memory" before touching the table.
- **RED 2 — the whitespace set, six isolated cases.** One `it` per byte, never one combined case —
  a combined case lets a `GIT_SPACE` table mutant survive. Four proving `0x09`, `0x0a`, `0x0d`,
  `0x20` are skipped (each alone flips the result when un-skipped: assert
  `packNameHash(withByte) === packNameHash(without)`); two proving `0x0b` and `0x0c` are
  **hashed** (assert `packNameHash(withByte) !== packNameHash(without)` **and** the exact expected
  value from the table). These pass immediately if GREEN 1 was right — that is the signal working,
  not a skipped RED. Run them and read the six greens individually.
- **RED 3 — high bytes.** `0x80` and `0xff` each contribute `c << 24` unsigned. Assert exact
  values, and assert `packNameHash(Uint8Array.of(0xff)) >= 0` explicitly — that assertion is the
  `>>> 0` mutant's killer and reads as noise without this note.
- **RED 4 — the window, both directions.** The 16-byte equality pair and the 15-byte
  difference-of-exactly-1 pair.
- **RED 5 — composition.** `fold(fold(seed, a), b) === packNameHash(concat(a, b))` on one fixed
  pair. The property file proves the grammar; this example documents the literal composition.
- **RED 6 — the seed.** `packNameHash(new Uint8Array(0)) === PACK_NAME_HASH_SEED` and
  `PACK_NAME_HASH_SEED === 0`, as two assertions in one `it`.
- **RED 7 — v2 as data.** The shape-only describe.
- **RED 8 — the properties.** Add `arbNameBytes` (plus the space-free variant) to
  `arbitraries.ts`, then the four properties. Run the property file alone first; a starving filter
  shows up as a fast-check "too many pre-conditions failed" error, not a wrong answer.
- **REFACTOR.** Name every byte constant. Confirm `foldPackNameHash` is a single loop with an
  early `continue` and no nesting past one level. Re-read the `GIT_SPACE` initialisation: it must
  set exactly four indices, each from a named constant, on separate statements, so each is its own
  mutation target with its own killing test.
- **Coverage.** `npx vitest run --project unit --coverage` — `src/domain/**` is gated at 100 % on
  all four metrics.

### Gate

```
npx vitest run test/unit/domain/storage/pack-name-hash.test.ts test/unit/domain/storage/pack-name-hash.properties.test.ts
npx vitest run --project unit --coverage
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/storage/pack-name-hash.ts src/domain/storage/index.ts test/unit/domain/storage/pack-name-hash.test.ts test/unit/domain/storage/pack-name-hash.properties.test.ts test/unit/domain/storage/arbitraries.ts
npm run check:spelling
npx cspell --no-progress src/domain/storage/pack-name-hash.ts test/unit/domain/storage/pack-name-hash.test.ts test/unit/domain/storage/pack-name-hash.properties.test.ts
npm run check:dead-code
npm run docs:json
```

Run every command bare, never through a pipe, and read `echo $?`. `reports/api.json` **must**
change here — that is the new public surface landing. Commit it.

### Commit

```
feat(pack): compute git's pack name hash as a pure byte fold
```

---

## Part 2 — the emission comparator learns name hash and recency

### Context

Design §3 (`sed -n '492,532p'`), §1b-§1c (`sed -n '365,395p'`), ADR-826, ADR-832.
Requirements **R3**, and the recency-absent half of **R4**.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/domain/storage/delta-policy.ts` | `NO_RECENCY`, two `PackEmissionKey` fields, two comparator clauses, the docblock at `:29-33` |
| edit | `src/domain/storage/index.ts` | the module's **first** barrel line — `export { NO_RECENCY } from './delta-policy.js';` |
| edit | `src/application/primitives/internal/deltify.ts` | `boundCarriedContent` (`:93-117`) fills the two new fields with constants |
| edit | `test/unit/domain/storage/delta-policy.test.ts` | the `key()` helper at `:13-17` and seven new cases |
| regenerate | `reports/api.json` | `NO_RECENCY` is a new public export |

**Current state, verbatim.** `src/domain/storage/delta-policy.ts` is 79 lines. `PackEmissionKey`
is `:22-27` — `{ id: string; type: BasePackEntryType; uncompressedSize: number }`, **no name or
path field**. `comparePackEmissionOrder` is `:34-40`:

```ts
export function comparePackEmissionOrder(a: PackEmissionKey, b: PackEmissionKey): number {
  if (a.type !== b.type) return a.type - b.type;
  if (a.uncompressedSize !== b.uncompressedSize) return b.uncompressedSize - a.uncompressedSize;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
```

**The target** (design §3, verbatim). `NO_RECENCY = 0` with the doc *"A recency-absent object:
every such object ties on this term and falls to `id`."*; `nameHash` and `recency` added to the
interface; two clauses inserted:

```ts
if (a.nameHash !== b.nameHash) return b.nameHash - a.nameHash;   // DESC, after type
// … existing size clause …
if (a.recency !== b.recency) return a.recency - b.recency;       // ASC, before id
```

`id` **stays** as the final term. The comparator gets **no conditional and no sentinel check** —
transitivity is structural. `deltify.ts` normalises absence in the one place it builds keys, and
Part 3's `buildPack` guard makes a mixed input unrepresentable, so within one sort either every
key carries a caller ordinal or every key carries `NO_RECENCY`. `b.nameHash - a.nameHash` and
`a.recency - b.recency` are exact: both operands are non-negative integers below 2**53.

**The module docblock at `:29-33`** currently reads *"Total order: (type ASC, uncompressedSize
DESC, id ASC). No two distinct objects compare equal, because oids are unique — which is what
makes the sort stable regardless of the input array's order."* Restate the key; **keep** the
uniqueness sentence (it still holds) and qualify the stability sentence — it is a function of
per-object values only in the recency-absent mode.

**`deltify.ts`'s one change.** `boundCarriedContent` (`:93-117`) builds each key at `:102-107`:

```ts
const key = {
  id,
  sourceIndex: i,
  type: objectTypeToPackEntryType(meta.type),
  uncompressedSize: meta.uncompressedSize,
};
```

It gains `nameHash: 0` and `recency: NO_RECENCY` as **literal constants** — the input still has no
hashes to read; Part 3 turns them into `object.nameHash ?? 0` / `object.recency ?? NO_RECENCY`.
Import `NO_RECENCY` alongside the existing `delta-policy.js` imports at `deltify.ts:18-24`.

**This is why Part 2 is byte-neutral**: the same constant on every key in the sort makes both new
clauses unreachable, so no order changes. See "How byte-neutrality is proved" above; an edited
expectation anywhere in the pack-writing surface is a stop-and-escalate.

**The test helper.** `delta-policy.test.ts:13-17` is
`const key = (id, type, uncompressedSize): PackEmissionKey => ({ id, type, uncompressedSize })`,
called positionally with exactly three arguments at `:24-26`, `:43-45`, `:60-62`, `:77-79`,
`:94-96`, `:113-115`. Give it two **optional parameters with defaults** — `nameHash = 0`,
`recency = NO_RECENCY` — so all six existing call sites compile unchanged. The design is explicit
that "the existing id cases stay as they are" and that the duplicate-oid case at `:109-125` is
untouched.

**`NO_RECENCY` is public** (design §8). `delta-policy.ts` has **no** barrel line today, so this
adds the module's first. `PackEmissionKey` and `DeltaPolicy` stay **internal** — verified: zero
`reports/api.json` mentions.

### TDD steps

Seven new cases, each a separate `it` under its own Given/When, in
`test/unit/domain/storage/delta-policy.test.ts`'s existing `describe('comparePackEmissionOrder')`
(`:19`).

- **RED 1 — hash precedes size.** Same type; `nameHash` order **disagrees** with size order.
  Expected failure: `nameHash` is not a property of `PackEmissionKey` → a `check:types` error,
  which is the genuine RED. **GREEN:** add the field and the clause.
- **RED 2 — hash is DESC.** Two keys differing only in `nameHash`: the **larger** sorts first.
  This is the case that kills `a.nameHash - b.nameHash`; RED 1 alone does not.
- **RED 3 — size precedes recency.** Two keys whose size order disagrees with their recency order:
  size wins.
- **RED 4 — recency precedes id.** Two keys whose recency order disagrees with their id order:
  recency wins.
- **RED 5 — recency is ASC.** Two keys differing only in `recency`: the **smaller** sorts first.
  Kills the flipped subtraction.
- **RED 6 — the recency-absent mode.** Two keys both at `NO_RECENCY`, differing only in `id`: `id`
  decides, exactly today's order. This is the arm that proves the new term is inert when nobody
  opts in.
- **RED 7 — strict total order in both modes.** Mirror the existing `:90-107` case's shape twice:
  one pair with distinct recencies, one pair both at `NO_RECENCY`. For each assert
  `forward !== 0` and `Math.sign(forward) === -Math.sign(backward)`.
- **Unchanged:** the duplicate-oid case at `:109-125` must stay green **with no edit**. It is the
  proof that the two new terms did not accidentally make equal keys unequal.
- **GREEN.** Implement the two clauses and `NO_RECENCY`; fill the two constants in
  `boundCarriedContent`; add the barrel line.
- **REFACTOR.** Rewrite the `:29-33` docblock. Confirm the comparator is still five early-return
  clauses and one `return 0`, no nesting, no conditional on presence.
- **The byte-neutrality run.** Execute the whole pack-writing surface listed above and confirm
  **no assertion needed a new expected value**.

### Gate

```
npx vitest run test/unit/domain/storage/delta-policy.test.ts
npx vitest run test/unit/application/primitives/build-pack.test.ts test/unit/application/primitives/internal
npx vitest run test/unit/application/commands/pack-objects.test.ts test/unit/application/commands/bundle-create.test.ts test/unit/application/commands/maintenance.test.ts
npx vitest run --project integration test/integration/delta-pack-interop.test.ts test/integration/rev-write-interop.test.ts test/integration/maintenance-interop.test.ts
npx vitest run --project unit --coverage
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/domain/storage/delta-policy.ts src/domain/storage/index.ts src/application/primitives/internal/deltify.ts test/unit/domain/storage/delta-policy.test.ts
npm run check:spelling
npm run docs:json
```

### Commit

```
feat(pack): order pack emission by name hash and an optional recency
```

---

## Part 3 — `buildPack` takes identified objects, not a bare oid array

### Context

Design §4f (`sed -n '693,740p'`), §8 (`sed -n '980,1000p'`), ADR-827, ADR-832.
Requirements **R8**, **R10**, **R11**.

**This part changes no behaviour.** Its diff is pure migration and its gate is "every existing
test green modulo the type". It lands **before** the closure engine starts emitting a hash
(Part 6) precisely so no pass-through caller can pick one up here — design §12's rule 2.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/application/primitives/build-pack.ts` | `PackObjectInput` (new), `BuildPackInput`, `WriterPlan`, `resolveWriterPlan`, `buildBaseEntries`, the `emissionOrder` docblock, the mixed-recency guard |
| edit | `src/application/primitives/internal/deltify.ts` | `deltifyEntries`, `buildEmissionOrder`, `boundCarriedContent` take `objects`; `DeltifiedEntry.sourceIndex`'s docblock |
| edit | `src/domain/storage/error.ts` | `INVALID_PACK_INPUT` union member + `invalidPackInput` factory |
| edit | `src/domain/storage/index.ts` | `invalidPackInput` in the value export list |
| edit | `src/domain/error.ts` | one `case` in `extractDetail`'s `return data.reason` group |
| edit | `src/application/primitives/index.ts` | `PackObjectInput` beside `BuildPackInput` at `:11` |
| edit | **six** `src/` call sites | table below |
| edit | `test/unit/domain/exhaustiveness.ts` | one `case` |
| edit | `test/unit/domain/storage/error.test.ts` | one describe for the new factory |
| edit | **four** `buildPack` test files | 25 + 1 + 2 + 1 call sites, table below |
| edit | **three** `deltifyEntries` test files + **one** bench | 24 + 1 call sites, table below |
| regenerate | `reports/api.json` | breaking + additive public surface |

**Current shape, verbatim** (`build-pack.ts` is 139 lines):

```ts
export interface BuildPackInput {                            // :28-32
  readonly oids: ReadonlyArray<ObjectId>;
  /** Emit OFS_DELTA entries where a delta is strictly smaller on disk. Default false. */
  readonly delta?: boolean;
}
interface WriterPlan {                                       // :51-56
  readonly ids: ReadonlyArray<ObjectId>;
  readonly entries: ReadonlyArray<PackWriterEntry>;
  /** Emission ordinal -> index into `input.oids`. */
  readonly emissionOrder: Uint32Array;
}
async function resolveWriterPlan(ctx, input): Promise<WriterPlan> {          // :95-108
  if (input.delta !== true) return buildBaseEntries(ctx, input.oids);
  const config = await readConfig(ctx);
  const policy = resolveDeltaPolicy(config.pack ?? {});
  if (!policy.enabled) return buildBaseEntries(ctx, input.oids);
  const deltified = await deltifyEntries(ctx, input.oids, policy);
  …
}
async function buildBaseEntries(ctx, oids: ReadonlyArray<ObjectId>): Promise<WriterPlan> { … }  // :110-125
```

**The target** (design §4f, verbatim):

```ts
export interface PackObjectInput {
  readonly id: ObjectId;
  /** git's `pack_name_hash` of the object's path. Absent, or `0`, for an object
   *  the caller has no path for — what git itself does for an object it has no
   *  name for. */
  readonly nameHash?: number;
  /** The caller's first-seen ordinal — git's pointer-order tiebreak in the one
   *  form a caller can reproduce. Present on every object or on none: a mixed
   *  input is refused. When present the pack's bytes are a function of the
   *  sequence as well as the set, so pass a deterministic one. */
  readonly recency?: number;
}
export interface BuildPackInput {
  readonly objects: ReadonlyArray<PackObjectInput>;
  readonly delta?: boolean;
}
```

**The guard runs first — before `readConfig`, before any read, and regardless of `delta`**, since
a mixed input is a caller defect whatever path follows. It throws
`invalidPackInput('mixed-recency', present, absent)`, where `present` counts objects carrying
`recency` and `absent` counts those that do not; the refusal condition is
`present > 0 && absent > 0`. Put it at the top of `buildPack` (`:58`), **not** inside
`resolveWriterPlan` — that function's first line already branches on `delta`.

**`buildBaseEntries` takes `objects` and reads `object.id`** in input order; it needs no key. Its
existing `Stryker disable next-line EqualityOperator` comment at `:118-122` anchors on the `for`
loop at `:123` — keep the two glued together and update the comment's `oids.length` wording to
`objects.length`, so the equivalence proof still describes the code it guards.

**`deltify.ts`.** `deltifyEntries(ctx, oids, policy)` (`:286-290`) →
`deltifyEntries(ctx, objects, policy)`. `buildEmissionOrder(ctx, oids)` (`:119-128`) →
`(ctx, objects)`; its `boundedMapFor` at `:123-125` currently maps
`(id) => readObjectMetadataWithContent(ctx, id)` and becomes
`(object) => readObjectMetadataWithContent(ctx, object.id)`.
`boundCarriedContent(oids, metas, budget)` (`:93-117`) → `(objects, metas, budget)`; its
`for (const [i, id] of oids.entries())` at `:100` becomes `objects.entries()`, and Part 2's two
constants become `nameHash: object.nameHash ?? 0` and `recency: object.recency ?? NO_RECENCY`.
**Both `??` arms need their own covered row** — `src/application/**` is not coverage-gated, but
Stryker mutates it and each `??` is a live mutant.

`DeltifiedEntry.sourceIndex`'s docblock (`:44-48`) says *"Emission order is the packer's own
(type, size, oid)"* — restate to the new key. `EmissionEntry.sourceIndex`'s (`:53-55`) says
*"Index into `deltifyEntries`' input list"* — still true, no edit.

**`BuildPackResult.emissionOrder`'s docblock (`:43-48`)** is restated to: *"Emission ordinal →
index into the `objects` this build was given. The packer emits in its own
`(type, nameHash, size, recency, oid)` order, so a caller holding per-object data keyed by ITS
order — `gc`'s cruft mtimes are the case — maps across with this instead of decoding an oid per
object."* `WriterPlan.emissionOrder`'s one-liner at `:54` likewise. **The value is unchanged**
(R10): the `.idx`, `.rev`, cruft `.mtimes` and midx paths are all oid-keyed and untouched.

**The new error code trips five surfaces** — it is a discriminated-union member, not a one-liner:

1. `src/domain/storage/error.ts` — the `StorageError` union is `:43-72`, nine members today, each
   `{ readonly code: '…'; … }`. Add a tenth with `reason: string; present: number; absent: number`.
   The factories are `:74-99`, all of the form
   `export const invalidX = (…): TsgitError => new TsgitError({ code: 'INVALID_X', … });`.
2. `src/domain/storage/index.ts` — the value export list is `:20-29`, alphabetical:
   `invalidCruftMtimes, invalidDelta, invalidMultiPackIndex, invalidPackBitmap, invalidPackEntry,
   invalidPackHeader, invalidPackIndex, invalidPackRevIndex`. `invalidPackInput` sorts **between**
   `invalidPackIndex` and `invalidPackRevIndex` (`Index` < `Input`, then `I` < `R`).
3. `src/domain/error.ts` — `extractDetail`'s `switch` at `:216`; the group returning `data.reason`
   runs `:220-238`. Insert `case 'INVALID_PACK_INPUT':` beside `case 'INVALID_PACK_INDEX':`
   (`:227`) — that list is grouped by family, not alphabetical.
4. `test/unit/domain/exhaustiveness.ts:13` `assertExhaustiveSwitch` — its `never` default arm is a
   **compile-time** gate. **Adding the union member without this case makes `check:types` red, and
   that is Part 3's first genuine RED.** `case 'INVALID_CRUFT_MTIMES':` sits at `:29`.
5. `test/unit/domain/storage/error.test.ts` — one `describe("Given invalidPackInput(…)")` inside
   the `describe('factory functions')` block at `:16`, asserting `result.data` with `toEqual` on
   all four fields. `assertExhaustiveSwitch` is already imported at `:13`.

`docs/use/errors.md` has **no mechanical gate** — it is Part 13's row.

**The six `src/` call sites** (verified; design §Corrections 7 — six, not five):

| File:line | Today | Becomes |
|---|---|---|
| `src/application/commands/push.ts:353` | `buildPack(ctx, { oids })` | `buildPack(ctx, { objects: oids.map((id) => ({ id })) })` — the **only** base-only caller; it gains nothing from this work and pays only the migration |
| `src/application/commands/pack-objects.ts:86-87` | `const oids = closure.objects.map((object) => object.id);` then `buildPack(ctx, { oids, delta: true })` | `buildPack(ctx, { objects: closure.objects.map((o) => ({ id: o.id })), delta: true })`. **Keep the `.map`** — Part 8 deletes it once Part 6 has put `nameHash` on the closure object |
| `src/application/commands/internal/gc-pipeline.ts:484` | `buildPack(ctx, { oids, delta: true })` in `buildAndWriteNormalPack` (`:476-498`) | `{ objects: oids.map((id) => ({ id })), delta: true }` |
| `…/gc-pipeline.ts:527` | same, in `buildAndWritePromisorPack` (`:520-540`) | same |
| `…/gc-pipeline.ts:560` | `buildPack(ctx, { oids: survivors, delta: true })` in `buildAndWriteCruftPack` (`:553-573`) | `{ objects: survivors.map((id) => ({ id })), delta: true }`. The `mtimeAt` closure at `:570` reads `survivors[pack.emissionOrder[ordinal]!]` — **unchanged**; `emissionOrder` still indexes this call's own array |
| `src/application/commands/bundle-create.ts:312` | `buildPack(ctx, { oids: closure.objects, delta: true })` — it passes the enumerator's array **directly**; there is no local `oids` | `{ objects: closure.objects.map((id) => ({ id })), delta: true }`. Part 9 deletes this `.map` |

**The four `buildPack` test files — 29 real call sites, not 31:**

- `test/unit/application/primitives/build-pack.test.ts` — **25**, at `:87, :116, :139, :212, :231,
  :253, :281, :305, :338, :356, :392, :431, :432, :452, :453, :474, :475, :494, :495, :514, :515,
  :537, :573, :574, :609`. All mechanical.
- `test/unit/application/primitives/fetch-pack.test.ts` — **one**, at `:3437`.
  ⚠️ `:3799` and `:3800` call a **local shadow** `const buildPack = async (label: string) => {…}`
  declared at `:3783-3793` around `buildSyntheticPack`. **Do not touch them.**
- `test/integration/delta-pack-interop.test.ts` — **two**, at `:872` and `:873`, where `oids` comes
  from `enumerateObjects(ctx, { includePacks: false })` at `:868`.
- `test/integration/rev-write-interop.test.ts` — **one**, at `:596`; `oids` is filled by the
  `SCALE_OBJECTS` loop at `:587-595`.

Spy-only sites assert `expect.objectContaining({ delta: true })` on `mock.calls[0]![1]` and do
**not** break on the rename — `maintenance.test.ts` (`:1996`, `:2023`, `:2050`) and
`bundle-create.test.ts:312`. Leave them; Parts 8 and 9 strengthen them.

**`deltifyEntries` has its own callers, and `check:types` covers every one of them.**
`check:types` runs `tsc -p tsconfig.typecheck.json` over `src/**/*.ts`, `test/**/*.ts` **and**
`tooling/**/*.ts`, so `test/bench/**` is type-checked even though no suite in `validate` runs it.
Each of these passes an `ObjectId[]` as the second argument and breaks on the signature change:

| File | Sites | Shape |
|---|---|---|
| `test/unit/application/primitives/internal/deltify.test.ts` | **13** | `await sut(ctx, [idA, idB], DEFAULT_POLICY)` / `await sut(ctx, ids, policy)`, with `sut` bound to `deltifyEntries` |
| `test/unit/application/primitives/internal/deltify-window-eviction.test.ts` | **7** | same shape; `sut` bound at `:73, :102, :132, :164, :193, :218, :254` |
| `test/unit/application/primitives/internal/deltify-carried-content.test.ts` | **4** | same shape |
| `test/bench/deltify.bench.ts:65` | **1** | `await deltifyEntries(ctx, oids, policy)` inside the `sut` closure at `:64-66`; its `oids` array is built at `:53-61` |

⚠️ **The bench is the one that gets forgotten** — nothing in `validate` *runs* it, so only
`check:types` catches it, and a wireit-cached `check:types` reads exactly like a pass. Run the
bare `npx tsc --noEmit -p tsconfig.json` after the migration.

**Barrel.** `src/application/primitives/index.ts:11` is
`export type { BuildPackInput, BuildPackResult } from './build-pack.js';` — add `PackObjectInput`
(alphabetically last of the three). Note `:96` is `export type * from './types.js'`: only serena's
`find_referencing_symbols` resolves references through an `export type *` barrel, so use serena,
not grep, when checking consumers of anything re-exported there.

**Degenerate inputs keep today's behaviour**: an empty `objects` builds the empty pack
(`build-pack.test.ts:87` already pins it); a single object is emitted as a base whatever its
fields, because a one-entry sort has no order to change.

### TDD steps

- **RED 1 — the exhaustiveness gate.** Add the `INVALID_PACK_INPUT` member to `StorageError`
  **first** and run `npx tsc --noEmit -p tsconfig.json`. Expected failure: the `never` assignment
  in `assertExhaustiveSwitch`'s default arm no longer type-checks. **GREEN:** add the case there
  and in `extractDetail`; add the factory and the barrel line; add the `error.test.ts` describe
  asserting `code`, `reason`, `present`, `absent`.
- **RED 2 — mixed recency is refused, from both sides.** Two cases in `build-pack.test.ts`, so the
  count arithmetic is tested from both directions: (a) one bare object among many carrying
  `recency`; (b) one object carrying `recency` among many bare. Use **try/catch plus direct
  `.data` assertions**, never `toThrow(expect.objectContaining(…))` — nested property mutations
  survive the latter. Assert `code === 'INVALID_PACK_INPUT'`, `reason === 'mixed-recency'`, and
  the exact numeric `present` and `absent`. Expected failure before GREEN: no throw at all. The
  two cases together kill the `present === 0 || absent === 0` mutants **and** the off-by-one at a
  single bare object.
- **RED 3 — refused before any I/O.** The same fixture with `vi.spyOn` on the config-read and
  object-read modules: assert **neither** was called. Without this the guard could sit anywhere.
- **RED 4 — the guard is independent of `delta`.** The same mixed input with `delta` absent must
  refuse identically. A guard placed inside `resolveWriterPlan` would pass RED 2 and fail this.
- **GREEN — the migration.** Change the types, thread `objects` through `resolveWriterPlan`,
  `buildBaseEntries`, `deltifyEntries`, `buildEmissionOrder` and `boundCarriedContent`, then walk
  the six `src/` sites, the 29 `buildPack` test sites and the 25 `deltifyEntries` sites (24 in
  tests, one in the bench). Run `npx tsc --noEmit -p tsconfig.json` after the type change alone and
  let the compiler enumerate the call sites — do not hand-hunt them.
- **RED 5 — the `??` arms.** `object.nameHash ?? 0` and `object.recency ?? NO_RECENCY` each need a
  row where the field is **absent** and one where it is **present**. Absent is covered by every
  migrated test; present needs REDs 6 and 7.
- **RED 6 — hashes reorder, absence does not.** Two same-size blobs of the same type: supplied
  with different `nameHash` values they reorder; supplied with none they keep today's `id` order.
  Assert on `emissionOrder`, not on bytes.
- **RED 7 — the recency-present mirror pair** (design §Test strategy), placed **beside**
  `:441-480`'s recency-absent pair so the two modes read as a pair: (a) the same sequence with the
  same ordinals twice → equal bytes; (b) a tie-dense trio (same type, same size, same hash) under
  two different ordinal assignments → **different** bytes with the same object set read back.
  (b) is the test that shows the recency-present mode is sequence-keyed.
- **Unchanged, load-bearing:** `:418-437` (same input twice → same bytes) and `:441-459` /
  `:462-480` (shuffled and permuted, no recency → same bytes) keep their assertions; only the
  `oids` → `objects` shape moves. **An edited expectation here is a stop-and-escalate.**
- **REFACTOR.** Extract the mixed-recency count into a small named helper if the guard pushes
  `buildPack` past 20 lines. Confirm no call site kept a stale `oids` local name.
- **The byte-neutrality run.** The whole pack-writing surface, no expectation edited.

### Gate

```
npx vitest run test/unit/application/primitives/build-pack.test.ts test/unit/application/primitives/fetch-pack.test.ts test/unit/application/primitives/internal
npx vitest run test/unit/domain/storage/error.test.ts
npx vitest run test/unit/application/commands/pack-objects.test.ts test/unit/application/commands/bundle-create.test.ts test/unit/application/commands/maintenance.test.ts test/unit/application/commands/push.test.ts
npx vitest run --project integration test/integration/delta-pack-interop.test.ts test/integration/rev-write-interop.test.ts test/integration/maintenance-interop.test.ts
npx vitest run --project unit --coverage
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check <every touched file>
npm run check:spelling
npm run check:dead-code
npm run docs:json
```

### Commit

```
feat(pack)!: take identified objects on the pack input, not a bare oid array
```

The `!` is load-bearing: `BuildPackInput.oids` is removed from a published type. It folds into the
pending major — `main` already carries three `feat(…)!:` commits since `v3.6.0`.

---

## Part 4 — `walkTree` folds the name hash per frame

### Context

Design §4a (`sed -n '553,576p'`), ADR-828 first half. Requirement **R5**'s producer side.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/application/primitives/walk-tree.ts` | `WalkFrame`, `enterTree`, `FrameStep`, `nextFrameEntry`, the `walkTree` loop |
| edit | `src/application/primitives/types.ts` | `WalkTreeEntry` (`:171-175`), `WalkTreeOptions` (`:177-186`) |
| edit | `test/unit/application/primitives/walk-tree.test.ts` | one new `describe` block |
| regenerate | `reports/api.json` | both types are published |

**Current shape, verbatim** (`walk-tree.ts` is 162 lines):

```ts
interface WalkFrame {                                                    // :40-46
  readonly entries: ReadonlyArray<TreeEntry>;
  index: number;
  readonly prefix: string;
  readonly depth: number;
  readonly id: ObjectId;
}
function enterTree(maxDepth, tree: Tree, prefix: string, depth: number,  // :59-70
                   ancestry: Set<ObjectId>): WalkFrame {
  if (ancestry.has(tree.id)) throw treeCycleDetected(tree.id);
  if (exceedsMaxTreeDepth(depth, maxDepth)) throw treeDepthExceeded(depth);
  ancestry.add(tree.id);
  return { entries: tree.entries, index: 0, prefix, depth, id: tree.id };
}
interface FrameStep { readonly path: FilePath; readonly entry: TreeEntry; }   // :86-89
function nextFrameEntry(config, counter, frame): FrameStep {             // :96-106
  const entry = frame.entries[frame.index]!;
  frame.index += 1;
  if (config.ctx.signal?.aborted) throw operationAborted();
  const path = (frame.prefix === '' ? entry.name : `${frame.prefix}/${entry.name}`) as FilePath;
  counter.value += 1;
  if (exceedsMaxTreeEntries(counter.value, config.maxEntries)) {
    throw treeEntryLimitExceeded(counter.value, config.maxEntries);
  }
  return { path, entry };
}
// in walkTree:
const stack: WalkFrame[] = [enterTree(config.maxDepth, rootTree, '', 0, ancestry)];   // :131
const { path, entry } = nextFrameEntry(config, counter, frame);                       // :139
yield { path, id: entry.id, mode: entry.mode as FileMode };                           // :140
stack.push(enterTree(config.maxDepth, subtreeObj, path, frame.depth + 1, ancestry));  // :144
```

`WalkTreeEntry` is `types.ts:171-175` — `{ path: FilePath; id: ObjectId; mode: FileMode }`.
`WalkTreeOptions` is `:177-186` — `recursive?`, `maxDepth?`, `maxEntries?`.

**The change.** `WalkTreeOptions` gains `pathHasher?: PathHasher` (imported from
`src/domain/storage/pack-name-hash.js`, Part 1). `WalkTreeEntry` gains `nameHash?: number`,
present **exactly when** a hasher was supplied. `WalkFrame` gains `readonly hashState: number` —
the fold state of the frame's own `prefix`; the root frame built at `:131` starts from
`hasher.seed`. `nextFrameEntry` computes, per yielded entry:

```
state    = frame.prefix === '' ? frame.hashState : hasher.fold(frame.hashState, SLASH)
nameHash = hasher.fold(state, entry.nameBytes)
```

and `FrameStep` carries it so `enterTree` at `:144` can receive it as the child frame's
`hashState`. `SLASH` is a module-level `Uint8Array.of(0x2f)` constant, allocated once.

**The fold consumes `entry.nameBytes`, never `entry.name` or the joined `path` string.**
`TreeEntry` (`src/domain/objects/tree.ts:27-36`) is branded and carries `nameBytes` as the
authoritative value beside a **derived, lossy** `name` whose own docblock says it is "never read
to make a decision". An invalid-UTF-8 name decodes to U+FFFD, so two distinct on-disk names
collide in `name` — hashing the decoded view would make tsgit disagree with git for exactly the
names the byte-sensitivity work exists to handle.

**The empty-prefix guard is git's own rule** (`if (base->len) strbuf_addch(base, '/')`): a
root-level entry is hashed as `name`, not `/name`. It is also a mutant that must be killed **in
isolation** — a nested-only test does not kill it.

**Cost when off**: one `undefined` check per entry. All fourteen existing `walkTree` consumers
(`ls-tree`, `checkout`, `status`, diff, …) pay nothing and **see no new field**. Cost when on:
one fold over the entry's own name bytes (not the whole path) plus 8 bytes per frame, zero
allocation per entry.

**The yield becomes a conditional spread**, so `toStrictEqual` can see key presence:

```ts
yield {
  path,
  id: entry.id,
  mode: entry.mode as FileMode,
  ...(step.nameHash !== undefined ? { nameHash: step.nameHash } : {}),
};
```

⚠️ **`toEqual` ignores an `undefined` property and cannot see this.** Every shape assertion in
this part uses `toStrictEqual`.

**Test fixtures already in the file.** `walk-tree.test.ts` (525 lines) imports `walkTree` (`:3`),
`writeObject` (`:4`), `writeTree` (`:5`), `treeEntry` (`:9`), and
`buildSeededContext, buildTreeChain, seedMaxTreeDepth` from `./fixtures.js` (`:10`); it has a
module-level `collect(iter): Promise<WTE[]>` helper at `:12-16`. `describe('walkTree')` opens at
`:18`; the nested-tree fixture pattern is at `:61-81` and `:204-225`. For the invalid-UTF-8 name,
`treeEntry(FILE_MODE.REGULAR, new Uint8Array([0xff]), id)` is the shape —
`test/unit/application/primitives/flatten-tree.test.ts:547-550` is the working precedent (and that
file already imports `walkTree`).

**`buildSeededContext`** is `test/unit/application/primitives/fixtures.ts:156-194`; it is on
`test-pyramid-budgets.json`'s `sutBindsResult` allowlist, so `const ctx = await buildSeededContext(…)`
does not trip the `sut` heuristic.

### TDD steps

One new `describe('Given a walkTree call with a path hasher')` inside the existing
`describe('walkTree')` at `:18`.

- **RED 1 — no hasher, no field.** `toStrictEqual` on the **exact** yielded object shape:
  `{ path, id, mode }` and nothing else. Expected failure: none yet — write it first anyway, it is
  the pin that the option is genuinely opt-in, and it is the assertion that goes red
  the moment someone makes `nameHash` unconditional.
- **RED 2 — a root-level entry hashes `name`, not `/name`.** One flat tree, hasher on; assert
  `entry.nameHash === packNameHash(nameBytes)` **and** `!== packNameHash(concat(SLASH, nameBytes))`.
  Expected failure: `pathHasher` is not a property of `WalkTreeOptions` → `check:types` error.
  This is the isolated killer for the `frame.prefix === ''` guard.
- **GREEN 2.** Add the option, the `WalkFrame.hashState` field, the `enterTree` parameter, the
  `FrameStep` field, and the conditional spread.
- **RED 3 — a nested entry folds the full path with `/`.** Build `deep/er/churn.txt` and assert
  the yielded `nameHash` equals `0x9a8be7c7` — Part 1's vector table row, reused as the
  cross-layer oracle. Also assert the intermediate tree entries' hashes against `packNameHash` of
  their own paths.
- **RED 4 — invalid-UTF-8 name bytes are hashed as bytes.** A tree entry whose name is
  `Uint8Array.of(0xff)`: assert `nameHash === packNameHash(Uint8Array.of(0xff))` (i.e.
  `0xff000000`) and **not** `packNameHash(encode(entry.name))` — the decoded view is U+FFFD
  (`ef bf bd`) and hashes differently. Compute both sides from `packNameHash` directly; no spy.
- **RED 5 — first-seen semantics are the caller's, not the walker's.** The walker yields a hash
  per *entry*; an object reachable under two paths is yielded twice with two hashes. Assert that
  explicitly, so Part 6's dedup responsibility is documented at the seam rather than assumed.
- **REFACTOR.** `SLASH` is a named module constant. `enterTree` now takes six parameters — leave
  it; **Part 5 collapses `prefix`/`hashState`/`prefixBytes` into one `FramePrefix` value object**
  (PC-1). Do not anticipate that here; a half-done extraction across two parts is worse than one
  clean one.
- **No behaviour change for anyone else:** run the full `walk-tree.test.ts` plus every consumer
  suite that walks trees (`ls-tree`, `checkout`, `status`, the diff suites). No expectation moves.

### Gate

```
npx vitest run test/unit/application/primitives/walk-tree.test.ts
npx vitest run test/unit/application/primitives test/unit/application/commands
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/walk-tree.ts src/application/primitives/types.ts test/unit/application/primitives/walk-tree.test.ts
npm run check:spelling
npm run docs:json
```

### Commit

```
feat(walk-tree): fold a caller-supplied path hash over entry name bytes
```

---

## Part 5 — `walkTree` yields path bytes on request

### Context

Design §4g (`sed -n '741,785p'`), ADR-828 second half. Requirement **R15**.

**This part ships an option with no production caller** — the test is the consumer. That is
deliberate and ratified: `walkTree`'s surface exposes only the decoded, lossy `path`, so a
consumer that must decide on bytes (the class the byte-sensitivity work created) cannot get them
through the walker at all today. All twelve `walkTree` call sites were surveyed; **zero** read
name bytes through it, and the byte-level consumers that exist (`resolve-tree-path`,
`walk-submodules`, fsck, archive) bypass the walker and read `tree.entries` directly. The gap is
latent, and ADR-828 accepted closing it without a first consumer rather than leaving a public
walker that can only lie about names.

**Files:** the same four as Part 4 (`walk-tree.ts`, `types.ts`, `walk-tree.test.ts`,
`reports/api.json`).

**Option shape.** `WalkTreeOptions.pathBytes?: boolean`, default `false`.
`WalkTreeEntry.pathBytes?: Uint8Array`, present on every yielded entry exactly when the option is
on.

**What it yields.** The entry's full path as bytes: every ancestor's `nameBytes` and the entry's
own, joined by `0x2f`, **no leading or trailing separator**; a root-level entry is its `nameBytes`
alone. A **fresh `Uint8Array` per entry**, owned by the consumer — the same ownership rule
`TreeEntry.nameBytes` states — so a consumer may keep or mutate it without touching the walk.
`path` is unchanged and stays the display view; `path === decodePreservingBom(pathBytes)` holds
only for names that decode losslessly, which is exactly the point.

**Mechanics.** `WalkFrame` gains `readonly prefixBytes: Uint8Array | undefined` — the frame's own
private copy of its tree's path bytes, `undefined` when the option is off and an **empty array**
at the root. `nextFrameEntry` builds
`prefixBytes.length === 0 ? nameBytes.slice() : concat(prefixBytes, SLASH, nameBytes)`;
`enterTree` receives a **copy** of the directory entry's `pathBytes` as the child frame's
`prefixBytes`, so the array handed to the consumer and the array the walker keeps are never the
same object.

⚠️ **`prefixBytes.length === 0` is a second, separate root guard** from Part 4's
`frame.prefix === ''`. Each needs its own isolated root-level test; one test covering both leaves
one mutant alive.

`concatBytes` is at `src/domain/objects/encoding.ts:46`; `decodePreservingBom` at `:93`.

**Interaction with the other options.** `recursive: false` yields root-level entries with
`pathBytes === nameBytes.slice()` and never enters a frame. `maxDepth` and `maxEntries` fire in
`enterTree` / `nextFrameEntry` **before** any bytes are built, exactly as for `path`. `pathHasher`
is independent: both on yields both fields, and the hash is still folded from `nameBytes` per
frame, never re-derived from `pathBytes`.

**The REFACTOR this part owns (PC-1).** `enterTree` would reach seven parameters. Collapse
`prefix`, `hashState` and `prefixBytes` into one `FramePrefix` value object — a frame's inherited
path in three representations, which is one concept — and pass that. `enterTree` returns to five
parameters and the primitive-obsession smell the house rules refuse in touched code goes away.

### TDD steps

Its own `describe('Given a walkTree call with pathBytes enabled')`, separate from Part 4's block.

- **RED 1 — option off, no field.** `toStrictEqual` on the exact yielded shape; and with the
  **hasher on but `pathBytes` off**, the shape is `{ path, id, mode, nameHash }` — the fold alone
  adds no `pathBytes`. Two assertions, one `it` each.
- **RED 2 — root-level entry.** `pathBytes` equals `nameBytes` **and is not the same object**:
  assert `toEqual` on contents plus `expect(result.pathBytes).not.toBe(entry.nameBytes)`. That
  second assertion is the `slice()` mutant's killer.
- **RED 3 — nested entry.** The byte concatenation with `0x2f` and **no trailing separator**; a
  two-level plain-ASCII path round-trips to `path` through `decodePreservingBom`.
- **RED 4 — the gap it closes.** Two sibling entries whose names are an invalid-UTF-8 byte
  sequence and its U+FFFD encoding (`ef bf bd`): equal `path`, **unequal** `pathBytes`. This is
  the load-bearing test of the whole part. `flatten-tree.test.ts:536-564` is the precedent for
  building such a tree through the real `writeTree`.
- **RED 5 — `recursive: false`.** Root-level `pathBytes` only; no frame entered.
- **RED 6 — `maxDepth` fires before any bytes are built.** Assert the thrown error's `depth` and
  that **no entry was yielded past it**. Arrange so the depth refusal is the only thing that can
  stop the walk.
- **RED 7 — both options on.** For every entry, `nameHash === packNameHash(pathBytes)`. This is
  the cheapest cross-check of the two mechanisms against each other and it would catch a fold that
  silently drifted from the byte path.
- **RED 8 — the private-copy rule.** Mutate a yielded `pathBytes` in place, then continue the walk
  and assert a later sibling's and a child's bytes are unaffected.
- **REFACTOR — `FramePrefix`.** Introduce the value object, move the two root guards onto it, and
  re-run. Confirm `enterTree` is back to five parameters and `nextFrameEntry` stays under 20 lines.
- ⚠️ **`check:dead-code`.** The option ships with no `src/` consumer. knip sees reachability
  through the test files (`knip.json`'s `vitest.config` entry registers the suite's `include`
  globs), and `WalkTreeOptions`/`WalkTreeEntry` are published types besides. If knip flags
  anything here, **escalate** — never a knip ignore.

### Gate

```
npx vitest run test/unit/application/primitives/walk-tree.test.ts
npx vitest run test/unit/application/primitives test/unit/application/commands
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/walk-tree.ts src/application/primitives/types.ts test/unit/application/primitives/walk-tree.test.ts
npm run check:spelling
npm run check:dead-code
npm run docs:json
```

### Commit

```
feat(walk-tree): yield an entry's full path as bytes on request
```

---

## Part 6 — the closure engine carries a name hash on the walk tier

### Context

Design §4b (`sed -n '577,597p'`), §1c (`sed -n '376,395p'`), §5 (`sed -n '871,892p'`), ADR-830.
Requirement **R5**.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/application/primitives/internal/closure-engine.ts` | `ClosureObject`, `Emit`, `emitTree`, `resolveWants`, the commit emitters, `walkClosure` |
| edit | `test/unit/application/primitives/internal/closure-engine.test.ts` | extend existing assertions, add four cases |
| edit | the bitmap-tier closure test | assert field **absence** |

**Current shape, verbatim** (`closure-engine.ts` is 276 lines):

```ts
export interface ClosureObject {                    // :67-75
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  /** … the bitmap tier never fills this … */
  readonly path?: FilePath;
}
type Emit = (id: ObjectId, type: ClosureObject['type'], path?: FilePath) => void;   // :86
const ROOT_PATH = '' as FilePath;                   // :91
const emitTree = async (ctx, treeId, marked, emit) => {                 // :100-112
  …
  emit(treeId, 'tree', ROOT_PATH);                                      // :106 (root)
  for await (const entry of walkTree(ctx, treeId)) {                    // :107
    … emit(entry.id, isDirectory(entry.mode) ? 'tree' : 'blob', entry.path);   // :110
  }
};
const resolveWants = async (ctx, wants, emit): Promise<Commit[]> => { … }   // :121-141
//   :128 resolveTagChain emits tags;  :134-137 tree want → emitTree;  :138 blob want → emit(peeled, 'blob')
const walkAndEmitCommits = …                                            // :172-196
//   :192-195 emit the commit, then emitTree(ctx, commit.data.tree, marks.objects, emit)
const walkClosure = async (ctx, request) => {                           // :212-225
  const emit: Emit = (id, type, path) => {                              // :215-218
    if (!tryEmit(state, id)) return;
    results.push(path === undefined ? { id, type } : { id, type, path });
  };
  …
};
```

`tryEmit` is **imported** from `./object-emit.js` (`:34`), not defined here.

**The change.** `ClosureObject` gains `readonly nameHash?: number` with the doc *"git's
`pack_name_hash` of `path`; `0` for a path-less object; populated by the walk tier only — a
reachability artefact encodes types and bits, never names, so the bitmap tier never fills this"*,
mirroring `path`'s existing note at `:70-73`. `Emit` (`:86`) gains a fourth parameter.
`emitTree` walks with `{ pathHasher: PACK_NAME_HASH_V1 }` and passes `entry.nameHash`; the root
emits `PACK_NAME_HASH_SEED`. `resolveWants` and the commit emitters pass `0` **explicitly**, so on
the walk tier the field is always a number.

**Object class by class** (design §1c — this table is the oracle):

| Class | Hash | Where |
|---|---|---|
| commit | `0` | `walkAndEmitCommits` `:192` |
| tag (any hop of a tag chain) | `0` | `resolveWants` `:128` |
| root tree of a commit | `0` (= `PACK_NAME_HASH_SEED`) | `emitTree` `:106` |
| nested tree at `a/b` | `packNameHash('a/b')` — **no trailing slash** | `emitTree` `:110` |
| blob at `a/b/c.txt` | `packNameHash('a/b/c.txt')` | same |
| object seen under two paths | **the first** | `tryEmit` rejects the repeat before the hash is stored |
| directly-wanted blob or tree | `0` | `resolveWants` `:134-138` — a recorded divergence: git uses the pending object's own name |
| every bitmap-tier object | field **absent** | `tryBitmapClosure` `:241-258` is untouched |

**`ClosureObject` becomes assignable to `PackObjectInput`** — it has `id` and an optional
`nameHash`, and no `recency`. That is what lets Part 8 pass the closure's own array straight
through with no wrapper allocation.

**The fold runs on every walk-tier closure, `rev-list` included.** Its cost is a few dozen byte
operations per visited entry against a tree read and parse per tree; keeping `ClosureObject`
uniform on the walk tier is worth more than an opt-in flag on `ClosureRequest`. This is a recorded
non-decision (design §6) — do not re-open it.

**`emitTree` re-walks subtrees an earlier commit already emitted** — a pre-existing cost this
design neither adds to nor fixes. `tryEmit` rejects the repeat before the hash is stored, so the
first-seen rule holds.

**Why this part is byte-neutral:** no consumer reads the field until Part 8. `pack-objects.ts`
still maps to `{ id: o.id }` (Part 3), `bundle-create` still maps, gc still maps.

**Existing assertions that break on the added field** — these are shape assertions, not value
assertions, so updating them is expected here (unlike the pack-byte expectations, which are not):

- `closure-engine.test.ts:343` — `expect(result.objects).toEqual([{ id: blobId, type: 'blob', path: undefined }])`
- `:401` and `:464` — the same `path: undefined` shape for a commit and a tag

Rewrite these as `toStrictEqual` with the exact new shape. `toEqual`'s blindness to `undefined`
properties is precisely why the bitmap-tier absence case must use `toStrictEqual`.

**Test fixtures already in the file** (1540 lines, two top-level describes: `:193`
`describe('computeClosure')` and `:1328` the bitmap-tier one). Module-level helpers:
`writeBlob` (`:66-73`), `writeCommit` (`:75-87`), `writeTag` (`:89-108`), `buildLinearChain`
(`:122-134`, a 3-commit chain each with its own tree and blob at `file.txt`), `buildDeepTree`
(`:55-64`), `buildHavesFixture` (`:172-191`). Existing path assertions to extend:
`:242-243` (`t1` → `''`, `b1` → `'file.txt'`) and `:325-326` (root tree → `''`, nested blob →
`'sub/deep.txt'`).

### TDD steps

- **RED 1 — walk tier, root and nested.** Extend `:242-243` and `:325-326`: assert the root tree's
  `nameHash === 0` and that `file.txt` / `sub/deep.txt` carry `packNameHash` of their own paths.
  Expected failure: `nameHash` is not a property of `ClosureObject` → `check:types` error.
- **GREEN 1.** Add the field, widen `Emit`, thread `entry.nameHash` through `emitTree`, pass
  `PACK_NAME_HASH_SEED` for the root.
- **RED 2 — commits, tags and directly-wanted blobs carry `0`.** Three separate cases extending
  `:333-343`, `:401` and `:464`, each `toStrictEqual` on the exact object. Three cases, not one:
  they are three different emitters and three different mutants.
- **RED 3 — the bitmap tier carries no `nameHash` field.** `toStrictEqual` on a bitmap-tier
  closure object — the field must be **absent**, not `0`. Extend the `:1328` describe (or the
  bitmap-binding closure test, whichever holds the tier fixture). ⚠️ This is the assertion
  ADR-830 rests on and the one `toEqual` silently passes.
- **RED 4 — first-seen wins.** Arrange two commits whose trees place the **same blob** at
  different names; assert the emitted object carries the **first** commit's hash. `buildLinearChain`
  (`:122-134`) is the shape to copy; give the second generation a different entry name for the
  same blob content.
- **REFACTOR.** `Emit`'s fourth parameter makes it a four-argument callback; if that reads poorly,
  collapse `(path, nameHash)` into one small emitted-entry value object rather than adding a
  fifth. Keep `walkClosure`'s `emit` closure under 20 lines.
- **The byte-neutrality run.** Pack bytes still match: no caller reads the field yet.

### Gate

```
npx vitest run test/unit/application/primitives/internal/closure-engine.test.ts
npx vitest run test/unit/application/primitives test/unit/application/commands
npx vitest run --project integration test/integration/delta-pack-interop.test.ts test/integration/maintenance-interop.test.ts
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/internal/closure-engine.ts test/unit/application/primitives/internal/closure-engine.test.ts
npm run check:spelling
npm run docs:json
```

`reports/api.json` should show **no** diff here — `closure-engine.ts` is internal. A diff means
something leaked; read it rather than committing it.

### Commit

```
feat(closure): carry git's name hash on every walk-tier closure object
```

---

## Part 7 — the measurement driver, and the B0 baseline row

### Context

Design §11 (`sed -n '1053,1117p'`), ADR-831. Requirement **R14**.

**This part has zero `src/` delta** — it is the test-infra-only standalone the sizing rules allow.
It exists because §11 needs **five-plus** measured runs to be one committed procedure rather than
five hand-typed variants a reviewer cannot reproduce.

**Files.**

| Action | Path | What |
|---|---|---|
| create | `tooling/pack-size-compare.ts` | the driver |
| create | `tooling/test/unit/pack-size-compare.test.ts` | unit tests for its **pure** helpers — this is the part's only automated gate |
| edit | `biome.json` | **two** lines in `files.includes` |
| edit | `package.json` | one `wireit` script entry, if the driver needs one; otherwise `node --experimental-strip-types tooling/pack-size-compare.ts` is the documented invocation |
| edit | `docs/design/name-hash-delta-ordering.md` | the **B0 row** of §11b's table, filled in |

⚠️ **`biome.json`'s `files.includes` is a WHITELIST** (`biome.json:9-48`, 37 explicit `tooling/…`
entries). A new `tooling/*.ts` file is **silently unlinted** until it is listed. Add **both** the
driver and its test — see `"tooling/bench-ab.ts"` (`:21`) and `"tooling/test/unit/bench-ab.test.ts"`
(`:22`) as the paired precedent. Insert beside the other bench-adjacent entries; do not re-sort.

**What the driver does** (§11a is the contract — every row of it is binding):

| Element | Contract |
|---|---|
| git version | 2.55.0, printed with every number |
| Peer | `git -c pack.threads=1 -c pack.window=10 -c pack.depth=50 repack -a -d -f -q`. **`gc` is not a selection peer** — it reuses inherited deltas |
| tsgit side | `gc` at the stage commit, at defaults; the **normal** pack is the measured artefact; the run asserts **no cruft pack was written** (none of the corpora has an unreachable object) |
| Corpora | `DELTA_CHAIN_FIXTURE`, `MEDIUM_FIXTURE`, and tsgit's own history as a **fresh clone** (`git clone --no-local` into `mktemp`, so no unreachable object exists on either side). ⚠️ The working repository, with its thousands of unreachable objects, is **not** a corpus |
| Comparability gate | `git show-index` / `parsePackIndex` object counts **equal** on both sides *before* any byte is divided. A mismatch is a measurement defect, not a result. Runs on **every** row |
| Structural readout | `git verify-pack -v` on both packs, **blob lines and tree lines separately**: base count, delta count, chain-length histogram, max depth — recorded beside every ratio, because it is what shows *why* a ratio moved and what makes a zero-effect stage verifiable as zero |
| Environment | scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off — `.claude/workflow/faithfulness.md` |
| Output | one table row per corpus, printed; the operator pastes it into §11b |

**Fixtures — the cache is shared and read-only.** `ensureScaledFixture(spec)` is
`test/bench/support/fixture-generator.ts:956`; `ScaledFixture.cwd`'s own doc (`:218-220`) says
**"Never delete or mutate it — it is the shared cache; copy it first"**. `gc` retires and rewrites
packs in place, and so does `repack`, so the driver must `cp -r` the cache into a scratch
directory **per tool per run**, exactly as `test/bench/maintenance.bench.ts` does. Specs:
`DELTA_CHAIN_FIXTURE` (`:160-168`; `evolving`, 300 commits, one 4 096-byte path, generated at
`deltaWindow: 250` — that is **generation**, not the measurement) and `MEDIUM_FIXTURE` (`:85-91`;
`multi`, 5 000 commits, 20 000 blobs, 2 560 bytes).

**Importing tsgit.** `tooling/` scripts that need the library **dynamic-import from `dist/`** —
`tooling/bench-memory.ts:61` is the precedent (*"Dynamic-import `openRepository` from the built
`dist/`"*). So the driver's documented invocation is `npm run build` **then** the script.
`tooling/bench-ab.ts` is the model for structure and for the `escapeCell`-style table printing,
but note it imports sibling **tooling sources** with explicit `.ts` extensions, not `dist/`.

**Reusable helpers.** `maxChainDepthOid` (`fixture-generator.ts:419-434`) is the precedent for
parsing `git verify-pack -v`: a deltified **blob** line has 6+ whitespace-separated tokens with
`tokens[1] === 'blob'` and the chain depth at `tokens[5]`; base lines and non-blob lines lack the
column. `parseChainDepths` (`delta-pack-interop.test.ts:186-205`) is the precedent for the
`chain length = N: M objects` histogram. **Do not import from `test/integration/**` into
`tooling/`** — copy the parsing shape into the driver's own pure helper and unit-test it there.

⚠️ **`runGit`, `tmp`, `solePackIdx` and `trackedNodeContext` are NOT in
`test/integration/pack-fixture-helpers.ts`** (the design says they are; it is wrong). `runGit`,
`git`, `runGitEnv`, `tryRunGitWithExit`, `disableAutoMaintenance` and `GIT_AVAILABLE` live in
`test/integration/interop-helpers.ts` (`:91`, `:200`, `:105`, `:257`, `:221`, `:149`); `tmp`
(`:56`), `freshRepo` (`:62`), `trackedNodeContext` (`:133`) and `solePackIdx` (`:137`) are
**file-local** to `delta-pack-interop.test.ts` and not exported. The driver owns its own
equivalents; `interop-helpers.ts:105`'s `runGitEnv()` (`{ ...SAFE_ENV }`) is the shape to copy for
the scrubbed environment.

**The unit test.** The driver's I/O is not unit-testable, but its **pure** parts are, and they are
where a silent measurement defect would hide. Test at least: the `verify-pack -v` readout parser
(blob vs tree partition, base/delta counts, histogram, max depth) over a recorded sample of real
output; the ratio formatter; and the comparability gate's own predicate (equal counts pass,
unequal counts **throw** rather than returning a number). The `tooling/test/unit/**` glob is part
of `check:test-pyramid`'s `unit` tier and is subject to the same GWT/AAA/`sut` rules.

**The B0 row is recorded at this commit, and that is legitimate.** Parts 1–6 have all landed by
now, but each carried a byte-neutrality gate, so the packer at this commit emits exactly what
`main`'s does. **B0 must re-measure `main`'s classes: roughly ×5.43 on `DELTA_CHAIN` (with ~808
bases and a max chain of 5) and ×1.58 on `MEDIUM`, on the new `repack -a -d -f` peer.** The real
history figure is **re-measured, not carried**: the retired ×1.42 was against `gc`, an
inherited-delta peer. ⚠️ **A B0 outside those classes retroactively falsifies Parts 1–6 — stop and
escalate, do not proceed to Part 8.**

### TDD steps

- **RED 1 — the readout parser.** Write `tooling/test/unit/pack-size-compare.test.ts` first, with
  a recorded `git verify-pack -v` sample (a dozen lines: blob delta lines with a depth column,
  blob base lines, tree lines, a `chain length = N: M objects` histogram tail). Assert the parsed
  blob/tree partition, base and delta counts, histogram map and max depth. Expected failure:
  `Cannot find module '../../pack-size-compare.ts'`.
- **GREEN 1.** Write the pure helpers in `tooling/pack-size-compare.ts` and export them.
- **RED 2 — the comparability gate throws.** Equal counts return the ratio; unequal counts throw
  with both counts named in the message. try/catch, assert the message carries both numbers.
  Without this, a silent mismatch would publish a ratio that compares nothing.
- **RED 3 — tree lines and blob lines are partitioned, not merged.** A sample where the two
  disagree on max depth; assert the two readouts differ. This is the assertion that makes Part 12's
  "the tree readout flips from 300 deltas to 300 bases" observable.
- **GREEN 2 — the driver.** Wire the corpora, the copy-per-tool-per-run, the scrubbed environment,
  the peer command, the tsgit `gc` run, the no-cruft-pack assertion, and the table print.
- **Run it.** `npm run build`, then the driver over all three corpora. Read the numbers.
- **Record B0** into `docs/design/name-hash-delta-ordering.md` §11b's table, replacing the row's
  placeholders with the measured values **and** the structural readout beside each.
- **REFACTOR.** Keep every pure helper exported and free of I/O so the unit test can reach it; keep
  the I/O shell thin.

### Gate

```
npm run build
npx vitest run tooling/test/unit/pack-size-compare.test.ts
node --experimental-strip-types tooling/pack-size-compare.ts
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check tooling/pack-size-compare.ts tooling/test/unit/pack-size-compare.test.ts biome.json
npm run check:spelling
npx cspell --no-progress docs/design/name-hash-delta-ordering.md
node --experimental-strip-types tooling/audit-test-pyramid.ts
```

⚠️ Re-run `./node_modules/.bin/biome check tooling/pack-size-compare.ts` **after** editing
`biome.json` and confirm it actually lints the file — a whitelist miss shows up as "checked 0
files", which reads like a pass.

### Commit

```
test(pack): add a pack-size comparison driver and record the baseline row
```

---

## Part 8 — stage 1a: name hashes reach the packer

### Context

Design §4c (`sed -n '598,660p'`), §4d (`sed -n '661,676p'`), §4e (`sed -n '677,692p'`),
§11b (`sed -n '1079,1104p'`), ADR-830. Requirements **R6** (hash half), **R7**.

**This is the first measured stage.** It is byte-moving by design. Its gate includes recording the
**S1a** row.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/application/commands/pack-objects.ts` | delete the `:86` map; qualify the `:45-60` docblock |
| edit | `src/application/primitives/enumerate-bundle-objects.ts` | `BundleObjectClosure` (`:46-55`), `BundleEmitState` (`:63-65`), `emitTreeObjects` (`:116-143`), `enumerateBundleObjects` (`:183-206`) |
| edit | `src/application/commands/bundle-create.ts` | delete the `:312` map |
| edit | `src/application/commands/internal/gc-pipeline.ts` | `computeReachableSet` → `computeReachable` (`:284-293`), `partitionOwned` (`:379-421`), a new `toPackInput` helper, sorted roots, the `:419` sort removed |
| edit | four unit test files | the captured-argument spies |
| edit | `docs/design/name-hash-delta-ordering.md` | the **S1a** row |

**`packObjects` (`pack-objects.ts:86-87`).** Today:

```ts
const oids = closure.objects.map((object) => object.id);
const pack = await buildPack(ctx, { oids, delta: true });
```

becomes, with the `.map` **deleted**:

```ts
const pack = await buildPack(ctx, { objects: closure.objects, delta: true });
```

`ClosureObject` is already assignable to `PackObjectInput` (Part 6). On the walk tier every object
carries its hash; on the bitmap tier — **this command's default** — none does, and
`boundCarriedContent`'s `?? 0` is the single place that reads the absence. No object carries
`recency`, so this caller stays in the recency-absent mode. This is the one call site where the
change is a net **memory reduction**: the map and its array are gone.

**The `PackObjectsResult.packId` docblock (`:45-60`) is qualified, not withdrawn.** Its last
sentence today reads *"the pack's byte order is a function of the object SET (`buildPack`'s own
emission order), not of the closure's own traversal order."* It gains *"and of the name hashes the
tier supplied"*. The surrounding **"Never compare this across tiers"** (`:50-51`) is **unchanged**
and now has two reasons.

**`pack-objects.test.ts:287-316` inverts.** Its title today is *"Then the two tiers write the same
object set AND the same packId"* and it asserts `walkResult.packId === bitmapResult.packId`
(`:310`). It becomes a cross-tier **inequality** on the same object set read back from both `.idx`
files (`:311-313`'s `bitmapIds` / `walkIds` equality **stays**). The cause is the **hash**, not the
tiebreak: the fixture's walk-tier closure carries three commits' worth of trees and blobs with
non-zero hashes and the bitmap tier carries none, so the two sorts differ. Attributable to
ADR-830 — rewrite the title to say so in its own words, with **no ADR reference in the test**.

**`bundleCreate`.** `BundleObjectClosure.objects` (`:48`) is `ReadonlyArray<ObjectId>` today and
becomes `ReadonlyArray<{ readonly id: ObjectId; readonly nameHash: number }>`.
`BundleEmitState` (`:63-65`) extends `EmitState` with `boundary`; it gains the emitted-object
accumulator, because `enumerateBundleObjects` currently returns `objects: [...state.emitted]`
(`:205`) — a `Set<ObjectId>` — and a `Set` cannot carry the hash. Push `{ id, nameHash }` on every
successful `tryEmit` instead, keeping `state.emitted` as the dedup set.

`emitTreeObjects` (`:116-143`) is a recursion over `treeObj.entries` with `entry.nameBytes` in
hand at every step, so it **folds the hash itself** — it does not use `walkTree`. It gains a
`hashState` parameter (root = `PACK_NAME_HASH_SEED`); each entry's hash is
`fold(state, nameBytes)` at the root and `fold(fold(state, SLASH), nameBytes)` below it; a
subtree's recursive call receives its own hash as state. Commits and tags push `nameHash: 0`.
`bundle-create.ts:312` then passes `closure.objects` straight through, no `.map`, no recency.

⚠️ `emitTreeObjects` carries **three** `Stryker disable next-line` equivalence comments
(`:128`, `:130`, `:136`) and `collectTreeObjects` carries three more (`:90`, `:96`, `:98`). Each
anchors on the **expression line that follows it**. Adding a parameter shifts lines; keep every
directive glued to its own expression, and **re-prove** any whose proof text mentions control flow
you changed. A carried-forward equivalence proof that no longer describes the code is a defect.

The `seenTrees` prune (`:125`) means a subtree already emitted under an earlier path is never
re-entered — the same first-seen rule as git's `SEEN` flag, with no second hash ever computed.
`collectTreeObjects` (`:79-105`, the uninteresting-side walk) computes **nothing**: its objects
are never packed.

**gc.** Four changes, one invariant:

1. **`computeReachableSet` (`:284-293`) becomes `computeReachable`**, returning the closure's
   objects **in traversal order** together with a membership set:
   `{ objects: ReadonlyArray<ClosureObject>; reachable: ReadonlySet<ObjectId> }`. (Part 9 widens
   the second field to a `ReadonlyMap<ObjectId, number>` of traversal ordinals. Design §12 row H
   describes the end state after Part 9; splitting it this way keeps Part 9's diff small.)
2. **It sorts the roots.** `:285-287` is
   `const roots = await collectRetentionRoots(ctx); … wants: [...roots]`.
   `collectRetentionRoots` (`src/application/commands/internal/fsck/roots.ts:493-501`) returns a
   `Set` whose insertion order follows ref, then reflog, then index, then worktree enumeration.
   Nothing depends on that order today. Sort it: the walk — and in Part 9 the recency it carries —
   must be a pure function of `(sorted roots, graph)`, independent of where objects live. That is
   what makes run 2 reproduce run 1 across the loose→packed transition.
3. **`partitionOwned` (`:379-421`) produces `toNormalPack: PackObjectInput[]`** by iterating **the
   closure**, not `owned`: every reachable object that is not kept and is either owned or a
   promisor-pack member goes to `toNormalPack` as `{ id, nameHash }`, **in traversal order**. That
   is the same set the two existing loops produce — `reachable ∩ (owned ∪ ownedPromisor) \ kept` —
   collected in one pass. `cruftCandidates` **keeps its `owned`-order derivation unchanged** and is
   **not** sorted: the cruft pack passes neither hash nor recency, so its bytes are a function of
   the survivor set alone, and `existingCruftShas.has(pack.sha)` (`:561`) keeps matching on every
   run.
4. **The `toNormalPack.sort()` at `:419` goes, with its comment at `:408-418`.** It existed because
   `owned`'s iteration order depends on where objects live; traversal order is a function of the
   graph and the sorted roots alone, so its invariant now holds by construction — on the delta path
   *and* on the base-only path. Replace the comment with one stating the new invariant, in its own
   words.

**`toPackInput(object)`** is the one small wrapper builder:
`{ id: object.id, nameHash: object.nameHash ?? PATHLESS_HASH }`. Its `?? PATHLESS_HASH` arm is
reachable only through the bitmap tier, which gc never uses, so it is **unit-tested directly** with
a hash-less object. Export it with the `@internal — exported only for that coverage` JSDoc
grammar of `src/adapters/node/path-policy.ts:190-198`. `PATHLESS_HASH` is a named module constant,
not a bare `0`.

**`toPromisorPack` (`:859`) stays oid-sorted** and its `:851-858` comment stays. It is mapped to
inputs by hash lookup: a **reachable** member gets its walk hash, an **unreachable** member gets
`nameHash: 0` explicitly. Its recency is Part 9's.

**The cruft call keeps `{ id }` objects** — no hash, no recency (design §5: every cruft member is
unreachable; git names them `""`).

### ⚠️ The mutation-gate requirement — the highest-yield survivor class in this change

`vitest.stryker.config.ts` runs **`test/unit/**` only**. Everything in this part is wiring whose
effect appears in a real pack, so an integration assertion alone leaves the mutants **alive with
correct-looking coverage**. Every site below needs a **unit-level spy on the callee's captured
argument**:

| Test file | Assert on the captured `objects` |
|---|---|
| `maintenance.test.ts` (spies at `:1919, :1965, :1985, :2012, :2039, :2076`) | the **normal**-pack call receives objects in the closure's **traversal order** (not sorted) with each `nameHash` equal to `packNameHash` of its path; the **cruft** call receives `{ id }` objects with **no** `nameHash` (`toStrictEqual` on one element); the **promisor** call receives oid-sorted objects with `nameHash: 0` for an unreachable member |
| `pack-objects.test.ts` | the captured `objects` **is** `closure.objects` — assert **identity** (`toBe`), not equality; walk tier carries non-zero hashes; bitmap tier carries **no** `nameHash` field (`toStrictEqual`) |
| `bundle-create.test.ts` (spy at `:305`) | the captured objects are `{ id, nameHash }` with `0` for commits and the fold result for a nested blob, and **no** `recency` (`toStrictEqual` on one element) |
| `push.test.ts` | **added here**: the captured objects are `{ id }` each — `toStrictEqual` on one element, with **no** `nameHash` and **no** `recency`. This is the regression guard that `push` never acquires either field while every other caller does; Part 3 only migrated the shape and asserted nothing about it |

⚠️ **Use `toStrictEqual` on at least one element per site**, never `toEqual`: `toEqual` ignores an
`undefined` property and cannot tell `{ id }` from `{ id, nameHash: undefined }`.

### TDD steps

- **RED 1 — `packObjects` passes the closure through by identity.** Spy on the build-pack module;
  assert `spy.mock.calls[0]![1].objects` is `toBe(closure.objects)`. Reach the closure by spying
  the closure-engine module in the same test. Expected failure: today's `.map` makes it a fresh
  array. **GREEN:** delete the map.
- **RED 2 — the two tiers now disagree on `packId`.** Rewrite `pack-objects.test.ts:287-316`:
  same object set from both `.idx` files, **different** `packId`. Expected failure before GREEN 1:
  they are equal.
- **RED 3 — bundle hashes.** `bundle-create.test.ts`: the captured objects carry `nameHash: 0` for
  the commit and `packNameHash('<path>')` for a nested blob. Add the nested-path fixture if
  `buildSingleCommitRepo` is flat. Expected failure: `objects` are bare oids.
- **GREEN 3.** Widen `BundleObjectClosure`, `BundleEmitState`, thread `hashState` through
  `emitTreeObjects`, delete `bundle-create.ts:312`'s map. Re-glue every Stryker directive.
- **RED 4 — gc's normal pack, traversal-ordered and hashed.** In `maintenance.test.ts`, seed a repo
  with a nested path; assert the captured normal-pack `objects` are in traversal order with correct
  hashes.
- **RED 5 — the cruft call carries neither field.** `toStrictEqual` on one captured element:
  exactly `{ id }`.
- **RED 6 — the promisor call.** Oid-sorted, `nameHash: 0` for an unreachable member.
- **RED 7 — `toPackInput`'s `?? PATHLESS_HASH` arm, tested directly.** Call the exported helper
  with a hash-less `ClosureObject`; assert `nameHash === 0`. Also call it with a hash-bearing one.
  Two rows, because the `??` has two arms.
- **RED 8 — the root sort is load-bearing.** Two repositories with **identical graphs** whose refs
  are created in **different orders**; run gc on both with the buildPack spy and assert the
  captured normal-pack `objects` **sequences are equal**. This is the "sort removed" mutant's
  killer, and it is a unit test, so Stryker sees it.
- **Unchanged and load-bearing:** `maintenance.test.ts:1906-1931` ("second gc with nothing changed
  does not call buildPack for cruft") is the set-keyed cruft identity's test and **must stay green
  untouched**. `maintenance.test.ts:2120-2154` (the single-blob resurrection pin) likewise — a
  one-object pack has no order for a key to change. `maintenance-interop.test.ts:1399-1455` (gc
  twice → three identical checksums) must pass **without edits**.
- **REFACTOR.** `partitionOwned` now has two loops with different sources; if it passes 20 lines,
  split `toNormalPack` and `cruftCandidates` into two named functions. Rewrite the `:408-418`
  comment to the new invariant.
- **Measure.** `npm run build`, run the Part 7 driver, record the **S1a** row in §11b.
  ⚠️ **Prediction: `DELTA_CHAIN` must not move** — all 300 versions share one hash and one size,
  the 300 root trees likewise, and with recency absent the tiebreak is still `oid ASC`. **If it
  moves, the design's tie analysis is wrong: stop and escalate, do not land the stage.** `MEDIUM`
  and real history are expected to **gain**.

### Gate

```
npx vitest run test/unit/application/commands/pack-objects.test.ts test/unit/application/commands/bundle-create.test.ts test/unit/application/commands/maintenance.test.ts test/unit/application/commands/push.test.ts
npx vitest run test/unit/application/primitives
npx vitest run --project integration test/integration/delta-pack-interop.test.ts test/integration/maintenance-interop.test.ts
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check <every touched file>
npm run check:spelling
npm run check:dead-code
npm run build && node --experimental-strip-types tooling/pack-size-compare.ts
npm run docs:json
```

`DELTA_CHAIN` must read **no movement**; the S1a row must be committed with this part.

### Commit

```
feat(pack): supply git's name hash from every walk-tier packing caller
```

---

## Part 9 — stage 1b: gc supplies its traversal ordinal as recency

### Context

Design §4c (`sed -n '598,660p'`), §6 (`sed -n '893,949p'`), §11b (`sed -n '1079,1104p'`),
ADR-826, ADR-832.
Requirements **R4**, **R6** (recency half), **R13** (first half).

**This is the stage that closes the gap the whole entry exists for.** On the tie-dense corpus
every version now sorts next to its predecessor.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/application/commands/internal/gc-pipeline.ts` | `computeReachable` returns ordinals; `toPackInput` gains the ordinal; the promisor ordinal; `buildAndWriteNormalPack`'s doc |
| edit | `test/unit/application/commands/maintenance.test.ts` | recency assertions + the multi-object resurrection case |
| edit | `test/integration/delta-pack-interop.test.ts` | `buildSameSizeVersionsRepo`, the cap oracle, X7 re-peered |
| edit | `docs/design/name-hash-delta-ordering.md` | the **S1b** row |

**The change.** `computeReachable` (Part 8's rename of `:284-293`) widens its second return field
from `ReadonlySet<ObjectId>` to an **insertion-ordered** `ReadonlyMap<ObjectId, number>` from id to
traversal ordinal. Membership tests become `ordinalOf.has(id)`; the ordinal is the recency gc
passes. `toPackInput(object, recency)` gains the second argument.

**The three gc call sites, after this part** (design §4c):

| Site | `objects` | mode |
|---|---|---|
| normal (`gc-pipeline.ts:484`) | `toNormalPack` — traversal order, `{ id, nameHash, recency }` | recency-**present**: the sha is a function of the set, the hashes **and** the traversal sequence |
| promisor (`:527`) | oid-sorted, `{ id, nameHash, recency }` | recency-**present** |
| cruft (`:560`) | `survivors.map((id) => ({ id }))` | recency-**absent**: the sha is a function of the set alone |

**The promisor ordinal (ADR-832) is the one piece of arithmetic here.** `toPromisorPack` (`:859`)
is `[...ownedPromisor].sort()` and stays so. Mapping it to inputs: a **reachable** member takes its
walk hash and its traversal ordinal; an **unreachable** member takes `nameHash: 0` and
`recency: reachable.size + i` for its index `i` in the sorted array — "first seen after everything
reachable, in oid order", reproducing git's "appended after the traversal" placement. This is what
keeps the promisor pack in the recency-present mode **without a mixed input**, which Part 3's guard
refuses.

⚠️ `reachable.size + i` is a live mutation target on both operands. Its killer is a **numeric**
assertion on an unreachable member's captured `recency`, not a "greater than every reachable one"
inequality.

**What gc gives up, stated so it is not discovered.** Its normal and promisor packs are now
sequence-keyed. gc meets the resulting obligation by construction: traversal order is a function of
the object graph and the retention roots (`closure-engine.ts:15`: *"Order is deterministic for a
given call"*), and Part 8 sorted the roots so the walk does not depend on ref enumeration order.
Every path-less gc input stays oid-sorted or set-keyed.

**The one identity that weakens — named here rather than discovered.** `buildAndWriteNormalPack`
reports `reuse: 'cruft'` (`:492-496`) when the fresh normal pack's sha equals an existing cruft
pack's — the "resurrected cruft set moving intact into the normal pack" case that
`declassifyCruftPack` then handles in place. That equality needs the same object set **and the same
emission bytes**. The normal pack is now built with hashes and recency and the cruft pack with
neither, so a **multi-object** resurrected set generally yields a *different* sha: gc then takes the
ordinary route — a new normal pack is written, the cruft pack's objects are no longer survivors, and
the cruft lifecycle retires or rewrites it. The arm stays reachable and keeps its tests: the
existing resurrection pins resurrect a **single** blob, and a one-object pack has no order for a key
to change.

- `maintenance.test.ts:2120-2154` (empty repo, one blob crufted then referenced → the rebuilt normal
  pack reproduces the cruft pack byte-for-byte, `declassifyCruftPack` runs) — **must stay green
  untouched.**
- `maintenance.test.ts:2093-2118` (an object made reachable again moves to the normal pack) —
  untouched.
- **New: the multi-object resurrection case.** A commit, its tree and two blobs crufted together,
  then re-referenced. Assert the **ordinary route**: a normal pack under a **new** sha,
  `declassifyCruftPack` **not** called (spy), and the cruft pack handled by its own fate.

**The interop corpus.** New file-local builder in `delta-pack-interop.test.ts`,
`buildSameSizeVersionsRepo(slug, versions)`: **one path**, `versions` revisions of a **fixed-length**
file mutated **in place** through real `git commit`s — the `evolving` shape at interop scale. Copy
the mechanics of `buildTextChurnRepo` (`:111-131`): `freshRepo` (`:62`), `commitAt` (`:82`) with
`fixedCommitEnv` (`:77`) so commit oids reproduce across runs, and `mix32` (`:94`) for deterministic
edit positions. **Mutate bytes in place — never append** — or the versions stop being the same size
and the corpus stops being tie-dense.

**Oracles read blob lines only.** `maxChainDepthOid` (`fixture-generator.ts:419-434`) is the
precedent for the filter: a deltified blob line has `tokens[1] === 'blob'` and 6+ tokens with the
depth at `tokens[5]`. Trees and commits are excluded because their deltas are decided by the
deflate-size acceptance rule, not by ordering. `parseChainDepths` (`:186-205`) gives the histogram
and the per-object map; assert they **agree**.

**After stage 1b, the two rows (R13):**

- **45 versions** — below the depth cap, so the cap never interferes: exactly **1** blob base,
  **44** blob deltas, max blob chain **44** = `versions − 1`.
- **60 versions** — the cap binds: max blob chain **exactly 50**, blob bases **≤ 4**.

The same repositories repacked by `git -c pack.threads=1 repack -a -d -f` give the structural
comparison — **recorded in a comment, not asserted equal**, because the two codecs produce different
delta sizes and a chain ends where the step stops fitting.

⚠️ **Part 10 re-sets both rows.** Write them so the numbers live in one named constant per row, not
scattered through assertions.

**X7 (`:420-434`) is re-peered here.** The peer becomes
`git -c pack.threads=1 -c pack.window=10 -c pack.depth=50 repack -a -d -f -q` (today `:255` runs
`repack -a -d -q`, no `-f`, which compares against **inherited** deltas — a validity band, not a
selection measure). **Object counts are asserted equal first**, before any ratio. Leave the band at
today's wide class (`< 2×`, `> 0.5×`) for now; **Part 12 tightens it** from the shipped row.

⚠️ **Cost and timeouts.** Two new real-git repositories of 45 and 60 commits. Build them **once**
in a shared `beforeAll` with an explicit **`120_000`** timeout — the file's `SETUP_TIMEOUT` is
`60_000` (`:45`) for the existing 200-commit build, and full-validate concurrency makes a
too-tight hook flaky. Build the tsgit `Context` (`trackedNodeContext`, `:133`) **after** all real-git
writes: a per-`Context` loose-object fanout cache is invalidated only by tsgit's own `writeObject`,
so a `Context` created before the git subprocess writes misses them. Scrub `GIT_*` — `runGit`
(`interop-helpers.ts:91`) already does via `runGitEnv` (`:105`). **No `vi.*` in
`test/integration/**`.**

**`maintenance-interop.test.ts:1399-1455`** (reachable + promisor + cruft, gc twice → three
identical checksums, byte-compared) is **R4's gate for the recency-present mode** and must pass
**with no edits**. If it needs one, gc's traversal is not a pure function of the graph — stop and
escalate.

### TDD steps

- **RED 1 — the normal pack carries ordinals.** `maintenance.test.ts`, buildPack spy: the captured
  normal-pack `objects` carry `recency` equal to each object's traversal ordinal, in traversal
  order. Expected failure: no `recency` field is passed.
- **RED 2 — the cruft call still carries neither field.** `toStrictEqual` on one captured element:
  exactly `{ id }`. Regression guard for the recency-absent mode; it must not drift.
- **RED 3 — the promisor unreachable ordinal, numerically.** Seed a `.promisor` pack holding one
  unreachable member alongside reachable content; assert that member's captured `recency` equals
  the exact number `reachable.size + i`. Both operands are mutation targets, so assert the value,
  never an inequality.
- **RED 4 — a mixed promisor input is never constructed.** Assert every captured promisor object
  has a `recency` (no `undefined`), so Part 3's guard cannot fire from gc. A spy plus
  `toStrictEqual` on one element of each class.
- **RED 5 — the multi-object resurrection takes the ordinary route.** New case beside `:2120-2154`:
  new normal-pack sha, `declassifyCruftPack` not called, cruft handled by its fate.
- **GREEN.** Widen `computeReachable`'s return, thread the ordinal through `toPackInput`, build the
  promisor ordinals, update `buildAndWriteNormalPack`'s docblock to say the sha is now a function of
  the set, the hashes and the sequence.
- **RED 6 — the interop cap oracle.** Add `buildSameSizeVersionsRepo` and the two rows (45 and 60
  versions) with the exact base/delta/chain numbers above. Expected failure before GREEN: far more
  blob bases and a max chain in the single digits.
- **RED 7 — X7 re-peered.** Change the peer command, assert object counts equal first.
- **Unchanged and load-bearing:** `maintenance-interop.test.ts:1399-1455`; `maintenance.test.ts`
  `:1906-1931`, `:2093-2118`, `:2120-2154`; every existing delta-pack-interop oracle (index-pack,
  fsck, verify-pack, corruption, bundle, pack-objects, push).
- **REFACTOR.** If `partitionOwned` and the promisor mapping now share wrapper-building logic, keep
  `toPackInput` the single builder. Keep the ordinal arithmetic in one named function.
- **Measure.** Run the Part 7 driver; record the **S1b** row.
  ⚠️ **Prediction: the large gain on `DELTA_CHAIN`** — every version deltas on its predecessor, max
  blob chain `min(versions − 1, 50)`, a handful of blob bases, and a size **below** git's (tsgit
  runs to 50 where git stops near 43). `MEDIUM`: no movement or a small one. **If the cap oracle
  fails, stop and escalate — do not land the stage.**

### Gate

```
npx vitest run test/unit/application/commands/maintenance.test.ts
npx vitest run test/unit/application/primitives test/unit/application/commands
npx vitest run --project integration test/integration/delta-pack-interop.test.ts test/integration/maintenance-interop.test.ts
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check <every touched file>
npm run check:spelling
npm run check:dead-code
npm run build && node --experimental-strip-types tooling/pack-size-compare.ts
node --experimental-strip-types tooling/audit-test-pyramid.ts
```

### Commit

```
feat(gc): pass the reachability walk's ordinal as the pack emission tiebreak
```

---

## Part 10 — stage 2: git's depth-scaled search bound

### Context

Design §4h (`sed -n '786,836p'`), §1f (`sed -n '417,462p'`), ADR-831, ADR-835.
Requirement **R16**, and **R13**'s second half.

**This stage replicates git's bound; its size direction is an open measurement.** ADR-831 ratified
it as faithfulness-over-size, on the premise that tsgit's flat bound packs *smaller* than git and
stage 2 gives that surplus back. **S1b measured that premise and it is FALSE**: tsgit reaches
maxDepth 50 with 6 blob bases against git's 43 with 7 — the chain topology already matches — and
tsgit is still **7.3 % larger** (200,701 B vs 187,097 B). With structure equal, the residual is
per-delta encoding quality, not chain depth, so there is no surplus to give back and the ratio may
move either way. Replicating git is still the point; predicting a regression is no longer part of it.

⚠️ **The structural check is this stage's gate, not the ratio.** Max blob chain must drop from 50
into git's band (~43-44). Record whichever direction the ratio moves. The stop condition was
restated after S1b for exactly this reason — the old "S2 lowering the ratio" condition would now
fire on an improvement, since tsgit enters at ×1.07, above parity, not below.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/application/primitives/internal/deltify.ts` | `searchBound` (new, exported `@internal`), `tryCandidate` (`:140-153`), `selectBestCandidate` (`:155-170`) |
| edit | `src/domain/storage/delta-policy.ts` | **remove** `DELTA_ACCEPT_RATIO` (`:11-14`) |
| edit | `test/unit/application/primitives/internal/deltify.test.ts` | the §1f vector matrix and the incumbent rules |
| edit | `test/integration/delta-pack-interop.test.ts` | R13's two rows become bands |
| edit | `docs/design/name-hash-delta-ordering.md` | the **S2** row |

**Current shape, verbatim:**

```ts
function tryCandidate(member, content, type, policy, searchBound: number,     // :140-153
                      best: Candidate | undefined): Candidate | undefined {
  if (member.type !== type || member.chainDepth >= policy.maxDepth) return undefined;
  const maxSize = best === undefined ? searchBound : best.delta.length - 1;
  const delta = encodeDeltaFromIndex(member.index, content, maxSize);
  if (delta === undefined) return undefined;
  return { delta, chainDepth: member.chainDepth, emissionIndex: member.emissionIndex };
}
function selectBestCandidate(content, window, type, policy): Candidate | undefined {  // :157-170
  const searchBound = Math.floor(content.length * DELTA_ACCEPT_RATIO);        // :163
  let best: Candidate | undefined;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const found = tryCandidate(window[i]!, content, type, policy, searchBound, best);
    if (found !== undefined) best = found;
  }
  return best;
}
```

`encodeDeltaFromIndex` is `src/domain/storage/delta-encode.ts:362`, signature
`(index: DeltaIndex, target: Uint8Array, maxSize?: number) => Uint8Array | undefined` — `maxSize`
is **already optional**, which is what makes the unbounded arm free.

**The target** (design §4h, verbatim):

```ts
const NO_INCUMBENT_REF_DEPTH = 1;

/** git's `try_delta` bound: the byte budget a candidate base at `baseDepth` must
 *  fit, scaled so a deeper base must earn its place with a smaller delta and a
 *  shallower one may win with a larger.
 *  @internal — exported only for the vector coverage below. */
export function searchBound(
  targetSize: number,
  hashSize: number,
  incumbent: Candidate | undefined,
  baseDepth: number,
  maxDepth: number,
): number | undefined {
  const [budget, refDepth] =
    incumbent === undefined
      ? [Math.floor(targetSize / 2) - hashSize, NO_INCUMBENT_REF_DEPTH]
      : [incumbent.delta.length, incumbent.chainDepth + 1];
  if (budget < 0) return undefined; // git's unsigned wrap: no bound at all
  return Math.floor((budget * (maxDepth - baseDepth)) / (maxDepth - refDepth + 1));
}
```

⚠️ **`budget < 0` returning "unbounded" is git's unsigned underflow, replicated on purpose
(ADR-835). It looks like a bug and is not.** Say so at the site, in the implementer's own words —
the vectors below fail if anyone clamps it to `0`.

`tryCandidate` keeps its cross-type and depth guards **first** — `member.chainDepth >= policy.maxDepth`
is git's own guard and is **not** subsumed by a zero bound, because the unbounded arm bypasses the
scaling entirely — then computes the bound, **refuses on `0`**, and hands `undefined` to
`encodeDeltaFromIndex`'s optional `maxSize` for the unbounded case. The bound is **inclusive**:
git's `create_delta` refuses only an output position strictly above `max_size`, and
`encodeDeltaFromIndex` fits a delta of exactly `maxSize`.

A delta that comes back is then judged by **git's same-size rule**: with an incumbent,
`delta.length === incumbent.delta.length && member.chainDepth >= incumbent.chainDepth` keeps the
incumbent. So a candidate whose delta equals the incumbent's wins only from a **strictly shallower**
base. This replaces today's strict `best.delta.length - 1` incumbent bound, which made the rule
unreachable.

`hashSize` is `ctx.hash.digestLength` — threaded into `selectBestCandidate` as a **parameter**,
never added to `DeltaPolicy`, which stays a pure function of config. `deltifyEntries` (`:296`) is
the one call site.

`tryCandidate`'s docblock (*"strictly smaller wins; the most recently admitted member breaks
anything left"*) is rewritten to this rule.

**Arithmetic:** `budget × (maxDepth − baseDepth)` is at most `2**53 / 50` for any object tsgit can
read, so the product is exact and `Math.floor` of the quotient is C's truncating unsigned division
for non-negative operands.

**ADR-777's deflate-size acceptance still runs after the search and is unchanged.** tsgit's
pipeline is git's search bound, then git's incumbent rules, then tsgit's on-disk acceptance.

**`DELTA_ACCEPT_RATIO` is removed.** `delta-policy.ts:11-14` declares it; its **only** consumer is
`deltify.ts:163`, and `acceptsDeltaEntry` never read it despite the docblock at `:11-13` claiming
so. It is **internal** — `delta-policy.ts` reaches the barrel only through Part 2's `NO_RECENCY`
line, and `DELTA_ACCEPT_RATIO` is not on it, so this is **not** a public break and
`reports/api.json` does not move. Delete the constant and its docblock; `MAX_OFS_OVERHEAD_BYTES`
and `acceptsDeltaEntry` stay.

**The §1f vector matrix — this is the oracle** (pinned against real git 2.55.0; two-commit
repositories, one file rewritten in place with a one-byte tail change,
`git -c pack.threads=1 repack -a -d -f`, read back with `git verify-pack -v`; scrubbed `GIT_*`,
isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off):

| object format | sizes → **both bases** | sizes → **one 6-byte delta** | what it pins |
|---|---|---|---|
| sha1 (`hashSize` 20) | 49, 50, 51 | 52, 53, 54 | 49: the floor (Part 12). 50, 51: `25 − 20 = 5 < 6`. 52: `26 − 20 = 6`, and a 6-byte delta is accepted — the bound is **inclusive** |
| sha256 (`hashSize` 32) | 49; 64, 65, 66, 70 | 50, 56, 62, 63; 76, 78, 80 | 49: the floor. 50–63: `size/2 − 32` is negative, wraps, search is **unbounded** — git deltas them. 64, 65: `32 − 32 = 0` refuses. 66–70: bound 1–3, under 6. 76: `38 − 32 = 6` |

⚠️ **Under sha1 the 50-byte floor (Part 12) hides the wrap entirely; under sha256 it does not**,
because 50-to-63-byte objects sit above the floor and still underflow. That asymmetry is why the
sha256 rows exist.

### ⚠️ The vacuous-guard hazard

This change puts **three interacting filters** on the same objects: the search bound (here), the
50-byte floor (Part 12) and max-depth non-admission (Part 11). Part 12 has not landed yet, so a
bound test written now against a 49-byte object passes for the wrong reason once Part 12 lands.
**Every bound test must use objects the floor would admit (≥ 50 bytes)** so the bound is the only
thing that can exclude the row. This exact class has bitten this repo before on threshold work.

### TDD steps

`searchBound` is exported and pinned directly; the end-to-end rules go through `deltifyEntries`.
`deltify.test.ts` has one transparent top-level `describe('deltifyEntries')` at `:53`; put the
`searchBound` cases in a sibling `describe('searchBound')`. Module helpers already there:
`pseudoRandomBytes` (`:24-26`), `DEFAULT_POLICY` (`:28-33`, `window: 10, maxDepth: 50`), `writeBlob`
(`:35-38`), `findEntry` (`:40-44`), `chainDepthOf` (`:46-51`), and a spy on
`deltaEncodeModule.encodeDeltaFromIndex` at `:117`.

- **RED 1 — no incumbent, sha1.** `hashSize` 20: target 50 → `5`, 51 → `5`, 52 → `6`
  (`floor(size/2) − 20`). Expected failure: `searchBound` does not exist.
- **GREEN 1.** Write `searchBound` and export it with the `@internal` JSDoc grammar of
  `src/adapters/node/path-policy.ts:190-198`.
- **RED 2 — the inclusive bound, end-to-end.** A 6-byte delta is **refused** at target 51 and
  **accepted** at 52. This is the `<` vs `<=` killer and it must run through `deltifyEntries`, not
  through `searchBound` alone.
- **RED 3 — no incumbent, sha256.** `hashSize` 32: 50 → `undefined`, 63 → `undefined`, 64 → `0`,
  66 → `1`, 76 → `6`. For the `64 → 0` row assert **`encodeDeltaFromIndex` was not called** (the
  existing spy at `:117` is the shape) — a `0` bound refuses *before* encoding, and that is the
  `=== 0` guard's killer. `undefined` vs `0` is the `< 0` vs `<= 0` mutant: the 64-byte sha256 case
  is exactly `0`, refused, **not** unbounded.
- **RED 4 — depth scaling.** Budget 2 028, `maxDepth` 50: base depth 0 → 2 028; 25 → 1 014;
  49 → 40. Base depth **50** → refused by the **depth guard**, not by the bound: assert with a spy
  that the bound was never computed. That guard is live on the unbounded arm and is not subsumed.
- **RED 5 — the incumbent rule, three rows.** Incumbent delta 100 at base depth 3 (`refDepth` 4):
  a candidate at depth 3 → bound `floor(100 × 47 / 47) = 100`; at depth 10 →
  `floor(100 × 40 / 47) = 85`; at depth 1 → `floor(100 × 49 / 47) = 104`. The last row is the
  behavioural headline — **a shallower base may win with a larger delta** — and must also be
  asserted **end-to-end** with two window members whose deltas are 100 and 102 bytes. The `47`
  denominators are the `refDepth + 1` and `incumbent.chainDepth + 1` mutants' killers.
- **RED 6 — the same-size rule, both directions.** Two members at **equal** depth producing
  **equal-size** deltas → the **first scanned** stays. The same pair with the second **strictly
  shallower** → the second wins. The first row is the `>=` mutant's killer.
- **RED 7 — `hashSize` is `ctx.hash.digestLength`.** A sha256 context changes a 60-byte target's
  bound from bounded to unbounded. `buildSeededContext({ algorithm: 'sha256' })` is available
  (`fixtures.ts:146-160`).
- **GREEN 2.** Rewrite `tryCandidate` and `selectBestCandidate`; delete `DELTA_ACCEPT_RATIO`;
  thread `hashSize` from `deltifyEntries`.
- **RED 8 — R13's bands.** Re-set the 45- and 60-version rows in `delta-pack-interop.test.ts`: max
  blob chain in `[git's max − k, 50]` and blob bases in a band. ⚠️ **The plan does not guess `k`**
  (PC-4). Fill both bands **from this stage's own measured readout**, and record `git verify-pack -v`'s
  reading of the same repository beside them **in a comment** so a reviewer can check the band
  against the row.
- **REFACTOR.** `searchBound` is a pure function with an early return; keep it under 20 lines and
  keep the destructured `[budget, refDepth]` tuple rather than two mutable locals. Rewrite
  `tryCandidate`'s docblock.
- **Measure.** Run the Part 7 driver; record the **S2** row.
  ⚠️ **Structural prediction (this is the gate): `DELTA_CHAIN`'s max blob chain drops from 50 into
  git's band (~43-44), with more bases. If it stays at 50, the §1f model is wrong: stop and
  escalate.** The **ratio** direction is an open measurement — record whichever way it moves and do
  not treat either direction as a refutation. tsgit enters this stage at ×1.07, *above* parity;
  the older "a lowering refutes the model" condition assumed it would enter below parity and has
  been retired. `MEDIUM`: small movement either way.

### Gate

```
npx vitest run test/unit/application/primitives/internal
npx vitest run test/unit/domain/storage/delta-policy.test.ts
npx vitest run --project integration test/integration/delta-pack-interop.test.ts test/integration/maintenance-interop.test.ts
npx vitest run --project unit --coverage
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check <every touched file>
npm run check:spelling
npm run check:dead-code
npm run build && node --experimental-strip-types tooling/pack-size-compare.ts
npm run docs:json
```

`reports/api.json` should show **no** diff — `DELTA_ACCEPT_RATIO` was never on the barrel.

### Commit

```
feat(pack): scale the delta search bound by candidate depth, as git does
```

---

## Part 11 — stage 3: best-base promotion and max-depth non-admission

### Context

Design §4i (`sed -n '837,870p'`), ADR-831, ADR-833.
Requirement **R17**.

**Both mechanics are expected to read exactly zero on both fixtures**, and the stage exists to
**record that zero rather than assume it** (ADR-831). ADR-833 folds non-admission in because both
are window-admission mechanics in the same function, both are byte-neutral once Part 10 landed (no
chain reaches 50 under the depth-scaled bound), and non-admission is a real divergence under
stage 1 alone — a depth-50 member holding a window slot it can never be used from.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/application/primitives/internal/deltify.ts` | `deltifyEntries`' admission step (`:294-306`), new `without` and `readmit`, `WindowState` (`:230-238`) |
| edit | `test/unit/application/primitives/internal/deltify.test.ts` | five cases |
| edit | `docs/design/name-hash-delta-ordering.md` | the **S3** row |

**Current admission step, verbatim** (`deltifyEntries`, `:294-306`):

```ts
for (const [emissionIndex, key] of order.entries()) {
  const content = key.content ?? (await readRawObject(ctx, key.id)).content;
  const candidate = selectBestCandidate(content, state.window, key.type, policy);
  const outcome = await buildDeltifiedEntry(ctx, key.type, content, candidate);
  results.push({ id: key.id, entry: outcome.entry, sourceIndex: key.sourceIndex });
  state = admitToWindow(state.window, state.residentBytes, policy, {
    id: key.id, type: key.type, chainDepth: outcome.chainDepth, content, emissionIndex,
  });
}
```

**The target** (design §4i). Git's window after a hit, oldest to newest, is
`[…others without the base, emitted object, base]` — the base becomes the **most recent** member
and is the first tried for the next target; the just-emitted object sits **behind** it:

```
no hit                     → admitToWindow(state, pending)                        (today)
hit, chainDepth < maxDepth → readmit(admitToWindow(without(state, base), pending), base)
hit, chainDepth >= maxDepth → state unchanged                                     (ADR-833)
```

⚠️ **A "hit" is an *emitted delta*, not a *found candidate*.** When ADR-777's deflate-size
acceptance rejects the candidate and `buildDeltifiedEntry` (`:194-212`) emits a base instead, the
object takes the **no-hit** row. Git never reaches that situation because it accepts on raw size,
so the faithful reading is that no base was used and nothing is promoted. Read the outcome, not the
candidate.

**The three helpers.**

- `without(state, base)` removes the base from the window and subtracts its `memberWeight`
  (`:226-228`). It identifies the member by **`emissionIndex` equality**, not by object identity.
- `admitToWindow` (`:269-284`) is **unchanged** and now admits the new member against a window that
  no longer holds the base, so the base can never be the oldest member `evictToFit` (`:243-260`)
  drops to make room.
- `readmit(state, member)` runs `evictToFit` and appends an **existing** `WindowMember` — its
  `DeltaIndex` is **kept, never rebuilt**. Rebuilding it would be a silent CPU regression and a
  wrong-identity bug.

All three are pure and return a new `WindowState` — the CQS shape `admitToWindow` and `evictToFit`
already have. `WindowState`'s docblock (`:230-234`) — *"The window array and its resident-byte
total, encapsulated as one value so the two can never drift apart"* — is exactly the invariant the
budget test below pins; extend it to name the three operations.

The window stays a **plain array walked back to front** (`selectBestCandidate`'s `:155-156` comment
says so); **no hash-keyed container enters the selection path.**

### ⚠️ The vacuous-guard hazard, again

Part 10's bound and Part 12's floor both exclude objects. Arrange every case here so the
**admission rule** is the only thing that can change the outcome: use objects comfortably above 50
bytes whose deltas fit the depth-scaled bound at the depths under test. A promotion test whose
objects the bound would have refused anyway proves nothing.

### TDD steps

- **RED 1 — promotion changes scan order.** Window `[a, b, c]` (`c` newest); the target picks `b`;
  the **next** target is offered `b` first. Make the winner observable by choosing a next target for
  which `b` and `c` yield **equal-size deltas at equal depth**, so Part 10's "first scanned wins"
  rule decides: with promotion the base is `b`, without it `c`. Assert via `chainDepthOf` /
  `findEntry` (`:40-51`) on which object's `baseIndex` the emitted delta points at. Expected
  failure: the base is `c`.
- **RED 2 — the emitted object sits behind the promoted base.** A third target that ties on the
  just-emitted object `n` and on `b` picks **`b`** — proving the order is `[…, n, base]`, not
  `[…, base, n]`. This is the killer for a swapped append order and RED 1 does not catch it.
- **RED 3 — max-depth non-admission (ADR-833).** A delta emitted at `maxDepth` is **absent from the
  window** for the next target, **and** the base it used was **not** promoted. Two assertions, one
  case — both halves are the same `continue`. Pair it with a **depth 49** case that *does* admit, so
  the `chainDepth >= maxDepth` boundary is pinned from both sides (49 admits, 50 does not).
- **RED 4 — no promotion on a deflate-size rejection.** A candidate found in the search but rejected
  by the acceptance rule leaves the window **exactly as a no-hit admission would**: the would-be
  base keeps its slot and the emitted base object is admitted last. `deltify.test.ts:165-211`
  (*"a candidate that wins the raw search bound but ties the base on deflated size"*) is the
  existing fixture shape to extend.
- **RED 5 — the budget invariant.** After `without` + `admitToWindow` + `readmit`,
  `residentBytes` equals the sum of `memberWeight` over the window. This kills an accounting drift
  in **any** of the three, which no single-operation test does.
- **RED 6 — `readmit` keeps the `DeltaIndex`.** `toBe` (identity, not equality) on the readmitted
  member's `index`. Reaching it needs the window state; if `deltifyEntries` does not expose it,
  assert indirectly by spying `createDeltaIndex` (`delta-encode.ts:186`) and asserting the call
  count does not rise on a promotion. Prefer the spy — it is unit-visible and mutation-visible.
- **GREEN.** Implement `without` and `readmit`; rewrite the admission step as the three-row table.
- **REFACTOR.** The admission step is now a three-way choice; extract it into a named pure function
  taking `(state, policy, pending, outcome)` and returning the next `WindowState`, so
  `deltifyEntries`' loop stays flat and under 20 lines. Extend `WindowState`'s docblock.
- **Sibling suites.** `deltify-window-eviction.test.ts` (eviction accounting, describes at
  `:55, :85, :114, :145, :177, :205, :230`) and `deltify-carried-content.test.ts` (`:59, :80,
  :105, :130`) must stay green. Eviction order is oldest-first on both sides and is **unchanged**;
  if a case there needs a new expected value, promotion has leaked into eviction — stop and read it.
- **Measure.** Run the Part 7 driver; record the **S3** row.
  ⚠️ **Prediction: exactly zero on both fixtures.** On a chain the predecessor is already the most
  recent member, and no chain reaches 50 after Part 10. **A non-zero reading means one of the two
  mechanics moved bytes and needs separating — stop and escalate.** Real history may read small and
  non-zero; branchy history is where one base serves several targets. Record the structural readout
  beside the number either way: it is what makes a zero *verifiable* as zero rather than merely
  reported.

### Gate

```
npx vitest run test/unit/application/primitives/internal
npx vitest run --project integration test/integration/delta-pack-interop.test.ts test/integration/maintenance-interop.test.ts
npx vitest run --project unit --coverage
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/internal/deltify.ts test/unit/application/primitives/internal/deltify.test.ts
npm run check:spelling
npm run build && node --experimental-strip-types tooling/pack-size-compare.ts
npm run docs:json
```

### Commit

```
feat(pack): promote a chosen delta base and withhold max-depth deltas from the window
```

---

## Part 12 — stage 4: git's 50-byte delta floor

### Context

Design §1f's floor row (`sed -n '417,462p'`), §11b's S4 row (`sed -n '1079,1104p'`),
ADR-834, ADR-835.

**The last measured stage, and the shipped number.** `should_attempt_deltas` never offers an object
under 50 bytes as a delta target **or** as a base; tsgit offers every object. Pinned empirically
against git 2.55.0, not inferred from source.

It moves structure on every corpus. `DELTA_CHAIN_FIXTURE`'s 300 root trees are 40 bytes, so git
writes 300 tree **bases** where tsgit writes tree **deltas**. Any structural comparison against git
— and the structural readout is the oracle this work relies on, since git's pointer tiebreak puts
byte-identity out of reach — carries that 300-object discrepancy until the floor lands.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/application/primitives/internal/deltify.ts` | `DELTA_FLOOR_BYTES = 50`; the emission loop |
| edit | `test/unit/application/primitives/internal/deltify.test.ts` | the 49/50 pair and the base-side case |
| edit | `test/integration/delta-pack-interop.test.ts` | the tree readout; **X7's final band** |
| edit | `docs/design/name-hash-delta-ordering.md` | the **S4** row, and the summary sentence |

**The change.** `DELTA_FLOOR_BYTES = 50` as a module-private named constant in `deltify.ts` —
internal, nothing outside decides on it. Objects below it are **emitted as bases and never admitted
to the window, as neither target nor base**. Two effects in one guard placed in `deltifyEntries`'
loop: skip `selectBestCandidate` for an under-floor target, and skip admission for an under-floor
object. Delta selection also gets **cheaper** — under-floor objects are skipped before any window
work, removing encode attempts that could never have been kept.

**Interaction with Part 10, stated so nobody "simplifies" it away.** Under **sha1** the floor
excludes every object small enough to underflow the bound (`2 × 20 = 40 < 50`), so the floor hides
the wrap entirely. Under **sha256** it does not: objects of 50 to 63 bytes are **above** the floor
and still underflow (`2 × 32 = 64`). Part 10's sha256 vectors therefore stay live after this part,
and its sha1 49-byte rows are now decided by the floor rather than the bound. **Re-read Part 10's
tests after this lands**: any of them that used a sub-50-byte object is now vacuous — the floor
excludes the row before the bound is consulted. Fix by raising the object size, never by weakening
the floor.

### ⚠️ The vacuous-guard hazard, third and last time

Three filters now interact. Each floor test below must use objects the **bound** would have
admitted, and each must be arranged so the **floor** is the only thing that can exclude the row.

### TDD steps

- **RED 1 — the 49/50 pair.** Two near-identical **49**-byte objects stay **two bases** and
  **neither enters the window**; two near-identical **50**-byte objects **delta**. The pair is the
  `<` vs `<=` killer on the floor comparison. Verify the 50-byte pair actually deltas under Part
  10's bound *before* relying on it — at `hashSize` 20 a 50-byte target's bound is `5`, so the
  delta between the two must be **≤ 5 bytes**; construct them to differ in a single tail byte.
  (Under sha256 the same pair is unbounded, so it deltas there too.)
- **RED 2 — the floor applies to bases too.** A 49-byte object never serves as a base for a
  4 096-byte target, even though it would be a legal one. Assert the emitted 4 096-byte object is a
  base, or deltas against something else. Without this row the guard could be target-only and pass
  RED 1.
- **RED 3 — an under-floor object never enters the window.** Emit a 49-byte object, then a target
  that would otherwise have taken a delta against it; assert the window never offered it (spy on
  `createDeltaIndex`, or assert the emitted base count). Distinguishes "skipped as a target" from
  "skipped as a window member" — two separate effects of one guard.
- **GREEN.** Add `DELTA_FLOOR_BYTES` and the guard.
- **RED 4 — the interop tree readout.** In `delta-pack-interop.test.ts`, assert the **tree** lines
  of `git verify-pack -v` now show bases where they showed deltas, and that the count matches git's
  own readout of the same repository. This is the assertion ADR-834 exists for: it is what makes
  every later structural comparison mean what it appears to mean.
- **RED 5 — X7's final band.** Tighten `:420-434` from the wide class Part 9 left it at to the
  **shipped** S4 row **plus 15 % headroom** (PC-4; §11c). Object counts stay asserted equal first.
  The number comes **from the measurement**, never the other way round.
- **REFACTOR.** One named constant, one guard, no nesting added to the loop. If the loop passes 20
  lines, extract the per-object step.
- **Re-run Part 10's tests** and confirm none became vacuous.
- **Measure.** Run the Part 7 driver; record the **S4** row — **this is the shipped figure**.
  ⚠️ **Prediction: growth of roughly 300 × (a deflated 40-byte tree − a deflated tree delta) on
  `DELTA_CHAIN` — a few KiB — and the tree readout flips from 300 deltas to 300 bases, matching
  git's.** Small growth on `MEDIUM` and real history, with small-object base counts matching git's.

**Then write §11b's summary sentence**, in these words or their equivalent: *the ordering gain is
S1b − B0; the bound costs S2 − S1b and is the faithfulness trade; promotion is S3 − S2 and was
measured to be zero; the floor costs S4 − S3.* **The published figure is S4.** Any later comparison
against these numbers must name the row it compares.

### Gate

```
npx vitest run test/unit/application/primitives/internal
npx vitest run --project integration test/integration/delta-pack-interop.test.ts test/integration/maintenance-interop.test.ts
npx vitest run --project unit --coverage
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/application/primitives/internal/deltify.ts test/unit/application/primitives/internal/deltify.test.ts test/integration/delta-pack-interop.test.ts
npm run check:spelling
npx cspell --no-progress docs/design/name-hash-delta-ordering.md
npm run build && node --experimental-strip-types tooling/pack-size-compare.ts
npm run docs:json
```

### Commit

```
feat(pack): never offer an object under git's fifty-byte floor as a delta
```

---

## Part 13 — documentation and the backlog tick

### Context

Design §11c (`sed -n '1105,1117p'`), §12 row M. **Docs-only: zero `src/` delta**, which is the
standalone exception the sizing rules allow.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `docs/BACKLOG.md:568` | tick **30.6**; replace the size figures with the stage table |
| edit | `docs/use/commands/maintenance.md:210-238` | "The size trade" — rewritten |
| edit | `docs/use/primitives/internals.md:20` | the `buildPack` entry: `input.oids` → `objects`, and the emission-order key |
| edit | `docs/use/errors.md` | the `INVALID_PACK_INPUT` row |
| edit | `test/bench/maintenance.bench.ts:10-13` | the delta-chain docblock paragraph |
| verify | `docs/adr/769-*.md:8` | already reads **"accepted (ordering half amended by ADR-826)"** — confirm, do not re-edit |
| regenerate | `reports/api.json` | expect **no** diff; a diff means a surface moved in a docs-only part |

**`docs/BACKLOG.md:568`** is the unticked `- [ ] **30.6** name-hash ordering for delta-base
selection` entry. It currently states the ×1.58 / ×5.43 / ×1.42 figures and the root-cause finding
(*"808 of 900 objects landed as non-delta bases with a max chain of 5, against git's ~43"*). Tick
it and replace the figures with **all five rows** (B0, S1a, S1b, S2, S3, S4) plus the summary
sentence — never a single composite. Follow the shape of the completed 30.3 / 30.4 / 30.5 entries
immediately above it: a `**Shipped**` clause, what the design surfaced that the entry did not
anticipate, then `· ADRs 826–835 · design/name-hash-delta-ordering.md`.

**`docs/use/commands/maintenance.md:210-238`** ("The size trade") currently says *"tsgit's window
orders candidate delta bases by size; git orders by path/name-hash first, so … a series of
same-size versions of one file ties under tsgit's ordering and the window samples the wrong
neighbours."* That sentence is now **false** and is the reason this page is in scope. Rewrite the
paragraph around: the name-hash key, gc's recency tiebreak, git's depth-scaled bound (and that
tsgit now ends chains where git does rather than running to the cap), and the 50-byte floor. Give
it the **shipped** row **and** the S1b row with the summary sentence between them (§11c). The
`pack.depth`-above-50 paragraph (`:231-236`) and the `*.keep` sentence are **unchanged**.

⚠️ **Structured output, not cosmetics.** This page documents a command surface. Nothing in this
change adds a rendering option, and nothing here may describe one.

**`docs/use/primitives/internals.md:20`** is the **only** `docs/use/` page that documents
`buildPack`'s input (verified: `command grep -rn "oids" docs/use/` at plan time —
`docs/use/commands/fetch-missing.md`'s `oids` is `FetchMissingInput`, unrelated, **do not touch
it**). Its `buildPack` entry names `input.oids` and *"the packer emits in its own (type, size, oid)
order"*. Update both: `objects: ReadonlyArray<PackObjectInput>` with the two optional per-object
fields and their meanings, and the emission key
`(type, nameHash, size, recency, oid)`. Note that `entries`'s internal `oids` slab field is a
**different** thing and stays.

**`docs/use/errors.md`** lists codes **alphabetically**; `INVALID_PACK_INDEX` is at `:66` and
`INVALID_TREE_ENTRY` follows. `INVALID_PACK_INPUT` sorts **between** them (`Index` < `Input`).
One row: code, `reason, present, absent`, and a one-line description of the mixed-recency refusal.

**`test/bench/maintenance.bench.ts:10-13`** says the delta-chain scenario is *"the design's cost
ceiling now that `buildPack` deltifies, since there is no 'already consolidated, skip it' branch
(Pin W), so every run re-walks the window and re-selects delta bases from scratch."* It now measures
a search that **finds** deltas under git's bound rather than one that mostly fails. Rewrite that
paragraph only; the rest of the docblock (`:14-33`, the `deltify.bench.ts` rationale, the
shared-fixture-copy rule, the `teardown`-not-`afterAll` note) is unchanged and still correct.

⚠️ **No new timing scenario.** Published timing numbers come from the nightly artifact only; the
size table comes from `tooling/pack-size-compare.ts`. This entry claims **nothing** about timing.

⚠️ **`docs/**/*.md` is covered by `npm run check:spelling`'s glob**, but the lint-staged markdown
hook does **not** cover `docs/plan/`. Run `npx cspell --no-progress` bare over every touched doc.
Prefer rewording over a `cspell.json` entry; if one is unavoidable, insert at its alphabetical
position and **never re-sort the file**.

### TDD steps

Docs-only: the "tests" are the mechanical checks, and each is run before the corresponding edit so
its failure mode is observed.

- **RED 1 — the stale claim is still there.** `command grep -n "orders candidate delta bases by size" docs/use/commands/maintenance.md`
  returns a hit. **GREEN:** rewrite the paragraph; the grep returns nothing.
- **RED 2 — the stale input name.** `command grep -n "input.oids" docs/use/primitives/internals.md`
  returns a hit. **GREEN:** rewrite; re-grep clean. Then `command grep -rn "oids" docs/use/` and
  confirm the only survivors are `fetch-missing.md`'s `FetchMissingInput`, `recipes.md:53`'s call
  of it, and `internals.md`'s `PackIndexEntries` slab field.
- **RED 3 — the error code is undocumented.** `command grep -n "INVALID_PACK_INPUT" docs/use/errors.md`
  returns nothing. **GREEN:** add the row at its alphabetical position; re-grep.
- **RED 4 — the backlog entry is unticked.** `command grep -n "^- \[ \] \*\*30.6\*\*" docs/BACKLOG.md`
  returns a hit. **GREEN:** tick it, write the stage table; re-grep returns nothing and
  `- [x] **30.6**` is present.
- **RED 5 — the bench docblock.** `command grep -n "re-selects delta bases from scratch" test/bench/maintenance.bench.ts`
  returns a hit. **GREEN:** rewrite that paragraph only.
- **VERIFY — ADR-769's status line.** `sed -n '8p' docs/adr/769-*.md` must already read
  **"accepted (ordering half amended by ADR-826)"**. If it does not, add it; if it does, leave it.
- **VERIFY — every stage row is present.** `command grep -c "^| \*\*S" docs/design/name-hash-delta-ordering.md`
  must show the four measured stages plus B0 and S1a, each with a real number and a structural
  readout. **A missing row means a stage did not record its measurement and the PR is not
  complete** — escalate rather than back-filling from memory.
- **REFACTOR.** Read the three prose surfaces end to end and check they agree with each other and
  with §11b's table. A number that appears in two places and disagrees is worse than one that
  appears once.

### Gate

```
npm run check:spelling
npx cspell --no-progress docs/BACKLOG.md docs/use/commands/maintenance.md docs/use/primitives/internals.md docs/use/errors.md docs/design/name-hash-delta-ordering.md test/bench/maintenance.bench.ts
npm run check:doc-links
npm run check:doc-coverage
./node_modules/.bin/biome check test/bench/maintenance.bench.ts
npm run check:types
npx tsc --noEmit -p tsconfig.json
npm run docs:json
```

### Commit

```
docs(pack): publish the staged size table for name-hash delta ordering
```

---

## After the last part — the orchestrator's checks

Run **once**, by the orchestrator, never inside a part.

1. **`npm run validate`** — the phase gate. First run of `check:coverage`, `check:architecture`,
   `check:duplicates`, `check:dead-code`, `check:size`, `check:tarball`, `check:exports`,
   `check:test-pyramid`, `check:write-surfaces`, `check:assert-tier`, `check:browser-surface` and
   the parity projects over the whole change.
   ⚠️ If `check:size` or `check:tarball` fails, `rm -rf dist .wireit` and rebuild before believing
   it — a stale chunk inflates both.
   ⚠️ A cached-green `validate` can precede a red prepush. Re-run `cspell` fresh and regenerate
   `reports/api.json` before pushing.
2. **`npm run docs:json` and confirm `reports/api.json` is committed and clean.**
   `check:doc-typedoc` is a prepush gate, not a validate gate.
3. **The stage table is complete** — B0, S1a, S1b, S2, S3, S4, each with a number, a structural
   readout, and the git version stated. The published figure is S4.
4. **Mutation.** The mutation gate is **unit-only**. The wiring in Parts 8 and 9 is invisible to
   Stryker except through the captured-argument spies those parts require; confirm each one landed
   before the mutation phase, or the survivors will be reported against arithmetic that is
   correct.
5. **Review dominates every run in this repo** — consistently two to three convergence cycles, and
   it has repeatedly found CRITICAL/HIGH defects on diffs that already passed a green `validate`.
   Budget for it. Implementation is not the end.

### Escalation

Any blocker is `{ part, reason, at most 3 options }`. Never spin; never silently abandon. The four
stop-and-escalate conditions written into the parts above are:

- an assertion in the pack-writing surface needing a **new expected value** in Part 2, 3 or 6;
- **B0** landing outside `main`'s measured classes (Part 7);
- **S1a moving `DELTA_CHAIN`** (Part 8), **S1b failing the cap oracle** (Part 9), **S2 lowering the
  `DELTA_CHAIN` ratio** (Part 10), or **S3 reading non-zero on either fixture** (Part 11);
- `check:dead-code` flagging a test-only export (Parts 5, 10).

Each means the model in the design is wrong somewhere, and the stage's commit does not land until
the design says where.
