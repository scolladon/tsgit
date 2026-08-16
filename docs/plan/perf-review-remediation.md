# Plan — perf-review remediation

> Source: design doc `docs/design/perf-review-remediation.md` (rev ccb6ad5c) · ADRs 640-652
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Map and ordering

| Part | Item | One-line scope |
|---|---|---|
| 1 | W1 | Regenerate the committed perf baseline (exclusive, long single-shot run) |
| 2 | W2 | `ObjectId.from` code-unit validator + examples + property test |
| 3 | W3 | `status` allocation profile → top-site fix **or** recorded finding (ADR-650) |
| 4 | W4 + W7a | Entry-cap the commit-graph header cache + its memory workload |
| 5 | W5 + W7b | fsck structural projection + its memory workload |
| 6 | W6 + W10 | `tsconfig.typecheck.json` + CI `.tsbuildinfo` cache + label-gate the two heavy jobs |
| 7 | W9a | Per-command rollup entries + `exports` keys + size rows + `SIZE_CAP` + resolution guard |
| 8 | W9b | Re-export the 10 leaked declaration types + regenerate `reports/api.json` |
| 9 | W8 | vitest pool / prepush worker-cap pilot — keep or revert (R12) |

Deviations from the design's §0 ordering, each forced and each stated where it applies:

- **W7 folds into W4 and W5 instead of following them.** Both cache oracles (W4 oracle 1,
  R10) are *peak before vs after* readings; a "before" reading requires the workload to
  exist before the fix. §0's `W4,W5 ──► W7` edge is a coverage dependency ("W7 covers
  both"), not a commit order, and the sizing rules forbid a standalone test-only part when
  an implementation part exists to fold into.
- **W9's `SIZE_CAP` move lands in the same commit as the entries, not before or after.**
  The entries push the pack to ≈825 KiB against a 750 KiB cap; any commit boundary between
  the two leaves `check:tarball` red. The design's own guard/entries rule ("the guard and
  the explicit keys land together") is honoured by putting the guard in that same commit —
  it is green on today's map and on the split map, and it protects the very commit that
  adds 50 keys.
- **W6 and W10 share one part.** Both edit only `.github/workflows/ci.yml` plus root
  config, neither has a `src/` delta, both are verified by the same three-step ladder
  (megalinter YAML → green CI run on the PR → post-merge timings). §0 places W10 "anywhere
  in the sequence".

## Repo-wide traps every part must know

1. **`biome check <path>` exits 1 with "No files were processed" when the path is outside
   `biome.json`'s `files.includes` allow-list.** Covered: `src/**`, `test/**`, root `*.ts`,
   root `*.json`, and a hand-listed set of `tooling/*.ts`. NOT covered: `docs/**`,
   `.github/**`, `tooling/bench-memory.ts`, `tooling/gen-bench-fixture.ts`,
   `tooling/verify-tarball.sh`. Each part's `### Gate` names only biome-covered paths;
   where a part needs a tooling file linted, it adds that path to `biome.json` in-part.
2. **`npm run profile <cmd>` overwrites `docs/perf/baseline.json` and `.md` with a
   single-command baseline** (`tooling/profile.ts` `main` always calls `writeBaseline`
   over the resolved workload subset). After any single-command oracle run, restore with
   `git checkout -- docs/perf/baseline.json docs/perf/baseline.md`. Only Part 1 commits
   those two files.
3. **`reports/api.json` staleness is a `prepush` gate (`check:doc-typedoc`), not a
   `validate` gate** — a green local `validate` can precede a red push hook. Any part that
   changes a public export regenerates it in-part with `npm run docs:json`.
4. **`rollup.config.ts` is outside `tsconfig.json`'s `include`** — `npm run build` is its
   only type check. `npm run check:types` will not see an error there.
5. **`.github/workflows/**` is outside `npm run validate` entirely.** No local gate reads
   it. megalinter's `YAML_YAMLLINT` catches syntax only, never a bad `uses:`/`needs:`/
   context expression.
6. **`vitest.config.ts` sets `testTimeout: 120_000` but no `hookTimeout`** — hooks keep the
   10 s default. Any new `beforeAll` that spawns `git`, generates a fixture or builds
   `dist/` needs an explicit per-hook timeout (60 000 ms+; 600 000 for a dist build) as the
   third argument. Scrub `GIT_*` from every spawned-git env (`-C` does not override
   `GIT_DIR`).
7. **Phase gate, run once after the last part:** `npm run validate` — and, because
   `check:doc-typedoc` is not one of its 22 dependencies, `npm run prepush` before pushing.
   Each part's own gate is stated in its `### Gate` block; none of them is a substitute.
8. No provenance references (phase / ADR / backlog numbers) in source or test code (R15).
   No suppression directives. Never commit on a red gate. Escalate blockers as
   `{ unit, reason, ≤3 options }`.
9. Serena is the default navigator/editor for TypeScript; it is already activated on this
   worktree. `Read`/`Grep` for markdown, JSON, YAML, shell and generated artefacts.

---

## Part 1 — Regenerate the committed perf baseline (W1)

### Context

**Run this part alone. `npm run profile` builds `dist-profile/` then spawns 13
`node --prof` children back to back; it is a long single-shot command and every share it
records is noise if any other CPU-heavy task runs concurrently in the same session. No
other part may run while this one is measuring.**

Files this part commits:

- `docs/perf/baseline.json` (24.7 kB today) and `docs/perf/baseline.md` (8.8 kB) —
  regenerated, not hand-edited.
- `cspell.json` — only if the regenerated `baseline.md` introduces a frame name cspell
  rejects. Add the word to the `words` array; never an inline suppression.

Producers, verified in place:

- `tooling/profile.ts` — `captureBaseline` (`:162-176`) loops the resolved workloads,
  `captureProfile` spawns `node --prof --experimental-strip-types tooling/profile.ts
  --child <cmd>`, `main` (`:176-213`) ends with `writeBaseline(baseline, ROOT)`.
- `tooling/profile-baseline.ts` — `writeBaseline` / `renderBaselineJson` /
  `renderBaselineMarkdown`; `machineBanner()` re-stamps `generatedOn`
  (`<platform-arch> / node <version> / <cpu model>`, descriptive, never compared).
- `tooling/profile-registry.ts` — 13 registered workloads (10 read + 3 write);
  `READ_ITERATIONS = 100`, `FAST_READ_ITERATIONS = 2000`, `HEAVY_READ_ITERATIONS = 2`,
  `WRITE_ITERATIONS = 100`. Read workloads run over `MEDIUM_FIXTURE`
  (`test/bench/support/fixture-generator.ts`: 5 000 commits / 20 000 blobs / 2 560 B),
  cached under `~/.cache/tsgit-bench/medium-v3`. Pre-warm with
  `npm run bench:fixture -- medium` before profiling so generation cost is not inside the
  measured run.

Staleness this repairs — the committed artifact was last written by
`35ea4eca 2026-07-13`, four perf-relevant merges ago (#255, #263, #271, #273). Current
`baseline.json` `commands.log.hotShares` still attributes `0.07` self to
`checkContainment`, and names `isContainedInEitherRoot`, `containmentVerdict`,
`walkInternal` — all **zero occurrences** in today's `src/**` (#273 deleted the
containment functions).

The current key set is exactly:
`log, status, pack-read, describe, name-rev, rev-parse, cat-file, show, diff, blame,
commit, add, merge`.

Gate interactions:

- No `validate` task reads either artifact. `docs/perf/hot-paths.json` — read by
  `tooling/bench-check.ts` under `bench:check` and asserted by
  `tooling/test/unit/hot-paths-consistency.test.ts` against the `*.bench.ts` set — is a
  *different* file and is untouched here.
- `check:spelling` runs `cspell "src/**/*.ts" "test/**/*.ts" "docs/**/*.md" "*.md"`, so
  `docs/perf/baseline.md` **is** covered. `cspell.json` already carries
  `ignoreRegExpList: ["[a-f0-9]{40}"]`.
- `check:doc-links` (lychee over `docs/**/*.md`) is unaffected — the renderer emits no
  links, only `| frame | self |` tables.
- ADR-652: **no staleness guard is added.** A profile frame name is not required to be a
  live symbol (`<anonymous>`, minifier artefacts such as `resolveObject$1`, and
  pattern-keyed regular-expression entries all appear legitimately).

Downstream consumers of this part's output: Part 2 reads the regenerated `log` entry's
`^[0-9a-f]{40}$` / `^[0-9a-f]{64}$` shares as its pre-change ground truth (R8); Part 3
reads the regenerated `status` entry's GC share (R9). Record both entries verbatim in the
implementation report so those parts do not have to re-derive them.

### TDD steps

1. **RED (oracle, not a unit test).** On the committed artifact, prove the staleness:
   `grep -c 'checkContainment\|isContainedInEitherRoot\|containmentVerdict\|walkInternal'
   docs/perf/baseline.json` returns a non-zero count while
   `grep -rn 'checkContainment' src/` returns nothing. That mismatch is the failing
   condition this part closes.
2. **GREEN.** `npm run bench:fixture -- medium`, then `npm run profile` (nothing else
   running). Commit both regenerated artifacts.
3. **Verify the oracle.** The four symbols appear **zero** times in the regenerated
   `baseline.json`; `Object.keys(commands)` still covers all 13 registered workloads (a
   short `node -e` / `python3 -c` read, not a committed test). If a workload emits no
   frames, `captureBaseline` prints a `warning: … produced no tsgit frames above the noise
   floor` line — report it, do not silence it.
4. **REFACTOR.** None: both files are generated. Do not hand-edit either.

### Gate

```bash
npm run check:types && npm run check:spelling
```

`npx vitest run` has no touched test and `biome check` has no covered touched file — both
`docs/perf/*.{json,md}` paths are outside `biome.json`'s allow-list, so invoking biome on
them would exit 1 on "No files were processed". If `cspell.json` was edited, append
`&& ./node_modules/.bin/biome check cspell.json`. What this gate actually exercises:
the spell check over the regenerated markdown, and that the tree still type-checks.

### Commit

```
chore(perf): regenerate the committed profiling baseline
```

---

## Part 2 — `ObjectId.from` code-unit validation (W2)

### Context

Files:

- `src/domain/objects/object-id.ts` — the edit. Current shape, verbatim:

  ```ts
  const SHA1_HEX_RE = /^[0-9a-f]{40}$/;      // :4
  const SHA256_HEX_RE = /^[0-9a-f]{64}$/;    // :5
  export const ObjectId = {
    from(hex: string): ObjectId {           // :10
      if (!SHA1_HEX_RE.test(hex) && !SHA256_HEX_RE.test(hex)) {
        throw invalidObjectId(hex);
      }
      return hex as ObjectId;
    },
    fromRaw(bytes: Uint8Array): ObjectId { … },   // :17 — DO NOT TOUCH (R2)
  } as const;
  ```

  Both regex constants are module-private with no other reader in the file; delete them
  with the rewrite. `ZERO_OID` (`:28`) and `EMPTY_TREE_OID` (`:35`) call `ObjectId.from`
  at module load — the new predicate must accept both literals or the module throws on
  import.
- `test/unit/domain/objects/object-id.test.ts` (307 lines) — **extend**, never replace.
  Existing tree: `describe('object-id')` > `describe('ObjectId.from')` >
  `describe('Given a valid 40-char or 64-char hex string')` >
  `describe('When calling ObjectId.from')` > `it.each(...)`. The existing invalid-input
  block asserts with `expect(() => ObjectId.from(hex)).toThrow(expect.objectContaining({
  data: { code: 'INVALID_OBJECT_ID', value: hex } }))` — new negative tests must use
  try/catch + direct `.data` assertions instead (repo convention: `toThrow` +
  `objectContaining` misses nested property mutations).
