# Design — `range-diff` (compare two commit ranges)

## Goal

Tier-1 `repo.rangeDiff(opts)` — git's `git range-diff`: compare two versions of a
patch series (two commit ranges) and report, commit-by-commit, which patches were
**added**, **removed**, left **unchanged**, or **changed** between the old and the
new range. **Structured data only** (ADR-249): the command returns the ordered
**correspondence list** — exactly the data behind `git range-diff --no-patch`
(`-s`) — not the rendered "diff of diffs" body. Each entry carries the matched
old/new commit (position + oid), a status enum (`= ! < >`), and the shown subject.
The byte-faithful `-s` line, the abbreviation length, the number padding, and the
diff-of-diffs body are all caller projections.

This is the first command whose **core datum is an assignment** (a min-cost
bipartite matching), not a walk or a projection. The matching is the novel,
faithful algorithm; the diff-of-diffs body git prints by default is rendering.

## Faithfulness research (verified against real `git` 2.54.0)

All facts below were confirmed against canonical `git range-diff` with scrubbed
`GIT_*` env and deterministic author/committer dates, and cross-checked against
`git/git`'s `range-diff.c` + `linear-assignment.c` at tag `v2.54.0`. They are the
binding contract; the design records them.

### Argument forms and ranges

1. git accepts three CLI forms, all reducible to **two `(base, tip)` ranges**:
   `<oldBase>..<oldTip> <newBase>..<newTip>`; the 3-arg `<base> <tip1> <tip2>`
   (shared base); and the symmetric `<tip1>...<tip2>` (base = `merge-base(tip1,
   tip2)`). The CLI "need two commit ranges" usage error and the equal-endpoint
   rejection of `X..X` are **arg-detection artifacts** of the string CLI, not
   semantics: the 3-arg form happily accepts an **empty** range (e.g. `base base
   tip` → old range empty → all creations). Our typed API takes the two ranges
   directly, so it never reproduces the usage error; an empty range is just a
   zero-commit series.
2. Each range is read with
   `git log --no-color -p --reverse --date-order --no-merges --pretty=medium
   --no-prefix --submodule=short --output-indicator-{new=>,old=<,context=#}
   --no-abbrev-commit` over `base..tip`. So the patch series is:
   **`base..tip`, committer-date order, oldest-first, merges excluded**,
   numbered `1..n`. This is exactly `walkCommitsByDate({from:[tip],
   until:[base]})` **reversed**, with multi-parent commits filtered out.
3. `base` / `tip` resolve through the **full rev grammar** (`~`/`^`/`@{…}`/oid
   prefix/tags); an unresolvable endpoint co-refuses with git (`bad revision`).

### Per-commit patch text (the `## ` format)

For each commit `read_patches` builds two strings (`util->patch` = full,
`util->diff` = the slice from the first file header on — `diff_offset`):

```
 ## Metadata ##
Author: <name> <email>

 ## Commit message ##
    <message line 1, 4-space-indented, trailing ws stripped>
    <message line 2 …>

 ## <path>[ (new)|(deleted)|<old> => <new>][ (mode change <oct> => <oct>)] ##
@@[ <path>: <section heading>]
 <context line>
-<removed line>
+<added line>
…
```

- `--pretty=medium` supplies `Author:` + the 4-space-indented message body. Only
  the `Author:` line and the `    `-indented message lines are captured; `Date:`,
  `commit <oid>`, and blank separators are dropped. Each message line keeps its
  4-space indent, trailing whitespace stripped.
- File headers are rewritten to ` ## <path> ## ` with `(new)`, `(deleted)`,
  `<old> => <new>` (rename), and `(mode change <oct> => <oct>)` annotations. The
  `diff --git`, `index <a>..<b>`, `--- `, `+++ `, `new/deleted file mode` lines
  are **stripped** (no blob oids, no mode lines, no `±` path headers).
- Hunk headers drop the `-a,b +c,d` line numbers: `@@ -a,b +c,d @@ <section>` →
  `@@`, plus ` <path>:` and the `<section>` heading **only when a section
  heading is present**. Content lines carry `+`/`-`/` ` (space) prefixes.
