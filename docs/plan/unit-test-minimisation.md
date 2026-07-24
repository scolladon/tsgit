# Plan — Unit test minimisation (backlog 27.1)

> Source: design doc `docs/design/unit-test-minimisation.md` · ADRs `498`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Nature of this work (read once, applies to every part)

This is **not feature TDD**. Every part is a **behaviour-preserving test-suite refactor
with zero `src/` delta** — no production code, no comments, no threshold/budget files move
(design §"The invariant"; ADR-498 Consequences). Per the plan-template Sizing-rules
EXCEPTION, test-suite parts with no `src/` delta are legitimately **standalone**; that is
the correct shape here, not a smell. There are no production parts and none should be
invented (design §7 Non-goals).

The "RED → GREEN → REFACTOR" cycle is re-cast for a redundancy-removal refactor:

- **BASELINE** (analog of RED): the file(s) are green on `main`; the "defect" removed is
  **redundancy** — subset/duplicate tests. Record the current green `it()` count.
- **MINIMISE** (analog of GREEN): apply KEEP/COLLAPSE/DELETE (below); minimised file(s)
  still pass vitest, typecheck, and biome — no oracle weakened, matrix = union.
- **VERIFY** (analog of REFACTOR): confirm GWT/AAA/`sut` discipline is intact and
  hand-verify any risky collapse/delete.

## Methodology (the single reference every part applies)

Apply **ADR-498 §1 KEEP / COLLAPSE / DELETE** to each `it()` under one `describe('When …')`:

- **KEEP** verbatim if its *act* (SUT call) OR *oracle* (`expect(…)` expression shape)
  differs from every sibling, OR it isolates a guard/boundary no other kept test isolates.
- **COLLAPSE** into one `it.each` when **3+ siblings** (Decision 4a) share the same act AND
  the same oracle shape, differing only in row literals. The row matrix MUST be the
  **UNION** of every sibling's distinguishing inputs and expected oracles — no input
  dropped, no oracle weakened. Canonical AFTER shape:
  `test/unit/domain/attributes/conflict-marker-size.test.ts` (design §1 "canonical AFTER").
  Use object-rows with a `then` field when a semantic label must survive (design §1
  `parseCapabilities` example).
- **DELETE** only when a test's (inputs × assertions) is a **strict subset** of *one*
  retained test (containment in both dimensions). Relocating an extra assertion into the
  retained row before deleting is part of a legal delete — it adds no new `it()`.

Apply **ADR-498 §3.2 guard-rails** — a collapse/delete is illegal (revert to KEEP) if it
would: drop a distinguishing/boundary input (min, max, each side of an off-by-one, empty,
overflow, every guard-triggering value is its own row); merge two guard conditions of an
`if (A || B)` into one row; **weaken an error assertion** (keep per-row `.data`
code/reason/value — never `toThrow(Class)`, gated by `bareClassToThrow`); or share mutable
state across `it.each` rows (each row's Arrange stays *inside* the callback — never hoist a
temp dir / built repo / adapter instance above the table).

**Preserve** GWT titles (`describe` `^Given `/`^When `, `it.each` `^Then `), AAA section
comments, and the `sut` binding exactly as the source uses it (`sutNaming` bans only
`subject`/`objectUnderTest`/`systemUnderTest`/`cut`). Unify sibling `Given` blocks into one
parameterised `Given` **only** when one truthful phrasing covers all rows (Decision 4b); keep
them separate when they name distinct behaviour classes.

**Never touch** `*.properties.test.ts` (design §4 / ADR-136 — non-substitutable, left
byte-identical, never counted as a retained test that makes an example a subset). `.skip` /
`.todo` / `.fails` blocks are left verbatim. `*.mutation.test.ts`, `*.characterization.test.ts`
and `*.laws.test.ts` files **are in scope** (they are not property files) but are frequently
KEEP-only.

**Do NOT** add tests, rename `sut`, re-order AAA sections, "improve" kept-test titles, or edit
`src/`. A genuine coverage/mutation *gap* found mid-work is surfaced, never papered over with
a smuggled new test (design §7).

**Proof obligation (ADR-498 §3.1 + §3.4).** Mutation-kill preservation is a theorem from the
union/strict-subset discipline — no Stryker run gates this PR (zero-signal in CI,
non-deterministic locally, design §"Why the outcome bar…"). For any collapse/delete the
implementer judges risky (touches a guard, boundary, or error-data test), run the reverse
hand-verification (§3.4): pick the specific mutant the dropped/merged input existed to kill,
hand-apply its replacement to `src` (or set `__STRYKER_ACTIVE_MUTANT__`), run
`npx vitest run <file>`, confirm the collapsed test still **FAILS**, then restore `src`. The
per-file/per-directory `npx vitest run` + `npm run check:types` + `biome check` is the part
gate; **`npm run test:coverage`** is run once per partition boundary (Decision 4c) and must
stay at 100% — never commit on a red gate.

## Sizing & partition scheme (ADR-498 Decision 2)

One part per subsystem directory + a dedicated part per giant file (>1500 LOC, pulled out of
its directory's part; the directory part then covers the remaining files). Small sibling dirs
are clustered to stay meaningfully sized. Parts are grouped under four partition headers run
in order **A domain → B operators/ports/adapters → C repository/transport/api-surface/root →
D application**, coverage-gated tiers first, application last (design §5). 47 parts total.

Two directory parts are intentionally large (**Part 29** application/commands remaining, 46
files; **Part 40** application/primitives remaining, 84 files): the >1500-LOC giants are
already carved out, every remaining file is <1500 LOC, and most are KEEP-only, so the diff is
modest even where the file count is high. They are one atomic commit each per the ratified
one-part-per-directory scheme.

---

# Partition A — domain/** (coverage-gated: strongest §3.3 backstop, run first)

Boundary checkpoint: `npm run test:coverage` after this partition's parts land (must hold 100%
line/branch/function/statement on `src/{domain,ports,adapters/node,adapters/memory,operators}`).

## Part 1 — domain/objects

