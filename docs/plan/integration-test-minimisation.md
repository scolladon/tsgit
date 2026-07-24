# Plan — Integration test minimisation (backlog 27.2)

> Source: design doc `docs/design/integration-test-minimisation.md` · ADRs `499` (refines `498`)
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Nature of this work (read once, applies to every part)

This is **not feature TDD**. Every part is a **behaviour-preserving test-suite refactor
with zero `src/` delta** — no production code, no comments, no threshold/budget/config file
moves (design §"The invariant"; ADR-499 Consequences). Per the plan-template Sizing-rules
EXCEPTION, test-suite parts with no `src/` delta are legitimately **standalone**; that is the
correct shape here, not a smell. **There are no production parts and none should be invented**
(design §7 Non-goals).

The "RED → GREEN → REFACTOR" cycle is re-cast for a redundancy-removal refactor, exactly as
27.1 did:

- **BASELINE** (analog of RED): the file(s) are green on the branch base; the "defect"
  removed is **redundancy** — subset/duplicate tests. Record the current green `it()` count.
- **MINIMISE** (analog of GREEN): apply KEEP/COLLAPSE/DELETE (Methodology below); the minimised
  file(s) still pass vitest, typecheck, and biome — no oracle weakened, matrix = union, and
  **every surviving cross-tool row still spawns git + tsgit and keeps the byte-exact compare**.
- **VERIFY** (analog of REFACTOR): confirm each file's *existing* convention is intact (§2 —
  not retrofitted), and hand-verify any risky collapse/delete (§3.5).

### The three integration-tier deltas over 27.1 (ADR-499 — do NOT re-derive, apply)

1. **No coverage / no mutation / no pyramid-shape gate backstops this tier.** `test:coverage`
   runs the `unit` project only; PR mutation is zero-signal for a tests-only diff; the pyramid
   GWT/AAA/`sut` heuristics are `tier: unit`. The **only** machine gate on the collapsed shape is
   biome `noThenProperty` (row field `label`, never `then`). The guarantee is carried by
   **proof-by-construction + cross-tool-preservation review + green `test:integration` +
   targeted hand-verify** (design §3; ADR-499 Decision 1).
2. **Cross-tool faithfulness is the primary backstop.** A collapse/delete is **illegal** if a
   surviving row that spawned real `git` stops spawning it, drops its byte-exact
   `expect(...).toBe/.toEqual(...)`, drops a fixture that pins a distinct git behaviour, weakens
   an error/refusal assertion, merges two `if (A||B)` guards into one row, or shares mutable repo
   state across rows (design §3.2).
3. **Preserve each file's existing convention exactly — do NOT retrofit.** Interop files bind
   `g`/`repo`/`ours`/`pair`, not `sut`, and are not GWT-perfect. That is legal for the tier
   (§2). Minimisation never introduces `sut`, never re-titles kept tests, and never touches the
   `@proves` header, the `describe.skipIf(!GIT_AVAILABLE)` wrapper, or the `interop-helpers.ts`
   env/async plumbing. Bar = **"no worse than today"**.

## Methodology (the single reference every part applies)

Apply **ADR-499 (refining ADR-498 §1) KEEP / COLLAPSE / DELETE** to each `it()` under one
`describe('When …')` (or one flat 2-level-GWT sibling group):

- **KEEP** verbatim if its journey/path OR oracle differs from every sibling (a structurally
  different `expect`, a different error code/reason/refusal, a different git-behaviour class),
  OR it isolates a boundary/tie-break/refusal no other kept test isolates.
- **COLLAPSE** into one `it.each` when **3+ siblings** (ADR-499 Decision 5) drive the **same
  journey/code-path AND the same oracle shape**, differing only in row fixtures — and, uniquely
  to this tier, optionally **the consuming command** carried as a row `run` thunk + `gitArgs`
  (ADR-499 Decision 2b: missing-value `commit`/`fetch`/`push`; archive/bundle/log/blame/grep
  git-subcommand args). The row matrix MUST be the **UNION** of every sibling's distinguishing
  fixtures — no fixture dropped, no oracle weakened — AND each cross-tool row MUST still spawn
  git + tsgit and keep the byte-exact compare. Canonical in-repo AFTER shape:
  `test/integration/config-interop.test.ts` (`WRITE_PARITY_MATRIX` /
  `MALFORMED_HEADER_READ_MATRIX` blocks) — the interop analog of 27.1's
  `conflict-marker-size.test.ts`. At **2 siblings**, COLLAPSE only when mechanically identical
  modulo one fixture literal (e.g. an earlier-by-line tie-break pair, a drive-letter/forward-slash
  path-form pair); else KEEP.
- **DELETE** only when a test's (fixtures × assertions) is a **strict subset** of *one* retained
  test (containment in *both* dimensions), and the retained row still pins every git behaviour the
  deleted test pinned. Relocating an extra assertion into the retained row before deleting is part
  of a legal delete — it adds no new `it()`. Two tests that merely *overlap* are a **collapse over
  the union**, never a delete.

Apply the **ADR-499 §3.2 guard-rails** — revert to KEEP if a move would: drop a
distinguishing/boundary/refusal fixture (every corner git handles specially — valueless-vs-absent
config key, earlier-by-line tie-break, leaf↔directory type change, off-by-one line, empty input,
binary/CRLF edge — is its own row); merge two `if (A||B)` guard conditions into one row;
**weaken an error/refusal assertion** (keep per-row `.data` code/key/line/reason AND the per-row
git-stderr substrings; never `toThrow(Class)`; never drop the `git.ok === false` check;
`absent`-class codes `AUTHOR_UNCONFIGURED`/`REMOTE_NOT_CONFIGURED`/`NO_UPSTREAM_CONFIGURED` NEVER
merge with `CONFIG_MISSING_VALUE` rows); or share **mutable** repo state across rows. A
**read-only** shared `beforeAll` repo is the ONLY permitted hoist — where a file already builds a
read-only commit-pair once and never writes it, that stays shared; a per-`beforeEach` fresh
mutable repo stays per-row.

**Preserve** each file's existing titles/AAA/variable-name convention exactly (§2 — the bar is
"no worse than today"). The one hard gate on the collapsed shape is biome `noThenProperty`: row
tables use a `label` field, **never** `then`.

**Never touch** (design §4 / §7): `test/parity/**`, `test/runtime-parity/**`, `test/browser/**`
(cross-adapter/runtime carve-out — never collapsed, deleted, nor counted as a retained test that
makes an integration test a strict subset); any `*.properties.test.ts` (none currently under
`test/integration/**`, rule stands); the `@proves` header, `describe.skipIf(!GIT_AVAILABLE)`
wrapper, and `interop-helpers.ts` env/async plumbing (`runGit`/`tryRunGit`/`git`/`runGitBytes` +
`SAFE_ENV` scrub; **`gitAsync`, never sync**, across same-process HTTP round trips in
`network/**`). `-parity`-named files *inside* `test/integration/**` (`diff-patch-git-parity`,
`filter-driver-parity`) are **cross-tool** interop and **in scope** — the carve-out is by
directory, not filename.

