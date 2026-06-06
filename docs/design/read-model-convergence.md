# Design — read-model convergence (capstone)

## Goal

The capstone of the 23.4 API-foundation pass. The earlier sub-items (a–i) built
and hardened the **read model** — the Tier-2 read primitives every inspection
command sits on. This item closes the loop: the porcelain reads stop reinventing
those primitives and become **thin projections over them**.

The item is **sequenced last and gated on an over-design caution**: *force
nothing until the right shape is evident from the full surface.* So this design
is deliberately narrow. It converges only what the full command surface now
proves is ready, and it explicitly **rejects** building a new abstraction layer.

## Thesis — the read model already exists; it is the Tier-2 primitives

There is no missing "read model" to invent. It is already shipped, proven, and
consumed:

| read concern            | the primitive that owns it                                  |
|-------------------------|-------------------------------------------------------------|
| reachable commit set    | `walkCommitsByDate` (date order) / `walkCommits` (topo, first-parent) |
| rev → oid (grammar)     | `revParse` (`~`/`^`/`@{…}`/`:path`/oid-prefix)              |
| object / blob / tree    | `readObject` / `readBlob` / `readTree`                       |
| tree-vs-tree diff       | `diffTrees`                                                  |
| working / index / tree state | `snapshot.*`                                           |

"Convergence" = make the porcelain reads **call these** instead of carrying
bespoke copies. The capstone does not add a `ReadModel` facade object or new
accessors — that would be the over-design the backlog warns against, and the
accessor-shape question is the **separate, still-deferred 23.4k** (gated on this
item precisely so it is decided *after* the model proves out, not here).

## Current state — what already converged, and the one holdout

Most reads already project cleanly:

- `show` resolves via `revParse`, reads via `readObject`, diffs via `diffTrees`.
- `status` projects over `diffIndexAgainstTree` + `compareWorkingTreeDelta`.
- `blame` / `describe` drive the shared `domain/commit` priority queue.
- `readFileAt` is a thin `revParse` + tree-descent + `readBlob`.
- `cat-file` is `readObject`; `reflog` is `readReflog` (not a commit walk).

**`log` is the holdout.** It is the one inspection command that still carries:

