# Plan — Test-convention conformance sweep (backlog 27.6)

> Source: design doc `docs/design/test-convention-sweep.md` · ADR `506`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Nature of this work (read once — applies to every part)

This is **not feature TDD**. Every part is a **behaviour-preserving test-suite refactor
with zero `src/` delta** — no production code, no comments, no threshold/budget file
(`test-pyramid-budgets.json`, `mutation-budgets.json`) moves (design §1, §9; ADR-506).
Per the plan-template Sizing-rules EXCEPTION, test-suite parts with no `src/` delta are
legitimately **standalone** — that is the correct shape here, not a smell. There are no
production parts and none may be invented.

**Surface gates DO NOT APPLY.** No `src/` change, no new exported symbol, no barrel /
facade / `api.json` / doc-coverage / README / registry impact. There is nothing for the
implement phase to pre-pay — do not chase surface gates in any part (`.claude/workflow/surface-gates.md`
is out of scope for this sweep).

**Mutation is ZERO-signal.** CI's `compute-mutation-scope.sh` filters the PR diff to
`^src/.*\.ts$`; a tests-only diff yields an empty mutate-list, so Stryker audits nothing.
Local whole-tree Stryker under-reports non-deterministically (stryker-js#5928). No part
schedules or chases a mutation score. The guarantee is **by construction** (assertions
byte-identical) + **coverage** (100%, cannot drop — no case removed) + **green `validate`**.

The "RED → GREEN → REFACTOR" cycle is re-cast for a conformance refactor (see each part's
`### TDD steps`):

- **BASELINE** (analog of RED): the file(s) are green on the part's base. The "defect"
  removed is *non-conformance* — `sut` bound to an outcome/input, missing/empty AAA markers,
  scattered Given+When zones. Record the current green `it()`/case count.
- **CONFORM** (analog of GREEN): apply the §5 procedure axes 1–3; the file(s) still pass
  vitest, typecheck, and biome — **no assertion changed, no case dropped, no case added**.
- **VERIFY** (analog of REFACTOR): confirm `sut`-binds-the-unit-or-is-dropped-per-rule, all
  three AAA markers own a statement, each subject+event is one zone, and every
  `*.properties.test.ts` body is byte-preserved.

## The per-file procedure (the single reference every part applies — design §5)

Apply the **design §5** procedure and **ADR-506** criteria to each file, top to bottom.
Do **not** re-transcribe it per part — this is the shared contract:

- **Axis 1 — `sut`/`result` (drop-sut rule).** For a **function** or a **`this`-free static
  factory** (`crc32`, `ObjectId.from`, `RefName.from`, `FilePath.from`) → **drop `sut`; bind
  the outcome to `result`** (`const result = crc32(data)`). The anti-pattern fixed is
  `const sut = <call>(…)` where `sut` holds the *outcome*/input and is only read as data —
  a near-pure rename `sut`→`result`, plus renaming a mis-named input to a descriptive name.
  An **object/factory under test keeps `sut`** (`const sut = new NodeHashService('sha256')`,
  `const sut = openRepository(…); const result = await sut.status()`). Test **input never**
  binds to `sut`. A throwing/rejecting test keeps the error assertion on `.data` — never a
  bare `toThrow(Class)` (gated by `bareClassToThrow`).
- **Axis 2 — AAA markers.** Every non-skipped `it`/`test` body carries `// Arrange`,
  `// Act`, `// Assert`, each owning a statement. A genuinely empty section uses the
  **compound marker** (`// Arrange & Act`) — never a bare marker above an empty section
  (`emptyAaaSection`). `it.each` object-row label field is **`label`**, never `then`
  (`noThenProperty`).
- **Axis 3 — GWT + zone regrouping.** `describe('Given …')` > `describe('When …')` >
  `it('Then …')`; the 2-level shortcut only for a singleton When. **Cluster** every test
  sharing the *same Given AND same When* into **one** describe zone per subject+event.
  Regrouping **moves** `it` leaves between describes; it never changes a leaf's assertions.
- **Collapse (lossless, NO DELETE).** Within a zone, **collapse** 3+ siblings sharing the
  same act AND oracle shape into one `it.each` — the row matrix is the **union** of every
  sibling's distinguishing inputs/oracles (no input dropped, no oracle weakened, one row
  per guard/boundary, no shared mutable state). Collapse is lossless: the `it()`-block count
  may drop; the **executed-case count does not**. **NO DELETE** and **no case added** — every
  distinguishing input survives as a KEEP leaf or a COLLAPSE row.
- **Exclusions — do NOT rewrite.** Files already canonical (skip them); `sut` = object/factory
  under test read as data; `.skip`/`.todo`/`.fails` blocks (verbatim); `*.properties.test.ts`
  — conform the **structure** only (GWT/AAA/`sut` of the outer scaffolding), the
  `fc.assert(fc.property(…))` invariant and arbitraries are **byte-preserved** (ADR-134/136).

**Convention for `*.properties.test.ts` siblings of a dedicated giant** (`config-read.properties`,
`update-config.properties`, `three-way-tree.properties`, `node-file-system.properties`,
`fsck.properties`, `describe.properties`): the giant part is the single `.test.ts` file only;
its `.properties` sibling rides the neighbouring **batch** part as a structure-only conform.

**Navigation/edit:** Serena is the default (`get_symbols_overview`, `replace_content`,
`replace_symbol_body`); `get_diagnostics_for_file` after each edit (advisory — ground truth is
`check:types` / `validate`). Worked examples: design §5 (`crc32`, `object-id`, `index-diff`,
`apply-merge-to-worktree`).

## Sizing & partition scheme (design §7 / ADR-506)

