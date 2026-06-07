# Plan — `range-diff` (compare two commit ranges)

TDD per slice (Red → Green → Refactor), one atomic conventional commit each.
`npm run validate` green before every commit. Bottom-up: pure domain leaves
first, then the orchestrator, then the command, then surface + interop + docs.
Reference: `docs/design/range-diff.md`, ADRs 279–281, and the verbatim git
sources captured in design research (`range-diff.c`, `linear-assignment.c`,
`xdiff/xemit.c` @ v2.54.0).

Branded types: `ObjectId`. Reuse: `walkCommitsByDate`, `diffTrees`,
`materialisePatchFiles`, `readObject`, `resolveCommit`, `diffLines`/`LineDiff`,
`PatchFile`/`DiffChange`, `foldSubject`, `splitLines`. New subsystem
`src/domain/range-diff/` (all internal — not on `reports/api.json` except the
command's public types).

---

## Slice 1 — `domain/range-diff/linear-assignment.ts` (verbatim LAP)

**Goal:** `computeAssignment(n: number, cost: ReadonlyArray<number>): { columnToRow: number[]; rowToColumn: number[] }` — a verbatim TS port of git's
`compute_assignment` (square `n×n`, `COST(c,r) = cost[c + n*r]`). Preserve every
phase and tie-break (column reduction → reduction transfer → 2× augmenting-row
reduction → augmentation). `INT_MAX` sentinel constant exported as `COST_MAX`.

- **Red:** `linear-assignment.test.ts`
  - Given a 2×2 cost `[[0,9],[9,0]]` (flattened, column-major per `COST`), Then
    the assignment is identity (`columnToRow = [0,1]`).
  - Given a 2×2 `[[9,0],[0,9]]`, Then it swaps (`[1,0]`).
  - Given `n < 2` (n=1, n=0), Then both arrays are zero-filled (the early return).
  - A 3×3 with a unique optimum (hand-computed) → that permutation.
  - A reorder-shaped matrix (cheap off-diagonal) → the off-diagonal assignment.
- **Green:** port the C verbatim; `MEMZERO_ARRAY`→`.fill(0)`, `ALLOC_ARRAY`→`new
  Array(n)`, `SWAP`→destructuring, `BUG`→`throw`. Flat `number[]` cost.
- **Properties** (`linear-assignment.properties.test.ts`, lens 3, numRuns 100):
  Given an arbitrary non-negative `n×n` (2≤n≤6) integer matrix, Then `columnToRow`
  is a permutation of `0..n-1`; `rowToColumn` is its inverse on assigned indices;
  the assignment cost ≤ the identity-diagonal cost.
- **Commit:** `feat(range-diff): port linear-assignment (compute_assignment)`

## Slice 2 — `domain/range-diff/funcname.ts` (default hunk section heading)

**Goal:** two pure fns over `ReadonlyArray<Uint8Array>` old-file lines:
- `matchFuncRec(line: Uint8Array): string | undefined` — `def_ff`: `undefined`
  unless `line.length>0 && (isAlpha(line[0]) || line[0]===0x5f || line[0]===0x24)`;
  else the line decoded, **trailing-ASCII-ws-stripped**, capped at **80 bytes**
  (cap applied to byte length *before* the trailing strip).
- `findFuncLine(oldLines, start, limit): { index: number; heading: string } | undefined`
  — scan from `start` toward `limit` (step ±1, `l !== limit && 0<=l<nrec`),
  return the first `matchFuncRec` hit.

`isAlpha` = ASCII `[A-Za-z]` (git's `isalpha` under C locale).

- **Red:** `funcname.test.ts`
  - `int main(void)` → heading `int main(void)`; `{` / `\tx` / `` (empty) /
    `  spaces` → `undefined` (non-identifier first byte).
  - `_underscore` and `$dollar` → headings (the two extra identifier bytes).
  - trailing-ws strip: `foo()   ` → `foo()`. 80-byte cap: an 90-char identifier
    line → first 80 bytes.
  - `findFuncLine` over `['int f()', '{', '\tx']` from index 2 toward -1 → finds
    index 0 `int f()`; from a block with no identifier → `undefined`.
- **Green:** implement; ASCII byte tests, `TextDecoder` for the heading.
- **Properties** (lens 3, numRuns 100): Given an arbitrary byte line, `matchFuncRec`
  returns `undefined` or a string never longer than 80 chars and never throws.
- **Commit:** `feat(range-diff): default funcname hunk-section heading (def_ff)`

## Slice 3 — `domain/range-diff/diff-size.ts` (cost metric)

**Goal:** `diffSize(a: string, b: string): number` — git's `diffsize`: the count
of emitted lines of a 3-context unified diff between `a` and `b` (hunk headers +
context + ± lines). Implement via `diffLines(encode(a), encode(b))` → group hunks
at `minGap = 2*3+1`, count `Σ (1 + bodyLines)` per coalesced hunk.

- **Red:** `diff-size.test.ts`
  - `diffSize(x, x) === 0` (no hunks).
  - single-line change in a 1-line input → 1 hunk: `1 (@@) + 2 (− and +) = 3`
    (no context available).
  - a change inside a long input → `1 + context(≤3 each side) + changed`.
  - disjoint changes >7 lines apart → two hunks (counts include both `@@`).
- **Green:** reuse `diffLines` + a local gap-grouping counter (or the shared
  grouper if extracted in Slice 4's refactor). Cross-check counts against `git
  diff -U3 | wc -l`-style hand counts in the test.
- **Properties** (lens 2, numRuns 100): assert `diffSize(x,x)===0` and
  `diffSize('', y) === 1 + lineCount(y)` for non-empty `y` (one all-insert hunk:
  the `@@` header + every line of `y`).
- **Commit:** `feat(range-diff): diffsize cost metric (3-context line count)`

## Slice 4 — `domain/range-diff/patch-text.ts` (`## ` renderer)

**Goal:** `renderRangePatch(input: CommitPatchInput): RenderedPatch` reproducing
git's `read_patches` byte-for-byte. `CommitPatchInput = { id, authorName,
authorEmail, subject, message, files: ReadonlyArray<PatchFile> }`.
`RenderedPatch = { id, subject, patch, diff, diffsize }`.

Render order (into one buffer; record `diffOffset` at the first file header):
1. ` ## Metadata ##\nAuthor: <name> <email>\n\n ## Commit message ##\n`
2. message: split raw `message` on `\n`; each line → `    ` + line, then strip
   trailing ASCII ws; join with `\n`, trailing `\n`. (Reproduce medium's 4-space
   indent + read_patches' trailing-strip; a blank line → empty line.)
3. for each `PatchFile` (in `files` order): a leading `\n`, set `diffOffset` if
   unset, then ` ## <header> ##` where header = path with `(new)` / `(deleted)` /
   `<old> => <new>` / trailing `(mode change <oct> => <oct>)`; then hunks.
4. hunks: compute via `diffLines(oldBytes, newBytes)` grouped at ctxlen 3; for
   each hunk emit `@@` + (funcname ? ` <newPath>: <heading>` : ``) — funcname via
   Slice 2 over `splitLines(oldBytes)`, scanning from `firstOldLine-1` toward the
   previous hunk's scan start, **retaining** the prior heading when none found —
   then body lines prefixed `+`/`-`/` `. Binary file → the `Binary files …` line.
5. `diff = patch.slice(diffOffset)`; `diffsize` = count of appended diff-slice
   lines (file headers + `@@` + body; **not** metadata/message).

- **Red:** `patch-text.test.ts` — one test per rule:
  metadata block; 4-space message incl. a blank-line case; `(new)`/`(deleted)`/
  rename/`mode change` headers; `@@` line-number strip; `@@ path: func` heading
  (with old lines containing an identifier); `+`/`-`/` ` body; binary line;
  `diff` is the suffix from the first ` ## … ## `; `diffsize` equals the diff
  slice's line count.
- **Green:** implement; reuse the diff domain's hunk grouping (export/extract a
  shared grouper from `patch-serializer` if cleaner — else a local grouper, with
  a Slice-7/Step-8 refactor note).
- **Properties** (lens 1, numRuns 100): Given an arbitrary `CommitPatchInput`,
  `diff` is a suffix of `patch`; `diffsize === diff.split('\n').length - 1` (the
  trailing newline); rendering is deterministic (idempotent re-render equal).
- **Commit:** `feat(range-diff): render the ## patch text (read_patches port)`

## Slice 5 — `domain/range-diff/correspond.ts` (matching)

**Goal:** `correspond(old: RenderedPatch[], new: RenderedPatch[], creationFactor):
{ old: Matched[]; new: Matched[] }` where `Matched = RenderedPatch & { matching:
number }` (−1 = unmatched). Steps: (a) `exactMatch` — `Map<diff, number[]>` over
`old`, **LIFO pop** per duplicate diff key (mirrors git's hashmap head-removal),
pair each `new` whose diff hits; (b) build the `n×n` cost matrix (n = old.len +
new.len) per `get_correspondences` (diff-diffsize, `COST_MAX` for cross-matched,
integer creation/deletion `diffsize*cf/100`, dummy×dummy 0); (c)
`computeAssignment`; (d) wire `a2b[i] ∈ [0,new.len)` ⇒ `old[i].matching=a2b[i]`,
`new[a2b[i]].matching=i`.

- **Red:** `correspond.test.ts`
  - Two byte-identical diffs → exact-matched (cost 0) regardless of size.
  - Two large near-identical patches (small diff-of-diffs, big self-size) → fuzzy
    matched. Two **small** near-identical patches (`diffsize ≤ 1`) → **not**
    matched (integer creation cost 0 wins) — pins the integer-division rule.
  - Reorder (3 patches A,B,C vs A,C,B, all big+exact) → exact-matched across the
    reorder.
  - Duplicate identical diffs in `old` → LIFO pairing order (highest index first).
  - creationFactor=0 → everything unmatched (all creations/deletions).
- **Green:** implement; validate the cost indexing (`cost[i + n*j]`, column=old).
- **Commit:** `feat(range-diff): exact + min-cost assignment of patch series`

## Slice 6 — `domain/range-diff/interleave.ts` (ordering + entries)

**Goal:** `interleave(old: Matched[], new: Matched[]): RangeDiffEntry[]` — the
verbatim `output` loop (skip-shown-old; deletion; creations; b-driven matched
pair, mark old shown). Per emitted pair build the entry: `status` (`<`→only-old,
`>`→only-new, else `=` iff `old.patch===new.patch` else `!` changed); `old`/`new`
`{ position: i+1, id }`; `subject` = (old ?? new).subject; `diffOfDiffs` =
`diffLines(encode(old.patch), encode(new.patch))` **iff** status `changed`.

- **Red:** `interleave.test.ts`
  - deletion-only series → `only-old` entries in old order.
  - creation-only → `only-new` in new order.
  - all-matched reorder → entries in **new** order, with crossed positions.
  - mixed (match + deletions then creations) → the exact interleave order.
  - matched, identical patch → `unchanged`, no `diffOfDiffs`; matched, differing
    message → `changed` with `diffOfDiffs` present.
  - subject taken from old on a pair; from new on a creation.
- **Green:** implement the loop verbatim; each status branch isolated.
- **Properties** (lens 2, numRuns 100): every old and every new index appears in
  exactly one entry; the present-`new` side is monotonically increasing in
  position across the entry list.
- **Commit:** `feat(range-diff): interleave assignment into ordered entries`

## Slice 7 — `domain/range-diff/range-diff.ts` + `index.ts` (orchestrator)

**Goal:** `rangeDiffEntries(old: CommitPatchInput[], new: CommitPatchInput[],
creationFactor): RangeDiffEntry[]` = render both series (`renderRangePatch`) →
`correspond` → `interleave`. `index.ts` re-exports the public types + the
orchestrator (internal barrel; types `RangeDiffEntry`/`RangeDiffStatus`/
`RangeDiffCommit` will be re-exported from the command).

- **Red:** `range-diff.test.ts` — end-to-end on synthetic `CommitPatchInput`:
  the canonical reword scenario → one `unchanged` + one `changed` (with
  `diffOfDiffs`); an add+drop scenario → `only-old` + `only-new` ordering.
- **Green:** wire the three pure stages.
- **Commit:** `feat(range-diff): pure orchestrator over two patch series`

## Slice 8 — `application/commands/range-diff.ts` (Tier-1 command)

**Goal:** `rangeDiff(ctx, opts: RangeDiffOptions): Promise<ReadonlyArray<RangeDiffEntry>>`.
`readSeries(range)`: `resolveCommit(base)`, `resolveCommit(tip)`; walk
`walkCommitsByDate({from:[tip], until:[base]})`, **skip `parents.length>1`**,
collect, **reverse** (oldest-first); per commit `diffTrees(parentTree, tree,
{recursive:true, detectRenames:true})` → `materialisePatchFiles` → build
`CommitPatchInput` (author from `commit.data.author`, `subject =
foldSubject(message)`). Memory guard: refuse `RANGE_DIFF_COST_MATRIX_TOO_LARGE`
when `(old.len+new.len)² * 4 > CAP`. `creationFactor` validated (non-negative
integer; default 60). Then `rangeDiffEntries(...)`.

- **Red:** `range-diff.test.ts` (unit, memory adapter)
  - assertRepository refusal off-repo.
  - reword scenario built with real commits → `[unchanged, changed]`, the
    `changed` carrying `diffOfDiffs`.
  - merge in a range is **excluded** (parents>1 filtered).
  - empty old range (base===tip) → all `only-new`.
  - unresolvable base/tip → co-refuses (the resolveCommit error).
  - `creationFactor` invalid (negative / non-integer) → structured refusal;
    `creationFactor=0` forces all creations/deletions.
  - the cost-matrix guard fires past the cap (small CAP via a crafted series, or
    assert the guard predicate directly).
- **Green:** implement with a bounded-concurrency series read (reuse the
  `materialisePatchFiles` pool shape). Early-return on both-empty.
- **Commit:** `feat(range-diff): Tier-1 rangeDiff command`

## Slice 9 — Public surface wiring

- `commands/index.ts`: export `rangeDiff` + `RangeDiffOptions`/`RangeDiffRange`/
  `RangeDiffEntry`/`RangeDiffStatus`/`RangeDiffCommit`.
- `repository.ts`: `Repository.rangeDiff` field (`BindCtx<typeof
  commands.rangeDiff>`) + bound method under `guard()`.
- `test/unit/repository/repository.test.ts`: add `'rangeDiff'` to the key-set.
- `src/index.ts`: re-export the public `RangeDiff*` types (api.json surface).
- **Red:** the repository key-set test fails until the field is added.
- **Green:** wire all six gate points; `npm run check:doc-typedoc` regen
  `reports/api.json` (expected large typedoc-id diff).
- **Commit:** `feat(range-diff): expose repo.rangeDiff on the facade`

## Slice 10 — Interop (`test/integration/range-diff-interop.test.ts`)

**Goal:** build repos with real `git` (scrubbed `GIT_*`, signing off, fixed
dates), and for each scenario reconstruct **both** `git range-diff -s` (the
correspondence lines, padded number + abbrev oid + marker + subject) **and** the
default body (the 2-level-prefixed diff-of-diffs from `diffOfDiffs`) byte-for-byte
from the structured entries; plus `--creation-factor=N` and `--left-only`/
`--right-only` (entry filters). Scenarios: reword (`!`), exact cherry (`=`),
small-patch split (`< >`), reorder, add+drop, one-empty-range, multi-file,
rename, deletion, funcname-bearing source file.

Use one shared `beforeAll` repo-builder + a 60s timeout (per the interop-flake
memory). Reconstruct git's `-s` line with the number width
`decimal_width(1+max(oldN,newN))` and 7-char abbrev.

**Body reconstruction (test-side):** git renders a changed pair's body by
diffing the two `## ` texts at ctxlen 3, prefixing each line with the outer
`+`/`-`/` ` plus a 4-space indent, and labelling each hunk header `@@ <section>`
where `<section>` is the nearest enclosing ` ## … ## ` line (git's bespoke
`section_headers` userdiff driver — `## Commit message ##` / `## <file> ##`).
The library returns only the structured `diffOfDiffs` (a `LineDiff`); the **test**
reconstructs git's body from it (group hunks at ctxlen 3, apply the outer prefix +
indent, derive each `@@ <section>` by scanning the `## ` lines). Full body
reconstruction is pinned for the **reword** and **funcname** scenarios; the other
scenarios pin the `-s` lines (the body is empty / one-sided for them).

- **Commit:** `test(range-diff): byte-faithful range-diff interop`

## Slice 11 — Parity scenario

- `test/parity/scenarios/range-diff.scenario.ts` + registry entry: cross-adapter
  (node/memory/browser) — run `repo.rangeDiff` on a fixed two-range repo, assert
  identical structured entries across adapters.
- **Commit:** `test(range-diff): cross-adapter parity scenario`

## Slice 12 — Docs + backlog

- `docs/use/commands/range-diff.md` (new page; structured-output + caller
  projection notes; the `-s` and body reconstruction examples).
- `README.md` (root): Tier-1 count 34 → 35; index `README.md`: 34 → 35 entries.
- `docs/BACKLOG.md`: flip `23.6` `[ ]` → `[x]` with the realised summary.
- `reports/api.json` already regenerated in Slice 9 (re-check).
- **Commit:** `docs(range-diff): usage page, README counts, backlog`

---

## Review / refactor / mutation (workflow Steps 6–8)

- Steps 6 reviews (typescript / security / tests) scoped to the diff.
- Step 7 architecture pass: candidate refactors — extract the shared hunk-grouper
  from `patch-serializer` for `patch-text`/`diff-size` reuse (rule-of-three:
  serializer + patch-text + diff-size); consider whether `funcname` belongs in
  `domain/diff/` for a future `rebase` patch-file funcname fix (note, don't force).
  Behaviour-preserving, re-reviewed, then mutation.
- Step 8 mutation: `npm run test:mutation` scoped to `src/domain/range-diff/*` +
  `src/application/commands/range-diff.ts`; 0 killable survivors (LAP and
  interleave are the dense targets; equivalent loop-bound mutants documented
  inline only with proof).

## Risks

- **LAP port correctness** — verbatim port + property tests (permutation /
  inverse / cost-bound) + the reorder interop pin.
- **`## ` byte-fidelity** (message indent, `@@` strip, funcname) — pinned by
  `patch-text` example tests *and* the interop body reconstruction.
- **Integer-division creation cost** — the small-patch split case pins it in both
  `correspond` and interop.
- **File order under rename detection** — pinned by the rename + multi-file
  interop scenarios; rename-with-edit is a documented divergence.
