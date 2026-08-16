# Plan — depth caps and Node release-line aliases

> Source: design doc `docs/design/depth-caps-and-node-aliases.md` · ADRs `636, 637, 638, 639`
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

## Ordering and the one conditional branch

Ten parts, strictly sequential in one working tree.

```
1  cap resolution surface        (prerequisite for 3, 5, 6, 7)
2  repo-wide eager refusal + DC-15 five commands + bundle pinning
3  the six already-bounded sites take the resolved cap
4  §A12 frame-ceiling MEASUREMENT (docs-only)   ── gates part 8's shape
5  structural stacks: synthesizeLevel + writeNestedTree
6  structural stack: walkTree + archive's restored cap + deep-tree interop
7  structural stack: walkWorkingTree
8  discharge the §A12 verdicts  ── scope decided by part 4's outcome
9  Scope B — Node release-line aliases (.github/ + bench tooling; no src/ delta)
10 docs sweep (docs-only)
```

**Part 4 gates part 8, not parts 5–7.** ADR-636 mandates the four structural rewrites
(`synthesizeLevel`, `writeNestedTree`, `walkTree.walkInternal`,
`walkWorkingTree.walkInternal`/`visitEntry`) unconditionally — they are parts 5–7 and no
measurement can retire them. What DC-14 / §A12 leaves conditional is whether the **six
sites ADR-636 leaves recursive** (`flattenLevel`, `diffChangedSubtree`, `walkLevel`,
`collectTreeObjects`/`emitTreeObjects`, `markTree`) additionally join the rewrite. Part 3
wires those six to the resolved cap (a *value* change, not a rewrite — so §A12's "before
any rewrite part" holds); part 4 then measures them; part 8 discharges the verdict. Part 4
must run **after** part 3 because three of the six (`diffChangedSubtree`,
`collectTreeObjects`/`emitTreeObjects`, `markTree`) read their cap from a module constant
today and only become drivable at a large *configured* cap once part 3 lands.

**Part 4's outcome changes part 8's scope, and both branches are pre-specified** (§A12's
table), so no re-plan is needed either way:

| Part 4 verdict per site | Part 8's work for that site |
|---|---|
| **Holds** — measured ceiling ≥ **4096** (2× the 2048 default) | The site keeps its recursion. Its module doc gains the asymmetry as a written invariant: *this descent honours `core.maxTreeDepth` up to N and refuses beyond it by exhausting frames, not by policy* — carrying the measured number and the measurement date. |
| **Does not hold** — measured ceiling < 4096 | The site joins the structural rewrite: explicit stack (template = parts 5/6), plus its `iterative ≡ recursive` property test, plus **re-derivation** of any carried equivalent-mutant proof (`enumerate-bundle-objects.ts` and `closure-not-marks.ts` each carry several `// Stryker disable next-line` and `// equivalent-mutant:` comments whose proofs are structure-specific and do NOT survive a rewrite). |

If part 4 reports **four or more** sites below threshold, part 8 is a materially larger
part than planned. The implementer does **not** silently absorb it: part 4's final message
escalates `{ unit: part 8, reason: <N> of 6 sites below the 4096 threshold, options: [(a)
run part 8 as one part with all N rewrites — the transformation is identical per site and
parts 5/6 supply the template; (b) split part 8 into 8a (the sites that held → doc
invariants) and 8b…8n (one rewrite each), inserted before part 9; (c) rewrite only the
sites below threshold that sit off the hot raw-tree cursor path and record the remaining
ones as a bounded, dated exception in ADR-636] }` and the session decides. Default if the
session does not respond: **(a)**.

## Cognitive-locality notes — the file overlaps `plan-lint` flags, and why each stands

`plan-lint.sh` warns when one file is declared by more than one part. Six overlaps are
deliberate; each is recorded here rather than merged away.

- **`docs/design/depth-caps-and-node-aliases.md` — parts 4 and 8.** Part 4 **writes** the
  measured ceilings and verdicts into §A2.1/§A12; part 8 only **reads** them as its
  specification. Merging them would mean measuring and acting on the measurement in one
  commit, which is precisely what ADR-636's "measure before rewriting" resolution forbids —
  the measurement has to be a reviewable artefact before its consequence is chosen.
- **`src/application/primitives/{internal/flatten-raw.ts, internal/walk-raw-subtree.ts,
  internal/closure-not-marks.ts, diff-trees.ts, enumerate-bundle-objects.ts}` — parts 3, 4
  and 8.** Part 3 changes the **cap source** on all five (a value change, unconditional).
  Part 4 does not edit them at all — it only names them as the probe's subjects, so that
  overlap is a reference, not a write. Part 8 acts on part 4's verdict, and its scope is
  **unknown until part 4 runs**: it may be five doc-comment additions or up to five explicit
  stacks. A part whose scope is decided by an earlier part's output cannot be merged into a
  part that precedes that output.
- **`reports/api.json` — parts 1, 3, 5, 6, 7.** Shared infrastructure, and the repetition is
  intentional: it is a generated report gated at **prepush**, not at `validate`, so each
  part that changes a public TSDoc or type must regenerate and commit it **in its own
  commit**, or the push hook rejects that commit. Deferring all five regenerations to one part would
  leave four commits individually red at the push gate.
- **`test/unit/application/primitives/fixtures.ts` — parts 1, 5 and 7.** Each part adds the
  one helper its own tests need and no more (`seedMaxTreeDepth`, then `buildTreeChain` /
  `deepIndexPath`, then `seedDeepWorkingTree`). Front-loading all four into part 1 would
  land three unused exports whose shape is guessed rather than driven by a consumer.

## Cross-cutting facts every part needs

**Repository shape.** Hexagonal: `domain/` (pure) ← `application/primitives/` ←
`application/commands/` ← `repository.ts`. Ports between application and adapters.
`src/domain/**` and `src/adapters/**` are gated at **100%** line/branch/function/statement
coverage; `src/application/**` is not (but Stryker mutates all of `src`).

**Serena is already activated on this worktree** — do not call `activate_project`. Use
`find_symbol` / `find_referencing_symbols` / `replace_symbol_body` / `insert_after_symbol`
as the default for TypeScript read/navigate/edit (test files too); `Read`/`Grep` only for
markdown, JSON and YAML. `replace_symbol_body` on an `export const` arrow can double the
`export const` prefix (TS1389) — omit the prefix in the new body.

**Test conventions.** `describe('Given …')` > `describe('When …')` > `it('Then …')`; AAA
body with `// Arrange` / `// Act` / `// Assert` section comments; `sut` is the **function
under test**, never the result (result goes in `result`). Error assertions use try/catch +
direct `.data` reads — never `toThrow(ErrorClass)` alone, never
`toThrow(expect.objectContaining(...))`. Guard clauses need **isolated** tests: for
`if (A || B) throw`, one test tripping both proves neither.

**No provenance refs in source or test** — no `§A8`, no `ADR-637`, no `DC-13`, no backlog
ids inside `src/` or `test/`. Those live in the commit message and this plan only.

**No suppression directives** — no `@ts-ignore`, `biome-ignore`, `v8 ignore`,
`istanbul ignore`. `// Stryker disable next-line <Mutator>: equivalent — <proof>` is
allowed **only** for a proven equivalent and only where one already exists or a new proof
is written out in full.

**Surface gates.** `reports/api.json` is regenerated by `npm run docs:json` and checked by
`check:doc-typedoc` at **prepush**, not by `validate` — a locally-green validate can still
be rejected on push. It carries **doc comments**, not just types, so a TSDoc edit on an
already-exported symbol regenerates it. Parts that MUST run `npm run docs:json` and commit
`reports/api.json` in the same commit: **1** (`ParsedConfig` gains a field — 30 occurrences
in the report), **3** (`diffTrees` TSDoc), **5** (`synthesizeTreeFromIndex` TSDoc), **6**
(`walkTree` / `WalkTreeOptions` TSDoc), **7** (`walkWorkingTree` /
`WalkWorkingTreeOptions` TSDoc). Absent from the report, so no gate:
`MAX_TREE_WALK_DEPTH`, `MAX_MERGE_TREE_DEPTH`, `writeNestedTree`, `flattenRawTree`,
`walkRawSubtree`, `enumerateBundleObjects`, `FlattenBounds`. **No new error code is
introduced anywhere in this change** — `CONFIG_BAD_NUMERIC_VALUE` is reused, so
`src/domain/error.ts`'s union, `test/unit/domain/exhaustiveness.ts` and the barrel-surface
test are all untouched.

**Config-cache hazard (bites every part that writes config in a fixture).**
`readConfig`'s cache is a `WeakMap` keyed on **`Context` identity**
(`src/application/primitives/config-read.ts:117`). A fixture that writes `.git/config`
through one `Context` and reads through a spread copy gets a stale or independent read.
Every fixture writes and reads through the **same** `ctx` object and calls
`invalidateConfigCache(ctx)` (or `__resetConfigCacheForTests()` in `beforeEach`) after the
write. Interop tests that let **real git** write objects/config must build a **fresh**
`Context` afterwards — the per-`Context` loose-object fanout cache is invalidated only by
tsgit's own `writeObject`.

**Interop discipline** (`test/integration/interop-helpers.ts`). Every `git` spawn goes
through `runGit` / `runGitAsync` / `git(dir, …)`, which scrub every `GIT_*` var, point
`HOME` at a never-created path and set `GIT_CONFIG_NOSYSTEM=1`. `-C <path>` does **not**
override an inherited `GIT_DIR`. `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0` **do** override
`core.maxTreeDepth`, so a leaked `GIT_*` would silently change the value under test. Every
git-spawning integration suite uses **one shared `beforeAll` repo with an explicit 60 s
timeout** — `beforeAll(async () => { … }, 60_000)` — because the default 10 s hook timeout
fails under full-validate concurrency, and per-test repos are flaky here.

**Deep fixtures are never materialised on disk.** `PATH_MAX` is 1024 on darwin; a real
deep checkout dies at real depth ~471. Unit fixtures use `createMemoryContext()`; interop
fixtures feed git the path as **data** (`git update-index --add --cacheinfo
100644,<oid>,<path>` then `git write-tree`), never as a filesystem path.

**Forbidden assertions** (ADR-636 consequences, restated because they are easy to
reintroduce): no test asserts a raw `RangeError`, a frame count, a stack depth, or a
"deepest that works" number; no exact syscall-count assertion anywhere (platform-dependent,
has broken CI here).

**Acceptance oracle.** `npm run test:unit` must emit **zero**
`Exception in PromiseRejectCallback` lines (measured baseline at HEAD: exactly **2**, both
from `test/unit/application/primitives/synthesize-tree-from-index.test.ts`). It is a
process-level property, not an assertion any test can make about itself — it lives in the
part gate (parts 5 and 7) and at the phase boundary. Redirecting or filtering that stderr
to satisfy it is forbidden; the only acceptable fix is removing the overflow.

**One dictionary entry the first implementing part owes.** `npm run check:spelling` runs
`cspell` over `src/**/*.ts`, `test/**/*.ts`, `docs/**/*.md` and `*.md`, and `cspell.json`'s
`words` array is a whitelist — `loosecompression` sits in it at `:499`. The **all-lowercase**
qualified key this change asserts on (`core.` + the lower-cased key name) is not there, and
cspell cannot split it because it has no camel humps. **Part 1 adds that one word to
`cspell.json`'s `words` array, in alphabetical position, in the same commit as the first test
that asserts the literal.** No `cspell:disable` comment anywhere — a dictionary entry, not a
suppression. This plan document is itself under `docs/**/*.md`, which is why it *describes*
that key rather than spelling it.

**Blocker protocol.** Escalate as `{ unit, reason, ≤3 options }`. Never spin, never guess,
never silently narrow a part's scope.

---

## Part 1 — Cap resolution: `core.maxTreeDepth` parsed, defaulted, resolved, refused

### Context

This part builds the **surface** — nothing consumes it yet except its own tests. Parts 3,
5, 6, 7 wire the ten cap sites onto it.

**What git does (pinned; do not re-derive).** `core.maxTreeDepth` defaults to **2048**
(512 under MSVC — irrelevant here). The enforced predicate is `slashCount > cap`, on a
signed comparison, with **no** special case: `0` permits exactly top-level entries, and any
**negative** value refuses everything including a depth-0 tree. The value grammar is
exactly `parseGitInt`'s (leading-whitespace trim, one optional sign, `0x` hex / leading-`0`
octal / decimal, `k`/`m`/`g` unit suffixes) **narrowed to the C `int` range**, with two
refusal reasons: `'invalid unit'` and `'out of range'`. Git quotes the **all-lowercase**
key spelling in its own message. Accepted: `2048`, `+6`, `" 6"` (leading space), `1k`→1024,
`1m`→1048576, `0x10`→16, `010`→8, `07`→7, `2147483647`, `-2147483648`. Refused as *invalid
unit*: `"6 "` (trailing space), `08`, `2.5`, `""`, `"  "`, `true`. Refused as *out of
range*: `2147483648`, `4294967296`, `9999999999`, `99999999999999999999`, `-2147483649`.

**Files to touch.**

1. `src/domain/diff/flat-tree.ts` (19 lines). **Add** — do not yet rename or delete:
   ```ts
   /** Default tree-recursion depth when `core.maxTreeDepth` is unset — git's own default. */
   export const DEFAULT_MAX_TREE_DEPTH = 2048;
   ```
   `MAX_TREE_WALK_DEPTH = 1024` (`:19`) **stays for now**; part 3 removes two of its three
   importers and part 6 removes the last one and deletes it. Neither constant is in
   `reports/api.json` (verified: 0 occurrences) and neither is re-exported from
   `src/domain/diff/index.ts` (`:23-24` export only `FlatTree`/`FlatTreeEntry` and
   `MAX_FLAT_TREE_ENTRIES`). **This file is `domain/` — 100 % coverage applies.**

