# 636 — Tree recursion is bounded structurally, not by a cap tuned against V8

- **Status:** accepted
- **Date:** 2026-08-15
- **Design:** docs/design/depth-caps-and-node-aliases.md · **Supersedes/Refines:** refines ADR-024 (bounded reads — where the cap fires); enables ADR-637

## Context

Nine call sites throw `treeDepthExceeded` behind six distinct caps. Every one exists to stop a recursive tree descent from exhausting the JavaScript call stack before a typed refusal can be raised. Four of them cannot do that, because the cap sits **above** the number of frames the engine can hold — the guard is unreachable and the failure is a raw `RangeError` with no `code`, outside the `TsgitError` contract every calling command documents.

Measured against the real modules (esbuild-bundled, one depth per fresh `node` process, `createMemoryContext()`, darwin 25.5.0 arm64, Node v22.22.3, default V8 stack):

| Site | Cap | Enforced | Measured ceiling | Verdict |
|---|---|---|---|---|
| `synthesizeLevel` (`synthesize-tree-from-index.ts`) | 4096 | input boundary | ~2250 | cap 1.8× the ceiling |
| `writeNestedTree` (`merge.ts`) | 4096 | during | ~1350 | cap 3.0× the ceiling |
| `walkInternal`+`visitEntry` (`walk-working-tree.ts`) | 4096 | during | ~925 | cap 4.4× the ceiling |
| `walkInternal` via `archive` | `Number.MAX_SAFE_INTEGER` | during (unreachable) | ~2100 | cap disabled |
| `walkTree` default, `flattenLevel`, `diffChangedSubtree`, `walkLevel`, `collectTreeObjects`/`emitTreeObjects`, `markTree` | 1024 | during | ≥2100 | reachable, but stricter than git |

The 2 `Exception in PromiseRejectCallback: RangeError` lines every `npm run test:unit` run emitted came from a boundary test that built a 4096-slash path, which `slashCount > 4096` accepts, and then overflowed. The test asserted only that the failure was *not* a tsgit depth error — it documented the defect as expected behaviour.

Two facts make a numeric cap untenable rather than merely awkward. **The ceiling is not a constant.** The same input at the same settings clears 2250 cold and 4096 after 200 shallow warm-up calls — a 2× swing on JIT tier alone — and halving `--stack-size` halves it. **And git's number is out of reach.** ADR-637 pins `core.maxTreeDepth` at 2048; recursively `writeNestedTree` tops out at 1350 and `walkWorkingTree` at 925, while `walkTree` clears 2048 by 52 frames. tsgit's supported surface is Node on three OSes, workers, and three browser engines; exactly one corner was measured.

Caller depth was measured as a non-factor: nesting the call under 200/500/1000 caller frames left the ceiling unmoved, because every path into these primitives crosses an `await` on genuinely pending work, which returns the stack to the microtask baseline. The probe awaited inside the measured function and so could not have detected an effect if one existed — the measurement is *consistent with* that mechanism rather than a clean test of it, and the practical half is what matters: on every real path through tsgit, caller depth does not accumulate.

## Options considered

