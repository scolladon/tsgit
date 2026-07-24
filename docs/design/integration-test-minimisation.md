# Integration test minimisation — one `it('Then …')` per distinct journey/code-path

## Goal & scope

Reduce the **integration tier** to **one `it('Then …')` per distinct behaviour**
without losing a single executed assertion or weakening a single cross-tool
faithfulness pin. This is the integration-tier analog of the shipped 27.1
unit-tier minimisation (`docs/design/unit-test-minimisation.md`,
ratified as ADR-498). The same two mechanical moves do the reduction:

- **Collapse** tests that exercise the *same user journey or code path with
  different fixtures* into one parameterised `it.each`.
- **Delete** tests whose inputs and assertions are a *strict subset* of a test
  that remains.

Everything else is **kept verbatim**. Because this is the same methodology,
this doc **does not re-derive** the classification/proof reasoning — it *refines*
it for the integration tier. The load-bearing differences from 27.1 are three,
each addressed below:

1. **No coverage gate.** `test:coverage` runs the `unit` project only; the
   integration tier drives *no* coverage number (§3). The 27.1 coverage backstop
   (§3.3 there) simply does not exist here — a different backstop is defined.
2. **The per-`it` GWT/AAA/sut heuristics do not gate this tier.** In
   `test-pyramid-budgets.json` every gating heuristic (`gwtTitle`, `aaaBody`,
   `sutNaming`, `underAssertedUnit`, `bareClassToThrow`, `emptyAaaSection`) is
   scoped `tier: unit`. The only integration-tier heuristics —
   `integrationProof` and `overMockedIntegration` — are **report-only**
   (`gating: false`). So the collapsed shape is held to house style *by
   convention plus biome*, not by the pyramid gate (§2).
3. **Cross-tool faithfulness pins live inside the fixtures.** Most
   `test/integration/**` files are `-interop` tests that spawn **real `git`** and
   compare byte-for-byte against tsgit (ADR-226). A collapse may never drop a
   fixture that pins a distinct git behaviour, and every surviving `it.each` row
   must **still spawn `git` + tsgit and compare** (§1, §3.2). This is the
   integration-tier's replacement for "no mutant resurrects".

**Scope (user decision, non-negotiable): the whole integration tier in ONE PR**
(platform-gated `posix-only/`/`win-only/` subdirs per Decision 6). The exact
globs, from `vitest.config.ts`:

| vitest project | glob | files | in 27.2 scope? |
|---|---|---:|---|
| `integration` | `test/integration/**/*.test.ts` minus `posix-only/**`, `win-only/**` | 85 root + 10 `network/` | **yes** |
| `posix-integration` | `test/integration/posix-only/**/*.test.ts` | 5 | **yes** (verifiable on this darwin host) |
| `win-integration` | `test/integration/win-only/**/*.test.ts` | 2 | Decision 6 (can't verify locally) |
| `parity` | `test/parity/**/*.test.ts` | 2 | **NO — carve-out (§4)** |
| (runtime runners) | `test/runtime-parity/**` (deno/bun/workers) | 5 | **NO — carve-out (§4)** |
| `e2e` | `test/browser/**/*.spec.ts` | 0 present | out (27.3) |

Only **3** integration files use `it.each` today (`config-interop`,
`notes-interop`, `ssh-transport-interop`) versus ~38 in the unit tier — the
target pattern is proven-in-repo but heavily under-applied.
`test/integration/config-interop.test.ts` (the `WRITE_PARITY_MATRIX` /
`SUBSECTION_WRITE_MATRIX` / `MALFORMED_HEADER_READ_MATRIX` blocks) is the
canonical in-repo interop `it.each` AFTER shape — the integration analog of
`conflict-marker-size.test.ts` for the unit tier. Copy it.

### The parity carve-out — cross-adapter ≠ cross-tool (precise boundary)

Two different equivalence proofs both look like "parity" and must not be
confused:

- **Cross-adapter parity (OUT OF SCOPE, never touched).** `test/parity/**`
  (`node.test.ts`, `memory.test.ts`) and `test/runtime-parity/**`
  (deno/bun/workers × node/memory) run the *same* tsgit scenarios against
  *different adapters/runtimes* and assert byte-identical results. Their whole
  reason to exist is the N-way cross-product (Node × Memory × Browser × Deno ×
  Bun × Workers) — collapsing across adapters would destroy the proof. These
  live *outside* `test/integration/**`, so they are excluded by glob, and they
  are **never** counted as a "retained test" that could make an integration test
  a strict subset (§4).
- **Cross-tool parity (IN SCOPE, but its byte assertions are inviolable).**
  Within `test/integration/**`, the `-interop` files spawn **canonical git** and
  compare tsgit's bytes/SHAs/refs/stderr against it (the ADR-226 faithfulness
  pins). Cross-tool parity is *the point* of the interop tier; a collapse may
  merge two same-journey interop tests into one `it.each`, but **each surviving
  row must still spawn git + tsgit and keep the byte-exact comparison** — the
  collapse reduces test *count*, never faithfulness *coverage* (§1(b), §3.2).