- `test/unit/domain/objects/object-id.properties.test.ts` — **new** sibling. Peer files
  for shape: `header.properties.test.ts`, `tree-cursor.properties.test.ts`. Shared
  generators live in `test/unit/domain/objects/arbitraries.ts` (`arbObjectId(40|64)` builds
  a valid id from `fc.constantFrom(...'0123456789abcdef')`); add any new generator there,
  not inline.

The hot call site (why this is worth doing at all): `src/domain/objects/commit.ts:22`
imports `ObjectId as ObjectIdFactory`, and `parseCommitContent` → `parseRequiredFields`
calls it once for the root tree (`:75`) and once per parent (`:79`) for **every** commit
`readObject` decodes. An `ObjectId.from(` grep does not find it — the alias hides it.

`invalidObjectId` is `src/domain/objects/error.ts:50-51`:
`new TsgitError({ code: 'INVALID_OBJECT_ID', value })`. The rewrite must call it with
`hex` **unmodified** — no trim, no truncation, no reformat (R1).

Fix shape (ADR-free; the design fixes it):

- accept iff `hex.length === 40 || hex.length === 64` **and** every code unit
  `c = hex.charCodeAt(i)` satisfies `(c >= 48 && c <= 57) || (c >= 97 && c <= 102)`;
- the four code-unit boundaries become **named constants** (no magic values);
- the predicate is a small module-private pure function; early return on the length
  mismatch; nesting never past 2;
- `throw invalidObjectId(hex)` stays the same call, unmoved.

Faithfulness matrix, pinned empirically on Node v22.22.3 — reproduce it as tests, do not
re-derive it:

| Input | regex pair | code-unit predicate |
|---|---|---|
| 40 × `a` | true | true |
| 40 × `a` + `\n` | **false** (JS `$` admits no trailing newline) | false |
| 40 × `a` + `\r` | false | false |
| 40 × `A` | false | false |
| 39 × `a` / 41 × `a` / `''` | false | false |
| 64 × `0` | true (SHA-256 arm) | true |
| 40 × `١` (Arabic-Indic digit) | false | false |
| 39 × `a` + one astral emoji (2 code units) | false | false |

Lone surrogates: the regexes carry no `u` flag, so they match on **code units**;
`charCodeAt` reads code units too, and a surrogate half (`0xD800…0xDFFF`) is outside both
accepted ranges. Both reject. A differential sweep of 200 000 random strings over
`0-9 a-f A-F space g z \n \r ١ <astral emoji>` at lengths 0-69 found **0 mismatches**.

Gate interactions:

- **Coverage**: `src/domain/objects/**` is inside the 100 % line/branch/function/statement
  gate (`vitest.config.ts:80-98`). Every branch of the length disjunction and both
  code-unit ranges need line **and** branch coverage.
- **Mutation**: `domain` bucket, break **99**, low/high 100 (`mutation-budgets.json`) —
  the strictest bucket. A code-unit loop is mutation-dense (`EqualityOperator`,
  `ConditionalExpression`, `ArithmeticOperator`, `LogicalOperator` per comparison).
  Explicit boundary examples carry the killing load; a property test alone will not
  reliably kill them because Stryker scores each mutant against whatever inputs that run
  generated. Stryker has no numeric-literal mutator, so the named boundary constants
  themselves are not mutated — the comparisons around them are.
- **Size**: the loop is a few dozen bytes larger minified than two regex literals. The
  browser no-build bundle is at 156.04 / 160 kB gzip (97.5 % consumed) — `check:size` must
  be **observed** green on the real build, never assumed.
- **Architecture**: stays inside `src/domain/**`, zero new imports.
- No new public symbol: `ObjectId.from` is already exported. No `reports/api.json` churn,
  no barrel/facade/doc-page gate.

Oracle (R8): after the change, `npm run profile log`, compare the `^[0-9a-f]{40}$` and
`^[0-9a-f]{64}$` self-shares against Part 1's regenerated `log` entry — same machine, same
`MEDIUM_FIXTURE`, same `READ_ITERATIONS = 100`. **Report absolute shares on both sides,
never a ratio alone**, and restore the baseline artifacts afterwards
(`git checkout -- docs/perf/baseline.json docs/perf/baseline.md`) — this part commits no
`docs/perf` change. Attribution caveat to restate rather than over-claim: `src/**` holds
**12** distinct `/^[0-9a-f]{40}$/` literals and V8's `--prof` digest keys regex ticks by
**pattern source**, so the digest line is the sum over all twelve; only `object-id.ts:4` is
on the `log` per-oid path, so the attribution holds *for that workload only*.

### TDD steps

**This is a behaviour-preserving rewrite (R1), so there is no input whose verdict changes —
a classic RED is unavailable and pretending otherwise would be theatre.** The tests are
written first anyway, and each one is justified by naming the *plausible wrong rewrite* it
fails against; the failing-before condition that does exist is the performance oracle
(step 6) and the mutation surface (step 5).

1. **Tests first — boundary examples.** Extend `object-id.test.ts` with one isolated test
   per mutable comparison, each a single-character substitution into an otherwise-valid
   40-character id: `/` (0x2F) reject, `0` (0x30) accept, `9` (0x39) accept, `:` (0x3A)
   reject, `` ` `` (0x60) reject, `a` (0x61) accept, `f` (0x66) accept, `g` (0x67) reject,
   `A` and `F` reject. Plus lengths 39/40/41/63/64/65 and `''`, plus the `…\n` and `…\r`
   trailing-whitespace cases. Guard clauses need isolated tests: the length check and the
   code-unit check must each be triggered **alone** — a 39-character string containing a
   `g` proves neither guard individually. Negative assertions use try/catch and assert
   `err.data` equals `{ code: 'INVALID_OBJECT_ID', value: <the exact input> }`; a
   `toThrow(TsgitError)` type-only check is forbidden. Each test's named failure mode —
   state it in the report: `A`/`F` catch a `toLowerCase()`-normalising rewrite; `…\n`
   catches an `endsWith`/`m`-flag rewrite; length 41 catches `>= 40`; length 63/65 catch a
   `>= 40 && <= 64` range check; the astral-emoji case catches a `for…of` (code-point)
   loop; `:` and `` ` `` catch inverted or off-by-one range boundaries.
2. **Tests first — property.** New `object-id.properties.test.ts`: *the validator agrees
   with the pair of original regular expressions on every input.* The oracle is those two
   regex literals inlined into the test file — an independent oracle, not a copy of the
   production loop, so this is a genuine lens-3 property (total function over an algebraic
   grammar). **It passes trivially before the edit** (the implementation *is* those
   regexes); its whole value is that it becomes a real differential test the moment step 3
   lands, and it is what makes the rewrite provably faithful over the negative space the
   examples cannot enumerate. Generators, boundary-biased because uniform random strings
   are almost never 40 hex characters: `arbObjectId(40)` / `arbObjectId(64)`; those with
   one character replaced by an arbitrary code point; those with a prefix/suffix appended;
   unconstrained `fc.string()`; and a code-unit string arbitrary covering lone surrogates.
   `numRuns: 200`. Never commit a seed. The examples stay **additive** — never delete one
   to make room for the property.
3. **GREEN.** Rewrite `ObjectId.from` per the fix shape; delete `SHA1_HEX_RE` and
   `SHA256_HEX_RE`.
4. **REFACTOR.** Extract the code-unit predicate to a module-private pure function with a
   name that says what it decides; hoist the four boundaries to named constants; confirm
   `ZERO_OID` and `EMPTY_TREE_OID` still construct at module load.
5. **Coverage + mutation check in-part.** `npm run test:coverage` must stay at 100 % for
   `src/domain/objects/object-id.ts`. Run the scoped Stryker check per
   `.claude/workflow/mutation.md` if the part's time budget allows; otherwise flag the
   file for the mutation phase.
6. **Oracle.** `npm run profile log`, report both shares, restore `docs/perf/`.

### Gate

```bash
npx vitest run test/unit/domain/objects/object-id.test.ts \
              test/unit/domain/objects/object-id.properties.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/objects/object-id.ts \
        test/unit/domain/objects/object-id.test.ts \
        test/unit/domain/objects/object-id.properties.test.ts \
  && npm run test:coverage
```

`test:coverage` is added because this file is inside the 100 % gated set and a missed
branch there fails `validate` at the phase boundary otherwise.

### Commit

```
perf(domain): validate object ids with a code-unit scan instead of two regexes
```

---

## Part 3 — `status` allocation churn: investigate, then maybe fix (W3)

### Context

**This part is complete either way.** ADR-650 fixes the exit criterion: capture the
allocation profile **first, on the unmodified tree**; if its **top** site accounts for
**≥10 % of allocated bytes** on the `status` workload, fix that one site — and only that
one — and re-measure. Below 10 %, the churn is diffuse: the outcome is a **recorded
finding and no code change**. That is a pass, not a miss. One site, not several, keeps the
GC-share oracle attributable to a single edit.

Always-committed artifact: `docs/perf/status-allocation-profile.md` — a new short record
carrying the profile's top sites with absolute allocated bytes, the 10 % verdict, the
measurement environment banner (`node --version`, `git --version`, host), and — when a fix
lands — the before/after GC tick shares. It lives beside `baseline.md` because it is the
same class of artifact: a machine-specific measurement record, not a claim. This is what
makes the no-fix outcome a real commit.

Investigation method (the design fixes the method; it deliberately does **not**
pre-select the edit):

1. `npm run profile status` on the current tree (after Part 1) to restate the GC share.
   Restore `docs/perf/baseline.{json,md}` afterwards.
2. Capture an **allocation** profile — not a CPU profile — on the same child workload:
   `tooling/profile-registry.ts` `READ_WORKLOADS.status` → `await repo.status()` over
   `MEDIUM_FIXTURE`, `READ_ITERATIONS = 100`. Use `node --heap-prof` (or the inspector's
   `HeapProfiler.startSampling`) against the same built entry `tooling/profile.ts` already
   loads: `dist-profile/esm/index.node.js`, produced by `npm run build:profile`.
3. Rank sites by **bytes allocated**. Only then choose.

Reference signal from the review (restate it, do not quote it as current): `status` spent
17.5 % of ticks in GC, with `MapPrototypeSet` 3.6 % and `ArrayPrototypeJoin` 1.7 %.

Pre-chewed candidate sites, ranked by how well each explains those two builtins — the
profile decides, this list only saves a search:

| Candidate | Anchor | Why it fits |
|---|---|---|
| `ancestorsOf` in the ignore evaluator | `src/application/primitives/internal/ignore-evaluator.ts:81-91` | Called **per walked path** through the closure `buildRepoIgnorePredicate` returns (`:56-74`). Per call: one `path.split('/')` array, then per depth level one `segments.slice(0, i)` array **and** one `.join('/')` string — `1 + 2(d-1)` allocations for depth *d*, nearly all discarded immediately by the `stackedDirs.has(ancestor)` skip at `:64`. Directly explains `ArrayPrototypeJoin`. |
| Five per-path collections in `status` | `src/application/commands/status.ts:143` (`stage0Map`), `:146-147` (`trackedPaths`), `:199-203` (`deltaMap`), `:242-245` (`stagedKindMap`), `:261-263` (`paths`) | Five `Map`/`Set` structures over the same `FilePath` key space, each sized by the index. Explains `MapPrototypeSet`. |
| Shared stat map | `src/application/primitives/internal/working-tree-stat-map.ts:23-31` | One `samples.set` per stat'd path — small and deliberate (it *replaced* duplicate `lstat` calls); listed for completeness. |
| Duplicate `ancestorsOf` | `src/application/primitives/is-ignored.ts:44-55` | A near-verbatim second copy on the `check-ignore` path, **not** on the `status` path. Relevant only if the fix is extracted into a shared helper. |

Fix shape **if** the profile lands on `ancestorsOf` (most likely; stated so the part can be
sized, not as a pre-decision) — replace split/slice/join with an `indexOf` scan that
allocates exactly one string per ancestor:

```ts
let idx = path.indexOf('/');
while (idx !== -1) {
  out.push(path.slice(0, idx));
  idx = path.indexOf('/', idx + 1);
}
```

**Mutation hazard this creates (R5) — the part's hardest obligation.** The current code
carries six `// Stryker disable next-line … equivalent` proofs written against
`segments.length <= 1`, `out: string[] = []` and the `rules.length > 0` guard:

- `ignore-evaluator.ts:59` (`ArrayDeclaration` on `stackedDirs`), `:63`
  (`ConditionalExpression` on the `stackedDirs.has` skip), `:67`
  (`EqualityOperator,ConditionalExpression` on `rules.length > 0`), `:83`
  (`ConditionalExpression,EqualityOperator,ArrayDeclaration` on `segments.length <= 1`),
  `:85` (`ArrayDeclaration` on the `out` seed).
- `is-ignored.ts:46`, `:48`, `:50` carry the same class plus an `EqualityOperator` proof on
  the loop bound.

An `indexOf` rewrite **deletes the `segments` array entirely**, which falsifies the `:83`
proof verbatim. Every surviving directive on a rewritten line must be **re-proven against
the new expression with its text updated, or removed and the mutant killed honestly** —
never carried forward. Equivalence proofs are structure-specific.

Preferred discharge (design's own recommendation): a real property test instead of a
re-proven suppression. `ancestorsOf` is a lens-4 fit (counting invariant) — a
`*.properties.test.ts` sibling asserting that the result length equals the count of `/` in
the path and that each element is a strict prefix ending at a `/` boundary kills the
loop-bound mutants the current directives suppress.

**`ancestorsOf` is module-private today** (`ignore-evaluator.ts:81`), so a direct property
test needs it exported. Decision: **export it from `ignore-evaluator.ts`** — the module
lives under `src/application/primitives/internal/`, which no barrel re-exports and which
`package.json`'s `exports` map cannot reach even after Part 7 (only `commands/<name>` and
the existing subpaths are entries; `internal/` stays behind the chunk boundary), so this is
an **internal** export with zero public-surface gates: no barrel row, no facade binding, no
doc page, no `reports/api.json` churn. knip counts it used because test files are knip
entries via its vitest plugin. Fallback if the export is judged unwanted: express the same
invariant through `buildRepoIgnorePredicate` by capturing the directories `loadDirRules` is
asked for (an `instrumentedContext`-style fake), which is strictly more work for the same
signal.

Test net if a fix lands:

- `test/unit/application/commands/internal/build-ignore-evaluator.test.ts` (289 lines) —
  covers `buildIgnoreEvaluator` and `buildRepoIgnorePredicate`, including a
  "3-level ancestor chain" case (`:179`) and a "two sibling paths under the same ancestor"
  case (`:199`). Extend here with table-driven examples for the ancestor sequence itself
  (`''`, `a`, `a/b`, `a/b/c`, `a//b`, leading and trailing `/`) asserting the exact array,
  **root-first** — that is the contract both callers depend on.
- `test/unit/application/primitives/is-ignored.test.ts` — the second copy's net; touch only
  if the helper is shared.
- `test/integration/gitignore-end-to-end.test.ts` — the behavioural backstop.

Gate interactions: `ignore-evaluator.ts`, `is-ignored.ts` and `status.ts` are in the
`application` mutation bucket (break 95 / low 98) and **outside** the coverage gate.
`check:duplicates` (jscpd, `src/` only, threshold 5 %, `minLines: 5`, `minTokens: 50`)
already tolerates the two `ancestorsOf` copies; extracting a shared helper can only improve
that number. The new markdown record is covered by `check:spelling` and `check:doc-links`
(emit no links, or only links that resolve).

Oracle (R9): GC tick share on `npm run profile status`, same machine / fixture /
iterations, before vs after, **plus** the allocation profile's own top-site bytes for the
attributed construct. Both as absolute numbers.

Shared-file note: `tooling/profile.ts` and `tooling/profile-registry.ts` are also cited by
Part 1. Neither part edits them — both read them to drive the profiler. The parts stay
separate because Part 1 regenerates a committed artifact under an exclusive-CPU rule and
this part is an investigation whose outcome may be no code change at all.

### TDD steps

1. **Measure first, edit nothing.** `npm run build:profile`, capture the heap-sampling
   profile over the `status` workload, rank sites by allocated bytes. Write
   `docs/perf/status-allocation-profile.md` with the top sites, absolute bytes, share of
   total, and the environment banner.
2. **Branch on the 10 % verdict.**
   - **< 10 %** → stop. The record is the deliverable. Commit it. Do not touch `src/`.
   - **≥ 10 %** → continue to step 3 for that one site only.
3. **Tests first.** Add the ancestor-sequence table-driven examples (exact arrays,
   root-first) to `test/unit/application/commands/internal/build-ignore-evaluator.test.ts`
   and the counting-invariant property to a new
   `test/unit/application/commands/internal/build-ignore-evaluator.properties.test.ts`
   sibling (generators in the neighbouring `arbitraries.ts` if one is needed). This is
   behaviour-preserving work, so they pass against the current implementation — their value
   is the wrong rewrites they catch, and each must be named in the report: dropping
   root-first order; yielding the path itself as its own ancestor; mishandling `a//b`
   (consecutive separators produce an empty segment that `split` yields and `indexOf`
   scanning also must); mishandling a leading or trailing `/`.
4. **GREEN.** Apply the single-site fix.
5. **REFACTOR + R5.** Re-read every Stryker directive on a rewritten line; re-prove against
   the new expression (updating the proof text) or delete it and let the new test kill the
   mutant. Do not extend a directive to new lines without a fresh proof.
6. **Oracle.** Re-run `npm run profile status`; append before/after GC shares to the
   record; restore `docs/perf/baseline.{json,md}`.

### Gate

No-fix outcome:

```bash
npm run check:types && npm run check:spelling && npm run check:doc-links
```

Fix outcome (adjust the file list to what was actually touched):

```bash
npx vitest run test/unit/application/commands/internal/build-ignore-evaluator.test.ts \
              test/unit/application/commands/internal/build-ignore-evaluator.properties.test.ts \
              test/unit/application/primitives/is-ignored.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/ignore-evaluator.ts \
        test/unit/application/commands/internal/build-ignore-evaluator.test.ts \
  && npm run check:spelling
```

`biome check` is not invoked on `docs/perf/status-allocation-profile.md` — markdown is
outside biome's allow-list and the call would exit 1 on "No files were processed".

### Commit

Fix outcome:

```
perf(status): allocate one string per ancestor in the ignore walk
```

No-fix outcome:

```
docs(perf): record the status allocation profile finding
```

---

## Part 4 — Entry-cap the commit-graph header cache + its memory workload (W4 + W7a)

### Context

**Source edit** — `src/application/primitives/internal/read-commit-graph.ts`:

```text
:36-41   interface CommitHeader { rootTree: ObjectId; parents: readonly ObjectId[];
                                  committerDate: number; generation: number }
:67      const headerCache = new WeakMap<Context, Map<ObjectId, CommitHeader>>();
:191-198 getHeaderCache(ctx) → `new Map()` on first use
:258-260 read path  (cache.get)
:273     write path (cache.set) — never evicts
```

The outer `WeakMap` is keyed by `Context`, so the inner `Map` lives for the whole lifetime
of an open repository: a full-history walk inserts one entry per commit in the graph and
drops none. It is the only unbounded cache among its siblings — `deltaCache`
(`src/index.node.ts:99-102`, `createLruCache(16 MiB, 65 536)`), bitmap reconstruction
(`src/application/primitives/internal/bitmap-reconstruct.ts:46`, `createLruCache(8 MiB)`),
parent-realpath (`src/adapters/node/node-file-system.ts:446`,
`createLruCache(128 KiB, 512)`).

Fix, settled by ADR-645: swap the inner `Map<ObjectId, CommitHeader>` for
`LruCache<CommitHeader>`, entry-capped at **65 536**:

```ts
import { createLruCache, type LruCache } from '../../../domain/storage/lru-cache.js';
// module-private, named — no magic value
const HEADER_CACHE_MAX_ENTRIES = 65_536;
createLruCache<CommitHeader>(Number.POSITIVE_INFINITY, HEADER_CACHE_MAX_ENTRIES);
// write path:
cache.set(id, header, 1);
```

Mechanics verified against `src/domain/storage/lru-cache.ts`: `get(key: string)` /
`set(key, value, byteSize)` are a drop-in for this usage, and `ObjectId` is a branded
`string` so it is assignable without a cast. `evict()` (`:56-63`) loops while
`currentSize > maxSizeBytes || map.size > maxEntries`, so entry-count capping works
directly. Both `set` guards are satisfied: `byteSize <= 0` throws (1 is positive),
`byteSize > maxSizeBytes` silently drops (1 < Infinity). `currentSize` degenerates into an
insert counter and `maxSize` reports `Infinity`; neither is read here. 65 536 mirrors the
`DEFAULT_DELTA_CACHE_ENTRIES` value that already appears (as a module-private constant, the
repo's existing pattern) in `src/index.node.ts:32`, `src/index.browser.ts:22`,
`src/adapters/{memory,browser,node}/*-adapter.ts` — define a local named constant, do not
import across layers.

Correctness (R3) — eviction is hazard-free by construction: `commitHeader` (`:257-288`)
uses the cache purely as a memo; on a miss it re-runs `findOwnPosition` → `commitDataAt` →
`resolveParentIds` against `graph`, the **already-parsed, already-resolved** `LoadedGraph`
held by `graphCache`. No `ctx.fs` call is on that path. The module's staleness reasoning
(`:53-66`) is about the shallow gate, settled once per `Context` inside `loadGraphUncached`
and memoised independently of the header cache — eviction cannot re-open it. One asymmetry
to preserve: a graph **miss** (`found === undefined`, `:267`) returns `undefined` uncached
today and must still do so.

**Tests** — `test/unit/application/primitives/internal/read-commit-graph.test.ts`
(688 lines). Helpers already present: `buildSeededContext`, `instrumentedContext`,
`writeCommitGraph` (from `../fixtures.js`), `withFsOverride`, `buildFiveCommitHistory`,
`expectHeaderMatchesCommit`. The existing case at `:329-350` —
*"Given a commit-graph consulted across two separate commitHeader calls / When both calls
target the same Context / Then the graph file is read only once"* — already uses
`instrumentedContext(base)` and filters `calls()` on `method === 'read' && path.includes
('commit-graph')`. That is the exact instrument for the no-I/O-after-eviction assertion;
extend beside it rather than inventing a double.

**Memory workload (W7a)** — `tooling/bench-memory.ts` (241 lines):

- Existing shape to copy: `WorkloadReport` (`before`/`peak`/`after` for `rss` and
  `heapUsed`, `node`, `platform`), `gcBaseline(gc)`, `maxSample`, `toReport`,
  `runDeltaChainWorkload` (`:123-144`), `runLargePackWorkload` (`:170-191`, gated behind
  `TSGIT_BENCH_LARGE`), and `main` (`:214`) which pushes reports and writes
  `reports/benchmarks/memory.{json,md}`. `openRepository` is dynamic-imported from
  `dist/esm/index.node.js`; `npm run bench:memory` builds first and runs under
  `--expose-gc --experimental-strip-types`.
- **Drive the walk with `repo.primitives.walkCommitsByDate({ from: [fixture.headCommitId as
  ObjectId] })`, drained with `for await (const _ of walk) { … }` and retaining nothing —
  not `repo.log()`.** `log` (`src/application/commands/log.ts:47`) takes no default limit
  and materialises the **whole** history into a `LogEntry[]`; on a 70 000-commit fixture
  that array's own retention swamps the cache signal the workload exists to read.
  `walkCommitsByDate` (`src/application/primitives/walk-commits-by-date.ts:22`) is an
  `AsyncIterable<Commit>`, bound at `repo.primitives.walkCommitsByDate`, and streams.
- Add `commit-walk-header-cache` over
  `MEDIUM_FIXTURE_WITH_COMMIT_GRAPH` (`test/bench/support/fixture-generator.ts:80-84` —
  `MEDIUM_FIXTURE` + `commitGraph: true`, label `medium-commit-graph`). **The commit-graph
  is the precondition, not a detail**: `commitHeader` is only reached when the fixture
  carries one. This spec already exists and is already generated in nightly CI by
  `test/bench/log.bench.ts` (which `npm run bench:summary` runs before
  `npm run bench:memory` in `.github/workflows/bench.yml`), so the ungated workload costs
  the nightly job nothing new. Assert the graph file's presence in the workload's setup and
  fail loudly if absent — a silently graph-less fixture measures nothing.
- Add `commit-walk-header-cache-large` for the eviction reading, gated behind **its own**
  `TSGIT_BENCH_HEADER_CACHE` env var — **not** `TSGIT_BENCH_LARGE`, which also switches on
  `large-pack-spread-read` and its ~500 MB `LARGE_FIXTURE`; the two must be independently
  runnable. Document the new form in the module's header comment block (`:1-16`, which
  already lists the invocation forms) and add the guard beside the existing
  `process.env.TSGIT_BENCH_LARGE !== undefined` test in `main` (`:221`). The workload runs
  over a **new** spec in `test/bench/support/fixture-generator.ts` sized **above** the
  65 536 cap (no existing spec is: `LARGE_FIXTURE` is 50 000 commits). Shape:
  `{ label: 'header-cache', strategy: 'deep-ancestry', commits: 70_000, blobs: 1,
  blobBytes: 256, commitGraph: true }` — add `'header-cache'` to the `FixtureSpec['label']`
  union (`:32-46`) and export the const beside `DEEP_ANCESTRY_LARGE`. `generateInto`
  already honours `commitGraph` for every strategy (`:594`). Cache dirs are per-label
  (`cacheDirFor`), so the new spec does not invalidate existing caches on disk — but the
  nightly fixture cache key is `hashFiles('test/bench/support/fixture-generator.ts')`
  (`bench.yml:29`), so editing that file **does** force one full regeneration of `medium`
  and `delta-chain` on the next nightly run. That is a one-off cost inside the job's
  30-minute timeout; state it in the report. Do **not** add a pre-warm step: that would
  drag `tooling/gen-bench-fixture.ts`'s hardcoded label ladder (`:24-36`) into scope.