- `util->diffsize` counts **only the diff-slice lines** (file headers, `@@`
  headers, content) — *not* the metadata/message (those `continue` past the
  counter).

### Matching (the assignment)

4. **Exact matches first** (`find_exact_matches`): hash `util->diff` (diff slice,
   message-independent). A new-range patch whose diff slice is **byte-identical**
   to an unconsumed old-range patch is paired (cost 0), regardless of size. Note
   this keys on the **diff**, so two commits with identical diffs but different
   messages are *paired* here.
5. **Cost matrix + min-cost assignment** (`get_correspondences`): build a square
   `n×n` cost matrix (`n = oldCount + newCount`) and solve
   `compute_assignment` (the Jonker-Volgenant LAP in `linear-assignment.c`):
   - old `i` × new `j`, both still unmatched: `cost = diffsize(old.diff,
     new.diff)` (a unified diff with **ctxlen 3** between the two diff slices,
     counting **every emitted line** — hunk headers + context + ± — via the
     `diffsize_hunk`+`diffsize_consume` callbacks). If `i` was exact-matched to
     `j`: `0`. If either was exact-matched to someone else: `COST_MAX` (`INT_MAX`).
   - deletion dummy (old `i` × extra col): `old.diffsize * creationFactor / 100`
     (**integer** division) if `i` unmatched, else `COST_MAX`.
   - creation dummy (extra row × new `j`): `new.diffsize * creationFactor / 100`.
   - dummy × dummy: `0`.
   - `creationFactor` default = **60** (`RANGE_DIFF_CREATION_FACTOR_DEFAULT`).
     Integer division means tiny patches (`diffsize ≤ 1`) get a creation cost of
     `0`, so creation/deletion can be **cheaper** than a small diff-of-diffs —
     this is why nearly-identical *small* patches still show as `< … >`, not `!`
     (verified). The matching only binds once patches are large enough that
     `diffsize * 60 / 100` exceeds the inter-version diff cost.
   - Wiring back: `a2b[i] ∈ [0, newCount)` ⇒ `old[i].matching = a2b[i]`,
     `new[a2b[i]].matching = i`.
6. `compute_assignment` is ported **verbatim** (column reduction → reduction
   transfer → two augmenting-row-reduction phases → augmentation), preserving its
   exact tie-breaking so the assignment is byte-identical to git's. `COST(c,r) =
   cost[c + n*r]`; the matrix is filled column = old-index, row = new-index.

### Output (ordering + status + subject)

7. **Ordering** (`output`): git prints in **new-range order**, slotting removed
   old commits in once their predecessors are shown:

   ```
   i = j = 0
   while i < old.nr or j < new.nr:
     while i < old.nr and old[i].shown: i++           # skip shown
     if i < old.nr and old[i].matching < 0:           # deletion
        emit(old=i+1, new=∅);  i++;  continue
     while j < new.nr and new[j].matching < 0:         # creations
        emit(old=∅, new=j+1);  j++
     if j < new.nr:                                    # matched pair
        i' = new[j].matching
        emit(old=i'+1, new=j+1);  old[i'].shown = 1;  j++
   ```

8. **Status** (`output_pair_header`): `<` only-old (`!new`), `>` only-new
   (`!old`), `=` if `strcmp(old.patch, new.patch) == 0` (full patch incl.
   metadata+message byte-identical), else `!`. So a diff-exact pair whose
   *message* differs is paired-but-`!`.
9. **Subject** = `pp_commit_easy(CMIT_FMT_ONELINE, oid)` of `old ?? new`
   (`oid = old_util ? old.oid : new.oid`) — the **old** commit's folded subject
   when present, else the new's. This is git's `%s` = `foldSubject`.
10. **Rendering-only** (caller projections, ADR-249): the number field width
    (`decimal_width(1 + max(oldCount, newCount))`), the abbreviation length and
    the dash run (`-:  -------`, dashes = abbrev length), `--left-only`/
    `--right-only` (filters over the entry list by status), and the diff-of-diffs
    body (`patch_diff` of the two `## ` texts with indent + dual-color).

### Documented faithful divergences