**The boundary is the directory, not the filename.** The carve-out is
`test/parity/**` / `test/runtime-parity/**` / `test/browser/**` — *directories*.
A file named `-parity` that lives **inside** `test/integration/**` (e.g.
`diff-patch-git-parity.test.ts`, `filter-driver-parity.test.ts`) is a
**cross-tool** interop test (git-vs-tsgit) and is **in scope**; do not mistake it
for the cross-adapter carve-out. Conversely, nothing under the three carve-out
directories is ever touched regardless of its name.

## The invariant: behaviour-preserving, tests only

**No `src/` change.** This is a pure test-suite refactor. Production code, object
SHAs, ref/reflog contents, on-disk state files, refusal conditions and message
formats are untouched, so the git-faithfulness prime directive (ADR-226) is
unaffected by construction. No new git behaviour is pinned here, so the
empirical-pinning procedure (`.claude/workflow/faithfulness.md`) does not
apply — every fixture already encodes an *observed* git behaviour; minimisation
only re-groups those observations, it never invents or relaxes one.

The property we preserve across every edit, restated for the integration tier
(the 27.1 property plus a cross-tool clause):

> **The multiset of executed `(Arrange → Act → Assert)` triples the integration
> suite runs does not shrink; no assertion is weakened; and every surviving
> triple that spawned real `git` still spawns real `git` and still compares
> byte-for-byte.**

The third clause is what a collapse cannot silently erode here: an over-eager
merge could keep the suite green while quietly dropping the `git` spawn or the
cross-tool `expect(...).toBe(...)` from a row. That is the integration-tier
equivalent of a resurrected mutant, and §3.2 is the check for it.

## Why the outcome bar cannot be freshly *measured* (and what we do instead)

27.1 leaned on two guarantees: coverage (measurable) and mutation (proven by
construction). **For the integration tier, *neither* is a live measurement:**

