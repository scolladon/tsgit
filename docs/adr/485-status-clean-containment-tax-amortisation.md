# 485 — status:clean is the containment tax, not a regression; amortise the containment hot path

- **Status:** accepted
- **Date:** 2026-07-13
- **Design:** docs/design/status-clean-perf-investigation.md · **Supersedes/Refines:** none

## Context

The published competitor comparison shows `status:clean` at **0.67×** isomorphic-git (tsgit
slower) on the CI nightly `linux-x64` runner, where a stale pre-Phase-26 baseline (from #65,
Apple M3, macOS) had recorded **1.10×** (tsgit faster). The open question was whether that
shift is a **genuine regression** or the **documented containment tax** — tsgit's
per-`lstat` path-containment check, a security property isomorphic-git does not perform.

The definitive tests were run (the two the backlog item named):

- **Same-host historical bench** — `status:clean` on current `main` vs `5820c789~1`
  (`6f52886f`, the commit before the 26.4 containment hot-path optimisation), one machine,
  identical bench harness. Current `main`'s floor is **~13–22% faster** than pre-26.4;
  isomorphic-git (a pinned dependency) is constant across both, confirming same-host
  validity. 26.4 **improved** `status`; it did not regress it.
- **`status` CPU profile** — `resolveForMode` (0.26 self) + `checkContainment` (0.20 self)
  account for **46% of `status` self-time**: the pure-JS containment path, not the `lstat`
  syscall (0.08) nor the actual working-tree diff (`compareWorkingTreeDelta` 0.09).

So the gap **is** the containment tax, not a regression — and 26.4's `parentRealpathCache`
already covers the full working-tree scan (the scan's `lstat` uses `cachedParentRealpath`;
the flat `status:clean` fixture has 1 parent dir, the 20k-file medium fixture ~40, both far
under the 512-entry LRU — no thrash). The remaining question this ADR answers: the tax is a
**security-boundary hot path** with measurable redundant per-`lstat` work; how far do we go
amortising it?

The redundancy (POSIX `normalizeForCompare` is identity, so the tax is `nodePath` string
ops, not case-folding): per `lstat` the two `isContainedInEitherRoot` calls (a lexical
pre-check on `resolved` and a post-check on the realpath'd `real`) recompute the two
constant roots' `+ sep` prefixes 4× and normalise the child 2× per call; and the post-check
runs once per entry even though every entry under one shard directory shares a parent.

## Options considered

1. **(A) Minimal behaviour-preserving refactor** — precompute `normRoot + sep` /
   `normCanon + sep` as memoised fields; single-normalise the child per
   `isContainedInEitherRoot`. Pros: pure precompute/dedupe, verdict bit-identical, tiny
   surface. / Cons: leaves the once-per-entry post-check on the table.
2. **(B) A plus the per-parent post-check verdict cache** — additionally memoise the
   lstat-arm post-check **verdict** per parent directory beside the existing per-parent
   realpath cache, so N files under one directory pay 1 containment check, not N. Pros:
   targets the headline redundancy on the 46% frame with a **proven** verdict-identical
   transformation; pairs with 26.4's per-parent realpath cache. / Cons: changes the
   *granularity* at which the verdict is computed — allowed only because it is proven
   equivalent, and adds a cache-coherence obligation.
3. **(C) Docs-only** — declare the tax inherent, ship no code. Pros: zero risk. / Cons:
   leaves a measured, security-safe win on a hot path unrealised.

Two deeper cuts were considered and **rejected as unfaithful**: hand-rolling a single
last-separator split to replace `policy.dirname`/`policy.basename` (cannot reproduce
`nodePath` root/trailing-sep/UNC edge cases and would desync the cache key on a security
boundary), and hoisting/caching the per-entry `policy.resolve(toAbsolute(...))` (it
neutralises `..`/`.` and foreign separators before any I/O — load-bearing traversal
defence).

## Decision

**Option B.** Ship the containment hot-path amortisation as three provably
verdict-identical cuts, confined to the containment predicate helpers in
`src/adapters/node/node-file-system.ts`:

- **B1** — precompute the two roots' `+ sep` prefixes once (memoised fields mirroring the
  existing `normalizedRootDir` / `normalizedCanonicalRoot` pattern).
- **B2** — normalise the child once per `isContainedInEitherRoot`, retaining both the
  `=== root` equality arm and the `startsWith(root + sep)` prefix arm per root.
- **B3** — memoise the lstat-arm post-check verdict per parent directory beside
  `parentRealpathCache`. `isContainedInEitherRoot(join(realParent, basename)) ≡
  isContainedInEitherRoot(realParent)` for a single clean leaf (proof in the design), so the
  per-entry post-check reduces to a per-parent one.

Every cut is **provably behaviour-identical on both `posixPolicy` and `windowsPolicy`** —
the binding faithfulness constraint, because path containment is a **tsgit security
property, not a git behaviour** (no ADR diverges from git-faithfulness here; there is
nothing git-observable to diverge from). The security-critical case — a parent that
symlinks out of the root — is preserved bit-identically (`realParent` not contained →
cached `false` → `permissionDenied`). The rejected cuts (hand-rolled path split,
`resolve` hoist) stay as canonical `nodePath` / per-entry calls.

No library or command surface changes: the work is internal to the Node adapter, its tests,
and docs. Containment remains a construction-time guarantee.

## Consequences

- **Correctness gate is the security-property net, not an interop test.** The change asserts
  no git-observable behaviour, so nothing is pinned as a cross-tool interop test. The proof
  obligation is that `checkContainment` / `isContainedInEitherRoot` /
  `pathContains(Normalized)` return the identical verdict for every input after the refactor,
  extended to drive the B1/B2 precomputed-prefix path **and the B3 per-parent verdict cache**
  through both policies (the file's injected `PathPolicy` + `FsOperations` DI seam), plus a
  property sibling proving the B3 join-algebra equivalence and the two-root aggregator
  invariants. `adapters/node` is in the covered set → 100% coverage and the mutation budget
  hold on the predicate.
- **B3 carries a cache-coherence obligation:** the per-parent verdict is keyed by the same
  raw parent key as `parentRealpathCache`, set together with the realpath in
  `cachedParentRealpath`, invalidated on the exact same events (`rename` / `rmRecursive`
  `clear()`; `rm` leaves both), and the lexical pre-check stays per-entry. B3 is scoped to
  the `lstat` arm (the status scan path); the `read` arm's full-leaf realpath keeps its
  per-entry post-check.
- **The `docs/understand/performance.md` follow-up note is resolved** (the "same-host
  historical bench + profile … tracked as a follow-up" sentence at the `status:clean`
  section) with the confirmed finding: no regression, containment tax, 26.4 already improved
  it, further amortised here. The published `0.67×` number is CI-nightly-sourced and is only
  edited if a fresh nightly materially moves it (ADR-483).
- **The perf win is validated out-of-tree**, not by a committed number — see
  [ADR-486](486-status-clean-perf-validation-and-baseline-policy.md).
- The `> 512`-distinct-parent-directory LRU thrash bound is documented and out of scope; no
  benchmark exercises it.