- **`tooling/bench-memory.ts` is NOT in `biome.json`'s `files.includes` allow-list**, so it
  is silently unlinted today and `biome check tooling/bench-memory.ts` exits 1 on "No files
  were processed". Add `"tooling/bench-memory.ts"` to that array in this part. Probed: with
  the path added, biome reports exactly **one** pre-existing violation —
  `assist/source/organizeImports` at `:24-28` (`LARGE_FIXTURE` must sort after
  `ensureScaledFixture`) — auto-fixed by `biome check --write`. No other finding.

Gate interactions: `application` mutation bucket (break 95). `createLruCache` is already
exported from `src/domain/storage/index.ts:27` — no new public surface, no
`reports/api.json` churn, no barrel/facade/doc gate. The new import edge
`application → domain/storage` is permitted by `.dependency-cruiser.cjs` (only
`primitives → commands`, `primitives → adapters`, `domain → outward` and friends are
forbidden). Stryker has no numeric-literal mutator, so `65_536` and `1` are not mutated.
`tooling/**/*.ts` is inside `check:types`.

Oracle — two readings, both required:

1. **Memory**: `TSGIT_BENCH_HEADER_CACHE=1 npm run bench:memory` peak `heapUsed` for the
   above-cap workload, before the edit and after. Peak must flatten — the pre-change cache
   retains one entry per commit for all 70 000, the post-change one stops at 65 536. Report
   absolute bytes on both sides, and the ungated `medium-commit-graph` row too (it should
   move by roughly nothing — 5 000 entries never reach the cap, which is itself the check
   that the cap did not accidentally shrink the common case).
2. **No time regression**: `npm run profile log` self-shares before vs after — a cap set
   too low would surface as increased time in `positionOf` / `findOwnPosition`. Restore
   `docs/perf/baseline.{json,md}` after.

### TDD steps

1. **Harness first (it is the oracle, not the subject).** Add both bench-memory workloads
   and the fixture spec; add `tooling/bench-memory.ts` to `biome.json` and fix the one
   import-order violation. Run `npm run bench:memory` and
   `TSGIT_BENCH_HEADER_CACHE=1 npm run bench:memory` on the **unmodified** cache and record
   the "before" peaks — this reading is unobtainable once the fix lands.
2. **Tests first — invariance.** In `read-commit-graph.test.ts`, add under `describe('commitHeader')`:
   (a) *Given a commit-graph and a repeated walk / When commitHeader is called for every
   commit twice / Then every returned `CommitHeader` is deep-equal across both passes* —
   uses `expectHeaderMatchesCommit`; (b) *Given a graph already loaded / When commitHeader
   is called for a commit whose header is not cached / Then `instrumentedContext`'s
   `calls()` records no additional `read` on a `commit-graph` path* — the re-derive-without-I/O
   proof (R3); (c) *Given an oid absent from the graph / Then `undefined` is returned and
   nothing is cached for it* (the uncached-miss asymmetry). Before the edit (b) and (c)
   pass and (a) passes — so write them so they would fail against a cache that re-reads or
   caches misses, and say so in the report; the genuinely new-behaviour assertion is that
   the LRU is entry-capped, which is proven by `lru-cache.ts`'s own tests plus the memory
   oracle, not by a 65 537-entry unit test.
3. **GREEN.** Swap the inner `Map` for `createLruCache<CommitHeader>(Number.POSITIVE_INFINITY,
   HEADER_CACHE_MAX_ENTRIES)`; update `getHeaderCache`'s return type; `cache.set(id, header, 1)`.
4. **REFACTOR.** Name the constant, keep `getHeaderCache` a one-purpose function, update the
   `:53-66` comment only if the swap makes any sentence false.
5. **Oracle.** Re-run `TSGIT_BENCH_HEADER_CACHE=1 npm run bench:memory` (after) and
   `npm run profile log`; report absolute numbers; restore `docs/perf/`.

### Gate

```bash
npx vitest run test/unit/application/primitives/internal/read-commit-graph.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check \
        src/application/primitives/internal/read-commit-graph.ts \
        test/unit/application/primitives/internal/read-commit-graph.test.ts \
        test/bench/support/fixture-generator.ts \
        tooling/bench-memory.ts biome.json
```

`tooling/bench-memory.ts` is only a legal argument **after** it is added to
`biome.json`'s `files.includes` in this same part.

Shared-file note: `tooling/bench-memory.ts` is also touched by Part 5. They stay separate
because they bound two unrelated caches in two unrelated source files with two independent
oracles; the shared file gains one self-contained workload function per part.

### Commit

```
perf(commit-graph): bound the per-repository header cache
```

---

## Part 5 — fsck stores a structural projection + its memory workload (W5 + W7b)

### Context

**Source edit** — `src/application/commands/internal/fsck/object-cache.ts`:

```text
:34       export type CachedGitObject = GitObject | null      ← the type to replace
:244-250  export interface ObjectCacheResult { cache; unrecoverable; recovered }
:252-256  interface CacheAccumulator
:283-304  export async function buildObjectCache(ctx, universe, unreadable)
:296      // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent — verifyHash…
:297      const obj = await readObject(ctx, id, { verifyHash: false });
:298      acc.cache.set(id, obj.type === 'commit' ? applyGraft(obj, shallow) : obj);
```

`buildObjectCache` loops the whole universe and retains every decoded `GitObject` —
**including each blob's full `content: Uint8Array`** — in one `Map` held for the entire
command. Peak is O(total repository content); real git streams.

The decisive finding, traced consumer by consumer: **no consumer ever reads blob bytes
from this map.**

| Consumer | Anchor | Fields it touches |
|---|---|---|
| `buildBlobFilenameMap` | `content-validation.ts:96-112` | `obj.type === 'tree'`, then `entry.name` and `entry.id` |
| `buildInEdgeMap` → `recordOutEdges` | `reachability.ts:11-22`, `:30-44` | commit `data.tree` + `data.parents`; tree `entries[].id` + `entries[].mode`; tag `data.object` |
| `buildReachableSet` → `visitObject` → `processCommit`/`processTree`/`processTag` | `reachability.ts:126-177`, `:85-125` | the same out-edge set, plus `obj.type`; tree entries also need `mode` (GITLINK skip, DIRECTORY → `toType: 'tree'`) ; tag needs `data.objectType` and `data.tagName` |
| `collectTypeFindings` / `resolveObjectType` | `reachability.ts:207-230` | `obj == null`, and `obj.type` |

Content validation reads raw bytes on its own path (`content-validation.ts`
`tryGetRawObjectBody`), never through this cache.

Fix, settled by ADR-646: replace `CachedGitObject = GitObject | null` with a **structural
projection** carrying `{ type }` plus exactly the fields the passes consume, and `null` for
unreadable. Minimum field set implied by the table above: commit → `tree`, `parents`; tree →
`entries[] { id, mode, name }`; tag → `object`, `objectType`, `tagName`; blob → nothing
beyond `type`. Peak drops from O(repo content) to O(graph metadata) with **zero** re-reads,
zero added I/O and no async signature changes — all four consumers keep taking a
synchronous `ReadonlyMap`.

Correctness (R4) — the projection must preserve the two distinctions the passes depend on:
`null` (unreadable) versus present, and the object's `type`. **`applyGraft(obj, shallow)`
must be applied *before* projecting a commit** (`:298`), so the grafted parent list is what
the walk sees — a shallow repository's reachability verdict depends on it. The `recovered`
and `unrecoverable` maps and `recordUnreadable` (`:262-277`) are untouched. Findings, their
order, and exit codes must be byte-identical for every repository shape, including corrupt,
shallow, connectivity-only and `unreadable: 'classify'`.

Why not an LRU (recorded so the decision is informed): all four consumers take a
synchronous `ReadonlyMap`; a byte-capped LRU with re-read-on-eviction makes all four async,
and the re-reads run through `auditCtx`, which deliberately carries `NO_DELTA_CACHE`
(`src/application/commands/fsck.ts:39-50`, `:64`) — every evicted packed object would re-pay
full delta-chain resolution, and the audit walk touches each object at least twice.

Out of scope (ADR-646 explicitly declines it): folding `buildBlobFilenameMap` into the
build pass so tree-entry *names* are never retained either. Only revisit if the memory
oracle shows tree names are material — report the number, do not act on it here.

Call sites and type consumers to update: `src/application/commands/fsck.ts:77-81`
(the single `buildObjectCache` call), `reachability.ts:1-5` and `:31`, `:143`, `:207`
(imports `CachedGitObject` and types `GitObject`-shaped locals),
`content-validation.ts:96-112` (inline `import('./object-cache.js').CachedGitObject`).
Use Serena's `find_referencing_symbols` on `CachedGitObject` before editing — the inline
`import(...)` type in `content-validation.ts` will not show up in a naive import grep.

**Tests**: `test/unit/application/commands/fsck.test.ts`,
`test/unit/application/commands/fsck.properties.test.ts`,
`test/unit/application/commands/fsck-finding-ids.ts` (shared helper),
`test/unit/application/commands/internal/fsck/content-validation.test.ts`, and the
integration net `test/integration/fsck-interop.test.ts`,
`test/integration/midx-fsck-interop.test.ts`,
`test/integration/rev-bitmap-fsck-interop.test.ts`,
`test/integration/fsck-pack-accessibility-interop.test.ts` — plus the parity scenarios
`test/parity/scenarios/fsck.scenario.ts` and `fsck-degraded-store.scenario.ts`. The
integration suites spawn real `git`; the global `testTimeout` is 120 000 ms
(`vitest.config.ts:10`), which is sufficient, but scrub `GIT_*` from any new subprocess env
(existing helpers already do).

