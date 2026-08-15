# Design — depth caps and Node release-line aliases

> Brief: make every tree-recursion depth cap refuse the input it cannot process (today the
> boundary value is admitted and overflows the JS call stack as a raw `RangeError`), and replace
> the hardcoded Node majors in CI with `actions/setup-node` release-line aliases.
> Status: **ratified** — revised in place against [ADR-636](../adr/636-tree-recursion-bounded-structurally.md),
> [ADR-637](../adr/637-tree-depth-cap-is-core-max-tree-depth.md) and
> [ADR-638](../adr/638-ci-tracks-node-release-lines-by-alias.md).

Two independent robustness scopes batched into one change. **Scope A** is `src/` + `test/`;
**Scope B** is `.github/` only. They share no file and can be reviewed independently; they are
batched because each alone is too small for a PR.

**Scope A now changes public behaviour, though not a single public signature.** ADR-637 makes the
tree-depth cap `core.maxTreeDepth`, read from config and honoured unclamped. `walkTree`,
`walkWorkingTree`, `synthesizeTreeFromIndex` and `diffTrees` are public (`reports/api.json`); their
*parameter lists* are unchanged, but their default bound stops being a literal and their TSDoc is
rewritten. `reports/api.json` carries doc comments, so every one of those rewrites regenerates the
report and the pre-push gate requires it committed in the same commit (§A10).

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

### Decisions this design now implements

Ratified after the first draft; they are the design's premises, not its options.

- **[ADR-636](../adr/636-tree-recursion-bounded-structurally.md)** — tree recursion is bounded
  **structurally**. `synthesizeLevel`, `writeNestedTree`, `walkWorkingTree`'s
  `walkInternal`/`visitEntry` pair and `walkTree`'s `walkInternal` each carry an explicit stack;
  depth costs heap, not frames. The six sites already bounded at `cap + 1` frames stay recursive
  and take only the new cap **value**. The rule: *a tree descent that can be driven by untrusted
  input does not recurse.*
- **[ADR-637](../adr/637-tree-depth-cap-is-core-max-tree-depth.md)** — the cap **is**
  `core.maxTreeDepth`: read from config, default **2048** when unset, honoured at **any**
  configured value with no internal ceiling and no clamp. An invalid value is refused the way git
  refuses it. `archive` takes the shared cap; its `maxEntries` override stays. One residual
  divergence is recorded rather than fixed — tsgit caps the *synthesis* surface where git's
  `write-tree` is unlimited (§A7 verdict 5).
- **[ADR-638](../adr/638-ci-tracks-node-release-lines-by-alias.md)** — the composite default is
  **`lts/*`**, the matrix is `['lts/-1', 'lts/*', 'latest']` with **`latest` blocking**,
  `npm-service.yml` is aliased rather than pinned, and the coverage cell is re-anchored on an
  `include:` flag with an OS-only artifact name.

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

- git's limit is **`core.maxTreeDepth`, default 2048** — user-configurable, and it binds
  **traversal**, not the synthesis surface this primitive implements, where git has no limit at
  all (§A7). Under ADR-637 that config *is* tsgit's cap;
- the "dead code" observation is *true at cap 4096* and is precisely the bug — a guard that
  cannot fire is a guard that does not work (§A3).

A third claim, `archive.ts:96`'s *"git archive imposes no entry or depth cap"*, is half false:
git caps archive's depth exactly like every other traversal (§A7 row R9).

---

## Requirements

When this ships:

**Scope A — the guard**

1. `npm run test:unit` emits **zero** `Exception in PromiseRejectCallback` lines. Measured
   baseline at HEAD: exactly **2** (verified — see §A1). Silencing stderr without removing the
   overflow does not satisfy this.
2. For **every** cap site, an input **one past** the cap yields `TREE_DEPTH_EXCEEDED` carrying
   the correct `depth`, and an input **exactly at** the cap completes successfully — with no
   `RangeError` at either boundary, on linux, macOS and Windows. Under ADR-637 the cap is
   configurable, so this matrix is asserted at a **small configured cap** with trivial fixtures
   (§Test strategy), not at 2048.
3. No tree descent reachable from the public surface can produce a raw `RangeError` for a deep
   input, **at any cap value the user configures**. That includes `archive`, whose cap is
   disabled today (§A5). ADR-636 makes this a **structural property** — depth costs heap, not
   frames — so it holds on any engine, not merely on the engines §A2 measured. The earlier
   draft's "empirical claim about the CI matrix" reading is retired. **Bounded by DC-14:** the six
   sites ADR-636 leaves recursive satisfy this at the 2048 default but not, on present evidence,
   at an arbitrarily large configured one. The requirement is stated at its full strength because
   that is what ADR-637 promises; DC-14 is where the shortfall is resolved.
4. One resolved cap source feeds every site. No module restates it as a literal;
   `MAX_SUBMODULE_DEPTH` is explicitly excluded (§A6).

**Scope A — the config surface** (new under ADR-637)

5. `core.maxTreeDepth` is read from config and honoured. Unset → **2048**. Any valid configured
   value is honoured with **no internal ceiling and no clamp**, including values far above and
   far below the default.
6. The value is parsed with git's numeric grammar, not JavaScript's: optional leading
   whitespace, optional `+`/`-`, decimal / octal (`0`-prefixed) / hex (`0x`-prefixed) radix,
   `k`/`m`/`g` unit suffixes, narrowed to the C `int` range. Every row of §A7 Pin 4 is matched.
7. An invalid value is **refused**, not silently defaulted: `2.5`, `""`, `"true"`, `"6 "` refuse
   as *invalid unit*; `2147483648` and beyond refuse as *out of range*. The refusal is a typed
   `TsgitError`, never a fallback to 2048 (ADR-637). §A7 Pin 7 also pins that git refuses these
   on commands that never enforce depth — how far tsgit propagates that is DC-13.
8. Zero and negative values are **valid, not invalid** — they are the strictest possible caps
   under `slashCount > cap`, and tsgit must not special-case them into "disabled" (§A7 Pin 5).
9. Which config **scopes** tsgit honours is stated in the shipped TSDoc and in `docs/use/`, so a
   user who sets the key in a scope tsgit does not read learns it from the docs rather than from
   a silent disagreement (DC-12).
10. No test asserts a raw `RangeError`, an exact frame count, or any quantity that varies with
    V8's stack budget.

**Scope A — the debris**

11. No source comment or published doc claims a git-faithfulness property that §A7 disproves.
    Specifically: `synthesize-tree-from-index.ts:30-31` ("4096, matching git's canonical limit"),
    `archive.ts:96` ("git archive imposes no entry or **depth** cap"), and `merge.ts:409-414`
    (which claims to match `synthesizeTreeFromIndex`'s *contract*, and misnames
    `MAX_FLAT_TREE_ENTRIES` as a depth cap).
12. The mangled module-doc sentence at `synthesize-tree-from-index.ts:21` is repaired.
13. `docs/use/errors.md`'s `TREE_DEPTH_EXCEEDED` row matches the shipped error: the data payload
    is `depth` only (there is no `limit` field), and the description names `core.maxTreeDepth`
    rather than a single 4096 cap.
14. Every pinned git behaviour from §A7 is asserted by a cross-tool interop test in
    `test/integration/`. At minimum: the traverse/synthesise split (git refuses `ls-tree -r` at
    2049 and accepts `write-tree` at any depth), `archive`'s refusal at 2049, and the
    configured-cap rows C1–C3 — which tsgit now **follows** rather than documents diverging from.
15. `reports/api.json` is regenerated in the same commit as any TSDoc change on a public symbol
    (§A10). The pre-push gate fails otherwise.

**Scope B**

16. No hardcoded Node major remains in `.github/` as a `node-version` value or as a matrix
    element — **with no carve-out**. `npm-service.yml` is aliased too (§B1 P4).
17. `unit-tests` runs three cells per OS from `node: ['lts/-1', 'lts/*', 'latest']`, all
    **blocking**. No `continue-on-error` on any cell.
18. The coverage-artifact step runs on exactly one cell per full matrix, gated on an `include:`
    flag rather than a version literal, and its artifact name is `coverage-report-${os}` — no
    character `actions/upload-artifact` rejects, and stable across LTS transitions (§B3).
19. The `benchmark-compare` job keeps its deliberate composite bypass and its
    `cache-dependency-path`; only the version value changes.
20. The benchmark snapshot carries the **resolved** Node version in its metadata. This is work in
    this change, not a note for later: the composite default moving 22 → 24 steps the `gh-pages`
    series **on merge** (§B9).
21. The matrix comment explaining the Node-20 floor is rewritten, not deleted (§B5).
22. `main`'s ruleset still passes. Verified live: only `build` is required (§B6).

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
would be a genuine exception — none exists in the call graph of §A9.

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
it by 2.5% on a third. That is the finding ADR-636 acted on: the question was never "which number
is safe" but "does tsgit get to use git's number at all" — and recursively the answer is no.

Git itself concedes the point. `core.maxTreeDepth` defaults to **512 under MSVC** — git lowers
its own cap on the platform with the smaller stack, for exactly the reason tsgit faces. That is
precedent for a platform-conditional number; it is also an admission that a recursive
implementation cannot offer one cap everywhere.

The worst measured shape is S3 at **925**. Applying the observed half-stack factor gives ~460.
A cap defensible across the unmeasured surface with the same ~2× margin S5 currently enjoys lands
near **256** — one eighth of git's default, refusing trees `git log --raw` walks without
complaint.

**That number is the cost of staying recursive, and it is why the numeric option lost.** Under
ADR-637 the cap is not tsgit's to choose at all: a user may configure 100000, which git honours
(§A7 row C3). No numeric constant tuned against a ~925-frame ceiling can serve that contract at
any value. The measurements in this section keep their full force as the *reason* the cap stopped
being a function of the engine — they no longer constrain what the cap may be.

### §A3 Why the obvious fixes do not work

Three fixes suggest themselves. Two are wrong; recording why, so they are not re-proposed.