**Do NOT** add tests, rename to `sut`, re-title kept tests, re-style AAA, or edit `src/` /
`vitest.config.ts` / `test-pyramid-budgets.json` / `mutation-budgets.json`. A genuine
faithfulness or overlap **gap** found mid-work is surfaced to the orchestrator, never papered
over with a smuggled new test (design §7).

**Proof obligation (design §3).** Triple-preservation is a theorem from the union/strict-subset
discipline — no coverage/mutation gate applies. For any collapse/delete the implementer judges
risky (touches a refusal, a tie-break, a byte-exact pin, or a boundary), run the deterministic
single-row hand-verify (§3.5): perturb the tsgit field (or fixture) the surviving row pins, run
`npx vitest run <file> -t '<label>'`, confirm the row **FAILS**, then restore. The
`npx vitest run <touched> && npm run check:types && biome check <touched>` is the part gate;
`npm run test:integration` runs at each partition boundary and the final `npm run validate`
runs once at the end (which also re-runs the report-only `integrationProof` findings — kept clean
by construction: no file deleted, none emptied, `@proves` headers byte-identical). **Never commit
on a red gate.**

## Sizing & partition scheme (design §5; ADR-499 Decision 3)

**Granularity:** one **part per file for the giants** (a dense interop file is itself a whole
cross-tool surface), and **themed grouped parts** for the mid-size tail where a real ≥3 family
exists. **Files with no real collapse candidate get NO part** and are left byte-identical.
Each part is one atomic commit `test(integration): minimise <file-or-theme>` that independently
passes the part gate. Scope is the whole integration tier in ONE PR (ADR-499 Decision 6 — both
platform subdirs in).

**Ordering — ADR-499 Decision 3 (risk/payoff, not backstop strength):** **giants first**
(largest overlap, richest worked examples, highest payoff — prove the collapse + cross-tool
discipline where it matters most) → **themed root tail** → **`network/`** → **platform subdirs
(`posix-only/` then `win-only/`) LATE** (heavier spawn/async; platform-gated). 19 parts across
four partition headers (A giants → B themed tail → C network → D platform).

**Files left untouched (no part — confirmed/expected minimal on inspection).** The ~50 small
root files (3–8 `it`, distinct-oracle each), plus these inspected-but-thin ones:
`reflog-writers.test.ts` (KEEP-heavy — each reflog op logs distinctly), `diff-textconv-interop`,
`diff-recursive-interop`, `diff-patch`, `diff-patch-git-parity`, `range-diff-interop`,
`shortlog-interop`, `whatchanged-interop`, `filter-driver-parity`, and the 9 non-`push`
`network/` files (1–6 `it`). If an implementer finds a genuine ≥3 same-oracle family in an
untouched file mid-work, **surface it** (do not smuggle a collapse into an unrelated part, do not
add a test).

**Part gate (normal, non-`win-only` parts):**
`npx vitest run <touched test files> && npm run check:types && ./node_modules/.bin/biome check <touched files>`.
`posix-only/` files run under the `posix-integration` project — locally verifiable on this
darwin host.

**`win-only` part gate caveat (ADR-499 Decision 6 → (A)).** The 2 `win-only/` files **cannot**
run on this darwin host (`npx vitest run` no-ops/skips there). Their part gate is
`npm run check:types && ./node_modules/.bin/biome check <touched files>` **only** — backed by
construction-proof (§3.1) + reviewer diff-reading, with the **CI `win-integration` job as the
green authority**. The implementer **must NOT** claim a local vitest green proves a `win-only`
collapse.

**Partition-boundary checkpoint:** after each partition's parts land, `npm run test:integration`
(the full integration project, catching cross-file interaction); once at the very end,
`npm run validate`. Never commit on a red gate.

## Decision candidates (for the plan phase)

No open plan-level decisions — the six design decisions are all ratified in ADR-499 and the
partition follows Decision 3/6 (per-file giants + themed tail; both platform subdirs in;
giants-first). One resolved-in-flight note for implementers: the `win-only` part accepts a
locally-unverifiable vitest green (Decision 6 → (A), the one design deviation) — its gate drops
vitest and leans on CI. No new choice surfaced during exploration.

---

# Partition A — interop giants (per-file; giants first, highest payoff)

Boundary checkpoint: `npm run test:integration` after this partition's parts land.

## Part 1 — missing-value-refusal-interop (giant)