2. `src/application/primitives/config-read.ts` (1950 lines). **Five edit sites, all
   mechanical clones of the `looseCompression` field one line away:**
   - `:13-27` — `ParsedConfig.core` gains `readonly maxTreeDepth?: number;` with a TSDoc
     one-liner. **This is the api.json trigger for this part.**
   - `:1101` area — `MutableCore` gains `maxTreeDepth?: number;`.
   - `:1683` — rename the module-private `GIT_BOOL_INT_MAX = 2_147_483_647` /
     `GIT_BOOL_INT_MIN = -2_147_483_648` to `GIT_C_INT_MAX` / `GIT_C_INT_MIN` and rewrite
     their comment: they are now the shared C-`int` narrowing used by both
     `parseGitBoolean` and the `maxTreeDepth` apply. They are module-private (never
     exported), so this rename has no surface consequence. Update the one existing use in
     `parseGitBoolean` (`:1697`).
   - `:1165` `applyCoreEntry` — beside the `loosecompression`/`compression` arm, add a
     dispatch comparing `lowered` (the key name already lower-cased by `mergeCore` at
     `:1189`) against the all-lowercase spelling of `maxTreeDepth`, delegating to
     `applyMaxTreeDepthEntry(core, value)` —
     a new sibling of `applyLooseCompressionEntry` (`:1113`) that parses with
     `parseGitInt`, narrows to `GIT_C_INT_MIN..GIT_C_INT_MAX`, and returns `undefined`
     (field merges as **absent**, lenient) on any failure. `applyCoreEntry` already skips
     `value === null` for non-boolean keys, so the valueless case merges as absent for
     free. **Leniency here is deliberate and load-bearing**: `readConfig` must stay total
     because the surfaces git keeps alive on an invalid value (`config --get`/`--list`,
     `config <write>`, `init`) read config through the same machinery. The refusal is a
     second, independent read of the same cached tokens.
   - `:1545` `finalizeCore` — add
     `...(core.maxTreeDepth !== undefined ? { maxTreeDepth: core.maxTreeDepth } : {}),`
     and add `maxTreeDepth?: number;` to `finalize`'s local `out.core` structural type
     (`:1614` area).
   - **New export** in the same file, modelled on `findFirstInvalidCompression` (`:301`)
     which is the template for the token walk, the `matchesSection(token.section,
     token.subsection, 'core', undefined)` gate, the `core.${loweredKey}` qualified key, the
     `token.startLine + 1` line, and the `token.value === null → { value: '', reason:
     'invalid unit' }` mapping:
     ```ts
     export interface InvalidMaxTreeDepthEntry {
       readonly key: string;      // always `core.` + the lower-cased key name
       readonly source: string;
       readonly line: number;
       readonly value: string;
       readonly reason: 'invalid unit' | 'out of range';
     }
     export const findLastInvalidMaxTreeDepth = async (
       ctx: Context,
     ): Promise<InvalidMaxTreeDepthEntry | undefined> => { … };
     ```
     **Two deliberate differences from its sibling, both forced by git and both documented
     at the site as a `why` comment** (a future reader "fixing" this to match its sibling
     must argue with the comment first):
     - it returns the **LAST** `core.maxTreeDepth` entry in file order, then validates only
       that one — git validates this key's **effective, last-wins** value. `core.compression`
       by contrast dies on *any* malformed line. The comment states that git reaches
       `maxTreeDepth` through its cached config-set lookup rather than through the
       streaming `git_default_config` callback the other `[core]` keys ride, cites the
       compression contrast as the thing a reader will otherwise assume is a bug, and says
       the ordering is pinned rather than chosen.
     - the C-`int` narrowing sits **here**, on top of `parseGitInt`, and it is what turns
       `4294967296` into `out of range` — `parseGitInt`'s own bounds are int64 and it
       returns `ok` for that value.
     Both go through `readConfigEntry(ctx)` (the module-private cache accessor
     `findFirstInvalidCompression` uses), so this costs an in-memory scan, not a second read.

3. **New file** `src/application/primitives/internal/resolve-max-tree-depth.ts`:
   ```ts
   export const resolveMaxTreeDepth = async (ctx: Context): Promise<number> => { … }
   ```
   - reads `findLastInvalidMaxTreeDepth(ctx)`; if defined, throws
     `configBadNumericValue(entry.key, entry.source, entry.value, entry.reason)` from
     `src/domain/commands/error.ts:567`;
   - otherwise returns `(await readConfig(ctx)).core?.maxTreeDepth ?? DEFAULT_MAX_TREE_DEPTH`.
   - **Internal**: it is NOT added to `src/application/primitives/index.ts`, NOT added to
     `repository.ts`, and therefore never reaches `reports/api.json` or the docs surface.
   - **`resolveMaxTreeDepth` DOES refuse.** ADR-639 supersedes the design's §A8.4 sentence
     "Never throws". The design predates DC-15; ADR-639's decision paragraph is explicit:
     the resolver refuses "as a defensive guard for any direct primitive path that does not
     pass through a command's operational gate". The two guards (this one and part 2's
     eager gate) are **deliberately redundant** — the gate covers the command surface, the
     resolver covers the primitive surface the gate cannot see. Write that reason as the
     module doc comment.
   - Absence is **not** failure: `readConfig` returns `{}` for a missing config file, so a
     bare / fresh / memory-adapter repository resolves to 2048 with no error path.
   - Resolution is **once per operation, at the entry point** — never per level. Both
     lookups hit the same cached `ConfigCacheEntry`, so one call is one `WeakMap` hit after
     the first read per `Context`.

4. `test/unit/application/primitives/fixtures.ts` — add and export
   ```ts
   export const seedMaxTreeDepth = async (ctx: Context, value: string): Promise<void>
   ```
   writing `` `[core]\n\tmaxTreeDepth = ${value}\n` `` to `${ctx.layout.gitDir}/config`
   then calling `invalidateConfigCache(ctx)`. Existing tests write config exactly this way
   (`test/unit/application/primitives/config-read.test.ts:33` `seed()`), and command-level
   tests already import from this file (`test/unit/application/commands/archive.test.ts:9`,
   `add.test.ts:20`, `cat-file.test.ts:8`), so parts 3/5/6/7 reuse it across both trees.

**Tests to extend / create.**
- `test/unit/application/primitives/config-read.test.ts` (existing; `beforeEach` already
  calls `__resetConfigCacheForTests()`, and `seed(ctx, content)` at `:33` writes
  `${ctx.layout.gitDir}/config`) — add describes for `findLastInvalidMaxTreeDepth` and for
  `readConfig`'s new lenient field.
- **New** `test/unit/application/primitives/internal/resolve-max-tree-depth.test.ts`.

### TDD steps

**RED 1 — the grammar sweep on the resolver.** Parameterised `it.each` over the accepted
rows (`2048`→2048, `+6`→6, `" 6"`→6, `1k`→1024, `1m`→1048576, `0x10`→16, `010`→8, `07`→7,
`2147483647`, `-2147483648`) asserting `resolveMaxTreeDepth` returns the parsed number.
Fails: module does not exist. **Assert the value, not merely that it resolved** — a
type-only check leaves every arithmetic mutant alive. Note in a comment that `parseGitInt`
itself is already covered by the existing config suite; what these rows pin is the
**narrowing and the default layered on top of it**, so do not re-derive `parseGitInt`'s
behaviour through this seam.

**RED 2 — the refusal reasons, two isolated cases, never parameterised together.**
`2.5` → `CONFIG_BAD_NUMERIC_VALUE` with `reason === 'invalid unit'`; `2147483648` →
`reason === 'out of range'`. try/catch + direct `.data.reason` / `.data.key` /
`.data.value` / `.data.source` reads. The `'out of range'` case is the **only** test that
proves the C-`int` narrowing sits on this path — `parseGitInt` alone returns `ok` for
`2147483648`. Fails: no refusal.

**RED 3 — zero and negative are caps, not switches. Three isolated tests** (the guard-clause
rule binds: one test covering two conditions proves neither):
- `cap = 0` resolves to `0` (not "unlimited", not the default);
- `cap = -1` resolves to `-1`;
- `cap = -2147483648` resolves to `-2147483648` (a *valid* value — the C-`int` floor).
  A future `cap <= 0 → unlimited` branch must fail these loudly.

**RED 4 — unset and absent both resolve to 2048. Two isolated tests**, because they reach
the resolver by different branches: (a) a config file with a `[core]` section that has no
`maxTreeDepth` key; (b) **no config file at all** (`createMemoryContext()` untouched) —
absence is not failure. Assert `=== 2048` by importing `DEFAULT_MAX_TREE_DEPTH`, not the
literal, so a mutation at the declaration site is caught.

**RED 5 — last-wins, two isolated tests, never one.** In `config-read.test.ts`:
`[core]\n\tmaxTreeDepth = 2.5\n\tmaxTreeDepth = 2048\n` → `findLastInvalidMaxTreeDepth`
returns `undefined` (git exits 0 here); `[core]\n\tmaxTreeDepth = 2048\n\tmaxTreeDepth =
2.5\n` → returns the entry for `2.5`. A finder that returns the *first* failing entry
passes the second and fails the first — precisely the sibling-shaped mistake this design
exists to prevent.

**RED 6 — valueless and empty are one case, two tests.** `[core]\n\tmaxTreeDepth\n`
(valueless, no `=`) and `[core]\n\tmaxTreeDepth =\n` (empty value) both yield
`{ value: '', reason: 'invalid unit' }`. Two tests, not a parameterised pair: a `null`
token and an empty string reach the finder by different branches.

**RED 7 — the lenient `ParsedConfig` field.** `readConfig` on
`[core]\n\tmaxTreeDepth = 4096\n` yields `core.maxTreeDepth === 4096`; on
`[core]\n\tmaxTreeDepth = 2.5\n` the field is **absent** (`undefined`) and `readConfig`
does **not** reject — the value path stays total, the refusal is the gate's job. Also assert
`[core]\n\tmaxTreeDepth = 2147483648\n` merges as absent (the narrowing applies in
`applyCoreEntry` too, so `ParsedConfig` never carries a value git would reject).

**RED 8 — case-insensitive key matching.** `[core]\n\tMaxTreeDepth = 4\n` resolves to `4`,
and the invalid form reports the qualified key **all-lowercase** — `core.` followed by the
lower-cased key name, exactly as `findFirstInvalidCompression` emits `core.` + its own keys.
Git quotes the lowercase spelling; the finder must too.

