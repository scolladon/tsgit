# Design — checkContainment hot path: gate the settled-promise await, hoist the per-call closure

> Brief: `checkContainment` is the single hottest cross-cutting frame in the
> committed profile baseline (`docs/perf/baseline.json` / `.md`) — self-share
> **0.36 diff, 0.26 name-rev, 0.24 blame, 0.18 describe, 0.16 merge, 0.13 show,
> 0.12 status**. It is the security gate on **every** node FS op (17 call sites).
> Its remaining per-call self-cost, after root-normalisation was already
> amortised, is (1) a guaranteed microtask suspension from `await
> this.getCanonicalRoot()` on an **already-settled** promise, and (2) a per-call
> closure allocation for `check`. Drop both, byte-identical behaviour. Pure
> internal FS-adapter refactor — NOT a git-observable change, so no new interop
> golden against `checkContainment` itself; the faithfulness pin is the existing
> suite staying green with unchanged assertions, plus a re-profile showing the
> self-share drop.
> Status: draft → self-reviewed ×3 → decision candidates opened (awaiting ADR gate)

## Context

`src/adapters/node/node-file-system.ts` → `class NodeFileSystem` (lines
292–802). `checkContainment(path, mode)` (lines 742–783) is the security gate
invoked by every FS op that touches a caller-supplied path:

- **17 call sites** via `checkContainment`: `read`, `readSlice`, `readUtf8`,
  `write`, `writeStream`, `writeExclusive`, `writeUtf8`, `appendUtf8`, `stat`,
  `lstat`, `readdir`, `mkdir`, `rm`/`rmRecursive`, `rename`, `readlink`,
  `symlink`, `chmod`, `openWithNoFollow`.
- **`exists` (lines 460–493) is an 18th, near-identical inline copy** of the
  same preamble (`await this.getCanonicalRoot()` → `getNormalizedRootDir()` →
  `getResolvedNormalizedCanonicalRoot()`) — it does its own realpath + dual-root
  containment check rather than call `checkContainment`. It is **also** a top
  baseline frame (0.18 in describe / name-rev / log). Lever A applies to it
  verbatim; this design fixes both frames.
- **`symlink`'s absolute-target validation branch (lines 558–576) is a third,
  identical inline copy** of the same preamble (`await this.getCanonicalRoot()` →
  two cached getters → dual-root `pathContainsNormalized`). It fires only when
  `symlink(target, path)` receives an **absolute** target (checkout materialising
  an absolute symlink) — a low-frequency path, so it is **not** a top baseline
  frame, but it is the same settled-await pattern. Lever A applies verbatim; the
  design fixes it too for consistency (three identical sites, all three gated —
  not two-of-three, which would be an odd asymmetry a reviewer would flag).

So there are **exactly three** `await this.getCanonicalRoot()` execution sites
(verified: L462 `exists`, L567 `symlink`, L760 `checkContainment`; the two other
textual hits at L359/L363 are JSDoc, not code). Lever A gates all three.

### The per-call body of `checkContainment` (lines 742–783)

```ts
private async checkContainment(path: string, mode: ContainmentMode): Promise<string> {
  const resolved = this.pathPolicy.resolve(toAbsolute(path, this.rootDir, this.pathPolicy)); // (1) genuine per-path work
  await this.getCanonicalRoot();                                                             // (2) microtask on a settled promise
  const normalizedRoot = this.getNormalizedRootDir();                                        // (3) cached getter (cheap)
  const normalizedCanonical = this.getResolvedNormalizedCanonicalRoot();                     // (3) cached getter (cheap)
  const check = (abs: string): void => {                                                     // (4) closure alloc per call
    if (
      !pathContainsNormalized(normalizedRoot, abs, this.pathPolicy) &&
      !pathContainsNormalized(normalizedCanonical, abs, this.pathPolicy)
    ) {
      throw permissionDenied(path);
    }
  };
  try {
    const real = await this.resolveForMode(path, resolved, mode, check);                     // (5) realpath I/O lives HERE (separate frame)
    check(real);
    return real;
  } catch (err) {
    if (err instanceof TsgitError) throw err;                                                // Stryker-disable equivalent (L776)
    if (isErrnoException(err) && err.code === 'ENOENT') throw fileNotFound(path);            // Stryker-disable equivalent (L778)
    if (isErrnoException(err)) throw mapErrno(err, path);
    throw err;
  }
}
```