| Proposed fix | Verdict |
|---|---|
| Change `slashCount > MAX_TREE_DEPTH` to `>=` | **Insufficient.** It removes one frame. The cap admits 4095 instead of 4096; the ceiling is ~2250. It also silently changes the meaning of every other cap if applied to `exceedsMaxTreeDepth`, whose `>` is pinned by S5's `TREE_DEPTH_EXCEEDED:1025`. |
| Move S1's guard from the INPUT boundary into `synthesizeLevel` (making it DURING, like the others) | **Insufficient, and the module comment inverts the reason.** The comment at `synthesize-tree-from-index.ts:114-118` says a DURING guard "would be dead code — the JS call stack would overflow long before it could ever fire". That is true *at cap 4096* and it is the bug, not a justification: a guard that can never fire is a guard that does not work. Moving it changes the admitted frame count from 4096 to 4097 — the wrong direction. **Enforcement position is not the defect; the cap value relative to the ceiling is.** |
| `return await` at `synthesizeLevel`'s return sites | **No effect.** Applied and reverted in a prior session; output unchanged. See §A1. |

What actually closes the gap is one of two things: make the cap smaller than the ceiling
(numeric), or make the descent not consume a stack frame per level (structural). **ADR-636 chose
structural**, and §A2.3 explains why the numeric branch was not merely worse but unavailable once
the cap became user-configurable.

### §A4 Structural bounding — the plan's shape

**Ratified (ADR-636).** Structural bounding replaces each recursive descent with an explicit stack
(or a work queue), so depth costs heap, not call frames. The cap stops being a number tuned
against V8 and becomes whatever `core.maxTreeDepth` says — which is what makes ADR-637's
*unclamped* promise implementable at all.

**Four sites get an explicit stack** — the four whose cap exceeded its measured ceiling:
`synthesizeLevel`, `writeNestedTree`, `walkWorkingTree`'s `walkInternal`/`visitEntry` pair, and
`walkTree`'s `walkInternal`. **Six keep their recursion** — `flattenLevel`, `diffChangedSubtree`,
`walkLevel`, `collectTreeObjects`/`emitTreeObjects`, `markTree` — and take only the new cap
*value*. Their guard sits at the head of the recursive function before any descent, which is why
inputs of 20000 and 8000 refuse cleanly today (§A2.1 rows S6/S7); rewriting them buys nothing and
risks the hot raw-tree cursor path.

**One consequence the six inherit that the four do not, and it is not settled by either ADR.**
"Structurally bounded at `cap + 1` frames for any input" is a statement about the *input*, not
about the *cap*. It held absolutely while the cap was the literal 1024. Under ADR-637 the cap is
user-controlled, so a recursive site can only honour a configured cap **up to its own frame
ceiling**: at `core.maxTreeDepth = 100000` the six would exhaust the stack before the guard fires
— the exact failure mode this change exists to remove, re-entering through the config door.

Note what §A2.1 does and does not establish here. S6 and S7 were driven to 20000 and 8000 and
refused cleanly *because the guard fired at 1025* — no run ever held 20000 frames, so those rows
are evidence about the guard, not about the ceiling. The real frame ceilings of S6–S10 are
**unmeasured**. S5, the most expensive traversal shape and one of the four getting a stack,
measured 2100 — which is 2.5% above the new default of 2048.

This is DC-14, and it is the one place where ADR-636's "six stay recursive" and ADR-637's
"unclamped" do not compose. It is not resolved here.

Per-site cost, using the §A2 shapes:

| Site | Rewrite | Invasiveness | Hot path? | Notes |
|---|---|---|---|---|
| S1 `synthesizeLevel` | Iterative post-order over the prefix trie: build the trie from the flat entries, then emit sub-trees bottom-up with an explicit stack. | **Low** — ~40 lines, one file, no signature change, no public type change | No — `checkout` / `stash` / `rebase` / `cherry-pick` / `revert` paths, once per operation | The natural shape: `groupByPrefix` already produces the trie level by level |
| S2 `writeNestedTree` | Same transformation. Must preserve the `Promise.all` fan-out across sibling subdirs, which becomes level-wise parallelism over the explicit stack. | **Low-moderate** — the parallelism is the only subtlety, and it carries a documented equivalent-mutant comment that must be re-proved against the new structure | Moderate — once per merge | Exported (`MAX_MERGE_TREE_DEPTH`), but not in `reports/api.json`, so no public-surface gate |
| S3 `walkWorkingTree.walkInternal`/`visitEntry` | Explicit DFS stack inside one flat `async function*`, yielding from the loop instead of `yield*`. | **Moderate** — two mutually-recursive generators collapse into one loop; `lazyStat` closures and the embedded-git-marker branch must survive verbatim | **Yes** — `status` | Also removes the per-yield bubbling cost (below) |
| S4/S5 `walkTree.walkInternal` | Same transformation. | **Moderate-high** — the most-referenced walker in the codebase | **Yes** — `log`, `status`, `archive`, `diff`, `walkSubmodules` | Same bubbling win |
| S6–S10 | none *structurally* | — | `diff`, `status` | Bounded at `cap + 1` frames for any input (§A2.1); rewriting them buys nothing and risks the hot raw-tree cursor path. Their **cap value** moves to the resolved `core.maxTreeDepth` — they are stricter than git today (§A10) — which is a constant change, not a rewrite, but it is also what exposes DC-14 |

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
from it, and where git supplies the number.

**Settled (ADR-637).** The `maxDepth: Number.MAX_SAFE_INTEGER` override is removed and `archive`
takes the resolved `core.maxTreeDepth`. The `maxEntries: Number.MAX_SAFE_INTEGER` override stays —
git caps archive's depth like every other traversal but does not cap its entry count, so the
comment's two claims are split rather than both deleted (§A11). The margin worry that made this a
question — 2048 sitting 52 frames below `walkTree`'s measured 2100 ceiling — is dissolved by
ADR-636: `walkTree` no longer has a frame ceiling, so 2048 is not a bet.

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

#### Pin 4 — the value grammar: what git accepts, and how it refuses the rest