- **Hunk section headings** (funcname context after `@@`): our diff machinery
  (`patch-serializer`/`line-diff`) does **not** detect userdiff funcname context,
  so our `## ` `@@` lines omit the ` <path>: <section>` suffix git adds for
  source files. This feeds `diffsize` (the cost) and the `=`/`!` strcmp. In
  practice it is **cost-neutral**: the `@@` line is one line either way, and the
  section heading is identical across the two versions of a patch (so it stays a
  single common context line), changing `diffsize` only on the rare hunk whose
  funcname *itself* changed. The correspondence is therefore byte-faithful for
  content without funcname-detectable context (prose, data, sequences — all
  interop fixtures); funcname-bearing source hunks are a deferred divergence
  (backlog **23.6a**, shared with a future `--function-context`).
- **Non-linear range order**: like `log`/`shortlog`, `walkCommitsByDate` equals
  `git log --date-order` for every causally-dated history (all real series).
  Strictly-forged reverse-causal committer dates are out of scope.
- **The diff-of-diffs body** is not emitted (it is rendering). Reconstructed only
  in interop via `-s`; the default `git range-diff` body is a caller projection
  (deferred render-side, shared with the 23.2a-style "caller renders patches"
  stance). The `--creation-factor` knob is in scope (it changes the *matching*).

## Architecture

Hexagonal, mirroring `blame`/`describe` but with a richer pure core:

```
src/
├── domain/
│   └── range-diff/                       # NEW pure subsystem
│       ├── patch-text.ts                 # render the `## ` full+diff text & diffsize from a pure commit-patch input
│       ├── diff-size.ts                  # diffsize(a, b): ctxlen-3 emitted-line count between two texts
│       ├── linear-assignment.ts          # compute_assignment port (verbatim JV-LAP)
│       ├── correspond.ts                 # exact-match + cost matrix + assignment → matching arrays
│       ├── interleave.ts                 # output ordering → ordered RangeDiffEntry[]
│       ├── range-diff.ts                 # pure orchestrator over two RangePatch series
│       └── index.ts                      # internal barrel
└── application/commands/
    └── range-diff.ts                     # NEW Tier-1: resolve ranges → walk+read → gather bytes → domain
```

**Dependency rule preserved:** the command does all I/O (resolve revs, walk
commits, read trees/blobs via `walkCommitsByDate` + `diffTrees` +
`materialisePatchFiles`) and hands the domain a pure, fully-hydrated
`RangePatch` per range (each commit's author, folded subject, message lines, and
per-file `{ header, oldBytes, newBytes }`). The domain renders the `## ` text,
computes `diffsize`, solves the assignment, and interleaves — all pure. Nothing
crosses the hexagon inward.

### Domain shapes (pure)

```ts
interface CommitPatchInput {              // one commit, hydrated by the command
  readonly id: ObjectId;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly subject: string;               // foldSubject(message), precomputed
  readonly message: string;               // raw commit message; patch-text owns the medium 4-space transform
  readonly files: ReadonlyArray<PatchFile>;  // reuse the diff domain's PatchFile {change, oldContent?, newContent?}
}
interface RenderedPatch {                 // patch-text.ts output
  readonly patch: string;                 // full `## ` text (metadata+message+diff)
  readonly diff: string;                  // the diff slice (from first file header)
  readonly diffsize: number;              // diff-slice line count
}
```

`renderRangePatch(input): RenderedPatch` reproduces `read_patches` byte-for-byte:
- metadata: ` ## Metadata ##\nAuthor: <name> <email>\n\n ## Commit message ##\n`;
- message: each raw line → `    ` + line, then **trailing-ws-stripped** (so a blank
  line becomes empty), reproducing `--pretty=medium`'s 4-space indent;
- per file (`PatchFile.change` drives the header): ` ## <path>[ (new)|(deleted)|
  <old> => <new>][ (mode change <oct> => <oct>)] ##`, then line-number-stripped
  `@@` hunks (no ` <path>: <section>` — funcname divergence), `+`/`-`/` ` body via
  `diffLines` at ctxlen 3, or the `Binary files …` line for binary;
- `diff` = the slice from the first file header on (the `diff_offset` split);
  `diffsize` = that slice's line count.