Where the per-call self-cost lives, decomposed:

| # | Line | Cost | Genuine per-call? |
|---|------|------|-------------------|
| 1 | `pathPolicy.resolve(toAbsolute(...))` | string normalisation of *this* path | **yes** — irreducible, distinct input every call |
| 2 | `await this.getCanonicalRoot()` | one microtask suspension, guaranteed, on a settled promise | **no** — the target is instance-stable after first resolution |
| 3 | `getNormalizedRootDir()` / `getResolvedNormalizedCanonicalRoot()` | field read + one lazy memoise on first ever call | **no** — already amortised |
| 4 | `const check = (abs) => {…}` | closure allocation capturing `normalizedRoot`, `normalizedCanonical`, `this.pathPolicy`, `path` | **no** — only `path` is per-call, and only for the error message |
| 5 | `resolveForMode` → `realpath` | the actual FS syscall | **yes** — but it is a *separate profile frame* (`resolveForMode` / `realpath`), NOT `checkContainment` self |

So the two levers below target #2 and #4. #1 and #5 are irreducible and #5 is
not even attributed to this frame's self-share.

### Existing caching infra (already in place — do NOT rebuild)

The root-normalisation amortisation is done (lines 300–390):

- `normalizedRootDir` — memoised `normalizeForCompare(rootDir)`, lazy (L350–355).
- `canonicalRootPromise` — one shared `realpath(rootDir)` promise; **cleared on
  rejection** so a transient ENOENT retries (L375–390).
- `normalizedCanonicalRoot` — set in the promise's success arm, cleared on its
  rejection arm (L380 / L385). **This field is the resolved sentinel** the whole
  design pivots on.
- `getResolvedNormalizedCanonicalRoot()` (L370–373) — synchronous, reads
  `normalizedCanonicalRoot!` (non-null assertion), trusting the "caller just did
  `await getCanonicalRoot()`" invariant. Its JSDoc already states the discipline.
- `creationParentCache` — LRU for creation-mode parent realpaths (L314),
  unrelated to this change.