Pinned by a second probe round (same method; fixture is a D=6 tree plus D=0/1024/1025 trees built
through `update-index --cacheinfo` + `write-tree`; oracle is `ls-tree -r`'s exit code). This is the
grammar ADR-637 obliges tsgit to match.

| # | Value | Parsed as | `ls-tree -r` exit | stderr (exact) |
|---|---|---|---|---|
| V1 | `2048` | 2048 | 0 | *(empty)* |
| V2 | `+6` | 6 | 0 (D=6) | *(empty)* |
| V3 | `" 6"` (leading space) | 6 | 0 (D=6) | *(empty)* |
| V4 | `"6 "` (trailing space) | — | **128** | `fatal: bad numeric config value '6 ' for '…': invalid unit` |
| V5 | `1k` | **1024** — calibrated: D=1024 exit 0, D=1025 exit 1 | 0 / 1 | *(empty)* / `error: exceeded maximum allowed tree depth` |
| V6 | `1m` | 1048576 | 0 | *(empty)* |
| V7 | `0x10` | **16** — calibrated: `0x4` refuses D=6, `0x10` accepts it | 0 | *(empty)* |
| V8 | `010` | 8 (octal) | 0 (D=6) | *(empty)* |
| V9 | `07` | 7 (octal) | 0 (D=6) | *(empty)* |
| V10 | `08` | — | **128** | `fatal: bad numeric config value '08' for '…': invalid unit` |
| V11 | `2.5` | — | **128** | `fatal: bad numeric config value '2.5' for '…': invalid unit` |
| V12 | `""` (empty) | — | **128** | `fatal: bad numeric config value '' for '…': invalid unit` |
| V13 | `"  "` (spaces only) | — | **128** | `fatal: bad numeric config value '  ' for '…': invalid unit` |
| V14 | `true` | — | **128** | `fatal: bad numeric config value 'true' for '…': invalid unit` |
| V15 | `2147483647` | INT_MAX | 0 | *(empty)* |
| V16 | `2147483648` | — | **128** | `fatal: bad numeric config value '2147483648' for '…': out of range` |
| V17 | `-2147483648` | INT_MIN — a *valid* cap | **1** | `error: exceeded maximum allowed tree depth` |
| V18 | `-2147483649` | — | **128** | `fatal: bad numeric config value '-2147483649' for '…': out of range` |
| V19 | `4294967296`, `9999999999`, `99999999999999999999` | — | **128** | `… : out of range` |

Three facts this table settles that a reading of `git-config(1)` would not:

1. **The range is the C `int`, not `int64`.** INT_MAX passes, INT_MAX + 1 is *out of range*.
   tsgit already has this exact narrowing: `config-read.ts`'s `GIT_BOOL_INT_MAX = 2_147_483_647` /
   `GIT_BOOL_INT_MIN = -2_147_483_648`, applied on top of `parseGitInt`, whose own bounds are
   int64. `core.maxTreeDepth` takes the same treatment.
2. **The grammar is `parseGitInt`'s, exactly.** Leading-whitespace trim, one optional sign,
   hex `0x` / octal `0` / decimal radix, `UNIT_SCALE` suffixes, `invalid unit` and `out of range`
   as the two refusal reasons. Every row above is reproduced by the function tsgit already ships
   (`config-read.ts:1928`). **No new parser is written for this key** — V1–V19 are a
   known-answer sweep over an existing function, not a specification for a new one.
3. **Git lower-cases the key inside its own message** — the quoted key is the all-lowercase
   spelling, not the camel-case one the user wrote. Elided as `'…'` in the table above, following
   the same convention as row C4. Not tsgit's problem
   under ADR-249 — tsgit matches the refusal *condition*, not the stderr bytes — but recorded so
   an interop assertion is not written against the mixed-case spelling.

#### Pin 5 — zero and negative are valid caps, not "disabled"

The tempting reading — *0 means unlimited* — is wrong, and it is the kind of wrong that ships.

| # | Cap | Depth | Exit | Meaning |
|---|---|---|---|---|
| Z1 | `0` | D=0 (top-level file) | **0** | accepted — `0 > 0` is false |
| Z2 | `0` | D=6 | **1** | refused |
| Z3 | `-1` | D=0 | **1** | refused |
| Z4 | `-1` | D=6 | **1** | refused |
| Z5 | `-5` | D=6 | **1** | refused |

`slashCount > cap` is applied uniformly, on a signed comparison, with no special case. `0` permits
exactly top-level entries; any negative value refuses **everything, including a depth-0 tree**.
tsgit must not add a "0 disables the cap" branch, and must not reject negatives at parse time —
V17 pins INT_MIN as a *valid* value.

#### Pin 6 — scope precedence, and the env override

Probed with `GIT_CONFIG_SYSTEM` / `GIT_CONFIG_GLOBAL` pointed at throwaway files, a D=6 tree, and
caps chosen so accept/refuse discriminates which scope won.

| # | Configuration | Winner | Exit (D=6) |
|---|---|---|---|
| P-1 | system=3, global=100, local unset | **global** (100) | 0 |
| P-2 | system=3, global=100, local=4 | **local** (4) | 1 |
| P-3 | + `-c core.maxTreeDepth=100` | **`-c`** | 0 |
| P-4 | local=4 + `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.maxTreeDepth GIT_CONFIG_VALUE_0=100` | **env** | 0 |
| P-5 | local=4, `extensions.worktreeConfig=true`, worktree=100 | **worktree** | 0 |
| P-6 | two `maxTreeDepth` entries in one file (100 then 4) | **last wins** (4) | 1 |
| P-7 | global=3, no local | **global** (3) | 1 |

Standard git precedence, no exception for this key: **system → global → local → worktree →
`-c` / `GIT_CONFIG_*`**, last-wins within a file. Row P-7 is the one that matters for tsgit: a
value set *only* in the global scope changes git's behaviour, so any reader that consults local
scope alone will disagree with git for that user. What tsgit does about it is **DC-12** — tsgit
ships both a local-only typed reader (`readConfig`) and a scope-aware raw reader
(`readConfigSections`, `SCOPE_ORDER = ['system','global','local','worktree']`), and the choice
between them is not made by either ADR (§A8).

#### Pin 7 — an invalid value is fatal on commands that never enforce depth

Same invalid value (`2.5`), different commands:

| Command | Exit | stderr |
|---|---|---|
| `write-tree` | **128** | `fatal: bad numeric config value '2.5' for '…': invalid unit` |
| `ls-files` | **128** | idem |
| `cat-file -p <tree>` | **128** | idem |
| `ls-tree <tree>` (non-`-r`) | **128** | idem |
| `ls-tree -r <tree>` | **128** | idem |
| `status --porcelain` | **128** | idem |
| `rev-list --objects --all` | **0** | *(empty)* |

Git parses `core.*` at startup, so the refusal reaches commands that have no depth surface at all
— including `write-tree`, which Pin 3 shows ignores the *value* entirely. The blast radius of
matching this in tsgit is therefore repo-wide, not scoped to the ten cap sites, because tsgit's
`readConfig` is shared by every command. That is **DC-13**; ADR-637 settles *that* an invalid value
is refused, not *where*.

#### Pin 8 — on a real worktree, the OS bites first, and git does not error

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
4. **Every one of tsgit's caps diverged from git at HEAD**, in both directions — and this change
   closes all but one of them:

| tsgit site | tsgit cap **at HEAD** | git's cap on the equivalent surface | Divergence at HEAD | After this change |
|---|---|---|---|---|
| `synthesizeTreeFromIndex` (S1) | 4096 | **none** — `write-tree` is unlimited (W2/W4) | tsgit refuses where git accepts | **remains** — the one residual divergence (verdict 5). "Unlimited" is a segfault in git too (W3); a typed refusal is strictly better than a crash |
| `writeNestedTree` (S2) | 4096 | **none** — same write surface | same | **remains** — same argument, same ADR-637 paragraph |
| `walkTree` (S5) / `archive` (S4) | 1024 / disabled | **2048** | S5 refuses trees git traverses; S4 accepts trees git refuses (R9) | **closed** — both take the resolved cap; `archive` gains a refusal it had at no input |
| `walkWorkingTree` (S3) | 4096 | 2048 nominally, `File name too long` in practice (F5–F7) | both directions | **cap closed, refusal semantics not** — F5–F7's "warn and silently skip" is named and deliberately unmatched (Out of scope) |
| `flattenRawTree`, `diffTrees`, `walkLevel`, bundle enumeration, `markTree` (S6–S10) | 1024 | **2048** | **stricter than git** — refuses trees `git diff`/`git rev-list` traverse happily | **closed at the default**; above the default it is DC-14 |

5. **`core.maxTreeDepth` is user-configurable, tsgit read it nowhere, and now it is the cap.**
   (Verified at HEAD: no occurrence of `maxTreeDepth` in `src/`.) The first draft framed this as
   an argument — *a faithful tsgit would honour it, including the 100000 of row C3, which is
   impossible for a stack-recursive implementation*. **That framing is retired.** ADR-636 removed
   the engine from the equation and ADR-637 took the consequence: honouring arbitrary configured
   values is now the plan of record, not a reason to reject one. Pins 4–7 supply the grammar, the
   zero/negative semantics, the scope precedence and the refusal condition that make it
   implementable rather than aspirational.

   **The divergence that survives is exactly one, and it is narrow.** tsgit caps the *synthesis*
   surface — `synthesizeTreeFromIndex` and `writeNestedTree` — where git's `write-tree` is
   unbounded. The pin shows git's "unbounded" is not a policy: rows W3/W4 make its only write-side
   failure a **segmentation fault whose threshold moves with `ulimit -s`** (139 near 29000 at the
   default, 100000 succeeding at `ulimit -s 65520`). Refusing where git segfaults is not a
   behaviour worth matching; a typed `TREE_DEPTH_EXCEEDED` is strictly better than a crash with a
   stale 0-byte `index.lock`. ADR-637 records this and argues it. What ADR-637 does **not** settle
   is whether the *configured* value moves those two sites or whether they keep an independent
   bound — a live question precisely because git's config never reaches that surface. DC-11.
6. **`archive.ts:96`'s comment is false about depth.** Row R9: `git archive` on a 2049-deep tree
   exits 128 with `error: exceeded maximum allowed tree depth`. Git caps archive exactly like
   every other traversal. The comment's *entry*-count claim remains true and stays.
7. **`fsck` checking nothing here (R13)** means `src/domain/fsck/validate-tree.ts` needs no depth
   check — a negative worth recording so it is not added "for symmetry".

### §A8 The cap-resolution surface — where the value is read and how it reaches nine sites

ADR-637's "one shared source supplies the cap to every site" is one sentence with a lot of
plumbing under it. This section is that plumbing, established against the code rather than
sketched.

#### §A8.1 How tsgit reads config today — the pattern to follow, not invent

Two readers exist, and the difference between them is the whole of DC-12.

| Reader | File | Scopes | Shape | Caching |
|---|---|---|---|---|
| `readConfig(ctx): Promise<ParsedConfig>` | `config-read.ts:126` | **local only** — `${commonGitDir(ctx)}/config` | typed `ParsedConfig` | per-`Context` `WeakMap`, single-flight; `invalidateConfigCache(ctx)` on write |
| `readConfigSections({ ctx, scope? })` | `config-scoped-read.ts:107` | **all four** — `SCOPE_ORDER = ['system','global','local','worktree']`, merged in precedence order | raw `IniSection[]`, scope-tagged | per-`Context`, per-scope |

`readConfig` misses → `{ parsed: {}, tokens: [], source: path }`; a missing config file is normal,
not an error. `readConfigSections`' merged path silently skips scopes the adapter cannot surface
(browser/OPFS has no `/etc/gitconfig`; the memory adapter's scope paths may fall outside `rootDir`).
Only `config.ts` — the `git config` command — consumes the scope-aware reader today; every typed
`core.*` key in the codebase comes from `readConfig`, local-only.

**The closest existing analogue is `write-object.ts:34-43`**, which reads a numeric `core.*` key to
parameterise a primitive:

```ts
const config = await readConfig(ctx);
const looseLevel = config.core?.looseCompression;
```

That is the shape `core.maxTreeDepth` follows. It also shows the existing house convention for an
invalid numeric: `applyLooseCompressionEntry` (`config-read.ts:1113`) documents *"valued-but-invalid
int merges as absent (lenient)"* — the field simply does not appear in `ParsedConfig`. **ADR-637
requires the opposite for this key** (refuse, do not default), which is why DC-13 exists.

#### §A8.2 The parse is already written

`parseGitInt(value: string | null): GitIntResult` (`config-read.ts:1928`) reproduces every row of
§A7 Pin 4: leading-whitespace trim, one optional sign, `matchDigits` giving radix 16 (`0x`), 8
(leading `0`) or 10, `UNIT_SCALE` for `k`/`m`/`g`, and `{ ok: false, reason: 'invalid unit' |
'out of range' }` otherwise. Its own bounds are int64 (`GIT_INT_MIN`/`GIT_INT_MAX`); the C-`int`
narrowing this key needs already exists one function away, in the boolean path
(`GIT_BOOL_INT_MIN = -2_147_483_648` / `GIT_BOOL_INT_MAX = 2_147_483_647`, `config-read.ts:1683`).
`core.maxTreeDepth` = `parseGitInt` + that narrowing. **No new parser.**

#### §A8.3 Signature impact, site by site

`maxDepth` is *already* an option on four of the nine. The change there is what the **default**
resolves to, not the parameter list.

| # | Site | Current signature / bound source | Change | Public? |
|---|---|---|---|---|
| S1 | `synthesizeTreeFromIndex(ctx, entries)` — `synthesize-tree-from-index.ts:140` | module const `MAX_TREE_DEPTH = 4096` (:52), checked at `slashCount > MAX_TREE_DEPTH` (:70) | **no signature change** — resolves from `ctx`. Subject to DC-11 | **yes** — barrel `:81`, `reports/api.json` |
| S2 | `writeNestedTree(ctx, leaves, depth = 0)` — `merge.ts:405` | exported `MAX_MERGE_TREE_DEPTH = 4096` (:402) | **no signature change** — resolves from `ctx`; the `depth` param is internal recursion state and disappears with ADR-636's explicit stack. Subject to DC-11 | exported, **not** in `api.json` |
| S3 | `walkWorkingTree(ctx, options?)` — `walk-working-tree.ts:50` | `options?.maxDepth ?? DEFAULT_MAX_DEPTH` (const `4096`, :14) | default becomes the resolved cap; `DEFAULT_MAX_DEPTH` goes | **yes** — `WalkWorkingTreeOptions` in `api.json` |
| S4 | `archive` → `buildEntryStream` — `archive.ts:97-101` | passes `maxDepth: Number.MAX_SAFE_INTEGER` explicitly | **drop the `maxDepth` key**; keep `maxEntries` | command is public; the override is internal |
| S5 | `walkTree(ctx, treeIdOrObject, options?)` — `walk-tree.ts:33` | `options?.maxDepth ?? MAX_TREE_WALK_DEPTH` (:41) | default becomes the resolved cap | **yes** — `WalkTreeOptions` in `api.json` |
| S6 | `flattenRawTree(ctx, root, bounds, preread?)` — `internal/flatten-raw.ts:87` | `bounds` is a **required positional**; callers pass `DEFAULT_FLATTEN_BOUNDS` (`{ maxDepth: MAX_TREE_WALK_DEPTH, maxEntries: … }`, :53) | `DEFAULT_FLATTEN_BOUNDS` cannot stay a module const — it becomes a resolver call at each call site, or `bounds.maxDepth` becomes optional. **This is the one real signature question in Scope A** | internal |
| S7 | `diffChangedSubtree` / `diffRecursiveLevel` — `diff-trees.ts:582` | reads `MAX_TREE_WALK_DEPTH` **directly**, not through options (`:602`, `:614` note "only `maxDepth` stays fixed at `DEFAULT_FLATTEN_BOUNDS`' value") | must reach the resolved cap through `diffTrees`' entry points | `diffTrees` **yes**; the internals no |
| S8 | `collectTreeObjects` / `emitTreeObjects` — `enumerate-bundle-objects.ts:86,118` | module const `MAX_TREE_DEPTH = 1024` (:38), comment already says *"Same bound as walk-tree.ts's default maxDepth"* | const goes; resolve from `ctx` | not in `api.json` |
| S9 | `markTree` — `internal/closure-not-marks.ts:54` | module const `MAX_TREE_DEPTH = 1024` (:28), same comment | idem | internal |
| S10 | `walkRawSubtree(...)` — `internal/walk-raw-subtree.ts:107,131` | `config.bounds.maxDepth`, fed from `DEFAULT_FLATTEN_BOUNDS` | rides S6's answer | internal |

Two structural facts fall out of the table:

- **Six of the ten already thread a bound through an options/bounds object.** The work is not
  "add a parameter everywhere"; it is "replace three module constants and one
  `DEFAULT_FLATTEN_BOUNDS` literal with one async resolver, and let the four already-threaded
  sites take its result as their default".
- **Every site has `ctx` in hand.** `synthesizeTreeFromIndex` and `writeNestedTree` — the two with
  no options object — need no new parameter; they read from `ctx` exactly as `writeObject` does.
  Adding an options object to either would be a public-surface change bought for nothing.

#### §A8.4 The resolver, and the two hazards it must not walk into

One primitive, one name, one call per operation:

```
resolveMaxTreeDepth(ctx): Promise<number>   // 2048 when unset; refuses per DC-13 when invalid
```

**Hazard 1 — it is `async`, and two of the ten call sites are sync-shaped.** `assertDepthBounded`
(`synthesize-tree-from-index.ts:70`) runs inside an entry loop, and `exceedsMaxTreeDepth(depth,
cap)` (`validators.ts`) is a pure comparator. Neither may become async. The cap is resolved **once
per operation, at the entry point**, and passed down as a plain number — which is exactly what the
existing `WalkConfig` / `FlattenConfig` objects already do with `maxDepth`. Resolving per level
would also multiply a `WeakMap` lookup across every frame of a hot walk.

**Hazard 2 — the derived-`Context` cache trap.** `readConfig`'s cache is keyed on **`Context`
identity**. A caller that writes config through one `Context` and reads through a spread copy gets
a fresh read, not the invalidated one — the same fan-out hazard that has produced intermittent
failures in this repo before. `resolveMaxTreeDepth` inherits it: any command that mutates
`core.maxTreeDepth` mid-operation and then re-reads must go through `invalidateConfigCache(ctx)` on
**the same object**, and no command should re-resolve mid-walk.

**When config is unavailable.** `readConfig` treats a missing file as empty, so a bare/uninitialised
repo, the browser adapter with no config written, and the memory adapter all resolve to the
default 2048. There is no "config unavailable" error path to design — absence is not failure. The
only failure path is a **present but invalid** value (DC-13).

### §A9 Blast radius

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

**ADR-636 closes the band rather than narrowing it.** With an explicit stack there is no ceiling to
sit under, so there is no "succeeds below, `RangeError` between, refuses above" — every depth past
the resolved cap yields `TREE_DEPTH_EXCEEDED` with `depth === cap + 1`, and every depth at or below
it completes. That is what makes the guard-is-reachable assertion in the test strategy a property
rather than a measurement. The blast radius does not shrink; the *failure mode* inside it becomes
typed — the thirteen call sites' documented `TsgitError` contract can now catch it.

### §A10 Cap reconciliation

Six distinct caps today: 4096 (×3, in three files, one of them `export`ed), 1024 (×4, of which
one is shared via `MAX_TREE_WALK_DEPTH` and three are inlined local `MAX_TREE_DEPTH` constants),
`Number.MAX_SAFE_INTEGER` (×1), 100 (×1, different contract).

The three inlined 1024s in `enumerate-bundle-objects.ts:38`, `closure-not-marks.ts:28` and the
`flatten-raw`/`walk-raw-subtree` bounds all mean "the same bound as `walk-tree.ts`" — one of them
says so in a comment (`enumerate-bundle-objects.ts:36-37`: *"Same bound as walk-tree.ts's default
maxDepth"*). Under ADR-637 they stop restating anything: all three read the resolved cap through
§A8's resolver, and `MAX_TREE_WALK_DEPTH` stops being a *value* and becomes the **default** the
resolver returns when `core.maxTreeDepth` is unset — renamed accordingly, since a constant called
`MAX_…` that a user can exceed is a lie.

§A7 adds a constraint the inventory alone did not show: **the 1024 caps are stricter than git**.
Every one of them guards a traversal — bundle enumeration, `not`-side marking, raw flattening,
the recursive diff — and git traverses to 2048. So today tsgit refuses trees `git diff`,
`git rev-list --objects` and `git bundle create` handle without complaint. That is a divergence
in the strict direction, which ADR-226 binds just as tightly as a permissive one, and it means
"leave the 1024s alone" is not the free option it looked like.

**Settled (ADR-637): they converge, on git's number, from one source.** The default is 2048 and the
source is `core.maxTreeDepth`. Two constraints survive the settlement:

- **`merge.ts`'s comment must change.** It currently reads *"Depth cap matches
  `synthesizeTreeFromIndex`'s contract"*. It matches the **number**; it does not match the
  **contract**, because `synthesizeTreeFromIndex` refuses at the input boundary before recursing
  and `writeNestedTree` refuses during the descent. The two admit 4096 and 4097 frames
  respectively and have ceilings of 2250 and 1350. The same sentence also claims *"walkTree (via
  flattenTree) caps at MAX_FLAT_TREE_ENTRIES depth"* — `MAX_FLAT_TREE_ENTRIES` is a **breadth**
  cap (1 000 000 entries); the depth cap is `MAX_TREE_WALK_DEPTH`. Two errors in one comment.
- **`reports/api.json` gates more than a new export here.** Verified by name search: in the report
  today — `synthesizeTreeFromIndex`, `walkTree`, `WalkTreeOptions`, `walkWorkingTree`,
  `WalkWorkingTreeOptions`, `diffTrees`, `readConfig`, `readConfigSections`,
  `MAX_SUBMODULE_DEPTH`, `MAX_FLAT_TREE_ENTRIES`. Absent — `MAX_TREE_WALK_DEPTH`,
  `MAX_MERGE_TREE_DEPTH`, `flattenRawTree`, `walkRawSubtree`, `enumerateBundleObjects`,
  `writeNestedTree`, `markNotSide`. The report carries **doc comments**, not only types, so the
  §A11 TSDoc rewrites on `synthesizeTreeFromIndex`, `walkTree` and `walkWorkingTree` regenerate it
  on their own — before any new export is considered. Regenerate and commit in the same commit or
  the pre-push gate fails.

### §A11 Documentation and comment repairs

Not a separate scope — debris the change must not step over.

| Location | Current | Repair |
|---|---|---|
| `synthesize-tree-from-index.ts:21` | `* - **Path validation**:.7 hoisted segment-level validation into` | A stripped provenance ref left the sentence headless. Rewrite as prose with no phase reference, e.g. *"**Path validation**: segment-level validation is hoisted into `parseIndex` …"* |
| `synthesize-tree-from-index.ts:30-36` | "`MAX_TREE_DEPTH` (4096, matching git's canonical limit)" | **False** (§A7 Pin 1): git's limit is `core.maxTreeDepth`, default 2048, and it does not bind this surface at all (W2/W4). Restate as: the bound is `core.maxTreeDepth` (default 2048), and capping *this* surface is ADR-637's recorded residual divergence because git's `write-tree` is unbounded. 4096's real provenance (`MAX_PATH_BYTES`, a byte-length cap) is noted or the number simply goes. **Public symbol — regenerates `api.json`.** |
| `synthesize-tree-from-index.ts:114-118` | "A secondary `depth > MAX_TREE_DEPTH` guard would be dead code" | The observation is true and is the bug (§A3). Rewrite to state the invariant the shipped design actually establishes. |
| `merge.ts:409-414` | two factual errors (§A10) — matches the *number* not the *contract*; names `MAX_FLAT_TREE_ENTRIES` (a breadth cap) as a depth cap | Rewrite. |
| `archive.ts:96-97` | "git archive imposes no entry or depth cap — pass effectively-unbounded limits" | The **entry** claim is true and stays. The **depth** claim is false: §A7 row R9 has `git archive` exiting 128 with `error: exceeded maximum allowed tree depth` at D=2049. Split them. |
| `docs/use/errors.md:111` | `` `TREE_DEPTH_EXCEEDED` \| `depth, limit` \| Tree recursion exceeded `MAX_TREE_DEPTH` (4096). `` | `treeDepthExceeded(depth)` constructs `{ code, depth }` — **there is no `limit` field**, so the documented payload is wrong. Rewrite both columns: payload `depth`; description names `core.maxTreeDepth` (default 2048) and the scopes tsgit honours (DC-12). |
| `docs/use/` — configuration page | no `core.maxTreeDepth` entry | **New.** ADR-637 makes tsgit honour a config key it never read; the honoured range, the default, the invalid-value refusal and the scope answer are user-facing and belong in the published config reference, not only in TSDoc. |
| `src/domain/fsck/validate-tree.ts` | no depth check | **Leave it.** §A7 row R13: `git fsck --strict` does not check tree depth. Recorded here so the absence is not read as an omission. |

---

## Part B — Node release-line aliases

Settled by ADR-638: matrix `node: ['lts/-1', 'lts/*', 'latest']`, **all cells blocking**;
composite default **`lts/*`**; `npm-service.yml` aliased; coverage cell re-anchored on an
`include:` flag.

**Three consequences the brief does not name. ADR-638 landed against the draft's recommendation on
the first two, which is why they now happen on merge rather than someday.**

*CI cost.* `unit-tests` goes from 3 OS × 2 majors = **6 cells** to 3 × 3 = **9**, a 50% increase
in the repo's most-run job. `fail-fast: false` means all nine always run. The draft offered this
as the argument for dropping `latest`; ADR-638 accepts the cost and keeps the cell, **blocking**.
The consequence is that an unpinned upstream major can now turn CI red on an empty diff — priced
in deliberately, on the reasoning that a Node major which breaks this project is real signal, and
that a `continue-on-error` cell nobody reads is worse than no cell.

*Benchmark continuity — on merge, not at the next promotion.* `bench.yml` and `ci.yml`'s
`benchmark-snapshot` both reach Node through the composite action, so they take the composite
default. The draft assumed `lts/-1` → 22, i.e. no change today. **ADR-638 chose `lts/*`, so the
nightly's Node major moves 22 → 24 the moment this merges**, and every number in the `gh-pages`
series steps underneath a continuous graph with an empty diff and no PR to attribute it to. Under
ADR-483 those are the citable numbers. The mitigation is therefore **work in this change, not a
note**: the resolved version goes into the snapshot metadata so a step change reads as a runtime
change rather than a regression (§B9). `benchmark-compare` is unaffected — it builds both trees on
one runner with one Node.

*And 27 jobs move with it.* The same `lts/*` default takes lint, typecheck, build, integration,
e2e, mutation, docs and the rest from 22 to 24 on merge. That is 27 of 28 composite call sites
(§B1 P1) changing runtime in one commit — the single largest behavioural effect in Scope B, and
the reason this PR's own CI run is the acceptance evidence (§B10).

### §B1 Pin sites — complete inventory

Verified by sweeping the whole `.github/` tree, not only the four sites the brief named.

| # | Site | Current | Change |
|---|---|---|---|
| P1 | `.github/actions/setup/action.yml:4-8` | `inputs.node-version.default: "22"` | **the one that matters** — 27 of 28 composite call sites inherit it. → **`lts/*`** (ADR-638), so all 27 move 22 → 24 on merge |
| P2 | `.github/workflows/ci.yml:242-244` | `node: [22, 24]` | → `['lts/-1', 'lts/*', 'latest']`, all blocking |
| P3 | `.github/workflows/ci.yml:560-566` | bare `actions/setup-node@v7`, `node-version: "22"` | alias the value; **keep** the bypass and `cache-dependency-path` |
| P4 | `.github/workflows/npm-service.yml:36-40` | bare `actions/setup-node@v7`, `node-version: 24` | → **`lts/*`** (ADR-638). The comment is rewritten from *"we pin 24 to get npm 11"* to *"the npm ≥ 11 floor is why this can never go below the current LTS"* — the floor is on **npm**, and `lts/*` satisfies it today and, npm majors being monotonic across LTS lines, thereafter. **No npm upgrade step is added** — upgrading npm in place self-corrupts the runner tool-cache install, which is why the pin existed |
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
resolved version. **ADR-638 settles it:** one matrix cell carries `coverage: true` via `include:`,
the condition gates on that flag, and the artifact is named `coverage-report-${{ matrix.os }}` —
coupled to no version literal, so the artifact URL stops moving at every LTS transition and the
trap is not rearmed at the next matrix change.

Note that `actions/setup-node` **outputs** the resolved concrete version, but the composite action
declares no `outputs:`, so that value is not available to callers today. Under the ratified
approach the artifact does not need it — but §B9's snapshot metadata does, which is where that
composite output now has to be added.

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
claims to support it.

**That gap is accepted knowingly (ADR-638), not closed.** It was the draft's strongest argument for
an `lts/-1` composite default; the ratified default is `lts/*`, which widens the gap further —
after merge the 27 non-matrix jobs assert "this project works" on 24 while the package promises
22, and only the matrix's floor cell touches an older line at all. The floor cell tracks the
oldest LTS, which is the closest available proxy for the declared floor, not the floor itself.
Closing it properly means either raising `engines.node` (semver-relevant, deliberately out of
scope) or adding a cell pinned to the declared minimum — which would reintroduce the hardcoded
major Requirement 16 forbids.

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

**And it qualifies what DC-7's "blocking" buys.** ADR-638 keeps the `latest` cell blocking in the
*workflow* sense — no `continue-on-error`, so the cell goes red and the job fails. It is **not**
blocking in the *ruleset* sense: `latest` is not a required check, so a red `latest` cell does not
mechanically prevent a merge. The decision therefore buys a loud, un-ignorable red mark and the
social contract that someone reads it; it does not buy an enforcement gate. That distinction is
worth stating plainly, because "blocking" invites the stronger reading — and because the same
fact is what makes the draft's counter-argument ("red-by-default noise trains people to ignore
the matrix") a real risk rather than a rhetorical one. Making `unit-tests` a required check is a
ruleset change, out of scope here.

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

### §B9 Benchmark snapshot metadata — work in this change

Under `lts/*` the nightly's runtime steps 22 → 24 **on merge** (Part B intro). ADR-483 makes the
`gh-pages` series the citable numbers, and a runtime step inside a continuous series is
indistinguishable from a regression unless the series records what it ran on.

So the snapshot gains the **resolved** Node version — not the alias, which is constant and
therefore useless as a discriminator. Three pieces have to meet:

1. `.github/actions/setup/action.yml` gains an `outputs:` block re-exporting
   `actions/setup-node`'s resolved version. It declares none today (§B3), which is why the value
   is not available to any caller.
2. `benchmark-snapshot` (`ci.yml:480`) and `bench.yml` pass that output into the snapshot writer.
3. The snapshot record carries it, so a reader of the series can attribute a step change to a
   runtime change.

This is the one place in Scope B where a *composite interface* changes rather than a value. It is
also the one piece of Scope B that is not self-proving from a green CI run: a green run does not
show that the metadata is populated, so it is on the by-eye checklist in the test strategy.

**`gh-pages` is benchmark data, not a website** — the orphan series branch. Nothing here deletes or
rewrites history on it; the change is additive metadata on new records only.

### §B10 The `latest` cell's day-one risk — reachability established

ADR-638 keeps `latest` **blocking** and names this PR's own run as the test. The design's earlier
treatment put `--experimental-strip-types` in a footnote under a `continue-on-error` cell; under a
blocking cell it could turn this very PR red, so it is established here rather than deferred.

**It is not reachable from `unit-tests`.** Traced through `package.json`'s wireit graph:

| Job step | Script | Command | Deps | Uses the flag? |
|---|---|---|---|---|
| `if: matrix.os == 'ubuntu-latest'` | `test:coverage` | `vitest run --project unit --coverage` | `check:types` | **no** |
| `if: matrix.os != 'ubuntu-latest'` | `test:unit` | `vitest run --project unit` | `check:types` | **no** |
| (dep of both) | `check:types` | `tsc --noEmit` | — | **no** |

The 16 `--experimental-strip-types` npm scripts are `bench:*`, `profile`, `build:js`'s
`truthful-dts` step, the parity bundle, the Stryker runners, `bench-summarize`, and five `audit-*`
/ `check-*` tooling scripts. The two workflow uses are `ci.yml:495` (`benchmark-snapshot`) and
`ci.yml:638` (`benchmark-compare`). **None of them runs in `unit-tests`, and `unit-tests` is the
only job with a `latest` cell** — every other job takes the composite default `lts/*` → 24, where
the flag is known-good.

**Verdict: theoretical, not real, for this PR.** The flag cannot make the `latest` cell red,
because no `latest` cell ever executes it. What a red `latest` cell *would* mean is a genuine Node
26 incompatibility in `vitest`, `tsc`, or the library itself — which is exactly the signal the cell
exists to produce, and it should be read as such rather than blamed on the flag.

Two second-order risks remain, and they are the ones to watch on day one:

- `latest` resolves from the **dist** endpoint rather than the pre-cached `actions/node-versions`
  manifest (§B2), so it misses the runner tool cache and carries download and rate-limit exposure
  the LTS aliases avoid. A red `latest` cell is at least as likely to be a download failure as a
  code failure, and under a blocking cell that noise blocks.
- The flag becomes reachable the moment the composite default itself reaches a Current line —
  which `lts/*` never does by construction. Recorded so the conclusion is not read as
  unconditional.

Owner: whoever merges this PR reads the nine-cell matrix before merging. `.github/` counts as code
under ADR-103, so the full matrix runs on the change that introduces it (test strategy, Scope B).

---

## Decisions

### Settled — ratified by the user, recorded in ADRs 636–638

Every load-bearing choice the draft put to the user. **Four landed against the draft's
recommendation**; those rows say so, because a design that hides where it was overruled is a
design nobody can audit.

| # | Choice | Chosen | vs recommendation | ADR | What changed in this doc |
|---|---|---|---|---|---|
| DC-1 | How recursion is bounded | **(b) Structural** — explicit stack at `synthesizeLevel`, `writeNestedTree`, `walkWorkingTree`'s `walkInternal`/`visitEntry`, `walkTree`'s `walkInternal`; the six already-bounded sites keep their recursion and take the new cap value | **as recommended** | [636](../adr/636-tree-recursion-bounded-structurally.md) | §A4 stops being a costed option and becomes the plan's shape; Requirement 3's "empirical claim about the CI matrix" caveat is retired — it is a structural property now |
| DC-2 | Cap topology | **(a) One shared source** feeding every site; the three inlined `1024`s stop restating it; `MAX_SUBMODULE_DEPTH` excluded | **as recommended** | [637](../adr/637-tree-depth-cap-is-core-max-tree-depth.md) | §A10; the "shared constant" becomes §A8's resolver, and `MAX_TREE_WALK_DEPTH` becomes the *default* the resolver returns rather than the value |
| DC-3 | The cap value | **(a) 2048** — git's default | **as recommended**, but its role changed: 2048 is now the **default when `core.maxTreeDepth` is unset**, not the constant | [637](../adr/637-tree-depth-cap-is-core-max-tree-depth.md) | §A8; every "the cap is 2048" reading is now "the cap defaults to 2048" |
| DC-4 | `archive`'s disabled cap | **(a)** drop the `maxDepth` override, keep `maxEntries` | **as recommended** | [637](../adr/637-tree-depth-cap-is-core-max-tree-depth.md) | §A5, §A8.3 row S4 |
| DC-5 | Which ADRs this needs | **(c) Two for Scope A** — 636 (the *means*) and 637 (the *contract*) — plus 638 for Scope B | **against** the recommendation of one | [636](../adr/636-tree-recursion-bounded-structurally.md) + [637](../adr/637-tree-depth-cap-is-core-max-tree-depth.md) | The draft argued an ADR whose subject is "we used an explicit stack" is an implementation note. DC-10(c) falsified that: structural bounding is the **enabler** of the unclamped promise, not an implementation detail of it, so it carries its own observable consequence and its own record |
| DC-6 | Composite default | **(a) `lts/*`** | **against** the recommendation of `lts/-1` | [638](../adr/638-ci-tracks-node-release-lines-by-alias.md) | Part B intro and §B4: 27 jobs move 22 → 24 **on merge**, and the benchmark rollover is work in this change (§B9), not a future note |
| DC-7 | Does `latest` block or warn? | **(b) Blocking** — no `continue-on-error` on any cell | **against** the recommendation of `continue-on-error` | [638](../adr/638-ci-tracks-node-release-lines-by-alias.md) | §B10: the `--experimental-strip-types` question stops being a footnote and becomes an established day-one finding with a named owner |
| DC-8 | Coverage cell re-anchoring | **(a)** `include:` flag + `coverage-report-${{ matrix.os }}` | **as recommended** | [638](../adr/638-ci-tracks-node-release-lines-by-alias.md) | §B3 |
| DC-9 | `npm-service.yml` | **(b) `lts/*`** | **against** the recommendation to keep it pinned at 24 | [638](../adr/638-ci-tracks-node-release-lines-by-alias.md) | §B1 P4: the comment is rewritten from *"we pin 24 to get npm 11"* to *"the npm ≥ 11 floor is why this can never go below the current LTS"*; no npm upgrade step is added; Requirement 16 needs **no carve-out** |
| DC-10 | Does tsgit read `core.maxTreeDepth`? | **(c) Yes, unclamped** — default 2048, any configured value honoured, no internal ceiling | **against** the recommendation to defer it and record the divergence | [637](../adr/637-tree-depth-cap-is-core-max-tree-depth.md) | The largest revision. §A8 is new. §A7 gains Pins 4–7 and inverts verdict 5. Requirement 9 flips from "record the divergence" to "honour the config". Reading the config leaves Out of scope. The test strategy is rebuilt around a configurable cap |

### Open — genuinely new, surfaced by the ratified decisions

Four choices the ADRs do not settle. They are separated from the table above because they are
**not decided**; each is a live question for the ADR conversation, with a recommendation and
nothing more.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-11 | **Does the configured `core.maxTreeDepth` bind the synthesis sites?** ADR-637 says `synthesizeTreeFromIndex` and `writeNestedTree` are capped and that capping them is the residual divergence (§A7 verdict 5). It does not say whether the *user's value* moves them — a live question precisely because git's config never reaches `write-tree` at all (Pin 3 rows W2/W4). | (a) **Yes** — the configured value binds all ten sites uniformly; one resolver, one number, no special case. A deliberate extension of git's config to a surface git leaves unbounded. (b) **No** — the synthesis sites keep an independent bound (the 2048 default, fixed), and `core.maxTreeDepth` moves only the eight traversal sites, matching exactly which surfaces git's own config binds. (c) **Yes, but floored at the default** — the configured value may raise the synthesis bound, never lower it, so a user who tightens traversal cannot break `commit` on an index git would happily write. | **(a)** | ADR-637's "one shared source supplies the cap to every site" reads toward (a), and (a) is the only option with no special case to explain, test twice, or mutate around. It also gives the user a lever for the exact scenario tsgit uniquely has: a typed refusal where git segfaults (W3). (b) is the more literally faithful reading — git's config binds traversal, so mirroring *which surfaces it binds* is arguably more faithful than mirroring *the number* onto a surface git does not bind — but it means `core.maxTreeDepth=4096` lets `ls-tree` walk a tree that `commit` then refuses to write, which is a worse surprise than either divergence. (c) removes that specific trap at the cost of a rule with two behaviours in one key, and "raise only" is not a thing git does anywhere. **Not decided here.** |
| DC-12 | **Which config read path supplies the cap.** §A7 Pin 6 pins git's precedence as system → global → local → worktree → `-c`/`GIT_CONFIG_*`, and Pin 6 row P-7 shows a **global-only** value changes git's behaviour. tsgit ships two readers (§A8.1): `readConfig` is typed but **local-only**; `readConfigSections` is scope-aware but returns raw sections and is wired to the `config` command alone. | (a) **`readConfig`** — local-only, typed, cached, identical to every other `core.*` key the codebase reads. Divergence: a value set in global/system/worktree scope is invisible to tsgit. (b) **`readConfigSections`** for this key — matches git's precedence for `core.maxTreeDepth` specifically, at the cost of one key reading through a different path from every other typed key, and re-implementing the `core` projection for it. (c) **Make `readConfig` scope-aware** — `ParsedConfig` starts merging `SCOPE_ORDER` for all keys. Faithful across the board; by far the largest blast radius, touching every config-reading command. | **(a)** for this change, with the divergence **written into the shipped docs** (Requirement 9) rather than left implicit | (a) is the only option that does not make this key special or this change large, and the local-only limitation is **pre-existing and repo-wide**: no typed `core.*` key tsgit reads today consults global scope, so (a) introduces no new class of divergence — it inherits one. That is also the argument against it: `core.maxTreeDepth` is documented by git as a *fail-safe* knob, which is exactly the kind of thing a user sets **once, globally**, so this key is more likely than most to be set in a scope tsgit cannot see. (b) is a one-key fix that leaves the general problem and adds a second reading path. (c) is the right end state and the wrong PR — it is a config-subsystem change wearing a depth-cap change's clothes. **This gap is not covered by ADR-637**, which names scope precedence as "tsgit's problem" without saying what tsgit does about it. **Not decided here; escalated.** |
| DC-13 | **Where an invalid `core.maxTreeDepth` refuses.** ADR-637 settles *that* an invalid value is refused rather than silently defaulted. §A7 Pin 7 pins that git refuses it on **`write-tree`, `ls-files`, `cat-file -p`, `ls-tree`, `status`** — commands with no depth surface at all — because it parses `core.*` at startup. tsgit's `readConfig` is shared by every command, and its existing house convention is the opposite: *"valued-but-invalid int merges as absent (lenient)"* (`config-read.ts:1113`). | (a) **Refuse at the ten cap sites only** — `resolveMaxTreeDepth` throws; commands that never resolve a depth are unaffected. (b) **Refuse repo-wide** — `readConfig` fails on an invalid `core.maxTreeDepth`, matching Pin 7 exactly, and every command in the library starts failing for that user. (c) **Refuse at the cap sites, and additionally at the command entry points that git covers** — a named list rather than a blanket. | **(a)** | (a) is bounded, testable at exactly the sites this change touches, and gives the user a typed refusal precisely when the bad value would have mattered. It under-refuses relative to git: `readObject` on a repo with `core.maxTreeDepth = 2.5` succeeds in tsgit and fails in git. (b) is literally faithful and disproportionate — it turns a typo in one config key into a total library outage, and it inverts a documented lenient convention for every *other* numeric key at the same time, which is a config-subsystem decision, not a depth-cap one. (c) is (b)'s faithfulness without its blast radius, but "the commands git happens to cover" is not a principle — it is git's startup-parse order, an implementation artefact, and enumerating it is a list that rots. **Not decided here.** |
| DC-14 | **What an unclamped cap means for the six sites that stay recursive.** ADR-636 keeps `flattenLevel`, `diffChangedSubtree`, `walkLevel`, `collectTreeObjects`/`emitTreeObjects` and `markTree` recursive because they are "structurally bounded at `cap + 1` frames for any input" — true while the cap was the literal 1024. ADR-637 makes the cap user-controlled. At `core.maxTreeDepth = 100000` those six recurse 100 000 frames deep and overflow before the guard fires, which is the defect this change exists to remove, re-entering through the config door (§A4). Their real frame ceilings are **unmeasured** — §A2.1's 20000/8000 rows prove the guard fired at 1025, not that 20 000 frames were held. | (a) **Extend ADR-636 to all ten** — every tree descent carries an explicit stack; "unclamped" becomes true everywhere, at the cost of four more rewrites including the hot raw-tree cursor path §A4 deliberately protected. (b) **Measure first, then decide** — drive each of the six at a large configured cap in a probe, publish the ceilings in §A2.1 as measurements rather than inferences, and rewrite only those that cannot hold a stated headroom above the 2048 default. (c) **Accept the ceiling on the six and say so** — `core.maxTreeDepth` is honoured unclamped on the four structural sites and is effectively bounded by the engine on the six recursive ones; document the asymmetry rather than engineer it away. | **(b)** | The disagreement between the two ADRs is real but its *size* is unknown, and (b) is the only option that does not guess at it. The measurement is cheap — §A2's harness already exists, one depth per fresh process — and it converts three inferred rows into measured ones, which §A2.1's own caveat already asks the plan to do. (a) is the honest maximal answer and may well be where (b) lands, but committing to four more rewrites (two of them on the raw-tree cursor path that carries documented equivalent-mutant proofs) before measuring is exactly the "tuned against a number nobody measured" mistake this design was written to stop. (c) contradicts Requirement 3 as re-derived — "no raw `RangeError` at any cap value the user configures" — and would have to be paired with a clamp, which ADR-637 ruled out as the worst of its three options. **Not decided here; this is the composition gap between ADR-636 and ADR-637.** |

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
**at-cap success**. Under ADR-636 that is automatic on the four rewritten sites: with an explicit
stack there is no ceiling for at-cap success to gamble against. Under DC-14 it is still an open
question for the six that stay recursive at a large configured cap — which is why every boundary
test below runs at a *small* configured cap, where no site is anywhere near any ceiling.

### The simplification a configurable cap unlocks

This is the largest single change to the test plan, and the previous draft could not see it
because it assumed a fixed constant.

With the cap fixed at 2048 (or 4096, or 1024), asserting "at exactly the cap it completes, one
past it refuses" meant **building a 2048-deep fixture for every one of the ten sites** — 2049-slash
index paths, 2049-link tree chains, 2049-level directory trees. Slow, memory-hungry, and on the
`walkWorkingTree` sites impossible against a real filesystem at all (§A7 Pin 8 row F2: darwin dies
at real depth ~471).

Under ADR-637 the cap is `core.maxTreeDepth`. **So the test sets it.**

```
Given a repository configured with core.maxTreeDepth = 4
When <site> is driven at depth 4
Then it completes
When <site> is driven at depth 5
Then it refuses with TREE_DEPTH_EXCEEDED and depth === 5
```

A depth-4 fixture is four nested trees or a path with four slashes. It is trivial to build, it
costs nothing, it is identical on linux, macOS and Windows, and it exercises **exactly** the
arithmetic a 2048-deep fixture would. This is what makes Requirement 2 cheap *and* deterministic on
all three OSes rather than merely satisfiable on one.

Two consequences worth stating so they are not re-litigated:

- **The small cap is not a weaker test.** The predicate under test is `slashCount > cap`. Its
  mutants — `>` → `>=`, `>` → `<`, `cap` → `cap ± 1` — are killed identically at cap 4 and at cap
  2048. A large fixture buys no additional mutant coverage; it buys wall-clock.
- **It requires the config write to be part of the fixture**, which means the boundary tests are
  also the tests that prove the config is *read*. Under the memory adapter that is a
  `.git/config` write plus `invalidateConfigCache(ctx)`, or a context constructed with the config
  already in place. §A8.4's derived-`Context` hazard applies: the write and the read must go
  through the same `Context` object.

### What still needs a large fixture — the short list

Three things, and only three:

| Assertion | Why it cannot use a small configured cap | Fixture |
|---|---|---|
| **The default is 2048.** Unset config → depth 2048 completes, 2049 refuses with `depth === 2049` | The number under test *is* the default; configuring anything defeats the test | One pair, memory adapter, one site (`walkTree` — the canonical traversal). A 2049-slash path is a ~4 KB string; a 2049-link tree chain is 2049 small objects in memory. Not free, not expensive |
| **Interop rows R4/R5, R9, W2/W4** (§A7) | The oracle is real git at *its* default; the whole point is that tsgit and git agree at the same number | `update-index --cacheinfo` + `write-tree` at D=2048/2049 — path-as-data, never materialised on disk |
| **DC-14's ceiling probe**, if DC-14 lands as (b) | It is a measurement of where the six recursive sites break, which is by definition a large-depth question | A probe outside the suite (§A2's harness), not a test. Its output is rows in §A2.1, not assertions |

Everything else — every per-site at-cap/past-cap pair, every `depth` payload assertion, every
guard-reachability check — runs at a configured cap in the single digits.

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
replacement asserts the positive: **at exactly the configured cap, synthesis completes and returns
a tree oid whose contents round-trip**. The sibling one-past-cap test (`:314-346`) keeps its shape
and its exact-`depth` assertion — it is already the right test — with its 4096 literals replaced by
the small configured cap.

### Unit — the per-cap boundary matrix

One pair per site, same shape everywhere, **all at a small configured `core.maxTreeDepth`**:

| Site | at-cap | one past cap |
|---|---|---|
| `synthesizeTreeFromIndex` (S1) | completes; returned tree round-trips through `readObject` | `TREE_DEPTH_EXCEEDED`, `depth === cap + 1` (slash count) |
| `writeNestedTree` (S2) | completes | `TREE_DEPTH_EXCEEDED`, `depth === cap + 1` |
| `walkWorkingTree` (S3) | yields the leaf | `TREE_DEPTH_EXCEEDED`, `depth === cap + 1` |
| `walkTree` (S5) | yields the leaf | `TREE_DEPTH_EXCEEDED`, `depth === cap + 1` |
| `archive` (S4) | completes | `TREE_DEPTH_EXCEEDED` (new — no depth refusal exists today at any input) |
| `flattenRawTree` (S6), `diffTrees` (S7), `walkLevel` (S10), `collectTreeObjects`/`emitTreeObjects` (S8), `markTree` (S9) | completes | `TREE_DEPTH_EXCEEDED`, `depth === cap + 1` |

Per the mutation-resistance rules in CLAUDE.md, each one-past-cap test asserts the **exact
`depth` value**, not merely the code — `toThrow(TsgitError)` and code-only assertions leave the
counting arithmetic unmutated. Use try/catch + direct `.data` assertions rather than
`toThrow(expect.objectContaining(...))`.

Three properties get their own tests because they are what actually broke, or what the config
newly makes breakable:

- **The guard is reachable.** For each site, an input *far* past the configured cap (20× is now
  20× of a single-digit number — free) yields `TREE_DEPTH_EXCEEDED` with `depth === cap + 1` —
  never a `RangeError`, never a larger `depth`. This is the single assertion that would have
  caught the original defect.
- **`exceedsMaxTreeDepth`'s `>`.** Isolated tests for `depth === cap` (false) and
  `depth === cap + 1` (true), so `>`→`>=` and `>`→`<` are both killed at the comparator rather
  than incidentally at ten call sites.
- **The cap is read, not guessed.** For each site, the *same* fixture passes at `core.maxTreeDepth
  = N` and refuses at `core.maxTreeDepth = N - 1`. A site that ignored the config would pass the
  at-cap test and the past-cap test at a hardcoded value and fail only this one. Without it, "the
  config is wired through" is untested at nine of the ten sites.

### Unit — the config surface (new)

Three groups, all pure and fast.

**Value grammar.** §A7 Pin 4's rows V1–V19 become a parameterised sweep over the resolver:
accepted values with their parsed result (`2048`, `+6`, `" 6"`, `1k` → 1024, `1m`, `0x10` → 16,
`010` → 8, `07` → 7, `2147483647`, `-2147483648`), and refused values with their **reason**
(`"6 "`, `08`, `2.5`, `""`, `"  "`, `true` → *invalid unit*; `2147483648`, `4294967296`,
`9999999999`, `-2147483649` → *out of range*). Assert the reason, not just that it threw —
CLAUDE.md's rule about `toThrow(ErrorClass)` alone applies directly, and *invalid unit* vs *out of
range* is exactly the StringLiteral mutant a type-only check leaves alive.

Note what this is: `parseGitInt` is already tested. These assert the **narrowing and the default**
layered on top of it — the C-`int` clamp (V15/V16 straddle it) and the 2048 fallback. Testing
`parseGitInt` again through this seam would be duplication.

**Zero and negative are caps, not switches.** §A7 Pin 5's rows Z1–Z5, isolated per CLAUDE.md's
guard-clause rule: `cap = 0` accepts a depth-0 tree and refuses a depth-1 one; `cap = -1` refuses
a depth-0 tree. Each condition gets its own test — one test covering both proves neither, and a
`cap <= 0 → unlimited` branch that someone adds later must fail loudly.

**Unset and absent.** No `[core]` section → 2048. No config file at all (bare/fresh/memory
adapter) → 2048, not an error. §A8.4: absence is not failure, and the only failure path is a
present-but-invalid value.

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

The assertions pair git and tsgit on the same input: where git accepts a depth, tsgit accepts it;
where git refuses, tsgit refuses with the same *condition* (exit-code-equivalent refusal, not the
same stderr bytes — ADR-249). **Under ADR-637 most of these now assert agreement rather than a
documented divergence**, which is the point.

| Pin row | Assertion |
|---|---|
| Pin 2 boundary / R4–R5 | Build one tree at D=2048 and one at D=2049 via `update-index --cacheinfo` + `write-tree`. `git ls-tree -r` exits 0 on the first, 1 on the second. tsgit's `walkTree` **matches the split exactly** — same number, same predicate. No divergence clause is needed any more |
| W2/W4 | `git write-tree` exits 0 on the D=2049 index and on far deeper ones. This is the row that proves the synthesis surface has **no** git counterpart, and it is the entire basis for ADR-637's residual divergence — asserted, not assumed |
| R9 | `git archive --format=tar` of the D=2049 tree exits 128. tsgit's `archive` must refuse too. **This assertion fails on `main`** — today tsgit's `archive` has no depth refusal at any input — and it is the single most valuable test in Scope A |
| R13 | `git fsck --strict` exits 0 on a repo containing the D=2049 tree. tsgit's `fsck` must not grow a depth check for symmetry. A negative assertion, cheap, and it forecloses a plausible wrong "fix" |
| C1/C2/C3 | `-c core.maxTreeDepth=<n>` moves git's boundary in both directions. **tsgit now follows**: the same configured value moves tsgit's boundary the same way, including C3's 100000 on a shallow tree. The draft's "tsgit is expected *not* to follow" clause is deleted |
| Pin 4 (V-rows) | A representative refused value (`2.5`) and a representative unit value (`1k`, calibrated at D=1024/1025) asserted against both tools. tsgit matches the **refusal condition**, not git's stderr bytes — and not the all-lowercase key spelling git quotes back (Pin 4 note 3) |
| Pin 5 (Z-rows) | `-c core.maxTreeDepth=0` accepts a depth-0 tree and refuses a depth-1 one in both tools |
| Pin 6 (P-rows) | Bounded by DC-12. Under (a) this row asserts the **local** scope agreeing and explicitly records that global/system are not consulted; under (b) or (c) it asserts the full precedence chain. Written once DC-12 lands |

Four traps this file must dodge, all from §A7's method:

- building a genuinely deep path on disk hits `PATH_MAX` (1024 on darwin → checkout dies at real
  depth ~471, row F2) long before git's own 2048. Every fixture above therefore drives git
  through plumbing that takes the path as **data** (`update-index --cacheinfo`, `write-tree`),
  never as a filesystem path. An on-disk fixture would measure the filesystem, not git;
- rows F5–F7: on a real deep worktree git **warns and silently skips** rather than failing, so no
  assertion may read "git exited 0" as "git accepted the path";
- `runGitEnv()` scrubs `GIT_*`; do not rely on `-C <path>` to override an inherited `GIT_DIR`,
  because it does not. For the config rows this matters twice over — `GIT_CONFIG_COUNT`/`KEY_0`/
  `VALUE_0` **do** override this key (Pin 6 row P-4), so an environment leaking `GIT_*` would silently
  change the value under test;
- the user's global git config is not the test's. Every config row is driven through `-c` or a
  throwaway file, never through whatever the developer has set.

**Every deep fixture uses the memory adapter, and that is not a convenience.** `PATH_MAX` is 1024
on darwin and differs again on Windows; §A7 row F2 shows a real checkout dying at depth ~471. A
`walkWorkingTree` at-cap test against the **node** adapter would fail on the filesystem long before
it reached the default cap — it would be measuring `File name too long`, not the guard.
`createMemoryContext()` has no path-length limit, so the same fixture runs identically on linux,
macOS and Windows. Concretely:

- **Unit tests** — memory adapter throughout, for both the `walkWorkingTree` directory fixtures
  and the synthetic tree chains. With a small configured cap the fixtures are shallow enough that
  a real filesystem *would* cope — but the memory adapter is still the right choice, because it
  keeps one fixture shape across every site including the default-is-2048 pair, which a real
  filesystem cannot hold.
- **Interop tests** — real git, but driven through path-as-data plumbing (above), so no deep
  path is ever materialised on disk.
- Any test that *does* create real deep directories is out of bounds: it is platform-dependent by
  construction, and per the cross-cutting constraint it would be asserting a filesystem property
  rather than the behaviour under test.

### Property tests

The first draft concluded no property test was warranted, with one conditional exception. **That
conclusion is now half wrong**, and ADR-636 settles which half.

**Warranted, and mandated by ADR-636: `iterative ≡ recursive` for the four rewritten walkers.**
Lens 1 (round-trip / equivalence) applies in the form *"the iterative walk yields exactly the
sequence the recursive walk yielded"* over arbitrary generated tree shapes. Pre-order,
directory-before-contents is a **contract**, and the pre-change implementation is a genuinely
independent oracle — captured as a fixture generator before the rewrite lands, not re-implemented
inside the test. That is a property, not a tautology, and ADR-636's consequences section calls it
"the one place in the change where a property test earns its keep". It ships with the rewrite, in
`walk-tree.properties.test.ts` and `walk-working-tree.properties.test.ts`, with generators in a
shared `arbitraries.ts` per ADRs 134–136. `numRuns` **100** — composition/invariant tier; these
build object stores per case and are not cheap.

The same lens covers `synthesizeLevel` and `writeNestedTree`: the oracle is *the tree oid the
recursive implementation produced for the same entries*, which is a single comparable value. Same
tier, same layout.

**Still not warranted for the cap arithmetic.** `exceedsMaxTreeDepth` is a two-argument predicate
whose whole behaviour is one comparison — a parameterised example sweep is clearer than a property,
per the "small enum / trivial input space" exclusion.

**Borderline, and the answer is no: the config value grammar.** Lens 3 (total function over an
algebraic grammar) superficially fits — "the resolver never throws on any input in a declared safe
subset" — but the function under test is `parseGitInt` plus a range clamp, and `parseGitInt` is
already covered by the existing config test suite. A property here would be testing a dependency
through a seam. §A7 Pin 4's rows are a *known-answer* sweep with a pinned oracle per row, which is
the stronger test for this job because each row has a pinned oracle from real git.

### Benchmarks

`walkTree` and `walkWorkingTree` sit under `log`, `status`, `diff` and `archive`, all of which are
in `docs/perf/hot-paths.json` and gated by `benchmark-compare`. Report absolute wall-clock
`main`-vs-branch on one machine, and take the citable number from the CI nightly artifact
(ADR-483). Never a self-share percentage — that framing has misled this project before. The §A4
claim that removing `yield*` bubbling is a *win* is a hypothesis until that A/B lands; the design
does not depend on it, and ADR-636 states the rewrite stands on the correctness argument alone if
the A/B is neutral-or-worse.

Two new costs to measure rather than assume, both introduced by ADR-637:

- **One `readConfig` per operation** on every path that resolves a cap. It is a `WeakMap` hit
  after the first call per `Context`, so the expectation is noise-level — but `status` and `log`
  resolve it on every invocation, and "expected to be free" is how the last regression got in.
- **§B9's runtime step.** The nightly moves 22 → 24 on merge, so the first post-merge benchmark
  run is not comparable to the last pre-merge one. That is the whole reason the resolved version
  goes into the snapshot metadata; the perf A/B for Scope A must be run on **one** Node major,
  not read across the step.

### Scope B — how it is proved

No new tests. `.github/scripts/has-code-changes.sh` counts `.github/` as code, so the PR that
makes the change runs the full matrix, all six→nine `unit-tests` cells, `build`, `integration`
and `e2e` on the new aliases — and, because the composite default moves, all 27 inheriting jobs on
Node 24. That is the proof. Four things to check by eye on that run, because nothing asserts them:

1. the resolved versions in each cell's setup-node log match §B2's table (`lts/-1`→22,
   `lts/*`→24, `latest`→26);
2. the coverage artifact **exists** and its name is well-formed (the DC-8 fix — §B6 shows nothing
   would turn red if it did not);
3. `benchmark-compare`'s two trees both installed (it is `continue-on-error: true`, so a Node
   mistake there is silent);