- **Coverage — not driven by this tier at all.** `npm run test:coverage` runs
  `vitest run --project unit --coverage`; the `include` set is
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**`. The
  integration project is not in the coverage run and pins no line. A deleted or
  collapsed integration test can never move a coverage number, so coverage is
  **zero-signal** here — it can neither catch a regression nor be cited as a
  backstop. (27.1's §3.3 has no analog.)
- **Mutation — zero-signal for a tests-only PR, same as 27.1.** The PR mutation
  job (`tooling/run-stryker-pr.ts` ← `.github/scripts/compute-mutation-scope.sh`)
  scopes Stryker to the diff filtered by `grep -E '^src/.*\.ts$'`; a tests-only
  change yields an empty mutate-list ⇒ "No src/ files … skipping" ⇒ exit 0. And
  local whole-bucket Stryker under-reports non-deterministically
  (stryker-js#5928). No mutation evidence gates or is trustworthy for this PR.
- **The pyramid GWT/AAA/sut heuristics — unit-scoped, do not gate here.** In
  `test-pyramid-budgets.json` every gating heuristic carries `tier: unit`
  (verified: `gwtTitle`/`aaaBody`/`sutNaming`/`underAssertedUnit`/
  `bareClassToThrow`/`emptyAaaSection` all `tier=unit, gating=true`). The two
  integration-tier heuristics (`integrationProof`, `overMockedIntegration`) are
  `gating=false` — **report-only**. So `check:test-pyramid` mechanically gates
  *nothing* on the shape of an integration `it()`.

**What remains, and is therefore load-bearing (§3):**

1. **Proof-by-construction** — the same union/strict-subset theorem as 27.1: a
   collapse relocates every triple 1:1, a delete removes only strict-subset
   triples (§3.1).
2. **Cross-tool preservation** — each surviving row still spawns git + tsgit and
   compares (§3.2). This is the integration-specific obligation that stands in
   for the coverage/mutation guarantees 27.1 had.
3. **Green suite** — `npx vitest run <touched>` per part and `test:integration`
   at the boundary prove the surviving rows *pass* (§3.3). Weaker than 27.1's
   coverage aggregate: green proves surviving triples pass, **not** that no
   unique triple was silently dropped — so the construction discipline (§3.1)
   and reviewer diff-reading carry more weight here than in 27.1.
4. **`biome check`** — the one machine gate that *does* bind the collapsed shape:
   `noThenProperty` (row field `label`, never `then`) is a biome recommended
   rule and runs on every touched file in the part gate (§2).

This shift — coverage gone, pyramid heuristics report-only, cross-tool
preservation promoted to the primary backstop — is Decision 1.

## 1. Operational classification — KEEP / COLLAPSE / DELETE

Reuse ADR-498's procedure, with "act/oracle" reinterpreted for integration.
Define, for an integration test `T`:

- its **journey/path** — the sequence of repo operations under test *and* the
  internal code path they drive (e.g. "stage → commit → refuse on a valueless
  config key", or "diff a tree pair where one leaf changes object type");
- its **oracle** — the `expect(…)` assertion *shape*, ignoring row literals
  (e.g. `expect(diff type-change row).toEqual(…)`, or "git exits 128 with the
  two-line missing-value message" + "tsgit throws `CONFIG_MISSING_VALUE` with
  key+line" + "reconstructed stderr matches");
- its **distinguishing fixtures** — the concrete inputs that make this test
  differ from its siblings (the config key, the from→to type pair, the
  whitespace mode, the corruption kind, …), *and* — uniquely to this tier — the
  **consuming command** where the same code path is reached through different
  git subcommands (see the missing-value example below).

```
For each group of it() blocks that share ONE journey/path under a common —
or unifiable (§2) — Given+When:

  (a) KEEP verbatim
      if the test's journey/path OR oracle differs from every sibling
      (a structurally different assertion, a different error code/reason, a
      different git-behaviour class), OR it isolates a boundary/tie-break/
      refusal that no other kept test isolates.

  (b) COLLAPSE into one it.each
      if 3+ siblings drive the SAME journey/path AND the SAME oracle SHAPE,
      differing only in the row fixtures (and/or the consuming command).
      The row matrix MUST be the UNION of every sibling's distinguishing
      fixtures — no fixture dropped, no assertion weakened — AND, for a
      cross-tool row, the callback MUST still spawn git + tsgit and keep the
      byte-exact compare (a non-git integration row — pure adapter/state — has no
      spawn to preserve; §3.1/§3.3 still bind it).

  (c) DELETE
      if T's (fixtures × assertions) is a STRICT SUBSET of a single retained
      test R: every fixture T exercises R also exercises, AND every assertion
      T makes R also makes (same oracle, same expected). Removing T removes no
      unique triple and no unique git-behaviour pin.