So root-normalisation is already amortised. The remaining self-cost is exactly
the guaranteed microtask (#2) + the closure alloc (#4).

## The crux — why the await on a settled promise still costs

`await p` where `p` is already resolved does **not** run synchronously: per the
ES spec, `await` always schedules a microtask and yields the current job. So
even though `getCanonicalRoot()` returns the already-settled
`canonicalRootPromise` from the second call onward, every `checkContainment` call
still pays one guaranteed event-loop microtask turn. Across a command that issues
thousands of FS ops (a diff / name-rev / blame walk), that is thousands of
avoidable suspensions — and the profiler attributes the resumption bookkeeping to
this frame's self time, which is precisely why `checkContainment` tops the chart
on the I/O-heavy read commands.

The existing `getResolvedNormalizedCanonicalRoot()` already documents that a
synchronous read is *safe once the field is set* — it uses `!` and leans on the
call-site discipline. The insight for Lever A: **the field itself is the
observable "already resolved" signal**, so the `await` can be skipped when the
field is set, keeping the exact same post-condition (`normalizedCanonicalRoot`
defined) that the `!` getter already trusts.

## Approach

### Lever A — gate the settled-promise await (PRIMARY, recommended)

Replace the unconditional `await this.getCanonicalRoot();` at all **three**
execution sites — L760 (`checkContainment`), L462 (`exists`), L567 (`symlink`
absolute-target branch) — with a guarded await:

```ts
if (this.normalizedCanonicalRoot === undefined) {
  await this.getCanonicalRoot();
}
```

After the first successful resolution, `normalizedCanonicalRoot` is defined, the
`if` is false, and the call runs **synchronously through to `resolveForMode`** —
no microtask suspension. The `checkContainment` method stays `async` (it awaits
`resolveForMode`), so callers are unchanged.

**Correctness argument (the three verification questions from the brief):**

1. **Preserves the `getResolvedNormalizedCanonicalRoot()` `!` invariant?** Yes.
   The getter requires `normalizedCanonicalRoot` to be defined at read time. Two
   cases:
   - Field already defined → we skip the await, field stays defined → getter
     safe.
   - Field `undefined` → we `await this.getCanonicalRoot()`. On success its
     `.then` arm sets `normalizedCanonicalRoot` **before the awaited promise
     settles** (the assignment is inside the `then` callback that produces the
     resolution value), so by the time control returns past the `await` the
     field is defined → getter safe. This is the *identical* post-condition the
     current unconditional `await` already establishes; the guard only elides the
     await when the post-condition is *already* true. The invariant is
     unweakened.
2. **First-call concurrency race?** No new race. `getCanonicalRoot()` already
   de-duplicates concurrent first calls behind one shared `canonicalRootPromise`
   (L376). Two concurrent first `checkContainment` calls both see
   `normalizedCanonicalRoot === undefined`, both call `getCanonicalRoot()`, and
   both await the *same* promise — exactly today's behaviour. The guard does not
   introduce a check-then-act window on a mutable-in-flight value: it reads the
   field, and the only writer is the shared promise's settled arms. Worst case a
   second concurrent first-caller redundantly enters the `if` and awaits the same
   shared promise — a no-op, not a race.
3. **Rejection / retry path preserved?** Yes. On `realpath(rootDir)` rejection,
   `getCanonicalRoot`'s `.catch` clears **both** `canonicalRootPromise` and
   `normalizedCanonicalRoot` back to `undefined` (L384–385) and rethrows. So
   after a transient ENOENT the field is `undefined` again → the next call's
   guard is true → it re-awaits and retries. Identical to today. The guard reads
   the same sentinel the rejection arm resets, so retry semantics are exactly
   preserved.

**TOCTOU unchanged.** Lever A touches only the *root canonicalisation* await
(instance-stable data), never the per-path realpath in `resolveForMode`/`exists`.
Every op still re-realpaths its own path every call, so a symlink swapped between
two ops is still re-checked — the security re-stat is untouched.

Applies identically to `exists` (L462) and to the `symlink` absolute-target
branch (L567): same `normalizedCanonicalRoot` sentinel, same three-part argument.
Both those sites also read `getResolvedNormalizedCanonicalRoot()` immediately
after, so the "field defined ⇒ getter safe" post-condition is what each relies on
— identical to `checkContainment`.

### Lever B — hoist the per-call `check` closure (SECONDARY; recommend DEFER — see DC-2)

The `check` closure (L763–770) is allocated fresh on every call. It captures
three instance-stable values (`normalizedRoot`, `normalizedCanonical`,
`this.pathPolicy`) and one per-call value (`path` — used only to build the
`permissionDenied(path)` error). Options:

- **B(i) — instance predicate + throw at call sites.** Add
  `private isContained(abs: string, normRoot: string, normCanon: string): boolean`
  returning the boolean; `checkContainment` throws `permissionDenied(path)` on
  `false`. But `resolveForMode` takes `check: (abs) => void` as a callback and
  calls it internally (`read`/`lstat` arms, L727/L735), so removing the closure
  forces `resolveForMode` to be rebound to either take the trio + `path` or to
  return the abs-to-check for the caller to verify. That reshapes an internal
  method signature and its two arms — real churn for a sub-microtask alloc.
- **B(ii) — leave the closure as-is.** V8 allocates the closure on the young
  generation; it is short-lived and cheap relative to the microtask Lever A
  removes. The profiler self-share is dominated by the suspension, not the alloc.

**Recommendation: defer B.** Lever A captures the dominant win (the guaranteed
microtask on the busiest frame). B's churn touches `resolveForMode`'s callback
contract for a marginal alloc saving and risks perturbing the closure-related
mutation coverage. If the post-Lever-A re-profile still shows `checkContainment`
disproportionately hot *and* attributable to allocation, B becomes a clean
follow-up. Recorded as DC-2.

### Lever C — memoise checkContainment(path,mode)→real across a command (REJECTED)

Caching the realpath + security decision per `(path, mode)` for a command's path
set. **Rejected on two independent grounds:**

1. **Not TOCTOU-faithful.** A memoised realpath+decision would skip the re-stat
   on a path deleted or symlink-swapped mid-command. Real git re-stats every
   access; caching the decision would let a path that was safe at first touch be
   trusted after an attacker swapped it for a symlink escape. That violates
   contract A (TOCTOU byte-identical) and the security semantics. Non-starter.
2. **Wrong frame anyway.** The realpath cost lives in `resolveForMode` /
   `exists`'s own `realpath` call — a *separate* profile frame. Memoising it would
   not reduce `checkContainment`'s **self** share (which is the microtask +
   string work), so it fails the perf pin's stated target even if it were safe.