1. **A bespoke commit walk.** It calls `walkCommits` with `order: 'first-parent'`.
   But `git log` with no order flag walks **all parents in committer-date order**
   (git's commit-date priority queue) — exactly what `walkCommitsByDate` was built
   for ("the Core a converged `log` projects over", ADR-261). The current
   first-parent default is a **faithfulness divergence**: `repo.log()` on a branchy
   history omits every merged-in commit that `git log` shows.

2. **A bespoke, weaker rev-resolver.** `resolveStart` tries `rev`,
   `refs/heads/<rev>`, `refs/tags/<rev>` literally — **no `~`/`^`/`@{…}` grammar,
   no oid-prefix, and no tag peel.** So `repo.log({ rev: 'HEAD~3' })` throws, and
   `repo.log({ rev: <annotated-tag> })` walks from the tag object and yields
   nothing (the reader skips the non-commit). `git log HEAD~3` and
   `git log v1.0` both work. `resolveExcluding` has the same gap and additionally
   **silently swallows** an unresolvable exclusion (git errors `bad revision`).

`diff` has a lesser version of gap (2): `resolveTreeId` resolves only an oid or a
ref name (no `^`/`~`), then peels a commit to its tree by hand. `git diff HEAD^`
works; `repo.diff({ from: 'HEAD^' })` throws.

## Scope

| change | in this PR? | why |
|--------|-------------|-----|
| `log` default → `walkCommitsByDate` (all-parents, committer-date order) | **yes** | the headline faithfulness fix + the projection the read model was built for |
| `log` gains `order` (`'date'` default, `'first-parent'` opt-in) | **yes** | preserves the current first-parent walk as an explicit, faithful (`git log --first-parent`) mode |
| `log` `rev`/`excluding` → full grammar via `revParse`, peel-to-commit | **yes** | makes `log` a thin projection of the rev grammar; fixes `~`/`^`/tag-peel/oid-prefix gaps |
| `log` unresolvable `excluding`/`rev` → throw (not skip) | **yes** | the shared resolver throws; faithful to git's `bad revision`; sheds the swallow + its equivalent-mutant suppressions |
| `diff` `from`/`to` → full grammar (peel-to-tree) | **yes, feature slice** | a behaviour change (more faithful: `git diff HEAD^` now works), so a feature slice — not the behaviour-preserving arch pass |
| extract the shared `revParse` + `peelTo` resolver (log + diff co-own) | **yes, architecture pass** | the DRY/centralisation gain, behaviour-preserving once both already resolve via the grammar |
| new `ReadModel` facade / `repo.tree(rev)` accessors | **no** | over-design; the accessor shape is the deferred **23.4k**, gated on *this* item |
| strict `git rev-list --date-order` (forged reverse-causal dates) | **no** | ADR-261 defers it here "built only if a converged porcelain needs it" — it does not (see §Rejected) |
| `order: 'topo'` / `'author-date'` | **no** | not byte-pinnable against git today; YAGNI until a faithful pin is feasible (see §Rejected) |
| fold `describe`'s bespoke date walk onto `walkCommitsByDate` (23.4l) | **no** | rule-of-three unmet + describe's walk carries candidate/depth bookkeeping; re-evaluated in the architecture pass, stays deferred |
| add `subject` to `LogEntry` | **no** | derived cosmetics; ADR-249 says return raw `message`, caller folds via `foldSubject` |

## The converged `log` surface

```ts
export type LogOrder = 'date' | 'first-parent';

export interface LogOptions {
  readonly rev?: string;                    // commit-ish, full grammar; default 'HEAD'
  readonly order?: LogOrder;                // default 'date'
  readonly excluding?: ReadonlyArray<string>; // commit-ish stops (exclusive), full grammar
  readonly limit?: number;
  readonly before?: Date;                   // committer-date filter (git --before)
}

export interface LogEntry {                 // UNCHANGED
  readonly id: ObjectId;
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly message: string;
}
```

**Projection body** (the whole command, once resolution is shared):

```
start    ← resolveCommit(ctx, rev ?? 'HEAD')           // grammar + peel-to-commit
excludes ← excluding.map(e => resolveCommit(ctx, e))   // throws on a bad rev (faithful)
walk     ← order === 'first-parent'
             ? walkCommits(ctx, { from: [start], until: excludes, order: 'first-parent' })
             : walkCommitsByDate(ctx, { from: [start], until: excludes })
for await (commit of walk):
  if before and commit.committer.timestamp ≥ before: continue   // skip, keep walking
  out.push(project(commit))
  if out.length === limit: break
```

Resolution is the existing grammar primitive **`revParse`** plus a **shared
peel-to-target**: `log` peels to a commit, `diff` peels to a tree. The shared
piece is therefore `revParse` (grammar) + one `peelTo(ctx, id, target)` helper,
replacing `log.resolveStart`/`resolveExcluding` and `diff.resolveTreeId`. Peeling
an annotated tag follows it to its object; a rev that cannot reach the wanted kind
refuses as git does (`git log <tree>` → *"does not have a commit"*). The working
name for `log`'s composition is `resolveCommit(ctx, rev)` = `revParse` +
`peelTo(commit)`.

`before` stays a **post-walk skip filter** (not a walk stop): in newest-first order
the newest commits are skipped until the frontier drops below the threshold, after
which every remaining commit passes — identical to today and to `git log --before`.

### `excluding` semantics — per-oid boundary, not ancestor painting (unchanged)

Both walks treat `until` as a **per-oid boundary**: the listed commit is not
yielded and is not expanded, so on a linear segment it transitively excludes the
ancestors reachable *only* through it. It does **not** paint all commits reachable
from the excluded oid the way git's true `^X` does — in a DAG, an excluded
commit's ancestor reachable by another path still appears. This is the **existing**
`log`/`walkCommits` behaviour (the 23.4 sub-items left it as-is); this convergence
preserves it verbatim and does **not** add reachability painting. The `excluding`
interop golden therefore uses a **linear** segment (`HEAD~2..HEAD`), where the
boundary and git's `^` coincide; full `^`-reachability exclusion is a separate,
out-of-scope rev-list feature.

## Faithfulness anchors (git source)

- **Default order** — `git log` / `git rev-list` with no order flag order the
  frontier by **committer timestamp, newest first** (the commit-date `prio_queue`,
  `commit.c: compare_commits_by_commit_date`). `walkCommitsByDate` is exactly this
  (lazy ≡ git's queue for every causally-dated history; ADR-261 §"Date-order
  scope"). Equal-date heap order is git-unspecified → goldens use strictly-distinct
  dates; the oid tie-break is a unit concern.
- **`--first-parent`** — follows only `parents[0]`; `walkCommits`
  `order: 'first-parent'` already is this.
- **Rev grammar + peel** — `git log <rev>` / `git diff <rev>` resolve `<rev>` via
  gitrevisions and **peel** an annotated tag to the commit/tree the context needs
  (`sha1-name.c`). `revParse` + peel-to-commit reproduces this.
- **Bad revision** — `git log ^<bad>` exits with *"bad revision"*; the shared
  resolver throwing `REF_NOT_FOUND` / `OBJECT_NOT_FOUND` co-refuses (structured).

## Decisions requiring an ADR (surfaced to the user before the plan)

1. **Capstone framing.** Focused convergence (this design) vs a broader unified
   read-model facade across all reads vs minimal (`order: 'date'` opt-in only,
   keep the first-parent default). Recommended: **focused**.
2. **`log` default order.** `'date'` (faithful to `git log`, all-parents —
   breaking output change for branchy histories) vs keep `'first-parent'` default
   with `'date'` opt-in (non-faithful default, non-breaking). Recommended:
   **`'date'`** (the prime directive points here; 23.4 is the breaking window).
3. **`order` surface.** `'date' | 'first-parent'` (both byte-pinnable vs `git log`
   / `git log --first-parent`) vs also `'topo'` / `'author-date'`. Recommended:
   **`'date' | 'first-parent'`**, defer the rest (YAGNI + no faithful pin yet).

## Rejected alternatives

- **A `ReadModel` facade / `repo.tree(rev)` accessors** — over-design; this item's
  whole gating premise is "force nothing." Accessor shape is **23.4k**, gated on
  the model proving out *through this convergence*.
- **Strict `--date-order`** — the converged `log`'s default *is* git's default
  (commit-date queue), which the lazy `walkCommitsByDate` already matches for every
  causally-dated history. Forged reverse-causal committer dates are the only
  divergence, and no converged porcelain needs them. Per ADR-261 we build it "only
  if needed" — it is not. Stays deferred.
- **`order: 'topo'` / `'author-date'`** — `walkCommits` topo is a BFS that is not
  obviously byte-faithful to `git log --topo-order`'s branch-grouping; author-date
  ordering needs a walk the model does not have. Neither is pinnable today; add
  when a faithful pin exists.
- **Folding `describe`'s walk onto `walkCommitsByDate` (23.4l)** — describe's walk
  is a date-ordered BFS entangled with tag-candidate reachability and finish-depth
  bookkeeping; it is not a plain "reachable set, newest-first." Even with the
  converged `log` as a date-walk consumer, the shapes differ; rule-of-three on a
  *plain* date walk is unmet. Confirmed (not refuted) in the architecture pass.
- **A `subject` field on `LogEntry`** — `foldSubject` already exists domain-side;
  emitting a folded subject is the caller's projection (ADR-249).

## Tests

### `log` — unit (`log.test.ts`, extended)

Existing linear-chain cases stay green (date ≡ first-parent on a chain). New:

- **all-parents date order (the headline):** a diamond `A→B,C→D` (merge `D`) with
  strictly-increasing committer dates `a<b<c<d` → default `log` yields `[D,C,B,A]`
  (a first-parent mutant yields `[D,B,A]`, dropping `C`).
- **`order: 'first-parent'`:** same diamond → `[D,B,A]` (pins the branch onto
  `walkCommits`; default-order mutant would re-add `C`).
- **tie-break:** two same-date commits pop oid-ascending (inherited from `precedes`).
- **grammar `rev`:** `rev: 'HEAD~2'` starts two back (current resolver throws here).
- **annotated-tag `rev` peels** to its commit (current resolver yields nothing).
- **`excluding` grammar:** `excluding: ['HEAD~1']` (a real range) stops correctly.
- **bad `excluding` throws** `REF_NOT_FOUND` with `.data` asserted (was silently
  skipped) — isolated from the bad-`rev` case (guard-isolation).
- **`limit` / `before`** cases retained, re-pointed at the new walk.
- **unborn HEAD** still refuses, but the code changes `REF_NOT_FOUND` →
  `OBJECT_NOT_FOUND`: routing the start through `revParse` (whose `resolveBase`
  swallows the ref miss and falls through to `objectNotFound`) makes `log`
  **consistent** with `show`/`readFileAt`, which already resolve via the grammar.
  The refusal *condition* (unborn HEAD → throw) is preserved; only the structured
  code aligns. Documented in the PR.

Guard-isolation: the `order` branch gets independent date- and first-parent cases;
the two resolver throw-paths (`rev` vs each `excluding`) get independent cases.

### `log` — interop (`log-interop.test.ts`, new, `skipIf(!GIT_AVAILABLE)`)

Build a branchy DAG with strictly-decreasing committer dates via real `git`
(scrubbed `GIT_*`, signing off), then assert the `repo.log()` oid sequence equals:

- `git log --format=%H` (default order) — pins all-parents committer-date order;
- `git log --first-parent --format=%H` for `order: 'first-parent'`;
- `git log --format=%H <annotated-tag>` — pins the tag peel;
- `git rev-list --format=%H HEAD~2..HEAD` shape for a grammar `excluding` range.

Distinct dates keep the goldens independent of git's unspecified equal-date order.

### `diff` (feature slice) — `from: 'HEAD^'` resolves to the parent's tree (unit)
+ an interop step reconstructing the `git diff HEAD^ HEAD` changed-path set. The
architecture pass then extracts the shared `revParse` + `peelTo` resolver both
`log` and `diff` co-own (behaviour-preserving), with its diff scoped to the
`refactor(...)` commits.

## Coverage / mutation

100% line/branch/function/statement on every touched file; 0 surviving killable
mutants. Awkward spots and their kills:

- `order` branch → the diamond date-vs-first-parent pair.
- peel-to-commit → the annotated-tag case (+ a peels-to-tree refusal case).
- resolver throw → the isolated bad-`rev` / bad-`excluding` cases.
- `before` `≥` boundary, `limit` break → retained boundary cases.

Removing the two `resolveExcluding` `// Stryker disable` suppressions is a **net
reduction** in suppressions: the swallow they annotated is gone (the shared
resolver throws), so the lines they guarded no longer exist.

No `v8 ignore` / `stryker-disable` directives added. Any genuinely equivalent
mutant is annotated inline `// equivalent-mutant: <why>` only.

## Out of scope (logged, not done)

- 23.4k snapshot source accessors — gated on this item; the focused convergence
  here is the proof-out it waited for. The accessor decision is its own workflow.
- 23.4l describe-walk consolidation — stays deferred (justified above).
- Strict `--date-order`, `topo`/`author-date` order — deferred (justified above).
- Publicly exporting `foldSubject` / a `subject` projection — YAGNI.