### Context
Owns `test/integration/missing-value-refusal-interop.test.ts` (3391 LOC, 102 `it`, 0 `it.each`
today — the highest-payoff collapse in the tier and design §1's richest worked example). The file
repeats, per config key, the **same three-oracle journey** through a **per-key consuming
command** (Decision 2b): (1) git refuses — exit 128 + the two-line
`missing value for '<key>'` / `bad config variable '<key>' … at line N` message; (2) tsgit throws
`CONFIG_MISSING_VALUE` with `{ key, line, source }`; (3) reconstruction — git's two stderr lines
rebuilt from tsgit's structured fields match after path-token normalisation. A fourth repeated
oracle: `tsgit configList does not throw (refusal is at consumer, not read)`.

**COLLAPSE (the union of key×command rows) into ≤4 `it.each`** — one per oracle family
(git-refuses-128+2-line / tsgit-throws-`CONFIG_MISSING_VALUE`-`{key,line,source}` /
reconstruction-matches-stderr / configList-does-not-throw). Each row carries
`{ key, fixture, line, gitArgs, run: (repo)=>…, label }`. Union of the valueless-key journeys:
`user.name` via `commit`, `remote.origin.url` via `fetch`, `remote.origin.url` via `push`,
`remote.origin.pushurl` via `push` (valued url present), `branch.main.remote` via `pull`,
`merge.mydriver.driver` via `merge`, `merge.mydriver.recursive` via `merge`,
`merge.mydriver.name` (read independently of driver).

**KEEP — interleaved DISTINCT behaviours that MUST NOT fold into the refusal matrix** (each keeps
its own `.data` + git behaviour): `AUTHOR_UNCONFIGURED` (absent `[user]` — git auto-commits exit
0; asserts `.not.toBe('CONFIG_MISSING_VALUE')`); `REMOTE_NOT_CONFIGURED` (absent url — via `fetch`
AND via `push`, two rows); `NO_UPSTREAM_CONFIGURED` (absent upstream keys);
subsectionless-`[merge] recursive` (neither tool refuses — git ignores the subsectionless key);
`merge.mydriver.name` valueless-with-valued-driver (name read independently). The **earlier-by-line
tie-break PAIRS** (pushurl-earlier/url-earlier; branch remote-earlier/merge-earlier;
driver-earlier/name-earlier) are 2-sibling groups → per Decision 5 either KEEP both or collapse
each pair into its **own** 2-row `it.each` (mechanically identical modulo one fixture literal);
they NEVER merge into the single-key refusal matrix.

**Isolation:** the per-`beforeEach` fresh `ours` tmpdir is mutable → each row's Arrange stays
inside the callback (never hoist it above the table). Preserve `runGit`/`tryRunGit` + `SAFE_ENV`
scrub and the `describe.skipIf(!GIT_AVAILABLE)` wrapper verbatim.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/missing-value-refusal-interop.test.ts` green
   on the base; note the 102 `it()` count. The redundancy removed is the key×command×oracle
   duplication.
2. **MINIMISE**: build the ≤4 `it.each` families over the UNION of valueless-key journeys with
   per-row `{ key, fixture, line, gitArgs, run, label }`; keep every cross-tool row spawning git +
   tsgit + comparing bytes and per-row `.data`. Leave every `absent`-class / tie-break / distinct
   behaviour KEEP. Re-run green.
3. **VERIFY**: convention intact (§2 — no `sut` retrofit); hand-verify (§3.5) one
   `CONFIG_MISSING_VALUE` row (perturb the pinned `line`, confirm the row FAILS, restore) and
   confirm an `AUTHOR_UNCONFIGURED` case still asserts `.not.toBe('CONFIG_MISSING_VALUE')`.

### Gate
`npx vitest run test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/missing-value-refusal-interop.test.ts`

### Commit
`test(integration): minimise missing-value-refusal-interop`

## Part 2 — config-interop (giant)

### Context
Owns `test/integration/config-interop.test.ts` (3234 LOC, 100 `it`, **already 13 `it.each` /
`describe.each` matrices** — the canonical in-repo AFTER shape). Existing matrices:
`WRITE_PARITY_MATRIX`, `SUBSECTION_WRITE_MATRIX`, `SUBSECTION_READ_MATRIX`,
`MALFORMED_HEADER_READ_MATRIX`, `WRITE_REFUSAL_BAD_HEADER_MATRIX`, `VALUELESS_REFUSAL_MATRIX`,
`SAME_LINE_READ_MATRIX`, `SAME_LINE_REFUSAL_MATRIX`, `SAME_LINE_SET_MATRIX`,
`SAME_LINE_UNSET_MATRIX`, `CHAIN_READ_MATRIX`, `CHAIN_REFUSE_MATRIX` (+ one inline `it.each`).
This file is **already heavily minimised — expect a light/moderate touch.**

**COLLAPSE:** extend an existing matrix with any straggler non-matrix `it()` that drives the same
journey as that matrix (add a row, not a new block); and collapse any remaining homogeneous ≥3
family among the ~50 non-matrix `it()`s into a new `it.each` over the union. Preserve the existing
`label` row-field convention (never `then`).

**KEEP:** every distinct read/write journey and every distinct-code refusal with per-row `.data`
(the matrices already isolate these — do not merge two codes). Do not fold a distinct malformed/
valueless/subsection behaviour into an unrelated matrix.

**Isolation:** config-write tests mutate on-disk config files; each row builds/writes its own
temp config → per-row Arrange stays inside the callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/config-interop.test.ts` green; note the 100
   `it()` count and which are already matrix rows.
2. **MINIMISE**: fold straggler siblings into the matching existing matrix; collapse any new ≥3
   homogeneous family; each row keeps its cross-tool compare and per-row `.data`. Re-run green.
3. **VERIFY**: convention intact; `noThenProperty` clean (label rows); hand-verify (§3.5) a
   refusal row moved into a matrix (perturb `.data.line`, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/config-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/config-interop.test.ts`

### Commit
`test(integration): minimise config-interop`

## Part 3 — diff-type-change-interop (giant, clean grid)

### Context
Owns `test/integration/diff-type-change-interop.test.ts` (1057 LOC, 45 `it`, 15 `Given` describe
blocks — design §1's clean-grid worked example). Six **symmetric type-pair** describes
(`file→symlink`, `symlink→file`, `file→gitlink`, `gitlink→file`, `symlink→gitlink`,
`gitlink→symlink`) each hold the **same four oracles**: `emits type-change with correct modes and
oids` / `reconstructed raw line matches git diff-tree` / `name-status T line matches git` /
`reconstructPatch emits delete+add blocks matching git`.

**COLLAPSE the 6×4 into four `it.each` blocks** (one per oracle family — they assert structurally
different things, so stay four separate blocks; collapse only *within* a family across the 6 type
pairs). Each row carries `{ from, to, fromMode, toMode, label }`; the callback builds the pair with
real git, runs tsgit `diff`, compares byte-for-byte per row.

Also consider collapsing the **gitlink single-op** trio — `pure gitlink add (absent→160000)`,
`pure gitlink delete (160000→absent)`, `gitlink pointer bump (oid1→oid2)` — which each carry the
same three oracles (`reconstructPatch` / `name-status` / `raw line`) differing by op; collapse to
three `it.each` of 3 rows **only if** the oracle shapes truly match (add=new-file block,
delete=deleted block, bump=modify block differ — carry the expected block-kind as a row field, else
KEEP the trio).

**KEEP (distinct detection oracles — never fold into a type-pair matrix):** leaf↔directory NEGATIVE
(`emits delete + add, never type-change`); same-oid gitlink move R100; different-oid gitlink move
at default / threshold-1 / copies:harder (three distinct `stay as separate add and delete`
outcomes); gitlink-delete + near-similar-blob-add R3 (unpaired); copy-source-not-detected; -B
break-rewrite `NOT broken into delete+add`.

**Isolation:** confirm whether the type-pair commit repos are a read-only shared `beforeAll`
(may stay shared) or per-test built (stay per-row) before hoisting anything.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/diff-type-change-interop.test.ts` green; note
   the 45 `it()` count.
2. **MINIMISE**: four `it.each` over the 6 type-pair rows (union), one per oracle family; optionally
   the gitlink-single-op trios; each row keeps the real-git build + byte-exact compare. Leave every
   rename/copy/break detection case KEEP. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) a `raw line matches git diff-tree` row (perturb
   the tsgit mode/oid, confirm FAIL, restore) and confirm the leaf↔directory NEGATIVE stays isolated.

### Gate
`npx vitest run test/integration/diff-type-change-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/diff-type-change-interop.test.ts`

### Commit
`test(integration): minimise diff-type-change-interop`

## Part 4 — rename-similarity-interop (giant, KEEP-heavy / RISKY)

### Context
Owns `test/integration/rename-similarity-interop.test.ts` (2578 LOC, 27 `it`, 0 `it.each`; flat
2-level-GWT titles). **KEEP-HEAVY and judgment-heavy — collapse conservatively.** Each `it` pins a
distinct similarity/copy/break/threshold matrix case (`#1`, `#4`, `#5`, `#C1`, `#C1b`, `#C4`, `#C2`,
`#C3`, `#B1`–`#B6`, `#T1`–`#T4`, bridge, limit), most against a **frozen golden** byte assertion.

**COLLAPSE (only genuinely homogeneous same-oracle families):** the break-rewrite
`M-score matches git byte-for-byte (+ frozen golden)` family (`#B1` M100, `#B2` M065, `#B5` M060,
`#B6` M100+R094 — the pure "score matches git" rows) → one `it.each` carrying
`{ fixture, expectedScore, golden, label }`; and the copy `C-score matches git` family
(`#C1`, `#C2`, with the copies mode as a per-row field) if ≥3 truly share the oracle shape.

**KEEP (distinct behaviours / boundaries / negatives — never collapse):** every threshold boundary
(`#T1`/`#T2` -M40%-yes/-M41%-no, `#T3` -C40%/-C41%, `#T4` gate boundaries, `#B4` inclusive-vs-
exclusive gate, `#B4b` merge:0→DEFAULT_MERGE_SCORE); every negative (`stays unpaired` /
`stay as add`/`not detected as copy`/`re-merged to plain M`); `renameLimit=1` and
`NUM_CANDIDATE_PER_DST` cap cases; the modify-passthrough-alongside-add/delete case. Never weaken a
frozen-golden byte assertion.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/rename-similarity-interop.test.ts` green; note
   the 27 `it()` count.
2. **MINIMISE**: collapse ONLY the pure "score matches git + golden" break-rewrite (and copy)
   families over the union; every threshold boundary, negative, limit-cap, and passthrough stays
   KEEP. Each collapsed row keeps its live-git run + golden byte compare. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) **every** collapsed score-parity row (perturb
   the pinned score/golden, confirm FAIL, restore) — this file's risk profile warrants verifying
   each collapse, not a sample.

### Gate
`npx vitest run test/integration/rename-similarity-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/rename-similarity-interop.test.ts`

### Commit
`test(integration): minimise rename-similarity-interop`

## Part 5 — fsck-interop (giant)

### Context
Owns `test/integration/fsck-interop.test.ts` (1403 LOC, 17 `it`, 17 `describe('When fsck runs …')`).
Each `it` asserts a corruption finding + exit code vs real git.

**COLLAPSE:** the `emits broken-link + missing findings and exit code 2 matches real git` family —
**5–6 siblings** producing the same broken-link+missing outcome from different corruption fixtures
→ one `it.each` over the union of corruption fixtures, each row keeping the findings + exit-code
compare.

**KEEP (every distinct violation code with per-row `.data` + exit-code — guard-rail §3.2; never
merge two violation classes; never `toThrow(Class)`):** bad-object warning(default)-vs-error(strict)
[2 siblings — Decision-5 2-collapse candidate only if mechanically identical modulo the strict flag,
else KEEP]; hash-mismatch (exit bit 1); badRefOid (exit 2); badRefContent + badRefOid-zero composite
(exit 10); null-oid-sentinel (exit 0, not a root); gitmodulesUrl bad-object (exit 1); gitmodulesParse
INFO (exit 0); badDateOverflow (exit 1).

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/fsck-interop.test.ts` green; note the 17 `it()`
   count.
2. **MINIMISE**: one `it.each` for the broken-link+missing family over the union of corruption
   fixtures; keep every distinct violation code its own row with `.data` + exit-code. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) one broken-link row and one distinct-code row
   (perturb the finding/exit-code, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/fsck-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/fsck-interop.test.ts`

### Commit
`test(integration): minimise fsck-interop`

## Part 6 — distinct-types-with-base-interop (giant, judgment)

### Context
Owns `test/integration/distinct-types-with-base-interop.test.ts` (1392 LOC, 22 `it`). Each `Given`
is a distinct merge/cherry-pick/revert scenario (S1–S12, P1–P5, Q1–Q6) over base/ours/theirs of
mixed object kinds.

**COLLAPSE candidate (the stage-1 rename-target-path family):** `S1` (stage-1 at `p~HEAD`, regular),
`S2` (`p~B`, regular), `S3` (`p`, symlink), `S4` (`p`, symlink), `S8` (`p~HEAD_0`), `P1`
(`p~HEAD_1`), `S12` (`p~feature_x`, slash flattened) all assert
`index stage-1 at <expected path> (<kind>) matches git, and working tree matches` — the same oracle
shape differing by `{ base/ours/theirs kinds, expected stage-1 path token, kind }`. Collapse to one
`it.each` where each distinct rename-target path is a preserved row.

**KEEP (distinct oracles — never fold):** `S7` (untracked squats target → **both refuse**, HEAD/
index untouched — a refusal); `S5`/`S5-mirror` (clean symlink, writeTreeOf parity); `Q1`/`Q4`/`Q5`
(exec-bit / mode outcomes); `P2`/`Q2` (union merge clean bytes); `Q6` (symlink retarget conflict);
`S6`/`P5` (cherry-pick / revert MERGE_MSG trailer byte-match); `S9`/`S9b`/`P3` (two-way markers / UU
stages / ours-symlink); `Q3` (binary rename bytes preserved).

**Isolation:** each scenario builds its own repo and merges (mutable) → per-row Arrange stays inside
the callback; do NOT hoist a merged repo above the table.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/distinct-types-with-base-interop.test.ts` green;
   note the 22 `it()` count.
2. **MINIMISE**: one `it.each` for the stage-1 rename-target-path family (union of expected paths),
   each row building its own merge and comparing index+worktree to git. Leave refusal / exec-bit /
   union / retarget / cherry-pick / revert / marker cases KEEP. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) two rename-target-path rows (perturb the
   expected path token, confirm FAIL, restore) and confirm `S7` still asserts both tools refuse.