Documented as rejected; not deferred (it is unsafe, not merely out of scope).

### What does NOT change

- Method signatures of the 18 public FS ops — unchanged.
- `resolveForMode` signature (unless B is taken later) — unchanged.
- The dual-root (`raw` OR `canonical`) containment logic, the `permissionDenied`
  / `fileNotFound` / `mapErrno` mapping, the two `Stryker disable` equivalent
  comments on the catch arms (L776, L778) — untouched. The change is confined to
  one `await` → guarded-`await` on lines 760 and 462.

## Behaviour preservation — the pin is the existing suite, unchanged

Contract A: this is an internal FS-adapter refactor, not git-observable. There is
**no new real-git interop golden for `checkContainment` itself**. The faithfulness
pin is: the existing behavioural suite stays green with **unchanged assertions**.
If any proposal here required editing an existing behavioural assertion, it would
not be behaviour-preserving and would be rejected. Lever A does not.

### Exact guarding test files (must stay green, assertions unchanged)

| File | What it guards on `checkContainment` / `exists` |
|------|--------------------------------------------------|
| `test/unit/adapters/node/node-file-system.test.ts` | Real-FS containment security: symlink-escape → `PERMISSION_DENIED` (L73–91), symlink-swap escape (L99–117), lstat-mode escaped-parent (L125–142), rename-escape via absolute path (L349–369), `rootDir===resolved` short-circuit (L288), FILE_NOT_FOUND vs PERMISSION_DENIED distinction (L249). |
| `test/unit/adapters/node/node-file-system-injected.test.ts` | DI-mocked `fsOps.realpath` call-**count** pins: creation LRU (L58–), non-ENOENT parent → PERMISSION_DENIED (L150–175), missing-parent slow walk-up call count = 4 (L181–212), rmRecursive cache-clear count = 3 (L216–248). These count `realpath` invocations — the direct observable of Lever A's behaviour (see mutation plan). |
| `test/integration/checkout-replace-symlink-with-file-interop.test.ts` | The one path-containment-adjacent interop test; exercises symlink→file replacement through the adapter. Stays green unchanged. |

Additionally the whole `npm run test:unit` + `npm run test:integration` suites
(every command that drives the adapter) must stay green with zero assertion edits.

### First-call vs later-call realpath(rootDir) count — the observable of Lever A

