# Design — depth caps and Node release-line aliases

> Brief: make every tree-recursion depth cap refuse the input it cannot process (today the
> boundary value is admitted and overflows the JS call stack as a raw `RangeError`), and replace
> the hardcoded Node majors in CI with `actions/setup-node` release-line aliases.
> Status: draft → self-reviewed ×3

Two independent robustness scopes batched into one change. Neither touches the public API
surface. **Scope A** is `src/` + `test/`; **Scope B** is `.github/` only. They share no file and
can be reviewed independently; they are batched because each alone is too small for a PR.

---

## Context

### Scope A — where this sits

Nine call sites throw `treeDepthExceeded` behind six distinct depth caps. Every one of them
exists for the same stated reason: bound a recursive tree descent so a pathologically deep input
fails with a typed refusal instead of exhausting the JavaScript call stack.

The caps come in two enforcement strategies, and the distinction is load-bearing:

- **DURING-recursion** — `if (depth > CAP) throw` at the head of the recursive function. Frames
  are structurally bounded at `CAP + 1` **regardless of how deep the input is**. Eight sites.
- **INPUT-boundary** — `synthesizeTreeFromIndex` counts slashes before recursing and refuses at
  `slashCount > CAP`. Frames are bounded at `CAP`. One site.

Neither strategy is wrong. What is wrong is that four of the caps sit **above** the number of
frames the engine can actually hold, so the guard is unreachable and the failure is a raw
`RangeError` rather than `TREE_DEPTH_EXCEEDED`.

### Subsystems this touches

| Path | Role |
|---|---|
| `src/application/primitives/synthesize-tree-from-index.ts` | `MAX_TREE_DEPTH` (4096), `assertDepthBounded`, `synthesizeLevel`, `groupByPrefix`, `stage0Entries` — the reported defect |
| `src/application/commands/merge.ts` | `MAX_MERGE_TREE_DEPTH` (4096), `writeNestedTree`, `partitionByPrefix` |
| `src/application/primitives/walk-working-tree.ts` | `DEFAULT_MAX_DEPTH` (4096), `walkInternal` + `visitEntry` (async generators) |
| `src/application/primitives/walk-tree.ts` | `walkInternal` (async generator), cap from `MAX_TREE_WALK_DEPTH` |
| `src/domain/diff/flat-tree.ts` | `MAX_TREE_WALK_DEPTH` (1024) — the one already-shared constant |
| `src/application/commands/archive.ts` | `buildEntryStream` passes `maxDepth: Number.MAX_SAFE_INTEGER` — the cap deliberately disabled |
| `src/application/primitives/internal/flatten-raw.ts` | `DEFAULT_FLATTEN_BOUNDS`, `flattenLevel` |
| `src/application/primitives/internal/walk-raw-subtree.ts` | `walkLevel`, cap from `config.bounds.maxDepth` |
| `src/application/primitives/diff-trees.ts` | `diffChangedSubtree` / `diffRecursiveLevel`, cursor-based |
| `src/application/primitives/enumerate-bundle-objects.ts` | local `MAX_TREE_DEPTH` (1024), `collectTreeObjects`, `emitTreeObjects` |
| `src/application/primitives/internal/closure-not-marks.ts` | local `MAX_TREE_DEPTH` (1024), `markTree` |
| `src/application/primitives/walk-submodules.ts` | `walkInTree`, `MAX_SUBMODULE_DEPTH` — a `>=`-`continue`, investigated below |
| `src/application/primitives/validators.ts` | `exceedsMaxTreeDepth(depth, cap) => depth > cap` — the shared comparator |
| `src/domain/objects/error.ts` | `treeDepthExceeded(depth)` — carries `depth` only |
| `test/unit/application/primitives/synthesize-tree-from-index.test.ts` | the boundary test that documents the overflow as expected |
| `docs/use/errors.md` | the published `TREE_DEPTH_EXCEEDED` row |

### Scope B — where this sits

`.github/actions/setup/action.yml` hardcodes `node-version: "22"` as the composite action's
default. **27 of 28 composite call sites inherit it**; only `unit-tests` passes a version, from
a `node: [22, 24]` matrix. Two jobs bypass the composite entirely with a bare
`actions/setup-node@v7`. Nothing bumps any of these automatically — `dependabot.yml` groups the
`github-actions` ecosystem, so the **action major** is kept current while the **`node-version`
value** drifts until a human notices.

### Prior decisions that constrain this design

- **[ADR-226](../adr/226-git-faithfulness-prime-directive.md) / CLAUDE.md prime directive** — replicate canonical git's observable behaviour
  byte-for-byte unless an ADR diverges and says why. A refusal condition is observable
  behaviour, so a depth cap that refuses input git accepts is a divergence requiring an ADR.
- **[ADR-249](../adr/249-describe-structured-data-only.md)** — the binding is on data, on-disk state and refusal conditions, not rendered
  stdout. A `TREE_DEPTH_EXCEEDED` refusal is squarely inside the binding.
- **[ADR-024](../adr/024-bounded-reads-where-cap-fires.md)** — precedent for a cap enforced at several points chosen per pipeline shape, with
  the rationale written down rather than a single number asserted. This design follows it.
- **[ADR-085](../adr/085-nested-submodule-recursion.md)** — nested-submodule recursion via a child `Context`; `MAX_SUBMODULE_DEPTH` is its
  backstop, distinct from the tree-depth caps (see §A6).
- **[ADR-483](../adr/483-committed-hand-transcribed-benchmark-snapshot.md)** — published performance numbers come from a dated CI nightly artifact, never a
  local run. Any perf claim in §A4's structural option must be settled that way.
- **[ADR-103](../adr/103-ci-code-change-gating.md)** — CI code-change gating; `.github/` counts as code, so a workflow-only PR runs the
  full matrix and Scope B is self-validating in its own PR.

### The claim this design had to test

`synthesize-tree-from-index.ts`'s module doc asserts the cap is *4096, matching git's canonical
limit*, and its `synthesizeLevel` comment asserts that a DURING-recursion guard *would be dead
code — the JS call stack would overflow long before it could ever fire*. Both claims are
falsifiable. Both were tested and both are false in an instructive way:

- git's limit is **`core.maxTreeDepth`, default 2048** — and it binds **traversal**, not the
  synthesis surface this primitive implements, where git has no limit at all (§A7);
- the "dead code" observation is *true at cap 4096* and is precisely the bug — a guard that
  cannot fire is a guard that does not work (§A3).

A third claim, `archive.ts:96`'s *"git archive imposes no entry or depth cap"*, is half false:
git caps archive's depth exactly like every other traversal (§A7 row R9).

---

## Requirements

When this ships:

**Scope A**

1. `npm run test:unit` emits **zero** `Exception in PromiseRejectCallback` lines. Measured
   baseline at HEAD: exactly **2** (verified — see §A1). Silencing stderr without removing the
   overflow does not satisfy this.
2. For **every** cap in the inventory, an input **one past** the cap yields
   `TREE_DEPTH_EXCEEDED` carrying the correct `depth`, and an input **exactly at** the cap
   completes successfully — with no `RangeError` at either boundary, on linux, macOS and Windows.
3. No tree descent reachable from the public surface can produce a raw `RangeError` for a deep
   input. That includes `archive`, whose cap is currently disabled (§A5).
   **How strongly this holds depends on DC-1.** Under (b) it is a structural property, true on
   any engine. Under (a) or (c) it is an empirical claim about the engines that were measured —
   §A2.3 shows the ceiling halves with the stack budget, and no browser engine was measured — so
   the requirement reduces to "no `RangeError` on the CI matrix", and the ADR must say so rather
   than let the stronger reading stand.
4. Every cap is either one shared constant or carries a written rationale for why it differs.
5. No source comment or published doc claims a git-faithfulness property that §A7 disproves.
   Specifically: `synthesize-tree-from-index.ts:30-31` ("4096, matching git's canonical limit"),
   `archive.ts:96` ("git archive imposes no entry or **depth** cap"), and `merge.ts:409-414`
   (which claims to match `synthesizeTreeFromIndex`'s *contract*, and misnames
   `MAX_FLAT_TREE_ENTRIES` as a depth cap).
6. The mangled module-doc sentence at `synthesize-tree-from-index.ts:21` is repaired.
7. `docs/use/errors.md`'s `TREE_DEPTH_EXCEEDED` row matches the shipped error: the data payload
   is `depth` only (there is no `limit` field), and the description does not claim a single
   4096 cap.
8. Every pinned git behaviour from §A7 is asserted by a cross-tool interop test in
   `test/integration/`. At minimum: the traverse/synthesise split (git refuses `ls-tree -r` at
   2049 and accepts `write-tree` at any depth), and `archive`'s refusal at 2049.
9. Whatever the caps become, the relationship to `core.maxTreeDepth` (default 2048, 512 under
   MSVC) is a written, ADR-recorded decision rather than an accident — including the decision
   *not* to read the config, if that is the answer (DC-10).
10. No test asserts a raw `RangeError`, an exact frame count, or any quantity that varies with
    V8's stack budget.

**Scope B**

11. No hardcoded Node major remains in `.github/` as a `node-version` value or as a matrix
    element.
12. `unit-tests` runs three cells per OS from `node: ['lts/-1', 'lts/*', 'latest']`.
13. The coverage-artifact step still runs on exactly one cell per full matrix, and its artifact
    name contains no character `actions/upload-artifact` rejects. Both are currently coupled to
    the literal `22` and both break silently under aliases (§B3).
14. The `benchmark-compare` job keeps its deliberate composite bypass and its
    `cache-dependency-path`; only the version value changes.
15. The matrix comment explaining the Node-20 floor is rewritten, not deleted (§B5).
16. `main`'s ruleset still passes. Verified live: only `build` is required (§B6).

---

## Design

## Part A — depth caps

### §A1 The defect, reproduced

