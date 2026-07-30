# Design — shallow-boundary commit walk (grafted parents)

> Brief: on a `git clone --depth N` repository every tsgit commit traversal follows the
> boundary commit's recorded parents into objects the repo does not have and throws
> `OBJECT_NOT_FOUND`; canonical git treats a `.git/shallow` commit as parentless.
> Status: self-reviewed ×3 → awaiting ADR decisions

## Context

### The defect

`.git/shallow` is a newline-separated list of *graft-boundary* commit oids. The boundary
commit object still records its true parents — the repository simply does not have them.
Canonical git applies the shallow set as a **graft at commit-parse time**, so every
traversal, and every parent list git *reports*, sees an empty parent list for a boundary
commit. `git cat-file` bypasses parsing and still prints the true `parent` line.

tsgit already has the whole `.git/shallow` file surface — `readShallow` / `updateShallow`
(`src/application/primitives/shallow-file.ts`), wired into `clone`
(`src/application/commands/clone.ts:148`) and `fetch`
(`src/application/commands/fetch.ts:172`) — and both walk primitives already accept an
optional `shallow?: ReadonlySet<ObjectId>` boundary set
(`src/application/primitives/types.ts:120-152`, honoured at
`walk-commits.ts:142` and `internal/commit-date-walk.ts:114`).

**No caller anywhere in `src/` ever passes it.** Verified: the only `shallow`
occurrences outside `shallow-file.ts` / `fetch-pack` / `domain/protocol` are the option
declarations themselves. The option is dead wiring; every walk on a shallow repository
expands the boundary commit's true parents and dies on the first missing object.

Downstream impact: sfdx-git-delta's `getFirstCommitRef` (`rev-list --max-parents=0 HEAD`)
fails on any CI checkout with a limited fetch depth — the single most common CI clone shape.

### Surfaces that traverse or report parents

| Site | Symbol / line | Reaches parents via |
|---|---|---|
| `src/application/primitives/walk-commits.ts` | `walkCommits`, `enqueueParents:134`, `resolveFrontierEntry:70` | `readCommit` + `commitHeader` |
| `src/application/primitives/internal/commit-date-walk.ts` | `commitDateWalk`, `enqueueParents:128`, `selectParents:24` | `readCommit` + `commitHeader` |
| `src/application/primitives/internal/read-commit.ts` | `readCommit:18` | `readObject` |
| `src/application/primitives/internal/read-commit-graph.ts` | `commitHeader`, `CommitHeader.parents` | commit-graph file |
| `src/application/commands/internal/history-rewrite.ts` | `readCommitData:15` | `readObject` |
| `src/application/commands/log.ts` | `log:47`, reports `parents:71`, filters `withinParentBand:33` | walk |
| `src/application/commands/show.ts` | `ShowCommitResult.commit`, `patch` via `diffCommitAgainstParent` | `readObject` |
| `src/application/commands/blame.ts` | `processSuspect:249`, `finalize` boundary flag `:293` | `readCommitData` |
| `src/application/commands/name-rev.ts` | `expandParents:126` | `readObject` |
| `src/application/commands/rev-parse.ts` | `getNthParent:182` | `readObject` |
| `src/application/commands/describe.ts` | `selectNearest:376` | `commitDateWalk` |
| `src/application/commands/whatchanged.ts` | `:55`, `:59`, `:63` | walk |
| `src/application/commands/shortlog.ts` `range-diff.ts` `cherry-pick.ts` `revert.ts` `rebase.ts` `push.ts` `reflog.ts` | per-caller table in §4 | walk / `readCommitData` |
| `src/application/primitives/merge-base.ts` | `paint:78` | `readObject` |
| `src/application/primitives/bisect-midpoint.ts` | `paintReachable:38`, `:100` | `readObject` |
| `src/application/primitives/enumerate-push-objects.ts` `enumerate-bundle-objects.ts` | `:62`, `:166` | walk |
| `src/application/commands/internal/fsck/reachability.ts` | `:14` | `readObject` |

### Constraining prior decisions

- **ADR-226** (git-faithfulness prime directive) — observable behaviour byte-for-byte.
- **ADR-249** (structured data only) — mask the *data* (`parents` arrays, refusals), never a
  rendered string.
- **ADR-532 / 540** (linked-worktree write-surface sweep) — `shallow` already resolves through
  `commonGitDir(ctx)` (`shallow-file.ts:33`). Pinned below as correct.
- **ADR-275 / 261** — one shared date-ordered walk core (`commitDateWalk`); `walkCommitsByDate`
  is a thin projection. Any masking must land in the core, not be copied per consumer.
- Per-`Context` memoised state is the house pattern:
  `read-object.ts:15 registryCache`, `read-commit-graph.ts graphCache/headerCache`,
  `internal/loose-oid-cache.ts fanoutCache` (+ `invalidateLooseOid` called from
  `write-object.ts:49`).

## Requirements

Ship-verifiable statements. "Boundary" = a commit oid present in the repository's shallow set.