4. the benchmark snapshot record carries a **populated** resolved-version field (§B9). A green run
   does not prove this — an empty or literal-alias value would pass CI and defeat the mitigation.

And one to read rather than check: **the `latest` cell's verdict**. §B10 establishes that
`--experimental-strip-types` cannot be its cause; a red `latest` cell therefore means a genuine
Node 26 incompatibility or a dist-endpoint download failure, and under a blocking cell it holds
the PR. That is the accepted price of DC-7.

### Gates

`npm run validate` — 100% coverage on `domain`/`adapters`, Stryker over all of `src`. Guard
clauses need isolated tests per CLAUDE.md: for each `if (depth > cap) throw`, the at-cap and
one-past-cap cases are separate tests, and a single test tripping both proves neither.

Three gate-level specifics for this change:

- **Carried equivalent-mutant proofs do not survive the rewrite.** A proof about a recursive shape
  is not a proof about its iterative replacement. `merge.ts`'s `Promise.all` comment
  (`merge.ts:419-425`) is the named one at risk — ADR-636 requires it re-proved against the new
  structure or removed. Do not carry the comment across and assume it still holds.
- **`reports/api.json` is part of the gate, not an afterthought.** §A10: the TSDoc rewrites on
  `synthesizeTreeFromIndex`, `walkTree` and `walkWorkingTree` regenerate it on their own. Commit
  the regenerated report in the same commit or the pre-push gate fails.