**GREEN.** Implement in the order: `DEFAULT_MAX_TREE_DEPTH` → the `config-read.ts` field
plumbing (interface, `MutableCore`, `applyMaxTreeDepthEntry`, `applyCoreEntry` arm,
`finalizeCore`, `finalize`'s local type) → `GIT_C_INT_*` rename →
`findLastInvalidMaxTreeDepth` → `resolve-max-tree-depth.ts`.

**REFACTOR.** Confirm `applyMaxTreeDepthEntry` and `applyLooseCompressionEntry` are not
duplicated logic (they differ: the loose/compression precedence flag has no analogue here)
— if the shared shape is only "parse then narrow", extract nothing; the rule-of-two is not
met. Re-read the last-wins `why` comment on the finder and confirm it names the compression
contrast explicitly.

**Regenerate `reports/api.json`** (`npm run docs:json`) and commit it — `ParsedConfig` is
in the report.

### Gate

```
npx vitest run \
  test/unit/application/primitives/config-read.test.ts \
  test/unit/application/primitives/config-read.properties.test.ts \
  test/unit/application/primitives/config-int.properties.test.ts \
  test/unit/application/primitives/internal/resolve-max-tree-depth.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check \
  src/domain/diff/flat-tree.ts \
  src/application/primitives/config-read.ts \
  src/application/primitives/internal/resolve-max-tree-depth.ts \
  test/unit/application/primitives/fixtures.ts \
  test/unit/application/primitives/config-read.test.ts \
  test/unit/application/primitives/internal/resolve-max-tree-depth.test.ts
```
Plus: `npm run docs:json && git diff --exit-code -- reports/api.json` must be clean **after**
`reports/api.json` is staged.

### Commit

```
feat(config): read core.maxTreeDepth with git's numeric grammar and a 2048 default
```

## Part 2 — Repo-wide eager refusal, the five ungated commands, and the bundle pin

### Context

An invalid `core.maxTreeDepth` must refuse the **whole operational surface**, not just the
ten cap sites — git parses `core.*` at startup and goes fatal on commands with no depth
surface at all.

**The pinned refusal surface (git 2.55.0, invalid value `2.5` in local scope, repo with one
commit).** **Exit 0 — survive:** `config --get <key>`, `config --list`,
`config --local --list`, `config --get core.maxTreeDepth` (reads `2.5` back verbatim),
`config <key> <value>` (a write), `init` (re-init), `remote -v`. **Exit 128 — refuse:**
`rev-parse HEAD`, `rev-parse --git-dir`, `rev-list --all`, `rev-list --objects --all`,
`log`, `cat-file -t`, `add`, `commit`, **and** `archive --format=tar`, `fsck`, `grep`,
`bundle create`, `clone`. **Validation model:** invalid-then-valid **succeeds** (exit 0);
valid-then-invalid **refuses**. **Ordering:** with a malformed `core.loosecompression` or
`core.sparseCheckout` on an *earlier* line, git still reports **maxTreeDepth** — it is not
line-ordered against the other classes.

**Where the refusal sits, and the two mechanisms that were refuted on evidence** (do not
re-propose either): a strict per-entry applier inside `assembleParsed` refuses
invalid-then-valid where git exits 0; a throw inside `loadConfigEntry` poisons the single
cached `ConfigCacheEntry` that also carries `tokens`, killing all seven `findFirstInvalid*`
finders and the `config` porcelain — the surfaces git keeps alive.

**Files to touch.**

1. `src/application/primitives/internal/repo-state.ts` (257 lines) — the eager gate.
   `assertEagerConfigValid` (`:139`) currently runs five finders in `Promise.all` and
   reduces them with `pickLowerLine` (`:52`), then `throwEagerCandidate` (`:106`).
   **Add `findLastInvalidMaxTreeDepth` as a SIXTH parallel finder and throw it BEFORE the
   reduction runs** — it is *not* a `pickLowerLine` candidate. Dropping it into the
   `candidates` array is the natural-looking mistake and it fails the ordering tests below.
   Shape:
   ```ts
   const [maxTreeDepth, str, comp, boolCore, logAllRefUpdates, boolDiff] =
     await Promise.all([ findLastInvalidMaxTreeDepth(ctx), … ]);
   if (maxTreeDepth !== undefined) {
     throw configBadNumericValue(
       maxTreeDepth.key, maxTreeDepth.source, maxTreeDepth.value, maxTreeDepth.reason);
   }
   // …existing five-way lowest-line reduction, unchanged
   ```
   Extend the existing block comment at `:122-138` to name the new key **and** its
   different validation model (effective/last-wins, reported ahead of the line-ordered
   classes) — and say the ordering is pinned rather than chosen.
   `assertOperationalRepository` (`:172`) is unchanged; it already calls
   `assertRepository` then `assertEagerConfigValid`. `assertRepository` (`:84`) — the
   discovery tier the `config` porcelain rides — stays untouched.

2. **The five ungated commands gain `assertOperationalRepository`.** Verified at HEAD:
   - `src/application/commands/archive.ts:35` — currently `await assertRepository(ctx);`
     inside `archive()`. Swap to `assertOperationalRepository`, updating the import at
     `:10`.
   - `src/application/commands/bundle-create.ts:252` — currently `assertRepository`
     (import at `:14`). Swap.
   - `src/application/commands/fsck.ts:53` — currently `assertRepository` (import at
     `:26`). Swap.
   - `src/application/commands/clone.ts:72` — **no gate at all, and a literal
     `assertOperationalRepository(ctx)` here would be wrong.** This is a considered
     decomposition of ADR-639's "one call each", not an improvisation, and the reason is
     mechanical: `assertOperationalRepository` (`repo-state.ts:172`) is `assertRepository`
     **+** `assertEagerConfigValid`, and `assertRepository` asserts that `${gitDir}/HEAD`
     **exists** — while `clone` runs against a *target* that must NOT already be a
     repository (`:73-75` throws `TARGET_DIRECTORY_NOT_EMPTY` exactly when
     `${gitDir}/HEAD` exists). Composed literally it would throw `NOT_A_REPOSITORY` on
     every legitimate clone. What git refuses on is its **startup config read of the
     repository it is standing in**, when there is one — which is the
     `assertEagerConfigValid` half alone. Implement: reuse the existence probe already at
     `:73`; when `${ctx.layout.gitDir}/HEAD` exists, `await assertEagerConfigValid(ctx)`
     **before** `targetDirectoryNotEmpty` is thrown, so a bad config refuses first, matching
     git's startup-parse ordering. When the target is empty there is no repository to read
     config from and nothing refuses. **If the implementer finds this shape does not
     reproduce the pin, escalate `{ unit: part 2 / clone, reason: …, options […] }` rather
     than inventing a third shape.**
   - `src/application/commands/grep.ts:165` — no gate. `grep()` opens with
     `if (opts.patterns.length === 0) throw invalidOption(…)`. **Keep that refusal first**
     — it is an argument error, not a repository-state error, and reordering it would
     change an existing refusal's precedence. Insert
     `await assertOperationalRepository(ctx);` immediately after it and before
     `buildGrepMatcher`. Add the import.

   All five import from `./internal/repo-state.js`, which is a **deprecated shim**
   (`src/application/commands/internal/repo-state.ts`, 452 B) re-exporting from
   `src/application/primitives/internal/repo-state.ts`. Follow each file's existing import
   path; do not migrate imports in this part.

3. **`config`, `init` and `remote` stay ungated.** That is not an omission — the pin has git
   surviving on all three, and gating them would break the one porcelain a user with a bad
   value needs in order to fix it. Do not touch `src/application/commands/config.ts`,
   `init.ts` or `remote.ts`.

4. **`bundle-list-heads` and `bundle-verify` must be PINNED before they are changed.**
   `src/application/commands/bundle-list-heads.ts:16` (`bundleListHeads`) and
   `bundle-verify.ts:34` (`bundleVerify`) are ungated and share `bundle-create`'s shape,
   but were **never pinned against real git**. Do **not** gate them on the strength of the
   resemblance. This part **pins them first**: in a `mktemp -d` throwaway (never the
   worktree), with the interop helpers' scrubbed env, build a repo with one commit, write
   `core.maxTreeDepth = 2.5` into local config, produce a bundle, then run
   `git bundle list-heads <file>` and `git bundle verify <file>` and record the exit codes
   as assertions in the new interop file. **Branch:** exit 128 ⇒ they join the five and gain
   `assertOperationalRepository` in this same part; exit 0 ⇒ they stay ungated and the
   interop test records the surviving behaviour with a comment saying so. Either way the
   pin ships as an assertion.

5. **`src/domain/fsck/validate-tree.ts` gains NO depth check.** `git fsck --strict` exits 0
   on a repo containing a 2049-deep tree. Adding one "for symmetry" would be a divergence
   in the strict direction. Recorded so its absence is not read as an omission.

**Tests to extend / create.**
- `test/unit/application/commands/internal/repo-state.test.ts` (existing — this is where the
  gate's unit tests live even though the source moved to `primitives/internal/`).
- Per-command unit tests: `test/unit/application/commands/{archive,bundle-create,clone,
  fsck,grep}.test.ts`, plus `bundle-list-heads.test.ts` / `bundle-verify.test.ts` if the pin
  puts them in scope.
- **New** `test/integration/max-tree-depth-config-interop.test.ts`.

### TDD steps

**RED 1 — the gate refuses, with both reasons, isolated.** In `repo-state.test.ts`: a
memory context whose `.git/config` holds `[core]\n\tmaxTreeDepth = 2.5\n` makes
`assertOperationalRepository` throw `CONFIG_BAD_NUMERIC_VALUE`. Assert the **whole
payload** via try/catch and direct `.data` reads: `key` is the all-lowercase qualified key,
`source === ${gitDir}/config`, `value === '2.5'`, `reason === 'invalid unit'`. Second,
separate test with `2147483648` → `reason === 'out of range'`. The reason strings are
exactly the StringLiteral mutants a code-only assertion leaves alive.

**RED 2 — the porcelain survives, both directions, two tests.** (a)
`assertRepository` on the same context returns normally. (b) `configGet` / `configList`
(from `src/application/commands/config.ts`) succeed on that repository and `configGet`
reads the invalid value back **verbatim** (`'2.5'`). Test (b) is the one that fails if
someone "simplifies" the design into a strict `readConfig`; it earns a test rather than a
comment.

**RED 3 — gate ordering, two isolated tests.** (a) `[core]` with
`loosecompression = bogus` on line 2 and `maxTreeDepth = 2.5` on line 3 → the thrown error
is the **maxTreeDepth** one (its all-lowercase qualified key), not
`core.loosecompression`. (b) same with `sparseCheckout = bogus` on the earlier line →
still maxTreeDepth. Dropping the new finder into the `pickLowerLine` candidate list passes
everything else and fails exactly these two.

**RED 4 — last-wins reaches the gate, two isolated tests.** invalid-then-valid ⇒
`assertOperationalRepository` **returns normally**; valid-then-invalid ⇒ refuses. Distinct
from part 1's finder tests: this proves the gate consumes the finder's last-wins semantics
rather than re-deriving them.

**RED 5 — the five commands refuse.** One test per command
(`archive`, `bundleCreate`, `fsck`, `grep`, `clone`) on a repository holding
`maxTreeDepth = 2.5`: `CONFIG_BAD_NUMERIC_VALUE` with `reason === 'invalid unit'`. For
`clone`, the fixture must be a context whose `gitDir/HEAD` already exists (the
already-a-repository branch), and a **second** test asserts a clone into a genuinely empty
target still gets its existing behaviour (no `CONFIG_BAD_NUMERIC_VALUE`), so the gate does
not fire where there is no repository to read.

**RED 6 — the two redundant guards each need isolated coverage** (ADR-639's consequence
paragraph binds the pair, not just each `if`). (a) Command surface: covered by RED 5.
(b) **Primitive surface, bypassing every command gate**: call `resolveMaxTreeDepth(ctx)`
directly on a context holding `maxTreeDepth = 2.5` and assert the refusal. Arrange so the
gate cannot be what refuses — no command in the call path. A test that proves only one of
the two proves nothing about the other.

**RED 7 — the interop file** `test/integration/max-tree-depth-config-interop.test.ts`.
House shape: `@proves` header block (`surface`, `bucket: cross-tool-interop`, `unique`,
`interopSurface`), `describe.skipIf(!GIT_AVAILABLE)`, **one shared `beforeAll` repo with a
60 s timeout**, `runGit`/`git`/`runGitEnv` from `./interop-helpers.js`. Every config row is
driven through a **file write** or `-c`, never through the developer's global git. Rows:
- **N1/N2/N2b** — `git config --get user.name`, `--list`, `--local --list`,
  `--get core.maxTreeDepth` (reads `2.5` back), and a `git config <k> <v>` write all exit 0;
  tsgit's `configGet`/`configList`/`configSet` all succeed on the same repository.
- **N3** — `git log`, `git rev-parse HEAD`, `git add`, `git commit` exit 128; tsgit's
  `log` / `revParse` / `add` / `commit` throw `CONFIG_BAD_NUMERIC_VALUE`. Assert the
  **condition**, never git's stderr bytes and never the all-lowercase key git quotes back.
- **N3b** — `git archive --format=tar`, `git fsck`, `git grep`, `git bundle create`,
  `git clone` exit 128; the five tsgit commands throw.
- **N3c/N4** — `git remote -v` and `git init` (re-init) exit 0; tsgit's `remote` and `init`
  succeed.
- **N7/N8** — invalid-then-valid: `git status --porcelain` exits 0 **and** tsgit's `status`
  succeeds. valid-then-invalid: both refuse. **Two tests.** N7 is the row that proves tsgit
  reads the *effective* value the way git does, and it is the assertion that fails on any
  per-entry strict variant.
- **The bundle pin** — `git bundle list-heads` and `git bundle verify` exit codes recorded
  as assertions, with the tsgit-side assertion matching whichever branch the pin lands on.

**Trap for RED 7:** after the real `git` writes objects/config into the fixture repo,
build a **fresh** `Context` (`createNodeContext`) before driving tsgit — the per-`Context`
loose-object fanout cache is invalidated only by tsgit's own `writeObject`.

**GREEN.** Wire the sixth finder into `assertEagerConfigValid` ahead of the reduction; swap
the three `assertRepository` calls; add the two missing gates; act on the bundle pin.

**REFACTOR.** Re-read the extended gate comment: it must say *why* maxTreeDepth is checked
first (git's cached config-set lookup vs the streaming `git_default_config` pass) and *why*
it is validated last-wins where compression is not, without any provenance reference.
Confirm no command file gained a second, redundant gate call.

### Gate

```
npx vitest run \
  test/unit/application/commands/internal/repo-state.test.ts \
  test/unit/application/commands/archive.test.ts \
  test/unit/application/commands/bundle-create.test.ts \
  test/unit/application/commands/bundle-list-heads.test.ts \
  test/unit/application/commands/bundle-verify.test.ts \
  test/unit/application/commands/clone.test.ts \
  test/unit/application/commands/fsck.test.ts \
  test/unit/application/commands/grep.test.ts \
  test/unit/application/primitives/internal/resolve-max-tree-depth.test.ts \
  test/integration/max-tree-depth-config-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check \
  src/application/primitives/internal/repo-state.ts \
  src/application/commands/archive.ts \
  src/application/commands/bundle-create.ts \
  src/application/commands/clone.ts \
  src/application/commands/fsck.ts \
  src/application/commands/grep.ts \
  test/unit/application/commands/internal/repo-state.test.ts \
  test/integration/max-tree-depth-config-interop.test.ts
```

### Commit

```
feat(config): refuse an invalid core.maxTreeDepth across the operational surface
```

## Part 3 — The six already-bounded sites take the resolved cap

### Context

ADR-636 leaves six descents recursive; ADR-637 makes their **cap value** the resolved
`core.maxTreeDepth`. This is a constant change, not a rewrite. It also closes a
faithfulness gap in the **strict** direction: all six cap a traversal at 1024 today where
git traverses to 2048, so tsgit currently refuses trees `git diff`,
`git rev-list --objects` and `git bundle create` handle without complaint.

**The async/sync hazard.** `resolveMaxTreeDepth` is `async`; `exceedsMaxTreeDepth(depth,
cap)` (`src/application/primitives/validators.ts:224`, body `return depth > cap;`) is a
pure comparator and **must stay sync**. Resolve **once per operation, at the entry point**,
and thread the number down as a plain value — exactly what the existing
`FlattenConfig.bounds` / `WalkConfig` objects already do. Resolving per level would also
multiply a `WeakMap` lookup across every frame of a hot walk.

**The six sites and their exact plumbing.**

| # | Site | File · symbols | Cap today | Entry point that resolves |
|---|---|---|---|---|
| S6 | `flattenLevel` | `src/application/primitives/internal/flatten-raw.ts:105` (guard at `:115`) | `config.bounds.maxDepth` ← `DEFAULT_FLATTEN_BOUNDS` (`:53`) = `MAX_TREE_WALK_DEPTH` | `flattenRawTree` (`:87`) — but `bounds` is a **required positional** |
| S7 | `diffChangedSubtree` | `src/application/primitives/diff-trees.ts:576` (guard at `:582`, reads `MAX_TREE_WALK_DEPTH` **directly**) | 1024 module const | `diffTrees`' public entry points |
| S8 | `collectTreeObjects` / `emitTreeObjects` | `src/application/primitives/enumerate-bundle-objects.ts:86,118` (guards use local `MAX_TREE_DEPTH = 1024` at `:38`) | 1024 | `enumerateBundleObjects` (`:172`) |
| S9 | `markTree` | `src/application/primitives/internal/closure-not-marks.ts:45` (guard reads local `MAX_TREE_DEPTH = 1024` at `:28`) | 1024 | `markNotSide` (`:142`) and `markBoundaryTrees` (`:164`) |
| S10 | `walkLevel` | `src/application/primitives/internal/walk-raw-subtree.ts:121` (guard at `:131`) | `config.bounds.maxDepth` | `walkRawSubtree` (`:107`) — `bounds` positional |

**The one real signature question, decided here: `DEFAULT_FLATTEN_BOUNDS` becomes a
resolver call, not an optional field.** Replace
```ts
export const DEFAULT_FLATTEN_BOUNDS: FlattenBounds = { maxDepth: MAX_TREE_WALK_DEPTH, maxEntries: MAX_FLAT_TREE_ENTRIES };
```
(`flatten-raw.ts:53`) with
```ts
export const resolveFlattenBounds = async (ctx: Context): Promise<FlattenBounds> => ({
  maxDepth: await resolveMaxTreeDepth(ctx),
  maxEntries: MAX_FLAT_TREE_ENTRIES,
});
```
Rationale to write into the module doc: keeping `FlattenBounds.maxDepth` **required** makes
it structurally impossible for a call site to forget the cap, and every one of the four
production call sites has `ctx` in hand. Making the field optional would move the default
into `flattenLevel` — i.e. per level — which is the hazard above.

**Production call sites of `DEFAULT_FLATTEN_BOUNDS` (all four have `ctx`):**
`src/application/primitives/flatten-tree.ts:20,25`;
`src/application/primitives/diff-trees.ts:50` (import), `:391`, `:394`, `:602`
(`subtreeExpansionBounds(state)` — it currently reads `DEFAULT_FLATTEN_BOUNDS.maxDepth`;
change `DiffWalkState` to carry the resolved `maxDepth` alongside its existing
`maxEntries`, resolved once at the diff entry point, and have `subtreeExpansionBounds`
read it from state). Update the doc comment at `diff-trees.ts:614` which says *"only
`maxDepth` stays fixed at `DEFAULT_FLATTEN_BOUNDS`' value"*.

**Test call sites of `DEFAULT_FLATTEN_BOUNDS`** (must all change — 20 occurrences):
`test/unit/application/primitives/internal/walk-raw-subtree.test.ts:3,36,161,191,215,242,300,536`
and `test/unit/application/primitives/internal/flatten-raw.test.ts:4,177,213,257,302,329,375,440,493,528,565,592,621,662`.
Replace with `await resolveFlattenBounds(ctx)` or an explicit literal
`{ maxDepth: <n>, maxEntries: MAX_FLAT_TREE_ENTRIES }` — whichever reads clearer per case.

**S9's threading.** `markTree` is reached from three call paths inside
`closure-not-marks.ts` (`:130`, `:134` in `markCommitAncestry`; `:178` in
`markBoundaryTrees`). `markNotSide(ctx, not)` and `markBoundaryTrees(ctx, marks, …)` are
separate exported entry points. Resolve **once** in `markNotSide` and carry the number on
the already-threaded `NotMarks` struct (`:30`) as `readonly maxDepth: number`, so
`markBoundaryTrees` reads `marks.maxDepth` instead of resolving again. Its only consumer is
`src/application/primitives/internal/closure-engine.ts:220`.

**Delete `MAX_TREE_WALK_DEPTH`'s two importers here, not the constant.** After this part
`src/domain/diff/flat-tree.ts:19`'s `MAX_TREE_WALK_DEPTH` has exactly one importer left —
`src/application/primitives/walk-tree.ts:1,41` — which part 6 removes, and part 6 deletes
the constant. Do not delete it here; `check:types` would go red.

**Three module constants die here:** `enumerate-bundle-objects.ts:38`'s
`MAX_TREE_DEPTH = 1024` and its "Same bound as walk-tree.ts's default maxDepth" comment
(`:36-37`), and `closure-not-marks.ts:28`'s `MAX_TREE_DEPTH = 1024` with the same comment
(`:26-27`). They stop restating anything.

**Existing deep fixtures that must shrink to a small configured cap** (they build real
1025-level structures today and would need 2049 levels after this part — slow, and the
design's whole test-strategy simplification is to stop doing this):
- `test/unit/application/primitives/diff-trees.test.ts:2603-2630` — "1025 levels deep".
- `test/unit/application/primitives/enumerate-bundle-objects.test.ts:532,561,594,627` —
  four cases at 1024/1025.
- `test/unit/application/primitives/internal/closure-engine.test.ts:645-672`.

**The TSDoc obligation on `diffTrees`.** `diffTrees` is public and in `reports/api.json`.
Its TSDoc must state the depth bound is `core.maxTreeDepth`, default 2048, honoured
unclamped, **"read from the repository-local config"** — never the unqualified "read from
git config", which would assert git's precedence and be false (tsgit reads local scope
only; a value in `~/.gitconfig` is honoured by git and ignored by tsgit). **This part
regenerates `reports/api.json`.**

### TDD steps

**RED 1 — the at-cap / one-past-cap pair, per site, at a SMALL configured cap.** Five
pairs (S6, S7, S8, S9, S10), each shaped:
```
Given a repository configured with core.maxTreeDepth = 4
  When <site> is driven at depth 4   Then it completes
  When <site> is driven at depth 5   Then TREE_DEPTH_EXCEEDED with depth === 5
```
Use `seedMaxTreeDepth(ctx, '4')` from `test/unit/application/primitives/fixtures.ts`
(added in part 1) on the **same** `ctx` the site is then driven with. A depth-4 fixture is
four nested trees; it is identical on linux, macOS and Windows and exercises exactly the
arithmetic a 2048-deep fixture would. Each one-past-cap test asserts the **exact `depth`
value** via try/catch + `.data.depth`, never the code alone — a code-only assertion leaves
the counting arithmetic unmutated. **At-cap and one-past-cap are separate tests**: one test
tripping both proves neither. Fails today: the sites read 1024 and ignore config.

**RED 2 — the guard is reachable, per site.** Same fixture family, input **20× past** the
configured cap (20× of a single digit — free): `TREE_DEPTH_EXCEEDED` with
`depth === cap + 1`, never a larger `depth`, never a `RangeError`. This is the single
assertion class that would have caught the original defect.

**RED 3 — the cap is read, not guessed, per site.** The **same** fixture passes at
`core.maxTreeDepth = N` and refuses at `core.maxTreeDepth = N - 1`. A site that ignored the
config would pass RED 1 and RED 2 against a hardcoded value and fail only this. Without it,
"the config is wired through" is untested at five of the ten sites.

**RED 4 — `exceedsMaxTreeDepth`'s `>`, isolated.** In
`test/unit/application/primitives/validators.test.ts`: `depth === cap` → `false`;
`depth === cap + 1` → `true`. Two tests, so `>`→`>=` and `>`→`<` are both killed at the
comparator rather than incidentally at ten call sites. (If equivalents already exist, keep
them and note it — do not duplicate.)

**RED 5 — the existing deep fixtures, rewritten.** Convert `diff-trees.test.ts:2603`,
`enumerate-bundle-objects.test.ts:532/561/594/627` and `closure-engine.test.ts:645` from
1024/1025-level real structures to the small-configured-cap shape of RED 1. Preserve each
test's original *claim* (which guard fires, which side of the boundary) — only the fixture
size and the cap source change. Their describe/it titles must lose any reference to the
literal 1024.

**GREEN.** In order: `resolveFlattenBounds` replaces `DEFAULT_FLATTEN_BOUNDS` (S6, S10) →
`DiffWalkState.maxDepth` + `subtreeExpansionBounds` + `diffChangedSubtree`'s guard (S7) →
`enumerateBundleObjects` resolves once and threads a `maxDepth` parameter into
`collectTreeObjects`/`emitTreeObjects` (S8) → `NotMarks.maxDepth` (S9). Delete the two
`MAX_TREE_DEPTH = 1024` module constants. Update every test call site of
`DEFAULT_FLATTEN_BOUNDS`.

**REFACTOR.** `flattenRawTree`'s module doc (`:12-14`) says *"`flattenTree` calls this with
`DEFAULT_FLATTEN_BOUNDS`"* — rewrite. `diff-trees.ts:614`'s *"only `maxDepth` stays fixed
at `DEFAULT_FLATTEN_BOUNDS`' value"* — rewrite. Rewrite `diffTrees`' TSDoc with the
"read from the repository-local config" wording. Confirm no site resolves the cap more than
once per operation (grep for `resolveMaxTreeDepth` / `resolveFlattenBounds` call sites and
check each is at an entry point, not inside a loop or a recursive function).

**Regenerate `reports/api.json`** and commit it — `diffTrees`' doc comment changed.

### Gate

```
npx vitest run \
  test/unit/application/primitives/internal/flatten-raw.test.ts \
  test/unit/application/primitives/internal/walk-raw-subtree.test.ts \
  test/unit/application/primitives/internal/closure-engine.test.ts \
  test/unit/application/primitives/diff-trees.test.ts \
  test/unit/application/primitives/enumerate-bundle-objects.test.ts \
  test/unit/application/primitives/flatten-tree.test.ts \
  test/unit/application/primitives/validators.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check \
  src/application/primitives/internal/flatten-raw.ts \
  src/application/primitives/internal/walk-raw-subtree.ts \
  src/application/primitives/internal/closure-not-marks.ts \
  src/application/primitives/diff-trees.ts \
  src/application/primitives/enumerate-bundle-objects.ts \
  src/application/primitives/flatten-tree.ts \
  test/unit/application/primitives/internal/flatten-raw.test.ts \
  test/unit/application/primitives/internal/walk-raw-subtree.test.ts \
  test/unit/application/primitives/internal/closure-engine.test.ts \
  test/unit/application/primitives/diff-trees.test.ts \
  test/unit/application/primitives/enumerate-bundle-objects.test.ts \
  test/unit/application/primitives/validators.test.ts
```

### Commit

```
feat(primitives): bind the six bounded tree descents to the resolved core.maxTreeDepth
```

## Part 4 — Measure the six recursive sites' frame ceilings and publish the verdicts

### Context

**Docs-only part.** No `src/` and no `test/` delta. Its output is measured rows and a
per-site verdict written into `docs/design/depth-caps-and-node-aliases.md`, and its verdict
decides part 8's scope. It exists because ADR-636 refuses to commit to four more rewrites —
two of them on the hot raw-tree cursor path, carrying documented equivalent-mutant proofs
that would need re-deriving — before knowing the size of the problem.

**What is being measured, and why the existing table is not enough.** §A2.1 rows S8/S9/S10
are marked SAFE by **inference**, never driven. Rows S6 and S7 *were* driven to inputs of
20000 and 8000 and refused cleanly — but they refused **because the guard fired at 1025**,
so no run has ever held 20000 frames. S6 and S7 are as unmeasured at their real ceilings as
S8–S10 are. All six are measured here:

| Site | Symbol · file |
|---|---|
| S6 | `flattenLevel` — `src/application/primitives/internal/flatten-raw.ts` |
| S7 | `diffChangedSubtree` — `src/application/primitives/diff-trees.ts` |
| S8 | `collectTreeObjects` / `emitTreeObjects` — `src/application/primitives/enumerate-bundle-objects.ts` |
| S9 | `markTree` — `src/application/primitives/internal/closure-not-marks.ts` |
| S10 | `walkLevel` — `src/application/primitives/internal/walk-raw-subtree.ts` |

**The harness — §A2's, unchanged.** `esbuild --bundle --platform=node --format=esm` over a
scratch entry that imports the production modules **from the worktree by absolute path**,
driving each recursion at a chosen depth against `createMemoryContext()`. **One depth per
fresh `node` process** so no run warms another (JIT tier moves the ceiling by nearly 2×: the
same site clears 2250 cold and 4096 after 200 shallow warm-up calls). Default V8 stack.
**The probe lives outside the worktree and outside the test suite** — write it under the
session scratchpad or a `mktemp -d`, never into `src/`, `test/` or `tooling/`. Nothing is
written into the worktree except the design-doc edit. Its output is rows in a table, never
assertions: the quantity moves with JIT tier and stack size, so a test asserting it would be
asserting V8's mood.

**Method per site.** Part 3 made every one of the six read `core.maxTreeDepth`, so the
method is: seed a memory context with a **large** configured cap (e.g. `100000`), build a
chain of N nested trees, drive the site, and record whether it completes, refuses with
`TREE_DEPTH_EXCEEDED`, or dies with a raw `RangeError`. Bisect N per site. Record the
deepest N that completes as that site's ceiling. Note the ±1 imprecision inherent to how
each fixture maps input depth to recursion depth — the load-bearing claim is the
order-of-magnitude, not an off-by-one.

**Driving handles (all already exist after part 3):** S6 —
`flattenRawTree(ctx, root, bounds)`; S10 — `walkRawSubtree(ctx, root, bounds, prefix,
counter, emit)`; S7 — `diffTrees` over two trees differing at the deepest level; S8 —
`enumerateBundleObjects({ wants, haves })`; S9 — `markNotSide(ctx, [tip])`.

**The threshold: a site "holds" at a measured ceiling ≥ 4096** — 2× the 2048 default. The
factor is not arbitrary: the ceiling was measured **halving** with `--stack-size` at half
the default, and tsgit's supported surface (three OSes, workers, three browser engines) was
measured in exactly one corner. 2× is the smallest margin that survives the one adverse
factor that *was* measured, and it is the margin `walkTree` already enjoyed at cap 1024 /
ceiling 2100 — the configuration the design calls SAFE. Calibrated against a site the design
already accepts, not invented for the occasion.

**Where the results land.** `docs/design/depth-caps-and-node-aliases.md`:
- **§A2.1** — replace rows S6–S10's "SAFE (inferred — being measured)" verdicts with the
  measured ceilings and a HOLDS / DOES NOT HOLD verdict each, dated.
- **§A12** — add a "Results" subsection stating the machine, the Node version, the stack
  setting, the date, the per-site numbers, and which branch of §A12's table each site takes.
- Do not touch §A7, the Requirements, the Decisions table, or Out of scope.

**ADRs are immutable records — do NOT edit `docs/adr/636-*.md`.** ADR-636's
"provisionally" is discharged *by* this measurement being published, not by rewriting the
record.

### TDD steps

There is no RED/GREEN cycle for a measurement; the equivalent discipline is that the number
must be **produced before it is written down**, and the write-down must be falsifiable.

**Step 1 (the "RED" — a failing premise made explicit).** Before running anything, write
the two claims this part exists to test, verbatim, into the scratch notes: *(a) each of the
six is structurally bounded at `cap + 1` frames for any INPUT — true, and irrelevant once
the cap is user-controlled; (b) each therefore honours an arbitrary configured cap — an
inference with no measurement behind it.* Claim (b) is what the probe falsifies or confirms
per site.

**Step 2 — build the probe** in a `mktemp -d` outside the worktree. Verify the harness on a
**known** answer first: drive S6 at a configured cap of 4 and confirm it refuses with
`TREE_DEPTH_EXCEEDED` at depth 5. A harness that cannot reproduce the known answer cannot be
trusted on the unknown one.

**Step 3 — measure**, one depth per fresh process, bisecting per site. Record the raw
transcript in the scratch notes (not in the repo).

**Step 4 — write the verdicts** into §A2.1 and §A12. Each row carries: measured ceiling,
threshold comparison, verdict, date, machine/Node/stack.

**Step 5 — decide and hand off.** Count the sites below threshold. If **zero**: part 8 is
the doc-invariant branch for all six. If **one to three**: part 8 runs as planned with those
rewrites. If **four or more**: escalate per the plan's ordering section — do not silently
absorb it.

**Step 6 — spelling.** New prose in a doc goes through `npm run check:spelling`; the cspell
dictionary lags on some British `-ising`/`-ised` forms, so a red spelling run on a real word
is a dictionary entry, not a rewrite.

### Gate

Docs-only: the `<touched-tests>` and `<touched-files>` legs of the manifest gate are empty
(no test and no TypeScript file is touched), so the gate resolves to the doc-surface checks:

```
npm run check:spelling && npm run check:doc-links
```

Plus the part's own exit condition, verified by reading the diff: **six rows in §A2.1 carry
a measured ceiling and a verdict**, and §A12 carries a dated Results subsection. A part 4
commit that leaves any of the six still marked "inferred" has not met its exit condition.

### Commit

```
docs(design): publish measured frame ceilings for the six recursive tree descents
```

## Part 5 — Structural stacks for the two synthesis walkers

### Context

The two write-surface descents get explicit stacks. Depth costs heap, not frames. This is
also the part that kills the acceptance oracle's two `Exception in PromiseRejectCallback`
lines.

**S1 — `synthesizeLevel`** (`src/application/primitives/synthesize-tree-from-index.ts`, 143
lines). Current shape:
- `MAX_TREE_DEPTH = 4096` module const (`:52`) — **goes**.
- `assertDepthBounded(path)` (`:60-73`) counts slashes and throws
  `treeDepthExceeded(slashCount)` when `slashCount > MAX_TREE_DEPTH`. The **predicate is
  correct and pinned** (`slashCount > cap` is byte-for-byte git's) — only its source
  changes. It is called from `stage0Entries` (`:87`) inside a per-entry loop, so it must
  stay **sync**: `stage0Entries` takes the resolved cap as a parameter.
- `synthesizeLevel(ctx, entries)` (`:119-133`) recurses once per prefix bucket
  (`:129 const subId = await synthesizeLevel(ctx, subEntries);`) and calls
  `writeTree(ctx, treeEntries)` (`:132`). `groupByPrefix` (`:93-112`) already produces the
  trie level by level — the natural iterative shape is a **post-order walk over the prefix
  trie with an explicit stack**: build the trie, then emit sub-trees bottom-up.
- `synthesizeTreeFromIndex(ctx, entries)` (`:140-143`) is the public entry:
  `synthesizeLevel(ctx, stage0Entries(entries))`. **Signature unchanged** — it resolves
  from `ctx` exactly as `write-object.ts:34-43` reads `core.looseCompression`. Adding an
  options object would be a public-surface change bought for nothing.

**S2 — `writeNestedTree`** (`src/application/commands/merge.ts:405`, guard at `:414`,
`MAX_MERGE_TREE_DEPTH = 4096` at `:402`). Same transformation over
`partitionByPrefix` (`:380-400`). Its `depth = 0` third parameter is **internal recursion
state** and disappears with the explicit stack — it is exported for direct unit testing but
is **not** in `reports/api.json`, so no public-surface gate. `MAX_MERGE_TREE_DEPTH` goes.
Its enforcement stays DURING-descent (it currently admits `cap + 1` frames vs S1's `cap`)
— with an explicit stack there is no frame count to differ on, and both must now refuse at
`depth === cap + 1` with the same `depth` payload.

**`merge.ts`'s `Promise.all` fan-out and its equivalent-mutant comment (`:415-425`, the
proof sentence anchored at `:420`).** The
current code resolves sibling subdirs in parallel via `Promise.all` over
`Array.from(subdirs, …)` and carries a documented equivalent-mutant proof: *"swapping
Promise.all for a serial for-await loop produces the same output … a unit-level mutation
test cannot distinguish parallel from serial without timing or call-order
instrumentation"*. **That proof is about the recursive shape and does not survive the
restructure.** Two obligations, no third option: either (a) preserve the level-wise
parallelism over the explicit stack and **re-derive** the proof in full against the new
structure, rewriting the comment; or (b) drop the parallelism and delete the comment.
Carrying the comment across unchanged is forbidden.

**Source-comment repairs owned by this part** (all three are false or headless today):
- `synthesize-tree-from-index.ts:21` — `* - **Path validation**:.7 hoisted segment-level
  validation into` is a **headless sentence** left by a stripped provenance reference.
  Rewrite as prose with **no** phase reference, e.g. *"**Path validation**: segment-level
  validation is hoisted into `parseIndex` (`src/domain/git-index/path-validator.ts`) …"*
  and keep the defence-in-depth paragraph that follows (`:22-29`).
- `synthesize-tree-from-index.ts:30-36` — *"`MAX_TREE_DEPTH` (4096, matching git's canonical
  limit)"* is **false**: git's limit is `core.maxTreeDepth`, default 2048, and it does not
  bind this surface at all (`git write-tree` accepts 4097, 8000, 28000 and its only failure
  is a segfault whose threshold moves with `ulimit -s`). Restate: the bound is
  `core.maxTreeDepth`, default 2048, **read from the repository-local config**, honoured
  unclamped; capping *this* surface at all is a deliberate residual divergence, because
  refusing where git segfaults with a stale 0-byte `index.lock` is strictly better than
  crashing. 4096's real provenance is `MAX_PATH_BYTES = 4096` in
  `src/domain/working-tree-path.ts:5`, a **byte-length** cap — note it or drop the number.
- `synthesize-tree-from-index.ts:114-118` — *"A secondary `depth > MAX_TREE_DEPTH` guard
  would be dead code — the JS call stack would overflow long before it could ever fire"*.
  The observation was **true at cap 4096 and is precisely the bug**: a guard that cannot
  fire is a guard that does not work. Rewrite to state the invariant the shipped design
  establishes (the descent carries its own stack, so the cap is a policy number and the
  refusal is reachable at every configured value).
- `merge.ts:409-414` — two factual errors in one comment: it claims to match
  `synthesizeTreeFromIndex`'s **contract** (it matched the *number*; the two enforce at
  different points), and it names `MAX_FLAT_TREE_ENTRIES` — a **breadth** cap of 1 000 000
  entries — as a depth cap. Rewrite.

**`synthesizeTreeFromIndex` is public and in `reports/api.json`** — this part regenerates it.

**The boundary test that must be rewritten, deliberately.**
`test/unit/application/primitives/synthesize-tree-from-index.test.ts:348-386`
("Given an index path with exactly MAX_TREE_DEPTH slashes" / "Then the depth cap does NOT
reject it (boundary)") currently **documents the overflow as expected behaviour**: it builds
a 4097-segment path, comments that "Synthesis itself recurses 4096 frames deep and overflows
the JS call stack with a plain RangeError", and asserts
`expect(data?.code).not.toBe('TREE_DEPTH_EXCEEDED')`. That is a weak oracle — it passes for
a `RangeError`, an `OBJECT_NOT_FOUND`, or any other failure — and it is the sole source of
the suite's two `Exception in PromiseRejectCallback` lines. Its replacement asserts the
**positive**: at exactly the configured cap, synthesis completes and returns a tree oid whose
contents round-trip through `readObject`. The sibling one-past-cap test (`:314-346`) keeps
its shape and its exact-`depth` assertion — it is already the right test — with its
4096/4097/4098 literals replaced by the small configured cap.

**Test helpers this part adds** to `test/unit/application/primitives/fixtures.ts` (parts 6/7
reuse them):
- `buildTreeChain(ctx, depth): Promise<ObjectId>` — a `depth`-level nested tree chain with
  one leaf blob, written to the memory object store, returning the root oid.
- `deepIndexPath(slashes): string` — a path with exactly `slashes` slashes.

### TDD steps

**RED 1 — the structural bound at the DEFAULT cap. This is the part's real RED, and it is
the only assertion that distinguishes an explicit stack from the recursion.** With config
**unset** (default 2048): `synthesizeTreeFromIndex` on an index whose single entry has
**2048** slashes completes and returns a tree oid that round-trips; on **2049** slashes it
refuses with `TREE_DEPTH_EXCEEDED` and `depth === 2049`. Same pair for `writeNestedTree`.
Fixtures are memory-adapter only (a 2049-slash path is a ~4 KB string; a 2049-link tree
chain is 2049 small objects in memory — not free, not expensive). **Why this is not a
"deepest that works" assertion:** 2048 is the *default cap*, not a measured ceiling, and
after the rewrite there is no ceiling for it to gamble against. Before the rewrite,
`synthesizeLevel`'s ceiling is ~2250 and `writeNestedTree`'s is ~1350, so the
`writeNestedTree` at-cap half fails outright and the `synthesizeTreeFromIndex` refuse-at-2049
half fails outright (today's cap admits 4096). Fails today.

**RED 2 — the small-configured-cap pair, per site.** `core.maxTreeDepth = 4`: at depth 4
completes and round-trips; at depth 5 refuses with `depth === 5`. Two separate tests per
site. Plus the guard-is-reachable case at 20× the cap: `TREE_DEPTH_EXCEEDED` with
`depth === 5`, never larger, never a `RangeError`.

**RED 3 — the cap is read, not guessed.** The same fixture passes at
`core.maxTreeDepth = N` and refuses at `N - 1`, per site.

**RED 4 — the `iterative ≡ recursive` property, per site** (ADR-636 mandates it; this is the
one place in the change where a property test earns its keep). New siblings
`test/unit/application/primitives/synthesize-tree-from-index.properties.test.ts` and
`test/unit/application/commands/merge.properties.test.ts`, with generators in the existing
`test/unit/application/primitives/arbitraries.ts` / `test/unit/application/commands/
arbitraries.ts`. `numRuns` **100** (composition/invariant tier — these build object stores
per case and are not cheap). The oracle is **the pre-change implementation, copied verbatim
into the test file before the rewrite lands** — not re-implemented, not paraphrased, and
never the new code. For these two sites the observable is a single comparable value: *the
tree oid the recursive implementation produced for the same entries*. Property:
`iterative(entries) === recursiveOracle(entries)` over arbitrary flat entry sets with
arbitrary path shapes. Copy the oracle **first**, run the property against the still-recursive
production code to prove the oracle and the generators are sound, then rewrite. `Given`
reads "Given an arbitrary …". Never commit a seed.

**GREEN.** Rewrite `synthesizeLevel` as an iterative post-order over the prefix trie with an
explicit stack; thread the resolved cap into `stage0Entries` → `assertDepthBounded`. Then
`writeNestedTree`, same transformation, resolving from `ctx` and dropping the `depth`
parameter. Delete `MAX_TREE_DEPTH` (`:52`) and `MAX_MERGE_TREE_DEPTH` (`merge.ts:402`).

**REFACTOR.** Apply the four comment repairs above. Re-derive or delete the `Promise.all`
equivalent-mutant proof. Re-read `synthesizeLevel`'s new body against Object Calisthenics:
functions under 20 lines, nesting ≤ 2, no magic values, early returns.

**Regenerate `reports/api.json`** and commit it.

**Verify the acceptance oracle** before committing (see the Gate).

### Gate

```
npx vitest run \
  test/unit/application/primitives/synthesize-tree-from-index.test.ts \
  test/unit/application/primitives/synthesize-tree-from-index.properties.test.ts \
  test/unit/application/commands/merge.test.ts \
  test/unit/application/commands/merge.properties.test.ts \
  test/unit/application/primitives/fixtures.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check \
  src/application/primitives/synthesize-tree-from-index.ts \
  src/application/commands/merge.ts \
  test/unit/application/primitives/fixtures.ts \
  test/unit/application/primitives/synthesize-tree-from-index.test.ts \
  test/unit/application/primitives/synthesize-tree-from-index.properties.test.ts \
  test/unit/application/commands/merge.test.ts \
  test/unit/application/commands/merge.properties.test.ts
```

**Acceptance oracle — part of this gate, run after the above is green:**

```
LOG="$(mktemp)"; npx vitest run --project unit > "$LOG" 2>&1; \
  ! grep -q 'Exception in PromiseRejectCallback' "$LOG"
```

Must exit 0. Baseline at HEAD is **2** matching lines, both from this part's test file.
Redirecting or filtering that stderr anywhere in the product, the test files or the vitest
config to satisfy this is forbidden — the only acceptable fix is removing the overflow.

Plus `npm run docs:json && git diff --exit-code -- reports/api.json` clean after staging.

### Commit

```
fix(primitives): bound tree synthesis with an explicit stack instead of recursion
```

## Part 6 — Structural stack for `walkTree`, `archive`'s restored cap, and the deep-tree interop suite

### Context

The most-referenced walker in the codebase, plus the one site where restoring a cap moves
tsgit **toward** git and git supplies the number, plus the cross-tool suite that proves the
whole of Scope A.

**S4/S5 — `walkTree`** (`src/application/primitives/walk-tree.ts`, 92 lines).
- `walkTree(ctx, treeIdOrObject, options?)` (`:33-50`) builds a `WalkConfig` (`:22-27`:
  `ctx`, `recursive`, `maxDepth`, `maxEntries`) with
  `maxDepth: options?.maxDepth ?? MAX_TREE_WALK_DEPTH` (`:41`) and then
  `yield* walkInternal(config, counter, rootTree, '', 0, [])` (`:49`). It is an
  `async function*`, so `await resolveMaxTreeDepth(ctx)` at `:41` is legal and is the
  once-per-operation resolution point. **`WalkTreeOptions.maxDepth` stays** — only the
  default changes.
- `walkInternal` (`:52-77`) recurses via `yield* walkInternal(...)` (`:74`), one async
  generator frame per level. **Rewrite as an explicit DFS stack inside one flat
  `async function*`**, yielding from the loop instead of `yield*`. Everything else must
  survive verbatim and in the same order: the cycle guard `stack.includes(tree.id)` →
  `treeCycleDetected` (`:60`), the depth guard
  `exceedsMaxTreeDepth(depth, config.maxDepth)` → `treeDepthExceeded(depth)` (`:61`), the
  abort check `config.ctx.signal?.aborted` → `operationAborted()` (`:64`), the path join
  (`:65`), the entry counter and `exceedsMaxTreeEntries` → `treeEntryLimitExceeded`
  (`:67-69`), the **yield-before-descend** order (`:70` then `:71-75`), `shouldRecurse`
  (`:79-84`), and the silent non-tree skip (`:73`). Pre-order, **directory before
  contents**, is a contract.
- **Keep the `ObjectId` cycle stack as it is.** Replacing its `includes()` with a `Set` is a
  separate perf change, explicitly out of scope; the rewrite merely makes it available.
- `MAX_TREE_WALK_DEPTH` (`src/domain/diff/flat-tree.ts:19`) loses its last importer here —
  **delete the constant and its doc comment in this part** (part 3 removed the other two
  importers). Verify with a repo-wide grep that no reference survives.

**S4 — `archive`** (`src/application/commands/archive.ts`, 109 lines).
- `buildEntryStream` (`:95-108`) passes `maxEntries: Number.MAX_SAFE_INTEGER` **and**
  `maxDepth: Number.MAX_SAFE_INTEGER`. **Drop the `maxDepth` key**; keep `maxEntries`.
- The comment at `:96-97` — *"git archive imposes no entry or depth cap — pass
  effectively-unbounded limits so walkTree's diff-oriented defaults never abort a large
  tree"* — is **half false**. The **entry** claim is true and stays: `git archive` does not
  cap entry count, and `MAX_FLAT_TREE_ENTRIES` is a breadth cap this change does not touch.
  The **depth** claim is false: `git archive --format=tar` on a 2049-deep tree exits **128**
  with `error: exceeded maximum allowed tree depth` followed by `fatal: failed to unpack
  tree object <oid>`. Git caps archive's depth exactly like every other traversal. **Split
  the two claims** rather than deleting both.
- `archive.md`'s refusal list gains the new condition in part 10.
- Note: `archive` also gained `assertOperationalRepository` in part 2. Do not re-add it.

**`walkTree` / `WalkTreeOptions` are public and in `reports/api.json`** — this part
regenerates it. `WalkTreeOptions`' TSDoc (in `src/application/primitives/types.ts`) and
`walkTree`'s own doc must state the default bound is `core.maxTreeDepth`, default 2048,
honoured unclamped, **"read from the repository-local config"**.

**Downstream callers that must keep working unchanged** (no signature change, but the
default moves): `src/repository.ts:744`,
`src/application/primitives/materialize-tree.ts:94`,
`build-index-from-tree.ts:70`, `enumerate-push-objects.ts:70`, `walk-submodules.ts:65`,
`snapshot/tree-snapshot.ts:55`, `internal/closure-engine.ts:107`,
`internal/bitmap-binding.ts:181`, `commands/checkout.ts:301`, `commands/notes.ts:159`,
`commands/grep.ts:119`, `commands/archive.ts:97`.

**Existing tests that change.**
- `test/unit/application/commands/archive.test.ts:471-478` — "Given a commit with a tree
  nested 1025 levels deep (beyond walkTree default maxDepth)" / "Then no
  TREE_DEPTH_EXCEEDED is thrown (maxDepth is effectively unbounded)". This test asserts the
  defect. **Invert it**: at a small configured cap, at-cap completes and one-past-cap
  refuses with the exact `depth`. Drop the 1025 fixture.
- `test/unit/application/primitives/walk-tree.test.ts:263-287` — explicit `maxDepth: 1`;
  keeps working, but add the configured-cap pair beside it.
- `test/unit/application/primitives/snapshot/tree-snapshot.mutation.test.ts:170-191` —
  forwards `maxDepth: 0` explicitly; unaffected, but re-run it.

**The deep-tree interop suite — new `test/integration/tree-depth-interop.test.ts`.** This is
where every pinned row of the faithfulness matrix that needs a **deep** fixture lands. It is
created in this part because this is the first point at which `walkTree`, `archive` and
`synthesizeTreeFromIndex` are all structurally bounded and config-driven.

House shape: `@proves` header (`surface`, `bucket: cross-tool-interop`, `unique`,
`interopSurface`), `describe.skipIf(!GIT_AVAILABLE)`, **one shared `beforeAll` repo,
`beforeAll(fn, 60_000)`**, helpers from `./interop-helpers.js`. **Every deep fixture is
built path-as-data**: `git update-index --add --cacheinfo 100644,<blobOid>,<a/×D + f>` then
`git write-tree`. Nothing deep is ever materialised on disk.

| Row | Assertion |
|---|---|
| Pin 2 / R4–R5 | One tree at D=2048 and one at D=2049. `git ls-tree -r` exits **0** on the first, **1** on the second. tsgit's `walkTree` matches the split exactly — same number, same predicate. No divergence clause. |
| W2 / W4 | `git write-tree` exits **0** on the D=2049 index and on far deeper ones — the synthesis surface has **no** git counterpart. This is the entire evidential basis for the one residual divergence tsgit keeps (`synthesizeTreeFromIndex` / `writeNestedTree` cap a surface git leaves unbounded). Assert it; do not assume it. |
| **R9** | `git archive --format=tar` of the D=2049 tree exits **128**. tsgit's `archive` must refuse too. **This assertion fails on `main`** — today tsgit's `archive` has no depth refusal at any input — and it is the single most valuable test in Scope A. |
| R13 | `git fsck --strict` exits **0** on a repo containing the D=2049 tree. tsgit's `fsck` must **not** grow a depth check for symmetry. A negative assertion; cheap; forecloses a plausible wrong "fix". |
| C1 / C2 / C3 | `-c core.maxTreeDepth=4096` refuses D=4097; `=4097` accepts it; `=100000` accepts it. tsgit **follows** in all three, including C3's 100000. |
| Pin 4 (representative) | `2.5` refuses in both tools; `1k` accepted, calibrated at D=1024 (accept) / D=1025 (refuse) in both. tsgit matches the **refusal condition**, not git's stderr bytes, and not the all-lowercase key spelling git quotes back. |
| Pin 5 (Z-rows) | `core.maxTreeDepth=0` accepts a depth-0 tree and refuses a depth-1 one in both tools. **Two tests**, one per condition. |
| Pin 6 / P-7 (the published divergence) | The same value in a throwaway `GIT_CONFIG_GLOBAL` **moves git's boundary** and leaves tsgit's **unmoved** — because tsgit reads local scope only. A divergence that is documented gets a test, not a gap in the matrix. |

**Perf obligation — `walkTree` is a hot path and this part must budget for measuring it.**
It sits under `log`, `status`, `diff`, `archive` and `walkSubmodules`, all of which are in
`docs/perf/hot-paths.json` and gated by `benchmark-compare`. The mechanism suggests the
rewrite is a **win**: `yield*` delegation in async generators does not flatten, so a value
yielded at depth *d* is re-yielded through all *d* enclosing generators — O(entries × d)
where an explicit stack is O(entries). **That is a hypothesis with a mechanism, not a
measurement.** Settle it the way this repo settles perf claims: an **absolute wall-clock
`main`-vs-branch A/B on one machine**, both sides on the **same** Node major (part 9 moves
CI's default 22 → 24 on merge, so a number read across that step is not comparable), never a
self-share percentage — that framing has misled this project before. The citable number comes
from the CI nightly artifact, never a local run. Record the number in the commit body or the
PR, not in a doc, and **do not assert it anywhere**. If the A/B comes back neutral-or-worse
the rewrite still stands on the correctness argument alone; suppressing the number is not an
option. Also measure the new **one `readConfig` per operation**: it is a `WeakMap` hit after
the first call per `Context`, so the expectation is noise-level — but `log` and `status`
resolve it on every invocation, and "expected to be free" is how the last regression got in.

**Four traps this file must dodge:** (1) never build a deep path on disk — darwin's
`PATH_MAX` of 1024 kills a real checkout at depth ~471, long before git's own 2048; (2) on a
real deep worktree git **warns and silently skips** at exit 0, so no assertion may read
"git exited 0" as "git accepted the path"; (3) `runGitEnv()` scrubs `GIT_*` and `-C <path>`
does **not** override an inherited `GIT_DIR` — and `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0` **do**
override this key, so a leak silently changes the value under test; (4) the user's global
git config is not the test's — every config row goes through `-c` or a throwaway file.
**And one more:** after git writes the trees, build a **fresh** `Context` before driving
tsgit.

### TDD steps

**RED 1 — the structural bound at the DEFAULT cap (the part's real RED).** Config unset:
`walkTree` over a 2048-deep tree chain yields the leaf; over a 2049-deep chain it refuses
with `TREE_DEPTH_EXCEEDED` and `depth === 2049`. Memory adapter,
`buildTreeChain(ctx, depth)` from part 5's fixtures. Fails today: the default is 1024, so
the at-cap half refuses at 1025.

**RED 2 — `archive` gains a refusal it has at no input today.** Small configured cap:
at-cap completes; one-past-cap throws `TREE_DEPTH_EXCEEDED` with the exact `depth`. Two
separate tests. Fails today: `maxDepth: Number.MAX_SAFE_INTEGER`.

**RED 3 — the small-configured-cap pair + guard-reachability + cap-is-read triple for
`walkTree`**, exactly as part 3's RED 1–3.

**RED 4 — `iterative ≡ recursive` for `walkTree`.** New
`test/unit/application/primitives/walk-tree.properties.test.ts`, generators in
`test/unit/application/primitives/arbitraries.ts`. `numRuns` **100**. The oracle is the
pre-change `walkInternal`, **copied verbatim into the test file before the rewrite lands**.
Property: over arbitrary generated tree shapes (varying breadth, depth, mixed
blob/tree/gitlink entries, duplicate oids for the shared-subtree case), the iterative walk
yields **exactly** the sequence the recursive one yielded — same paths, same oids, same
modes, same **order** (pre-order, directory before contents). Copy the oracle first, run the
property green against the still-recursive code to prove the oracle and generators are
sound, then rewrite. `Given` reads "Given an arbitrary tree shape". Never commit a seed.

**RED 5 — the interop suite.** Write `test/integration/tree-depth-interop.test.ts` with
every row in the table above. R9 is expected to be the one that fails first; C1–C3 and
Pin 5 fail until `walkTree` reads the config. Build the D=2048/2049/4097/1024/1025 fixtures
once in the shared `beforeAll`.

**GREEN.** Rewrite `walkInternal` as an explicit DFS stack. Resolve the cap once in
`walkTree`. Drop `archive`'s `maxDepth` override. Delete `MAX_TREE_WALK_DEPTH`.

**REFACTOR.** Split `archive.ts:96-97`'s comment into its true entry half and a corrected
depth sentence. Rewrite `walkTree`'s and `WalkTreeOptions`' TSDoc with the
"read from the repository-local config" wording. Re-read the new `walkInternal` for guard
ordering against the pre-change source line by line — an out-of-order abort check or a
descend-before-yield is a silent contract break the property test may not catch if the
generator never produces the discriminating shape.

**Regenerate `reports/api.json`** and commit it.

### Gate

```
npx vitest run \
  test/unit/application/primitives/walk-tree.test.ts \
  test/unit/application/primitives/walk-tree.properties.test.ts \
  test/unit/application/primitives/snapshot/tree-snapshot.mutation.test.ts \
  test/unit/application/commands/archive.test.ts \
  test/unit/application/commands/checkout.test.ts \
  test/unit/application/commands/grep.test.ts \
  test/unit/application/commands/notes.test.ts \
  test/unit/application/primitives/walk-submodules.test.ts \
  test/unit/application/primitives/materialize-tree.test.ts \
  test/unit/application/primitives/build-index-from-tree.test.ts \
  test/integration/tree-depth-interop.test.ts \
  test/integration/archive-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check \
  src/application/primitives/walk-tree.ts \
  src/application/primitives/types.ts \
  src/application/commands/archive.ts \
  src/domain/diff/flat-tree.ts \
  test/unit/application/primitives/walk-tree.test.ts \
  test/unit/application/primitives/walk-tree.properties.test.ts \
  test/unit/application/primitives/arbitraries.ts \
  test/unit/application/commands/archive.test.ts \
  test/integration/tree-depth-interop.test.ts
```

Plus `npm run docs:json && git diff --exit-code -- reports/api.json` clean after staging.

### Commit

```
fix(primitives): walk trees with an explicit stack and restore archive's depth cap
```

## Part 7 — Structural stack for `walkWorkingTree`

### Context

The worst measured shape in the inventory (~925 frames, cap 4096 — a 4.4× overrun) and the
only one where two mutually-recursive async generators collapse into one loop. It sits under
`status`, `add` and `stash`.

**S3 — `walkWorkingTree`** (`src/application/primitives/walk-working-tree.ts`, 167 lines).
- `DEFAULT_MAX_DEPTH = 4096` (`:14`) — **goes**, replaced by
  `await resolveMaxTreeDepth(ctx)` at `:56` (`maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH`).
  `walkWorkingTree` is an `async function*` (`:50-63`), so the resolution point is legal and
  is once per operation. `WalkWorkingTreeOptions.maxDepth` stays.
- `walkInternal` (`:65-85`) and `visitEntry` (`:87-124`) are **mutually recursive**:
  `walkInternal` calls `yield* visitEntry(...)` (`:83`) per entry, and `visitEntry` calls
  `yield* walkInternal(...)` (`:108`) for a directory. **Two `yield*` frames per level** —
  which is why this site's ceiling is the lowest in the inventory. Collapse both into one
  flat `async function*` driving an explicit DFS stack.
- **Everything below must survive verbatim, in the same order:** the depth guard
  `if (depth > config.maxDepth) throw treeDepthExceeded(depth)` (`:72`) — note it uses the
  bare `>` rather than `exceedsMaxTreeDepth`; keep the predicate identical either way; the
  `readdir` on `directoryPath(config, prefix)` (`:73`); the **embedded-repo gate**
  `if (!isRoot && entries.some(isEmbeddedGitMarker)) return;` (`:79`) with its `isRoot`
  distinction — the host repository's own `.git` is NOT an embedded-repo marker, so at the
  workDir root only the `.git` entry itself is skipped, never the workDir; the abort check
  (`:81`); `isDotGitWalkEntry(entry.name)` skip (`:82`); `validateWalkedEntryPath(path)`
  (`:105`); the directory branch's `ignore` predicate call **before** descending (`:107`)
  and the file branch's **after** the kind check (`:112`); the
  `!entry.isFile && !entry.isSymbolicLink` drop (`:111`); the counter and
  `treeEntryLimitExceeded` (`:113-116`); and **`lazyStat(config, path)`** (`:135-141`) — the
  per-entry memoised, `.catch()`-free stat accessor, which must be constructed per yielded
  entry exactly as today, carrying `WorkingTreeStatMap` short-circuiting through
  `fetchStat` (`:143-149`).
- Pre-order, directory-before-contents is a contract; a symlink to a directory is a **leaf**,
  never descended into.

**`walkWorkingTree` / `WalkWorkingTreeOptions` are public and in `reports/api.json`** — this
part regenerates it. Their TSDoc gains the `core.maxTreeDepth` / default-2048 /
**"read from the repository-local config"** wording. Note the existing doc block at `:28-49`
is long and accurate about `.git` handling — extend it, do not replace it.

**One divergence that is named and deliberately NOT fixed.** On a genuinely deep real
worktree, git **warns** `File name too long` and **silently stages nothing** at exit 0, where
tsgit throws `TREE_DEPTH_EXCEEDED`. That predates this change; matching it would mean
adopting "silently see nothing" as a contract. Do not add an interop assertion that reads
"git exited 0" as "git accepted the path".

**A downstream equivalent-mutant comment to re-check, not to rewrite blindly.**
`src/adapters/snapshot-resolvers/fs-workdir-enumerator.ts:63-73` carries
*"replacing these `... === undefined ? {} : {...}` conditional spreads … is observably
equivalent because `walkWorkingTree` itself defaults every undefined option via
`options?.X ?? DEFAULT`"*. The premise survives structurally (undefined still routes to the
default), but the default is now a resolver call rather than a literal. Re-read the proof
and confirm it still holds verbatim; if the wording implies a *constant* default, correct
the wording. **This file is in `src/adapters/` — 100 % coverage applies**; its test is
`test/unit/adapters/snapshot-resolvers/fs-workdir-enumerator.mutation.test.ts` (the
`maxDepth: 1` forwarding case at `:177-197` must stay green).

**Perf obligation — `walkWorkingTree` is `status`'s hot path.** Same discipline as part 6:
an absolute wall-clock `main`-vs-branch A/B on one machine, both sides on the same Node
major, citable number from the CI nightly artifact, never a self-share percentage, never
asserted in a test or a doc. This site has the strongest mechanical case of the four —
**two** `yield*` frames per level today, so the bubbling cost it removes is doubled — but it
is still a hypothesis until the A/B lands, and a neutral-or-worse result does not undo the
correctness argument.

**Test helper this part adds** to `test/unit/application/primitives/fixtures.ts`:
`seedDeepWorkingTree(ctx, depth): Promise<void>` — creates `depth` nested directories under
`ctx.layout.workDir` in the **memory** adapter with one leaf file at the bottom.
`createMemoryContext()` has no path-length limit, so the same fixture runs identically on
linux, macOS and Windows. A `walkWorkingTree` at-cap test against the **node** adapter would
fail on the filesystem long before it reached the default cap — it would be measuring
`File name too long`, not the guard. **Never** create real deep directories.

### TDD steps

**RED 1 — the structural bound at the DEFAULT cap (the part's real RED).** Config unset:
`walkWorkingTree` over a **2048**-deep memory working tree yields the leaf; over a **2049**-deep
one it refuses with `TREE_DEPTH_EXCEEDED` and `depth === 2049`. Fails today with a raw
`RangeError` around depth ~925 — which is exactly what this part removes. Two separate tests.
(Rationale, so a reviewer does not flag it as a ceiling-dependent test: 2048 is the *default
cap*, not a measured ceiling; after the rewrite there is no ceiling for it to gamble against,
and ADR-636's consequences name "at exactly the cap, the operation completes" as the property
that becomes testable on all three OSes.)

**RED 2 — the small-configured-cap pair, guard-reachability, and cap-is-read**, exactly as
part 3's RED 1–3, at `core.maxTreeDepth = 4` / `= 3`.

**RED 3 — `iterative ≡ recursive`.** New
`test/unit/application/primitives/walk-working-tree.properties.test.ts`, generators in
`test/unit/application/primitives/arbitraries.ts`. `numRuns` **100**. Oracle = the
pre-change `walkInternal`/`visitEntry` pair, **copied verbatim into the test file before the
rewrite lands**. Generated shapes must include, or the property proves less than it looks:
nested directories of varying breadth and depth; a `.git` directory at the root **and** at a
non-root level (the embedded-repo gate); a `.git` **file** at a non-root level; a symlink to
a directory; a non-file non-symlink entry; an `ignore` predicate that returns true for some
directories and some files. Copy the oracle first, run green against the still-recursive
code, then rewrite. Never commit a seed.

**RED 4 — the embedded-repo gate is the one to break by accident. Isolated tests, not
folded into the property.** (a) A non-root directory containing a `.git` **directory**
yields nothing under it, while its siblings still yield. (b) The **root**'s own `.git` is
skipped as an entry but does not collapse the workDir. (c) A `.git` **regular file** at a
non-root level is a marker; (d) a `.git` **symlink** is **not** — treating a stray `.git`
symlink as a marker would let an attacker silently hide siblings. Four conditions, four
tests: one test tripping several proves none.

**GREEN.** Collapse `walkInternal` + `visitEntry` into one flat `async function*` with an
explicit DFS stack; resolve the cap once in `walkWorkingTree`; delete `DEFAULT_MAX_DEPTH`.
Preserve `lazyStat`'s per-entry closure construction exactly — a stat accessor hoisted out
of the per-entry path or given a `.catch()` is a behaviour change.

**REFACTOR.** Extend the module TSDoc. Re-read the new loop against the pre-change source
guard by guard. Re-check `fs-workdir-enumerator.ts`'s equivalent-mutant wording.

**Regenerate `reports/api.json`** and commit it.

**Verify the acceptance oracle** again (see the Gate) — this is the last `src/` change of
Scope A's structural work, so the zero-line property must hold here and stay held.

### Gate

```
npx vitest run \
  test/unit/application/primitives/walk-working-tree.test.ts \
  test/unit/application/primitives/walk-working-tree.properties.test.ts \
  test/unit/adapters/snapshot-resolvers/fs-workdir-enumerator.mutation.test.ts \
  test/unit/application/commands/status.test.ts \
  test/unit/application/commands/add.test.ts \
  test/unit/application/commands/stash.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check \
  src/application/primitives/walk-working-tree.ts \
  src/application/primitives/types.ts \
  src/adapters/snapshot-resolvers/fs-workdir-enumerator.ts \
  test/unit/application/primitives/fixtures.ts \
  test/unit/application/primitives/walk-working-tree.test.ts \
  test/unit/application/primitives/walk-working-tree.properties.test.ts \
  test/unit/application/primitives/arbitraries.ts
```

**Acceptance oracle:**

```
LOG="$(mktemp)"; npx vitest run --project unit > "$LOG" 2>&1; \
  ! grep -q 'Exception in PromiseRejectCallback' "$LOG"
```

Plus `npm run docs:json && git diff --exit-code -- reports/api.json` clean after staging.

### Commit

```
fix(primitives): walk the working tree with an explicit stack instead of recursion
```

## Part 8 — Discharge the §A12 verdicts on the six recursive sites

### Context

**Scope is decided by part 4's published verdicts.** Read
`docs/design/depth-caps-and-node-aliases.md` §A2.1 and §A12's Results subsection **first** —
they are this part's specification. Do not re-measure and do not re-derive the threshold
(a site "holds" at a measured ceiling ≥ **4096**, i.e. 2× the 2048 default).

**Branch A — sites that HELD.** Each keeps its recursion and gains the asymmetry as a
**written invariant in its module doc**: *this descent honours `core.maxTreeDepth` up to N
and refuses beyond it by exhausting frames, not by policy* — carrying the measured number
and the date of the measurement. No provenance reference, no ADR number, no `§` — the
sentence must stand on its own. The files, one doc block each:
- `src/application/primitives/internal/flatten-raw.ts` (module doc at `:1-15`)
- `src/application/primitives/diff-trees.ts` (`diffChangedSubtree`'s doc / the module head)
- `src/application/primitives/enumerate-bundle-objects.ts` (`collectTreeObjects` /
  `emitTreeObjects`)
- `src/application/primitives/internal/closure-not-marks.ts` (`markTree`'s doc at `:44`)
- `src/application/primitives/internal/walk-raw-subtree.ts` (module doc at `:1-34`, whose
  existing paragraph already argues why this walker is a deliberate sibling of
  `flatten-raw`'s rather than a shared walker — extend it, do not replace it)

**Branch B — sites that did NOT hold.** Each joins the structural rewrite. The
transformation is identical to parts 5/6 — explicit stack, guards preserved verbatim and in
order — and those parts are the template. Each rewritten site additionally brings:
- an `iterative ≡ recursive` property test (`<site>.properties.test.ts` beside the example
  test, generators in the directory's `arbitraries.ts`, `numRuns` **100**, oracle = the
  pre-change implementation copied verbatim **before** the rewrite lands);
- **re-derivation of every carried equivalent-mutant proof on that site.** A proof about a
  recursive shape is not a proof about its iterative replacement, and this repo has been
  bitten by carrying one across a data-structure migration before. The two sites on the raw
  cursor path are the expensive ones; `enumerate-bundle-objects.ts` carries several
  `// Stryker disable next-line ConditionalExpression: equivalent — …` annotations at
  `:87`, `:93`, `:97`, `:119`, `:123`, `:126` plus `// equivalent-mutant:` prose, and
  `closure-not-marks.ts` carries one at `:55`. **Its second annotation, at `:94`, is on the
  commit-ancestry cut-off, not on `markTree`'s descent — leave it alone.** For each: re-prove against the new structure
  and rewrite the proof, or delete the annotation and let the mutant be killed by a test.
  Carrying one across unchanged is forbidden.

**Both branches, always:** this part changes no public signature and touches no symbol in
`reports/api.json` (verified: `flattenRawTree`, `walkRawSubtree`, `enumerateBundleObjects`,
`markNotSide`, `MAX_TREE_WALK_DEPTH`, `MAX_MERGE_TREE_DEPTH` are all absent from the report;
`diffTrees` is present but its TSDoc was already settled in part 3 — if branch B forces a
`diffTrees` doc edit, regenerate `reports/api.json` in this part too).

**If part 4 reported four or more sites below threshold**, the session was already escalated
per the plan's ordering section and has chosen a shape. Follow that choice; do not
re-litigate it here.

**Perf obligation for branch B on the raw cursor path.** `flattenLevel` and `walkLevel` sit
under `diff` and `status`. If either is rewritten, the perf claim is settled the way this
repo settles perf claims: an **absolute wall-clock `main`-vs-branch A/B on one machine**, one
Node major on both sides, never a self-share percentage, with the citable number taken from
the CI nightly artifact. If the A/B comes back neutral-or-worse the rewrite still stands on
the correctness argument alone — record the number, do not suppress it.

### TDD steps

**Branch A (a site that held) — the discipline is falsifiability, not RED/GREEN.** The
invariant sentence must name a number that part 4 actually measured. Before writing it,
re-read the §A2.1 row and copy the number and date from there. A sentence claiming a number
part 4 did not publish is worse than no sentence. No test changes.

**Branch B (a site that did not hold):**

**RED 1 — the structural bound at a cap above the site's measured ceiling.** Config set to a
cap comfortably above the ceiling part 4 published for that site (e.g. ceiling 1400 ⇒ cap
4096): a fixture at depth `ceiling + 500` completes, and one at `cap + 1` refuses with
`TREE_DEPTH_EXCEEDED` and the exact `depth`. Fails today with a raw `RangeError`. Two
separate tests. Use the measured number from §A2.1 to choose the fixture depth — that is the
only place in the test suite where a measured ceiling may inform a fixture size, and it
informs the **fixture**, never an **assertion**.

**RED 2 — `iterative ≡ recursive`** for that site, oracle copied verbatim before the
rewrite, `numRuns` 100, per the property-test conventions. For `walkLevel` the observable is
the **emitted entry sequence** (`emit` callback order, duplicates included — this walker
deliberately does NOT de-duplicate, matching `git diff-tree -r`); for `flattenLevel` it is
the resulting `Map` **and** its insertion order; for `collectTreeObjects`/`emitTreeObjects`
and `markTree` it is the final object `Set` (and, for `emitTreeObjects`, the emission order
through `tryEmit`).

**RED 3 — the small-configured-cap pair, guard-reachability and cap-is-read** already exist
for all six from part 3. Re-run them; they must stay green through the rewrite unchanged.
If any needs editing to pass, the rewrite changed behaviour — stop and diagnose rather than
adjusting the test.

**GREEN.** One site at a time, committing nothing until the whole part is green.

**REFACTOR.** Re-prove or delete every equivalent-mutant annotation on each rewritten site.
Re-read each new loop against its pre-change source guard by guard.

### Gate

```
npx vitest run \
  test/unit/application/primitives/internal/flatten-raw.test.ts \
  test/unit/application/primitives/internal/walk-raw-subtree.test.ts \
  test/unit/application/primitives/internal/closure-engine.test.ts \
  test/unit/application/primitives/diff-trees.test.ts \
  test/unit/application/primitives/enumerate-bundle-objects.test.ts \
  test/unit/application/primitives/flatten-tree.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check \
  src/application/primitives/internal/flatten-raw.ts \
  src/application/primitives/internal/walk-raw-subtree.ts \
  src/application/primitives/internal/closure-not-marks.ts \
  src/application/primitives/diff-trees.ts \
  src/application/primitives/enumerate-bundle-objects.ts
```

Add each branch-B site's new `*.properties.test.ts` to the vitest list and its
`arbitraries.ts` to the biome list. If branch B applies to any site, also run the acceptance
oracle:

```
LOG="$(mktemp)"; npx vitest run --project unit > "$LOG" 2>&1; \
  ! grep -q 'Exception in PromiseRejectCallback' "$LOG"
```

### Commit

Branch A only (every site held):
```
docs(primitives): record the measured frame bound on the six recursive tree descents
```
Any branch B site rewritten:
```
fix(primitives): bound the remaining recursive tree descents with explicit stacks
```

## Part 9 — Scope B: CI tracks Node release lines by alias

### Context

Independent of Scope A — shares no source file. `.github/` plus the benchmark-snapshot
writer; **no `src/` delta**, which is what makes it legitimately standalone.

**Alias semantics, read off `actions/setup-node@v7`'s own source at tag `v7.0.0`
(`src/distributions/official_builds/official_builds.ts`, `resolveLtsAliasFromManifest`) —
not from memory.** An alias resolves to a bare **MAJOR** string
(`release.version.split('.')[0]`), which is then resolved as an ordinary semver spec against
`actions/node-versions`' `versions-manifest.json` filtered to `lts && stable === true`. An
unresolvable alias **throws**; it does not fall back. Resolved as of 2026-08-15:
`lts/-1` → **22** (Jod), `lts/*` → **24** (Krypton), `lts/-2` → 20 (below the engines floor),
`latest`/`current`/`node` → **26.7.0** (`lts: false`). So `['lts/-1','lts/*']` is
**byte-equivalent to today's `[22, 24]`** and self-rolling. `*` and `latest` are **not**
synonyms: `*` is tool-cache-biased; `latest`/`current`/`node` resolve from the **dist**
endpoint, so they miss the runner tool cache and carry download / rate-limit exposure.

**The six edits.**

| # | Site | Current | Change |
|---|---|---|---|
| P1 | `.github/actions/setup/action.yml:4-8` | `inputs.node-version.default: "22"` | → **`lts/*`**. 27 of 28 composite call sites inherit it, so all 27 move 22 → 24 **on merge**. |
| P2 | `.github/workflows/ci.yml:238` | `node: [22, 24]` | → `node: ['lts/-1', 'lts/*', 'latest']`, three OSes, nine cells, `fail-fast: false` already set, **no `continue-on-error` on any cell**. |
| P3 | `.github/workflows/ci.yml:555-566` (`benchmark-compare`; the bypass rationale comment sits at `:555-559`) | bare `actions/setup-node@v7`, `node-version: "22"` | alias the **value only**. **Keep** the composite bypass and `cache-dependency-path` — the composite runs `npm ci` with no `working-directory:` and this job has no root `package.json`, only `base/` and `head/`. |
| P4 | `.github/workflows/npm-service.yml:36-40` (value at `:38`) | bare `actions/setup-node@v7`, `node-version: 24` | → **`lts/*`**. Rewrite the comment at `:27-35` from *"we pin 24 to get npm 11"* to *"the npm ≥ 11 floor is why this can never go below the current LTS"*. **Add no npm upgrade step** — upgrading npm in place self-corrupts the runner tool-cache install (`MODULE_NOT_FOUND promise-retry`), which is why the pin existed. |
| P5 | `.github/workflows/ci.yml:257` | `if: always() && matrix.os == 'ubuntu-latest' && matrix.node == 22` | Not a version pin — a **comparison literal**. Under aliases it is permanently false and the coverage artifact is **never uploaded**, silently. Re-anchor on an `include:` flag: one matrix cell carries `coverage: true`, and the condition gates on `matrix.coverage == true`. |
| P6 | `.github/workflows/ci.yml:259` | `name: coverage-report-${{ matrix.os }}-node${{ matrix.node }}` | Renders `/` (from `lts/-1`) or `*` (from `lts/*`), both in `upload-artifact`'s rejected-character set — a hard error, masked today only because P5 guarantees the step never runs. → `coverage-report-${{ matrix.os }}`, coupled to no version literal, so the artifact URL stops moving at every LTS transition and the trap is not rearmed at the next matrix change. |

**P7 — `.nvmrc`** (repo root, contains `22`) is referenced by **no** workflow. **Out of
scope**; noted so it is not mistaken for a live pin. Do not wire it via `node-version-file:`
— whether `setup-node@v7`'s file parser accepts alias syntax was never verified.

**The matrix comment (`ci.yml:235-236`, immediately above `os:` at `:237` and `node:` at
`:238`), rewritten not deleted.** Current:
```yaml
        # Node 20 dropped: cspell@10 + lint-staged@17 require >=22.18 /
        # >=22.22.1; the engines floor matches.
```
Replacement keeps the historical fact, relocates the authority, and names the mechanism:
```yaml
        # Release-line aliases, not pinned majors: lts/-1 and lts/* track the
        # two current LTS lines and roll forward on their own; `latest` is the
        # Current line, kept as early warning.
        # The real floor is package.json `engines.node` (>=22.22.1, forced by
        # `engine-strict=true` in .npmrc): a line below it fails `npm ci`
        # rather than testing on an unsupported runtime. That floor is what
        # dropped Node 20 — cspell@10 and lint-staged@17 need >=22.18 and
        # >=22.22.1.
```

**§B9 — the snapshot metadata, which is work in this change, not a note.** Under `lts/*` the
nightly's runtime steps 22 → 24 **on merge**, and every number in the `gh-pages` series
steps underneath a continuous graph with an empty diff and no PR to attribute it to. Those
are the citable numbers. Three pieces must meet:
1. `.github/actions/setup/action.yml` gains an `outputs:` block re-exporting
   `actions/setup-node`'s resolved version. It declares **none** today, which is why the
   value is unavailable to any caller. Give the `actions/setup-node@v7` step an `id:` and
   wire `outputs.node-version.value: ${{ steps.<id>.outputs.node-version }}`.
2. `benchmark-snapshot` (`ci.yml:480-505`) and `bench.yml` (the `- uses:
   ./.github/actions/setup` step) give the composite step an `id:` and pass its output into
   the snapshot writer as an env var.
3. `tooling/bench-to-snapshot.ts` records it. `toSnapshotEntries(raw)` (`:44-53`) currently
   emits `{ name, unit: 'ms', value }`. `github-action-benchmark`'s
   `customSmallerIsBetter` schema also accepts an optional `extra` string per entry — put
   the **resolved** version there (never the alias, which is constant and therefore useless
   as a discriminator).
   **Make the by-eye check mechanical:** the writer **fails** (non-zero exit, message on
   stderr) when the resolved-version env var is absent, empty, or still alias-shaped
   (contains `/` or `*`). A green CI run does not otherwise prove the metadata is populated,
   and an empty or literal-alias value would pass CI and defeat the whole mitigation.
   `tooling/test/unit/bench-to-snapshot.test.ts` is the existing test file; extend it.

**`gh-pages` is benchmark data, not a website** — an orphan series branch. Nothing here
deletes or rewrites history on it; the change is additive metadata on **new records only**.

**Branch protection — verified live, no action needed.** The legacy protection API returns
404; all enforcement is ruleset `16502004`, whose `required_status_checks` is exactly one
context, `build`. `build` (`ci.yml:209`) has no matrix, so its check name is the stable
literal `build`. Renaming `unit-tests (ubuntu-latest, 22)` to
`unit-tests (ubuntu-latest, lts/-1)` **cannot** break branch protection. The same fact means
the whole unit-test matrix is **advisory at the ruleset level**: `latest` is blocking in the
*workflow* sense (no `continue-on-error`, the cell goes red and the job fails) but not in the
*ruleset* sense. That is a loud red mark and a social contract, not an enforcement gate — and
it is exactly why getting P5 right matters: a silently disabled coverage upload would not
block a merge.

**Doc sweep owned by this part:** `RUNBOOK.md:134` reads *"**Unit Tests** — Matrix:
Ubuntu/macOS/Windows × Node 22/24 (Windows re-added in Phase 14.4)"* — update it to the
alias triple. **Do NOT rewrite** `docs/adr/103-*.md`, `docs/adr/048-*.md` or
`docs/design/phase-14-4-windows-support.md`: ADRs and shipped design docs are dated
historical records, and rewriting them to match today's matrix would falsify the record.
`docs/BACKLOG.md` belongs to the docs phase, not to this plan.

**`--experimental-strip-types` on the `latest` cell — established, not deferred.** Traced
through `package.json`'s wireit graph: `unit-tests` runs `test:coverage` (ubuntu) or
`test:unit` (others), both depending only on `check:types` (`tsc --noEmit`). None uses the
flag. The 16 scripts that do are `bench:*`, `profile`, `build:js`'s `truthful-dts` step, the
parity bundle, the Stryker runners, `bench-summarize`, and five `audit-*`/`check-*` tooling
scripts; the two workflow uses are `ci.yml:495` (`benchmark-snapshot`) and `ci.yml:638`
(`benchmark-compare`). **None runs in `unit-tests`, and `unit-tests` is the only job with a
`latest` cell.** So the flag cannot make the `latest` cell red. A red `latest` cell means a
genuine Node 26 incompatibility in `vitest`, `tsc` or the library — or a dist-endpoint
download failure — and should be read as such.

### TDD steps

Workflow YAML has no test tier; the honest equivalent is a mechanical negative check plus a
real test for the one piece of TypeScript this part touches.

**RED 1 — the snapshot writer refuses a missing or alias-shaped version.** In
`tooling/test/unit/bench-to-snapshot.test.ts`, three isolated cases (guard-clause rule):
env var **absent** → refusal; env var **empty string** → refusal; env var containing `*`
(and a second case containing `/`) → refusal. Assert the refusal's message content, not just
that it threw. Fails: no such guard exists.

**RED 2 — a resolved version reaches every entry.** `toSnapshotEntries` with a resolved
version of e.g. `24.19.0` puts it on **every** emitted entry's `extra`, for a multi-group,
multi-benchmark raw report. Assert the exact string on each entry, and assert the existing
`{ name, unit, value }` fields are byte-unchanged so the schema `github-action-benchmark`
consumes is not disturbed.

**GREEN.** Apply P1–P6, the matrix comment, the composite `outputs:` block, the two workflow
wirings, the writer change, and the `RUNBOOK.md` line.

**REFACTOR / mechanical verification (this is the part's real oracle):**
```
grep -RnE 'node-version:[[:space:]]*["'"'"']?(1[0-9]|2[0-9])' .github/
grep -RnE 'matrix\.node[[:space:]]*==[[:space:]]*[0-9]' .github/
grep -RnE 'node[[:space:]]*:[[:space:]]*\[[[:space:]]*[0-9]' .github/
```
All three must return **nothing**. No hardcoded Node major may remain in `.github/` as a
`node-version` value or as a matrix element — **with no carve-out**; `npm-service.yml` is
aliased too. Remaining `20`/`22`/`24` occurrences in `.github/` must be prose in comments
only; read each hit to confirm.

**Four things to check by eye on this PR's own CI run** (nothing asserts them; `.github/`
counts as code, so the full nine-cell matrix runs on the change that introduces it):
1. the resolved versions in each cell's setup-node log match `lts/-1`→22, `lts/*`→24,
   `latest`→26;
2. the coverage artifact **exists** and its name is well-formed — nothing turns red if it
   does not, because only `build` is a required check;
3. `benchmark-compare`'s two trees both installed — that job is `continue-on-error: true`,
   so a Node mistake there fails **quietly** and would silently run both sides of the
   benchmark on a different major from the rest of CI;
4. the benchmark snapshot record carries a **populated, non-alias** resolved-version field.
   RED 1 makes this mechanical, so a green run now does prove it — but confirm the value in
   the artifact once.

And one to **read** rather than check: the `latest` cell's verdict.

### Gate

```
npx vitest run tooling/test/unit/bench-to-snapshot.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check \
  tooling/bench-to-snapshot.ts \
  tooling/test/unit/bench-to-snapshot.test.ts
```

Plus the three `grep` negatives above returning nothing, and
`npm run check:spelling` (the rewritten comments and `RUNBOOK.md` are new prose).
Note: biome's `files.includes` is a **whitelist** — if `tooling/bench-to-snapshot.ts` is not
already in it, the biome leg silently passes without linting the file; confirm the path is
covered rather than assuming.

### Commit

```
ci: track Node release lines by alias and stamp the resolved version on benchmarks
```

## Part 10 — Documentation sweep

### Context

**Docs-only part — no `src/` and no `test/` delta.** Every source comment and TSDoc repair
already landed in its owning part (5, 6, 7); what remains is the **published** surface. This
is plan work, not a docs-phase discovery, because the behaviour change reaches published
docs in six places and two of them are rows that are **not about this feature** and would
otherwise silently go stale.

**1. `docs/use/errors.md:111` — the `TREE_DEPTH_EXCEEDED` row.** Currently:
`` | `TREE_DEPTH_EXCEEDED` | `depth, limit` | Tree recursion exceeded `MAX_TREE_DEPTH` (4096). | ``
**Both columns are wrong.** `treeDepthExceeded(depth)`
(`src/domain/objects/error.ts:86-87`) constructs `{ code, depth }` — **there is no `limit`
field**, and there never was. And the description asserts one 4096 cap. Rewrite: payload
**`depth`** only; description names `core.maxTreeDepth`, default **2048**, honoured
**unclamped** at any configured value, **read from local scope only**.

**2. `docs/use/errors.md:198` — the `CONFIG_BAD_NUMERIC_VALUE` row.** Two clauses go stale
the moment this key joins:
- *"Today scopes `core.loosecompression` / `core.compression`"* → add **`core.maxTreeDepth`**,
  and state its **different validation model**: validated on the **effective (last-wins)**
  entry, where the compression keys die on *any* malformed line.
- *"The gate reports the first failing `[core]` entry by file line across the string
  path-likes and the compression keys (git's per-entry order)"* → `core.maxTreeDepth` is
  reported **ahead of** the line-ordered classes rather than within them, regardless of line
  order.
The tier sentence — *"`status`, `log`, `branch`, … die; `config --get` / `--list` still
survive"* — was already right; see item 3 for what changed underneath it.

**3. `docs/use/errors.md:197`, `:199`, `:200` — three rows that are NOT about this feature
and drift anyway.** `CONFIG_MISSING_VALUE` (`:197`), `CONFIG_BAD_ZLIB_LEVEL` (`:199`) and
`CONFIG_BAD_BOOLEAN_VALUE` (`:200`) each describe the **eager operational surface** in prose
("refuse **eagerly**: … on every operational command", "on the same broad operational
surface", "refuse the operational surface while `config --get` / `--list` still succeed").
Part 2 **widened that surface by five commands** — `archive`, `bundle-create`, `clone`,
`fsck`, `grep` now reach the gate, so every key the gate carries newly refuses on them too.
**Verify each of the three rows against the shipped code and update what actually changed** —
do not blanket-edit, and do not leave a row untouched merely because it does not mention
`maxTreeDepth`. `CONFIG_MISSING_VALUE`'s row also contains the published `core.hooksPath`
under-refusal precedent (*"a documented narrower under-refusal"*); leave that clause intact.

**4. Five command pages gain refusals they do not document.**
- `docs/use/commands/archive.md` — the *"Refusals match git (thrown before the stream is
  opened)"* list at `:59-62` and the `## Errors` list at `:101-104`. Two additions:
  `CONFIG_BAD_NUMERIC_VALUE` (and the other eager-gate codes) from the new operational gate,
  **and** `TREE_DEPTH_EXCEEDED` — `archive` had **no depth refusal at any input** before this
  change and now takes the shared cap. Note that its `maxEntries` override is *correct* and
  stays: git caps archive's depth like every other traversal but does **not** cap its entry
  count.
- `docs/use/commands/bundle.md` — the `create` error list at `:206-213` and, if part 2's pin
  put them in scope, the `verify`/`listHeads` list at `:215-218`. **Report whichever branch
  the pin landed on**; do not assume they were gated.
- `docs/use/commands/clone.md` — has no refusal list today; add one, or add the eager-gate
  codes to whatever error section exists, describing the narrow shape part 2 implemented
  (the gate fires only when the target already is a repository).
- `docs/use/commands/fsck.md` — the `## Errors` list at `:277+`. Add the eager-gate codes.
  **Also record the sharp edge**: `fsck` is the command a user runs when a repository is
  already suspect, and it now refuses to run on a repo whose `core.maxTreeDepth` is
  malformed. Git does the same, so the behaviour is faithful — and `config --get`/`--set`
  remaining ungated is what makes that recoverable rather than a deadlock. Say so.
  Separately, record the negative: `fsck` does **not** check tree depth, matching
  `git fsck --strict`, which exits 0 on a repo containing a 2049-deep tree.
- `docs/use/commands/grep.md` — add the refusal section it lacks.

**5. `core.maxTreeDepth` as a newly-honoured config key — where it lands, and why no new
page.** `docs/use/` contains only `commands/`, `primitives/`, `serializers/`, `errors.md`,
`recipes.md` and `snapshots.md`. **There is no config-keys page, and one is deliberately not
created here.** The existing home for config semantics is
`docs/use/commands/config.md`'s *"Valueless keys (git NULL parity)"* bullet (around `:70`),
whose final third already documents `core.loosecompression` / `core.compression` as *the*
int-typed keys, with the eager-gate refusal shape, `CONFIG_BAD_NUMERIC_VALUE`'s payload, and
`ParsedConfig`'s lenient treatment. **Add `core.maxTreeDepth` alongside them there**, with
its last-wins difference called out. A new page would duplicate that bullet and start a
second place to keep in sync; record the decision in the page so its absence reads as a
choice rather than an oversight.

**6. The local-only scope divergence — published, not implicit.** Git's precedence for this
key is system → global → local → worktree → `-c`/`GIT_CONFIG_*`, last-wins within a file, with
**no exception**. A value set *only* in the global scope changes git's behaviour. tsgit reads
`core.maxTreeDepth` through `readConfig`, which is **local-only** — the same reader every
other typed `core.*` key uses. **So a user who sets `core.maxTreeDepth` in `~/.gitconfig`
will see git honour it and tsgit ignore it.** The divergence is inherited, not created — no
typed key tsgit reads today consults global scope — but this key is likelier than most to be
hit by it, because git documents it as a fail-safe knob and fail-safe knobs get set once,
globally. It must be learnable from the docs rather than from a silent disagreement, and it
goes in **both** places, not either: `docs/use/commands/config.md` (a reader arrives from the
config side) **and** `docs/use/errors.md` (a reader arrives from the error side). Note the
contrast on the same page: the `config` **porcelain** reads all four scopes, but the keys the
**library itself** honours are read from local only.

**7. Primitive pages whose default bound changed.** `docs/use/primitives/walk-tree.md`,
`walk-working-tree.md`, `flatten-tree.md`, `diff-trees.md` — each states or implies a depth
behaviour. Add the one-sentence bound: the default is `core.maxTreeDepth` (2048 when unset),
honoured unclamped, read from the repository-local config. Check
`docs/use/primitives/internals.md` for any statement about the old constants.

**8. Cross-check pass, cheap and worth doing once.** Grep the whole of `docs/use/` for
`4096`, `1024`, `MAX_TREE_DEPTH`, `MAX_TREE_WALK_DEPTH`, `MAX_MERGE_TREE_DEPTH` and
`Number.MAX_SAFE_INTEGER`, and confirm every surviving hit is about something else (byte
caps, entry caps, `MAX_PATH_BYTES`, `MAX_FLAT_TREE_ENTRIES`).

**Out of this part's scope:** `docs/BACKLOG.md` (the docs phase ticks it),
`docs/design/depth-caps-and-node-aliases.md` (parts 4 and 8 own their sections; do not
re-edit), and every `docs/adr/*.md` (dated immutable records).

### TDD steps

Prose has no RED/GREEN; the equivalent discipline is that **every published claim is checked
against the shipped code before it is written**, and the check is recorded in the commit's
diff rather than asserted.

**Step 1 — verify before writing, item by item.** For each of the eight items: open the
source of truth and confirm the claim. Specifically: read
`src/domain/objects/error.ts:86-87` to confirm `TREE_DEPTH_EXCEEDED` carries `depth` and
nothing else; read `src/application/primitives/internal/repo-state.ts`'s
`assertEagerConfigValid` to confirm exactly which key classes the gate carries and in what
order; grep for `assertOperationalRepository` across `src/application/commands/` to confirm
the five newly-gated commands and the three that stayed ungated; read part 2's interop file
to confirm which branch the `bundle-list-heads` / `bundle-verify` pin landed on. A doc claim
this change cannot substantiate is worse than a stale row.

**Step 2 — write the six substantive edits** (items 1–6), then the primitive pages (7).

**Step 3 — run the cross-check grep** (item 8) and resolve every hit.

**Step 4 — link and spelling.** `npm run check:doc-links` catches a broken relative link;
`npm run check:spelling` catches new prose. The cspell dictionary lags on some British
`-ising`/`-ised` forms — a red spelling run on a real word is a dictionary entry, not a
rewrite.

**Step 5 — read the whole diff once as a user who has just hit
`CONFIG_BAD_NUMERIC_VALUE` on `fsck`.** They must be able to get from the error to the cause
(`core.maxTreeDepth` in local config), to the fix (`config --set`, which still works), and to
the reason their `~/.gitconfig` value was ignored — without reading source. If any of those
three hops is missing, the sweep is incomplete.

### Gate

Docs-only: the `<touched-tests>` and `<touched-files>` legs of the manifest gate are empty
(no test and no TypeScript file is touched), so the gate resolves to the doc-surface checks:

```
npm run check:doc-links && npm run check:spelling && npm run check:doc-coverage
```

`check:doc-coverage` is included because five command pages and four primitive pages change;
it is the check that catches a documented surface drifting out of sync with the exported one.

### Commit

```
docs(use): document core.maxTreeDepth, its local-only scope, and the widened refusal surface
```