**Giants get a dedicated single-file part** (design §7's enumerated >1.5k-LOC set): the 7
primary — `application/primitives/{config-read,update-config,detect-similarity-renames}`,
`application/commands/merge`, `domain/fsck/validate-object`,
`adapters/node/node-file-system-injected`, `domain/diff/patch-serializer` — **plus the next
tier** — `application/commands/{fsck,fetch,push,rebase,add}`, `domain/merge/three-way-tree`.
That is **13 dedicated giant parts**. Everything else is grouped: **tiny sibling subdirs
cluster into one batch part** (coarser than the design's per-directory default — the plan-phase
brief's explicit permission), each batch held to ≤ ~48 files.

**Part-count note (transparency, not a blocker).** The ~12–20 aspiration is exceeded to
**31 parts** because the giant-isolation directive (13 dedicated giants) combined with the
590-file / all-tier scope sets the floor: 13 giant parts + 18 batch parts. Isolating each
giant keeps a 2k–6k-LOC single-file diff reviewable and any red gate bisectable; batching the
small files keeps the other parts to one reviewable atomic commit each.

**Ordering — machine-gated tiers first (strongest backstop), then un-gated tiers:**
`check:test-pyramid` gates axes 2–3 titles on the **unit** tier only; non-unit tiers rest on
the per-file procedure + the review phase. So: **A** `test/unit/domain` → **B**
`test/unit/{operators,ports,adapters}` → **C** `test/unit/{repository,transport,api-surface}`
+ unit root → **D** `test/unit/application` → **E** `test/integration` → **F**
`test/{parity,runtime-parity,perf}`.

## Gates (apply to every part unless a part overrides)

- **Part gate** (every atomic commit — behaviour-preserving, NO red→green; the proof is the
  existing suite staying green):
  `npx vitest run <touched paths> && npm run check:types && ./node_modules/.bin/biome check <touched paths>`.
  `check:types` is whole-project. For a part that **splits a flat directory** (primitives
  root, commands root, integration root), the vitest/biome target may be the **parent
  directory** as a green superset — it still proves the in-scope files pass and cannot fail on
  the untouched (already-green, already-formatted) siblings. `### Context` always enumerates
  the exact in-scope files.
- **Batch-boundary + final gate:** `npm run validate` (full multi-tier suite +
  `check:test-pyramid`; `test:coverage` stays 100% by construction — no case removed). Run it
  once at the end of each partition and once at the very end. `validate` runs `test:coverage`
  (unit), `test:integration`, `test:parity`, `test:perf` + every `check:*`. It does **not**
  run `posix-integration`, `win-integration`, or the deno/bun/workers runtime-parity jobs —
  those are **CI-authoritative**; local proof there is per-part vitest (where runnable) +
  `check:types` + biome + the review phase.
- **Never commit on a red gate. Never `--no-verify`. Never add an ignore/suppression directive.**

---

# Partition A — test/unit/domain/** (coverage-gated: strongest §"axes 2–3" backstop, run FIRST)

Boundary checkpoint: `npm run validate` after Parts 1–9 land (coverage holds 100% by
construction — no case removed). 195 files across 30 subdirs + 3 root files; ~90 flagged.

## Part 1 — domain/objects + storage + commit + root

### Context
In scope (33 files): `test/unit/domain/objects/**` (18 — incl `object-id.test.ts` 405,
`tag.test.ts` 1019, `commit.test.ts` 822, `file-mode.test.ts` 268; `.properties` siblings
`commit-message`/`file-mode`/`header`/`tag` are structure-only), `test/unit/domain/storage/**`
(8), `test/unit/domain/commit/**` (4), and the 3 domain root files
`test/unit/domain/{error,remote,working-tree-path}.test.ts`. No >1.5k giant here.
**Drop-sut dense** (design §5 worked examples `crc32`/`object-id` live here): `object-id`
SHA/hex factory rows, `file-mode` octal parses, `encoding` codecs, `commit`/`tag` header
fields — bind outcomes to `result`, drop `sut`; `error.test.ts` keeps per-row `.data`.
Apply the §5 procedure + drop-sut/collapse/no-delete rules; skip already-canonical files.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/objects test/unit/domain/storage test/unit/domain/commit test/unit/domain/error.test.ts test/unit/domain/remote.test.ts test/unit/domain/working-tree-path.test.ts` green; note per-file `it()`/case counts.
2. **CONFORM**: apply axes 1–3 per file; collapse same-act/same-oracle families to `it.each` (union matrix); `*.properties` bodies byte-preserved. Re-run green.
3. **VERIFY**: `sut` dropped for functions/static factories (object-under-test keeps `sut`); all three AAA markers own a statement; one zone per subject+event; no case dropped/added.

### Gate
`npx vitest run test/unit/domain/objects test/unit/domain/storage test/unit/domain/commit test/unit/domain/error.test.ts test/unit/domain/remote.test.ts test/unit/domain/working-tree-path.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/objects test/unit/domain/storage test/unit/domain/commit test/unit/domain/error.test.ts test/unit/domain/remote.test.ts test/unit/domain/working-tree-path.test.ts`

### Commit
`test(unit): conform domain/objects+storage+commit to sut/AAA/GWT convention`

## Part 2 — domain/diff (remaining) + range-diff

### Context
In scope (29 files): `test/unit/domain/diff/**` **excluding** `patch-serializer.test.ts`
(the giant — Part 3), i.e. 15 files; plus `test/unit/domain/range-diff/**` (14). Diff/patch
family — `sut = diffX(…)` result-in-sut is the dominant anti-pattern → rename to `result`;
zone-regroup scattered Given+When; collapse same-oracle input families (design §5 `index-diff`
example pattern). `.properties` siblings structure-only. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/diff test/unit/domain/range-diff` green (this superset includes `patch-serializer`, untouched here); note counts for the 15+14 in-scope files.
2. **CONFORM**: axes 1–3 on the 15 diff-rest + 14 range-diff files; leave `patch-serializer.test.ts` for Part 3. Re-run green.
3. **VERIFY**: drop-sut applied to function results; zones clustered; no assertion/case change.

### Gate
`npx vitest run test/unit/domain/diff test/unit/domain/range-diff && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/range-diff $(git -C . ls-files 'test/unit/domain/diff/*.test.ts' | grep -v patch-serializer)`

### Commit
`test(unit): conform domain/diff+range-diff to sut/AAA/GWT convention`

## Part 3 — domain/diff/patch-serializer [GIANT, 2839 LOC]

### Context
In scope (1 file): `test/unit/domain/diff/patch-serializer.test.ts` (2839). Genuine
subsystem, dedicated for review. Dense `sut = serializePatch(…)`/`parsePatch(…)` result-in-sut
→ drop-sut to `result`; heavy zone-regroup + same-oracle `it.each` collapse opportunity across
patch-format families. Watch round-trip pairs — keep every distinguishing byte-format input as
a KEEP leaf or COLLAPSE row. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/diff/patch-serializer.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup by serialize/parse subject+event zones; collapse same-oracle format families (union matrix). Re-run green.
3. **VERIFY**: no format input dropped; error tests keep `.data`; AAA/GWT/`sut` discipline intact.

### Gate
`npx vitest run test/unit/domain/diff/patch-serializer.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/diff/patch-serializer.test.ts`

### Commit
`test(unit): conform domain/diff/patch-serializer to sut/AAA/GWT convention`

## Part 4 — domain/fsck/validate-object [GIANT, 3259 LOC]

### Context
In scope (1 file): `test/unit/domain/fsck/validate-object.test.ts` (3259) — the whole
`domain/fsck` dir. Object-validation rules; many `sut = validateObject(…)` result-in-sut →
`result`. Rich guard/boundary set (malformed headers, bad modes, cycles) — each guard stays
its own KEEP leaf or one `it.each` row (never merge two `if (A || B)` guards). Apply the §5
procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/fsck/validate-object.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup per validation subject+event; collapse only same-oracle families, one row per guard. Re-run green.
3. **VERIFY**: every guard/boundary preserved; `.data` error assertions intact; no case dropped.

### Gate
`npx vitest run test/unit/domain/fsck/validate-object.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/fsck/validate-object.test.ts`

### Commit
`test(unit): conform domain/fsck/validate-object to sut/AAA/GWT convention`

## Part 5 — domain/protocol + bundle + name-rev

### Context
In scope (30 files): `test/unit/domain/protocol/**` (19 — incl `upload-pack.test.ts` 1756,
kept in-batch and conformed file-by-file), `test/unit/domain/bundle/**` (3),
`test/unit/domain/name-rev/**` (8). Wire-format parsers/serialisers — round-trip and matcher
shapes; `.properties` siblings structure-only. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/protocol test/unit/domain/bundle test/unit/domain/name-rev` green; note counts.
2. **CONFORM**: axes 1–3; drop-sut on parser/serialiser results; collapse same-oracle families. Re-run green.
3. **VERIFY**: `.properties` bodies byte-preserved; zones clustered; no case change.

### Gate
`npx vitest run test/unit/domain/protocol test/unit/domain/bundle test/unit/domain/name-rev && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/protocol test/unit/domain/bundle test/unit/domain/name-rev`

### Commit
`test(unit): conform domain/protocol+bundle+name-rev to sut/AAA/GWT convention`

## Part 6 — domain/merge (remaining) + rebase + sequencer + commands + bisect

### Context
In scope (24 files): `test/unit/domain/merge/**` **excluding** `three-way-tree.test.ts`
(giant — Part 7), i.e. 7 files (incl `three-way-tree.properties.test.ts` structure-only,
`error.test.ts` keeps `.data`); plus `test/unit/domain/rebase/**` (7),
`test/unit/domain/sequencer/**` (3), `test/unit/domain/commands/**` (3 — incl `error.test.ts`
1731, conformed in-batch), `test/unit/domain/bisect/**` (4). Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/merge test/unit/domain/rebase test/unit/domain/sequencer test/unit/domain/commands test/unit/domain/bisect` green (superset includes `three-way-tree`, untouched here); note counts.
2. **CONFORM**: axes 1–3 on the in-scope files; leave `three-way-tree.test.ts` for Part 7. Re-run green.
3. **VERIFY**: drop-sut applied; error `.data` kept; zones clustered; no case change.

### Gate
`npx vitest run test/unit/domain/merge test/unit/domain/rebase test/unit/domain/sequencer test/unit/domain/commands test/unit/domain/bisect && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/rebase test/unit/domain/sequencer test/unit/domain/commands test/unit/domain/bisect $(git -C . ls-files 'test/unit/domain/merge/*.test.ts' | grep -v '^test/unit/domain/merge/three-way-tree.test.ts$')`

### Commit
`test(unit): conform domain/merge+rebase+sequencer to sut/AAA/GWT convention`

## Part 7 — domain/merge/three-way-tree [GIANT, 1870 LOC]

### Context
In scope (1 file): `test/unit/domain/merge/three-way-tree.test.ts` (1870). Tree-merge scenarios;
`sut = threeWayMergeTree(…)` result-in-sut → `result`. Dense scenario matrix (add/add,
modify/delete, rename conflicts) — cluster per conflict-class zone, collapse same-oracle
scenarios to `it.each`, keep every conflict-class its own row. Apply the §5 procedure.
(Its `.properties` sibling is conformed in Part 6.)

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/merge/three-way-tree.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup by conflict-class subject+event; collapse same-oracle scenarios (union matrix). Re-run green.
3. **VERIFY**: every conflict class preserved; no oracle weakened; AAA/GWT/`sut` intact.

### Gate
`npx vitest run test/unit/domain/merge/three-way-tree.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/merge/three-way-tree.test.ts`

### Commit
`test(unit): conform domain/merge/three-way-tree to sut/AAA/GWT convention`

## Part 8 — domain/refs + reflog + notes + describe + shortlog + blame + grep

### Context
In scope (34 files): `test/unit/domain/refs/**` (10), `reflog/**` (5), `notes/**` (5),
`describe/**` (6), `shortlog/**` (4), `blame/**` (2), `grep/**` (2). Refs & reporting family;
mixed function/object SUTs — apply drop-sut only to function/static-factory results, keep
`sut` where an object is exercised. `.properties` siblings structure-only. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/refs test/unit/domain/reflog test/unit/domain/notes test/unit/domain/describe test/unit/domain/shortlog test/unit/domain/blame test/unit/domain/grep` green; note counts.
2. **CONFORM**: axes 1–3; collapse same-oracle families. Re-run green.
3. **VERIFY**: object-under-test tests keep `sut`; zones clustered; no case change.

### Gate
`npx vitest run test/unit/domain/refs test/unit/domain/reflog test/unit/domain/notes test/unit/domain/describe test/unit/domain/shortlog test/unit/domain/blame test/unit/domain/grep && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/refs test/unit/domain/reflog test/unit/domain/notes test/unit/domain/describe test/unit/domain/shortlog test/unit/domain/blame test/unit/domain/grep`

### Commit
`test(unit): conform domain/refs+reflog+notes+reporting to sut/AAA/GWT convention`

## Part 9 — domain/git-index + attributes + ignore + pathspec + sparse + submodule + worktree + archive + repository

### Context
In scope (44 files): `test/unit/domain/git-index/**` (7), `attributes/**` (7), `ignore/**` (5),
`pathspec/**` (5), `sparse/**` (3), `submodule/**` (8), `worktree/**` (4), `archive/**` (4),
`repository/**` (1). Index/path-matching/worktree family; mostly small, high skip-canonical
rate. `pathspec`/`ignore`/`attributes` carry parser/matcher `.properties` siblings — structure
only. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/git-index test/unit/domain/attributes test/unit/domain/ignore test/unit/domain/pathspec test/unit/domain/sparse test/unit/domain/submodule test/unit/domain/worktree test/unit/domain/archive test/unit/domain/repository` green; note counts.
2. **CONFORM**: axes 1–3; drop-sut on matcher/parser results; collapse same-oracle families. Re-run green.
3. **VERIFY**: `.properties` bodies byte-preserved; matcher `sut` rules applied; no case change.

### Gate
`npx vitest run test/unit/domain/git-index test/unit/domain/attributes test/unit/domain/ignore test/unit/domain/pathspec test/unit/domain/sparse test/unit/domain/submodule test/unit/domain/worktree test/unit/domain/archive test/unit/domain/repository && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/git-index test/unit/domain/attributes test/unit/domain/ignore test/unit/domain/pathspec test/unit/domain/sparse test/unit/domain/submodule test/unit/domain/worktree test/unit/domain/archive test/unit/domain/repository`

### Commit
`test(unit): conform domain/git-index+paths+worktree to sut/AAA/GWT convention`

---

# Partition B — test/unit/{operators,ports,adapters}/** (coverage-gated)

Boundary checkpoint: `npm run validate` after Parts 10–11 land.

## Part 10 — adapters/node/node-file-system-injected [GIANT, 3139 LOC]

### Context
In scope (1 file): `test/unit/adapters/node/node-file-system-injected.test.ts` (3139). FS-adapter
behaviour with injected seams. Note the object-under-test exclusion: a `sut = new NodeFileSystem(…)`
then `sut.readFile(…)` is **correct — keep `sut`**; drop-sut applies only to pure helper results.
Watch the macOS platform-independent injected ENOENT branch (already covered post-#241 — do not
touch its assertion). Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts` green; note case count.
2. **CONFORM**: keep `sut` for the FS object; regroup per operation subject+event; add/repair AAA markers; collapse same-oracle families. Re-run green.
3. **VERIFY**: object-under-test `sut` preserved; error `.data` kept; no case change.

### Gate
`npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/adapters/node/node-file-system-injected.test.ts`

### Commit
`test(unit): conform adapters/node-file-system-injected to sut/AAA/GWT convention`

## Part 11 — adapters (remaining) + operators + ports

### Context
In scope (48 files): `test/unit/adapters/**` **excluding** `node/node-file-system-injected.test.ts`
(giant — Part 10) — `adapters/memory/**` (7), `adapters/node/**` (11 remaining, incl
`node-file-system.properties.test.ts` structure-only), `adapters/snapshot-resolvers/**` (12),
and adapter root `adapters/{adler32,inflate,inflate.properties}.test.ts` (3); plus
`test/unit/operators/**` (13) and `test/unit/ports/**` (2). **`operators/map.test.ts` is the
north-star exemplar — already canonical; skip it** (design §"North star"). Operators are largely
canonical (heuristic ~4 of 13 flagged); `crc32`/`adler32`/`inflate` are drop-sut. Apply the §5
procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/adapters test/unit/operators test/unit/ports` green (superset includes the injected giant, untouched here); note counts.
2. **CONFORM**: axes 1–3 on the in-scope files; skip `map.test.ts` and any already-canonical operator; leave the injected giant for Part 10. Re-run green.
3. **VERIFY**: object-under-test `sut` preserved (e.g. `NodeHashService`); `.properties` bodies byte-preserved; no case change.

### Gate
`npx vitest run test/unit/adapters test/unit/operators test/unit/ports && npm run check:types && ./node_modules/.bin/biome check test/unit/operators test/unit/ports test/unit/adapters/memory test/unit/adapters/snapshot-resolvers test/unit/adapters/adler32.test.ts test/unit/adapters/inflate.test.ts test/unit/adapters/inflate.properties.test.ts $(git -C . ls-files 'test/unit/adapters/node/*.test.ts' | grep -v '^test/unit/adapters/node/node-file-system-injected.test.ts$')`

### Commit
`test(unit): conform adapters+operators+ports to sut/AAA/GWT convention`

---

# Partition C — test/unit/{repository,transport,api-surface}/** + unit root (small non-gated unit)

Boundary checkpoint: `npm run validate` after Part 12 lands. These are still `tier: 'unit'` for
`check:test-pyramid`, so axes 2–3 titles remain gated.

## Part 12 — repository + transport + api-surface + unit root

### Context
In scope (23 files): `test/unit/repository/**` (11), `test/unit/transport/**` (3),
`test/unit/api-surface/**` (2), and the 7 unit root files
`test/unit/{adapter-detect,dispose-adapters,index.browser,index.default,index.node,progress,public-types}.test.ts`.
`repository`/`index.*` mostly exercise `sut = openRepository(…)` then `sut.method()` — **keep
`sut`** (object-under-test); `result` binds the method outcome. Transport middleware belongs in
integration by nature but these unit files conform structurally. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/repository test/unit/transport test/unit/api-surface test/unit/adapter-detect.test.ts test/unit/dispose-adapters.test.ts test/unit/index.browser.test.ts test/unit/index.default.test.ts test/unit/index.node.test.ts test/unit/progress.test.ts test/unit/public-types.test.ts` green; note counts.
2. **CONFORM**: keep `sut` for repository objects; drop-sut only for pure helpers; repair AAA; cluster zones. Re-run green.
3. **VERIFY**: object-under-test `sut` preserved; no case change.

### Gate
`npx vitest run test/unit/repository test/unit/transport test/unit/api-surface test/unit/adapter-detect.test.ts test/unit/dispose-adapters.test.ts test/unit/index.browser.test.ts test/unit/index.default.test.ts test/unit/index.node.test.ts test/unit/progress.test.ts test/unit/public-types.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/repository test/unit/transport test/unit/api-surface test/unit/adapter-detect.test.ts test/unit/dispose-adapters.test.ts test/unit/index.browser.test.ts test/unit/index.default.test.ts test/unit/index.node.test.ts test/unit/progress.test.ts test/unit/public-types.test.ts`

### Commit
`test(unit): conform repository+transport+api-surface to sut/AAA/GWT convention`

---

# Partition D — test/unit/application/** (coverage-gated; largest surface — primitives then commands)

Boundary checkpoint: `npm run validate` after Parts 13–27 land. 217 files (primitives 120,
commands 97); ~119 flagged. Fully pyramid-gated, so axes 2–3 titles keep their backstop.

## Part 13 — application/primitives/config-read [GIANT, 6131 LOC]

### Context
In scope (1 file): `test/unit/application/primitives/config-read.test.ts` (6131) — the largest
file in the tree. `sut = readConfig(…)` result-in-sut → `result`. Very dense same-oracle
config-parse families → large `it.each` collapse opportunity (union matrix; one row per
distinguishing config-syntax input; keep the git-config value-quoting-gap cases distinct).
`config-read.properties.test.ts` is structure-only and rides Part 16. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/config-read.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup per config-key/section subject+event; collapse same-oracle parse families. Re-run green.
3. **VERIFY**: every distinguishing config input preserved; no oracle weakened; AAA/GWT/`sut` intact.

### Gate
`npx vitest run test/unit/application/primitives/config-read.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/config-read.test.ts`

### Commit
`test(unit): conform application/primitives/config-read to sut/AAA/GWT convention`

## Part 14 — application/primitives/update-config [GIANT, 5070 LOC]

### Context
In scope (1 file): `test/unit/application/primitives/update-config.test.ts` (5070).
`sut = updateConfig(…)` result-in-sut → `result`; dense set/unset/rename families → collapse to
`it.each` (union matrix). `update-config.properties.test.ts` is structure-only and rides Part 17.
Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/update-config.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup per mutation subject+event; collapse same-oracle families. Re-run green.
3. **VERIFY**: every distinguishing input preserved; error `.data` kept; discipline intact.

### Gate
`npx vitest run test/unit/application/primitives/update-config.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/update-config.test.ts`

### Commit
`test(unit): conform application/primitives/update-config to sut/AAA/GWT convention`

## Part 15 — application/primitives/detect-similarity-renames [GIANT, 3818 LOC]

### Context
In scope (1 file): `test/unit/application/primitives/detect-similarity-renames.test.ts` (3818).
`sut = detectSimilarityRenames(…)` result-in-sut → `result`. Similarity-threshold boundary set —
keep each threshold/boundary its own KEEP leaf or `it.each` row. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/detect-similarity-renames.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup per rename-scenario subject+event; collapse same-oracle families, one row per threshold boundary. Re-run green.
3. **VERIFY**: every boundary preserved; no oracle weakened; discipline intact.

### Gate
`npx vitest run test/unit/application/primitives/detect-similarity-renames.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/detect-similarity-renames.test.ts`

### Commit
`test(unit): conform application/primitives/detect-similarity-renames to sut/AAA/GWT convention`

## Part 16 — application/primitives root (group 1: apply-changeset … object-resolver)

### Context
In scope (42 files): `test/unit/application/primitives/*.test.ts` at maxdepth 1, basenames
`apply-changeset.test.ts` **through** `object-resolver.test.ts` (sorted), **excluding** the two
giants in that range `config-read.test.ts` (Part 13) and `detect-similarity-renames.test.ts`
(Part 15). Anchors: `fetch-pack.test.ts` (1939), `object-resolver.test.ts` (1365),
`materialise-patch-files.test.ts` (1324), `apply-changeset.test.ts` (1249),
`apply-merge-to-worktree.test.ts` (1117 — design §5 worked example), `diff-trees.test.ts` (1078).
Structure-only `.properties` siblings in range: `config-int`, `config-read`, `enumerate-objects`,
`find-would-overwrite`, `merge-base`. Mixed function/object SUTs — apply drop-sut per rule.
Apply the §5 procedure. The gate targets the whole `primitives` dir as a green superset.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives` green; note counts for the 42 in-scope files.
2. **CONFORM**: axes 1–3 on the in-scope range only (leave the three giants + group-2 files); collapse same-oracle families. Re-run green.
3. **VERIFY**: `apply-merge-to-worktree` regrouped by stash/merge scenario (design §5); `.properties` bodies byte-preserved; no case change.

### Gate
`npx vitest run test/unit/application/primitives && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives`

### Commit
`test(unit): conform application/primitives (a–object-resolver) to sut/AAA/GWT convention`

## Part 17 — application/primitives root (group 2: pack-registry … write-tree)

### Context
In scope (43 files): `test/unit/application/primitives/*.test.ts` at maxdepth 1, basenames
`pack-registry.test.ts` **through** `write-tree.test.ts` (sorted), **excluding** the giant
`update-config.test.ts` (Part 14). Anchors: `stream-blob.test.ts` (951), `walk-commits.test.ts`
(796), `walk-submodules.test.ts` (755), `read-object.test.ts` (647), `run-hook.test.ts` (620),
`build-index-from-tree.test.ts` (589), `sign-payload.test.ts` (585). Structure-only `.properties`
siblings in range: `parse-gitmodules`, `update-config`. Apply the §5 procedure. Gate targets the
whole `primitives` dir as a green superset.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives` green; note counts for the 43 in-scope files.
2. **CONFORM**: axes 1–3 on the in-scope range only (leave the giant + group-1 files); collapse same-oracle families. Re-run green.
3. **VERIFY**: object-under-test `sut` preserved where a built object is exercised; `.properties` bodies byte-preserved; no case change.

### Gate
`npx vitest run test/unit/application/primitives && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives`

### Commit
`test(unit): conform application/primitives (pack-registry–write-tree) to sut/AAA/GWT convention`

## Part 18 — application/primitives/{snapshot, snapshot-operators, internal}

### Context
In scope (32 files): `test/unit/application/primitives/snapshot/**` (16),
`snapshot-operators/**` (4), `internal/**` (12). Snapshot iteration + internal helpers. Snapshot
operators mirror the top-level operators north-star shape — many likely canonical (skip those).
Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/snapshot test/unit/application/primitives/snapshot-operators test/unit/application/primitives/internal` green; note counts.
2. **CONFORM**: axes 1–3; keep `sut` for operator/object instances, drop-sut for pure helpers; collapse same-oracle families. Re-run green.
3. **VERIFY**: canonical files skipped; zones clustered; no case change.

### Gate
`npx vitest run test/unit/application/primitives/snapshot test/unit/application/primitives/snapshot-operators test/unit/application/primitives/internal && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/snapshot test/unit/application/primitives/snapshot-operators test/unit/application/primitives/internal`

### Commit
`test(unit): conform application/primitives/snapshot+internal to sut/AAA/GWT convention`

## Part 19 — application/commands/merge [GIANT, 3516 LOC]

### Context
In scope (1 file): `test/unit/application/commands/merge.test.ts` (3516) — design §5/§7 example.
`sut = await mergeRun(…)`/`applyMerge(…)` result-in-sut → `result`; regroup by
stash/fast-forward/conflict scenario (Given) and "the merge runs" (When); collapse same-oracle
scenarios to `it.each` (union matrix). Keep the user-configured-driver-overrides-built-in case
distinct. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/merge.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup per merge scenario subject+event; collapse same-oracle families. Re-run green.
3. **VERIFY**: every scenario/conflict class preserved; error `.data` kept; discipline intact.

### Gate
`npx vitest run test/unit/application/commands/merge.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/merge.test.ts`

### Commit
`test(unit): conform application/commands/merge to sut/AAA/GWT convention`

## Part 20 — application/commands/fsck [GIANT, 2471 LOC]

### Context
In scope (1 file): `test/unit/application/commands/fsck.test.ts` (2471). `sut = await fsckRun(…)`
result-in-sut → `result`; rich reachability/corruption guard set — one row per guard/boundary.
`fsck.properties.test.ts` is structure-only and rides Part 25. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/fsck.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup per check subject+event; collapse same-oracle families. Re-run green.
3. **VERIFY**: every guard preserved; error `.data` kept; discipline intact.

### Gate
`npx vitest run test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/fsck.test.ts`

### Commit
`test(unit): conform application/commands/fsck to sut/AAA/GWT convention`

## Part 21 — application/commands/fetch [GIANT, 2434 LOC]

### Context
In scope (1 file): `test/unit/application/commands/fetch.test.ts` (2434). `sut = await fetchRun(…)`
result-in-sut → `result`; regroup per negotiation/refspec scenario; collapse same-oracle families.
Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/fetch.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup per fetch scenario subject+event; collapse same-oracle families. Re-run green.
3. **VERIFY**: every refspec/negotiation case preserved; discipline intact.

### Gate
`npx vitest run test/unit/application/commands/fetch.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/fetch.test.ts`

### Commit
`test(unit): conform application/commands/fetch to sut/AAA/GWT convention`

## Part 22 — application/commands/push [GIANT, 2295 LOC]

### Context
In scope (1 file): `test/unit/application/commands/push.test.ts` (2295). `sut = await pushRun(…)`
result-in-sut → `result`; regroup per push scenario (ff/force/atomic); collapse same-oracle
families. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/push.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup per push scenario subject+event; collapse same-oracle families. Re-run green.
3. **VERIFY**: every scenario preserved; error `.data` kept; discipline intact.

### Gate
`npx vitest run test/unit/application/commands/push.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/push.test.ts`

### Commit
`test(unit): conform application/commands/push to sut/AAA/GWT convention`

## Part 23 — application/commands/rebase [GIANT, 2298 LOC]

### Context
In scope (1 file): `test/unit/application/commands/rebase.test.ts` (2298). `sut = await rebaseRun(…)`
result-in-sut → `result`; regroup per rebase scenario (linear/interactive/onto); collapse
same-oracle families; keep the submodule rebase-identity case distinct. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/rebase.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup per rebase scenario subject+event; collapse same-oracle families. Re-run green.
3. **VERIFY**: every scenario preserved; error `.data` kept; discipline intact.

### Gate
`npx vitest run test/unit/application/commands/rebase.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/rebase.test.ts`

### Commit
`test(unit): conform application/commands/rebase to sut/AAA/GWT convention`

## Part 24 — application/commands/add [GIANT, 1859 LOC]

### Context
In scope (1 file): `test/unit/application/commands/add.test.ts` (1859). `sut = await addRun(…)`
result-in-sut → `result`; regroup per add scenario (pathspec/renormalise/intent-to-add);
collapse same-oracle families. Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/add.test.ts` green; note case count.
2. **CONFORM**: drop-sut; regroup per add scenario subject+event; collapse same-oracle families. Re-run green.
3. **VERIFY**: every scenario preserved; discipline intact.

### Gate
`npx vitest run test/unit/application/commands/add.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/add.test.ts`

### Commit
`test(unit): conform application/commands/add to sut/AAA/GWT convention`

## Part 25 — application/commands root (group 1: abort-merge … log)

### Context
In scope (23 files): `test/unit/application/commands/*.test.ts` at maxdepth 1, basenames
`abort-merge.test.ts` **through** `log.test.ts` (sorted), **excluding** the giants in that range
`add.test.ts` (Part 24), `fetch.test.ts` (Part 21), `fsck.test.ts` (Part 20). Anchors:
`cherry-pick.test.ts` (1604), `checkout.test.ts` (1491), `describe.test.ts` (1437),
`grep.test.ts` (1064). Structure-only `.properties` siblings in range: `describe`, `fsck`.
Command tests mostly `sut = await run(…)` result-in-sut → `result`. Apply the §5 procedure.
Gate targets the whole `commands` dir as a green superset.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands` green; note counts for the 23 in-scope files.
2. **CONFORM**: axes 1–3 on the in-scope range only (leave the giants + group-2 + internal); collapse same-oracle families. Re-run green.
3. **VERIFY**: drop-sut applied to run results; `.properties` bodies byte-preserved; no case change.

### Gate
`npx vitest run test/unit/application/commands && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands`

### Commit
`test(unit): conform application/commands (abort-merge–log) to sut/AAA/GWT convention`

## Part 26 — application/commands root (group 2: mv … worktree)

### Context
In scope (26 files): `test/unit/application/commands/*.test.ts` at maxdepth 1, basenames
`mv.test.ts` **through** `worktree.test.ts` (sorted), **excluding** the giants `push.test.ts`
(Part 22) and `rebase.test.ts` (Part 23). Anchors: `revert.test.ts` (1471), `rev-parse.test.ts`
(1336), `remote.test.ts` (1094), `status.test.ts` (1095), `reflog.test.ts` (1065),
`stash.test.ts` (970), `submodule-*`. Command tests mostly `sut = await run(…)` result-in-sut →
`result`. Apply the §5 procedure. Gate targets the whole `commands` dir as a green superset.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands` green; note counts for the 26 in-scope files.
2. **CONFORM**: axes 1–3 on the in-scope range only (leave the giants + group-1 + internal); collapse same-oracle families. Re-run green.
3. **VERIFY**: drop-sut applied; error `.data` kept; no case change.

### Gate
`npx vitest run test/unit/application/commands && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands`

### Commit
`test(unit): conform application/commands (mv–worktree) to sut/AAA/GWT convention`

## Part 27 — application/commands/internal

### Context
In scope (42 files): `test/unit/application/commands/internal/**`. Anchors:
`git-service-session.test.ts` (1034), `url-validate.test.ts` (934 — dummy-credential fixtures
carry their existing secretlint/checkov handling; do not touch), `repo-state.test.ts` (915),
`rev-parse-grammar.test.ts` (720), `working-tree.test.ts` (660). Mixed function/object SUTs —
`rev-parse-grammar` is a parser (drop-sut on `result`), `git-service-session`/`repo-state` may be
object-under-test (`sut` kept). Apply the §5 procedure.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/internal` green; note counts.
2. **CONFORM**: axes 1–3; drop-sut for parsers, keep `sut` for session/state objects; collapse same-oracle families. Re-run green.
3. **VERIFY**: object-under-test `sut` preserved; no assertion/case change to `url-validate` fixtures; no case change.

### Gate
`npx vitest run test/unit/application/commands/internal && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/internal`

### Commit
`test(unit): conform application/commands/internal to sut/AAA/GWT convention`

---

# Partition E — test/integration/** (NOT pyramid-gated on the three axes; procedure + review carry it)

Boundary checkpoint: `npm run validate` after Parts 28–30 land (`validate` runs the default
`integration` project — it excludes `posix-only`/`win-only`, which are CI-authoritative). 102
files; ~27 flagged (most interop files spawn real git and are already clean — skip them).
**No `*.properties.test.ts` in this tier.** Preserve the interop env-hardening: never introduce a
`GIT_*` leak; keep the shared-`beforeAll` repo pattern where present.

## Part 28 — integration root (group 1: adapter-domain … merge-abort)

### Context
In scope (43 files): `test/integration/*.test.ts` at maxdepth 1, basenames
`adapter-domain-interop.test.ts` **through** `merge-abort-interop.test.ts` (sorted). Giants:
`config-interop.test.ts` (2879), `distinct-types-with-base-interop.test.ts` (1321). Most interop
files exercise `sut = openRepository(…)` then `sut.method()` — **keep `sut`**; drop-sut only for
pure helper results. Apply the §5 procedure. Gate targets the whole `integration` dir (default
project) as a green superset.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration` green; note counts for the 43 in-scope files.
2. **CONFORM**: axes 1–3 on the in-scope range only (skip already-clean interop files; keep object `sut`); collapse same-oracle families. Re-run green.
3. **VERIFY**: object-under-test `sut` preserved; no `GIT_*` env change; no assertion/case change.

### Gate
`npx vitest run test/integration && npm run check:types && ./node_modules/.bin/biome check test/integration`

### Commit
`test(integration): conform integration (adapter-domain–merge-abort) to sut/AAA/GWT convention`

## Part 29 — integration root (group 2: merge-conflict … worktree)

### Context
In scope (42 files): `test/integration/*.test.ts` at maxdepth 1, basenames
`merge-conflict-interop.test.ts` **through** `worktree-interop.test.ts` (sorted). Giants:
`missing-value-refusal-interop.test.ts` (3014), `rename-similarity-interop.test.ts` (2438).
Same object-`sut` rule as Part 28. Apply the §5 procedure. Gate targets the whole `integration`
dir as a green superset.

### TDD steps
1. **BASELINE**: `npx vitest run test/integration` green; note counts for the 42 in-scope files.
2. **CONFORM**: axes 1–3 on the in-scope range only; collapse same-oracle families. Re-run green.
3. **VERIFY**: object-under-test `sut` preserved; conflict-style peer-config note respected (compare bytes with `-c merge.conflictStyle=merge`); no assertion/case change.

### Gate
`npx vitest run test/integration && npm run check:types && ./node_modules/.bin/biome check test/integration`

### Commit
`test(integration): conform integration (merge-conflict–worktree) to sut/AAA/GWT convention`

## Part 30 — integration/{network, posix-only, win-only}

### Context
In scope (17 files): `test/integration/network/**` (10 — anchor `push-http-backend.test.ts`
1518; these are `gitAsync`/http-backend tests, run detached under CI — do not convert to sync),
`test/integration/posix-only/**` (5), `test/integration/win-only/**` (2). Platform-gated
subprojects. Apply the §5 procedure. **win-only cannot run on this macOS host** — conform its
structure + `check:types` + biome locally; the `win-integration` CI job is the runtime authority.

### TDD steps
1. **BASELINE**: `npx vitest run --project integration test/integration/network` and `npx vitest run --project posix-integration test/integration/posix-only` green; win-only conforms structurally (CI runs it). Note counts.
2. **CONFORM**: axes 1–3; keep object `sut`; keep `gitAsync` in network tests; collapse same-oracle families. Re-run the runnable projects green.
3. **VERIFY**: no sync/async regression in network tests; win-only typechecks + biome-clean; no assertion/case change.

### Gate
`npx vitest run --project integration test/integration/network && npx vitest run --project posix-integration test/integration/posix-only && npm run check:types && ./node_modules/.bin/biome check test/integration/network test/integration/posix-only test/integration/win-only`

### Commit
`test(integration): conform integration/network+platform to sut/AAA/GWT convention`

---

# Partition F — test/{parity,runtime-parity,perf}/** (NOT pyramid-gated; procedure + review + CI carry it)

Boundary checkpoint: the final `npm run validate` (runs `test:parity` + `test:perf`;
runtime-parity deno/bun/workers are CI-authoritative). 8 files; ~5 flagged.

## Part 31 — parity + runtime-parity + perf

### Context
In scope (8 files): `test/parity/{memory,node}.test.ts` (2), `test/runtime-parity/bun/parity-*.test.ts`
(2), `test/runtime-parity/deno/parity-*.test.ts` (2), `test/runtime-parity/workers/parity-memory.test.ts`
(1), `test/perf/domain/pathspec/compile-glob.perf.test.ts` (1). Parity tests assert cross-adapter
equivalence — typically `sut = openRepository(adapter)` object-under-test (**keep `sut`**). Apply
the §5 procedure. **Runtime-parity (deno/bun/workers) needs those runtimes** — conform structure
+ `check:types` + biome locally; the deno/bun/workers CI jobs are the runtime authority. Perf runs
under its own config.

### TDD steps
1. **BASELINE**: `npx vitest run --project parity test/parity` and `npx vitest run --config vitest.perf.config.ts test/perf` green; runtime-parity conforms structurally (CI runs deno/bun/workers). Note counts.
2. **CONFORM**: axes 1–3; keep object `sut`; collapse same-oracle families. Re-run the runnable runners green.
3. **VERIFY**: object-under-test `sut` preserved; runtime-parity files typecheck + biome-clean; no assertion/case change.

### Gate
`npx vitest run --project parity test/parity && npx vitest run --config vitest.perf.config.ts test/perf && npm run check:types && ./node_modules/.bin/biome check test/parity test/runtime-parity test/perf`

### Commit
`test(parity): conform parity+runtime-parity+perf to sut/AAA/GWT convention`

---

## Final gate (after Part 31)

`npm run validate` — full multi-tier suite + `check:test-pyramid` + `test:coverage` (100% by
construction). Green = behaviour-preservation proof for the whole sweep. The review phase's named
focus is **axis-1 semantics** (`sut` binds the unit / dropped per rule) and **non-unit-tier
conformance** (Partitions E–F), which no gate covers.