Reusing `PatchFile` means `materialisePatchFiles` output flows straight in; the
` ## ` header is rendered from the existing `DiffChange` discriminated union
(`add`/`delete`/`rename`/`modify`/`type-change` + modes).

### Domain engine (pure)

```
correspondences(old: RenderedPatch[], new: RenderedPatch[], creationFactor):
   matching = exactMatch(old, new)                 // diff-string Map, LIFO on dup keys (mirrors hashmap)
   cost = buildCostMatrix(old, new, matching, creationFactor)   // n×n, COST_MAX=INT_MAX
   [a2b, b2a] = computeAssignment(n, n, cost)      // verbatim JV-LAP
   applyAssignment(a2b, old, new)                  // wire .matching
   return interleave(old, new)                     // ordered RangeDiffEntry[] with =/!/</> + subject
```

`status` is `=` iff `old.patch === new.patch`. `subject` is taken from the
**old** entry's precomputed `subject` when present, else the new's.

### Application — `rangeDiff(ctx, opts)`

```
await assertRepository(ctx)
oldSeries = await readSeries(ctx, opts.old)     // resolveCommit base/tip; walk; filter merges; reverse; hydrate
newSeries = await readSeries(ctx, opts.new)
return correspondences(oldSeries, newSeries, opts.creationFactor ?? 60)
```