### Gate
`npx vitest run test/integration/distinct-types-with-base-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/distinct-types-with-base-interop.test.ts`

### Commit
`test(integration): minimise distinct-types-with-base-interop`

## Part 7 — diff-whitespace-interop (giant, judgment)

### Context
Owns `test/integration/diff-whitespace-interop.test.ts` (1168 LOC, 21 `it`, 0 `it.each`; flat
2-level-GWT titles). Each `it` pins a whitespace-mode × fixture behaviour.

**COLLAPSE candidates (homogeneous single-oracle families):** the
`change mode (-b) → no diff` family (`tab→spaces`, `internal ws run grows`,
`tab replaced by space` = 3+) → one `it.each`; the `ignoreWhitespace all (-w) → no changes` family
(space/tab-amount-only, ws-only-line, unterminated-last-line = 3+) → one `it.each`. Each row keeps
the live-git compare.

**KEEP (compound / nuanced oracles — do not force into a single-mode matrix):** the compound
`Then X; with mode Y, Then Z` cases (at-eol-vs-all internal-space, -b-vs-w leading-whitespace,
-b-vs-w internal-space); the `ignoreCrAtEol` / mid-line-CR cases; the `ignoreBlankLines` numstat/
name-status nuance cases (blank stays-in-changes-but-omitted-from-numstat, g-blank+h-real,
spaces-not-blank-without-w, blank+w drops-file entirely, CRLF+blank); the rename-whose-dst-differs-
only-in-whitespace pairing case. Distinct behaviours → KEEP.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/diff-whitespace-interop.test.ts` green; note the
   21 `it()` count.
2. **MINIMISE**: `it.each` for the `-b→no diff` and `-w→no changes` families over the union of
   fixtures; keep every compound / ignoreBlankLines / rename case KEEP. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) one `-b→no diff` row (perturb the fixture so a
   real diff appears, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/diff-whitespace-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/diff-whitespace-interop.test.ts`