1. **Numeric only** — lower every cap below the worst measured shape (925 halved for an unmeasured engine ⇒ ~256, or 512, git's own MSVC default) — pros: smallest diff; 512 is a number git itself ships / cons: the cap stays an empirical bet on V8 across a surface where one corner of six was measured; "at exactly the cap succeeds" becomes a claim about the CI matrix, not a property; at 512 tsgit refuses trees `git log --raw` walks without complaint.
2. **Structural — explicit stack for every site whose cap exceeds its ceiling (recommended)** — pros: depth costs heap, not frames, so the cap means what it says on every engine; the only option under which tsgit can adopt git's own number, and the only one under which honouring an arbitrary configured `core.maxTreeDepth` is implementable at all / cons: two hot-path rewrites (`walkTree`, `walkWorkingTree`); carried equivalent-mutant proofs must be re-proved against the new structure.
3. **Hybrid** — structural for the two cheap non-hot sites, numeric for the two generator-shaped hot ones — pros: fixes the worst two ratios without touching hot paths / cons: leaves the walkers on a number that must still sit far below git's, and forecloses ADR-637's unclamped contract.

## Decision

**Option 2 (user-ratified).** Every recursive tree descent whose cap exceeded its measured ceiling is rewritten to carry its own explicit stack, so depth is bounded by the heap and the cap becomes a **policy** number rather than a function of the engine: `synthesizeLevel`, `writeNestedTree`, `walkWorkingTree`'s `walkInternal`/`visitEntry` pair, and `walkTree`'s `walkInternal`.

The six sites bounded at `cap + 1` frames — `flattenLevel`, `diffChangedSubtree`, `walkLevel`, `collectTreeObjects`/`emitTreeObjects`, `markTree` — stay recursive **provisionally**, and the qualifier is load-bearing. Their guard sits at the head of the recursive function before any descent, which is why inputs of 20000 and 8000 refuse cleanly today at a cap of 1024.

That bound is on the **input**, not on the frames, and ADR-637 makes the cap user-controlled: at `core.maxTreeDepth = 100000` these six would recurse 100 001 frames and overflow before the guard fires — the defect this record exists to remove, re-entering through the config door. The two records do not compose on their face, and the evidence does not close the gap either way: the 20000 and 8000 rows prove the *guard* fired at depth 1025, not that 20 000 frames were ever held. Their real ceilings are unmeasured.

**Resolution (user-ratified): measure before rewriting.** Each of the six is driven at a large configured cap using the same harness that produced the table above — one depth per fresh process — and its ceiling published as a measurement rather than an inference. Only those that cannot hold a stated headroom above the 2048 default are rewritten. Committing to four more rewrites — two on the raw-tree cursor path, which carries documented equivalent-mutant proofs that would need re-deriving — before knowing the size of the problem would repeat the mistake this record was written to stop.

**Qualifier discharged — the measurement landed, and the anticipated asymmetry is empty.** Measured on darwin/arm64, Node v22.22.3, default V8 stack, each site cap-anchored (cap set to the target depth, one level deeper built, clean refusal confirmed at `cap + 1` rather than inferred from "did not crash"):

| Site | Bound | Margin over the 4096 threshold |
|---|---|---|
| `flattenLevel`, `diffChangedSubtree`, `walkLevel` | ≥ 15000 | 3.7× |
| `collectTreeObjects`, `emitTreeObjects` | ≥ 100000 | 24× |
| `markTree` | ≥ 100000, ran to **exactly** the configured cap and refused at `cap + 1` | 24× |

No raw `RangeError` at any site at any depth attempted. **Zero of six needed rewriting**; each took a documented invariant instead. So "the cap is honoured unclamped" holds across all ten sites, not four, and ADR-637's contract needs no standing qualification.

Two things this measurement does **not** license. It is not evidence that async recursion is stack-safe in general: the four sites rewritten above are `async` too and genuinely overflow at 2250/1350/925, with a real `RangeError` in the suite as proof. The difference — these six await genuinely-pending I/O at every level, and an awaited frame is suspended rather than stacked — is consistent with the result but is not fully characterised here. It also surfaced a second wall that was **not** a stack limit: `flattenLevel`, `diffChangedSubtree` and `walkLevel` rebuilt their cycle-detection ancestry with an O(depth²) `[...stack, id]` copy at every level, which exhausted the JS **heap** near depth 32000 — an uncatchable abort rather than a typed refusal, and reachable by configuration alone once the cap became user-supplied and unclamped. It was first recorded here as deferred; review escalated it, and it is **fixed in this change**: those three sites and `walkTree` now carry one walk-owned mutable `Set<ObjectId>`, added on entry and removed when the frame exits. Live pointers drop from O(depth²) to O(depth), and the 32000 figure no longer describes the code — the descent's remaining ceiling is memory proportional to depth, as any bounded structure would be. Cycle semantics are unchanged: the set is exactly the root-to-current path, so two siblings sharing one subtree oid still both traverse.

`MAX_SUBMODULE_DEPTH` is explicitly outside this: `walkInTree`'s `if (depth >= maxDepth) continue` is a non-throwing pruning backstop counting nested *repositories*, not tree levels, at 101 frames against a worst measured ceiling of 925. It is the one cap in the inventory whose number is not a guess about V8.

The rule future work applies: **a tree descent that can be driven by untrusted input does not recurse.** A new cap is chosen for what the format should permit, never for what the engine can survive.

## Consequences

The refusal becomes deterministic. "At exactly the cap, the operation completes" is testable on linux, macOS and Windows without depending on where V8's stack runs out, which is what makes ADR-637's boundary matrix assertable at all. No test may assert a raw `RangeError`, a frame count, or a "deepest that works" number; the guard-is-reachable property is asserted instead, by driving each cap at a large multiple of its value and requiring `TREE_DEPTH_EXCEEDED` with `depth === cap + 1`.

Two hot paths change. `walkTree` sits under `log`, `status`, `diff`, `archive` and `walkSubmodules`; `walkWorkingTree` sits under `status`. The mechanism suggests the rewrite is also a *win* — `yield*` delegation does not flatten, so a value yielded at depth *d* is re-yielded through *d* enclosing generators, making a full walk O(entries × d) where an explicit stack is O(entries); and `walkTree`'s per-level `stack.includes(tree.id)` is O(d) per level, i.e. O(d²) per descent, where an explicit stack can carry a `Set`. **That is a hypothesis with a mechanism, not a measurement.** Under ADR-483 it is settled by an absolute wall-clock `main`-vs-branch A/B and the CI nightly artifact, never a self-share percentage, and never asserted in a doc before it lands. If the A/B comes back neutral-or-worse the rewrite still stands on the correctness argument alone.

The iterative walkers must yield exactly the sequence the recursive ones yielded — pre-order, directory before contents — because that order is a contract. This is the one place in the change where a property test earns its keep: the pre-change implementation is an independent oracle, so "iterative ≡ recursive over arbitrary generated tree shapes" is a genuine property rather than a re-implementation of the production loop.

`merge.ts`'s `Promise.all` equivalent-mutant comment is carried into a different structure and its proof does not survive the move; it is re-proved against the new shape or removed. The `ObjectId` cycle-detection stacks are untouched here — replacing their `includes()` with a `Set` is a separate perf change, noted as a side-benefit this rewrite makes available.