1. On a `--depth N` clone, `walkCommits({ from: [HEAD] })` and
   `walkCommitsByDate({ from: [HEAD] })` complete without error and yield exactly the
   commits `git rev-list HEAD` yields, in the same order semantics as today.
2. `log({ maxParents: 0 })` returns the boundary commit(s), matching
   `git rev-list --max-parents=0 HEAD`. This is the reported-defect acceptance test.
3. Every `LogEntry.parents` for a boundary commit is `[]`, matching `git log --format=%P`.
4. `catFile` / `readObject` on a boundary commit still report the **true** parents.
5. A commit-graph is treated as **absent** whenever the shallow file exists (matching git's
   `commit_graph_compatible` gate), so a stale graph can never re-introduce a masked parent.
6. `.git/shallow` is read from the **common** git dir; a linked worktree of a shallow repo
   observes the same masking.
7. All boundary handling is derived from the repository's shallow set; no command carries a
   caller-visible "am I shallow" flag.
8. A repository with no `.git/shallow` behaves exactly as today — zero behavioural delta,
   and no more than one extra filesystem probe per `Context`.
9. Every pinned-matrix row describing behaviour tsgit implements is covered by a cross-tool
   interop test. Rows covering git's *writer* (C8–C12) and the parser grammar (D1–D13) are
   discharged by the commit-graph reader gate and by unit/property tests respectively.

## Design

### §1 — Empirical pin (git 2.55.0, macOS, `mktemp` throwaway, `GIT_*` scrubbed, isolated `HOME`, signing off)

Fixture unless stated: 5 linear commits `c1..c5` (oids `C1..C5`), `git clone --depth 2 file://<src>`
⇒ local objects `{C5, C4}`, `.git/shallow` = `{C4}`.

**A. Traversal and reported parents**

| # | Command | Result |
|---|---|---|
| A1 | `od -c .git/shallow` | `59c8…31cc \n` — one 40-hex oid, LF-terminated, no trailing blank |
| A2 | `git rev-parse --is-shallow-repository` | `true` |
| A3 | `git rev-list --max-parents=0 HEAD` | `C4` (**the defect case** — the boundary, not `C1`) |
| A4 | `git rev-list HEAD` | `C5`, `C4` (exit 0) |
| A5 | `git rev-list --count HEAD` | `2` |
| A6 | `git log --format='%H %P'` | `C5 C4` / `C4 ` — **boundary reports an empty parent list** |
| A7 | `git log --format='[%h\|%p]'` | `[d108aca\|e2da71c]`, `[e2da71c\|]` — abbrev form masked too |
| A8 | `git cat-file -p C4` | still prints `parent C3` — **object content is NOT grafted** |
| A9 | `git cat-file --batch-check`, `git cat-file commit C4` | raw, true parent |
| A10 | `git rev-list --parents HEAD` | `C5 C4` / `C4` (boundary line has no parent) |
| A11 | `git rev-list --boundary HEAD` | `C5`, `C4` (no extra boundary marker line) |
| A12 | `git rev-parse HEAD~1` / `C4^` … | `C4` / `fatal: ambiguous argument 'C4^': unknown revision…` exit 128 |
| A13 | `git rev-parse HEAD~2` | `fatal: ambiguous argument 'HEAD~2': unknown revision…` exit 128 |
| A14 | `git rev-list C4..C5` | `C5` (range whose base IS the boundary works) |
| A15 | `git rev-list C3..HEAD` | `fatal: Invalid revision range C3..HEAD` exit 128 (base beyond the boundary) |
| A16 | `git rev-list --ancestry-path C4..HEAD` | `C5` |
| A17 | `git rev-list HEAD --not C4` | `C5` |
| A18 | `git merge-base HEAD C4` | `C4` exit 0 |
| A19 | `git merge-base HEAD C3` | `fatal: Not a valid commit name C3` exit 128 |
| A20 | `git merge-base --is-ancestor C4 HEAD` | exit 0 |
| A21 | `git merge-base --independent HEAD C4` | `C5` |
| A22 | `git log --format=%H -- f.txt` (pathspec) | `C5`, `C4` — stops at the boundary |
| A23 | `git log --name-status` on `C4` | `A f.txt`, `A g1..g4` — **boundary diffs against the empty tree** |
| A24 | `git show --no-ext-diff --stat --format='%H p=[%P]' C4` | `<oid> p=[]` then `5 files changed, 8 insertions(+)` — **root-commit shape: diffed against the empty tree** |
| A25 | `git log --format=%H --min-parents=1` | `C5` only |
| A26 | `git rev-list --first-parent --max-parents=0 HEAD` | `C4` |
| A27 | `git blame f.txt` | 4 lines `^59c8808` (boundary marker), 1 line `47a629a1`; `--line-porcelain` emits `boundary` for 4 lines |
| A28 | `git describe HEAD` (annotated `v0.4` on `C4`) | `v0.4-1-g47a629a` exit 0 |
| A29 | `git describe C4` | `v0.4` |
| A30 | `git name-rev HEAD` | `HEAD main` |
| A31 | `git shortlog -s -n HEAD` | `2 T` |
| A32 | `git fsck --strict --no-progress` | clean, exit 0 |
| A33 | `git bundle create b.bundle HEAD` / `--all` | exit 0 (succeeds from a shallow clone) |
| A34 | `git push <bare> HEAD:refs/heads/main` | client enumerates fine; **server** rejects: `! [remote rejected] … (shallow update not allowed)` |
| A35 | `git revert --no-edit C4` | `CONFLICT (modify/delete): f.txt deleted in (empty tree)` — replayed against the empty tree |
| A36 | `git cherry-pick C4` | `CONFLICT (add/add)` — same graft, boundary behaves as a root |
| A37 | `git bisect start HEAD C4` | works; reports `C5 is the first 'bad' commit` |
| A38 | `git fetch --deepen 1` | `.git/shallow` rewritten to `{C3}`; `rev-list --count HEAD` = 3; `--max-parents=0` = `C3` |
| A39 | `git fetch --unshallow` | `.git/shallow` **removed**; count 5; `--max-parents=0` = `C1` |