### Commit
`test(integration): minimise diff-whitespace-interop`

## Part 8 — archive-interop (giant)

### Context
Owns `test/integration/archive-interop.test.ts` (1159 LOC, 17 `it`, 16 `describe`).

**COLLAPSE (three families):**
- **tar byte-equal** — `tar bytes byte-equal to git archive --format=tar <variant>`: `HEAD`,
  `--prefix=pre/`, `--mtime=<date> <tree-oid>`, `v1.0` (annotated tag), `>100-byte paths` (ustar
  split), non-ASCII UTF-8 paths = ~6 siblings → one `it.each` carrying
  `{ treeish, gitArgs, label }` (Decision 2b — the git-archive args vary per row).
- **zip faithful** — `zip structurally faithful to git archive --format=zip <variant>`: default
  (tzOffset=0), `--prefix=pre/`, `--mtime` (empty EOCD comment), all-stored byte-equal = ~4
  siblings → one `it.each`.
- **commit metadata** — `result.commit` / `result.commitTime` for commit-ish (equals rev-parse +
  committer epoch), bare-tree (both undefined), annotated-tag (peeled commit oid) = 3 siblings →
  one `it.each` if the oracle shape holds (carry the expected commit/commitTime per row).

**KEEP (distinct oracles):** ls-tree path-set/modes/pre-order; regular-file-content vs cat-file;
symlink-content equals link-target; cross-compressor framing (Node vs Memory — method-0 byte-
identical, method-8 round-trip).

**Isolation:** if the archive fixture repo is a read-only shared `beforeAll`, it may stay shared
(rows never write it); confirm before relying on it.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/archive-interop.test.ts` green; note the 17
   `it()` count.
2. **MINIMISE**: `it.each` for the tar-byte-equal, zip-faithful, and commit-metadata families over
   the union (git-archive args as row fields); each row keeps the byte-exact compare. Leave
   ls-tree / content / symlink / cross-compressor KEEP. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) a tar `--prefix` row and a zip row (perturb a
   byte, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/archive-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/archive-interop.test.ts`

### Commit
`test(integration): minimise archive-interop`

## Part 9 — bundle-interop (giant)

### Context
Owns `test/integration/bundle-interop.test.ts` (1063 LOC, 31 `it`, 31 `describe`).

**COLLAPSE (primary):** the `header bytes are byte-identical to git bundle create <variant>`
family — `{ all: true }`, single tip `refs/heads/main`, `{ branches: true }`, `{ tags: true }`,
two-dot `main~2..main`, three-dot `main...feature`, `^`-exclusion (`main ^main~2`) = ~7 siblings →
one `it.each` carrying `{ revSelection, gitArgs, label }` (Decision 2b). Consider a second
`it.each` for the `prerequisites are oid-sorted and match git` family (three-dot, criss-cross,
explicit-exclude) only if the oracle shape truly matches.

**KEEP (every distinct refusal `.data` code + distinct oracle):** pack-object-id oracles (all=oid
sets equal; two-dot=prereq commits absent; criss-cross=merge-base absent — three *distinct*
oracles → KEEP); bundleVerify round-trips (tsgit-creates→git-consumes; git-creates→tsgit-reads);
`BUNDLE_EMPTY{no-refs}` (empty-selection + bare-rev = 2 siblings, Decision-5 candidate else KEEP);
REVPARSE unknown-ref; `BUNDLE_READ_FAILED` (missing + unreadable/chmod-000 = 2 siblings);
`BUNDLE_BAD_HEADER` (directory + plain-text = 2 siblings, Decision-5 2-collapse candidate);
`BUNDLE_UNSUPPORTED_VERSION{3}`; `DECOMPRESS_FAILED`; bundleListHeads no-filter / exact-filter /
near-miss (distinct).

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/bundle-interop.test.ts` green; note the 31
   `it()` count.
2. **MINIMISE**: `it.each` for the header-byte-identical family (union of rev selections, git args
   per row); keep every distinct refusal `.data` code and every distinct pack-oid / listHeads
   oracle KEEP; treat 2-sibling refusal pairs per Decision 5. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) a header-byte-identical row (perturb a ref
   selection, confirm FAIL, restore) and confirm two distinct `BUNDLE_*` codes stay isolated.

### Gate
`npx vitest run test/integration/bundle-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/bundle-interop.test.ts`

### Commit
`test(integration): minimise bundle-interop`

## Part 10 — notes-interop (giant, light / verify-minimal)

### Context
Owns `test/integration/notes-interop.test.ts` (918 LOC, 33 `it`, **1 existing `it.each`** — the
`--ref-style` block). **KEEP-HEAVY — the collapse surface is thin; verify-minimal and land only
genuine families.** Per-object-OID assertions under one scenario (blob OID / tree OID / commit OID
/ cat-file / reflog subject) are **distinct oracles → KEEP**. Per-scenario blocks (single note /
flat-5 / fanned-150 flip region / stickiness / last-note-removed / non-hex-entry / core.notesRef
vs GIT_NOTES_REF precedence) pin **distinct tree-shape / precedence behaviours** (the flat→fanned
threshold is the whole point) → KEEP.

**COLLAPSE (thin):** extend the existing `--ref-style` `it.each` with any sibling ref-style case;
collapse any genuinely homogeneous ≥3 OID-parity family only if inspection surfaces one.

**KEEP:** `NOTES_ALREADY_EXIST` / `NOTES_OBJECT_HAS_NONE` (distinct refusal codes, per-row `.data`);
`core.notesRef` / `GIT_NOTES_REF` / `GIT_NOTES_REF-outside-refs/notes` precedence (distinct).

If inspection confirms the file is already minimal beyond the ref-style extension, land the small
extension and **surface the KEEP-heavy finding** rather than inventing a collapse.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/notes-interop.test.ts` green; note the 33 `it()`
   count and the existing `--ref-style` matrix.
