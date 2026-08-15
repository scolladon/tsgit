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

The six sites already structurally bounded at `cap + 1` frames for any input — `flattenLevel`, `diffChangedSubtree`, `walkLevel`, `collectTreeObjects`/`emitTreeObjects`, `markTree` — stay recursive. Their guard sits at the head of the recursive function before any descent, which is why inputs of 20000 and 8000 refuse cleanly today. They take the shared cap **value** from ADR-637; they do not get a rewrite, which would buy nothing and risk the raw-tree cursor path.

`MAX_SUBMODULE_DEPTH` is explicitly outside this: `walkInTree`'s `if (depth >= maxDepth) continue` is a non-throwing pruning backstop counting nested *repositories*, not tree levels, at 101 frames against a worst measured ceiling of 925. It is the one cap in the inventory whose number is not a guess about V8.

The rule future work applies: **a tree descent that can be driven by untrusted input does not recurse.** A new cap is chosen for what the format should permit, never for what the engine can survive.

## Consequences

The refusal becomes deterministic. "At exactly the cap, the operation completes" is testable on linux, macOS and Windows without depending on where V8's stack runs out, which is what makes ADR-637's boundary matrix assertable at all. No test may assert a raw `RangeError`, a frame count, or a "deepest that works" number; the guard-is-reachable property is asserted instead, by driving each cap at a large multiple of its value and requiring `TREE_DEPTH_EXCEEDED` with `depth === cap + 1`.

Two hot paths change. `walkTree` sits under `log`, `status`, `diff`, `archive` and `walkSubmodules`; `walkWorkingTree` sits under `status`. The mechanism suggests the rewrite is also a *win* — `yield*` delegation does not flatten, so a value yielded at depth *d* is re-yielded through *d* enclosing generators, making a full walk O(entries × d) where an explicit stack is O(entries); and `walkTree`'s per-level `stack.includes(tree.id)` is O(d) per level, i.e. O(d²) per descent, where an explicit stack can carry a `Set`. **That is a hypothesis with a mechanism, not a measurement.** Under ADR-483 it is settled by an absolute wall-clock `main`-vs-branch A/B and the CI nightly artifact, never a self-share percentage, and never asserted in a doc before it lands. If the A/B comes back neutral-or-worse the rewrite still stands on the correctness argument alone.

The iterative walkers must yield exactly the sequence the recursive ones yielded — pre-order, directory before contents — because that order is a contract. This is the one place in the change where a property test earns its keep: the pre-change implementation is an independent oracle, so "iterative ≡ recursive over arbitrary generated tree shapes" is a genuine property rather than a re-implementation of the production loop.

`merge.ts`'s `Promise.all` equivalent-mutant comment is carried into a different structure and its proof does not survive the move; it is re-proved against the new shape or removed. The `ObjectId` cycle-detection stacks are untouched here — replacing their `includes()` with a `Set` is a separate perf change, noted as a side-benefit this rewrite makes available.