`getCanonicalRoot` calls `fsOps.realpath(this.rootDir)` **exactly once** ever (it
is memoised behind `canonicalRootPromise`). Lever A does not change *how many*
times `realpath(rootDir)` runs — it changes *whether a microtask is scheduled*
when the field is already set. The `realpath`-call-count invariant is therefore
**identical** before and after: the injected tests' counts (4, 3, once-per-parent)
must be unchanged. A mutant that broke the guard (e.g. always-await, or
never-await) would either (a) leave counts identical but change timing — not
directly killable by count — or (b) if it dropped the await entirely on the first
call, read `normalizedCanonicalRoot!` before it is set and throw/return wrong,
which IS killable. See the mutation plan.

## Faithfulness pinning matrix

No new git-behaviour to pin (internal refactor). The matrix here is the
**invariant-preservation** matrix rather than a git-bytes matrix:

| Property | Before | After (Lever A) | Pinned by |
|----------|--------|------------------|-----------|
| `PERMISSION_DENIED` on every escape (symlink / absolute / short-name) | yes | yes | `node-file-system.test.ts` L73–369 (unchanged) |
| `FILE_NOT_FOUND` vs `PERMISSION_DENIED` split | yes | yes | `node-file-system.test.ts` L249 (unchanged) |
| `realpath(rootDir)` runs exactly once per adapter lifetime | yes | yes | memoisation intact; injected count tests |
| Per-path realpath re-run every op (TOCTOU) | yes | yes | `resolveForMode` untouched |
| Transient-ENOENT rootDir retries | yes | yes | rejection arm clears sentinel (L384–385), guard re-awaits |
| Concurrent first-call de-dup | yes | yes | shared `canonicalRootPromise` (unchanged) |
| Error object identity / codes / messages | yes | yes | catch arms untouched; Stryker-disable comments intact |

Should any downstream reviewer want a belt-and-braces git cross-check, the
existing per-command interop/e2e suites already exercise these adapters end to
end; no new golden is warranted (see DC-4, ADR question).

## Perf pinning plan

Mechanism: `npm run profile <cmd>` (26.3 / PR #224; `tooling/profile.ts` +
`tooling/profile-registry.ts`). Every hot command below is already in the
registry and re-profilable.

**Commands to re-profile** (the baseline's `checkContainment`-heavy set), with
current self-share and expected direction:

| Command | Kind | `checkContainment` self (baseline) | `exists` self (baseline) | Expected after Lever A |
|---------|------|-----------------------------------|--------------------------|------------------------|
| diff | read | 0.36 | 0.05 | `checkContainment` ↓ |
| name-rev | read | 0.26 | 0.18 | both ↓ |
| blame | read | 0.24 | — | `checkContainment` ↓ |
| describe | read | 0.18 | 0.18 | both ↓ |
| show | read | 0.13 | 0.01 | `checkContainment` ↓ |
| status | read | 0.12 | — | `checkContainment` ↓ |
| merge | write | 0.16 | 0.13 | both ↓ (command partition) |
| log | read | 0.09 | 0.18 | both ↓ |

Direction, not magnitude, is the gate: shares are self-relative and host-portable
(ADR-475), so the pin is "`checkContainment` self-share **drops** across the
I/O-heavy commands" — a microtask removed from the busiest frame necessarily
shifts self-share off it and onto the genuine work frames (`resolveForMode`,
`readSlice`, `pathContainsNormalized`). A wash or an increase would be a red flag
to investigate.

**Baseline handling — recommendation: regenerate + commit** `docs/perf/baseline.json`
(+ the sibling `docs/perf/baseline.md`) in this PR as the new post-optimisation
reference, and quote the before/after `checkContainment` (and `exists`) shares in
the PR body. Rationale: ADR-475 established the committed baseline precisely as
the *optimisation license and regression reference*; 26.4 is the first item to
spend that license, so the artifact should advance to reflect the improved surface
(the CI regression gate 26.5 will diff future captures against *this* number). Not
regenerating would leave the committed reference describing a surface the code no
longer has. This is load-bearing enough to be a formal decision candidate (DC-3)
because it changes a committed artifact the downstream gate depends on. Note: the
`generatedOn` banner is metadata, never a compared value (ADR-475), so a
host-change in the re-capture is expected and fine.

## Mutation plan

The file carries two `Stryker disable next-line` equivalent-mutant proofs on
`checkContainment`'s catch arms (L776 TsgitError early-rethrow, L778 ENOENT
short-circuit). **These proofs are structure-specific to the current catch
arms and MUST NOT be disturbed** — Lever A does not touch the catch block, so
they carry forward verbatim. Do not renumber, reword, or move them.