`readSeries` per commit: read commit; skip if `parents.length > 1` (git's
`--no-merges`); `diffTrees(parent?.tree, commit.tree, { recursive: true,
detectRenames: true })` (git's `git log -p` default `diff.renames` — exact
renames only; **rename-with-edit** is the existing diff-machinery divergence,
showing as delete+add); `materialisePatchFiles`; build `CommitPatchInput`. A
bounded-concurrency read (reuse the `materialisePatchFiles` pool pattern) keeps
large series civil. A memory guard refuses when `n² · 4 bytes` exceeds a cap
(faithful to git's `--max-memory` `die`), surfaced as a structured
`RANGE_DIFF_COST_MATRIX_TOO_LARGE`.

CQS: a pure query, no writes. Aborts honoured by the walks/reads.

## Public surface

```ts
repo.rangeDiff(opts: RangeDiffOptions): Promise<ReadonlyArray<RangeDiffEntry>>;

interface RangeDiffRange {
  readonly base: string;   // commit-ish (full grammar)
  readonly tip: string;    // commit-ish (full grammar)
}
interface RangeDiffOptions {
  readonly old: RangeDiffRange;        // the first / "before" range  (naming → ADR)
  readonly new: RangeDiffRange;        // the second / "after" range
  readonly creationFactor?: number;    // git --creation-factor; default 60
}
type RangeDiffStatus = 'unchanged' | 'changed' | 'only-old' | 'only-new';  // = ! < >
interface RangeDiffCommit {
  readonly position: number;           // 1-based index in its merge-filtered, oldest-first series
  readonly id: ObjectId;               // full oid; caller abbreviates
}
interface RangeDiffEntry {
  readonly status: RangeDiffStatus;
  readonly old?: RangeDiffCommit;      // absent iff status === 'only-new'
  readonly new?: RangeDiffCommit;      // absent iff status === 'only-old'
  readonly subject: string;            // folded subject of (old ?? new)
}
```

**Caller projections** (not library concerns, ADR-249):
- the `-s` line: `printf("%*d:  %s %c %*d:  %s %s", w, position, abbrev(id), marker, …)`.
- `--left-only` / `--right-only`: `entries.filter(e => e.old)` / `e.new`.
- the diff-of-diffs body: re-render each pair's two `## ` patch texts and diff them.

### Open decisions (→ ADR conversation)

- **D1 — output shape.** Correspondence list only (= `git range-diff -s`, the
  assignment), vs. additionally exposing the **structured diff-of-diffs** per
  `changed` pair. *Recommend:* correspondence-only — the assignment is the novel
  faithful datum; the diff-of-diffs is a render over the `## ` text (cosmetics in
  data), and ADR-249/23.2a put patch rendering on the caller. The engine renders
  the `## ` text internally (for hashing + cost) but does not expose it.
- **D2 — range / side vocabulary.** `old`/`new` (faithful to git's mental model;
  `new` is a legal-but-awkward object key), vs. `before`/`after`, vs.
  `left`/`right` (the output columns). *Recommend:* `old`/`new` for fidelity, or
  `before`/`after` if the reserved word is undesirable.
- **D3 — assignment fidelity.** Port git's exact `compute_assignment` +
  cost/`## `-text engine for a byte-faithful matching (`-s` reconstructed), vs. a
  simpler heuristic matcher. *Recommend:* port verbatim — the assignment is
  observable, so the prime directive binds it. Funcname section headings are the
  one deferred divergence (23.6a).

## Surface gates (per the Tier-1 checklist)

- `src/application/commands/range-diff.ts` + barrel export in `commands/index.ts`.
- `repository.ts`: `Repository.rangeDiff` field + bound method.
- `test/unit/repository/repository.test.ts`: add `'rangeDiff'` to the key-set.
- `domain/range-diff/` unit + property tests.
- `test/integration/range-diff-interop.test.ts`: reconstruct `git range-diff -s`
  (and `--creation-factor`, `--left-only`/`--right-only` as filters) byte-for-byte
  from the structured entries across the scenarios below.
- `test/parity/scenarios/range-diff.scenario.ts` + registry: cross-adapter
  (node/memory/browser) parity.
- Docs: `docs/use/commands/range-diff.md`, index `README.md` (34 → 35), root
  `README.md` Tier-1 count (34 → 35), `reports/api.json` regen.
- `docs/BACKLOG.md`: flip `23.6` `[ ]` → `[x]`; add `23.6a` (funcname sections).

## Testing strategy

- **GWT/AAA, `sut`, 100% coverage, 0 surviving mutants** (per CLAUDE.md).
- **`linear-assignment`** — example tests against hand-computed optima
  (deletion-only, creation-only, reorder, exact + fuzzy mix); property test
  (lens 3 — total function over a non-negative integer cost matrix: returns a
  permutation; cost ≤ identity; `column2row`/`row2column` are mutual inverses on
  assigned indices). Small-`n` (`< 2`) early-return guarded in isolation.
- **`patch-text`** — example tests for each `read_patches` rule (metadata, 4-space
  message, `(new)`/`(deleted)`/rename/mode-change headers, `@@` line-number strip,
  `+`/`-`/` ` body, binary line, `diff_offset` split, `diffsize` count); property
  (lens 1 — `diff` is a suffix of `patch`; `diffsize === diff.split('\n')` count
  minus the trailing empty).
- **`diff-size`** — example tests (identical → 0; disjoint → sum; ctxlen-3
  context counted); property (symmetric, `diffsize(x,x) === 0`).
- **`correspond` / `interleave`** — example tests reproducing every researched
  scenario (exact `=`, reword `!`, small-patch `< >` split, reorder, mixed
  add/drop, empty range); property (lens 2 — every old/new commit appears exactly
  once across the entries; ordering is new-range-monotone on the present side).
- **Interop** — `range-diff-interop.test.ts` builds repos with real git
  (deterministic dates, signing off) and reconstructs `git range-diff -s` /
  `--creation-factor=N` / `--left-only` / `--right-only` byte-for-byte from the
  entries. Scenarios: linear reword (`!`), exact cherry (`=`), small-patch split
  (`< >`), reorder, add+drop, one-empty-range, multi-file, rename, deletion.
- **Mutation-resistant**: specific error assertions (`creationFactor` validation,
  cost-matrix guard); isolated guard tests for each status branch (`< > = !`) and
  each interleave branch (deletion / creation / pair / skip-shown); the
  integer-division creation cost pinned by a small-patch split case; the
  assignment tie-break pinned by a reorder case that a greedy matcher would
  mis-order.

## Non-goals (deferred, divergences noted)

- **Funcname hunk-section headings** (23.6a) — needs userdiff funcname detection.
- **The diff-of-diffs body** — caller projection (render the two `## ` texts).
- **Symmetric `A...B` convenience** — caller computes `merge-base` (we have it);
  YAGNI for v1, additive later.
- **`--notes` / `--diff-merges` / dual-color / `--no-patch` is the default here**
  — rendering/notes flags, out of scope.
- **`.mailmap`** — no mailmap support anywhere yet (cross-cutting).
```