```

**"Same journey/path, different fixture" precisely** = identical oracle shape and
identical cross-tool comparison; only the fixture literals (and optionally the
consuming command, carried as a row field) move into the table. **"Distinct
behaviour"** = a structurally different `expect`, a different error
code/reason/refusal, or a boundary/tie-break that must stay isolated (§3).

**"Strict subset" precisely** = set containment in *both* dimensions (fixtures
and assertions) against **one** retained test, *and* the retained row still
pins every git behaviour the deleted test pinned. If `T` asserts even one thing
`R` does not (a distinct byte comparison, a distinct error field), `T` is **not**
a subset — KEEP `T`, or *relocate* `T`'s extra assertion into `R`'s row and then
delete `T` (relocation into a retained row is part of a legal delete; no new
`it()` appears). Two tests that merely *overlap* are never a delete — they are a
**collapse** over the union.

### Worked example — clean COLLAPSE grid (`diff-type-change-interop.test.ts`)

The file has **15** `describe('Given <from> → <to> …')` blocks (file↔symlink,
file↔gitlink, symlink↔gitlink, and leaf↔directory), each holding the **same
four** `it('Then …')` oracles:

```
describe('Given file → symlink (100644 → 120000)', () => {
  it('Then emits type-change with correct modes and oids',           …);
  it('Then reconstructed raw line matches git diff-tree',            …);
  it('Then name-status T line matches git diff --name-status',       …);
  it('Then reconstructPatch emits delete+add blocks matching git …', …);
});
// …repeated for 15 type pairs → 60 it() blocks…
```

This is a textbook 15×4 grid: **collapse each of the four oracle families across
the 15 type-pairs into four `it.each` blocks**. Each row carries the fixture
`{ from, to, fromMode, toMode, … }`; the callback still builds the pair with real
`git`, runs tsgit `diff`, and compares byte-for-byte per row:

```
describe('Given a tree pair whose leaf changes object type', () => {
  describe('When diff runs against git diff-tree', () => {
    it.each(TYPE_CHANGE_MATRIX)(          // 15 rows = union of all pairs
      'Then the raw line matches git for $label',
      async ({ from, to, fromMode, toMode }) => {
        // Arrange — the shared repo already holds a commit pair per type pair
        // Act — tsgit diff + git diff-tree for this pair
        // Assert — byte-exact raw line (cross-tool pin preserved per row)
      },
    );
  });
});
// …and one it.each each for name-status, reconstructPatch, modes-and-oids…
```

The four *oracle families* stay **four separate** `it.each` blocks — they assert
structurally different things (raw line vs name-status vs patch bytes vs
modes/oids), so they are KEEP-distinct from each other and only collapse
*within* a family across the type-pair fixtures. This is the KEEP-vs-COLLAPSE
line drawn correctly: collapse along the fixture axis, never merge distinct
oracles.

### Worked example — COLLAPSE with a per-row command + interleaved KEEPs (`missing-value-refusal-interop.test.ts`)

The file repeats, per config key (`user.name`, `remote.origin.url`,
`remote.origin.pushurl`, …), the **same three-oracle journey**:

1. **git refuses** — exit 128 + the two-line `missing value for '<key>'` /
   `bad config variable '<key>' … at line N` message;
2. **tsgit throws** `CONFIG_MISSING_VALUE` with `{ key, line, source }`;
3. **reconstruction** — git's two stderr lines rebuilt from tsgit's structured
   fields match after path-token normalisation.

The subtlety unique to this tier: the **consuming command differs per key** —
`user.name` trips on `commit`, `remote.origin.url` on `fetch`,
`remote.origin.pushurl` on `push`. The *journey* differs per row but the *code
path* (config-missing-value refusal) and all three oracle shapes are identical.
So the collapse is **three `it.each` blocks** (one per oracle family), each row
carrying the fixture **and the command**:

```
const MISSING_VALUE_MATRIX = [
  { key: 'user.name',            fixture: VALUELESS_NAME_FIXTURE,        line: 4,
    gitArgs: ['commit', '-m', 'x'], run: (repo) => repo.commit({ message: 'x' }), label: 'user.name via commit' },
  { key: 'remote.origin.url',    fixture: VALUELESS_REMOTE_URL_FIXTURE,  line: 4,
    gitArgs: ['fetch', 'origin'],   run: (repo) => repo.fetch({ remote: 'origin' }), label: 'remote.origin.url via fetch' },
  { key: 'remote.origin.pushurl', fixture: VALUELESS_REMOTE_PUSHURL_FIXTURE, line: 4,
    gitArgs: ['push', 'origin', 'main'], run: (repo) => repo.push({ … }), label: 'remote.origin.pushurl via push' },
  // …union of every key that shares this exact three-oracle journey…
];
```

Carrying the command as a row thunk (`run`) + `gitArgs` keeps the *code path* the
single collapse axis while the fixture *and* the command vary — a legitimate
integration-tier extension of 27.1's "one act per `it.each`" (Decision 2b). The
`beforeEach`-fresh-`ours`-tmpdir already gives per-row isolation for free; it
stays (§2).

**Interleaved DISTINCT behaviours that MUST stay isolated (KEEP):**

- **absent-identity → `AUTHOR_UNCONFIGURED`** (`Given a config with no [user]
  section`): git *auto-commits* (exit 0), tsgit throws a *different* code and
  asserts `data.code).not.toBe('CONFIG_MISSING_VALUE')`. Distinct oracle +
  distinct git behaviour → KEEP, never folded into the refusal matrix.
- **absent-url → `REMOTE_NOT_CONFIGURED`** (same shape, different code) → KEEP.
- **earlier-by-line tie-break** (`Given both … valueless with pushurl earlier` /
  `… with url earlier`): asserts *which* key wins when two are valueless — a
  distinct oracle (the tie-break rule), tested from both sides. These two rows
  may collapse into their *own* 2-row `it.each` only if Decision 5's threshold
  permits a 2-collapse; otherwise KEEP both. They never merge into the
  single-key refusal matrix.

Merging a `CONFIG_MISSING_VALUE` row with an `AUTHOR_UNCONFIGURED` case would
weaken an error assertion (guard-rail §3.2) — the whole point of these
interleaved blocks is that *absent ≠ valueless*.

### Worked example — DELETE (strict subset)

If a file holds an early narrow test asserting only "tsgit `diff` emits a
type-change entry with the right modes for file→symlink", and a later block
asserts *the same* modes-and-oids for file→symlink **plus** the raw-line,
name-status, and patch-byte comparisons, the narrow test's single assertion is
contained in the later block (same fixture, same oracle, subset of assertions)
→ **DELETE** the narrow one (its triple is re-executed by the retained block).
If instead each block pins a byte comparison the other lacks, neither is a
subset → **COLLAPSE** over the union of assertions, never delete.

### Worked example — KEEP (distinct refusal / co-refusal)

A `tryRunGit`-based *co-refusal* test (proving canonical git refuses exactly
where tsgit refuses — e.g. `merge-tracked-dirty-conflict-refusal-interop`) that
asserts a *different* refusal condition than its neighbours is KEEP: the git
behaviour it pins is unique, so it is neither a subset of nor collapsible into a
sibling with a different refusal.

## 2. GWT discipline under `it.each` — by convention + biome (not the pyramid gate)

Unlike 27.1, `check:test-pyramid` does **not** gate the per-`it` shape of an
integration test (§"Why the outcome bar…"). The collapsed shape is held to the
same house standard anyway, enforced by two different mechanisms:

| Rule | Enforced by | Applies to integration? |
|---|---|---|
| Row field `label`, never `then` | **biome `noThenProperty`** (recommended preset) | **Yes — machine-gated** via `biome check` in the part gate |
| `describe` `^Given `/`^When `; `it.each` `^Then .+` | pyramid `gwtTitle` | No (unit-scoped) — kept **by convention** |
| `// Arrange` / `// Assert` markers | pyramid `aaaBody`/`emptyAaaSection` | No (unit-scoped) — kept **by convention** |
| binds `sut` | pyramid `sutNaming` | No (unit-scoped) — kept **by convention** |
| ≥1 `expect` per row | pyramid `underAssertedUnit` | No (unit-scoped) — kept **by convention** |
| assert error `.data`, no `.toThrow(Class)` | pyramid `bareClassToThrow` + faithfulness | No (unit-scoped) — kept **by convention + ADR-226** |