2. **MINIMISE**: extend the `--ref-style` `it.each` with any siblings; collapse a genuine ≥3
   OID-parity family only if present; every per-object-OID and per-scenario block stays KEEP.
   Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) any row moved into the ref-style matrix
   (perturb the resolved ref, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/notes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/notes-interop.test.ts`

### Commit
`test(integration): minimise notes-interop`

## Part 11 — diff-attr-binary-interop (clean numstat collapse)

### Context
Owns `test/integration/diff-attr-binary-interop.test.ts` (534 LOC, 12 `it`, 24 `describe`). A
textbook single-family collapse: all 12 drive `diff({ withStat: true }) → numstat matches live git`
under a distinct gitattributes fixture.

**COLLAPSE:** one `it.each` over the union of ~11 fixtures — `B1` (-diff modify → `-\t-`), `Bn`
(-diff removed → text), `Ba` (-diff add), `Bd` (-diff delete), `Bmacro` (binary macro), `T2`
(diff=ghost unconfigured), `T2n` (-diff replacing ghost), `N1` (bare diff forcing text on NUL file
→ line counts), `N3` (diff=up textconv, no NUL), `N3s` (textconv + raw NUL → `-\t-`), `N4` (textconv
clean raw) — each row carrying `{ fixture/gitattributes, expectedNumstat/binaryFlag, label }`; each
row keeps the live-git numstat compare. Each distinct binary-vs-text behaviour is a preserved row
(guard-rail §3.2).

**KEEP (different act):** the rename case `R` uses `detectRenames: true` and asserts
`binary: true, added: 0, deleted: 0` vs git `-\t-` — carry it as a row with an options field, or
KEEP it as its own `it` (its act differs from the plain-numstat family).

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/diff-attr-binary-interop.test.ts` green; note the
   12 `it()` count.
2. **MINIMISE**: one `it.each` for the numstat family over the union of gitattributes fixtures;
   each row runs live git + tsgit and compares numstat; the `R` rename case handled per its
   distinct act. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) a `-\t-` (binary) row and a line-count (text)
   row (swap the expected numstat, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/diff-attr-binary-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/diff-attr-binary-interop.test.ts`

### Commit
`test(integration): minimise diff-attr-binary-interop`

## Part 12 — lfs-pointer-interop (clean 4×4 grid)

### Context
Owns `test/integration/lfs-pointer-interop.test.ts` (426 LOC, 16 `it`, 8 `describe`). A clean 4×4
grid: **4 scenarios** (adds git-lfs pointer / bumps pointer oid+size = modify / replaces pointer
with real content = modify / commits `.gitattributes` diff=lfs + tracked.bin with no driver) each
carry the **same four oracles** (`structured change type` / `name-status matches git` /
`numstat matches git` / `reconstructed patch matches git diff --no-ext-diff byte-for-byte`).

**COLLAPSE the 4×4 into four `it.each` blocks** (one per oracle family — distinct oracle shapes stay
four separate blocks; collapse *within* a family across the 4 scenarios). Each row carries
`{ fixture, expectedType, expectedNumstat, label }`; each row keeps the real-git compare.

**Isolation:** confirm whether the pointer-commit repos are a read-only shared `beforeAll` (may stay
shared) or per-scenario built (stay per-row) before hoisting.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/lfs-pointer-interop.test.ts` green; note the 16
   `it()` count.
2. **MINIMISE**: four `it.each` (one per oracle family) over the 4 scenario rows (union); each row
   keeps the byte-exact compare and its expected type/numstat. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) a `numstat matches git` row (perturb the
   expected added/deleted counts, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/lfs-pointer-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/lfs-pointer-interop.test.ts`

### Commit
`test(integration): minimise lfs-pointer-interop`

## Part 13 — bisect-midpoint-interop

### Context
Owns `test/integration/bisect-midpoint-interop.test.ts` (424 LOC, 11 `it`, 5 `describe`).

**COLLAPSE (two families):** `tsgit nextCommit matches git rev-list --bisect winner` (linear-10,
diamond-unequal-date, equal-date-diamond-b-first, equal-date-diamond-a-first = 4) → one `it.each`;
`tsgit structured counts match git rev-list --bisect-vars` (same 4 fixtures) → one `it.each`. Each
row carries `{ historyFixture, label }` and keeps the git-rev-list compare. The equal-date FIFO-walk
cases stay as **distinct rows** (they pin the FIFO tie-break, not oid-asc — preserve that pin).

**KEEP (distinct oracles):** `all=1 row returns remainingIfGood=-1`; `good=[] uses all bad-reachable
commits`; inverted-range (good descendant of bad) → `bisectMidpoint returns undefined`.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/bisect-midpoint-interop.test.ts` green; note the
   11 `it()` count.
2. **MINIMISE**: two `it.each` (nextCommit-parity, counts-parity) over the 4 history fixtures
   (union); the equal-date FIFO cases stay distinct rows. Leave all=1 / good=[] / inverted-range
   KEEP. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) an equal-date FIFO row (perturb the expected
   winner, confirm FAIL, restore) to protect the tie-break pin.

### Gate
`npx vitest run test/integration/bisect-midpoint-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/bisect-midpoint-interop.test.ts`

### Commit
`test(integration): minimise bisect-midpoint-interop`

---

# Partition B — themed root tail (grouped by collapse pattern)

Boundary checkpoint: `npm run test:integration` after this partition's parts land.

## Part 14 — read-command porcelain reconstruction (status + blame + log)

### Context
Owns three read-command interop files that each hold one dominant
`reconstructs git <read-command> for <scenario>` family:

- `test/integration/status-interop.test.ts` (468 LOC, 16 `it`). **Two families:** porcelain-v1
  `reconstructs git status --porcelain for <state>` (staged add / staged modify / staged delete /
  cached delete / staged-then-worktree MM / unborn-HEAD all-A / clean-empty / staged type-change /
  staged mode-change / conflicted UU-AA-UD-DU ≈ 10) → one `it.each`; porcelain-v2
  `reconstructs git status --porcelain=v2` (mixed modes+oids / staged symlink type-change / staged
  exec-mode / clean / conflicted u-lines / conflicted-removed-from-disk mW=000000 ≈ 6) → one
  `it.each`. Each scenario is a preserved row.
- `test/integration/blame-interop.test.ts` (294 LOC, 10 `it`). One family
  `reconstructs git blame --porcelain for <scenario>` (linear / prepend-shift / clean-merge /
  followed-rename / -L range / dirty-worktree / staged-new / worktree-L-range / deep-ancestry /
  -s first-parent-TREESAME) → one `it.each` with `{ fixture, gitArgs, label }` (the `-L`/`-s`
  variants carry git args per row).
- `test/integration/log-interop.test.ts` (308 LOC, 10 `it`). One family
  `oid sequence equals git log / rev-list <variant>` (all-parents-date-order / --first-parent /
  peel-tag / HEAD~3..HEAD / --max-parents=0 / --min-parents=2 / --max-parents=1 / --min-parents=1 /
  filter-then-limit -n1 / --first-parent --min-parents=2) → one `it.each` with
  `{ revArgs (gitArgs), label }`.

**KEEP:** any distinct-oracle outlier in each file (e.g. a co-refusal or a non-porcelain assertion).
**Isolation:** each scenario builds its own repo/worktree (mutable) → per-row Arrange inside the
callback; if a file uses a read-only shared history repo for the oid-sequence rows, it may stay
shared.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/status-interop.test.ts test/integration/blame-interop.test.ts test/integration/log-interop.test.ts`
   green; note per-file `it()` counts.
2. **MINIMISE**: per file, collapse the dominant reconstruction family into `it.each` over the
   union of scenarios (git args as row fields); each row keeps the real-git reconstruct + compare;
   leave outliers KEEP. Re-run green.
3. **VERIFY**: each file's convention intact; hand-verify (§3.5) one status-v2 conflicted row and
   one log rev-list row (perturb the fixture/expected sequence, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/status-interop.test.ts test/integration/blame-interop.test.ts test/integration/log-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/status-interop.test.ts test/integration/blame-interop.test.ts test/integration/log-interop.test.ts`