**B. Depth-1 and merge boundaries**

| # | Case | Result |
|---|---|---|
| B1 | `--depth 1`: `.git/shallow` | `{C5}` — HEAD itself is the boundary |
| B2 | `--depth 1`: `git log --format='[%H\|%P]'` | `[C5\|]`; `--max-parents=0` ⇒ `C5`; `show --stat` ⇒ root shape |
| B3 | merge history `base → {side1, main1} → merge`, `--depth 2`: `.git/shallow` | **two** entries (`side1`, `main1`), lexicographically sorted, LF-terminated |
| B4 | B3: `git rev-list HEAD` | merge, `side1`, `main1` (count 3) |
| B5 | B3: `git log --format='%H %P'` | both parents of the merge report empty parent lists |
| B6 | B3: `git rev-list --max-parents=0 HEAD` | **both** boundary commits |
| B7 | B3: `git merge-base HEAD HEAD^2` | `main1` (works inside the available set) |

**C. Commit-graph coexistence — decisive**

Fixture: full 5-commit clone, `git commit-graph write --reachable`, then `.git/shallow`
hand-written. All objects present unless stated.

| # | Case | Result |
|---|---|---|
| C1 | Full repo, graph, **no** shallow | `rev-list HEAD` ⇒ 5; `--max-parents=0` ⇒ `C1` |
| C2 | Full repo, graph, shallow=`{C4}` (parents **available**) | `rev-list HEAD` ⇒ `C5`, `C4` only; `--max-parents=0` ⇒ `C4`; `%P` masked. **Shallow masking wins over an available, graph-known parent.** |
| C3 | Full repo, graph, shallow=`{C2}` (mid-history) | `rev-list HEAD` ⇒ `C5,C4,C3,C2`; `--max-parents=0` ⇒ `C2`. Masking is applied by oid, independent of object availability |
| C4 | Graph present, **`C3`'s loose object deleted**, no shallow | `rev-list HEAD` ⇒ **5 commits, exit 0** — git traverses from the graph without reading objects |
| C5 | Same, plus shallow=`{C1}` (masks nothing real) | `error: Could not read C3` / `fatal: Failed to traverse parents of commit C4`, **exit 128** |
| C6 | Same, plus **empty (0-byte)** shallow file | identical failure to C5 |
| C7 | Restore `C3`, keep empty shallow | `rev-list --count HEAD` ⇒ 5 |
| C8 | `git commit-graph write --reachable` with shallow present (no prior graph) | **exit 0, writes nothing** (`objects/info/` stays empty) — a silent refusal, not an error |
| C9 | Same with `--split` | exit 0, writes nothing |
| C10 | `git -c gc.writeCommitGraph=true gc` with shallow present | exit 0, no graph written |
| C11 | `commit-graph write` with an **empty** shallow file | exit 0, writes nothing |
| C12 | `git commit-graph verify` with a pre-existing graph + shallow | `commit-graph parent list for commit C4 is too long` |

**C4 vs C5/C6 is the decisive pair.** Adding a shallow file — *even an empty one* — makes git
stop using the commit-graph entirely: a traversal that succeeded graph-only now fails on the
missing object. The gate is **file presence**, not set non-emptiness (C6, C11), matching git's
`is_repository_shallow` (a file that opens ⇒ shallow, whatever its content) feeding
`commit_graph_compatible`.

**D. `.git/shallow` parsing**

