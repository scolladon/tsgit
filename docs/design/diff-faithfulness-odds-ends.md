# Design — diff faithfulness odds & ends

> Brief (backlog 24.17, Wave D, from the sgd GitAdapter consumer spike): three
> independent sub-parts surfaced by a downstream consumer driving tsgit as its
> git adapter.
> 1. **LFS pointer handling** — "wired but untested" in the consumer; tsgit has no
>    filter port, so it diffs git-lfs pointer files as ordinary text. Pin that this
>    is byte-faithful to git WITHOUT an active `filter=lfs`/`diff=lfs` attribute
>    (the only faithful target tsgit can hit) with fixtures + an interop test.
> 2. **file↔symlink type-change (`T`)** — the spike note ("dropped from diff
>    output, matches `--diff-filter=AMD`") is STALE: tsgit already emits
>    `type-change` through every diff surface. Decide whether any path still drops
>    `T`, or whether this is pin-only.
> 3. **`log` roots / parent-count filter** — `log` cannot answer "give me the root
>    commits" cheaply; consumers walk and post-filter `parents.length === 0`. Add
>    git's `rev-list --max-parents`/`--min-parents` family as a structured option.
>
> Status: draft → self-reviewed ×3 → revised against ratified ADRs 398–401
> (D3.C deviated: public re-export bundled in, [ADR-401](../adr/401-reexport-log-types.md)).
>
> The three parts are independent. §1/§2/§3 are each self-contained (problem →
> current state → faithfulness baseline → proposed change → test/interop plan).
> §4 consolidates every load-bearing decision candidate (≤3 options each, with a
> recommendation) for the ADR conversation the orchestrator runs with the user.
> §5 is out-of-scope.

## 0. Cross-cutting constraints (tsgit prime directives — non-negotiable)

| Source | Binding constraint on this design |
|---|---|
| ADR-226 / CLAUDE.md (git-faithfulness) | Replicate canonical git's observable DATA byte-for-byte (object SHAs, raw/name-status equivalents, parent-count filtering semantics). Pinned against real `git` 2.54.0, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, signing off, isolated `HOME`, throwaway `mktemp -d` repo, `--no-ext-diff` on every scripted `git diff`/`show`. Every pinned behaviour becomes a cross-tool interop test in `test/integration/*-interop.test.ts`. |
| ADR-249 (structured-data-only) | The library returns FIELDS (oids, modes, enums, counts, booleans), never rendered text. No `--diff-filter`/`--pretty`/`--abbrev`-style rendering knobs. Part 3 exposes parent-count predicates as DATA options, not a formatted root-commit string. Faithfulness is reconstructed FROM the structured fields inside the interop test. |
| CLAUDE.md (architecture) | Hexagonal: `repository → commands → primitives → domain`. Domain stays platform-free. Object Calisthenics, branded types, FP-first, immutable. |
| Sibling design docs | Format/depth follows `docs/design/whitespace-diff-options.md` (24.14), `similarity-rename-detection.md` (24.13), `diff-recursive-tree-diff.md` (24.12). |

The empirical pins below were all run in `mktemp -d` throwaways with the
faithfulness procedure (`.claude/workflow/faithfulness.md`); none touched the
worktree's `.git`.

---

## 1. Part 1 — LFS pointer handling (pin-only, no tsgit code change)

> Ratified by [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md)
> (D1.A full matrix, D1.B active-driver out of scope — both as recommended).

### 1.1 Problem

The consumer (sgd) reported LFS pointer handling as "wired but untested". The
backlog asks for fixtures + interop to close that gap. The phrase refers to the
**consumer's** wiring, not tsgit code.

### 1.2 Current state (verified)

There is **ZERO LFS code** in `src/` or `test/` — confirmed by a clean grep for
`lfs`/`git-lfs`/`smudge`/`clean`/`filter=`/`pointer` (the only hits were unrelated
substrings: `--first-parent`, `cleanly`, `realFsOps`). tsgit has **no filter /
clean-smudge / textconv port** at all. A git-lfs pointer file is a plain UTF-8
text blob:

```
version https://git-lfs.github.com/spec/v1
oid sha256:<64-hex>
size <bytes>
```

Because tsgit has no filter machinery, it stores and diffs the pointer blob
exactly as its on-disk bytes — i.e. as ordinary text. This is the ONLY behaviour
tsgit can produce, and it is the correct faithful target (see §1.3).

### 1.3 Faithfulness baseline (the load-bearing decision)

git's behaviour over an LFS-tracked path depends on whether an LFS filter/diff
attribute is **active** in the environment running git:

| Environment | What `git diff` shows for an LFS path |
|---|---|
| **No `filter=lfs`/`diff=lfs` attribute active** (no `.gitattributes` lfs line, OR git-lfs not installed/initialised) | The raw **pointer blob** text. `git diff` produces an ordinary text diff of the three pointer lines (`version`/`oid`/`size`). The object store holds the pointer blob; that is the committed content. |
| **`filter=lfs diff=lfs` active + git-lfs installed** | git invokes the `lfs` textconv/diff driver, which substitutes the smudged (real) file or a synthesised summary; the diff is NOT the pointer text. |

tsgit has no filter port, so it can ONLY reproduce the first row. The faithful
baseline is therefore **git WITHOUT an active LFS filter** — i.e. the pointer
blob is the committed content and tsgit diffs it as text byte-identically to
`git diff` run in an environment where the `lfs` filter is not engaged. The
interop test MUST pin this baseline explicitly: build the fixture with NO
`.gitattributes diff=lfs` line and an isolated `HOME`/`GIT_CONFIG_NOSYSTEM=1`
(so no global git-lfs config engages a driver), so the peer `git` produces the
pointer-text diff that tsgit reproduces.

### 1.4 Empirical pin (run in a `mktemp` throwaway)

Pinned: with a hand-authored pointer blob committed and NO `diff=lfs` attribute,
real git diffs the pointer text. Add of a pointer = an `add` whose blob is the
pointer text; modify of a pointer (oid/size change) = a text `modify`; a
pointer→real-file change (the file stops being LFS-tracked and becomes its real
bytes) = a text `modify` whose new side is the real content. tsgit, reading the
same object store, produces byte-identical structured `TreeDiff` + numstat. (The
matrix is reproduced by the interop fixture in §1.6 against live `git`; the design
asserts the BASELINE, the test pins the exact bytes — never recalled from memory.)

The pin must include the **`.gitattributes` non-interference** check: committing a
`.gitattributes` that names `diff=lfs` but with NO git-lfs driver installed in the
isolated environment leaves git showing the pointer text anyway (the named driver
is absent ⇒ git falls back to the built-in text diff). This proves tsgit's
no-filter-port behaviour stays faithful even when the repo DECLARES an lfs
attribute, as long as no driver is registered — the realistic CI/consumer case.

### 1.5 Proposed change

**No tsgit source change.** The deliverable is fixtures + a cross-tool interop
test that pins the no-filter-port baseline. This makes the consumer's "wired but
untested" concern a tested, frozen contract: tsgit diffs LFS pointer blobs
byte-identically to filter-less git. If a future backlog item adds a filter port,
this test is the regression boundary it must not silently cross.

### 1.6 Test / interop plan

**Interop — `test/integration/lfs-pointer-interop.test.ts`** (new, twin
real-`git` vs tsgit; mirrors `diff-patch-git-parity` / `diff-recursive-interop`
isolation; `describe.skipIf(!GIT_AVAILABLE)`; one shared `beforeAll` repo; 60 s
timeout per the interop load→validate flake note):

- Initial commit with an unrelated file, then commit a hand-authored v1 pointer
  blob (`version`/`oid sha256:…`/`size …`) at `data.bin` on top, with NO
  `.gitattributes diff=lfs` line; isolate `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing
  off, scrubbed `GIT_*`. (Commit-to-commit, matching the consumer's pattern; no
  empty-tree spec needed.)
- **Pointer add**: assert tsgit's `diff(from='HEAD~1', to='HEAD')` structured
  `TreeDiff` reconstructs git's `--name-status` (`A data.bin`) and `--numstat`
  (3 added lines) byte-for-byte; the patch reconstructed via the shared
  `test/integration/diff-reconstruct.ts` `reconstructPatch` helper (the same
  domain `renderPatch` the library uses) equals live `git diff`.
- **Pointer modify** (bump `oid`+`size` to a new pointer): text `modify`; numstat
  counts and reconstructed patch equal live git.
- **Pointer → real file** (replace the pointer blob with real bytes, still no
  filter): text `modify` whose new side is the real content; counts + patch match.
- **`.gitattributes diff=lfs` declared, no driver installed**: assert git STILL
  shows the pointer text and tsgit matches (the §1.4 non-interference pin) — this
  is the explicit "filter declared but inert" faithfulness boundary.

No unit tests are added: there is no new tsgit code path; the contract is
entirely "tsgit ≡ filter-less git over pointer text", which only the interop
harness can prove (parity tests are cross-adapter and do NOT prove faithfulness).

### 1.7 Faithfulness boundary stated for the record

`.gitattributes diff=lfs` **with** a real git-lfs driver installed is explicitly
**out of scope** (§5): tsgit has no filter port, so reproducing the smudged diff
is impossible without inventing one — a separate, large backlog item. This design
declares the boundary so the interop test's environment hardening (no driver in
`HOME`) is understood as deliberate, not incidental.

---

## 2. Part 2 — file↔symlink type-change (`T`) — STALE note, pin-only

> Ratified by [ADR-399](../adr/399-type-change-already-faithful-pin-only.md)
> (D2.A dedicated `diff-type-change-interop.test.ts`, D2.B all three leaf-kind
> pairs — both as recommended).

### 2.1 Problem (as stated) vs reality

The backlog says file↔symlink type changes are "dropped from diff output (matches
`--diff-filter=AMD`)". This is **STALE**. Audit of every diff surface shows tsgit
ALREADY emits `type-change` faithfully and ALREADY reconstructs git's `T` raw
line in interop. There is no drop and no `--diff-filter` surface to decide about.

### 2.2 Current state — full surface audit (verified)

`type-change` (`DiffChangeType` member `'type-change'`, `diff-change.ts:4,42`)
carries `oldId`/`newId`/`oldMode`/`newMode` and flows through **every** diff
surface:

| Surface | File:symbol | Type-change handling |
|---|---|---|
| tree↔tree (domain) | `tree-diff.ts:24` `classifySamePath` | emits `type-change` when `!isSameKind(oldMode, newMode)` |
| index↔tree (domain) | `index-diff.ts:39` `classifyIndexVsTree` | emits `type-change` likewise |
| kind classifier | `mode-kind.ts` `kindOf`/`isSameKind` | `file` (regular+exec) \| `symlink` \| `directory` \| `gitlink` |
| recursive primitive | `diff-trees.ts` (`domainDiffTrees` via `blobProjection`) | preserves type-change; full-path entries classify the same way |
| whitespace drop pass | `diff-trees.ts:119` `shouldDrop` | drops ONLY `modify`; type-change is explicitly NEVER dropped |
| blob hydration | `materialise-patch-files.ts` `materialiseOne` | `modify` and `type-change` share the both-sides load arm |
| patch render | `patch-serializer.ts:560` `renderModifyOrTypeChangeBlock` | renders the type-change body (mode preamble + hunks) |
| status (index↔worktree, worktree↔tree) | `status.ts:265,277` | maps `type-change` → `ChangeKind 'type-changed'` (git `T`) |

There is **NO `--diff-filter` / `diffFilter` surface anywhere** in `src/` (clean
grep). The backlog's `--diff-filter=AMD` is git's *internal* default for certain
porcelain contexts; `git diff`/`diff-tree`/`whatchanged` surface `T` by default
(pinned §2.3), and tsgit mirrors that — it never had a filter to drop `T` through.

### 2.3 Empirical pin (run in a `mktemp` throwaway, git 2.54.0)

file → symlink (`100644` → `120000`):

```
git diff-tree -r --no-commit-id --abbrev=40 HEAD~1 HEAD
  :100644 120000 <old40> <new40> T	f
git diff --no-ext-diff --name-status HEAD~1 HEAD        →  T	f
git diff --no-ext-diff --raw      HEAD~1 HEAD (no flag) →  :100644 120000 <old> <new> T	f
```

`T` surfaces with **no** diff-filter. tsgit's `whatchanged-interop.test.ts:63-64`
already reconstructs exactly `:${oldMode} ${newMode} ${oldId} ${newId} T\t${path}`
from the structured `type-change` fields, and `status-interop.test.ts:114,317`
already pins `T` for a staged file→symlink AND its working-tree counterpart.

Also pinned (same throwaway): a leaf↔directory change at one path (`x` blob →
`x/` subtree) emits **`D x` + `A x`** (non-recursive) / **`D x` + `A x/inner`**
(recursive), NOT `T` — git's directory-entry ordering (`x` sorts as `x/`) makes
blob-`x` and tree-`x` distinct keys, so they pair as delete+add. This bounds the
reachable `type-change` pairs to the three leaf kinds.

### 2.4 The actual gap — a fixture hole, not a behaviour hole

The reconstruction arm in `whatchanged-interop` is wired but its `beforeAll`
fixture (root → modify+add → rename → empty → merge) **never creates a `T`
entry** — so the `type-change` → `T` raw-line arm is currently **un-exercised** in
the tree↔tree (`diff`/`whatchanged`) interop path. `status-interop` exercises it on
the index/worktree axes; tree↔tree does not. The deliverable is to **close the
fixture hole**, not change behaviour:

- Add a file→symlink type-change to a tree↔tree interop fixture so the `T`
  raw-line and patch reconstruction are actually compared against live git.
- Audit the OTHER kind-pairs that `kindOf` distinguishes. file↔symlink is the
  common case; file↔gitlink and symlink↔gitlink are also `!isSameKind` ⇒
  `type-change`. Decide (D2.B) whether to pin those extra pairs too, or only the
  file↔symlink pair the brief names.
- **A leaf↔directory change at one path is NOT a type-change** — pinned against
  real git (§2.3): a path `x` that is a blob in one tree and a subtree in the
  other emits a **`D` + `A` pair** (`D x`, `A x` / `A x/inner` recursively), never
  `T`. This is because git's tree-entry ordering sorts a directory entry as `x/`
  (trailing slash), so blob-`x` and tree-`x` are DISTINCT sort keys that never
  reach `classifySamePath`; they pair as a delete+add. tsgit's `diffTrees` uses
  the same `treeEntryCompare` ordering, so it reproduces this delete+add. The
  reachable `type-change` kind-pairs are therefore exactly the three LEAF-kind
  pairs (file/symlink/gitlink), and this delete+add behaviour is a faithfulness
  fact the interop fixture should also pin (a negative: assert NO `T` for the
  leaf↔directory case).

### 2.5 Proposed change

**No tsgit source change** (the audit confirms faithful behaviour on every
surface). The change is test-only: a tree↔tree `T` interop fixture (and,
per D2.B, optional gitlink-pair fixtures). This is the "pin-only" outcome the
brief anticipated.

### 2.6 Test / interop plan

**Interop — extend the tree↔tree diff interop** (smallest faithful surface;
candidate homes in D2.A: `whatchanged-interop.test.ts`, a new
`diff-type-change-interop.test.ts`, or fold into the §1 LFS file since both are
"diff a structurally-unusual blob" — recommend a dedicated
`diff-type-change-interop.test.ts` to keep each interop file single-purpose):

- Build file→symlink at one path across two commits; assert tsgit's structured
  `TreeDiff` change is `type-change` with `oldMode 100644`/`newMode 120000` and
  the correct oids; reconstruct git's `--raw` `T` line, `--name-status` `T`, and
  patch bytes; compare to live git + a frozen golden.
- Symmetric symlink→file (`120000` → `100644`).
- Per D2.B: file↔gitlink (`100644` → `160000`) and symlink↔gitlink, each pinned
  against live git's `T`.
- **Negative pin**: a leaf↔directory change (`x` blob → `x/` subtree) yields a
  `delete`+`add` pair in tsgit's `TreeDiff` (no `type-change`), reconstructing
  git's `D x` + `A x`/`A x/inner` — guards against a future regression that
  mis-classifies it as `T`.

No new unit tests are strictly required (the domain `type-change` emission is
already unit-covered in `tree-diff.test.ts` / `index-diff.test.ts` /
`diff-trees.test.ts`); if D2.B adds gitlink pairs, a domain unit test asserting
`classifySamePath`/`classifyIndexVsTree` emit `type-change` for the gitlink pairs
(not `modify`) is the cheap mutation-resistant guard.

---

## 3. Part 3 — `log` roots / parent-count filter (+ public re-export)

> Ratified by [ADR-400](../adr/400-log-parent-count-filter.md) (D3.A numeric
> `min/maxParents` pair, D3.B post-walk filter in `log.ts` — both as recommended)
> and [ADR-401](../adr/401-reexport-log-types.md) (D3.C public re-export bundled in —
> **DEVIATES** from this design's original "defer" recommendation; see §3.2/§3.4/§4).

### 3.1 Problem

`log` (`commands/log.ts`) cannot answer "give me the root commits" (or "only
merges" / "no merges") without the consumer walking the FULL history and
post-filtering `parents.length === 0`. tsgit itself does this internally
(`blame.ts:264` `data.parents.length === 0` for the boundary flag). git exposes
this directly as `rev-list --max-parents=<n>` / `--min-parents=<n>`. The brief
asks for a `maxParents`/roots filter for cheap root-commit lookup.

### 3.2 Current state (verified)

`LogOptions` (`log.ts:15`) = `{ rev?, order? ('date'|'first-parent'), limit?,
excluding?, before? }`. `log` resolves the start commit, then walks via
`walkCommitsByDate` (default) or `walkCommits` (`order: 'first-parent'`), pushing a
`LogEntry` per commit. Each `LogEntry` carries `parents: ReadonlyArray<ObjectId>`
(`log.ts:26`), so a consumer CAN post-filter — but only after materialising every
commit. `limit` is applied as a running `yielded >= opts.limit` break AFTER the
`before` time filter (`log.ts:66`). There is no parent-count filter today.

The `log` public types are not fully reachable through the shared barrel today.
`LogOptions`/`LogEntry` ARE re-exported from the commands barrel
(`application/commands/index.ts:143` — `export { type LogEntry, type LogOptions,
log } from './log.js'`), so they already ride `public-types.ts`'s
`export type * from './application/commands/index.js'` wildcard. But `LogOrder`
(`log.ts:13`, the `order` alias) is **NOT** in that barrel line, so it never reaches
`public-types.ts` (the only explicit `Log` hits there are `Logger`/`noopLogger`,
unrelated port types). `log` is exposed on the facade (`repository.ts:512`), so by
[ADR-363](../adr/363-facade-reachable-inclusion-bar.md)'s facade-reachable inclusion
bar all three types should be surfaced. Per
[ADR-401](../adr/401-reexport-log-types.md) — which deviates from this design's
original recommendation (see D3.C) — this item closes the gap NOW (it is in scope,
no longer a deferred follow-up). See §3.4 for the exact change and the `api.json`
gate.

### 3.3 Empirical pin (run in a `mktemp` throwaway, git 2.54.0)

Two-root history (orphan branch) merged into main; the merge commit has 2
parents:

| `rev-list` invocation | Result | Load-bearing fact |
|---|---|---|
| `--max-parents=0 HEAD` | both roots | roots = parent-count 0; reachable through the merge |
| `--min-parents=2 HEAD` | the merge commit only | merges = parent-count ≥ 2 |
| `--max-parents=1 HEAD` | all non-merge commits | no-merges = parent-count ≤ 1 |
| `--min-parents=1 HEAD` | all non-root commits | no-roots = parent-count ≥ 1 |
| **`--max-parents=1 -n 1 HEAD`** | the newest NON-merge commit | **filter is applied BEFORE `-n` limit** |

The last row is the critical interaction: git applies the parent-count filter
FIRST, then `-n`. The merge commit (newest by date) is filtered out, so `-n 1`
returns the newest *surviving* (non-merge) commit, not "the newest commit, then
filtered to nothing". `log` must therefore **filter-then-limit**, not
limit-then-filter.

The filter is a pure predicate on `parents.length`: keep a commit iff
`(minParents === undefined || parents.length >= minParents) && (maxParents ===
undefined || parents.length <= maxParents)`. It does NOT change the walk's
reachability or order — git still walks the same graph in the same order and only
drops commits from the OUTPUT (`--max-parents=0` still reaches both roots through
the merge, i.e. parents are still followed). So the filter is an output filter,
not a traversal pruner.

### 3.4 Proposed change — structured option(s) on `LogOptions`

The API shape is the primary decision (D3.A). The git-faithful, fully-general
form is a numeric `minParents`/`maxParents` pair, which covers roots
(`maxParents: 0`), merges (`minParents: 2`), no-merges (`maxParents: 1`),
no-roots (`minParents: 1`), and any band. A narrower `roots?: boolean` covers only
the brief's named case. The recommendation (D3.A) is the **numeric pair** —
git-faithful, structured-data-only (numbers, not a rendered string), and it
subsumes the `roots` convenience without a second redundant field.

**Filter location (D3.B).** The predicate is a pure parent-count test that needs
no extra I/O — every walked `Commit` already carries `data.parents`. It can live
EITHER (b1) post-walk in `log.ts` (filter each yielded commit before pushing to
`out`, applying the limit AFTER the parent-count filter to honour filter-then-limit
§3.3), OR (b2) threaded into the walk primitives (`walkCommits` /
`commitDateWalk`). Recommendation: **(b1) post-walk in `log.ts`** — the walk
primitives are shared by blame and other consumers whose semantics must NOT change
(adding a parent-count knob to them widens a shared contract for one caller), and
the predicate is free (no I/O), so there is no traversal-cost argument for pushing
it down. The filter sits exactly where `before` already filters (`log.ts:65`),
preserving the established structure; the `limit` break moves to fire only after
BOTH the `before` and the parent-count predicate pass (filter-then-limit). git
still follows all parents (the walk is unchanged), matching §3.3's "output filter,
not traversal pruner".

**Interaction with `order: 'first-parent'` (informational).** Under
`--first-parent`, git only ever follows the first parent, but the parent-count
filter still tests the commit's TRUE parent count (a merge under `--first-parent`
still has ≥2 parents and is still a "merge" for `--min-parents=2`). The predicate
reads `data.parents.length` (the full count), unaffected by which parents the walk
followed — so it composes correctly with both `order` modes with no special case.
This is pinned in the interop test (a `--first-parent --min-parents=2` case).

**Public re-export (D3.C → [ADR-401](../adr/401-reexport-log-types.md), in scope).**
The ratified decision bundles the `log` type re-export into this item, applying
[ADR-363](../adr/363-facade-reachable-inclusion-bar.md)'s facade-reachable inclusion
bar — the same bar under which the diff types (`DiffOptions`, `TreeDiff`, …) were
swept. Exact change: add `type LogOrder` to the existing `log.js` re-export line in
the commands barrel (`application/commands/index.ts:143`), so it reads
`export { type LogEntry, type LogOptions, type LogOrder, log } from './log.js'`.
`LogOptions`/`LogEntry` already reach `public-types.ts` through its
`export type * from './application/commands/index.js'` wildcard; adding `LogOrder` to
that one line makes all three reachable, mirroring how the sibling alias `ShortlogBy`
rides the `shortlog.js` re-export line (`index.ts:226`). No new line in
`public-types.ts` itself is needed — the wildcard does the work, keeping the change
surgical and house-consistent. Regenerate and commit the public-surface report with
`npm run docs:json` (typedoc → `reports/api.json`); the `check:doc-typedoc` gate
(`git diff --exit-code -- reports/api.json`, run under `prepush`) fails if the
committed report is stale. The new `min/maxParents` fields from §3.4 (D3.A) land in
the same regenerated report, so a consumer can construct the option from the public
types.

### 3.5 Edge semantics to pin

- `minParents > maxParents` (e.g. `{minParents: 2, maxParents: 1}`) → git yields
  the empty set (no commit can satisfy both). The predicate naturally returns the
  empty result; pin it.
- `maxParents: 0` from a tip whose history has multiple roots returns ALL roots
  reachable (pinned §3.3), because parents are still followed during the walk.
- Octopus merges (3+ parents): `--min-parents=2` includes them; `--min-parents=3`
  isolates octopus merges. The numeric pair handles this for free; a `roots`
  boolean could not express it (an argument for D3.A's numeric pair).
- `limit` + filter: filter-then-limit (§3.3). Pin `{maxParents: 1, limit: 1}`
  returns the newest non-merge, not nothing.

### 3.6 Test / interop plan

**Unit — `log.test.ts`** (extend): a fixture history with at least one root, one
merge, and several linear commits.
- `maxParents: 0` → only the root(s); `minParents: 2` → only the merge;
  `maxParents: 1` → all non-merges; `minParents: 1` → all non-roots.
- **filter-then-limit**: `{maxParents: 1, limit: 1}` → the newest non-merge (the
  merge is filtered before the limit), NOT empty and NOT the merge.
- `minParents > maxParents` → empty.
- composes with `order: 'first-parent'` (a merge still counts as ≥2 parents).
- composes with `before` and `excluding` (both filters AND the parent-count
  filter all apply before the limit break).
- default (neither field) → today's output byte-identical (regression guard).
- Isolated mutation-resistant guard tests: `minParents` alone, `maxParents` alone,
  both together, each boundary (`length === minParents`, `length === maxParents`)
  — the relational operators (`>=`/`<=`) and the off-by-one boundaries are the
  Conditional/Equality mutation hot spots; assert exact membership, never a count.

**Interop — `log-interop.test.ts`** (extend; already
`describe.skipIf(!GIT_AVAILABLE)` with a diamond+merge fixture; add a second root
via an orphan branch so `--max-parents=0` is non-trivial): for each
`min/max-parents` combination, assert tsgit's `log({...})` emitted oid sequence
equals `git rev-list <flags> --format=%H` (scrubbed `GIT_*`, isolated `HOME`,
signing off). Pin the filter-then-limit row (`--max-parents=1 -n 1` ≡
`{maxParents: 1, limit: 1}`) and the `--first-parent --min-parents=2` row.
Structured-data-only: tsgit emits oids/parents, the test reconstructs git's
selection from them.

---

## 4. Decision candidates

ADRs 226/249 fix faithfulness and the structured-data rule. The load-bearing
choices THIS feature introduces are below — each ≤3 options with a recommendation.
**All seven are now RATIFIED** by the ADR conversation; the ratified outcome and its
ADR are recorded in each row. Six matched this design's recommendation; **D3.C
deviated** — the user chose to bundle the public re-export now ([ADR-401](../adr/401-reexport-log-types.md))
rather than defer it. Per-part trace: §1 → [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md);
§2 → [ADR-399](../adr/399-type-change-already-faithful-pin-only.md); §3 →
[ADR-400](../adr/400-log-parent-count-filter.md) (filter) +
[ADR-401](../adr/401-reexport-log-types.md) (re-export). ADR dir: `docs/adr/`.

| # | Choice | Options | Recommendation |
|---|---|---|---|
| **D1.A** | What does the LFS interop pin? | (a) pointer add + pointer modify + pointer→real-file, all under the no-filter baseline, PLUS the `.gitattributes diff=lfs`-declared-but-no-driver non-interference case; (b) only pointer add + modify (no type/content transition); (c) only a single round-trip add. | **RATIFIED: (a)** — [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md). the consumer's real concern is "does tsgit stay faithful as pointers evolve AND when an lfs attribute is declared but no driver runs". (a) pins the realistic CI case; (b)/(c) leave the inert-driver boundary untested, which is exactly where a future filter port would regress. |
| **D1.B** | Is `.gitattributes diff=lfs` with an ACTIVE git-lfs driver in scope? | (a) explicitly OUT of scope (declare it, test only the no-driver baseline); (b) attempt to pin it (requires git-lfs installed in CI + a filter port to match). | **RATIFIED: (a)** — [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md). tsgit has no filter port; reproducing a smudged diff is impossible without inventing one (a separate large backlog item). Declaring the boundary (§1.7) is the faithful, honest scope. |
| **D2.A** | Where does the tree↔tree `T` interop fixture live? | (a) new dedicated `diff-type-change-interop.test.ts`; (b) extend `whatchanged-interop.test.ts`'s `beforeAll` fixture to include a `T` entry; (c) fold into the §1 LFS interop file. | **RATIFIED: (a)** — [ADR-399](../adr/399-type-change-already-faithful-pin-only.md). keeps each interop file single-purpose (the house pattern: one `*-interop.test.ts` per surface). (b) exercises the existing dead `T` arm but mixes a structural change into the whatchanged history fixture (which other assertions depend on); (c) conflates two unrelated brief parts. |
| **D2.B** | Which kind-pairs does part 2 pin? | (a) only file↔symlink (both directions) — the brief's named case; (b) file↔symlink AND file↔gitlink AND symlink↔gitlink (every reachable leaf-kind pair); (c) file↔symlink + a single representative gitlink pair. | **RATIFIED: (b)** — [ADR-399](../adr/399-type-change-already-faithful-pin-only.md). `kindOf` distinguishes four kinds; three leaf-kind pairs are reachable as a same-path `type-change` (directory cannot co-occur with a leaf at one path). Pinning all three closes the audit completely for one extra fixture each; (a) leaves gitlink type-changes unpinned despite the consumer being a real repo with submodules. |
| **D3.A** | `log` parent-count API shape | (a) numeric `minParents?`/`maxParents?` pair on `LogOptions`; (b) a narrow `roots?: boolean`; (c) both (numeric pair + `roots` convenience alias). | **RATIFIED: (a)** — [ADR-400](../adr/400-log-parent-count-filter.md). git-faithful and fully general: covers roots (`maxParents:0`), merges (`minParents:2`), no-merges (`maxParents:1`), no-roots (`minParents:1`), octopus bands — all the brief's named cases and more, with no rendered string (ADR-249-clean). (b) cannot express merges/octopus; (c) adds a redundant field that (a) already subsumes. |
| **D3.B** | Where does the parent-count filter run? | (a) post-walk in `log.ts` (alongside the existing `before` filter, limit applied after); (b) threaded into the walk primitives (`walkCommits`/`commitDateWalk`). | **RATIFIED: (a)** — [ADR-400](../adr/400-log-parent-count-filter.md). the predicate is pure and I/O-free (every `Commit` already carries `parents`), so there is no traversal-cost reason to push it down; keeping it in `log.ts` avoids widening the shared walk-primitive contract that blame and other consumers depend on. Honours filter-then-limit (§3.3) by moving the limit break after the predicate. |
| **D3.C** | `LogEntry`/`LogOptions`/`LogOrder` public re-export | (a) leave as-is (not re-exported, matching today; defer as a follow-up); (b) re-export `LogOptions`/`LogEntry`/`LogOrder` via the commands barrel as part of this item. | **RATIFIED: (b)** — [ADR-401](../adr/401-reexport-log-types.md). The design originally recommended (a); the user chose (b). `log` plainly meets [ADR-363](../adr/363-facade-reachable-inclusion-bar.md)'s facade-reachable inclusion bar (the same bar that swept the diff types), so the omission is a bug in the original sweep, not a new surface decision; and `LogOptions` is already being edited for D3.A, so the consumer touch-point is in scope. Bundle now: add `type LogOrder` to the `log.js` barrel line (§3.4) and commit the regenerated `reports/api.json`. |

---

## 5. Out of scope

- **An LFS filter / clean-smudge / textconv port** — part 1 pins the no-filter
  baseline ONLY (§1.7). Reproducing git-lfs's smudged diff (active `filter=lfs
  diff=lfs` + installed driver) needs a filter port tsgit does not have; that is a
  separate, large backlog item. The interop environment is deliberately hardened
  (no driver in isolated `HOME`) so the baseline is what's pinned.
- **A `--diff-filter` surface on `diff`** — none exists today, and part 2 needs
  none (`T` already surfaces by default, faithful to git; §2.2). Adding a
  result-filtering knob would be a rendering/selection concern (ADR-249-adjacent),
  not required by this brief.
- **Changing `type-change` emission** — part 2 is pin-only; the domain already
  emits `type-change` on every surface. No `tree-diff.ts`/`index-diff.ts`/
  `status.ts` behaviour change.
- **Threading parent-count into the walk primitives** — rejected in D3.B; the
  shared `walkCommits`/`commitDateWalk` contract stays unchanged so blame and
  future walk consumers are byte-unaffected.
- **`git log --no-merges`/`--merges` as named convenience flags** — git itself
  models these as `--max-parents=1`/`--min-parents=1` aliases; the numeric pair
  (D3.A) covers them, so no separate boolean flags are added.