### Commit
`test(integration): minimise status, blame, and log reconstruction suites`

## Part 15 — object/naming query reconstruction (show + describe + name-rev + grep)

### Context
Owns four query-reconstruction interop files:

- `test/integration/show-interop.test.ts` (266 LOC, 17 `it`). Families:
  `reconstructs git show for <object>` (root commit / non-root / rename commit / annotated-tag /
  lightweight-tag / tree-by-peel / tree-by-oid / blob ≈ 8) → one `it.each`; and
  `reconstructs git show -m for <merge>` (feature / combined both-sides-edit / three-parent octopus
  = 3) → one `it.each`. KEEP: concatenated-stream `show A B`, blob-path / nested-blob-path /
  empty-path / sub-directory-path resolution, single-file per-file-counts (distinct oracles).
- `test/integration/describe-interop.test.ts` (433 LOC, 19 `it`). COLLAPSE the
  `reconstructs git describe --dirty for <state>` family (clean / tracked-change / staged-change /
  conflicted-index = 4) → one `it.each`; consider the `matches git describe <flag>` family
  (nearest / --long / --match / --tags / --all / --always) only where ≥3 truly share the oracle
  shape. **KEEP** the candidates/budget tie-break cases (default keeps farther-first-met /
  --candidates=1 spends slot on farther / default nearest-first-met / full-budget nearer-later-met /
  single-slot first-met) and the exactMatch/no-`--always` co-refusals — distinct tie-break oracles.
- `test/integration/name-rev-interop.test.ts` (285 LOC, 15 `it`). COLLAPSE only genuinely
  homogeneous ≥3 families (e.g. the `renders with ~n` / `--refs`/`--exclude` filter families);
  KEEP the pruning cases (older-ancestor-pruned, older-seed-pruned, --tags-variant) and the
  `describe --contains co-refuses` case — distinct behaviours.
- `test/integration/grep-interop.test.ts` (457 LOC, 12 `it`). COLLAPSE the
  `tsgit omits <path-class> and git grep agrees` family (untracked / gitignored / deleted-tracked /
  symlink / wt-only-unstaged / staged-only ≈ 6, some with `--cached`/`HEAD` git args per row) → one
  `it.each`. KEEP: lineNumber `-n`, `-l` set-equality, binaryMatch, `-c`/`-l` derivation (distinct
  oracles).

**KEEP** every listed distinct-oracle case. Per-row isolation as above.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/show-interop.test.ts test/integration/describe-interop.test.ts test/integration/name-rev-interop.test.ts test/integration/grep-interop.test.ts`
   green; note per-file `it()` counts.
2. **MINIMISE**: per file, collapse the named dominant families into `it.each` over the union (git
   args as row fields); each row keeps the real-git reconstruct/compare; leave the listed
   tie-break / pruning / distinct-oracle cases KEEP. Re-run green.
3. **VERIFY**: each file's convention intact; hand-verify (§3.5) one `show -m` merge row, one
   describe `--dirty` row, and one grep `omits-path` row (perturb, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/show-interop.test.ts test/integration/describe-interop.test.ts test/integration/name-rev-interop.test.ts test/integration/grep-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/show-interop.test.ts test/integration/describe-interop.test.ts test/integration/name-rev-interop.test.ts test/integration/grep-interop.test.ts`

### Commit
`test(integration): minimise show, describe, name-rev, and grep reconstruction suites`

## Part 16 — merge / rebase / add-add families (merge-driver + rebase + add-add-content)

### Context
Owns three merge-family interop files:

- `test/integration/merge-driver-interop.test.ts` (403 LOC, 10 `it`). COLLAPSE the
  `configured driver overrides the built-in <text/binary/union> merge, matching git` family (3) →
  one `it.each`; consider the driver-output-lands family if ≥3 homogeneous. KEEP: lazy-refuse
  `lacks command line` (a refusal — keep the `.data`/stderr), fall-back-to-built-in-text (distinct).
- `test/integration/rebase-interop.test.ts` (489 LOC, 12 `it`). COLLAPSE the
  `matches git: resulting tree + commit count` family (drop / squash / fixup, plus clean/reorder if
  homogeneous) → one `it.each`. KEEP the cross-tool interop journeys as distinct: `git rebase
  --continue finishes tsgit rebase-merge state` / `repo.rebase.continue reads git state` /
  abort-reflog parity / cherry-pick-equivalent drop / edit-stop finished-by-git and finished-by-tsgit
  / all-pick byte-identical no-op — these are distinct acts, not fixtures of one journey.
- `test/integration/add-add-content-interop.test.ts` (873 LOC, 13 `it`). COLLAPSE the
  rename-suffix family (`f~feature_x` slash-flatten / `f~side_0` unique-probe / `f~HEAD_1` probe /
  `f~<7-char-abbrev> (<subject>)` = distinct suffix rules, each a preserved row) → one `it.each`;
  and the stage-2/3 marker families only where ≥3 share the oracle shape. KEEP: refusal
  (untracked-overwrite → both refuse, write nothing), clean-concatenated-commit, symlink-target /
  regular-vs-symlink stage cases (distinct outcomes).

**Isolation:** every merge/rebase/add builds its own repo (mutable) → per-row Arrange stays inside
the callback; never hoist a merged/rebased repo above a table.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/merge-driver-interop.test.ts test/integration/rebase-interop.test.ts test/integration/add-add-content-interop.test.ts`
   green; note per-file `it()` counts.
2. **MINIMISE**: per file, collapse the named family into `it.each` over the union; each row builds
   its own repo and keeps the git compare + per-row `.data` for refusals; leave the distinct
   cross-tool / refusal cases KEEP. Re-run green.
3. **VERIFY**: each file's convention intact; hand-verify (§3.5) a driver-override row, a rebase
   tree+count row, and a rename-suffix row (perturb, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/merge-driver-interop.test.ts test/integration/rebase-interop.test.ts test/integration/add-add-content-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/merge-driver-interop.test.ts test/integration/rebase-interop.test.ts test/integration/add-add-content-interop.test.ts`

### Commit
`test(integration): minimise merge-driver, rebase, and add-add-content suites`

---

# Partition C — network (heavier async; gitAsync-only)

Boundary checkpoint: `npm run test:integration` after this partition's part lands.

## Part 17 — network/push-http-backend (giant, push.default sweep)

### Context
Owns `test/integration/network/push-http-backend.test.ts` (1658 LOC, 23 `it`, 0 `it.each` — the
network giant). Beyond the two baseline push tests, it holds a large **push.default resolution
sweep** against a same-process http-backend bare repo.