### Context
Owns `test/unit/domain/objects/**` example/law files (dir: 18 files, 6677 LOC, 304 `it`):
`author-identity.test.ts` (935), `blob.test.ts` (109), `commit-message.test.ts` (494),
`commit.test.ts` (822), `encoding.test.ts` (623), `error.test.ts` (252),
`file-mode.test.ts` (268), `git-object.test.ts` (295), `hash-config.test.ts` (47),
`header.test.ts` (250), `object-id.test.ts` (405), `size.test.ts` (141), `tag.test.ts` (1019),
`tree.test.ts` (672). **Do NOT touch** the 4 siblings `commit-message.properties.test.ts`,
`file-mode.properties.test.ts`, `header.properties.test.ts`, `tag.properties.test.ts`.
Apply the Methodology above. Likely collapse candidates: `object-id` SHA-length/hex-charset
rows, `file-mode` octal-parse rows, `encoding` codec round-trips, `commit`/`tag` header-field
parses. Guard-rail focus: `object-id` boundary lengths (min/max/off-by-one) each stay their
own row; `error.test.ts` and every `*Error` assertion keeps per-row `.data` (code/reason) —
never collapse to `toThrow(Class)`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/objects` green on `main`; note the per-file
   `it()` counts (the "redundancy" to remove is subset/duplicate rows).
2. **MINIMISE**: apply KEEP/COLLAPSE/DELETE per file; matrix = union of distinguishing inputs;
   error tests keep per-row `.data`. Re-run `npx vitest run test/unit/domain/objects` green.
3. **VERIFY**: GWT/AAA/`sut` intact; hand-verify (§3.4) any collapsed `object-id` boundary or
   `file-mode` guard row — activate the specific mutant, confirm the collapsed test still fails.

### Gate
`npx vitest run test/unit/domain/objects && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/objects`

### Commit
`test(unit): minimise domain/objects`

## Part 2 — domain/storage

### Context
Owns `test/unit/domain/storage/**` (8 files, 4574 LOC, 219 `it`, no property siblings):
`crc32.test.ts` (145), `delta.test.ts` (1032), `error.test.ts` (121), `loose-path.test.ts`
(128), `lru-cache.test.ts` (608), `pack-entry.test.ts` (833), `pack-index.test.ts` (1104),
`pack-writer.test.ts` (603). Apply the Methodology. Collapse candidates: `crc32`/`delta`
byte-vector rows, `lru-cache` eviction sequences, `pack-index` fanout lookups. Guard-rail
focus: `pack-index` fanout **binary-search boundaries** (first/last/absent oid, off-by-one)
each stay their own row; `delta` copy/insert opcode boundaries stay isolated; `error.test.ts`
keeps per-row `.data`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/storage` green; note `it()` counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; fanout/opcode boundary rows preserved as the union.
   Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) any collapsed fanout-boundary or delta-opcode
   row.

### Gate
`npx vitest run test/unit/domain/storage && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/storage`

### Commit
`test(unit): minimise domain/storage`

## Part 3 — domain/diff (remaining)

### Context
Owns `test/unit/domain/diff/**` **except** the giant `patch-serializer.test.ts` (Part 4) and
the 3 property siblings (`patch-serializer.properties`, `similarity.properties`,
`whitespace.properties`). Remaining example/law files (12): `change-path.test.ts` (143),
`classify-unmerged.test.ts` (52, already `it.each`), `error.test.ts` (88), `index-diff.test.ts`
(1102), `line-diff.test.ts` (795), `mode-kind.test.ts` (217), `path-compare.test.ts` (103),
`rename-detect.test.ts` (343), `similarity.test.ts` (793), `stat-fields.test.ts` (395),
`tree-diff.test.ts` (382), `whitespace.test.ts` (737). Dir census: 16 files / 8850 LOC / 385
`it`. Apply the Methodology. Collapse candidates: `line-diff`/`whitespace` input-line rows,
`mode-kind`/`path-compare` enum rows, `similarity` score rows. Guard-rail focus: similarity
threshold boundaries and whitespace-flag combinations stay isolated; `error.test.ts` keeps
per-row `.data`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/diff` green (giant included, unchanged & green).
2. **MINIMISE**: KEEP/COLLAPSE/DELETE on the 12 owned files only; leave `patch-serializer.test.ts`
   and property files byte-identical. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) any collapsed similarity-threshold or
   whitespace-flag boundary row.

### Gate
`npx vitest run test/unit/domain/diff && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/diff`

### Commit
`test(unit): minimise domain/diff`

## Part 4 — domain/diff/patch-serializer (giant)

### Context
Owns the single giant `test/unit/domain/diff/patch-serializer.test.ts` (3098 LOC). Its
property sibling `patch-serializer.properties.test.ts` is **out of scope**. Apply the
Methodology. This is a serialize/format-heavy suite: expect many 3+ sibling groups sharing
`serialize(patch) → toEqual(bytes)` differing only by fixture — prime collapse territory.
Guard-rail focus: hunk-header edge cases (empty hunk, single-line, no-newline-at-eof, binary
patch) each stay their own row; never weaken a byte-exact `toEqual` to a shape check.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/diff/patch-serializer.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous `serialize → toEqual(bytes)` groups over the union of
   fixtures; keep each format-edge row distinct. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; byte-exact oracles preserved; hand-verify (§3.4) a
   no-newline-at-eof / binary-patch edge row.

### Gate
`npx vitest run test/unit/domain/diff/patch-serializer.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/diff/patch-serializer.test.ts`

### Commit
`test(unit): minimise domain/diff/patch-serializer`

## Part 5 — domain/merge (remaining)

### Context
Owns `test/unit/domain/merge/**` **except** the giant `three-way-tree.test.ts` (Part 6) and
the 2 property siblings (`region-merge.properties`, `three-way-tree.properties`). Remaining
files (5): `conflict-markers.test.ts` (313), `error.test.ts` (101), `merge-labels.test.ts`
(128), `region-merge.test.ts` (594), `three-way-content.test.ts` (1013). Dir census: 8 files /
4451 LOC / 205 `it`. Apply the Methodology. Collapse candidates: `three-way-content` A/B/base
region rows, `conflict-markers` marker-size rows. Guard-rail focus: conflict vs clean-merge
boundary rows stay isolated; `error.test.ts` keeps per-row `.data`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/merge` green (giant unchanged & green).
2. **MINIMISE**: KEEP/COLLAPSE/DELETE on the 5 owned files; leave giant + property files
   byte-identical. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) any collapsed conflict/clean boundary row.

### Gate
`npx vitest run test/unit/domain/merge && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/merge`

### Commit
`test(unit): minimise domain/merge`

## Part 6 — domain/merge/three-way-tree (giant)

### Context
Owns the single giant `test/unit/domain/merge/three-way-tree.test.ts` (2192 LOC). Already uses
`it.each` in places (target pattern) — lighter touch expected. Property sibling out of scope.
Apply the Methodology. Guard-rail focus: each three-way tree merge outcome class (add/add,
modify/delete, rename, directory/file) stays a distinct row; conflict `.data` preserved
per-row.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/merge/three-way-tree.test.ts` green; note count.
2. **MINIMISE**: collapse remaining 3+ homogeneous groups over the union; keep each outcome
   class isolated. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a modify/delete or rename conflict row.

### Gate
`npx vitest run test/unit/domain/merge/three-way-tree.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/merge/three-way-tree.test.ts`

### Commit
`test(unit): minimise domain/merge/three-way-tree`

## Part 7 — domain/protocol (remaining) + domain/protocol/v2

### Context
Owns `test/unit/domain/protocol/**` **except** the giant `upload-pack.test.ts` (Part 8), plus
the whole `test/unit/domain/protocol/v2/**` subdir (clustered — small). **Do NOT touch** the
property siblings (`upload-pack.properties`, and under v2 `capabilities.properties`,
`fetch.properties`, `ls-refs.properties`, `sections.properties`). Owned protocol files (9):
`capabilities.test.ts` (346, already `it.each`), `error.test.ts` (399, already `it.each`),
`object-filter.test.ts` (359, already `it.each`), `pkt-line.laws.test.ts` (102),
`pkt-line.test.ts` (807), `receive-pack-integration.test.ts` (64), `receive-pack.test.ts`
(736), `side-band.test.ts` (292), `upload-pack-integration.test.ts` (123). Owned v2 files (4):
`capabilities.test.ts` (293), `fetch.test.ts` (377), `ls-refs.test.ts` (607),
`sections.test.ts` (205). Census: protocol 11 files / 5208 LOC / 143 `it`; v2 8 files / 2022
LOC / 66 `it`. Apply the Methodology. Guard-rail focus: `pkt-line` length-prefix boundaries
(flush-pkt, empty, max-length) stay isolated; `error.test.ts` files keep per-row `.data`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/protocol` green (giant + properties unchanged).
2. **MINIMISE**: KEEP/COLLAPSE/DELETE on the 13 owned files; leave giant + property files
   byte-identical. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a pkt-line length-prefix boundary row.

### Gate
`npx vitest run test/unit/domain/protocol && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/protocol`

### Commit
`test(unit): minimise domain/protocol`

## Part 8 — domain/protocol/upload-pack (giant)

### Context
Owns the single giant `test/unit/domain/protocol/upload-pack.test.ts` (1911 LOC). Property
sibling out of scope. Apply the Methodology. Guard-rail focus: negotiation state rows
(have/want/ack/nak, shallow/deepen) each stay distinct; capability-parse guards isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/protocol/upload-pack.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous 3+ groups over the union; keep each negotiation-state
   class isolated. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a shallow/deepen or ack/nak boundary row.

### Gate
`npx vitest run test/unit/domain/protocol/upload-pack.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/protocol/upload-pack.test.ts`

### Commit
`test(unit): minimise domain/protocol/upload-pack`

## Part 9 — domain/git-index (remaining)

### Context
Owns `test/unit/domain/git-index/**` **except** the giant `index-parser.test.ts` (Part 10) and
the property sibling `index-parser.properties.test.ts`. Remaining files (5): `error.test.ts`
(79), `index-entry.test.ts` (378), `index-writer.test.ts` (574), `path-validator.test.ts`
(223), `trailer-sha.test.ts` (88). Census: 7 files / 2939 LOC / 119 `it`. Apply the
Methodology. Guard-rail focus: `index-writer`/`index-entry` byte-layout boundaries and
`path-validator` guard conditions (each `if (A || B)` branch) stay isolated; `error.test.ts`
keeps per-row `.data`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/git-index` green (giant + property unchanged).
2. **MINIMISE**: KEEP/COLLAPSE/DELETE on the 5 owned files. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `path-validator` guard row and an
   `index-writer` byte-layout boundary.

### Gate
`npx vitest run test/unit/domain/git-index && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/git-index`

### Commit
`test(unit): minimise domain/git-index`

## Part 10 — domain/git-index/index-parser (giant)

### Context
Owns the single giant `test/unit/domain/git-index/index-parser.test.ts` (1518 LOC). Property
sibling out of scope. Apply the Methodology — parse-heavy suite, prime collapse territory for
`parse(bytes) → toEqual(entry)` groups. Guard-rail focus: version/extension/truncation
boundaries and malformed-index error `.data` rows stay isolated; never weaken byte-exact
oracles.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/git-index/index-parser.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous parse groups over the union; keep each format-edge/error
   row distinct with per-row `.data`. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a truncation/malformed-index error row.

### Gate
`npx vitest run test/unit/domain/git-index/index-parser.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/git-index/index-parser.test.ts`

### Commit
`test(unit): minimise domain/git-index/index-parser`

## Part 11 — domain/fsck/validate-object (giant = whole fsck dir)

### Context
Owns the single giant `test/unit/domain/fsck/validate-object.test.ts` (3785 LOC) — the entire
`domain/fsck` directory (1 file, 151 `it`). Apply the Methodology. This is a heavily
error-data-driven suite (fsck reports keyed by object-type violation). Guard-rail focus:
**every distinct fsck violation code is its own row with per-row `.data`** — do not merge two
violation classes into one row, never collapse to `toThrow(Class)`. Collapse only true 3+
same-code, same-oracle groups differing by fixture.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/fsck/validate-object.test.ts` green; note count.
2. **MINIMISE**: collapse only same-violation-code homogeneous groups over the union; each
   violation code keeps a distinct row + `.data`. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) two representative violation-code rows —
   activate the mutant that flips each report, confirm the collapsed row still fails.

### Gate
`npx vitest run test/unit/domain/fsck/validate-object.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/fsck/validate-object.test.ts`

### Commit
`test(unit): minimise domain/fsck/validate-object`

## Part 12 — domain/commands/error (giant)

### Context
Owns the single giant `test/unit/domain/commands/error.test.ts` (1801 LOC, already partly
`it.each`). Its sibling `config-key.test.ts` (Part 21) and `config-key.properties.test.ts`
(out of scope) are NOT this part's. Apply the Methodology. Error-catalogue suite: guard-rail
focus is **per-row error `.data` (code/reason/value)** for every distinct error — never
collapse two error codes into one row, never `toThrow(Class)`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/commands/error.test.ts` green; note count.
2. **MINIMISE**: collapse only same-error-shape homogeneous groups over the union; each error
   code keeps a distinct `.data` row. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) two representative error-code rows.

### Gate
`npx vitest run test/unit/domain/commands/error.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/commands/error.test.ts`

### Commit
`test(unit): minimise domain/commands/error`

## Part 13 — domain/refs

### Context
Owns `test/unit/domain/refs/**` (10 files, 1909 LOC, 106 `it`, no property siblings):
`error.test.ts` (75), `loose-ref.test.ts` (294), `packed-refs.test.ts` (551), `peel.test.ts`
(98), `per-worktree-ref.test.ts` (54, already `it.each`), `ref-candidates.test.ts` (73),
`ref-prefixes.test.ts` (11), `ref-validation.test.ts` (672), `short-branch-name.test.ts` (40),
`state-files.test.ts` (41). Apply the Methodology. `ref-validation` is a rich guard suite:
guard-rail focus: each refname rule (`if (A || B || …)` branch — leading dot, double-slash,
`@{`, control chars, trailing `.lock`, …) keeps a **separate row per guard condition**
(CLAUDE.md mutation-resistant patterns). Collapse only genuinely homogeneous accept/reject
groups.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/refs` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; ref-validation guard conditions stay one row each.
   Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) two ref-validation guard rows in isolation.

### Gate
`npx vitest run test/unit/domain/refs && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/refs`

### Commit
`test(unit): minimise domain/refs`

## Part 14 — domain/reflog

### Context
Owns `test/unit/domain/reflog/**` (5 files, 1612 LOC, 124 `it`, no property siblings):
`approxidate.test.ts` (674), `error.test.ts` (156), `reflog-format.test.ts` (432),
`reflog-messages.test.ts` (137), `should-log.test.ts` (213). Apply the Methodology. Collapse
candidates: `approxidate` date-string parse rows, `reflog-format` line-format rows,
`should-log` predicate rows. Guard-rail focus: `approxidate` relative/absolute boundary cases
stay isolated; `error.test.ts` keeps per-row `.data`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/reflog` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; date-parse boundaries preserved as the union. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) an `approxidate` boundary row.

### Gate
`npx vitest run test/unit/domain/reflog && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/reflog`

### Commit
`test(unit): minimise domain/reflog`

## Part 15 — domain/range-diff

### Context
Owns `test/unit/domain/range-diff/**` example/characterization files **except** the 5 property
siblings (`diff-size`, `funcname`, `interleave`, `linear-assignment`, `patch-text`
`.properties`). Owned files (9): `correspond.characterization.test.ts` (103),
`correspond.test.ts` (157), `diff-size.test.ts` (79), `funcname.test.ts` (208),
`interleave.test.ts` (128), `linear-assignment.characterization.test.ts` (1211),
`linear-assignment.test.ts` (250), `patch-text.test.ts` (396), `range-diff.test.ts` (70).
Census: 14 files / 2958 LOC / 73 `it`. `.characterization.test.ts` files are in scope but
typically KEEP-only (each pins a distinct recorded behaviour). Apply the Methodology. Collapse
candidates: `funcname`/`diff-size`/`interleave` input rows. Guard-rail focus: assignment
cost-matrix boundaries stay isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/range-diff` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE on the 9 owned files; treat characterization files as
   KEEP unless a strict 3+ homogeneous group is present. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) an assignment cost boundary row if collapsed.

### Gate
`npx vitest run test/unit/domain/range-diff && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/range-diff`

### Commit
`test(unit): minimise domain/range-diff`

## Part 16 — domain/archive

### Context
Owns `test/unit/domain/archive/**` example files **except** the 2 property siblings
(`tar.properties`, `zip.properties`). Owned files (2): `tar.test.ts` (1303), `zip.test.ts`
(1078). Census: 4 files / 2873 LOC / 88 `it`. Apply the Methodology — format-heavy
serialize suites, prime collapse territory for `archive(entries) → toEqual(bytes)` groups.
Guard-rail focus: header edge cases (long path, empty entry, mode bits) stay isolated; never
weaken byte-exact `toEqual`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/archive` green; note counts.
2. **MINIMISE**: collapse homogeneous format groups over the union; keep each header-edge row.
   Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; byte-exact oracles preserved; hand-verify (§3.4) a header-edge row.

### Gate
`npx vitest run test/unit/domain/archive && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/archive`

### Commit
`test(unit): minimise domain/archive`

## Part 17 — domain/error (giant, domain root)

### Context
Owns the single giant `test/unit/domain/error.test.ts` (1548 LOC) at the `domain/` root. The
root siblings `remote.test.ts` and `working-tree-path.test.ts` belong to Part 21. Apply the
Methodology. Domain-error catalogue: guard-rail focus is **per-row error `.data`
(code/reason/value)** for every distinct error class; never merge two error classes into one
row, never `toThrow(Class)`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/error.test.ts` green; note count.
2. **MINIMISE**: collapse only same-error-shape homogeneous groups over the union; each error
   class keeps a distinct `.data` row. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) two representative error-class rows.

### Gate
`npx vitest run test/unit/domain/error.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/error.test.ts`

### Commit
`test(unit): minimise domain/error`

## Part 18 — domain path/attribute matching (attributes + ignore + pathspec + sparse)

### Context
Clustered small sibling dirs (all path/attribute matching). Owns example files only — **do NOT
touch** the property siblings under each (`attributes`: conflict-marker-size/parse-gitattributes/
resolve-attribute `.properties`; `ignore`: matcher-stack/parse-gitignore `.properties`;
`pathspec`: compile-pathspec/match-pathspec `.properties`). Owned files:
`attributes/{conflict-marker-size.test.ts (80, canonical it.each exemplar), driver-command.test.ts
(136), parse-gitattributes.test.ts (377), resolve-attribute.test.ts (306)}`;
`ignore/{match.test.ts (245), matcher-stack.test.ts (279), parse-gitignore.test.ts (560)}`;
`pathspec/{compile-glob.test.ts (372, already it.each), compile-pathspec.test.ts (153),
match-pathspec.test.ts (116)}`; `sparse/{cone.test.ts (673), non-cone.test.ts (232),
parse-sparse-checkout.test.ts (272)}`. Census `it`: attributes 61, ignore 74, pathspec 45,
sparse 66. Apply the Methodology. Guard-rail focus: glob/pathspec matcher rows keep each
distinguishing path (the design §1 DELETE-vs-COLLAPSE `compileGlob` example — merge over the
union of paths, do not subset-delete when each has a unique path); negation/precedence guards
stay isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/attributes test/unit/domain/ignore test/unit/domain/pathspec test/unit/domain/sparse` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; matcher matrices = union of distinguishing paths. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a negation/precedence guard row in `ignore` or `pathspec`.

### Gate
`npx vitest run test/unit/domain/attributes test/unit/domain/ignore test/unit/domain/pathspec test/unit/domain/sparse && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/attributes test/unit/domain/ignore test/unit/domain/pathspec test/unit/domain/sparse`

### Commit
`test(unit): minimise domain path/attribute matching suites`

## Part 19 — domain text/naming (grep + describe + shortlog + blame + name-rev)

### Context
Clustered small sibling dirs (text/naming). Owns example files only — **do NOT touch**
property siblings (`grep/matcher.properties`; `describe/{compare-candidates,match}.properties`;
`shortlog/{clean-subject,group}.properties`; `blame/split-blame.properties`;
`name-rev/{cutoff,is-better-name,ref-pattern,step}.properties`). Owned files:
`grep/matcher.test.ts (817)`; `describe/{compare-candidates.test.ts (61), match.test.ts (100),
ref-name.test.ts (95), replace-name.test.ts (143)}`; `shortlog/{clean-subject.test.ts (212),
group.test.ts (121)}`; `blame/split-blame.test.ts (160)`; `name-rev/{cutoff.test.ts (114),
is-better-name.test.ts (143), ref-pattern.test.ts (139), step.test.ts (130)}`. Census `it`:
grep 54, describe 30, shortlog 31, blame 12, name-rev 43. Apply the Methodology. Collapse
candidates: `grep/matcher` pattern rows, `name-rev` step/cutoff rows, `shortlog` clean-subject
rows. Guard-rail focus: matcher boundary/anchoring rows stay isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/grep test/unit/domain/describe test/unit/domain/shortlog test/unit/domain/blame test/unit/domain/name-rev` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; matcher matrices = union. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `grep/matcher` anchoring boundary if collapsed.

### Gate
`npx vitest run test/unit/domain/grep test/unit/domain/describe test/unit/domain/shortlog test/unit/domain/blame test/unit/domain/name-rev && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/grep test/unit/domain/describe test/unit/domain/shortlog test/unit/domain/blame test/unit/domain/name-rev`

### Commit
`test(unit): minimise domain text/naming suites`

## Part 20 — domain history/sequencing (rebase + sequencer + bisect + notes + bundle)

### Context
Clustered small sibling dirs (history/sequencing ops). Owns example files only — **do NOT
touch** property siblings (`rebase/{author-script,squash-message,todo}.properties`;
`sequencer/todo.properties`; `bisect/find-bisection.properties`; `notes/notes.properties`;
`bundle/bundle-header.properties`). Owned files: `rebase/{author-script.test.ts (319),
squash-message.test.ts (166), todo-help.test.ts (84), todo.test.ts (173)}`;
`sequencer/{operation-labels.test.ts (70), todo.test.ts (173)}`; `bisect/{estimate-steps.test.ts
(66), find-bisection.test.ts (490), weight.test.ts (114)}`; `notes/{fanout.test.ts (205),
load.test.ts (116), mutate.test.ts (327), write-plan.test.ts (187)}`;
`bundle/{parse-bundle-header.test.ts (407), serialize-bundle-header.test.ts (143)}`. Census
`it`: rebase 42, sequencer 25, bisect 39, notes 52, bundle 27. Apply the Methodology. Collapse
candidates: `todo` line-parse rows, `bisect` step/weight rows, `notes/fanout` path rows,
`bundle` header round-trips. Guard-rail focus: bisect midpoint/step off-by-one boundaries and
bundle header format edges stay isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/rebase test/unit/domain/sequencer test/unit/domain/bisect test/unit/domain/notes test/unit/domain/bundle` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; boundary rows preserved as the union. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a bisect step boundary or bundle header edge if collapsed.

### Gate
`npx vitest run test/unit/domain/rebase test/unit/domain/sequencer test/unit/domain/bisect test/unit/domain/notes test/unit/domain/bundle && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/rebase test/unit/domain/sequencer test/unit/domain/bisect test/unit/domain/notes test/unit/domain/bundle`

### Commit
`test(unit): minimise domain history/sequencing suites`

## Part 21 — domain leaf modules (commit + worktree + submodule + repository + root remainder + commands remainder)

### Context
Clustered small leaf modules and the two domain-directory remainders whose bulk was carved
into giants. Owns example files only — **do NOT touch** property siblings
(`commit/{binary-heap,priority-queue}.properties`; `submodule/{gitlink-path,relative-url}.properties`;
`commands/config-key.properties`). Owned files: `commit/{binary-heap.test.ts (205),
priority-queue.test.ts (43)}`; `worktree/{admin-files.test.ts (70), admin-id.test.ts (114,
already it.each), error.test.ts (76), resolve-path.test.ts (144)}`;
`submodule/{gitlink-path.test.ts (49, already it.each), name.test.ts (51, already it.each),
relative-url.test.ts (211), update-mode.test.ts (41)}`; `repository/error.test.ts (81)`;
domain-root remainder `remote.test.ts (11)` + `working-tree-path.test.ts (330, already it.each)`
(NOT `error.test.ts` → Part 17); `commands/config-key.test.ts (482)` (NOT `error.test.ts` →
Part 12). Census `it`: commit 21, worktree 26, submodule 45, repository 4, domain root
remainder + commands remainder are the non-giant slices of their dirs. Apply the Methodology.
Guard-rail focus: `binary-heap`/`priority-queue` ordering invariants (sift boundaries) stay
isolated; `error.test.ts` files keep per-row `.data`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/domain/commit test/unit/domain/worktree test/unit/domain/submodule test/unit/domain/repository test/unit/domain/remote.test.ts test/unit/domain/working-tree-path.test.ts test/unit/domain/commands/config-key.test.ts` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE on the owned files only (leave the giants
   `domain/error.test.ts` and `domain/commands/error.test.ts` byte-identical). Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a heap sift-boundary row if collapsed.

### Gate
`npx vitest run test/unit/domain/commit test/unit/domain/worktree test/unit/domain/submodule test/unit/domain/repository test/unit/domain/remote.test.ts test/unit/domain/working-tree-path.test.ts test/unit/domain/commands/config-key.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/commit test/unit/domain/worktree test/unit/domain/submodule test/unit/domain/repository test/unit/domain/remote.test.ts test/unit/domain/working-tree-path.test.ts test/unit/domain/commands/config-key.test.ts`

### Commit
`test(unit): minimise domain leaf-module suites`

---

# Partition B — operators/ + ports/ + adapters/** (coverage-gated)

Boundary checkpoint: `npm run test:coverage` after this partition's parts land (must hold 100%
on the gated `src` set incl. `operators`, `adapters/node`, `adapters/memory`).

## Part 22 — operators + ports

### Context
Clustered coverage-gated small dirs. Owns all of `test/unit/operators/**` (13 files, 2363 LOC,
130 `it`): `filter.test.ts` (230), `find.test.ts` (149), `fixtures.test.ts` (186),
`flat-map.test.ts` (233), `group-by.test.ts` (274), `index.test.ts` (43), `laws.test.ts` (190,
in scope — not a property file), `map.test.ts` (208), `pipe.test.ts` (192),
`readable-stream.test.ts` (126), `take.test.ts` (305), `to-array.test.ts` (180),
`types.test.ts` (47); and `test/unit/ports/**` (2 files, 326 LOC, 17 `it`): `context.test.ts`
(193), `logger.test.ts` (133). Apply the Methodology. Collapse candidates: operator input-stream
rows (`filter`/`map`/`take`/`flat-map` element sequences). Guard-rail focus: `take` count
boundaries (0, 1, N, > length) and async-iterator termination stay isolated; each operator
row's Arrange stays inside the callback (no hoisted mutable async source).

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/operators test/unit/ports` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; count/termination boundaries preserved as the union;
   no mutable async source hoisted above `it.each`. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `take` count boundary if collapsed.

### Gate
`npx vitest run test/unit/operators test/unit/ports && npm run check:types && ./node_modules/.bin/biome check test/unit/operators test/unit/ports`

### Commit
`test(unit): minimise operators and ports`

## Part 23 — adapters (root) + adapters/memory

### Context
Clustered coverage-gated adapter dirs. Owns adapters-root example files **except** the property
sibling `inflate.properties.test.ts`: `adapters/adler32.test.ts` (76),
`adapters/inflate.test.ts` (1170); and all of `test/unit/adapters/memory/**` (7 files, 2081
LOC, 99 `it`): `memory-adapter.test.ts` (250), `memory-command-runner.test.ts` (60),
`memory-compressor.test.ts` (237), `memory-file-system.test.ts` (1079),
`memory-hash-service.test.ts` (148), `memory-hook-runner.test.ts` (80),
`memory-http-transport.test.ts` (227). (Note: `adler32`/`inflate` sit at `test/unit/adapters/`
root; the root-level `test/unit/*.test.ts` files like `adapter-detect`/`dispose-adapters`
belong to Part 28.) Apply the Methodology. Collapse candidates: `inflate` byte-window rows,
`adler32` checksum rows, `memory-file-system` path-op rows. Guard-rail focus: inflate
window/back-reference boundaries and fs error-injection `.data` rows stay isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/adapters/adler32.test.ts test/unit/adapters/inflate.test.ts test/unit/adapters/memory` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; inflate/fs boundaries preserved as the union;
   `inflate.properties.test.ts` left byte-identical. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) an inflate back-reference boundary if collapsed.

### Gate
`npx vitest run test/unit/adapters/adler32.test.ts test/unit/adapters/inflate.test.ts test/unit/adapters/memory && npm run check:types && ./node_modules/.bin/biome check test/unit/adapters/adler32.test.ts test/unit/adapters/inflate.test.ts test/unit/adapters/memory`

### Commit
`test(unit): minimise adapters memory and root`

## Part 24 — adapters/node (remaining)

### Context
Owns `test/unit/adapters/node/**` **except** the giant `node-file-system-injected.test.ts`
(Part 25) and the property sibling `node-file-system.properties.test.ts`. Remaining files (10):
`node-adapter.test.ts` (363), `node-command-runner.test.ts` (290), `node-compressor.test.ts`
(462), `node-env-reader.test.ts` (46), `node-file-system.test.ts` (1392),
`node-hash-service.test.ts` (115), `node-hook-runner.test.ts` (436),
`node-http-transport.test.ts` (431), `node-ssh-transport.test.ts` (232), `path-policy.test.ts`
(290). Census: 12 files / 7387 LOC / 294 `it`. Apply the Methodology. Guard-rail focus:
`path-policy` root-containment/symlink-escape guards (each `if` branch its own row) and
`node-file-system` fs-error `.data` rows stay isolated; each row's Arrange (temp dir) stays
inside the callback — never hoist a shared mutable temp dir above `it.each`.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/adapters/node` green (giant + property unchanged).
2. **MINIMISE**: KEEP/COLLAPSE/DELETE on the 10 owned files; path-policy guards stay one row
   each; temp-dir Arrange stays inside each row. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `path-policy` containment-guard row.

### Gate
`npx vitest run test/unit/adapters/node && npm run check:types && ./node_modules/.bin/biome check test/unit/adapters/node`

### Commit
`test(unit): minimise adapters/node`

## Part 25 — adapters/node/node-file-system-injected (giant)

### Context
Owns the single giant `test/unit/adapters/node/node-file-system-injected.test.ts` (3175 LOC).
This suite injects fs errors to drive branch coverage — heavily error-data-driven. Apply the
Methodology. Guard-rail focus: **every injected fs error code (ENOENT, EEXIST, EACCES, ENOTDIR,
…) is its own row with per-row `.data`** — never merge two error codes into one row, never
`toThrow(Class)`; each row's injected-fs Arrange stays inside the callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts` green; note count.
2. **MINIMISE**: collapse only same-error-code homogeneous groups over the union; each fs error
   code keeps a distinct `.data` row. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) two representative injected-error rows.

### Gate
`npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/adapters/node/node-file-system-injected.test.ts`

### Commit
`test(unit): minimise adapters/node/node-file-system-injected`

## Part 26 — adapters/snapshot-resolvers

### Context
Owns `test/unit/adapters/snapshot-resolvers/**` example/mutation files **except** the 2
property siblings (`caching-index-resolver.properties`, `generation-view.properties`). Owned
files (10, incl. 2 `.mutation.test.ts` which are in scope): `caching-index-resolver.mutation.test.ts`
(879), `caching-index-resolver.test.ts` (231), `caching-tree-resolver.test.ts` (176),
`counter-generation-view.test.ts` (118), `fs-workdir-enumerator.mutation.test.ts` (291),
`fs-workdir-enumerator.test.ts` (201), `in-memory-write-event-bus.test.ts` (170),
`raw-index-resolver.test.ts` (107), `raw-tree-resolver.test.ts` (94),
`single-flight-index-resolver.test.ts` (141). Census: 12 files / 2565 LOC / 89 `it`. Apply the
Methodology; `.mutation.test.ts` files are frequently KEEP-only (targeted mutant kills).
Guard-rail focus: cache hit/miss/invalidation and single-flight de-dup boundaries stay isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/adapters/snapshot-resolvers` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; treat `.mutation` files as KEEP unless a strict 3+
   homogeneous group is present; property files byte-identical. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a cache-invalidation boundary if collapsed.

### Gate
`npx vitest run test/unit/adapters/snapshot-resolvers && npm run check:types && ./node_modules/.bin/biome check test/unit/adapters/snapshot-resolvers`

### Commit
`test(unit): minimise adapters/snapshot-resolvers`

---

# Partition C — repository/ + transport/ + api-surface/ + root (small, non-coverage-gated)

Boundary checkpoint: `npm run test:coverage` after this partition's parts land (these `src`
targets are not directly gated, but the run still guards domain coverage transitively — must
hold 100%).

## Part 27 — repository

### Context
Owns `test/unit/repository/**` **except** the property sibling `common-ancestor.properties.test.ts`.
Owned files (10): `common-ancestor.test.ts` (261), `compose-adapters.test.ts` (239),
`deep-freeze.test.ts` (154), `default-cwd.test.ts` (52), `find-layout.test.ts` (99),
`repository.test.ts` (1228), `snapshot-wiring.test.ts` (91), `validate-options.test.ts` (291),
`wrap-fs-validator.test.ts` (337, already `it.each`), `wrap-transport-validator.test.ts` (184).
Census: 11 files / 3061 LOC / 164 `it`. Apply the Methodology. Guard-rail focus:
`validate-options`/`wrap-*-validator` guard conditions (each `if (A || B)` branch its own row)
and `common-ancestor` path-boundary cases (drive-letter/UNC, per the recent parity fix) stay
isolated; `repository.test.ts` keys the command surface — collapse only genuinely homogeneous
groups, do not drop a command-surface assertion.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/repository` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; validator guards stay one row each. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `wrap-fs-validator` guard row if collapsed.

### Gate
`npx vitest run test/unit/repository && npm run check:types && ./node_modules/.bin/biome check test/unit/repository`

### Commit
`test(unit): minimise repository`

## Part 28 — transport + api-surface + root test/unit

### Context
Clustered small non-gated dirs + the root-level `test/unit/*.test.ts` files. Owns all of
`test/unit/transport/**` (3 files, 1390 LOC, 74 `it`, all already `it.each`):
`with-auth.test.ts` (304), `with-logging.test.ts` (332), `with-retry.test.ts` (754);
`test/unit/api-surface/**` (2 files, 197 LOC, 6 `it`): `snapshot-barrel-surface.test.ts` (88),
`snapshot-exports.test.ts` (109); and the root-level files (7 files, 1493 LOC, 83 `it`):
`adapter-detect.test.ts` (208), `dispose-adapters.test.ts` (161), `index.browser.test.ts`
(128), `index.default.test.ts` (109), `index.node.test.ts` (315), `progress.test.ts` (265),
`public-types.test.ts` (307). Apply the Methodology. `with-retry` is already parameterised —
lighter touch. Guard-rail focus: `with-retry` attempt-count/backoff boundaries stay isolated;
`api-surface`/`index.*` export-shape assertions are KEEP (each pins a distinct barrel entry —
not collapsible without weakening the surface oracle).

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/transport test/unit/api-surface test/unit/adapter-detect.test.ts test/unit/dispose-adapters.test.ts test/unit/index.browser.test.ts test/unit/index.default.test.ts test/unit/index.node.test.ts test/unit/progress.test.ts test/unit/public-types.test.ts` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; retry boundaries preserved as the union; export-surface
   assertions left as KEEP. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `with-retry` attempt-count boundary if collapsed.

### Gate
`npx vitest run test/unit/transport test/unit/api-surface test/unit/adapter-detect.test.ts test/unit/dispose-adapters.test.ts test/unit/index.browser.test.ts test/unit/index.default.test.ts test/unit/index.node.test.ts test/unit/progress.test.ts test/unit/public-types.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/transport test/unit/api-surface test/unit/adapter-detect.test.ts test/unit/dispose-adapters.test.ts test/unit/index.browser.test.ts test/unit/index.default.test.ts test/unit/index.node.test.ts test/unit/progress.test.ts test/unit/public-types.test.ts`

### Commit
`test(unit): minimise transport, api-surface, and root suites`

---

# Partition D — application/** (largest, NOT coverage-gated for its own src — leans hardest on §3.1 construction + §3.4 hand-verify; run LAST)

Boundary checkpoint: `npm run test:coverage` after this partition's parts land, then the final
`npm run validate` (which also runs `check:test-pyramid` for the §2 GWT/AAA/`sut` heuristics).
The application `src` is not directly coverage-gated, so lean on the construction proof (§3.1)
+ targeted hand-verification (§3.4) per part; the run still guards domain coverage transitively.

## Part 29 — application/commands (remaining)

### Context
Owns `test/unit/application/commands/*.test.ts` (top level of `commands`, NOT `internal/`)
**except** the 9 giants (Parts 30-38: `merge`, `fsck`, `fetch`, `push`, `rebase`, `add`,
`cherry-pick`, `checkout`, `revert`) and the property sibling `describe.properties.test.ts`.
This is a **large directory part** (~46 remaining files, each <1500 LOC; most are KEEP-heavy so
the diff is modest). Representative remaining files: `abort-merge` (478), `archive` (511),
`blame` (791), `branch` (611), `bundle-create` (670), `bundle-list-heads` (273),
`bundle-verify` (892), `cat-file` (167), `clone` (1105), `commit` (1011), `config` (439),
`continue-merge` (308), `describe` (1437), `diff` (888), `fetch-missing` (451), `fixtures`
(177), `grep` (1064), `init` (98), `log` (666), `mv` (756), `name-rev` (695), `notes` (712),
`pull` (837), `range-diff` (320), `read-file-at` (246), `reflog` (1065), `remote` (1094),
`reset` (773), `rev-parse` (1353), `rm` (831), `shortlog` (171), `show` (292),
`sparse-checkout` (732), `ssh-session-close` (103), `stash` (973), `status` (1140),
`submodule-add` (356), `submodule-sync-recursive` (89), `submodule-update` (851),
`submodule-write` (890), `submodule` (267), `tag` (681), `whatchanged` (318), `worktree` (629).
Census (whole dir incl. giants): 55 files / 48988 LOC / 1759 `it`. Apply the Methodology
file-by-file. Guard-rail focus: command refusal-condition rows keep per-row error `.data`
(never `toThrow(Class)`); every built-repo/temp-dir Arrange stays inside each `it.each` callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands` green on the owned files
   (the 9 giants + `describe.properties` unchanged & green); note per-file `it()` counts.
2. **MINIMISE**: walk each owned file; KEEP/COLLAPSE/DELETE per ADR-498; refusal-condition
   error `.data` preserved per-row; no hoisted mutable repo/temp-dir. Re-run the owned files green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a representative refusal-condition row from a
   collapsed command (e.g. `status`/`reset`/`commit`).

### Gate
`npx vitest run test/unit/application/commands && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands`

### Commit
`test(unit): minimise application/commands`

## Part 30 — application/commands/merge (giant)

### Context
Owns the single giant `test/unit/application/commands/merge.test.ts` (3701 LOC, already partly
`it.each`). Apply the Methodology. Guard-rail focus: each merge outcome/refusal class
(fast-forward, three-way, conflict, already-up-to-date, unrelated-histories, dirty-worktree
refusal) stays a distinct row with per-row `.data`; built-repo Arrange stays inside each callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/merge.test.ts` green; note count.
2. **MINIMISE**: collapse remaining homogeneous 3+ groups over the union; each outcome/refusal
   class isolated. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a conflict / dirty-worktree-refusal row.

### Gate
`npx vitest run test/unit/application/commands/merge.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/merge.test.ts`

### Commit
`test(unit): minimise application/commands/merge`

## Part 31 — application/commands/fsck (giant)

### Context
Owns the single giant `test/unit/application/commands/fsck.test.ts` (2560 LOC). Its property
sibling `fsck.properties.test.ts` is out of scope. Apply the Methodology. Guard-rail focus:
each fsck finding/report class stays a distinct row with per-row `.data`; never merge finding
classes; built-repo Arrange inside each callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/fsck.test.ts` green; note count.
2. **MINIMISE**: collapse only same-finding-class homogeneous groups over the union. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) two representative finding-class rows.

### Gate
`npx vitest run test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/fsck.test.ts`

### Commit
`test(unit): minimise application/commands/fsck`

## Part 32 — application/commands/fetch (giant)

### Context
Owns the single giant `test/unit/application/commands/fetch.test.ts` (2532 LOC). Apply the
Methodology. Guard-rail focus: negotiation/refspec/shallow outcome rows and refusal `.data`
stay isolated; each network-transport Arrange stays inside its callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/fetch.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous 3+ groups over the union; each refspec/shallow class isolated. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a shallow/refspec boundary row.

### Gate
`npx vitest run test/unit/application/commands/fetch.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/fetch.test.ts`

### Commit
`test(unit): minimise application/commands/fetch`

## Part 33 — application/commands/push (giant)

### Context
Owns the single giant `test/unit/application/commands/push.test.ts` (2376 LOC). Apply the
Methodology. Guard-rail focus: refspec/force/atomic outcome rows and rejection `.data`
(non-fast-forward, stale) stay isolated; transport Arrange inside each callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/push.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous 3+ groups over the union; each rejection class isolated. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a non-fast-forward rejection row.

### Gate
`npx vitest run test/unit/application/commands/push.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/push.test.ts`

### Commit
`test(unit): minimise application/commands/push`

## Part 34 — application/commands/rebase (giant)

### Context
Owns the single giant `test/unit/application/commands/rebase.test.ts` (2298 LOC). Apply the
Methodology. Guard-rail focus: each rebase outcome/refusal (linear, conflict, abort, continue,
onto) stays a distinct row with per-row `.data`; built-repo Arrange inside each callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/rebase.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous 3+ groups over the union; each outcome class isolated. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a conflict/abort row.

### Gate
`npx vitest run test/unit/application/commands/rebase.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/rebase.test.ts`

### Commit
`test(unit): minimise application/commands/rebase`

## Part 35 — application/commands/add (giant)

### Context
Owns the single giant `test/unit/application/commands/add.test.ts` (1969 LOC). Apply the
Methodology. Guard-rail focus: pathspec-match / ignore / index-update outcome rows and refusal
`.data` stay isolated; built-repo Arrange inside each callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/add.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous 3+ groups over the union; each pathspec/ignore class isolated. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) an ignore-precedence or pathspec boundary row.

### Gate
`npx vitest run test/unit/application/commands/add.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/add.test.ts`

### Commit
`test(unit): minimise application/commands/add`

## Part 36 — application/commands/cherry-pick (giant)

### Context
Owns the single giant `test/unit/application/commands/cherry-pick.test.ts` (1736 LOC). Apply
the Methodology. Guard-rail focus: each cherry-pick outcome/refusal (clean, conflict, empty,
continue, abort) stays a distinct row with per-row `.data`; built-repo Arrange inside each callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/cherry-pick.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous 3+ groups over the union; each outcome class isolated. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a conflict/empty-commit row.

### Gate
`npx vitest run test/unit/application/commands/cherry-pick.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/cherry-pick.test.ts`

### Commit
`test(unit): minimise application/commands/cherry-pick`

## Part 37 — application/commands/checkout (giant)

### Context
Owns the single giant `test/unit/application/commands/checkout.test.ts` (1629 LOC). Apply the
Methodology. Guard-rail focus: each checkout outcome/refusal (branch switch, detached, path
checkout, would-overwrite refusal, symlink-replacement per the recent parity fix) stays a
distinct row with per-row `.data`; built-repo Arrange inside each callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/checkout.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous 3+ groups over the union; each outcome/refusal class isolated. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a would-overwrite-refusal row.

### Gate
`npx vitest run test/unit/application/commands/checkout.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/checkout.test.ts`

### Commit
`test(unit): minimise application/commands/checkout`

## Part 38 — application/commands/revert (giant)

### Context
Owns the single giant `test/unit/application/commands/revert.test.ts` (1529 LOC). Apply the
Methodology. Guard-rail focus: each revert outcome/refusal (clean, conflict, continue, abort,
empty) stays a distinct row with per-row `.data`; built-repo Arrange inside each callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/revert.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous 3+ groups over the union; each outcome class isolated. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a conflict/abort row.

### Gate
`npx vitest run test/unit/application/commands/revert.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/revert.test.ts`

### Commit
`test(unit): minimise application/commands/revert`

## Part 39 — application/commands/internal (+ internal/fsck)

### Context
Owns all of `test/unit/application/commands/internal/**` **except** the property siblings
(`remote-url.properties`, `ssh-argv.properties`) — including the trivial subdir
`internal/fsck/content-validation.test.ts` (31, 1 `it`, clustered in). Census: `commands/internal`
41 files / 15506 LOC / 762 `it` + `internal/fsck` 1 file / 31 LOC / 1 `it`. Several files
already use `it.each` (`git-service-session`, `receive-pack-client`, `refs-discovery`,
`upload-pack-client`) — lighter touch. Notable larger files: `repo-state.test.ts` (1265),
`git-service-session.test.ts` (1034), `url-validate.test.ts` (964), `rev-parse-grammar.test.ts`
(845), `working-tree.test.ts` (791), `remote-url.test.ts` (722), `push-refspecs.test.ts` (659).
Apply the Methodology file-by-file. Guard-rail focus: `url-validate`/`rev-parse-grammar` guard
conditions (each `if (A || B)` branch its own row) and error `.data` rows stay isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/commands/internal` green (properties unchanged); note counts.
2. **MINIMISE**: walk each owned file; KEEP/COLLAPSE/DELETE; grammar/url guard conditions stay
   one row each; property files byte-identical. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `url-validate` guard row and a
   `rev-parse-grammar` boundary row.

### Gate
`npx vitest run test/unit/application/commands/internal && npm run check:types && ./node_modules/.bin/biome check test/unit/application/commands/internal`

### Commit
`test(unit): minimise application/commands/internal`

## Part 40 — application/primitives (remaining)

### Context
Owns `test/unit/application/primitives/*.test.ts` (top level of `primitives`, NOT the
`internal/`, `snapshot/`, `snapshot-operators/` subdirs) **except** the 4 giants (Parts 41-44:
`config-read`, `update-config`, `detect-similarity-renames`, `fetch-pack`) and the property
siblings at this level (`enumerate-objects.properties`, `find-would-overwrite.properties`,
`merge-base.properties`, `parse-gitmodules.properties`). This is a **large directory part**
(~84 remaining files, each <1500 LOC; KEEP-heavy). Notable remaining files: `object-resolver`
(1365, already `it.each`), `materialise-patch-files` (1324), `apply-changeset` (1294),
`diff-trees` (1148), `apply-merge-to-worktree` (1136), `stream-blob` (1029), `validators`
(938), `walk-commits` (796), `walk-submodules` (755), `enumerate-bundle-objects` (747),
`materialize-tree` (719), `read-object` (647), `run-hook` (647), `sign-payload` (622),
`parse-git-int` (592), `build-index-from-tree` (589), `build-content-merger` (556),
`write-working-tree-file`? (that is under `internal/` → Part 45). Files already using `it.each`
(`create-commit`, `object-resolver`, `pack-registry`) get a lighter touch. Census (whole
`primitives` level incl. giants): 88 files / 50603 LOC / 2100 `it`. Apply the Methodology
file-by-file. Guard-rail focus: `validators`/`parse-git-int` guard conditions and boundary rows
stay isolated (per-guard rows for `if (A || B)`); error `.data` per-row; each built-repo/fixture
Arrange stays inside its `it.each` callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives` green on the owned files
   (the 4 giants + subdirs + properties unchanged & green); note per-file counts.
2. **MINIMISE**: walk each owned top-level file; KEEP/COLLAPSE/DELETE; guard/boundary rows stay
   one per condition; no hoisted mutable fixtures; property files + subdirs + giants untouched.
   Re-run the owned files green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `validators` guard row and a `parse-git-int`
   overflow/boundary row.

### Gate
`npx vitest run test/unit/application/primitives && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives`

### Commit
`test(unit): minimise application/primitives`

## Part 41 — application/primitives/config-read (giant)

### Context
Owns the single giant `test/unit/application/primitives/config-read.test.ts` (6990 LOC — the
largest file; already uses `it.each`). Property sibling `config-read.properties.test.ts` out of
scope. This is the design's **worked COLLAPSE example** (`[core] bare` unification, design §1) —
prime collapse territory. Apply the Methodology. Guard-rail focus: the `invalid → default`
unparseable-boolean/int guard rows (design §1) each stay their own row — that literal is the
only input killing the parse-guard mutants; per-row `.data` for config-error tests.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/config-read.test.ts` green; note count.
2. **MINIMISE**: unify sibling `Given`s only when one truthful phrasing covers all rows (design
   §1 `[core] bare`); collapse homogeneous 3+ groups over the union; keep every
   unparseable/default guard row. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) an unparseable-boolean/int default row —
   activate the parse-guard mutant, confirm the collapsed row still fails.

### Gate
`npx vitest run test/unit/application/primitives/config-read.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/config-read.test.ts`

### Commit
`test(unit): minimise application/primitives/config-read`

## Part 42 — application/primitives/update-config (giant)

### Context
Owns the single giant `test/unit/application/primitives/update-config.test.ts` (6080 LOC).
Property sibling `update-config.properties.test.ts` out of scope. Apply the Methodology.
Guard-rail focus: config-write outcome rows (add/replace/unset/multivar, section creation)
stay distinct; on-disk config-bytes oracles are byte-exact — never weaken; per-row `.data`
for refusal/error tests.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/update-config.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous 3+ groups over the union; keep each write-outcome class
   distinct with byte-exact oracle. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a multivar/unset boundary row.

### Gate
`npx vitest run test/unit/application/primitives/update-config.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/update-config.test.ts`

### Commit
`test(unit): minimise application/primitives/update-config`

## Part 43 — application/primitives/detect-similarity-renames (giant)

### Context
Owns the single giant `test/unit/application/primitives/detect-similarity-renames.test.ts`
(3854 LOC). Apply the Methodology. Guard-rail focus: similarity-threshold boundaries (each side
of the rename/copy cutoff, exact-match, below-threshold) each stay their own row; rename/copy
pairing outcome rows distinct.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/detect-similarity-renames.test.ts` green; note count.
2. **MINIMISE**: collapse homogeneous 3+ groups over the union; keep every threshold-boundary row. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a threshold-boundary row — activate the cutoff
   mutant, confirm the collapsed row still fails.

### Gate
`npx vitest run test/unit/application/primitives/detect-similarity-renames.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/detect-similarity-renames.test.ts`

### Commit
`test(unit): minimise application/primitives/detect-similarity-renames`

## Part 44 — application/primitives/fetch-pack (giant)

### Context
Owns the single giant `test/unit/application/primitives/fetch-pack.test.ts` (1939 LOC, already
uses `it.each` — lighter touch). Apply the Methodology. Guard-rail focus: negotiation/want-have
and pack-receipt outcome rows stay distinct with per-row `.data`; each transport Arrange stays
inside its callback.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/fetch-pack.test.ts` green; note count.
2. **MINIMISE**: collapse remaining homogeneous 3+ groups over the union. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a negotiation-state boundary row if collapsed.

### Gate
`npx vitest run test/unit/application/primitives/fetch-pack.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/fetch-pack.test.ts`

### Commit
`test(unit): minimise application/primitives/fetch-pack`

## Part 45 — application/primitives/internal

### Context
Owns all of `test/unit/application/primitives/internal/**` **except** the property siblings
(`config-scope.properties`). Census: 12 files / 2823 LOC / 138 `it`. Files: `bounded-map.test.ts`
(147), `commit-date-walk.test.ts` (202), `config-key.test.ts` (207), `config-scope.test.ts`
(542), `index-entry-from-stat.test.ts` (46), `read-gitattributes.test.ts` (431),
`resolve-tree-path.test.ts` (267), `shell-quote.test.ts` (95), `submodule-context.test.ts`
(124), `worktree-context.test.ts` (119), `write-working-tree-file.test.ts` (551). Apply the
Methodology. Collapse candidates: `shell-quote` quoting rows, `config-scope` scope-resolution
rows, `bounded-map` eviction rows. Guard-rail focus: `bounded-map` capacity boundaries and
`shell-quote` escaping edge cases stay isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/internal` green (property unchanged); note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE per file; boundary rows preserved as the union. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `bounded-map` capacity boundary or
   `shell-quote` escaping edge if collapsed.

### Gate
`npx vitest run test/unit/application/primitives/internal && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/internal`

### Commit
`test(unit): minimise application/primitives/internal`

## Part 46 — application/primitives/snapshot

### Context
Owns all of `test/unit/application/primitives/snapshot/**` (16 files, 2921 LOC, 96 `it`,
including `.mutation.test.ts` files which are in scope; no property siblings here). Files
include: `index-entry.test.ts` (103), `index-snapshot.mutation.test.ts` (184),
`index-snapshot.test.ts` (165), `join.test.ts` (271), `path-merge.mutation.test.ts` (127),
`path-merge.test.ts` (161), `require-snapshot.test.ts` (50), `snapshot-factory.test.ts` (445),
`stash-snapshot.test.ts` (54), `tree-entry.test.ts` (103), `tree-snapshot.mutation.test.ts`
(248), `tree-snapshot.test.ts` (166), `workdir-entry.mutation.test.ts` (291),
`workdir-entry.test.ts` (244), `workdir-snapshot.mutation.test.ts` (149),
`workdir-snapshot.test.ts` (160). Apply the Methodology; `.mutation.test.ts` files are
frequently KEEP-only (targeted mutant kills). Guard-rail focus: snapshot merge/join boundary
rows stay isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/snapshot` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; treat `.mutation` files as KEEP unless a strict 3+
   homogeneous group is present. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `path-merge`/`join` boundary row if collapsed.

### Gate
`npx vitest run test/unit/application/primitives/snapshot && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/snapshot`

### Commit
`test(unit): minimise application/primitives/snapshot`

## Part 47 — application/primitives/snapshot-operators

### Context
Owns all of `test/unit/application/primitives/snapshot-operators/**` (4 files, 1180 LOC, 40
`it`, incl. 3 `.mutation.test.ts` which are in scope; no property siblings):
`group-by-dir.mutation.test.ts` (130), `hash-slot.mutation.test.ts` (167),
`load-blob.mutation.test.ts` (430), `operators.test.ts` (453). Apply the Methodology; the three
`.mutation.test.ts` files are frequently KEEP-only. Guard-rail focus: `hash-slot` slot-boundary
rows and `group-by-dir` grouping edge cases stay isolated.

### TDD steps
1. **BASELINE**: `npx vitest run test/unit/application/primitives/snapshot-operators` green; note counts.
2. **MINIMISE**: KEEP/COLLAPSE/DELETE; treat `.mutation` files as KEEP unless a strict 3+
   homogeneous group is present. Re-run green.
3. **VERIFY**: GWT/AAA/`sut`; hand-verify (§3.4) a `hash-slot` slot boundary if collapsed.

### Gate
`npx vitest run test/unit/application/primitives/snapshot-operators && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/snapshot-operators`

### Commit
`test(unit): minimise application/primitives/snapshot-operators`