**Memory workload (W7b)** — `tooling/bench-memory.ts`, same conventions as Part 4 (which
already added the file to `biome.json`; this part only edits it). Add `fsck-object-cache`
emitting **two** report rows, one per fixture, so R10's sub-linearity is readable straight
off the nightly artifact:

- lean fixture: `SMALL_FIXTURE` (`fixture-generator.ts:63-69` — 50 commits / 200 blobs /
  2 560 B ≈ 512 kB of blob content);
- fat fixture: a **new** spec in the same file, identical in commit/blob *count* and
  differing only in `blobBytes`, so graph metadata is held constant and the only variable
  is blob content — the cleanest possible reading of "peak tracks blob bytes" versus "peak
  tracks commit/tree count". Start at `{ ...SMALL_FIXTURE, label: 'small-fat-blob',
  blobBytes: 65_536 }` (25× content, ≈13 MB, trivial to generate). Add `'small-fat-blob'`
  to the `FixtureSpec['label']` union. R10's floor is ≥4×; if the pre-change peak delta
  between the two fixtures sits inside run-to-run noise, raise `blobBytes` until it does
  not and report both settings.
- Both fixtures are small enough to stay ungated (no `TSGIT_BENCH_LARGE`) and to respect
  `bench.yml`'s 30-minute job timeout. Same nightly-cache caveat as Part 4: editing
  `fixture-generator.ts` invalidates `tsgit-bench-${{ hashFiles(...) }}` once.

Gate interactions: `application` mutation bucket (break 95); `src/application/**` is
outside the coverage gate but inside Stryker. `object-cache.ts:296`'s
`// Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent` proof is about
`verifyHash: false` on the `readObject` **call** — that line is not rewritten by the
projection (only the value stored downstream of it is), so the proof survives; **re-read
and confirm it rather than assuming it** (R5). `check:write-surfaces` is not engaged — fsck
writes nothing. No new public symbol: `CachedGitObject` is exported from an
`internal/fsck/` module that no barrel re-exports, so the projection type is **internal**;
no `reports/api.json` churn, no barrel/facade/doc-page gate.

Oracle (R10): peak `heapUsed` for both fixtures, before and after. Today peak tracks blob
bytes roughly linearly; after, it must track commit/tree count instead. Report all four
absolute peaks.

### TDD steps

1. **GREEN-first for the harness.** Add the `fsck-object-cache` workload and the
   `small-fat-blob` spec; run `npm run bench:memory` on the **unmodified** cache and record
   both "before" peaks.
2. **Tests first — invariance under projection.** Extend `fsck.test.ts` with cases that pin what
   the projection must preserve, each asserting findings **and their order** and the exit
   code: (a) a shallow repository whose grafted parent list changes reachability —
   `applyGraft` before projection; (b) `connectivityOnly: true` with an unreadable object
   (`unreadable: 'classify'`) — `null` versus present, and `recovered`-driven types;
   (c) a tree carrying a GITLINK entry — `mode` must survive the projection or
   `recordOutEdges`/`processTree` change verdicts; (d) a `.gitmodules` blob nested below the
   root tree — `entry.name` must survive for `buildBlobFilenameMap`. Each fails if the
   projection drops the field it names. Run them against the current code first (all green)
   and then against a deliberately field-short projection to confirm they bite — report
   which case caught which omission.
3. **GREEN.** Introduce the projection type, project inside `buildObjectCache` (graft
   first), update `ObjectCacheResult`/`CacheAccumulator` and the four consumers' types.
4. **REFACTOR.** One small pure `project(obj)` function per object type or a single
   `switch` with no default fallthrough — `noFallthroughCasesInSwitch` is on. Keep
   `CachedGitObject`'s name if it still reads true, or rename it to what it now is and let
   Serena's `rename_symbol` carry the call sites.
5. **Full net.** `npm run test:integration` for the fsck suites and `npm run test:parity`
   must be green — findings, order and exit codes are the contract.
6. **Oracle.** Re-run `npm run bench:memory`; report all four peaks; note whether tree-entry
   names are material (input to the declined ADR-646 option 2 — report only, do not act).

### Gate

```bash
npx vitest run test/unit/application/commands/fsck.test.ts \
              test/unit/application/commands/fsck.properties.test.ts \
              test/unit/application/commands/internal/fsck/content-validation.test.ts \
              test/integration/fsck-interop.test.ts \
              test/integration/midx-fsck-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check \
        src/application/commands/internal/fsck/object-cache.ts \
        src/application/commands/internal/fsck/reachability.ts \
        src/application/commands/internal/fsck/content-validation.ts \
        src/application/commands/fsck.ts \
        test/unit/application/commands/fsck.test.ts \
        test/bench/support/fixture-generator.ts \
        tooling/bench-memory.ts \
  && npm run test:parity
```

Shared-file note: `tooling/bench-memory.ts` and `test/bench/support/fixture-generator.ts`
are also touched by Part 4 — see that part's note; each part adds its own self-contained
workload and its own fixture spec.

### Commit

```
perf(fsck): retain a structural projection instead of whole objects
```

---

## Part 6 — Incremental type-check, its CI cache, and the two label gates (W6 + W10)

### Context

This part has **no `src/` delta** and no test artifact. Its verification is the three-step
ladder the design fixes: megalinter's `YAML_YAMLLINT` (syntax only — it enables **no**
GitHub-Actions semantic linter, so a wrong `uses:`, a bad `needs:` edge or a misused
context expression is **not** caught there), a green CI run on the PR itself (the real
pre-merge gate), and post-merge run timings (`gh api
repos/scolladon/tsgit/actions/runs/<id>/jobs`, comparing `typecheck` and `unit-tests`
durations over ≥3 runs against the ≥5 immediately preceding — an observation, never a gate).

**W6 — `tsconfig.typecheck.json` (ADR-647) + undeclared `.tsbuildinfo` (ADR-648).**

Measured on this host (darwin arm64 / M3 Pro / node v22.22.3 / typescript 6.0.3):
`tsc --noEmit -p tsconfig.json` **9.22 s**; `--incremental` cold **8.72 s** (writes a
557.1 kB `.tsbuildinfo`); warm, zero source edits **2.03 s** (**4.3×**). The cold pair is
one measurement each — the claim carried forward is only *"no cold regression"*, to be
confirmed over ≥3 alternating rounds. The number the design does **not** have and R11
requires is **warm-after-one-edit**; measuring it needs a source edit, so it belongs here.

- New file `tsconfig.typecheck.json` at the repo root:
  `{ "extends": "./tsconfig.json", "compilerOptions": { "incremental": true,
  "tsBuildInfoFile": "./.typecheck.tsbuildinfo" } }`. `tsconfig.json` (27 lines) uses
  `include`, which the extension inherits; it has **no** `incremental` and no
  `tsBuildInfoFile` today.
- `package.json` wireit `check:types`: command becomes
  `tsc --noEmit -p tsconfig.typecheck.json`; add `"tsconfig.typecheck.json"` to its `files`
  array (currently `["src/**/*.ts","test/**/*.ts","tooling/**/*.ts","tsconfig.json"]`).
  **Keep `output: []`** (ADR-648): wireit's default `clean: true` deletes declared outputs
  before a run, so declaring the `.tsbuildinfo` without `clean: false` would delete the
  cache on every run and leave `tsc` permanently cold. Undeclared, the file simply persists
  on disk, invisible to wireit, and the two caches compose.
- `.gitignore:28` already carries `*.tsbuildinfo`, which matches `./.typecheck.tsbuildinfo`
   — no edit. cspell's `ignorePaths` already covers `*.tsbuildinfo`. `.ls-lint.yml` rules
  only `src/**` and `test/**`, so a root dotfile is unaffected.