**COLLAPSE (config-per-row, the network analog of Part 1's command-per-row):**
- the **remote-resolution** family `resolves the same remote real git does` (branch.main.pushRemote
  + remote.pushDefault + branch.main.remote precedence / remote.pushDefault + branch.main.remote /
  branch.main.remote + two-remotes / sole-remote) → one `it.each` carrying `{ configFixture, label }`;
- the **refspec push** family `pushes the current branch to <ref>, matching real git`
  (push.default=current+sole / upstream+central / simple+central-same-name / matching-two-advertised /
  tracking-alias / simple-triangular-same-name / matching-detached-still-pushes) → one `it.each`
  carrying `{ configFixture, expectedRef, label }`.

**KEEP — interleaved DISTINCT refusals that MUST NOT fold into a resolve/push matrix** (each keeps
its own reason + `.data`, mirroring Part 1's absent-vs-valueless discipline; guard-rail §3.2):
`push.default=nothing` refuse; detached-HEAD refuse (under current / simple); `push.default`
unrecognized-value → **bad-config-variable** refuse; wrong-case recognized word → refuse
(enum match is case-sensitive); `push.default=upstream` triangular refuse and central-no-merge
refuse; the triangular `refuses with the triangular error, NOT the no-upstream error` case (a
distinct-guard KEEP — one fixture must not stand in for the other); `push.default=simple`
different-name / no-merge / detached refuse. `already-up-to-date → pushedRefs empty, no POST` is a
distinct oracle → KEEP.

**Isolation (load-bearing for network):** use **`gitAsync`, never sync**, for every command that
crosses the same-process HTTP round trip (the event-loop-deadlock guard); preserve the bare-repo +
http-backend server harness and `SAFE_ENV` scrub; each row runs against a fresh clone it mutates →
per-row Arrange inside the callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/network/push-http-backend.test.ts` green; note
   the 23 `it()` count. (Network interop is spawn/async-heavy — allow the longer timeout the file
   already sets.)
2. **MINIMISE**: two `it.each` (remote-resolution, refspec-push) over the union of config fixtures;
   every distinct refusal reason stays its own KEEP row with `.data`; `gitAsync` preserved on every
   round trip. Re-run green.
3. **VERIFY**: convention intact; hand-verify (§3.5) one refspec-push row (perturb the expected
   ref, confirm FAIL, restore) and confirm the triangular case still asserts the triangular error,
   not no-upstream.

### Gate
`npx vitest run test/integration/network/push-http-backend.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/network/push-http-backend.test.ts`

### Commit
`test(integration): minimise network/push-http-backend`

---

# Partition D — platform subdirs (LATE; posix-only then win-only)

Boundary checkpoint: `npm run test:integration` after Part 18 lands; the final
`npm run validate` after Part 19 (also runs the report-only `integrationProof` findings — kept
clean by construction). Never commit on a red gate.

## Part 18 — posix-only sweep (locally verifiable)

### Context
Owns all of `test/integration/posix-only/**` (5 files, run under the `posix-integration` project —
**locally verifiable on this darwin host**). **KEEP-HEAVY — land only genuine ≥3 (or Decision-5
2-) collapses; else confirm minimal and leave byte-identical.**
- `node-hook-runner.test.ts` (134 LOC, 7 `it`): the `resolves skipped` pair (no-hook-file /
  no-executable-bit) is a 2-sibling Decision-5 candidate (mechanically identical modulo the fixture)
  → 2-collapse or KEEP; the exit-code / stdin / args / env cases are distinct → KEEP.
- `node-hooks-e2e.test.ts` (177 LOC, 6 `it`): the two `rewrites the message` cases (commit-msg /
  prepare-commit-msg) use **different hooks** (different act) → likely KEEP; pre-commit fail/pass,
  post-commit run/fail-still-succeeds are distinct → KEEP.
- `node-fs-real-symlinks.test.ts` (126 LOC, 4), `node-fs-locked-directory.test.ts` (100 LOC, 2),
  `node-fs-mode-bits.test.ts` (42 LOC, 1): distinct fs behaviours / too few siblings → KEEP/minimal.

**Isolation:** these spawn hooks / touch a real fs tmpdir (mutable) → per-row Arrange inside the
callback. Preserve `describe.skipIf` wrappers.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration/posix-only` green (runs under `posix-integration`
   on darwin); note per-file `it()` counts.
2. **MINIMISE**: land only the genuine collapses (the `resolves skipped` 2-collapse if mechanically
   identical; any ≥3 family that inspection surfaces); leave the rest byte-identical. If a file is
   fully minimal, keep it untouched and note it. Re-run green.
3. **VERIFY**: each file's convention intact; hand-verify (§3.5) any collapsed row (perturb the
   fixture, confirm FAIL, restore).

### Gate
`npx vitest run test/integration/posix-only && npm run check:types && ./node_modules/.bin/biome check test/integration/posix-only`

### Commit
`test(integration): minimise posix-only suites`

## Part 19 — win-only sweep (CI-verified; special gate)

### Context
Owns all of `test/integration/win-only/**` (2 files — **cannot run on this darwin host**;
ADR-499 Decision 6 → (A)).
- `openrepository-windows-paths.test.ts` (69 LOC, 2 `it`): the drive-letter path and its
  forward-slash variant assert the **same oracle** (`openRepository does NOT throw INVALID_OPTION`)
  differing only in the path-form literal → a legitimate **Decision-5 2-collapse** into one
  `it.each` of 2 rows.
- `node-fs-windows-real.test.ts` (101 LOC, 2 `it`): canonical-root round-trip vs symlink
  `openWithNoFollow` PERMISSION_DENIED — **distinct oracles → KEEP**.

**Special gate + proof (Decision 6 → (A)):** `npx vitest run` no-ops/skips on darwin, so the part
gate runs **`npm run check:types` + `biome check` only**. The collapse is verified by
construction-proof (§3.1) + reviewer diff-reading; **vitest-green is the CI `win-integration` job's
obligation.** The implementer **MUST NOT** claim a local vitest green proves the `win-only`
collapse. `§3.5` hand-verify is not available here (cannot run the file) — rely on construction +
the CI job.

### TDD steps
1. **BASELINE**: confirm the two files are green on the base **via the CI `win-integration` history**
   (they cannot run locally on darwin); note the 2+2 `it()` counts. Do NOT run `npx vitest run` and
   treat a skip as green.
2. **MINIMISE**: collapse the `openrepository-windows-paths` path-form pair into one `it.each` of 2
   rows over the union (drive-letter + forward-slash), each row keeping the
   `does NOT throw INVALID_OPTION` assertion; leave `node-fs-windows-real` KEEP. Typecheck + biome
   locally.
3. **VERIFY**: convention intact; construction-proof recorded (matrix = union, no oracle weakened);
   **do not** assert a local vitest green — the CI `win-integration` job is the authority.

### Gate
`npm run check:types && ./node_modules/.bin/biome check test/integration/win-only`

### Commit
`test(integration): minimise win-only suites`