| # | File content | Result |
|---|---|---|
| D1 | absent | `--is-shallow-repository` ⇒ `false`; no masking |
| D2 | 0 bytes | `--is-shallow-repository` ⇒ **`true`**; no masking (5 commits, root `C1`); graph still disabled (C6/C11) |
| D3 | `<40-hex>\n` | masked, canonical |
| D4 | `<40-hex>` (no trailing newline) | masked — accepted |
| D5 | `<40-hex>\r\n` | masked — accepted (`\r` ignored) |
| D6 | `<40-hex> trailing junk\n` | masked — **accepted** (prefix parse; git validates only the first 40 hex chars) |
| D7 | `<UPPERCASE-40-hex>\n` | masked — accepted |
| D8 | duplicate + unsorted entries, no blank lines | accepted, set semantics |
| D9 | leading/embedded blank line | `fatal: bad shallow line: ` **exit 128** |
| D10 | trailing blank line at EOF (`<oid>\n\n`) | `fatal: bad shallow line: ` **exit 128** |
| D11 | `not-an-oid\n<oid>\n` | `fatal: bad shallow line: not-an-oid` exit 128 — even `rev-parse --is-shallow-repository` dies |
| D12 | 39-hex short line | `fatal: bad shallow line: <line>` exit 128 |
| D13 | oid not present in the object store | **inert** — no masking, no error, `--is-shallow-repository` still `true` |

> **Divergence found.** `readShallow`'s doc comment (`shallow-file.ts:41-42`) asserts
> *"Malformed lines are tolerated (skipped) — canonical git behaves the same"*. D9–D12 refute
> that: git **dies** on any line whose first 40 characters are not hex. tsgit is more tolerant
> on D9/D11/D12 and *stricter* on D6 (its `SHA_ANY_RE` is `$`-anchored after `.trim()`, so it
> drops a line git accepts). Addressed as decision candidate **#4**.

**E. Linked worktree (ADR-532 confirmation)**

| # | Case | Result |
|---|---|---|
| E1 | `git worktree add` from a shallow repo | `.git/worktrees/<name>/` contains `commondir gitdir HEAD index logs ORIG_HEAD refs` — **no `shallow`** |
| E2 | `git -C <linked-wt> rev-parse --is-shallow-repository` | `true` |
| E3 | `git -C <linked-wt> rev-list HEAD` / `--max-parents=0` | identical masking to the main worktree |

`commonGitDir(ctx)` in `shallow-file.ts:33-34` is therefore already correct; no path change needed.

### §2 — The model: graft at parse, not at enqueue

git's masking is **not** an enqueue-time filter. `parse_commit_buffer` consults the graft
table and installs the *grafted* parent list on the in-memory commit. Everything downstream —
traversal, `%P`, `--max-parents`, diff-against-parent, blame's boundary flag, replay
base-tree selection — reads that already-masked list. Only raw-object surfaces (`cat-file`,
`--batch`) see the true `parent` header.

The pins force this model rather than a narrower one:

- **A6/A7/A10** — reported parents are masked, so an enqueue-only filter (today's dead
  `shallow` option shape) is insufficient: `log` would still report `C4`'s true parent, and
  requirement 2 (`maxParents: 0`) would still miss the boundary.
- **A23/A24** — `show`/`whatchanged` diff the boundary against the **empty tree**, i.e. they
  read `parents[0]` from the masked list.
- **A27** — blame's boundary marker is exactly `parents.length === 0` on the masked list
  (`blame.ts:293` already computes it that way; it just needs a grafted read).
- **A35/A36** — replay commands take the same masked list as their base tree.
- **A13** — `rev-parse HEAD~2` must *refuse*. Today `getNthParent` reads `C4`, returns the
  recorded `C3` oid, and hands the caller an oid whose object does not exist — a live
  divergence independent of the reported crash.

So the change is: **introduce a grafted commit-read tier**; leave `readObject` / `catFile`
raw. Breadth is decision candidate **#1**.

### §3 — Components

**New — `src/domain/commit/graft.ts`** (pure, zero I/O, domain tier):

```
graftedParents(id: ObjectId, parents: ReadonlyArray<ObjectId>, shallow: ReadonlySet<ObjectId>): ReadonlyArray<ObjectId>
applyGraftToData(id: ObjectId, data: CommitData, shallow: ReadonlySet<ObjectId>): CommitData
applyGraft(commit: Commit, shallow: ReadonlySet<ObjectId>): Commit
```

Each returns its input **referentially unchanged** when `shallow.size === 0` or `id` is not a
boundary — the zero-cost path required by requirement 8. Immutable otherwise: a masked commit
is a new object, never a mutation.

Three entry points, not one, because the oid arrives differently at each tier. `Commit`
carries `{ id, type, data }`, so `applyGraft` is self-sufficient — that is what `readCommit`
uses. But `history-rewrite.readCommitData` returns bare `CommitData`, which has **no `id`
field**; it must graft with the oid the caller asked for, hence `applyGraftToData(id, …)`.
`graftedParents` is the shared primitive the other two are built on.

**New — `src/application/primitives/internal/shallow-set.ts`**:

```
loadShallowSet(ctx: Context): Promise<ReadonlySet<ObjectId>>   // per-Context memo
isShallowRepository(ctx: Context): Promise<boolean>            // file PRESENCE (pin D2/C6)
invalidateShallowSet(ctx: Context): void
```