```
$ npx vitest run test/unit/application/primitives/synthesize-tree-from-index.test.ts

Exception in PromiseRejectCallback:
  …/src/application/primitives/synthesize-tree-from-index.ts:94
        return (0,__vite_ssr_import_3__.writeTree)(ctx, treeEntries);
RangeError: Maximum call stack size exceeded

Exception in PromiseRejectCallback:
  …/src/application/primitives/synthesize-tree-from-index.ts:87
        const subId = await synthesizeLevel(ctx, subEntries);
RangeError: Maximum call stack size exceeded

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

Exit code 0. `npm run test:unit` over the whole suite emits exactly **2** such lines, and this
file is their sole source.

The producer is the boundary test at `synthesize-tree-from-index.test.ts:348-386`
("Given an index path with exactly MAX_TREE_DEPTH slashes"). It builds a 4096-slash path,
which `assertDepthBounded` accepts (`slashCount > 4096` is false), then `synthesizeLevel`
descends 4096 frames and overflows.

**Not a missing `await`.** `Exception in PromiseRejectCallback` is V8 reporting that the
host's rejection-bookkeeping callback itself threw *while the stack was already exhausted*. It
is a symptom of the overflow, not an independent unhandled-rejection bug. A `return await` at
both return sites was applied in a prior session and changed the output by exactly nothing;
it was reverted. This design does not propose it.

### §A2 Measured stack ceilings — method and matrix

Every number below comes from running the **real** source, not a mock of its shape.

**Method.** `esbuild --bundle --platform=node --format=esm` over a scratch entry that imports
the production modules from the worktree by absolute path, driving each recursion at a chosen
depth against `createMemoryContext()`. One depth per process — a fresh `node` invocation per
data point — so no measurement warms another. Machine: darwin 25.5.0, arm64, Node **v22.22.3**,
default V8 stack. Probes live outside the worktree; nothing was written into it.

Read "ceiling" as *the deepest input that still completes*; "cap" as the constant in the source.

**Precision caveat.** Each probe builds its fixture slightly differently — a path with N slashes,
or a chain of N nested trees plus a leaf — so the mapping from "input depth" to "recursion depth"
varies by ±1 between rows. The load-bearing claims are unaffected: whether the guard is
*reachable at all*, and the order-of-magnitude gap between cap and ceiling. Do not read the
tables as pinning an exact off-by-one; the per-cap boundary tests in the test strategy are what
pin that, and they run against the shipped code rather than a probe.

#### §A2.1 Per-site ceiling vs cap — the verdict table

| # | Site | Recursion shape | Cap | Enforced | Frames the cap admits | **Measured ceiling** | Verdict |
|---|---|---|---|---|---|---|---|
| S1 | `synthesizeLevel` (`synthesize-tree-from-index.ts:119`) | `async`, one `await` per level | 4096 | INPUT | 4096 | **2200 OK / 2400 FAIL** (2250 OK / 2300 FAIL, n=5) | **UNSAFE** — cap 1.8× the ceiling |
| S2 | `writeNestedTree` (`merge.ts:405`) | `async` + `Promise.all` per level | 4096 | DURING | 4097 | **1350 OK / 1400 FAIL** (n=3) | **UNSAFE** — cap 3.0× the ceiling |
| S3 | `walkInternal`+`visitEntry` (`walk-working-tree.ts:65,87`) | async generator, **2 `yield*` frames per level** | 4096 | DURING | 4097 | **925 OK / 950 FAIL** (n=3) | **UNSAFE** — cap 4.4× the ceiling |
| S4 | `walkInternal` via `archive` (`archive.ts:99`) | async generator `yield*` | `Number.MAX_SAFE_INTEGER` | DURING (unreachable) | unbounded | **2100 OK / 2200 FAIL** (n=3) | **UNSAFE** — cap disabled |
| S5 | `walkInternal` via default (`walk-tree.ts:52`) | async generator `yield*` | 1024 | DURING | 1025 | 1024 OK, 1025 → `TREE_DEPTH_EXCEEDED:1025`; ceiling 2100 | **SAFE** — 2.0× margin |
| S6 | `flattenLevel` (`flatten-raw.ts:108`) | plain `async` | 1024 | DURING | 1025 | 1024 OK; 1025/4000/**20000** → `TREE_DEPTH_EXCEEDED:1025` | **SAFE** |
| S7 | `diffChangedSubtree` (`diff-trees.ts:576`) | plain `async`, cursor | 1024 | DURING | 1025 | 1025 OK; 2000/3000/5000/**8000** → `TREE_DEPTH_EXCEEDED:1025` | **SAFE** |
| S8 | `collectTreeObjects` / `emitTreeObjects` (`enumerate-bundle-objects.ts:86,118`) | plain `async` | 1024 | DURING | 1025 | not driven directly; shape strictly cheaper than S6/S7, same guard position | **SAFE** (inferred — see caveat) |
| S9 | `markTree` (`closure-not-marks.ts:54`) | plain `async` | 1024 | DURING | 1025 | not driven directly; same as S8 | **SAFE** (inferred — see caveat) |
| S10 | `walkLevel` (`walk-raw-subtree.ts:131`) | plain `async` | `bounds.maxDepth` = 1024 | DURING | 1025 | shares `flattenLevel`'s frame shape (S6) | **SAFE** (inferred) |
| S11 | `walkInTree` (`walk-submodules.ts:71`) | async generator, `>=` **`continue`** | 100 | DURING, non-throwing | 101 | 101 ≪ 925 | **SAFE — different contract** (§A6) |

**"SAFE" means "cannot overflow", not "needs no change".** Rows S5–S10 are safe against the
stack and *unfaithful* against git: every one of them caps a traversal at 1024 where git
traverses to 2048 (§A7). The two axes are independent, and a site can need work on the second
while passing on the first.

**Caveat on the three inferred rows.** S8/S9/S10 were not driven to their own ceilings; the
budget went to the four unsafe sites. Their guard sits in the identical position (head of the
recursive function, `depth > 1024`, before any descent), so they are structurally bounded at
1025 frames for *any* input, exactly like S6 and S7 which were driven to 20000 and 8000
respectively without overflow. The plan should still drive each to its cap once — cheap, and it
converts an inference into a measurement.

#### §A2.2 The two variables that move the ceiling — and the one that does not

**Stack size moves it, roughly linearly.** Same site (S1), same cold conditions, varying
`--stack-size`:

| `--stack-size` | deepest `synthesizeLevel` that completes |
|---|---|
| 492 KB (half default) | ~1194 |
| 984 KB (V8 default) | ~2250 |
| 1968 KB | the **cap fires first** — 4100/5000/8000 all raise `TREE_DEPTH_EXCEEDED` |
| 3936 KB | idem |
| 7900 KB | idem |

The ≥1968 KB rows are the design's target state expressed as an accident: give the engine twice
the default stack and the existing 4096 cap becomes reachable and correct. tsgit cannot require
that of its consumers.

**JIT tier moves it, by nearly 2×.** Same site, same process settings, only the warm-up differs:

| Warm-up before the deep call | ceiling |
|---|---|
| none (cold — first call is the deep one) | 2250 OK / 2300 FAIL |
| 200 shallow (depth-20) runs first | **4096 OK** / 4200 FAIL |

This is why the defect is *intermittent by construction*. A hot `synthesizeLevel` clears 4096; a
cold one does not. A sequential probe that walks 1 → 10 → 100 → 1000 → 4096 in one process
reports 4096 as fine — it warmed the function on the way down. Any benchmark, any repeated
call, any second invocation in the same process shifts the answer. **A cap tuned against a
measured ceiling is tuned against a number that changes under the caller's feet.**

**Caller depth appears *not* to move it.** Nesting the call under 200 / 500 / 1000 caller frames
(both `async` and plain-sync nesting) left the ceiling at 2200 in every cell. The mechanism: an
`await` on genuinely pending work returns the stack to the microtask baseline, so the deep
descent starts from a near-empty stack no matter how deep the caller was — and every path into
these primitives crosses such an `await` (reading the index, reading a tree object) before the
recursion begins.

**Stated with its limitation, because the probe is weaker than the claim.** The harness awaited
`writeObject` inside the measured function before invoking the recursion, so it re-set the
stack baseline itself and could not have detected an effect even if one existed. The measurement is
therefore *consistent with* the mechanism rather than a clean test of it. What it does establish
is the practically important half: **on every real path through tsgit, an intervening `await`
means caller depth does not accumulate.** The brief offered caller depth as a headroom
justification; on this evidence it is not one, and the headroom argument rests on stack size and
JIT tier alone. A caller that reached one of these primitives with no pending `await` in between
would be a genuine exception — none exists in the call graph of §A8.

#### §A2.3 What the numbers mean for headroom

A numeric cap must satisfy `cap + 1 < ceiling(shape, stack_size, jit_tier, engine)` for every
combination the library can be run in. tsgit's supported surface includes Node (linux, macOS,
Windows), workers, and **browsers** (`src/adapters/browser`, with e2e on chromium, firefox and
webkit). Only the Node/darwin/arm64/default-stack corner was measured. The half-stack row shows
the ceiling halves with the budget; no measurement exists for JavaScriptCore or SpiderMonkey,
and none is proposed, because the number would still be a point estimate of a moving target.

Cross-referencing §A7's pin makes the squeeze concrete. Git's number is **2048**:

| Site | measured ceiling | git's cap on the equivalent surface | headroom if tsgit adopts git's number |
|---|---|---|---|
| S5 `walkTree` | 2100 | 2048 | **1.03×** — 52 frames |
| S1 `synthesizeLevel` | 2250 | n/a (write surface, unlimited) | 1.10× if 2048 were adopted anyway |
| S2 `writeNestedTree` | 1350 | n/a (write surface) | **0.66× — impossible** |
| S3 `walkWorkingTree` | 925 | 2048 | **0.45× — impossible** |

**Recursively, tsgit cannot adopt git's own number** on two of the four unsafe sites, and clears
it by 2.5% on a third. That is the finding that reframes DC-1: the choice is not "which number is
safe" but "does tsgit get to use git's number at all".

Git itself concedes the point. `core.maxTreeDepth` defaults to **512 under MSVC** — git lowers
its own cap on the platform with the smaller stack, for exactly the reason tsgit faces. That is
precedent for a platform-conditional number; it is also an admission that a recursive
implementation cannot offer one cap everywhere.

The worst measured shape is S3 at **925**. Applying the observed half-stack factor gives ~460.
A cap defensible across the unmeasured surface with the same ~2× margin S5 currently enjoys lands
near **256** — one eighth of git's default, refusing trees `git log --raw` walks without
complaint.

### §A3 Why the obvious fixes do not work

Three fixes suggest themselves. Two are wrong; recording why, so they are not re-proposed.

| Proposed fix | Verdict |
|---|---|
| Change `slashCount > MAX_TREE_DEPTH` to `>=` | **Insufficient.** It removes one frame. The cap admits 4095 instead of 4096; the ceiling is ~2250. It also silently changes the meaning of every other cap if applied to `exceedsMaxTreeDepth`, whose `>` is pinned by S5's `TREE_DEPTH_EXCEEDED:1025`. |
| Move S1's guard from the INPUT boundary into `synthesizeLevel` (making it DURING, like the others) | **Insufficient, and the module comment inverts the reason.** The comment at `synthesize-tree-from-index.ts:114-118` says a DURING guard "would be dead code — the JS call stack would overflow long before it could ever fire". That is true *at cap 4096* and it is the bug, not a justification: a guard that can never fire is a guard that does not work. Moving it changes the admitted frame count from 4096 to 4097 — the wrong direction. **Enforcement position is not the defect; the cap value relative to the ceiling is.** |
| `return await` at `synthesizeLevel`'s return sites | **No effect.** Applied and reverted in a prior session; output unchanged. See §A1. |

What actually closes the gap is one of two things: make the cap smaller than the ceiling
(numeric), or make the descent not consume a stack frame per level (structural). DC-1.

### §A4 Structural bounding — costed honestly

Structural bounding replaces each recursive descent with an explicit stack (or a work queue), so
depth costs heap, not call frames. The cap then becomes a **policy** number — it means what it
says on every engine — instead of a number tuned against V8.

Per-site cost, using the §A2 shapes:

| Site | Rewrite | Invasiveness | Hot path? | Notes |
|---|---|---|---|---|
| S1 `synthesizeLevel` | Iterative post-order over the prefix trie: build the trie from the flat entries, then emit sub-trees bottom-up with an explicit stack. | **Low** — ~40 lines, one file, no signature change, no public type change | No — `checkout` / `stash` / `rebase` / `cherry-pick` / `revert` paths, once per operation | The natural shape: `groupByPrefix` already produces the trie level by level |
| S2 `writeNestedTree` | Same transformation. Must preserve the `Promise.all` fan-out across sibling subdirs, which becomes level-wise parallelism over the explicit stack. | **Low-moderate** — the parallelism is the only subtlety, and it carries a documented equivalent-mutant comment that must be re-proved against the new structure | Moderate — once per merge | Exported (`MAX_MERGE_TREE_DEPTH`), but not in `reports/api.json`, so no public-surface gate |
| S3 `walkWorkingTree.walkInternal`/`visitEntry` | Explicit DFS stack inside one flat `async function*`, yielding from the loop instead of `yield*`. | **Moderate** — two mutually-recursive generators collapse into one loop; `lazyStat` closures and the embedded-git-marker branch must survive verbatim | **Yes** — `status` | Also removes the per-yield bubbling cost (below) |
| S4/S5 `walkTree.walkInternal` | Same transformation. | **Moderate-high** — the most-referenced walker in the codebase | **Yes** — `log`, `status`, `archive`, `diff`, `walkSubmodules` | Same bubbling win |
| S6–S10 | none *structurally* | — | `diff`, `status` | Structurally bounded at 1025 frames already (§A2.1); rewriting them buys nothing and risks the hot raw-tree cursor path. Their **cap value** still moves under DC-2/DC-3 — they are stricter than git today (§A9) — but that is a constant change, not a rewrite |

**The perf argument cuts *toward* the rewrite for S3/S4, not against it.** `yield*` delegation in
async generators does not flatten: every value yielded at depth *d* is re-yielded through all *d*
enclosing generators, so a full walk of a tree of depth *d* costs O(entries × d) generator
resumptions, and each level also holds a live generator object. An explicit-stack rewrite makes
it O(entries). `walkTree` additionally does `stack.includes(tree.id)` per level, which is O(d)
per level, i.e. O(d²) per descent — an explicit stack can carry a `Set` instead. Both are real
wins on deep trees and neutral on shallow ones. **This is a hypothesis with a mechanism, not a
measurement**; under ADR-483 it must be settled by a `main`-vs-branch absolute wall-clock A/B and
the CI nightly, and the plan must budget for that. If the A/B comes back neutral-or-worse, the
rewrite still stands on the correctness argument alone.

**What structural bounding does not buy.** It does not remove the need to choose a cap — it
removes the need for the cap to be a function of the engine. Memory still bounds the descent, and
`MAX_FLAT_TREE_ENTRIES` still bounds breadth.

### §A5 `archive` — the deliberately disabled cap

`archive.ts:95-101`:

```ts
// git archive imposes no entry or depth cap — pass effectively-unbounded limits
// so walkTree's diff-oriented defaults never abort a large tree.
for await (const entry of walkTree(ctx, tree, {
  maxEntries: Number.MAX_SAFE_INTEGER,
  maxDepth: Number.MAX_SAFE_INTEGER,
})) {
```

**`walkTree` recurses.** `walkInternal` descends via `yield* walkInternal(...)`, one async
generator frame per level. Measured against a tree built to a chosen depth in the object store
(row S4): depth 2000 completes and emits 2001 entries; depth 2200 raises a bare `RangeError`.

So `archive` on a tree deeper than ~2100 is an **unguarded stack overflow reachable from a
public command**, and it is worse than the S1 defect in one respect: S1 at least refuses at
4097, whereas `archive` has no depth refusal at any input.

**The comment's depth premise is false, and §A7 row R9 is the proof.** `git archive --format=tar`
on a 2049-deep tree exits **128** with `error: exceeded maximum allowed tree depth` followed by
`fatal: failed to unpack tree object <oid>`. `archive` is a traversal, and git caps every
traversal at `core.maxTreeDepth`. There is no "git archive imposes no depth cap".

The comment's *entry*-count premise is sound and stays: `git archive` does not cap entry count,
and `MAX_FLAT_TREE_ENTRIES` is a breadth cap this design does not touch.

So `archive` is the one site where restoring a cap moves tsgit **toward** git rather than away
from it, and where git supplies the number. Whether the number can be 2048 depends on DC-1: at
2048 the cap sits 52 frames below `walkTree`'s measured 2100 ceiling — technically inside, but a
2.5% margin against a quantity that moves 2× with JIT tier is not a margin. DC-4.

### §A6 `walkSubmodules` — verdict: different contract, not this defect class

`walk-submodules.ts:71` reads `if (depth >= maxDepth) continue;` with
`MAX_SUBMODULE_DEPTH = 100` (`types.ts:286`). Three differences make it a genuinely different
contract, not an off-by-one sibling:

1. **It does not throw.** It `continue`s — the gitlink entry at the boundary is still *yielded*,
   only not *descended into*. There is no refusal, so there is no refusal condition to get
   wrong, and `treeDepthExceeded` is never constructed here.
2. **`>=` is correct for a pruning guard.** With `>=`, the deepest descended level is
   `maxDepth - 1` and the deepest *yielded* level is `maxDepth`. With `>` it would descend one
   further. Either is defensible for a backstop; `>=` is what the ADR-085 cycle-guard design
   pairs with, and its own doc comment calls it a "recursion backstop" whose primary guard is
   the visited-gitdir set.
3. **101 frames is three orders of magnitude below every measured ceiling** (worst: 925). It
   cannot overflow.

**Verdict: leave it alone.** Folding it into a shared tree-depth constant would be a category
error — it counts nested *repositories*, not tree levels, and its value is a policy choice about
submodule nesting that has nothing to do with stack budgets. It is the one cap in the inventory
whose number is not a guess about V8.

### §A7 Git faithfulness — the pinned matrix

> **This section is the pin.** Under ADR-226 a refusal condition is observable behaviour, so if
> canonical git accepts a path depth that tsgit refuses, the cap is a divergence that needs an
> ADR arguing why. The module doc's claim that 4096 "matches git's canonical limit" is the
> claim under test. It does not survive.

**Binary:** `git version 2.55.0`, `/opt/homebrew/bin/git`, darwin 25.5.0 arm64.
**Method:** every probe in a `mktemp -d` throwaway with isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`,
every `GIT_*` scrubbed, signing off. Never inside a worktree. Deep paths are fed to git as
**data** (`update-index --add --cacheinfo`) rather than as filesystem paths, so the OS `PATH_MAX`
does not mask git's own behaviour. `D` = **slash count**; the path is `a/`×D + `f`.
**Environment:** POSIX `PATH_MAX` = **1024** (darwin), `NAME_MAX` = 255, stack limit
(`ulimit -s`) = 8176 KB.

#### Pin 1 — git's limit is `core.maxTreeDepth`, and its default is **2048**, not 4096

`git help config`, verbatim:

> **core.maxTreeDepth** — The maximum depth Git is willing to recurse while traversing a tree
> (e.g., "a/b/cde/f" has a depth of 4). This is a fail-safe to allow Git to abort cleanly, and
> should not generally need to be adjusted. **When Git is compiled with MSVC, the default is 512.
> Otherwise, the default is 2048.**

`4096` appears **nowhere** in `git-config(1)`. No git default equals it. `pack.depth`'s documented
maximum of 4095 is delta-chain depth inside a packfile — unrelated to path depth.

**Where 4096 most likely came from:** `src/domain/working-tree-path.ts:5` defines
`MAX_PATH_BYTES = 4096`, a **byte-length** cap. The number appears to have leaked from a
byte-length cap into a component-count cap. It is not git's, and on this machine `PATH_MAX` is
1024, not 4096.

#### Pin 2 — the enforced predicate is `slashCount > core.maxTreeDepth`

Calibration of `ls-tree -r`'s exit code against explicit `core.maxTreeDepth = M` and depth `D`
(0 = accepted, 1 = refused):

| M \ D | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 1 | 1 | 1 | 1 | 1 |
| 2 | 0 | 0 | 0 | 1 | 1 | 1 | 1 |
| 3 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| 4 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| 5 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |

Refuse **iff `slashCount > cap`**. Independently re-verified at the default boundary:
D=2047 and D=2048 accepted, D=2049 refused.

**This is byte-for-byte tsgit's `assertDepthBounded` predicate** (`slashCount > MAX_TREE_DEPTH`).
The comparison is right; the constant and the surface are wrong.

*(Note: git's doc example counts components — `"a/b/cde/f"` "has a depth of 4" — while the
enforced quantity is slashes. At the default, 2048 slashes pass and 2049 refuse, so the predicate
is over slashes. The doc example is loose; the measurement is authoritative.)*

#### Pin 3 — the limit binds **traversal**, not **synthesis**

| # | Command | D | Exit | stderr (exact) | On-disk result |
|---|---|---|---|---|---|
| W1 | `update-index --add --cacheinfo 100644,<oid>,<path>` | 50 … 100000 | 0 | *(empty)* | index entry written at every depth |
| W2 | `write-tree` | 2048, 4096, **4097**, 8000, 20000, 28000 | 0 | *(empty)* | valid tree oid at every depth — **no refusal at or past 4096** |
| W3 | `write-tree`, default stack limit (8176 KB) | 29000 … 100000 | **139** (segmentation fault) | *(empty)* | no tree; stale 0-byte `.git/index.lock` |
| W4 | `write-tree`, `ulimit -s 65520` | 30000, **100000** | 0 | *(empty)* | valid tree oid |
| W5 | `mktree` | n/a | 0 | *(empty)* | single-level, no depth surface |
| R1 | `ls-files` | 4097 | 0 | *(empty)* | one line, 4097 slashes |
| R2 | `cat-file -p <tree>` | 4097 | 0 | *(empty)* | root entry printed |
| R3 | `ls-tree` (non-`-r`) | 2049 | 0 | *(empty)* | one entry |
| R4 | `ls-tree -r` | 2045–**2048** | 0 | *(empty)* | blob line emitted |
| R5 | `ls-tree -r` | **2049** | **1** | `error: exceeded maximum allowed tree depth` | no output |
| R6 | `diff-tree -r <empty> <tree>` | 2049 | **128** | `fatal: exceeded maximum allowed tree depth` | — |
| R7 | `log --raw` | 2049 | **128** | `fatal: exceeded maximum allowed tree depth` | — |
| R8 | `rev-list --objects` | 2049 | **128** | `fatal: exceeded maximum allowed tree depth` | partial stdout then abort |
| R9 | **`archive --format=tar`** | 2049 | **128** | `error: exceeded maximum allowed tree depth` + `fatal: failed to unpack tree object <oid>` | no tar |
| R10 | `read-tree <tree>` | 2049 | **128** | `error: exceeded maximum allowed tree depth` | index unchanged |
| R11 | `gc` | 2049 | **128** | `fatal: exceeded maximum allowed tree depth` + `fatal: failed to run repack` | repo cannot be gc'd |
| R12 | `repack -ad` | 2049 | **128** | `fatal: exceeded maximum allowed tree depth` | repo cannot be packed |
| R13 | `fsck` / `--strict` / `--connectivity-only` | 2049 **and** 4097 | **0** | *(empty)* | **fsck does NOT check depth** |
| C1 | `-c core.maxTreeDepth=4096 ls-tree -r` | 4097 | 1 | `error: exceeded maximum allowed tree depth` | refused |
| C2 | `-c core.maxTreeDepth=4097 ls-tree -r` | 4097 | 0 | *(empty)* | 8249 bytes emitted |
| C3 | `-c core.maxTreeDepth=100000 ls-tree -r` | 4097 | 0 | *(empty)* | emitted |
| C4 | `-c core.maxTreeDepth=<non-numeric>` | — | 128 | `fatal: bad numeric config value … invalid unit` | — |

Rows W3 vs W4 are decisive about the write side: the only write-side failure is **C-stack
exhaustion, and it moves with the process stack limit**. It is not a git constant, not a refusal, and
not something git reports — it is a segfault. Git has **no depth policy on the write path at all**.

#### Pin 4 — on a real worktree, the OS bites first, and git does not error

| # | Command | D | Exit | stderr (exact) | On-disk result |
|---|---|---|---|---|---|
| F1 | relative `mkdir` + descend loop, APFS | to 6000 | — | *(none)* | **APFS imposes no depth limit**; working-directory path 12079 bytes |
| F2 | `git clone` of a D=**2048** repo (inside git's limit) | 2048 | 128 | `fatal: cannot create directory at '…': File name too long` + `warning: Clone succeeded, but checkout failed.` | objects cloned; worktree stops at **real depth 471**, abs path ≈1015 B ≈ `PATH_MAX` |
| F3 | `checkout-index -a` | 2048 | — | `fatal: cannot create directory at '…': File name too long` | same wall |
| F4 | `git clone` of a D=**2049** repo | 2049 | 128 | `error: exceeded maximum allowed tree depth` + `fatal: unable to checkout working tree` | objects cloned, checkout refused **by git** |
| F5 | `git status --porcelain` on a real 3000-deep worktree | 3000 | **0** | `warning: unable to access '…/.gitignore': File name too long` ×N | **0 lines — silently sees nothing** |
| F6 | `git add -A` on the same | 3000 | **0** | same warnings | `ls-files` count **0** — never staged, no error |
| F7 | `git commit -m deep` on the same | 3000 | 1 | same warnings | nothing to commit |

`PATH_MAX = 1024` on darwin caps a checkout at real depth ~471 — **four times below git's own
2048** and nine times below tsgit's 4096. Git's depth limit is only reachable through synthetic
index/tree paths that never touch the filesystem.

Rows F5–F7 are a fidelity trap that lands squarely on `walkWorkingTree` (S3): on a genuinely deep
worktree git **warns and silently skips**; it does not fail. Whatever cap S3 ends up with, its
refusal semantics are already unfaithful in a way this design does not fix and should not
pretend to.

#### Verdict

1. **Git does impose a path-depth limit** — `core.maxTreeDepth`, default **2048** (**512** under
   MSVC), predicate `slashCount > cap`, enforced on **traversal**: `ls-tree -r`, `diff-tree -r`,
   `log --raw`, `rev-list --objects`, `archive`, `read-tree`, `gc`, `repack`, clone-checkout. Not
   enforced on `update-index`, `write-tree`, `ls-files`, non-`-r` `ls-tree`, `cat-file -p`, or
   `fsck` (even `--strict`).
2. **4096 is not git's number.** Git's is 2048. The module doc's faithfulness claim is false.
3. **The OS refuses first** in any real-filesystem scenario (~471 on darwin), and does so with a
   `File name too long` failure, not a depth error.
4. **Every one of tsgit's caps diverges from git**, in both directions:

| tsgit site | tsgit cap | git's cap on the equivalent surface | Divergence |
|---|---|---|---|
| `synthesizeTreeFromIndex` (S1) | 4096 | **none** — `write-tree` is unlimited (W2/W4) | tsgit refuses where git accepts. **Unavoidable** — "unlimited" is a segfault in git too (W3); tsgit's version is a typed refusal, which is strictly better |
| `writeNestedTree` (S2) | 4096 | **none** — same write surface | same |
| `walkTree` (S5) / `archive` (S4) | 1024 / disabled | **2048** | S5 refuses trees git traverses; S4 accepts trees git refuses (R9) |
| `walkWorkingTree` (S3) | 4096 | 2048 nominally, `File name too long` in practice (F5–F7) | both directions |
| `flattenRawTree`, `diffTrees`, `walkLevel`, bundle enumeration, `markTree` (S6–S10) | 1024 | **2048** | **stricter than git** — refuses trees `git diff`/`git rev-list` traverse happily |

5. **`core.maxTreeDepth` is user-configurable and tsgit reads it nowhere** (verified: no
   occurrence of `maxTreeDepth` in `src/`). A faithful tsgit would honour it — which means
   honouring *arbitrary* user values, including the 100000 that row C3 shows git accepting. That
   is impossible for a stack-recursive implementation at any cap, and it is the sharpest argument
   in this design for DC-1(b). DC-10 puts the config question itself to the user.
6. **`archive.ts:96`'s comment is false about depth.** Row R9: `git archive` on a 2049-deep tree
   exits 128 with `error: exceeded maximum allowed tree depth`. Git caps archive exactly like
   every other traversal. The comment's *entry*-count claim remains true and stays.
7. **`fsck` checking nothing here (R13)** means `src/domain/fsck/validate-tree.ts` needs no depth
   check — a negative worth recording so it is not added "for symmetry".

### §A8 Blast radius

`synthesizeTreeFromIndex` is exported from `src/application/primitives/index.ts:81` — it is a
**public primitive**, so any consumer can reach the defect directly. Internal callers, verified
by reference search:

| Caller | Site(s) |
|---|---|
| `checkout` | `checkout.ts:233` |
| `cherry-pick` | `cherry-pick.ts:396`, `:514` |
| `revert` | `revert.ts:383`, `:477` |
| `rebase` | `rebase.ts:534`, `:1150` |
| `stash` | `stash.ts:202`, `:261`, `:266`, `:440` |
| `apply-merge-to-worktree` | `apply-merge-to-worktree.ts:100` |

Twelve internal call sites across six commands. Today an index carrying a path between ~2250 and
4096 slashes turns any of them into a raw `RangeError` — an error with no `code`, outside the
`TsgitError` contract every one of those commands documents, and one that no caller can
meaningfully catch or classify. Below ~2250 the operation succeeds; the failure band is
*between* the ceiling and the cap, which is why it has gone unnoticed.

`archive` (§A5) adds a thirteenth reachable path through a different cap.

### §A9 Cap reconciliation

Six distinct caps today: 4096 (×3, in three files, one of them `export`ed), 1024 (×4, of which
one is shared via `MAX_TREE_WALK_DEPTH` and three are inlined local `MAX_TREE_DEPTH` constants),
`Number.MAX_SAFE_INTEGER` (×1), 100 (×1, different contract).

The three inlined 1024s in `enumerate-bundle-objects.ts:38`, `closure-not-marks.ts:28` and the
`flatten-raw`/`walk-raw-subtree` bounds all mean "the same bound as `walk-tree.ts`" — one of them
says so in a comment (`enumerate-bundle-objects.ts:36-37`: *"Same bound as walk-tree.ts's default
maxDepth"*). They should import `MAX_TREE_WALK_DEPTH` rather than restate it, whichever way DC-1
and DC-2 land; that part is not contentious.

§A7 adds a constraint the inventory alone did not show: **the 1024 caps are stricter than git**.
Every one of them guards a traversal — bundle enumeration, `not`-side marking, raw flattening,
the recursive diff — and git traverses to 2048. So today tsgit refuses trees `git diff`,
`git rev-list --objects` and `git bundle create` handle without complaint. That is a divergence
in the strict direction, which ADR-226 binds just as tightly as a permissive one, and it means
"leave the 1024s alone" is not the free option it looked like.

Whether the caps converge on git's 2048, on a lower shared value, or stay per-module is DC-2/DC-3.
Two constraints on the answer either way:

- **`merge.ts`'s comment must change.** It currently reads *"Depth cap matches
  `synthesizeTreeFromIndex`'s contract"*. It matches the **number**; it does not match the
  **contract**, because `synthesizeTreeFromIndex` refuses at the input boundary before recursing
  and `writeNestedTree` refuses during the descent. The two admit 4096 and 4097 frames
  respectively and have ceilings of 2250 and 1350. The same sentence also claims *"walkTree (via
  flattenTree) caps at MAX_FLAT_TREE_ENTRIES depth"* — `MAX_FLAT_TREE_ENTRIES` is a **breadth**
  cap (1 000 000 entries); the depth cap is `MAX_TREE_WALK_DEPTH`. Two errors in one comment.
- **A new exported shared constant gates on `reports/api.json`.** `MAX_SUBMODULE_DEPTH` and
  `MAX_FLAT_TREE_ENTRIES` are in the report; `MAX_TREE_WALK_DEPTH` and `MAX_MERGE_TREE_DEPTH`
  are not. Promoting a constant into the public barrel therefore requires a regenerated
  `api.json` in the same commit or the pre-push gate fails.

### §A10 Documentation and comment repairs

Not a separate scope — debris the change must not step over.

| Location | Current | Repair |
|---|---|---|
| `synthesize-tree-from-index.ts:21` | `* - **Path validation**:.7 hoisted segment-level validation into` | A stripped provenance ref left the sentence headless. Rewrite as prose with no phase reference, e.g. *"**Path validation**: segment-level validation is hoisted into `parseIndex` …"* |
| `synthesize-tree-from-index.ts:30-36` | "`MAX_TREE_DEPTH` (4096, matching git's canonical limit)" | **False** (§A7 Pin 1): git's limit is `core.maxTreeDepth`, default 2048, and it does not bind this surface at all (W2/W4). Restate as the deliberate divergence DC-5's ADR records, with 4096's real provenance (`MAX_PATH_BYTES`, a byte-length cap) noted or the number simply gone. |
| `synthesize-tree-from-index.ts:114-118` | "A secondary `depth > MAX_TREE_DEPTH` guard would be dead code" | The observation is true and is the bug (§A3). Rewrite to state the invariant the shipped design actually establishes. |
| `merge.ts:409-414` | two factual errors (§A9) — matches the *number* not the *contract*; names `MAX_FLAT_TREE_ENTRIES` (a breadth cap) as a depth cap | Rewrite. |
| `archive.ts:96-97` | "git archive imposes no entry or depth cap — pass effectively-unbounded limits" | The **entry** claim is true and stays. The **depth** claim is false: §A7 row R9 has `git archive` exiting 128 with `error: exceeded maximum allowed tree depth` at D=2049. Split them. |
| `docs/use/errors.md:111` | `` `TREE_DEPTH_EXCEEDED` \| `depth, limit` \| Tree recursion exceeded `MAX_TREE_DEPTH` (4096). `` | `treeDepthExceeded(depth)` constructs `{ code, depth }` — **there is no `limit` field**, so the documented payload is wrong. And there is no single 4096 cap. Rewrite both columns. |
| `src/domain/fsck/validate-tree.ts` | no depth check | **Leave it.** §A7 row R13: `git fsck --strict` does not check tree depth. Recorded here so the absence is not read as an omission. |

---

## Part B — Node release-line aliases

Target matrix: `node: ['lts/-1', 'lts/*', 'latest']`.

**Two consequences the brief does not name, both of which the ADR should record.**

*CI cost.* `unit-tests` goes from 3 OS × 2 majors = **6 cells** to 3 × 3 = **9**, a 50% increase
in the repo's most-run job. `fail-fast: false` means all nine always run. That is the price of
the `latest` signal, and it is the strongest practical argument for DC-7(c).

*Benchmark continuity.* `bench.yml` and `ci.yml`'s `benchmark-snapshot` both reach Node through
the composite action, so they inherit whatever DC-6 picks. Today that changes nothing (`lts/-1`
→ 22, the current pin). But at the **next LTS promotion the nightly's Node major moves on its
own**, and every number in the `gh-pages` benchmark series shifts underneath a continuous graph
— with an empty diff and no PR to attribute it to. Under ADR-483 those numbers are the citable
ones. Whichever way DC-6 lands, the rollover needs to be a *recognisable* event: at minimum the
resolved version belongs in the snapshot metadata, so a step change in the series can be read as
a runtime change rather than a regression. `benchmark-compare` is unaffected — it builds both
trees on one runner with one Node.

### §B1 Pin sites — complete inventory

Verified by sweeping the whole `.github/` tree, not only the four sites the brief named.

| # | Site | Current | Change |
|---|---|---|---|
| P1 | `.github/actions/setup/action.yml:4-8` | `inputs.node-version.default: "22"` | **the one that matters** — 27 of 28 composite call sites inherit it. DC-6 picks the alias. |
| P2 | `.github/workflows/ci.yml:242-244` | `node: [22, 24]` | → three alias cells |
| P3 | `.github/workflows/ci.yml:560-566` | bare `actions/setup-node@v7`, `node-version: "22"` | alias the value; **keep** the bypass and `cache-dependency-path` |
| P4 | `.github/workflows/npm-service.yml:36-40` | bare `actions/setup-node@v7`, `node-version: 24` | DC-9 — this pin has a documented npm ≥ 11 floor |
| P5 | `.github/workflows/ci.yml:257` | `if: … && matrix.node == 22` | **not a version pin — a comparison literal.** Breaks silently (§B3) |
| P6 | `.github/workflows/ci.yml:259` | `name: coverage-report-${{ matrix.os }}-node${{ matrix.node }}` | artifact name becomes invalid (§B3) |
| P7 | `.nvmrc` (repo root, contains `22`) | not referenced by any workflow | out of scope; noted so it is not mistaken for a live pin |

Negative results, verified: no `node-version-file:` anywhere; no `NODE_VERSION` env var; no
`container:` image with a node tag; no `volta` or `packageManager` field. The remaining `20`/`22`/
`24` occurrences in `.github/` are prose in comments.

**Composite fan-in.** 28 call sites across `ci.yml` (22), `bench.yml`, `gh-pages.yml`,
`pkg-pr-new.yml`, `pre-publish.yml`, `weekly-reports.yml` (×2). Exactly one (`unit-tests`) passes
`node-version`; the other 27 inherit. `release.yml` and `cancel-on-merge.yml` use no Node at all
(a release-please action and a `github-script` step respectively). So changing P1 moves every job
in the repo except the two bare-setup ones and those two Node-free workflows.

### §B2 Alias semantics — pinned against `actions/setup-node@v7`

Read off the action's own source at tag `v7.0.0`
(`src/distributions/official_builds/official_builds.ts`, `resolveLtsAliasFromManifest`) rather
than from memory:

- Supported forms: `lts/<codename>`, `lts/*`, `lts/-n`, and `latest` / `current` / `node`.
- **An alias resolves to a bare MAJOR string** (`release.version.split('.')[0]`), which is then
  resolved as an ordinary semver spec. `lts/*` becomes `"24"`; `lts/-1` becomes `"22"`. Aliases
  are therefore *exactly* as precise as today's pins — nothing widens or narrows.
- The oracle is `actions/node-versions`' `versions-manifest.json` filtered to
  `lts && stable === true`, not nodejs.org.
- An unresolvable alias **throws**; it does not fall back.

Resolved today (2026-08-15), from the live manifest — Hydrogen 18.20.8, Iron 20.20.2, Jod
22.23.2, Krypton 24.19.0:

| Alias | Resolves to | Note |
|---|---|---|
| `lts/-1` | **22** (Jod) | today's floor cell |
| `lts/*` | **24** (Krypton) | today's ceiling cell |
| `lts/-2` | 20 (Iron) | below the engines floor — `npm ci` would fail (§B4) |
| `latest` / `current` / `node` | **26.7.0**, `lts: false` | the Current line |

So `node: ['lts/-1', 'lts/*']` is **byte-equivalent to today's `[22, 24]`** and rolls forward on
its own at the next LTS promotion. The third cell, `latest`, is new signal.

**Two caveats worth carrying into the ADR.** First, `latest` resolves from the **dist** endpoint,
not the pre-cached `actions/node-versions` manifest, so it frequently misses the runner tool cache
and downloads from nodejs.org — the action's own README warns of rate-limit exposure. That is a
flakiness source `lts/*` and `lts/-1` largely avoid. Second, `*` and `latest` are **not**
synonyms: `*` is tool-cache-biased, `latest`/`current`/`node` are dist-authoritative.

### §B3 The two breakages the alias switch causes inside `unit-tests`

Both are in the same job and both are **silent**. Neither is mentioned in the brief; both must be
fixed in the same commit that changes the matrix, or the change is a regression.

**P5 — `if: always() && matrix.os == 'ubuntu-latest' && matrix.node == 22`.** With alias values
the literal `22` never matches, so the condition is permanently false and the coverage artifact
is **never uploaded**. Nothing fails; the artifact simply stops existing, and the 100%-coverage
breach that this artifact exists to diagnose becomes undiagnosable from CI.

**P6 — `name: coverage-report-${{ matrix.os }}-node${{ matrix.node }}`.** Under aliases this
renders a name whose alias segment contains `/` (for `lts/-1`) or `*` (for `lts/*`).
`actions/upload-artifact` rejects `/` and `*` (its `invalidArtifactNameCharacters` set is
`" : < > | * ? \r \n \ /`), so the step would hard-error — except P5 guarantees it never runs, so
P6 is masked. A future fix to P5 alone would surface P6 as a fresh failure.

Both need the same thing: a matrix value that is a **stable identifier**, decoupled from the
resolved version. DC-8 offers the shapes. Note that `actions/setup-node` **outputs** the resolved
concrete version, but the composite action declares no `outputs:`, so that value is not available
to callers today — an output would have to be added for any approach that wants the real version
in a name or a log line.

### §B4 The `engines` interaction — and why it is a feature here

`package.json` declares `"engines": { "node": ">=22.22.1" }`, floor only, no ceiling. The repo's
root `.npmrc` sets **`engine-strict=true`**. That combination was verified locally against a
throwaway package: without `engine-strict` npm emits an `Unsupported engine` **warning** and installs anyway; with
it, `npm ci` **fails hard** on the same mismatch.

The composite action's second step is `npm ci`. So the engines floor is a **live mechanical
gate** on every one of the 27 inheriting jobs, not documentation.

Walking the next two LTS transitions concretely:

| When | `lts/-1` | `lts/*` | `latest` | Effect |
|---|---|---|---|---|
| today | 22 (≥22.22.1 ✓) | 24 ✓ | 26 ✓ | matrix ≡ today's `[22, 24]`, plus a Current cell |
| Oct 2026 — 26 becomes LTS | **24** | **26** | 28 (Current) | floor cell rises to 24; `>=22.22.1` still satisfied. Nothing to do. |
| Oct 2028 — 28 becomes LTS | **26** | **28** | 30 | floor cell rises to 26 |

The floor never *falls*, so `engine-strict` can only ever fire if someone writes `lts/-2` (which
resolves to 20 today and would fail `npm ci` loudly on 27 jobs). That is the correct failure
mode: loud and immediate, not a silent test run on an unsupported runtime.

**Should `engines` move with the lines?** No — and this is the point worth stating in the ADR.
`engines.node` is a *consumer* contract (what a user of the published package must run), not a
*CI* contract (what the project tests on). They are deliberately decoupled: aliasing CI lets the
test matrix track upstream while the published floor stays where a deliberate decision put it.
Raising `engines.node` is a semver-relevant act and must stay a separate, deliberate change. The
one thing the aliases do change is that the floor cell will eventually stop testing the declared
minimum — once `lts/-1` reaches 24, nothing in CI runs on 22 any more while the package still
claims to support it. That is a real gap, and it is the strongest argument for DC-6 option (b).

### §B5 The matrix comment — rewritten, not deleted

Current (`ci.yml:236-238`):

```yaml
        # Node 20 dropped: cspell@10 + lint-staged@17 require >=22.18 /
        # >=22.22.1; the engines floor matches.
```

Under aliases this documents a floor that is no longer visible in the matrix. Draft replacement:

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

It keeps the historical fact (why 20 went), relocates the authority (`engines` + `.npmrc`, not
the matrix), and names the mechanism that enforces it.

### §B6 Branch protection — re-verified live

Queried 2026-08-15. The legacy API (`repos/scolladon/tsgit/branches/main/protection`) returns
**404 — "Branch not protected"**; all enforcement is ruleset `16502004` (name `main`, target
`~DEFAULT_BRANCH`, enforcement `active`).

Its `required_status_checks` parameters:

```json
{ "strict_required_status_checks_policy": true,
  "required_status_checks": [ { "context": "build", "integration_id": 15368 } ] }
```

**Exactly one required check, by the name `build`.** No matrix cell name appears anywhere in the
ruleset. `build` (`ci.yml:209`) has no matrix, so its check name is the stable literal `build`
and is unaffected. **Renaming `unit-tests (ubuntu-latest, 22)` to `unit-tests (ubuntu-latest,
lts/-1)` cannot break branch protection.** The brief's expectation is confirmed rather than
assumed.

One consequence worth recording, because it changes the risk calculus in §B3: since only `build`
is required, the entire unit-test matrix is **advisory at the ruleset level**. A silently
disabled coverage upload (P5) would not block a merge. That raises the cost of getting DC-8
wrong from "CI turns red" to "coverage evidence quietly stops being produced".

Cell names render as `<job-id> (<v1>, <v2>)` in **matrix-key declaration order** — `os` then
`node` — confirmed against merged PR #274's actual check names.

### §B7 Cache-key rotation — expected, and smaller than the brief assumed

Read off `actions/setup-node@v7`'s `src/cache-restore.ts`:

```ts
const keyPrefix = `node-cache-${platform}-${arch}-${packageManager}`;
const primaryKey = `${keyPrefix}-${fileHash}`;
```

The key is `node-cache-${RUNNER_OS}-${arch}-npm-${hash(lockfile)}`. **The Node version is not in
the key and never has been.** So the brief's expectation — "keys rotate when a line advances" —
is wrong in a benign direction: switching `22` → `lts/-1` cannot invalidate or fragment the npm
cache at all. Today's 22 and 24 cells already share one cache entry per OS+arch.

Recording the pre-existing sharp edge that this makes visible (not introduced here): because the
key is Node-version-agnostic, an npm content-addressed cache populated by a 24 cell is restored into a 22
cell on the same OS+arch. For npm's content-addressed tarball cache that is benign.

`benchmark-compare` is the one job with a different cache namespace, because its
`cache-dependency-path` hashes both the `base/` and `head/` lock files. Unchanged by this design.

### §B8 The composite bypass — why it stays

`ci.yml:552-566` documents its own bypass, and the reason is mechanical, not stylistic:

1. the composite's second step is `run: npm ci` with **no `working-directory:`**, so it installs
   at `$GITHUB_WORKSPACE` — and `benchmark-compare` has no `package.json` at the workspace root,
   only `base/` and `head/`. It needs *two* installs;
2. the composite passes `cache: npm` with no `cache-dependency-path`, so setup-node's default
   lockfile discovery finds nothing at the root and the cache step throws.

Keep both. Only the version value changes. One risk to state plainly: this job is
`continue-on-error: true`, so a Node-version mistake here fails **quietly**, and the two sides of
the benchmark would silently run on a different major from the rest of CI.

---

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | **How recursion is bounded** — numerically (a cap tuned below V8's ceiling) or structurally (an explicit stack, so depth costs heap not frames) | (a) **Numeric only** — lower every cap below the worst measured ceiling; no structural change. (b) **Structural** for every site whose cap exceeds its ceiling (S1, S2, S3, and `walkTree` behind S4/S5), leaving the six already-safe sites recursive. (c) **Hybrid** — structural for the two cheap non-hot sites (S1 `synthesizeLevel`, S2 `writeNestedTree`), numeric for the two generator-shaped hot ones (S3, S4/S5). | **(b)** | §A2.2 shows the ceiling moves with stack size (halves with the budget) **and** JIT tier (2× swing on the *same* input), across a surface of three OSes, worker threads and three browser engines of which exactly one corner was measured. §A7 then removes the comfortable answer: git's number is **2048**, and recursively tsgit cannot reach it — `writeNestedTree` tops out at 1350 and `walkWorkingTree` at 925, while `walkTree` clears 2048 by **52 frames**. Under (a) the defensible shared cap is ~**256**, one eighth of git's default, refusing trees `git log --raw` walks without complaint — a large divergence bought to install a guard. (b) is the only option under which tsgit can adopt git's own number, under which Requirement 2's "at exactly the cap completes successfully" is deterministically testable on all three CI OSes, and under which DC-10 is even possible (§A7 row C3: git honours a configured `core.maxTreeDepth=100000`). Cost: two hot-path rewrites (§A4), which the `yield*`-bubbling and `stack.includes` analyses suggest are *also* a perf win — a hypothesis with a mechanism, to be settled by an ADR-483 A/B, never asserted. (c) is the defensible retreat if two hot-path rewrites are judged too much for one PR: it fixes the two worst cap-to-ceiling ratios cheaply and leaves `walkTree`/`walkWorkingTree` on a numeric cap that must still sit far below git's. |
| DC-2 | **Cap topology** — one shared constant or per-module values | (a) One exported shared constant (extend `MAX_TREE_WALK_DEPTH`'s role); every site imports it; `MAX_SUBMODULE_DEPTH` explicitly excluded (§A6). (b) Keep per-module constants, each with a written rationale for its value, and collapse only the three inlined `1024`s that already mean "same as `walk-tree`". (c) One shared constant plus a documented per-site override where a site genuinely needs a different bound. | **(a)** | Six caps in five files, three of which are inlined restatements of a fourth (one of them says so in a comment). None of the differences is *justified* today — 4096 vs 1024 tracks which file was written when, not any property of the recursion. Under DC-1(b) the number stops being shape-dependent entirely. Under DC-1(a)/(c) a single value is **still** viable, because DC-3(b)'s 512 clears every measured shape including the worst (S3 at 925) — so "the shapes differ" does not by itself force per-site values. (a) is also what DC-10 needs: one named source a later `core.maxTreeDepth` read can feed, rather than nine literals to hunt down. (b) becomes the honest answer only if a site turns out to need a genuinely different bound — no such site exists today, and inventing the flexibility ahead of the need is the usual mistake. (c) is (a) with that escape hatch pre-installed. Note either way: promoting a constant into the public barrel requires a regenerated `reports/api.json` in the same commit. |
| DC-3 | **The cap value** | (a) **2048** — git's default (§A7 Pin 1), reachable only under DC-1(b). (b) **512** — git's own MSVC default, i.e. a number git already ships for a smaller-stack platform; ~1.8× margin against S3's measured 925, ~0.9× on a half-stack engine. (c) **256** — ~2× margin against the worst measured shape halved for an unmeasured engine (§A2.3). | **(a)** if DC-1 is (b); **(b)** if DC-1 is (a) or (c) | Under DC-1(b) the number stops being a fact about V8 and becomes a faithfulness choice, and §A7 supplies it: 2048, with `slashCount > cap` — the predicate tsgit already implements. Under DC-1(a)/(c) the number must be one the recursion can actually reach, and (b) has a property no other candidate has: **it is a number git itself ships**, as the MSVC default, for exactly this reason. That makes the divergence citable ("tsgit adopts git's small-stack default on every platform") rather than invented. (c) is safer against the unmeasured browser engines but is a number with no provenance at all. Today's 1024 is deliberately *not* offered: it is stricter than git on six traversal sites and still exceeds S3's 925 measured ceiling — the worst of both. |
| DC-4 | **`archive`'s disabled depth cap** (§A5) — an unguarded overflow reachable from a public command | (a) Remove the `maxDepth: Number.MAX_SAFE_INTEGER` override so `archive` takes the shared cap; keep the `maxEntries` override. (b) Keep an archive-specific cap distinct from the shared one. (c) Under DC-1(b), leave `Number.MAX_SAFE_INTEGER` — a structural walk makes it literally true. | **(a)** | §A7 row R9 settles the premise: `git archive` on a 2049-deep tree exits 128 with `error: exceeded maximum allowed tree depth`. Git caps archive at `core.maxTreeDepth` like every other traversal, so (a) moves tsgit **toward** git and the shared cap is the right one by construction. (b) needs a reason archive differs from `ls-tree -r`, and §A7 shows it does not. (c) is tempting under DC-1(b) but is now **wrong on faithfulness**: an uncapped archive would accept trees git refuses, trading one divergence for its mirror image. Whichever lands, `archive.ts:96`'s comment must split the entry claim (true, stays) from the depth claim (false, goes). |
| DC-5 | **Which ADRs this needs under ADR-226** | (a) **One** ADR: §A7's pinned matrix plus the resulting refusal contract (value, predicate, which surfaces enforce, why synthesis is capped where git is not). (b) **None** — a bug fix to an already-diverging cap. (c) **Two**: one for the refusal contract, one for the structural-bounding means if DC-1 lands as (b). | **(a)** | §A7 turns this from "probably needs an ADR" into "needs one for four separate reasons": the caps diverge from git in **both** directions (1024 is stricter, 4096/disabled is looser); tsgit caps a **synthesis** surface git leaves unlimited; tsgit ignores a documented git config; and the number 4096 has no provenance. All four are one decision — *what is tsgit's tree-depth refusal contract* — and belong in one document with the matrix as its evidence. (b) leaves the next reader to re-derive both §A2 and §A7. (c) over-splits: DC-1 is the *means* to the contract, not an independently observable behaviour, and an ADR whose subject is "we used an explicit stack" is an implementation note. |
| DC-6 | **Which alias the 27 non-matrix jobs take** (composite default, `action.yml:7`) | (a) `lts/*` — the current LTS line. (b) `lts/-1` — the floor the project claims to support. (c) `lts/*`, plus a note that the floor is covered by the `unit-tests` matrix. | **(b)** | A library's non-matrix jobs (lint, typecheck, build, integration, e2e, mutation, docs) are asserting "this project works". For a published package the honest default is the **oldest** line it claims to support, because that is the configuration most likely to break and least likely to be exercised elsewhere. §B4 sharpens this: once `lts/-1` advances past the declared `engines.node` floor, **nothing in CI runs on the declared minimum** — (b) at least keeps CI on the *oldest supported LTS*, the closest available proxy. (a) is the conventional choice and gives faster feedback on the line most consumers use, but it means every non-matrix job tests the newest thing while the package promises the oldest. This is a genuine values call, not a technical one — hence a decision candidate. |
| DC-7 | **Does the `latest` cell block or warn?** | (a) `continue-on-error: ${{ matrix.node == 'latest' }}` at job level — the expression evaluates per cell, so only that cell is non-blocking. (b) Leave it blocking like every other cell. (c) Drop `latest`; run `node: ['lts/-1', 'lts/*']` only, and keep the matrix at 6 cells. | **(a)** | `latest` is unpinned by construction: a Node major can turn CI red with an empty diff, and §B2 adds a second failure mode — `latest` resolves from the dist endpoint rather than the pre-cached manifest, so it misses the runner tool cache and carries rate-limit exposure the LTS aliases avoid. That is two sources of red that say nothing about the change under review. (a) keeps the early-warning signal and removes the false-blocking. (b) is defensible *only* because §B6 shows the matrix is advisory anyway (only `build` is required) — but then the cell is red-by-default noise that trains people to ignore the matrix. (c) forgoes the signal the brief is asking for. Under (a), whoever adds the cell owns noticing it: a `continue-on-error` cell nobody reads is worse than no cell. |
| DC-8 | **How the coverage-artifact condition and name are re-anchored** (§B3, sites P5/P6) — required under every DC-6/DC-7 outcome | (a) Add a `coverage: true` flag to one matrix cell via `include:` and gate on `matrix.coverage == true`; name the artifact `coverage-report-${{ matrix.os }}`. (b) Gate on the alias string itself (`matrix.node == 'lts/-1'`) and sanitise the name with a `replace()` expression. (c) Declare an `outputs.node-version` on the composite action (re-exporting setup-node's resolved version) and use the resolved concrete major in both the condition and the name. | **(a)** | (a) decouples "which cell produces coverage" from "which Node version that cell runs", which is what broke in the first place — the coupling to a literal is the defect, and re-coupling to a different literal (b) reproduces it the next time the matrix changes. (a) also yields a stable artifact name across LTS transitions, so the artifact URL stops moving. (b) is the one-line fix and works, but keeps the trap armed and needs a `replace()` chain to strip `/` and `*`. (c) is the most informative — the artifact would carry the real major — but it adds a composite output, changes the artifact name every time a line advances, and is the only option that also needs the composite action's interface to change. **This decision cannot be skipped:** doing nothing means coverage artifacts silently stop being produced (§B6: nothing would turn red). |
| DC-9 | **Does `npm-service.yml` get an alias?** (site P4, `node-version: 24`) | (a) Leave it pinned at `24`, with its existing comment extended to say why it is exempt. (b) `lts/*` — today equivalent to 24, rolls forward. (c) A floor-expressing pin such as `>=24`. | **(a)** | Its comment documents a hard **npm ≥ 11** requirement: Node 22's bundled npm 10.9.x has a broken trusted-publisher OIDC PUT path, and upgrading npm in place self-corrupts the runner tool cache install. That is a floor on **npm**, not a preference about Node. (b) satisfies it today by coincidence (`lts/*` → 24 → npm 11) and would keep satisfying it as lines advance — a reasonable bet, but a bet on a coupling nobody controls, in the one workflow that publishes to a registry. (c) is not a form `setup-node` treats as a floor in the way intended. Requirement 10 says "no hardcoded Node major"; if (a) is chosen, that requirement needs an explicit carve-out for this file — which is exactly why this is a decision and not an omission. |
| DC-10 | **Does tsgit read `core.maxTreeDepth`?** — git's cap is user-configurable and tsgit reads it nowhere (§A7 Pin 1, verdict 5) | (a) **No** — ship a fixed constant; record the divergence in DC-5's ADR. (b) **Yes, clamped** — read the config, honour it up to an internal ceiling, refuse or clamp above it. (c) **Yes, unclamped** — honour any configured value, which is only implementable under DC-1(b). | **(a)** for this change, with (c) named as the follow-on that DC-1(b) unlocks | Reading the config is the faithful answer and it is *reachable* — but it is a new config surface (parse, scope precedence, invalid-value handling: §A7 row C4 shows git rejects a non-numeric value with `fatal: bad numeric config value … invalid unit`) and it widens this change well past "make the guard fire". (b) is the worst of the three: it looks faithful, and then silently disagrees with git for exactly the users who set the config — the ones who noticed the limit. (a) is honest and bounded, provided DC-5's ADR states plainly that the value is fixed and that a user who sets `core.maxTreeDepth` will see tsgit ignore it. **This is the decision most likely to be revisited**, so the constant should be introduced in a shape a later config read can feed (one named source, not nine literals) — which is DC-2 (a). |

---

## Test strategy

### The hard constraint that shapes everything below

**No test may depend on where V8's stack actually runs out.** §A2.2 shows that quantity varies
with stack size and JIT tier on the *same machine*; across ubuntu/macOS/Windows runners it is
simply unknown. Concretely, the following are forbidden:

- asserting that a given depth raises `RangeError` (the current boundary test does this, in
  effect, and it is why the suite is noisy);
- asserting a frame count, a stack depth, or any "deepest that works" number;
- any test whose *pass* depends on the recursion NOT overflowing at a depth near the ceiling.

What is permitted, and deterministic everywhere, is asserting the **typed refusal** and the
**at-cap success** — provided the cap is far enough below the ceiling that at-cap success is not
itself a stack gamble. Under DC-1(b) that is automatic. Under DC-1(a)/(c) it is precisely what
DC-3's margin buys, and the at-cap test is the thing that margin has to protect.

### The boundary test must be rewritten — deliberately

`test/unit/application/primitives/synthesize-tree-from-index.test.ts:348-386`
("Then the depth cap does NOT reject it (boundary)") currently **documents the overflow as
expected behaviour**:

```
// Synthesis itself recurses 4096 frames deep and overflows the JS
// call stack with a plain RangeError — exactly the behaviour the
// module doc predicts …
// We therefore assert the *kind* of failure: NOT a tsgit depth error
expect(data?.code).not.toBe('TREE_DEPTH_EXCEEDED');
```

This is a deliberate rewrite, not an incidental edit. The test is not wrong about what happens
today; it is wrong about that being acceptable. `expect(...).not.toBe(...)` is also a weak
oracle — it passes for a `RangeError`, an `OBJECT_NOT_FOUND`, or any other failure. Its
replacement asserts the positive: **at exactly the cap, synthesis completes and returns a tree
oid whose contents round-trip**. The sibling one-past-cap test (`:314-346`) keeps its shape and
its exact-`depth` assertion — it is already the right test — with its literals updated to
whatever DC-2/DC-3 land.

### Unit — the per-cap boundary matrix

One pair per cap, same shape everywhere:

| Cap | at-cap | one past cap |
|---|---|---|
| `synthesizeTreeFromIndex` (S1) | completes; returned tree round-trips through `readObject` | `TREE_DEPTH_EXCEEDED`, `depth === cap + 1` (slash count) |
| `writeNestedTree` (S2) | completes | `TREE_DEPTH_EXCEEDED`, `depth === cap + 1` |
| `walkWorkingTree` (S3) | yields the leaf | `TREE_DEPTH_EXCEEDED`, `depth === cap + 1` |
| `walkTree` (S5) | yields the leaf | already covered — extend if the value moves |
| `archive` (S4) | completes | `TREE_DEPTH_EXCEEDED` (new — no depth refusal exists today) |
| `flattenRawTree` (S6), `diffTrees` (S7), `walkLevel` (S10), `collectTreeObjects`/`emitTreeObjects` (S8), `markTree` (S9) | completes | `TREE_DEPTH_EXCEEDED`, `depth === cap + 1` |

Per the mutation-resistance rules in CLAUDE.md, each one-past-cap test asserts the **exact
`depth` value**, not merely the code — `toThrow(TsgitError)` and code-only assertions leave the
counting arithmetic unmutated. Use try/catch + direct `.data` assertions rather than
`toThrow(expect.objectContaining(...))`.

Two properties that are worth their own tests because they are what actually broke:

- **The guard is reachable.** For each cap, an input *far* past it (e.g. 20× the cap) still
  yields `TREE_DEPTH_EXCEEDED` with `depth === cap + 1` — never a `RangeError`, never a
  larger `depth`. This is the single assertion that would have caught the defect, and it is
  cheap: S6 and S7 already demonstrate the property at inputs of 20000 and 8000.
- **`exceedsMaxTreeDepth`'s `>`.** Isolated tests for `depth === cap` (false) and
  `depth === cap + 1` (true), so `>`→`>=` and `>`→`<` are both killed at the comparator rather
  than incidentally at nine call sites.

### The acceptance oracle

`npm run test:unit` emitting zero `Exception in PromiseRejectCallback` lines is a **process-level**
property, not an assertion any test can make about itself. It is verified by running the suite
and grepping stderr — baseline **2**, target **0** — and it belongs in the plan's per-part gate,
not in a test file. Explicitly forbidden: redirecting or filtering that stderr.

### Interop — the only tier that proves faithfulness

Parity tests are cross-adapter and prove nothing about git. Every row of §A7's matrix becomes an
assertion in a new `test/integration/tree-depth-interop.test.ts`, following the house shape:
`@proves` header block, `GIT_AVAILABLE` guard, `runGitAsync` / `runGitEnv` from
`interop-helpers.ts`, **one shared `beforeAll` repo and a 60 s timeout** (per-test repos in
git-spawning interop tests are flaky here).

The assertions pair git and tsgit on the same input: where git accepts a depth, tsgit must accept
it or the divergence must be the one DC-5's ADR argues for; where git refuses, tsgit must refuse
with the same *condition* (exit-code-equivalent refusal, not the same stderr bytes — ADR-249).

| Pin row | Assertion |
|---|---|
| Pin 2 boundary | Build one tree at D=2048 and one at D=2049 via `update-index --cacheinfo` + `write-tree`. `git ls-tree -r` exits 0 on the first, 1 on the second. tsgit's `walkTree` mirrors the split under whatever DC-3 lands — or, if the cap is lower, the test asserts the **documented divergence** and cites the ADR, rather than silently disagreeing. |
| W2/W4 | `git write-tree` exits 0 on the D=2049 index and on far deeper ones. This is the row that proves `synthesizeTreeFromIndex`'s cap has **no** git counterpart, and it must be asserted, not assumed — it is the entire basis for DC-5's divergence argument. |
| R9 | `git archive --format=tar` of the D=2049 tree exits 128. tsgit's `archive` must refuse too (DC-4). **This assertion fails on `main`** — today tsgit's `archive` has no depth refusal at any input — and it is the single most valuable test in Scope A. |
| R13 | `git fsck --strict` exits 0 on a repo containing the D=2049 tree. tsgit's `fsck` must not grow a depth check for symmetry. A negative assertion, cheap, and it forecloses a plausible wrong "fix". |
| C1/C2 | `-c core.maxTreeDepth=<n>` moves git's boundary in both directions. Assert both exit codes so the config's existence is recorded in the suite; under DC-10(a) tsgit is expected **not** to follow, and the test says so explicitly with a pointer to the ADR. |

Three traps this file must dodge, all from §A7's method:
- building a genuinely deep path on disk hits `PATH_MAX` (1024 on darwin → checkout dies at real
  depth ~471, row F2) long before git's own 2048. Every fixture above therefore drives git
  through plumbing that takes the path as **data** (`update-index --cacheinfo`, `write-tree`),
  never as a filesystem path. An on-disk fixture would measure the filesystem, not git.
- rows F5–F7: on a real deep worktree git **warns and silently skips** rather than failing, so no
  assertion may read "git exited 0" as "git accepted the path".
- `runGitEnv()` scrubs `GIT_*`; do not rely on `-C <path>` to override an inherited `GIT_DIR`,
  because it does not.

**Every deep fixture uses the memory adapter, and that is not a convenience.** `PATH_MAX` is 1024
on darwin and differs again on Windows; §A7 row F2 shows a real checkout dying at depth ~471. A
`walkWorkingTree` at-cap test against the **node** adapter would therefore fail on the filesystem
long before it reached any plausible cap — it would be measuring `File name too long`, not the guard.
`createMemoryContext()` has no path-length limit, so the same fixture runs identically on linux,
macOS and Windows. Concretely:

- **Unit tests** — memory adapter throughout, for both the `walkWorkingTree` directory fixtures
  and the synthetic tree chains. This is what makes Requirement 2 satisfiable on all three OSes.
- **Interop tests** — real git, but driven through path-as-data plumbing (above), so no deep
  path is ever materialised on disk.
- Any test that *does* create real deep directories is out of bounds: it is platform-dependent by
  construction, and per the cross-cutting constraint it would be asserting a filesystem property
  rather than the behaviour under test.

### Property tests

Applying the four lenses from CLAUDE.md: this change touches recursion bounding and a
comparator, not a parser, matcher, round-trip pair, or algebraic grammar. `exceedsMaxTreeDepth`
is a two-argument predicate whose whole behaviour is one comparison — a parameterised example
sweep is clearer than a property. **No `*.properties.test.ts` sibling is warranted.** Recording
the negative explicitly so the review pass does not flag the gap.

One exception if DC-1 lands as (b): an explicit-stack rewrite of `walkTree`/`walkWorkingTree`
*is* a restructure of a traversal whose output order is a contract, and lens 1 (round-trip /
equivalence) applies in the form **"the iterative walk yields exactly the sequence the recursive
walk yielded"** over arbitrary generated tree shapes. That is a genuine property with an
independent oracle (the pre-change implementation, captured as a fixture generator), not a
tautology. It should ship with the rewrite.

### Benchmarks

Only if DC-1 lands as (b) or (c) with a hot-path rewrite. `walkTree` and `walkWorkingTree` sit
under `log`, `status`, `diff` and `archive`, all of which are in `docs/perf/hot-paths.json` and
gated by `benchmark-compare`. Report absolute wall-clock `main`-vs-branch on one machine, and take
the citable number from the CI nightly artifact (ADR-483). Never a self-share percentage — that
framing has misled this project before. The §A4 claim that removing `yield*` bubbling is a *win*
is a hypothesis until that A/B lands; the design does not depend on it.

### Scope B — how it is proved

No new tests. `.github/scripts/has-code-changes.sh` counts `.github/` as code, so the PR that
makes the change runs the full matrix, all six→nine `unit-tests` cells, `build`, `integration`
and `e2e` on the new aliases. That is the proof. Three things to check by eye on that run, because
nothing asserts them:

1. the resolved versions in each cell's setup-node log match §B2's table (`lts/-1`→22,
   `lts/*`→24, `latest`→26);
2. the coverage artifact **exists** and its name is well-formed (the DC-8 fix — §B6 shows nothing
   would turn red if it did not);
3. `benchmark-compare`'s two trees both installed (it is `continue-on-error: true`, so a Node
   mistake there is silent).

### Gates

`npm run validate` — 100% coverage on `domain`/`adapters`, Stryker over all of `src`. Guard
clauses need isolated tests per CLAUDE.md: for each `if (depth > CAP) throw`, the at-cap and
one-past-cap cases are separate tests, and a single test tripping both proves neither. If DC-1
lands as (b), any equivalent-mutant comment carried into the rewritten code must be **re-proved
against the new structure** — a carried-forward equivalence proof about a recursive shape does
not survive its conversion to an iterative one. `merge.ts`'s `Promise.all` equivalent-mutant
comment (`merge.ts:419-425`) is the specific one at risk.

---

## Out of scope

- **Path validation semantics** — `validateIndexPath`, the `..` / `.` / empty-segment /
  leading-slash rules, and `NO_PARSER_OFFSET`. Owned by
  `src/domain/git-index/path-validator.ts`; this design only observes that a path can be
  segment-wise valid and still pathologically deep, which is why the depth cap is a separate
  concern.
- **`MAX_FLAT_TREE_ENTRIES`** and every other breadth cap. Depth only. `archive`'s
  `maxEntries: Number.MAX_SAFE_INTEGER` override is *correct* and stays (§A5).
- **`MAX_SUBMODULE_DEPTH`** — investigated (§A6) and found to be a non-throwing pruning backstop
  counting nested repositories, not tree levels. Deliberately not folded into any shared
  constant.
- **`treeCycleDetected` and the descent stacks** — `walkTree`, `flattenLevel`, `walkLevel` and
  `diffChangedSubtree` each carry an `ObjectId` stack for cycle detection whose `includes()` is
  O(depth) per level. §A4 notes it as a side-benefit of the structural option; changing it on its
  own is a separate perf change.
- **Reading `core.maxTreeDepth`** — the faithful behaviour, and reachable only under DC-1(b). It
  needs a config-parse surface, scope precedence, and the invalid-value refusal §A7 row C4 pins
  (`fatal: bad numeric config value … invalid unit`). DC-10 recommends deferring it and recording
  the divergence; if the user chooses (c) instead, it re-enters scope and the plan grows a part.
- **The `walkWorkingTree` refusal-semantics divergence** — §A7 rows F5–F7: on a genuinely deep
  worktree git warns `File name too long` and **silently stages nothing**, exit 0. tsgit throws
  `TREE_DEPTH_EXCEEDED`. That divergence exists today, is not created here, and matching it would
  mean adopting "silently see nothing" as a contract. Named so it is not mistaken for something
  this change fixes.
- **Raising `package.json` `engines.node`** — a consumer-facing, semver-relevant decision
  deliberately decoupled from what CI tests on (§B4).
- **Wiring `.nvmrc`** into the workflows via `node-version-file:`. It exists, contains `22`, and
  is referenced by nothing; whether `setup-node@v7`'s file parser accepts alias syntax was not
  verified, so proposing it would be designing from memory.
- **`--experimental-strip-types` on the Current line.** 16 npm scripts and two workflow steps use
  the flag; whether Node 26 still accepts it was not verified. It is a non-issue for `lts/*` and
  `lts/-1`, and under DC-7(a) a `latest` cell that trips over it warns rather than blocks — but
  it is the first thing to look at if the `latest` cell is red on day one.
- **Docs that assert the matrix shape** (`RUNBOOK.md:134`, `docs/adr/103`, `docs/adr/048`,
  `docs/design/phase-14-4-windows-support.md`, `docs/BACKLOG.md`) — they go stale under aliases.
  Whether they are swept here or by the docs phase is a scoping call for the plan, not a design
  decision; flagged so it is not discovered late.