The new code is the guard `if (this.normalizedCanonicalRoot === undefined) {
await this.getCanonicalRoot(); }` at the three sites (L760, L462, L567). Each is
an independent mutation location, so each needs its own first-call kill test (a
mutant on `exists`'s guard is not killed by a `checkContainment` test and vice
versa; `symlink`'s guard needs a first-op-is-`symlink`-with-absolute-target
test). Stryker mutants to consider and how each is killed:

- **`ConditionalExpression` → `true` (always await).** Behaviourally
  indistinguishable from today on a settled promise (same result, extra
  microtask) — a **timing-only** difference with no functional observable. This
  is a genuine **equivalent mutant** and will survive; it needs a documented
  equivalent-mutant justification, NOT a contrived test. Reason: forcing the
  await when the field is set only re-schedules a microtask that resolves to the
  same value and leaves the same post-condition — no output, no call-count, no
  error changes.
- **`ConditionalExpression` → `false` (never await).** On the **first** call the
  field is `undefined`, the await is skipped, and `getResolvedNormalizedCanonicalRoot()`
  reads `normalizedCanonicalRoot!` while it is `undefined` → the first
  containment check compares against `undefined` and mis-decides (or the `!`
  masks it and `pathContainsNormalized` receives `undefined`, producing a wrong
  verdict / throw). **Killable** by a test whose adapter's very first FS op is a
  `checkContainment`/`exists` call with a mocked `realpath(rootDir)` that would
  otherwise populate the field — the first-call must still succeed. This is the
  test the plan must add: *"Given a fresh adapter, When the first FS op runs,
  Then it awaits canonical-root resolution before checking containment."*
  Observable via the injected `fsOps.realpath` spy: the first op must call
  `realpath(rootDir)` and succeed; skipping the await surfaces as a first-call
  failure or a `realpath(rootDir)` never issued.
- **`EqualityOperator` / `ConditionalExpression` on `=== undefined`.** Flipping
  to `!== undefined` inverts the guard → same as "never await first call" on the
  first call → killed by the same first-call test.

Make the gate observable/killable via the **injected `fsOps.realpath` call
sequence on a fresh adapter** — that is the existing, mutation-proven mechanism in
`node-file-system-injected.test.ts`, so the new test extends an established
pattern rather than inventing timing assertions. Timing (microtask counting) is
deliberately NOT asserted; the functional first-call-correctness assertion is what
kills the meaningful mutants, and the always-await mutant is accepted as provably
equivalent.

## Non-goals / explicitly deferred

Scoped to baseline finding (1) — `checkContainment` — **only**. The other 26.3
findings are out of scope for this run and become follow-up backlog entries:

- **(2) TREESAME pruning** — deferred.
- **(3) `exists`/`lstat` batching** — deferred. (Note: Lever A *incidentally*
  also fixes `exists`'s own settled-await microtask because it shares the
  `normalizedCanonicalRoot` sentinel; the *batching* of exists/lstat syscalls is a
  distinct, larger change and stays deferred.)
- **(4) tree walk / parse** — deferred.

Also out of scope: any change to browser/memory adapters (they do not carry this
node-specific canonicalisation), and Lever B (the closure hoist) unless the
re-profile motivates it (DC-2).