Memoised in a `WeakMap<Context, Promise<…>>`, exactly mirroring `loose-oid-cache.ts`'s
`fanoutCache` and `read-commit-graph.ts`'s `graphCache`. `updateShallow` calls
`invalidateShallowSet` so a `fetch --deepen` inside one `Context` is immediately visible.
Note the two distinct signals: the **set** drives masking; **presence** drives the
commit-graph gate (they differ only for a 0-byte file, pin D2).

Known caveat, inherited from the loose-object fanout cache: a *foreign* writer (a real `git`
subprocess) that rewrites `.git/shallow` mid-`Context` is not observed. Interop tests must
build a fresh `Context` **after** any git-side deepen/unshallow.

**Changed — `src/application/primitives/internal/read-commit.ts`**: `ReadCommitOptions` gains
`shallow: ReadonlySet<ObjectId>`, and `readCommit` applies `applyGraft` with it after
`readObject` returns. Hash verification already happened inside `readObject` against the raw
bytes, so grafting after the fact cannot weaken `verifyHash`.

The set is a **parameter, not an ambient lookup**, and that is load-bearing. Under
candidate 2(a) a caller may pass an explicit `shallow` override; the walk must then graft
with the *caller's* set, not the repository's, or an explicit `new Set()` would still be
masked by the repo file and the escape hatch would not exist. So each walk resolves its
effective set **once** at session construction —
`effective = options.shallow ?? await loadShallowSet(ctx)` in `createWalkSession`
(`walk-commits.ts:37`) and at the head of `commitDateWalk` — stores it in `WalkState.shallow`
/ the `DateWalk` closure exactly as today, and threads the same value into every
`readCommit` call. The non-walk grafted sites listed below have no override concept and call
`loadShallowSet(ctx)` directly.

Signature consequence: `createWalkSession` is synchronous today
(`function createWalkSession(ctx, options): WalkSession`) and becomes `async`, awaited at
`walk-commits.ts:100`. `walkCommits` is already an async generator, so no caller changes.
The seed-priming loop (`for (const seed of state.queue) bodies.start(seed)`) must stay
**after** the set resolves, since `bodies.start` now grafts.

**Changed — `src/application/primitives/internal/read-commit-graph.ts`**: the `loadGraph`
path short-circuits to `undefined` when `isShallowRepository(ctx)` — so `commitHeader`
returns `undefined` for every oid and both walks fall through to their existing
graph-absent body-read path. This is pin C5/C6 and requirement 5.

**Retained — the two existing enqueue guards.** With the graph off, `resolveFrontierEntry`
always takes the body-confirmed path, so masking flows through `enqueueParents`
(`walk-commits.ts:134`) reading an already-empty `commit.data.parents`; the
`state.shallow.has(commit.id)` guard at `:142` and the `shallow.has(commit.id)` guard at
`commit-date-walk.ts:114` become belt-and-braces there. They are **not** dead code: a caller
supplying an explicit override set in a repository with **no** `.git/shallow` file leaves the
commit-graph enabled, and `walk-commits.ts:76`'s `state.shallow.has(id) ? undefined : …` is
then the only thing stopping `commitHeader` from enqueueing a boundary's parents from the
graph. All three guards stay.

**Changed — `src/application/commands/internal/history-rewrite.ts`**: `readCommitData`
applies the graft, which propagates masking to `blame`, `cherry-pick`, `revert`, `rebase`
(pins A27/A35/A36) with no per-command edit.

**Changed, per-site** (each reads parents through `readObject` directly today, so each
needs to route through the grafted read): `show.ts`, `rev-parse.ts:getNthParent`,
`name-rev.ts:expandParents`, `merge-base.ts:makeReadCommit`, `bisect-midpoint.ts:readCommitEntry`,
`patch-id.ts:readCommitData`, `fsck/reachability.ts`.

**Unchanged — deliberately**: `read-object.ts`, `cat-file.ts` (pin A8/A9), `create-commit.ts`
(writes true parents), `write-object.ts`, the `domain/protocol` fetch-negotiation shallow
handling, `stash.ts` / `snapshot-factory.ts` (they destructure a *stash* commit's synthetic
parents, never a boundary).

### §4 — The walk primitives' public `shallow` option

`WalkCommitsOptions.shallow` / `WalkCommitsByDateOptions.shallow` are public
(`types.ts`, exported via `primitives/index.ts`, present in `reports/api.json`). With
auto-loading they become redundant. Shape is decision candidate **#2**; whichever is chosen,
`walkCommits`/`commitDateWalk` keep their existing `enqueueParents` guard as the mechanism —
the change is only *where the set comes from*.

Surface gate: even under 2(a) (no type change), the option's JSDoc must be rewritten to state
the auto-load contract, and typedoc feeds `reports/api.json` — so the regenerated
`reports/api.json` must be committed or the pre-push `check:doc-typedoc` gate fails.

Auto-loading changes behaviour at every existing call site. Reviewed, all are correct or
improved under masking:

| Caller | Effect |
|---|---|
| `log`, `whatchanged`, `shortlog`, `range-diff` | fixed (requirements 1–3) |
| `describe` (`commitDateWalk`) | fixed — pin A28/A29 |
| `cherry-pick:139,143`, `revert:328,332`, `rebase:173,180` | ranges terminate at the boundary instead of throwing |
| `push:304` (`ignoreMissing: true`) | enumeration stops at the boundary; the refusal is server-side (pin A34), so tsgit's client half matches |
| `enumerate-push-objects:62`, `enumerate-bundle-objects:144,159` | bundle creation succeeds (pin A33) instead of over-enumerating |
| `fetch:271` (have-computation) | correct: a shallow client must not claim `have` for objects it lacks |
| `reflog:181` (`ignoreMissing: true`) | unchanged in a non-shallow repo; bounded in a shallow one |

### §5 — Error semantics

No new error code is required for traversal: masking *removes* the `OBJECT_NOT_FOUND` throw
rather than replacing it. Three refusals stay/appear, all matching git:

- `revParse('HEAD~2')` on a depth-2 clone throws (`objectNotFound`), matching pin A13
  (`exit 128`). Today it wrongly *succeeds*.
- A range whose base lies beyond the boundary (pin A15) refuses at rev resolution, unchanged.
- A **seed** that is itself absent (`walkCommits({ from: [C3] })`) still throws
  `OBJECT_NOT_FOUND`, matching pin A19 (`fatal: Not a valid commit name`). Grafting only
  masks a *boundary's* parents; it never invents a commit.

`ignoreMissing: true` keeps its independent meaning — it tolerates objects missing for
reasons other than a shallow cut (`push:304`, `reflog:181`,
`enumerate-bundle-objects:144,159`). Masking narrows what those walks reach; it does not
change how they treat a genuinely missing object.

Shallow-file parse refusals are decision candidate **#4**.

### §6 — Performance

- Non-shallow repos (the overwhelming majority): one extra absence-tolerated
  `readUtf8` per `Context` (a single syscall serving both the presence and the
  content signal — cheaper than an `exists`+read pair on shallow repos),
  memoised. `applyGraft` short-circuits on an empty set. Requirement 8.
- Shallow repos: the commit-graph is disabled (requirement 5 / pin C5), which costs the
  graph's prefetch parallelism lever. The mitigation is intrinsic — a shallow repo has
  `depth` commits, and the CI shape that motivated this fix has depth 1–50. Candidate **#3**
  records the alternative for the record.
- `git` itself never writes a commit-graph in a shallow repo (pins C8–C11), so the
  graph+shallow combination only arises from a graph written *before* the repo became
  shallow, or by another tool.

### §7 — Threat model

`.git/shallow` content is remote-influenced: a hostile server chooses the `shallow` pkt-lines
a fetch persists (`fetch.ts:172` → `updateShallow`).