- **Coverage scope vs mutation scope differ here.** Coverage gates `domain`/`adapters`; Stryker
  mutates all of `src`, which is where nine of the ten cap sites live. The config resolver and
  every `cap`/`cap + 1` literal are mutation targets even though they sit outside the coverage
  gate's scope.

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
- ~~**Reading `core.maxTreeDepth`**~~ — **moved into scope.** DC-10 landed as (c): tsgit reads it,
  defaults to 2048, honours any configured value unclamped. The parse, the scope question and the
  invalid-value refusal are designed in §A8 and pinned in §A7 Pins 4–7. The plan grows a part.
- **Making `readConfig` scope-aware for every key** — DC-12 option (c). `readConfig` is local-only
  today for *all* typed `core.*` keys, not just this one; widening it to `SCOPE_ORDER` is a
  config-subsystem change touching every config-reading command, and it is not this PR whichever
  way DC-12 lands. If DC-12 lands as (a), the resulting gap is **documented** (Requirement 9), not
  closed.
- **Matching git's repo-wide fatal on an invalid `core.maxTreeDepth`** — §A7 Pin 7 shows git
  refusing on `write-tree`, `ls-files`, `cat-file -p` and `status`, commands with no depth surface
  at all. Scoping tsgit's refusal is DC-13; option (b)'s repo-wide version is named here because it
  would also invert the documented lenient convention for every *other* numeric config key
  (`config-read.ts:1113`), which is a decision about the config subsystem rather than about depth.
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
- ~~**`--experimental-strip-types` on the Current line**~~ — **established, not deferred.** DC-7
  landed as blocking, so this could have turned the PR red and was traced rather than left as a
  footnote: the flag is unreachable from `unit-tests`, the only job with a `latest` cell (§B10).
  Whether Node 26 still accepts the flag remains unverified and remains irrelevant here, because
  no `latest` cell executes it. It re-enters scope only if the composite default ever reaches a
  Current line, which `lts/*` does not by construction.
- **Docs that assert the matrix shape** (`RUNBOOK.md:134`, `docs/adr/103`, `docs/adr/048`,
  `docs/design/phase-14-4-windows-support.md`, `docs/BACKLOG.md`) — they go stale under aliases.
  Whether they are swept here or by the docs phase is a scoping call for the plan, not a design
  decision; flagged so it is not discovered late.