- **Why a dedicated config and not `tsconfig.json`**: three consumers read the project's
  tsconfigs and two must not inherit `incremental` — rollup (`build:js`) and typedoc
  (`docs`, `docs:json`) through `tsconfig.build.json`, which **extends** `tsconfig.json`
  and runs `@rollup/plugin-typescript` in-memory with `outDir: undefined`; and Stryker's
  typescript-checker, which reads `tsconfig.json` **directly** (`stryker.config.mjs:32`)
  and builds one program per mutant under concurrency. Setting the flag in `tsconfig.json`
  plus `incremental: false` in `tsconfig.build.json` fixes the first two and **not** Stryker.
  `npm run build` is therefore part of this part's gate: it is the only check that rollup
  and typedoc still behave (and the only type check the rollup config gets at all — it sits
  outside `tsconfig.json`'s `include`).

**W6 — CI cache (ADR-649).** A PR run pays `tsc` **19** times today: 17 job-instances whose
steps run a wireit task depending on `check:types`, plus `benchmark-compare`'s two tree
builds. In `.github/workflows/ci.yml`, add an `actions/cache@v6` step (floating major — no
SHA pinning) immediately after `./.github/actions/setup` and before the type-consuming step
in: `build` (`:209`), `unit-tests` (`:229`, 9 matrix cells), `mutation` (`:283`),
`integration` (`:328`), `posix-integration` (`:345`, 2 cells), `win-integration` (`:365`)
and `parity-tests` (`:383`) — **16 job-instances**. Give each of those jobs' setup steps
`id: setup` so the key can use the resolved Node version: `.github/actions/setup` already
declares an output `node-version` bound to `steps.setup-node.outputs.node-version`.

**`benchmark-compare` is deliberately excluded** — read the job before assuming otherwise:
it checks out **two** trees (`base/` and `head/`, `:558-572`) and *deliberately does not use
the composite setup* ("that composite installs into the workspace ROOT, and this job is the
one place with two trees and no package.json at the root"), so there is no
`steps.setup.outputs.node-version` to key on and no single `.tsbuildinfo` path. It is also
`continue-on-error: true` and, after W10, runs only on a `bench`-labelled PR. Record the
exclusion in the report rather than inventing a two-path cache for a job that mostly will
not run.

```yaml
      - name: Restore incremental type-check state
        uses: actions/cache@v6
        with:
          path: .typecheck.tsbuildinfo
          key: tsbuildinfo-${{ runner.os }}-${{ steps.setup.outputs.node-version }}-${{ hashFiles('tsconfig*.json', 'package-lock.json') }}-${{ hashFiles('src/**/*.ts', 'test/**/*.ts', 'tooling/**/*.ts') }}
          restore-keys: |
            tsbuildinfo-${{ runner.os }}-${{ steps.setup.outputs.node-version }}-${{ hashFiles('tsconfig*.json', 'package-lock.json') }}-
```

`runner.os` in the key is **mandatory** — a Linux cache file is not valid on Windows — and
it also makes cross-OS reuse impossible by construction, which is why an Ubuntu-only cache
would buy nothing this key does not already provide. Expected and benign in the logs:
several same-OS/same-Node jobs in one run compute the **same** primary key and all try to
save it, so all but the first print `Unable to reserve cache with key …, another job may be
creating this cache`. That is a warning, not a failure — do not "fix" it by making the key
job-specific, which would defeat reuse.

**Clean-run authority (ADR-649): the `typecheck` job (`ci.yml:56-63`) gets no cache step at
all** — it never restores and never saves, so no cache file can ever reach the one job
whose only purpose is the check. Restoring without saving was rejected for exactly that
reason. It already gates `build` and `unit-tests` through `needs:`.

**W10 — label gates (ADR-641 + ADR-651).** One conjunct added to each existing condition,
nothing else:

```yaml
  mutation:                      # ci.yml:283-285
    if: >-
      github.event_name == 'pull_request' &&
      contains(github.event.pull_request.labels.*.name, 'mutation')

  benchmark-compare:             # ci.yml:525-527
    if: >-
      github.event_name == 'pull_request' &&
      needs.changes.outputs.code == 'true' &&
      contains(github.event.pull_request.labels.*.name, 'bench')
```

- **Create the two labels — this is a session-executable step, not a file edit, and it is
  not optional bookkeeping**: `gh label create mutation` and `gh label create bench`. A
  `contains()` against a label nobody can apply is permanently false, which would silently
  retire both jobs rather than gate them. `gh label list` today returns twelve labels (the
  nine GitHub defaults, `dependencies`, and the two the release bot manages) — neither
  `mutation` nor `bench` exists.
- Both jobs are **leaves**: no job declares `needs:` on `mutation` or `benchmark-compare`
  (full `needs:` graph read off the file: `typecheck`/`dead-code`/`duplicates`/
  `architecture` → `changes`; `doc-links`/`doc-coverage`/`doc-typedoc`/
  `test-pyramid-audit` → `lint, typecheck`; `build`/`unit-tests` → `changes, lint,
  typecheck`; `integration`/`posix-integration`/`win-integration`/`parity-tests` →
  `changes, unit-tests`; `parity-deno`/`parity-bun`/`parity-workers` → `changes, build`;
  `e2e` → `changes, integration`; `mutation` → `unit-tests`; `benchmark-snapshot` →
  `unit-tests`; `benchmark-compare` → `changes, unit-tests`). A skip therefore propagates
  to nothing and there is no `if: always()` aggregator to reason about.
- On a `push` event `github.event.pull_request` is absent, the object filter yields nothing
  and `contains` is false — and both jobs already carry the `github.event_name ==
  'pull_request'` conjunct, so push behaviour is unchanged twice over.
  **`benchmark-snapshot` is not touched, in any respect (ADR-642).**
- The `mutation` job's inner skip (`compute-mutation-scope.sh` setting `skip=true` when the
  diff touches no `src/` file, `ci.yml:291-310`) is orthogonal and stays exactly as it is:
  the label decides whether the job runs, the scope script decides whether a running job
  does work.
- Merge policy: the `main` ruleset (id 16502004, `enforcement: active`) names exactly one
  required context — **`build`** — with `strict_required_status_checks_policy: true`, and
  `/branches/main/protection` is 404. Neither gated job is a required check, so gating them
  cannot block or unblock a merge. `gh pr checks` renders a job-level skip as `skipping`
  and still exits 0 (measured on PR #275, where push-only `benchmark-snapshot` prints that
  row today).
- **Re-run behaviour, the operational consequence**: `on.pull_request` declares no
  `types:`, so the default set (`opened`, `synchronize`, `reopened`) applies; a `labeled`
  event is not in it and re-running an existing run replays that run's original payload,
  labels included. **Adding a label to an open PR does not by itself produce a run in which
  the gated job appears** — it takes effect on the next push (`synchronize`) or on
  `reopened`. Adding `labeled` to `types:` is deliberately out of scope: the workflow's
  concurrency group is `ci-${{ github.ref }}` with `cancel-in-progress: true`, so a label
  event mid-run would cancel and restart the whole matrix.

Oracle (R19), executed on this PR in three readings of `gh pr checks`: unlabelled — neither
job appears as running, both read `skipping`; after applying both labels **and pushing** —
both run; then `gh api repos/scolladon/tsgit/actions/runs/<id>/jobs` for the labelled run
for per-job `conclusion` and duration (reference points: `mutation` 22 s–47 m,
`benchmark-compare` 23 m 15 s on run 31945837471). Step 2 is also the empirical
confirmation of the payload-replay reasoning above: if the job appears **without** a push,
that reasoning was wrong and it is corrected in the report rather than left standing.

Oracle (R11), local, ≥3 alternating rounds main-vs-branch on an idle machine: cold (cache
file deleted), warm-unchanged, warm-after-one-edit. Report absolute seconds per round and
the median. A wireit-**cached** green `check:types` is not a measurement — force real runs.

### TDD steps

1. **RED (gate, not a unit test).** `rm -f .typecheck.tsbuildinfo`, then time
   `npm run check:types` twice back to back with no source edit between: both runs cost the
   full ~9 s (wireit caching aside, the compiler starts cold every time). That is the
   condition this part removes.
2. **GREEN — typecheck config.** Add `tsconfig.typecheck.json`; point wireit's
   `check:types` at it and add it to `files`; keep `output: []`.
3. **Verify no blast radius.** `npm run build` must stay green (rollup + typedoc do not
   inherit `incremental`; this is also the only type check `rollup.config.ts` gets), and
   `git status` must show no new tracked file (`.typecheck.tsbuildinfo` is gitignored).
4. **Measure R11.** Cold / warm-unchanged / warm-after-one-edit, ≥3 alternating rounds,
   main vs branch. Report absolute seconds.
5. **GREEN — CI cache.** Add `id: setup` and the cache step to the seven cached job
   definitions (16 job-instances); leave `typecheck` untouched as the cold authority and
   `benchmark-compare` untouched for the reason above.
6. **GREEN — label gates.** Add the two `if:` conjuncts. Create both labels with
   `gh label create mutation` and `gh label create bench` (session step).
7. **REFACTOR.** Keep the cache step byte-identical across jobs (one copy-paste shape, one
   key expression) so a future key change is a single find-and-replace.

### Gate

```bash
npm run check:types \
  && ./node_modules/.bin/biome check package.json tsconfig.typecheck.json \
  && npm run build
```

No touched test exists, and `.github/workflows/ci.yml` is outside both biome's allow-list
and `npm run validate` — naming it as a biome argument would exit 1 on "No files were
processed". What this gate actually exercises: that `check:types` still runs (now through
the new config), that the two root JSON files are formatted, and that the rollup/typedoc
path is unaffected. The workflow edit's verification is the three-step ladder above.

### Commit

```
ci: cache the incremental type-check state and label-gate the two heavy PR jobs
```

---

## Part 7 — Publish one entry per command, with a resolution guard (W9a)

### Context

Implements ADR-640 (build ~49 per-command entries, in this change), ADR-643 (the missing
`./commands` barrel key) and ADR-644 (`verify-tarball.sh` resolves every `exports`
subpath). The defect being repaired, pinned on the published 3.3.0 via a resolution probe
(throwaway directory, package symlinked into `node_modules/`, Node v22.22.3):
`@scolladon/tsgit` **OK**, `@scolladon/tsgit/commands/index` **OK**,
`@scolladon/tsgit/commands/add` **`ERR_MODULE_NOT_FOUND`**, `@scolladon/tsgit/commands`
**`ERR_PACKAGE_PATH_NOT_EXPORTED`**.

**Everything in this part lands in one commit.** The entries push the pack to ≈825 KiB
against `SIZE_CAP = 750 KiB`, so a commit boundary anywhere inside this set leaves
`check:tarball` red; and the design's own rule is that the guard and the explicit keys land
together (landing the guard while keys exist but entries do not is exactly what it would
fire on).

**No `src/` delta and no new symbol**: every entry is an existing module already re-exported
through the built barrel. Consequently no coverage/mutation movement, no `check:filesystem`
(ls-lint) delta, no new import edge for `check:architecture`, and no `reports/api.json`
churn (R14 — typedoc reads the **source** entry points in `typedoc.json`, not `package.json`
`exports` and not `dist/`). Part 8 is where api.json engages.

**1 — `rollup.config.ts` `entryPoints` (`:8-20`).** Add 49 explicit entries beside the
existing 11, in the same literal style (`'commands/<name>': 'src/application/commands/<name>.ts'`).
Enumerate exactly these 49 (`src/application/commands/*.ts` is 50 modules — 49 commands plus
`index.ts`; `src/application/commands/internal/` is **not** an entry directory and stays
behind the chunk boundary):

```text
abort-merge  add  archive  blame  branch  bundle-create  bundle-list-heads  bundle-verify
cat-file  checkout  cherry-pick  clone  commit  config  continue-merge  describe  diff
fetch  fetch-missing  fsck  grep  init  log  merge  mv  name-rev  notes  pack-objects
pull  push  range-diff  read-file-at  rebase  reflog  remote  reset  rev-list  rev-parse
revert  rm  shortlog  show  sparse-checkout  stash  status  submodule  tag  whatchanged
worktree
```

`entryPoints` feeds **two** of the three exported configs: config #1 (`dist/esm` +
`dist/cjs`) and config #3 (`dist/types`, `.d.ts` + `.d.cts` via `rollup-plugin-dts`).
Config #2 — the no-build browser bundle (`:96-107`) — takes `src/index.browser.ts` alone
with `inlineDynamicImports: true` and never reads `entryPoints`, **so the split cannot touch
it**: `dist/browser/tsgit.js` is byte-identical across base and split builds (sha256
`a1aac9bb5b39096c502a6660351b6a3c55168f95c8cf0f7fb6bdb87a3114fa64`, 156.04 kB gzip both
sides). Per-command entries relieve bundler-using consumers; they do not shrink the CDN
bundle by one byte, and the 97.5 %-of-budget problem stays open. `rollup.config.ts` is
outside `tsconfig.json`'s `include`, so `npm run build` is its only type check.

Measured effects of the split (these numbers are the plan's constants — do not re-derive
them, only confirm the gates they feed):

| Metric | base — 11 entries | split — 60 entries |
|---|---|---|
| `dist/esm` files (of which chunks) | 27 (16) | 203 (143) |
| chunks reachable from ≥2 entries | 16 (all) | 143 (all) — no chunk is private to one entry |
| `dist/esm/**/*.js` raw | 564.04 kB | 717.53 kB (+27 %) |
| `dist/esm/**/*.js` gzip (= `size-limit` *Full library*) | **186.61 kB** | **284.35 kB** |
| `dist/types` `.d.ts` / `.d.cts` | 18 / 18 | 85 / 85 |
| rollup wall clock, all three configs | 17.45 s | 17.87 s |

**2 — `package.json` `exports` (ADR-643 + explicit keys).** Add 49 `"./commands/<name>"`
keys with exactly the shape the existing subpath entries use, plus `"./commands"`, and
**retain `"./commands/*"`** as the catch-all so `./commands/index` — the one specifier that
resolves on 3.3.0 — keeps working and nothing is retracted:

```json
"./commands/add": {
  "import": { "types": "./dist/types/commands/add.d.ts", "default": "./dist/esm/commands/add.js" },
  "require": { "types": "./dist/types/commands/add.d.cts", "default": "./dist/cjs/commands/add.cjs" }
},
"./commands": {
  "import": { "types": "./dist/types/commands/index.d.ts", "default": "./dist/esm/commands/index.js" },
  "require": { "types": "./dist/types/commands/index.d.cts", "default": "./dist/cjs/commands/index.cjs" }
}
```

Explicit keys and the retained wildcard do not fight — Node resolves the most specific
match first; pinned in a throwaway package on Node v22.22.3 (`"./x/*"` + `"./x/a"` →
`./x/a` hits the explicit target, `./x/b` goes through the pattern). **Explicit keys are
required, not stylistic**: attw enumerates `exports` **keys literally** and prints
`(wildcard)` for a pattern, validating nothing behind it — which is precisely how the
broken wildcard shipped past a green `check:exports`. With the 61-key map and the split
`dist/`, attw reports **61 entries, all green** for `node16 (from CJS)`,
`node16 (from ESM)` and `bundler`, exit 0, 7.63 s (against 2.54 s for the 11-key map).
That is R17's oracle: **a `(wildcard)` line for any command subpath means the explicit keys
did not land.**

`tooling/dts-entries.ts` `getPublishedEntries` needs **no modification** (R18): it walks the
map, expands wildcards against files present under `dist/`, and de-duplicates on the
`(dtsPath, runtimePath)` pair — 20 published entry pairs on the base build, **118** on the
split (18 non-command pairs plus 50 command modules × 2 formats). `tooling/truthful-dts.ts`
completes over all 118 in 0.79 s and exits 0, so `build:js`'s last step absorbs the split
unchanged.