## Decision candidates

Every load-bearing choice below is left for the ADR/decisions gate; the
recommendation is stated but not self-ratified.

### DC-1 — Scope: `checkContainment` only, vs widen to other findings

- **Option A (recommended):** fix the settled-await microtask at **all three
  sites that share the `normalizedCanonicalRoot` sentinel** — `checkContainment`,
  its inline twin `exists`, and `symlink`'s absolute-target branch — **only** this
  run; findings (2) TREESAME, (3) exists/lstat *batching*, (4) tree walk/parse
  become separate follow-up backlog entries. All three sites are the *same* lever
  (one guarded-await edit each), so gating all three is one coherent change, not
  scope creep; leaving one un-gated would be an inconsistency. Matches the user's
  explicit scoping instruction and keeps the PR a tight, provably
  behaviour-preserving refactor.
- **Option B:** widen to include finding (3) exists/lstat batching now, since
  Lever A already touches `exists`. Rejected as recommendation: batching is a
  syscall-count change (different risk surface, different pins) versus this PR's
  microtask/alloc-only change.
- **Recommendation: Option A.**

### DC-2 — Approach: Lever A only, vs Lever A + Lever B

- **Option A (recommended):** **Lever A only** — gate the settled-promise await
  at all three sites (`checkContainment` L760, `exists` L462, `symlink` L567).
  Captures the dominant win (guaranteed microtask off the busiest frame) with a
  single guarded-`await` edit per site, no signature churn, minimal
  mutation-surface disturbance.
- **Option B:** **Lever A + Lever B** — additionally hoist the per-call `check`
  closure to an instance predicate, rebinding `resolveForMode`'s callback
  contract. More alloc saved, but reshapes an internal method signature + two arms
  for a sub-microtask gain and risks the closure-related mutation coverage.
- **Option C:** Lever A + B + reconsider C (memoisation) — **rejected outright**;
  C is TOCTOU-unfaithful and targets the wrong frame.
- **Recommendation: Option A.** Ship Lever A; re-profile; open Lever B as a
  follow-up only if allocation still dominates `checkContainment` self-share.

### DC-3 — Baseline: regenerate + commit `docs/perf/baseline.json` in this PR, vs leave as before-reference

- **Option A (recommended):** regenerate and **commit** the updated
  `docs/perf/baseline.{json,md}` reflecting the post-optimisation shares; quote
  before/after in the PR body. ADR-475 established the committed baseline as the
  moving optimisation reference the 26.5 CI gate diffs against; 26.4 spends that
  license, so the artifact should advance.
- **Option B:** leave the committed baseline as the immutable "before" snapshot;
  record the after-numbers only in the PR body. Keeps a historical anchor but
  leaves the committed reference describing a surface the code no longer has,
  and de-syncs the 26.5 gate's baseline.
- **Recommendation: Option A** (commit the improved baseline; `generatedOn`
  banner remains metadata-only per ADR-475).

### DC-4 — Formal ADR file, or design doc + decision-candidates only

- **Option A (recommended):** **No standalone ADR** for the implementation
  itself — this is a behaviour-preserving internal FS-adapter refactor with no
  divergence from git and no new public contract; the design doc + these decision
  candidates suffice as the record. *If* the decisions gate ratifies DC-3
  (committing an updated baseline) as a policy-bearing choice, capture **that**
  one decision as a short ADR (it changes a committed, gate-consumed artifact),
  mirroring how ADR-475 recorded the baseline policy — but the code change needs
  none.
- **Option B:** write a full ADR covering the await-gate rationale and the
  equivalent-mutant acceptance. Heavier than the change warrants; the design doc
  already carries the correctness argument and the mutant analysis.
- **Recommendation: Option A** — design doc + decision candidates for the
  refactor; a one-paragraph ADR only if DC-3's baseline-commit is deemed
  policy-bearing at the gate.