| Threat | Assessment | Mitigation |
|---|---|---|
| Unbounded shallow set (server sends millions of `shallow` lines) → unbounded `Set` + file, then an unbounded in-memory set on **every** subsequent walk | Real. Verified: `upload-pack.ts` caps advertised refs (`MAX_ADVERTISED_REFS = 500_000`) but there is **no** cap on `shallow`/`unshallow` line counts, and `fetch.ts:172` unions whatever arrives into `updateShallow`. The only existing bound is the 512 MiB `maxResponseBytes` body cap ⇒ ~10⁷ entries | Cap the parsed entry count and/or file size in the reader, refusing above it — sized in the spirit of `MAX_ADVERTISED_REFS` / `MAX_WALK_QUEUE_SIZE`. Fold into candidate **#4**'s parser work so one reader owns the whole grammar |
| History concealment — a planted `.git/shallow` makes tsgit report a truncated history, so an "is X an ancestor of Y" check answers `false` | **Matches git exactly** (pins C2/C3: masking applies even when the parents are present locally). Faithful, therefore not a divergence — but it is a property callers must know | Document on `readShallow` / the walk options: a shallow set is *trusted repository state*, and reachability answers are relative to it |
| Grafted commit written back ⇒ new oid | A masked `Commit` carries the raw `id` with masked `data`, so `writeObject(graftedCommit)` would mint a different oid | The core reason candidate **#1**'s shape matters; whichever variant is chosen must state the `id ≡ hash(data)` contract explicitly |
| Path traversal / worktree escape via the shallow path | None — the path is derived from `commonGitDir(ctx)`, never from file content, and passes the adapter's containment gate | Pinned by E1–E3 |
| Symlinked `.git/shallow` | Handled by the existing `NodeFileSystem` root-set realpath gate (ADR-541) | No change |

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Breadth of the graft surface** | **(a) Walk primitives only** — mask inside `walkCommits`/`commitDateWalk`; `log`/`describe`/`shortlog` fixed, everything reading `readObject` directly (`show`, `rev-parse`, `blame`, `merge-base`, `bisect`, `name-rev`) stays divergent. **(b) Grafted read tier** — `readCommit` + `readCommitGraph` + `history-rewrite.readCommitData` + the seven direct `readObject` parent sites; `readObject`/`catFile` stay raw. **(c) Graft inside `readObject`** — every consumer masked, including `catFile` | **(b)** | (a) leaves requirement 2 met but pins A13/A23/A24/A27/A35/A36 unfixed — `rev-parse HEAD~2` still returns a phantom oid and `blame` still throws. (c) breaks pin A8/A9 (`cat-file` must show the true parent) and the whole "grafts apply to traversal, not object content" invariant. (b) is git's own layering, and its cost is bounded — seven mechanical call-site redirects |
| 2 | **Fate of the public `shallow` walk option** | **(a) Auto-load, option becomes an override** — omitted ⇒ load from `.git/shallow`; explicit (incl. `new Set()`) ⇒ caller wins. **(b) Auto-load, remove the option** — union of repo state only; public-API removal. **(c) Auto-load, always union** with any caller-supplied set | **(a)** | (a) is source-compatible (`reports/api.json` diff is doc-only) and keeps an explicit no-masking escape hatch for tooling that deliberately wants raw ancestry (fsck-style audits). (b) is cleaner but a breaking public-surface removal for a bug fix, and deletes that escape hatch. (c) silently makes an explicit `new Set()` mean "auto-load", which is a surprising override semantics |
| 3 | **Commit-graph gate under shallow** | **(a) Disable the graph whenever the shallow file exists** (git's `commit_graph_compatible`, pins C5/C6/C11). **(b) Disable only when the parsed set is non-empty** — keeps the graph for a 0-byte file. **(c) Keep the graph and mask its parents on top** | **(a)** | Pin C6 is unambiguous: an *empty* shallow file already makes git abandon the graph, and C5/C6 show the observable consequence (a graph-only traversal that succeeds without shallow **fails** with it). (c) would make tsgit *succeed* where git exits 128 — a divergence in exactly the stale-graph case the brief asks about. (b) is a half-measure that diverges on the empty-file case for no real gain. Accepted cost: no graph acceleration in shallow repos (§6) |
| 4 | **`.git/shallow` parser strictness** | **(a) Strict, git-faithful** — refuse any line whose first 40 chars are not hex (pins D9–D12), accept trailing junk after 40 hex (D6), plus an entry/size cap; new structured refusal code (e.g. `SHALLOW_FILE_MALFORMED`). **(b) Keep tolerant-skip**, only correct the false doc comment. **(c) Strict on the walk path, tolerant on the fetch path** | **(a)** | The current comment claims git-parity that pins D9–D12 disprove, so *something* must change. Under ADR-226, silently skipping a line git dies on means tsgit reports a history git refuses to report at all — a data divergence, not a cosmetic one. (a) also gives the natural home for the §7 threat-model cap. (c) makes two readers of one file disagree — the worst outcome. Note (a) is a behaviour change on the existing `readShallow` public export |
| 5 | **Shallow-set caching** | **(a) Per-`Context` `WeakMap` memo + `invalidateShallowSet` from `updateShallow`** (mirrors `loose-oid-cache`/`graphCache`). **(b) No memo** — read the file at each walk/graft-read entry point. **(c) Memo + `mtime` revalidation** | **(a)** | (a) is the established house pattern and keeps requirement 8's "one probe per `Context`". (b) is untenable once candidate 1(b) puts grafting on the *per-commit* `readCommitData` path. (c) adds a `stat` per read to close a window (foreign process mutating `.git/shallow` mid-`Context`) that the object-store caches already leave open — inconsistent, and the interop-test discipline (fresh `Context` after git-side writes) already covers it |
| 6 | **Masked-`Commit` shape** | **(a) Mask in place** — `applyGraft` returns `{…commit, data:{…data, parents: []}}`; `id` keeps the true oid. **(b) Keep `Commit` raw everywhere**, expose an application-tier `graftedParentsOf(ctx, commit)` and call it at every traversal/report site. **(c) Distinct `GraftedCommit` type** carrying both `parents` and `rawParents` | **(a)** | (a) is git's own representation and makes every downstream consumer (`log.parents`, `blame`'s `parents.length === 0`, `show`'s parent-diff) correct with no edit — the reason breadth (b) in candidate 1 is affordable. Its cost is the `id ≡ hash(data)` desync flagged in §7, mitigated because no code path writes a walked commit back. (b) is invariant-safe but re-opens every one of ~20 sites and will silently rot as new ones land. (c) doubles the type surface and forces a public-API decision for a bug fix |

## Test strategy

**Interop (authoritative for faithfulness) — new `test/integration/shallow-walk-interop.test.ts`.**
Follows `shallow-file-interop.test.ts`'s shape: `mkdtemp` bare + source + shallow clone,
`runGit`/`runGitEnv` from `interop-helpers.ts` (scrubbed `GIT_*`, pinned author/committer
dates, signing off), one shared `beforeAll` repo set with a 60s timeout (heavy git-spawning
interop under `validate` concurrency otherwise trips hook timeouts). Per ADR-249 the test
reconstructs git's stdout from tsgit's structured fields and compares to real `git`.

Fixtures: `F1` linear 5-commit `--depth 2`; `F2` `--depth 1`; `F3` merge history `--depth 2`
(two boundaries); `F4` full clone + `commit-graph write` + hand-written shallow; `F5` full
clone + graph + a deleted loose object + shallow (pin C5); `F6` linked worktree of `F1`.
**Every `Context` is built after the last git subprocess write** (shallow/loose-object caches).

Row coverage: A3/A4/A5/A6/A10/A11 → `walkCommits` + `log`; A25/A26 → `log`'s parent band and
`order: 'first-parent'`; A22 → `log` with a pathspec; A14/A15/A16/A17 → ranges (`until` /
`excluding`) with the base at, and beyond, the boundary; A24/A23 → `show` + `whatchanged`
against the empty tree; A8/A9 → `catFile` raw-parent assertion (**the negative control** that
proves the graft is traversal-only); A12/A13 → `revParse` refusal; A18/A19/A20/A21 →
`mergeBase`; A27 → `blame` boundary flag and per-line attribution; A28/A29 → `describe`;
A30 → `nameRev`; A31 → `shortlog`; A32 → `fsck` reports clean (proves the reachability walk
is grafted, not reporting the cut-off parent as missing); A33 → `bundleCreate`; A34 →
`enumeratePushObjects` terminates at the boundary; A35/A36 → `revert`/`cherryPick` against
the empty tree; A37 → `bisectMidpoint`; A38/A39 → deepen/unshallow with a rebuilt `Context`;
B1–B7 → `F2`/`F3`; C1–C7 → `F4`/`F5`; E1–E3 → `F6`.

**Unit.** `domain/commit/graft.ts`: empty set ⇒ identity (same reference); boundary ⇒ empty
parents, `id`/`tree`/`author`/`committer`/`message` untouched; non-boundary ⇒ identity;
multi-parent boundary ⇒ all parents dropped, not just the first.
`shallow-set.ts`: absent file ⇒ empty set **and** `isShallowRepository === false`;
0-byte file ⇒ empty set **and** `isShallowRepository === true` (pin D2 — the two signals
diverge here, and this is the one case that proves candidate 3(a) over 3(b));
memoisation (one `fs` call across N loads); `invalidateShallowSet` forces a re-read.
`walk-commits.test.ts` / `walk-commits-by-date.test.ts`: extend the existing `shallow`-option
suites with the auto-load path (memory adapter, hand-written shallow file) and the explicit
`new Set()` override.
`read-commit-graph`: graph present + shallow present ⇒ `commitHeader` returns `undefined`
for a graph-covered oid.
Per the "guard clauses need isolated tests" rule, the `shallow.size === 0 || !shallow.has(id)`
short-circuit gets one test per disjunct.

**Property tests** (`shallow-file.properties.test.ts`, sibling per ADR-134): the parser is a
grammar over an algebraic input, so lens 1 and lens 3 both fit.
Round-trip (`numRuns: 200`): `readShallow(updateShallow(S)) ≡ S` over arbitrary oid sets,
modulo the documented sort. Totality (`numRuns: 100`): over the safe subset (LF-separated
40-hex lines, optional trailing junk after each oid), `readShallow` never throws and its
cardinality equals the distinct-oid count. Under candidate 4(a), a paired negative property:
any line whose first 40 chars are not hex refuses with the structured code. Arbitraries go in
the directory's shared `arbitraries.ts`. No seed committed.

**Parity** (cross-adapter, node/memory/browser): a shallow repo built in the memory adapter
walks identically across adapters — proves the common-dir path resolution and the graft are
adapter-independent. Explicitly *not* a faithfulness proof.

**Mutation.** Target 0 survivors on `graft.ts`, `shallow-set.ts` and the changed
`read-commit`/`read-commit-graph` lines. The identity short-circuit is the likely
equivalent-mutant source (removing it only costs an allocation); if so it gets a proof
comment anchored on the expression line, not a suppression of the whole guard.

## Out of scope

- **Writing `.git/shallow` from the walk side.** Only `clone`/`fetch` mutate it (ADRs 008–009);
  this change is read-only with respect to repository state.
- **`fetch --deepen` / `--unshallow` semantics.** Pinned (A38/A39) only to prove the reader
  reacts to a rewritten file; the negotiation itself is unchanged.
- **A `shallow` / `isShallow` field on the public `Repository` facade.** Requirement 7 keeps
  the boundary invisible to callers; git exposes `rev-parse --is-shallow-repository`, and if
  tsgit wants that it is a separate surface decision, not part of the fix.
- **Shallow-aware `push`.** Pin A34 shows the refusal is server-side (`shallow update not
  allowed`); tsgit's client-side enumeration is corrected here, but implementing
  `receive.shallowUpdate` negotiation is a distinct feature.
- **`info/grafts` and `git replace`.** git's other two graft mechanisms share
  `parse_commit`'s masking path; `applyGraft` is deliberately shaped to accommodate them
  later, but neither is implemented or pinned here.
- **Commit-graph writing.** tsgit has no writer; git's silent refusal under shallow
  (C8–C11) is recorded for the reader gate only.