**3 — `.size-limit.json`.** The repo installs **`@size-limit/file`** and no bundler preset:
each row measures **the named file's own bytes**, gzipped, and does not follow imports.
(Pinned: with the split built, `Core (main entry)` reads 7.51 kB for `dist/esm/index.js`,
whose transitive chunk closure is 244 kB.) Add 49 command rows in the existing shape —
`{ "name": "Command (<name>)", "path": "dist/esm/commands/<name>.js", "limit": "<tier>",
"gzip": true }` — using four budget tiers sized from measured entry bytes with ~25 %
headroom, so the config gains four constants rather than 49 bespoke ones:

| Budget | Commands (measured entry gzip, kB) |
|---|---|
| **1.5 kB** (21) | show 1.16, whatchanged 1.15, fetch-missing 1.07, worktree 1.07, shortlog 0.99, abort-merge 0.99, pack-objects 0.99, rev-list 0.97, diff 0.97, archive 0.88, log 0.88, continue-merge 0.85, config 0.82, bundle-verify 0.79, status 0.68, read-file-at 0.56, name-rev 0.47, cat-file 0.45, rev-parse 0.42, init 0.29, bundle-list-heads 0.27 |
| **3 kB** (16) | fetch 2.35, add 2.34, grep 2.14, bundle-create 2.14, checkout 2.07, sparse-checkout 2.05, remote 1.82, pull 1.80, clone 1.73, notes 1.71, mv 1.65, tag 1.39, rm 1.33, reset 1.31, reflog 1.24, branch 1.22 |
| **6 kB** (9) | range-diff 4.06, push 4.05, merge 3.93, cherry-pick 3.60, revert 3.51, stash 3.37, describe 2.84, blame 2.51, commit 2.40 |
| **10 kB** (3) | fsck 7.79, rebase 7.62, submodule 4.88 |

Plus the barrel — `{ "name": "Commands (barrel)", "path": "dist/esm/commands/index.js",
"limit": "6 kB" }`, measured 3.76 kB — which has no row today at all. A single glob row over
`dist/esm/commands/*.js` was rejected: it sums, so one command doubling in size would hide
behind 48 unchanged ones. The `Full library` row stays at **335 kB** and stays green at
284.35 kB (84.9 %), but its reserve falls from 148 kB to **50.6 kB** — the number the next
bundle-touching change inherits. Do not change the `Browser bundle (no-build)` row.

**4 — `tooling/verify-tarball.sh`: `SIZE_CAP` + the resolution guard.**

- `SIZE_CAP` (`:23`, currently `$((750 * 1024))`) → `$((940 * 1024))`. Measured: published
  3.3.0 pack 94 files / 736 732 B (95.9 % of the old cap); probe base build 94 files /
  753 783 B (98.1 %); **probe split build 580 files / 864 106 B (112.5 % — FAIL)**. The
  probe packs 2.3 % heavier than the registry tarball (npm/gzip version skew, tar
  metadata), so the honest projection for the real split pack is
  864 106 × (736 732 / 753 783) ≈ **844 500 B ≈ 825 KiB**. Applying the script's own
  convention (cap ≈14 % above the honest floor — which is what produced 750 from 656) gives
  **940 KiB**. **Rewrite the comment block at `:15-22`** with the new floor, its
  composition (dual runtime + dual declarations, now across 60 entries and 143 chunks) and
  these measurements, so the next reader sees why it moved. This is the one W9 side effect
  that loosens an existing repo-wide guard rather than tightening one — the considered
  review the guard exists to force. Re-measure the real pack in-part and quote the actual
  bytes, not the projection.