So: `label`-not-`then` is a hard gate; the rest are house style the collapse
preserves because a minimisation that *degraded* GWT/AAA/`sut`/error-data would
be a worse test, and the faithfulness invariant forbids weakening an error
assertion regardless of whether a gate catches it. **Note:** many interop files
today do *not* bind a variable named `sut` (they use `g`, `repo`, `ours`, `pair`)
and are not GWT-perfect — this is legal for the tier. Minimisation **preserves
each file's existing convention exactly**; it does not *introduce* `sut` or
re-title kept tests. The bar is "no worse than today", not "retrofit unit-tier
GWT onto integration".

Canonical collapsed shape:

```
describe('Given <shared journey context>', () => {          // truthful for every row
  describe('When <the shared code path is driven>', () => {
    it.each([ /* one row per distinguishing fixture, UNION of merged tests */ ])(
      'Then $label',
      async (row) => {
        // Arrange  — build THIS row's throwaway repo + fixture (per-row, isolated)
        // Act      — spawn git for this row AND run tsgit for this row
        // Assert    — the shared oracle + the byte-exact cross-tool compare
      },
    );
  });
});
```

**Per-row isolation is heavier here and load-bearing.** Interop rows are `async`
and spawn `git` + create on-disk tmpdirs. Two constraints from
`test/integration/interop-helpers.ts` and prior incidents:

- **Never hoist a *mutable* repo across rows.** `it.each` rows run sequentially;
  a repo built once in `beforeAll` and *mutated* per row bleeds state between
  rows and changes the executed triples. Each row's Arrange must build (or
  `beforeEach`-provision) its own throwaway repo — exactly as the per-test
  Arrange did. A **read-only** shared `beforeAll` repo (the pattern several
  interop giants use to amortise git-spawn cost and dodge the validate-concurrency
  hook-timeout) is fine *only* when rows never write it — `diff-type-change`'s
  shared commit-pair repo is read-only and stays shared; `missing-value-refusal`'s
  per-`beforeEach` fresh `ours` stays per-row.
- **Preserve the env/async discipline verbatim.** Collapsed rows keep using the
  helper surface — `runGit`/`tryRunGit`/`git()` (env-scrubbed `SAFE_ENV`, no
  inherited `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM`) and **`gitAsync`,
  never sync**, for any command that crosses a same-process HTTP round trip
  (`test/integration/network/**`) to avoid the event-loop deadlock. Minimisation
  changes test *grouping*, never the isolation plumbing.

Because `vitest` expands `it.each` to N independent `it()` runs, each row is a
genuinely isolated test at runtime — this is what lets a collapse preserve
per-row `git` spawn and per-row refusal isolation (§3).

## 3. Invariant-preservation proof obligation (per part)

### 3.1 Triple preservation — by construction (primary, unchanged from ADR-498)

A behaviour is proven by the integration suite **iff at least one executed
`(Arrange→Act→Assert)` triple exercises it**. The two moves preserve every
triple:

- **COLLAPSE** relocates each sibling's Arrange/Act/Assert into a table row 1:1;
  `it.each` re-expands to N independent runs ⇒ the multiset of executed triples
  is *identical* pre/post, **provided the matrix is the union of all
  distinguishing fixtures (and commands) and no oracle is weakened**.
- **DELETE** removes only triples a retained test still executes (strict subset)
  ⇒ removes no *unique* triple.

The reviewer verifies the *discipline* by reading the diff — matrix-is-union,
delete-is-strict-subset, no weakened oracle — exactly as in 27.1.

### 3.2 Cross-tool / faithfulness preservation (the integration-specific obligation)

This is the backstop that *replaces* 27.1's coverage+mutation guarantees. A
collapse/delete is **illegal** (revert to KEEP) if any holds:

- A surviving `it.each` row **that spawned `git` today stops spawning it**, or
  **drops the byte-exact `expect(...).toBe/.toEqual(...)`** cross-tool compare.
  Every cross-tool row must still run git
  (`runGit`/`tryRunGit`/`git`/`runGitBytes`) *and* tsgit *and* compare — the
  collapse reduces count, never faithfulness coverage. (Pure adapter/state
  integration tests carry no git spawn; the clause is vacuous for them, but the
  triple-preservation and green obligations still apply.)
- It **drops a fixture that pins a distinct git behaviour** — every corner git
  handles specially (a valueless-vs-absent config key, an earlier-by-line
  tie-break, a leaf↔directory type change, an off-by-one line number, an empty
  input, a binary/CRLF edge) is its own row. Collapsing a distinct-behaviour
  fixture into an interior sample is forbidden.
- It **weakens an error/refusal assertion** — merged refusal tests keep per-row
  expected `.data` (`code`/`key`/`line`/`reason`) and the per-row git-stderr
  substrings; never collapse a co-refusal to a bare `toThrow(Class)` or drop the
  `git.ok === false` check. `absent`-class cases (`AUTHOR_UNCONFIGURED`,
  `REMOTE_NOT_CONFIGURED`) never merge with `CONFIG_MISSING_VALUE` rows.
- It **merges two refusal guards into one row** — for a git behaviour gated on
  `A || B`, one fixture tripping both does not prove each alone; keep one row per
  guarding condition.
- It **shares mutable repo state across rows** (§2) — each row's Arrange stays
  self-contained; a read-only shared `beforeAll` repo is the only permitted
  hoist.

### 3.3 Green suite — measured (backstop, weaker than 27.1's coverage)

`npx vitest run <touched files>` per part and `npm run test:integration` at the
partition boundary prove every expanded row **passes**. This is the only live
mechanical measurement for the tier, and it is strictly weaker than 27.1's
coverage aggregate: green confirms the *surviving* triples pass, but — with no
coverage number — it **cannot** detect that a *unique* triple was silently
dropped. That gap is closed only by §3.1 construction + §3.2 cross-tool review of
the diff. This is why the reviewer's diff-reading is promoted to primary
evidence here (Decision 1).

### 3.4 Report-only pyramid signals stay clean (honoured, though ungated)

`integrationProof` (`@proves`-header presence, `(surface, bucket)` uniqueness,
directory placement) and `overMockedIntegration` are report-only, but 27.2 keeps
both clean by construction:

- **No file is deleted and no file is emptied.** 27.2 collapses *within* files
  only, so each file keeps its top-of-file `@proves` header (where present)
  **byte-identical** and its `(surface, bucket)` pair unchanged — the
  duplicate/missing/misplaced findings are invariant. A file must never be reduced to zero tests; if every
  test in a file looks like a strict subset, that is a classification error —
  re-examine (the file's unique proof cannot both exist and be wholly redundant).
- **Do not increase mocking.** Minimisation re-groups real-git/real-adapter
  tests; it never swaps a spawn for a stub, so `overMockedIntegration` cannot
  regress.

### 3.5 Targeted hand-verification (backstop for risky edits)

For any collapse/delete the reviewer judges risky (touches a refusal, a
tie-break, a byte-exact pin, or a boundary), confirm the surviving row still
detects a regression: perturb the tsgit field the row pins (or the fixture) and
confirm the row **fails**, then restore. Because this is a positive,
deterministic single-row run (`npx vitest run <file> -t '<label>'`), it does not
depend on any aggregate score — the only trustworthy evidence available for a
tests-only integration PR.

### 3.6 What we explicitly do NOT rely on

Coverage (this tier drives none), CI PR mutation (zero-signal), local whole-bucket
Stryker (non-deterministic), and the pyramid GWT/AAA heuristics (unit-scoped,
report-only for integration). §3.1 construction + §3.2 cross-tool preservation +
§3.3 green + §3.5 hand-verify are the proof.

## 4. Carve-outs and property tests

- **Cross-adapter parity is out of scope (§"Goal & scope").** `test/parity/**`,
  `test/runtime-parity/**`, and `test/browser/**` are **left byte-identical** —
  never collapsed, never deleted, never counted as a retained test that could
  make an integration test a strict subset. They prove cross-adapter/runtime
  equivalence, which is destroyed by collapsing across adapters.
- **`*.properties.test.ts` are out of scope** (ADRs 134–136). None currently live
  under `test/integration/**`, but the rule stands: a property is never collapsed,
  deleted, nor counted as covering an example. Mechanically identifiable by
  suffix and skipped.
- **`.skip` / `.todo` / `.fails` blocks and `describe.skipIf(!GIT_AVAILABLE)`
  wrappers** are left verbatim — the `skipIf` gate (present on every interop
  file) is preserved exactly so the suite still no-ops cleanly where `git` is
  absent.

## 5. Partitioning & ordering (for the plan phase)

**Granularity:** one **part per file for the giants** (a dense interop file is
itself a whole cross-tool surface), and **grouped parts by theme** for the
sub-~500-LOC tail. Each part = one atomic commit
`test(integration): minimise <file-or-theme>` that independently passes the part
gate. Files with no real collapse candidate (a handful of distinct-oracle tests
each) are **not touched** and get no part.

Dedicated single-file parts — *candidate* collapse density by LOC / `it` (the
plan/implementer confirms the actual collapse per file; a candidate that proves
minimal on inspection gets no part):

- `missing-value-refusal-interop.test.ts` (3391 / 102) — 3 oracle families ×
  many keys, with interleaved KEEPs;
- `config-interop.test.ts` (3234 / 100) — extend the existing matrices;
- `rename-similarity-interop.test.ts` (2578 / 27) — similarity-threshold sweep;
- `diff-type-change-interop.test.ts` (1057 / 45) — the 15×4 grid;
- plus `fsck-interop` (1403/17, corruption-kind sweep),
  `distinct-types-with-base-interop` (1392/22, type-pair grid),
  `diff-whitespace-interop` (1168/21, whitespace-mode sweep),
  `archive-interop` (1159/17), `bundle-interop` (1063/31),
  `notes-interop` (918/33, extend existing `it.each`),
  `diff-attr-binary-interop` (534/12), `bisect-midpoint-interop` (424/11),
  `lfs-pointer-interop` (426/16).

Themed grouped parts for the mid/small tail (diff family, merge/refusal family,
ref/reflog family, status/add family, network family, …), each kept
meaningfully sized.

**Ordering — Decision 3.** Unlike 27.1 there is no coverage-gated tier to front,
so the ordering rationale is *risk/payoff* not *backstop strength*. Recommended:
**giants first** (largest overlap, richest worked examples, highest payoff —
prove the collapse+cross-tool discipline where it matters most), then themed tail,
`network/` and `posix-only/` late (heavier spawn/async, platform-gated). Themed
grouping keeps related git behaviours reviewable together.

**Gates:**

- **Part gate** (every atomic commit):
  `npx vitest run <touched test files> && npm run check:types && biome check <touched files>`.
  Proves the collapsed/kept rows pass, typecheck, and lint (incl. the
  `noThenProperty` gate). For a `posix-only/` file, the vitest invocation runs it
  under the `posix-integration` project (verifiable on this darwin host); a
  `win-only/` file cannot be green-verified locally (Decision 6).
- **Partition-boundary checkpoint** (after a themed group of parts lands, and
  once at the end via `npm run validate`): `npm run test:integration` — the full
  integration project, catching any cross-file interaction; plus `validate`'s
  `check:test-pyramid` confirming the report-only `integrationProof` findings did
  not regress. **Never commit on a red gate.**

The tier-ratio pyramid budget is file-count based and warn-only; minimisation
removes no files, so it is not at risk.

## 6. Decision candidates (for the ADR conversation → ADR-499)

### Decision 1 — the integration-tier proof/backstop model (load-bearing)

Since coverage does not cover this tier, mutation is zero-signal, and the pyramid
GWT/AAA heuristics are unit-scoped/report-only:

- **(A) Proof-by-construction + cross-tool-preservation review + green suite +
  targeted hand-verify** (§3): triple preservation is a theorem; the reviewer
  verifies per-row `git`-spawn + byte-compare + union-of-fixtures by reading the
  diff; `test:integration` proves surviving rows pass; risky edits are
  hand-verified deterministically. **← recommended.**
- **(B) Add integration to the coverage run so a coverage number backstops it.**
  Cons: out of scope (touches `vitest.config.ts`/CI, a src-adjacent config
  change this PR forbids); integration coverage is noisy and slow.
- **(C) Flip `integrationProof` gating to `true` as the backstop.** Cons: that
  gate checks `@proves` headers, not overlap; irrelevant to collapse correctness;
  a budget/manifest edit this PR excludes.

### Decision 2 — overlap definition precision

- **2a. Is "same journey" vs "same code path" one trigger or two?**
  **(A) One trigger** — "same journey/path with different fixtures, identical
  oracle shape, each row still spawns git+tsgit"; operationally both collapse the
  same way. **← recommended.** (B) Two triggers with separate guard-rails —
  cons: no operational difference, doubles the rules.
- **2b. May the *consuming command* vary per `it.each` row** (the
  missing-value `commit`/`fetch`/`push` case)? **(A) Yes** — carry it as a row
  thunk + `gitArgs` when the *code path* and oracle are identical; a legitimate
  extension of 27.1's "one act per `it.each`". **← recommended.** (B) No — forbid
  command variance, keep one literal SUT per `it.each`; cons: blocks the single
  richest collapse in the tier.

### Decision 3 — partition granularity + ordering

- **(A) Per-file for the giants + themed grouped parts for the tail; order
  giants → themed tail → network/posix late; untouched files get no part.**
  Balances reviewability against part count; fronts the highest-payoff overlap.
  **← recommended.**
- **(B) Per-file uniformly (~100 parts).** Cons: process overhead dominates a
  long tail of near-minimal files.
- **(C) One mega-part per subsystem theme.** Cons: un-reviewable diffs; a
  regression is hard to localise.

### Decision 4 — does ADR-499 refine ADR-498, or stand alone?

- **(A) ADR-499 *refines* ADR-498 for the integration tier** — records only the
  tier deltas (no coverage gate; pyramid heuristics unit-scoped/report-only;
  cross-tool-preservation as the primary backstop; command-per-row collapse;
  giants-first ordering) and inherits the KEEP/COLLAPSE/DELETE rules, guard-rails,
  and construction proof verbatim. ADR-498 already names 27.2 as an inheritor.
  **← recommended.**
- **(B) ADR-499 restates the full methodology standalone.** Cons: duplicates
  ADR-498; the two drift.
- **(C) No new ADR; extend ADR-498 in place.** Cons: muddies a ratified,
  run-specific ADR with a second run's deltas.

### Decision 5 — minimum sibling count to justify a collapse

- **2 / (B) 3 / 4.** Recommend **3**, mirroring ADR-498: a 2→1 collapse saves
  little and can hurt readability given the heavier interop row boilerplate; at 2
  siblings, COLLAPSE only when the tests are mechanically identical modulo one
  fixture literal (e.g. the earlier-by-line tie-break pair), else KEEP.

### Decision 6 — are `posix-only/` and `win-only/` integration subdirs in scope?

- **(A) Both in scope; verify `posix-only/` locally (darwin host runs the
  `posix-integration` project) and rely on CI for `win-only/` (can't run
  locally).** Cons: a `win-only` part commits on a locally-unverifiable green.
- **(B) `posix-only/` in scope, `win-only/` deferred** to whoever can run
  `win-integration` (CI/Windows). Cons: leaves 2 files un-minimised. **←
  recommended** — do not commit a `win-only` collapse on faith; the 2 files are a
  negligible tail.
- **(C) Both out of scope** (mainline `test/integration/**` only). Cons: excludes
  5 verifiable `posix-only/` files for no reason.

## 7. Non-goals

- **No `src/` production change** (not even a comment) — tests-only.
- **No new tests** — minimisation only collapses/deletes/keeps existing ones. A
  genuine faithfulness or overlap *gap* found mid-work is surfaced, not papered
  over with a new test smuggled into a minimisation commit.
- **No touching `test/parity/**`, `test/runtime-parity/**`, `test/browser/**`**
  (cross-adapter/runtime carve-out, §4), nor any `*.properties.test.ts`.
- **No new `git` behaviour pinned** — every fixture already encodes an observed
  behaviour; `.claude/workflow/faithfulness.md` empirical pinning does not apply.
- **No touching the `@proves` header, `describe.skipIf(!GIT_AVAILABLE)` wrapper,
  or the `interop-helpers.ts` env/async plumbing** of any file.
- **No `sut`-retrofit or GWT/AAA re-styling** of kept tests — preserve each
  file's existing convention; the bar is "no worse than today", not "unit-tier
  polish".
- **No threshold, budget, or config edits** (`test-pyramid-budgets.json`,
  `mutation-budgets.json`, `vitest.config.ts`) — this PR raises no floor and
  moves no gate.