- Add the resolution guard: enumerate the `exports` map **from inside the packed tarball**
  (not the worktree's `dist/`, or it re-verifies files `files: ["dist","LICENSE",
  "README.md"]` might not ship), expand wildcard patterns against the packed `dist/`,
  resolve **every** concrete specifier **through Node's own resolver** (the defect is a
  *resolution* failure, so path arithmetic proves nothing), and fail on the first miss. The
  shape to reuse is the D1 evidence probe: extract the tarball into a `mktemp -d`, symlink
  or copy `package/` to `<tmp>/node_modules/@scolladon/tsgit`, and run
  `node --input-type=module -e 'import.meta.resolve(...)'` (or a plain dynamic `import()`)
  per specifier from that directory. The script already has the pattern: it packs into a
  private `mktemp -d` directory via `npm pack --pack-destination` (`:44-45`) — never the
  repo root, because `attw --pack` under `check:exports` packs into the root concurrently —
  and registers `cleanup()` via `trap` before any temp path exists (`:28-37`). Add the new
  temp dir to that same cleanup.
- **The guard must run in `--quick` mode too.** `check:tarball` (the `validate` dependency)
  is `bash tooling/verify-tarball.sh --quick`; only the trailing `attw --pack` block is
  `QUICK`-gated (`:191-196`). Putting the resolution guard behind `QUICK` would keep it out
  of `validate`, which is the whole point of hosting it here (ADR-644 chose this file
  precisely because it already runs under `validate`).
- Its own negative proof is cheap and **must be taken once during implementation**: delete
  one built entry file, confirm the guard goes red, restore it. A guard nobody has seen fail
  is a guard nobody has tested. `tooling/verify-tarball.sh` is outside biome's allow-list —
  do not pass it to `biome check`.

Gate interactions, gathered: `check:size` 186.61 → 284.35 kB against 335 kB (green,
reserve 50.6 kB), 50 new rows, browser bundle unchanged; `check:tarball` / `verify:tarball`
red until `SIZE_CAP` moves (hence one commit), gains the guard; `check:exports` 11 → 61
entries, all green, 2.54 → 7.63 s; `check:doc-typedoc` unchanged (R14); `build:js` +0.42 s;
`check:filesystem` and `check:architecture` unmoved. Known residual, recorded so review does
not read it as an oversight: because the wildcard is retained, a **future** command added
without its own explicit key still resolves through the pattern and is therefore invisible
to both attw and this guard — the defect class shrinks, it does not vanish. Closing it would
need a "every `src/application/commands/*.ts` has an explicit key" check, which is beyond
ADR-644's scope.

### TDD steps

1. **RED (gate, not a unit test), three readings on the current tree.** (a)
   `npm run build && npm run check:exports` prints `(wildcard)` for `"./commands/*"` —
   proof the surface is unverified; (b) an out-of-tree resolution probe on the packed
   tarball reproduces `ERR_MODULE_NOT_FOUND` for `@scolladon/tsgit/commands/add` and
   `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@scolladon/tsgit/commands`; (c) with the entries
   added but the cap unmoved, `npm run check:tarball` FAILS at ≈825 KiB — which is why the
   cap moves in this same commit.
2. **GREEN, in this order inside the one commit** (the order is forced: an `exports` key
   that names a missing entry resolves to nothing, and a `check:size` row for a missing file
   errors): rollup entries → `exports` keys (49 + `./commands`, wildcard retained) →
   `.size-limit.json` rows → `SIZE_CAP` + comment rewrite → the resolution guard.
3. **Verify each oracle on the real build, never assumed.** `npm run build`;
   `npm run check:size` (observe the `Full library` row's absolute value and the 50 new
   rows); `npm run check:exports` (61 entries, zero `(wildcard)` lines for command
   subpaths); `npm run check:tarball` and `npm run verify:tarball` (record the actual packed
   byte count against the new cap); re-run the out-of-tree resolution probe on the new pack
   — all three previously-failing specifiers now resolve.
4. **Negative proof of the guard.** Delete one built entry file, confirm
   `npm run check:tarball` goes red naming that specifier, restore it, confirm green.
5. **REFACTOR.** Keep the 49 `exports` blocks byte-uniform (one shape, one substitution) so
   a future key change is mechanical; keep the four size tiers as the only budget constants.
6. **Report** the rollup declaration-warning count before and after (`6` → `30`) — Part 8's
   input. Warnings only: rollup exits 0, `truthful-dts` exits 0, attw is green, **no gate is
   red**; the consequence is a worse published type surface, not a broken build.

### Gate

```bash
npm run check:types \
  && ./node_modules/.bin/biome check package.json .size-limit.json rollup.config.ts \
  && npm run build \
  && npm run check:size \
  && npm run check:exports \
  && npm run check:tarball \
  && npm run verify:tarball
```

No touched test exists; `tooling/verify-tarball.sh` is outside biome's allow-list. What this
gate actually exercises: the three packaging gates that this part moves, on the real built
artifacts.

Shared-file note: `package.json` is also touched by Part 6 (the `check:types` wireit block)
— disjoint keys, no overlap in intent; the parts stay separate because one is CI/typecheck
cost and the other is the published surface.

### Commit

```
feat(package): publish one export entry per command and guard every subpath
```

---

## Part 8 — Re-export the leaked declaration types + regenerate the API report (W9b)

### Context

The split's one genuine breakage. `rollup-plugin-dts` warns when an entry's declarations
reference a type living in a shared declaration chunk with no public re-export — the TS2742
hazard for downstream consumers. The base build emits **6** such warnings (the three adapter
entries × 2 formats, pre-existing). The split emits **30**: the same 6 plus **18** new ones
across 9 entries × 2 formats:

| Entry | Leaked type names |
|---|---|
| `commands/merge` | `ConflictType`, `IndexEntry`, `MergeConflict`, `MergeOutcome`, `SparseMatcher` |
| `commands/config` | `ConfigKey`, `ConfigScope` |
| `commands/cherry-pick`, `commands/rebase`, `commands/revert`, `commands/stash` | `ConflictType` |
| `commands/reflog` | `ReflogEntry` |
| `commands/add` | `AttributeProvider` |
| `primitives/index` | `ConfigKey`, `ConfigScope`, `IndexEntry`, `ReflogEntry`, `SparseMatcher`, `TreeEntry` |

Two facts to hold together: `primitives/index` is **not** a new entry — its declarations are
clean today, and the split changes how `rollup-plugin-dts` partitions shared declaration
chunks, so a type that was public-by-accident stops being so. And these are **warnings**:
rollup exits 0, `truthful-dts` exits 0, attw is green — **no gate is red**. The consequence
is a worse published type surface, which this part repairs; the goal is the warning count
back to the pre-existing **6**.

**Public-surface decision, made here and not deferred: these 10 type names become public
re-exports.** They are already structurally reachable — a consumer of
`dist/types/commands/add.d.ts` cannot call the exported `addAll` without naming
`AttributeProvider` — so the re-export publishes nothing that was not already in the
published signature; it only gives it a name the consumer can import. `AttributeProvider`
is the one that deserves the sentence: it is declared in
`src/application/primitives/internal/read-gitattributes.ts:81` and reaches the surface only
through `addAll`'s optional third parameter (`src/application/commands/add.ts:234-237`,
"Exposed for testability"). Publishing the type is the honest reading of a signature that is
already published.

Declaration sites, verified — use these exact origins:

```text
ConflictType, MergeConflict, MergeOutcome   src/domain/merge/merge-types.ts:3, :13, :38
SparseMatcher                               src/domain/sparse/sparse-pattern.ts:32
ConfigKey, ConfigScope                      src/domain/commands/config-key.ts:8, :14
ReflogEntry                                 src/domain/reflog/reflog-entry.ts:5
AttributeProvider                           src/application/primitives/internal/read-gitattributes.ts:81
IndexEntry     TWO declarations — src/application/primitives/snapshot/index-entry.ts:14
                                  and src/domain/git-index/index-entry.ts:20
TreeEntry      TWO declarations — src/application/primitives/snapshot/tree-entry.ts:15
                                  and src/domain/objects/tree.ts:19
```

`IndexEntry` and `TreeEntry` are **ambiguous names**. Do not guess which one an entry leaks:
`npm run build 2>&1 | grep -n 'still references private shared type exports'` prints the
entry and the type per warning; resolve each to its origin by reading the leaking entry's
own imports (e.g. `src/application/commands/merge.ts:22-30` imports `TreeEntry` from
`../../domain/objects/index.js`). The rollup warning list is the authoritative worklist for
this part — drive the edit from it, re-run it after every edit, and stop when the count is
back to 6.

**Mechanism** — the repo's barrels use **explicit named re-exports**, not `export *`
(`src/application/commands/index.ts` enumerates `export { type AddOptions, type AddResult,
add } from './add.js';` per command), so a type re-export added to a leaf module does **not**
propagate anywhere by itself:

1. Add `export type { … } from '<origin>';` to each leaking entry module
   (`src/application/commands/{merge,config,cherry-pick,rebase,revert,stash,reflog,add}.ts`)
   and to `src/application/primitives/index.ts` for its six.
2. **knip (`check:dead-code`) is the constraint that decides whether step 3 is needed.**
   `knip.json` lists `src/application/commands/index.ts` and
   `src/application/primitives/index.ts` as entries (entry exports are exempt) with
   `ignoreExportsUsedInFile: true`; a command module is **not** an entry, so a re-exported
   type that nothing imports is reportable as an unused export. If knip flags any of them,
   add the same names to `src/application/commands/index.ts`'s explicit re-export list —
   which both satisfies knip and is the more honest surface (the barrel is what
   `src/public-types.ts` reads).
3. `src/public-types.ts` (119 lines) carries
   `export type * from './application/commands/index.js'` and the same for
   `primitives/index.js`, **plus explicit `export type { IndexEntry } from
   './application/primitives/snapshot/index-entry.js'` and `TreeEntry` from
   `snapshot/tree-entry.js`, which deliberately win over the wildcards for exactly these two
   duplicate names** (the file says so, and the semantics were probed clean). If a barrel
   addition introduces a *different* `IndexEntry`/`TreeEntry`, the explicit export still
   wins in `public-types.ts` — but the **barrel itself** would then carry two same-named
   type exports, which is a TS2308 error. `npm run check:types` catches it. If it fires,
   that is a genuine blocker: escalate `{ unit, reason, ≤3 options }` (options: re-export
   under the barrel only from the module that already owns the name; leave that one entry's
   warning standing and record it; rename nothing).
4. **`reports/api.json` (R14 + the prepush gate).** typedoc's `entryPoints`
   (`typedoc.json`) include `src/application/commands/index.ts` and
   `src/application/primitives/index.ts` — so a re-export reaching either **changes the
   report**, while leaf-only re-exports do not. Regenerate with `npm run docs:json` and
   commit `reports/api.json` **in this part**; the huge typedoc-id diff is normal. Verify
   with `npm run check:doc-typedoc` (`git diff --exit-code -- reports/api.json` after
   `docs:json`), which is a **prepush** gate, not a `validate` gate — a green local
   `validate` proves nothing here.
5. Surface gates that do **not** engage, checked so nobody chases them: no new Tier-1
   command, so no `docs/use/commands/*.md` page, no `docs/use/commands/README.md` row, no
   README "N Tier-1 commands" count, no `Repository` facade binding, and no change to
   `test/unit/repository/repository.test.ts`'s sorted `Object.keys(sut)` assertion — these
   are **type-only** exports with zero runtime value added. `audit-browser-surface`
   (`check:browser-surface`) inspects runtime command invocations in
   `test/parity/scenarios/*.scenario.ts` and is likewise unmoved. No new error code, so no
   exhaustiveness switch.

### TDD steps

1. **RED (gate, not a unit test).** `npm run build 2>&1 | grep -c 'still references private
   shared type exports'` returns **30** on the split build — 6 pre-existing (three adapter
   entries × 2 formats) plus 18 new (9 entries × 2 formats). Count what the build actually
   prints and record it; that count is the failing oracle and the target is **6**.
2. **GREEN, entry by entry.** For each warning, add the `export type { … } from '<origin>'`
   line to the named entry module. Re-run the build after each group and watch the count
   fall. Stop at 6 — the pre-existing adapter warnings are out of scope and must not be
   "fixed" opportunistically.
3. **knip branch.** `npm run check:dead-code`. If a leaf re-export is flagged unused, add
   the name to `src/application/commands/index.ts` and re-run.
4. **api.json.** `npm run docs:json`, commit `reports/api.json`, confirm
   `npm run check:doc-typedoc` is green.
5. **REFACTOR.** Group each module's re-export into a single `export type { … } from` per
   origin, placed with the module's other exports; no barrel churn beyond what step 3
   requires.
6. **Report** the final warning count, the exact names published, and whether the barrel
   was touched (i.e. whether the public type surface grew).

### Gate

```bash
npx vitest run test/unit/repository/repository.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/merge.ts \
        src/application/commands/config.ts src/application/commands/cherry-pick.ts \
        src/application/commands/rebase.ts src/application/commands/revert.ts \
        src/application/commands/stash.ts src/application/commands/reflog.ts \
        src/application/commands/add.ts src/application/primitives/index.ts \
  && npm run build \
  && npm run check:dead-code \
  && npm run check:doc-typedoc
```

Add `src/application/commands/index.ts` and `src/public-types.ts` to the biome argument list
if step 3 touched them. `check:doc-typedoc` is included deliberately: it is a prepush gate
that `validate` does not run, and this is the part that makes it stale.

### Commit

```
fix(types): re-export the types the per-command declarations reference
```

---

## Part 9 — vitest pool / prepush worker-cap pilot (W8)

### Context

**This part goes last** because it perturbs the harness every other part's gate runs
through, and `npm run validate` must be green on the final state regardless of which
variables survive. **Both outcomes are successes: "measured, no win, reverted" closes the
item (R12).**

Anchors, verified: `vitest.config.ts` declares **no** `pool` key and no `isolate` key, so
vitest defaults apply (`pool: 'forks'`, `isolate: true`); `maxWorkers: '100%'` is set at
`:29`; `testTimeout: 120_000` at `:10`; the `env` block at `:21-26` sets `TZ`, `HOME`,
`USERPROFILE`, `XDG_CONFIG_HOME` (the isolated-`HOME` guard that has already broken a byte
comparison once). Five projects are declared (`unit`, `integration`, `posix-integration`,
`win-integration`, `parity`); four `validate` dependencies are vitest tasks
(`test:coverage`, `test:integration`, `test:parity`, `test:perf` — the last through its own
`vitest.perf.config.ts`, deliberately **not** a project of `vitest.config.ts` so Stryker
never runs timing assertions as mutant kills; leave that file alone).

The oversubscription, read out of wireit's own source:
`node_modules/wireit/lib/cli-options.js:77 → const defaultValue = os.cpus().length * 2;`
On an 11-core host `WIREIT_PARALLEL` defaults to **22**, and `validate` declares **22**
dependencies — so wireit starts all of them at once, including four vitest tasks each
spawning up to 11 workers. Worst case ≈**44 vitest workers on 11 cores**, alongside rollup,
typedoc, biome, cspell, size-limit and attw.

Isolation audit, already done — this is the prerequisite for `pool: 'threads'` /
`isolate: false`:

| Hazard | Finding |
|---|---|
| In-process working-directory mutation (the Node call that changes `process.cwd()`) | **zero** occurrences in `src/`, `test/`, `tooling/` — the classic threads-pool blocker is absent |
| `process.env` writes in unit tests | 2 files: `test/unit/adapters/node/node-env-reader.test.ts`, `test/unit/adapters/node/node-file-system.test.ts` |
| `vi.stubEnv` / `vi.stubGlobal` / `vi.setSystemTime` | 5 unit-test files |
| Config-level env injection | `vitest.config.ts:21-26` |
| Module-scope mutable bindings in tests | 5 files with a top-level `let` |
| Suite size | 558 unit test files, 125 integration |

The env findings are the crux and **must be settled empirically, not from memory**: whether
a worker thread gets its own copy of `process.env` or shares the parent's is a
Node/Tinypool behaviour, and both `vitest.config.ts`'s `env` block and `vi.stubEnv` write
through it. **The pilot's first step is a probe, not a config edit**: run the two
env-writing unit files plus the five stub-using files under `pool: 'threads'` in a scratch
invocation (`npx vitest run --pool=threads <files>`) and read the verdict before touching
the committed config.

Three independent variables, measured **one at a time** so a regression is attributable:

1. `pool: 'threads'` with `isolate: true` — `vitest.config.ts`.
2. `isolate: false` on the current `forks` pool — `vitest.config.ts`.
3. A per-task worker cap for `prepush` — either `maxWorkers` lowered in
   `vitest.config.ts` or `WIREIT_PARALLEL` capped where prepush is invoked. The invocation
   point is `.husky/pre-push` (2 lines: `npm outdated || true`, `npm run prepush`); the
   wireit `prepush` entry itself carries only `dependencies: ["validate",
   "check:doc-typedoc"]` and no command, so an env prefix belongs on the hook line
   (`WIREIT_PARALLEL=<n> npm run prepush`).

**Oracle and revert rule (R12), per variable:** measure `npm run test:unit` — and, for
variable 3, `npm run prepush` — over **≥3 alternating rounds** main-vs-branch on the same
idle machine, reporting absolute wall clock per round **and** the median. Self-share deltas
and single-round numbers do not count. If the median is not improved by a margin larger
than the observed round-to-round spread, **revert that variable in this same PR**. A
variable that changes any test's pass/fail verdict, or makes any test flaky across the three
rounds, is reverted immediately regardless of speed. Revert path: `git checkout --
vitest.config.ts` (and `.husky/pre-push`) — own files only, never repo-wide git state.

Measurement hygiene: a wireit-**cached** green task is not a timing sample. Force genuinely
cold runs (touch a source file or clear the relevant `.wireit` entry) and say in the report
how coldness was ensured. Published perf numbers come from CI, never from this machine —
every number here is labelled local, dev-machine, with `node --version` and the host banner
beside it.

Always-committed artifact: `docs/perf/test-harness-pilot.md` — the three variables, the
probe verdict on thread-vs-fork `process.env` semantics, per-round absolute wall clock,
medians, spreads, and the keep/revert decision for each. This is what makes an
all-reverted outcome a real commit, and it is the record that stops the next reader
re-running the pilot.

### TDD steps

1. **Probe first, edit nothing.** `npx vitest run --pool=threads` over
   `test/unit/adapters/node/node-env-reader.test.ts`,
   `test/unit/adapters/node/node-file-system.test.ts` and the five stub-using files. Record
   whether each worker sees its own `process.env`. If the probe fails, variable 1 is dead on
   arrival — record that and move to variable 2 without editing the config.
2. **Baseline rounds.** ≥3 alternating rounds of `npm run test:unit` on the unmodified
   config (this is the "main" side; the branch has no harness change yet).
3. **Variable 1.** Set `pool: 'threads'`; run the **full** `npm run test:unit` (all 558
   files — a pass/fail verdict change is an immediate revert) plus ≥3 timed rounds. Decide,
   keep or `git checkout -- vitest.config.ts`.
4. **Variable 2.** Same protocol for `isolate: false` on `forks`.
5. **Variable 3.** Same protocol for the worker cap, measured on `npm run prepush`.
6. **Write the record**, then **`npm run validate` on the final state** — whatever survived.
7. **REFACTOR.** If a variable is kept, comment *why* in `vitest.config.ts` in the file's
   existing voice (the config comments explain rationale, never mechanics) — and never with
   a phase/ADR reference.

### Gate

```bash
npm run test:unit \
  && npm run check:types \
  && ./node_modules/.bin/biome check vitest.config.ts \
  && npm run check:spelling \
  && npm run validate
```

The whole unit suite is the gate here, not a file subset: this part changes how every test
runs. `.husky/pre-push` and `docs/perf/test-harness-pilot.md` are outside biome's allow-list
and are not passed to it. If every variable reverted, `vitest.config.ts` is unchanged and
the biome argument is dropped.

### Commit

If a variable survives:

```
perf(test): run the unit suite on the threads pool
```

If everything reverted:

```
docs(perf): record the test-harness pilot measurements
```
