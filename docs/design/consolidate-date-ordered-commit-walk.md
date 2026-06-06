# Design — consolidate the date-ordered commit walk

## Goal

Resolve backlog **23.4l**: `describe` still carries a bespoke date-ordered
scoreboard walk, structurally distinct from the `walkCommitsByDate` primitive
(23.4b). With the third date-walk consumer now landed (the 23.4j-converged `log`
projects over `walkCommitsByDate`), re-evaluate whether `describe`'s walk should
fold onto a shared traversal — and either do it or record why not.

## Current state — two date-walk implementations

The **ordering substrate** is already shared: `domain/commit/priority-queue.ts`
(`precedes` = committer-date desc, oid-asc tie-break; sorted `enqueue`;
`QueueEntry<T>`) was consolidated in 23.3a (ADR-259). What remains duplicated is
the **walk-loop shell** around it — the seen-gated, eager-read-at-enqueue,
pop-then-discover-parents traversal:

| | `walkCommitsByDate` (primitive) | `describe`'s `selectNearest` |
|---|---|---|
| Queue | `QueueEntry<Commit>` (carries loaded commit) | `QueueEntry<undefined>` + a side `makeCommitReader` cache |
| Read | shared `readCommit` (lenient, `ignoreMissing`/`verifyHash`) | bespoke `toWalkCommit` → `{date, parents}` |
| Frontier bound | `seen`-gated enqueue | `seen`-gated enqueue |
| Parents | **all** parents | **all OR first-parent** (`plan.firstParent`) |
| Boundary | `until` / `shallow` | none |
| Yield shape | `AsyncIterable<Commit>` | inline loop, no yield |
| Extra work | none | candidate collection, `reach` map, depth bookkeeping, candidate **cap** + two-phase `finishDepth` |

The two loops rhyme but are not identical. The structural divergences that
matter:

1. **`describe` needs first-parent**, which `walkCommitsByDate` does **not**
   offer — `log --first-parent` deliberately routes through `walkCommits`'s lazy
   FIFO, not `walkCommitsByDate`. So `walkCommitsByDate` has *no* first-parent
   path and *no* first-parent consumer today.
2. **`describe` interleaves bookkeeping with the traversal**: a candidate's depth
   increments at each pop (`incrementUnreached`), and a candidate's reachability
   spreads to parents during parent enumeration (`enqueueParents`'s reach half).
   The reach set must propagate over **exactly** the parents the walk visits, so
   reach-propagation and the walk's parent selection must stay in lockstep.
3. **`describe` caps** the candidate set, then runs a second `finishDepth` pass to
   finalise the winner's depth — a two-phase `break`/re-enqueue dance the streaming
   `walkCommitsByDate` has no analogue for.

## The duplication is genuine but the traversal *is* separable

ADR-259 already proved the substrate is separable (the comparator + sorted insert
came out cleanly). The remaining shared part — *the queue/seen/eager-read/pop/
parent-discovery loop* — is generic mechanism; the *candidate/reach/depth/cap*
bookkeeping is `describe`-specific policy. They are two concerns currently fused
in one function. Separating them is a textbook SoC improvement, continuing the
ADR-259 → ADR-261 trajectory of pulling commit-walk substrate out of commands.

The single obstacle to a clean fold is that `walkCommitsByDate` is a **public
Tier-2 primitive** with a frozen-ish options shape, and `describe` needs
**first-parent** — a capability no public consumer wants. Adding `firstParent` to
the *public* `WalkCommitsByDateOptions` to serve one *internal* caller is exactly
the over-design the project guards against (ADR-260/274 ethos: no public surface
for a single, internal need).

## Options

### A — `describe` consumes the public `walkCommitsByDate`, add public `firstParent`

Give `WalkCommitsByDateOptions` a `firstParent` field; `describe` drives the
primitive as an iterable.

- **+** No new module; one public date-walk entry point.
- **−** Widens public `api.json` with a `firstParent` option whose *only*
  consumer is internal `describe` — speculative public surface (YAGNI / ADR-274).
- **−** Reach-propagation in `describe` must re-derive the first-parent slice to
  match the primitive's internal parent selection → a new lockstep duplication.

### B — Extract an **internal** date-walk core; both build on it *(recommended)*

New internal `primitives/internal/<commit-date-walk>.ts` owning the generic loop
(queue/seen/eager-read/pop/parent-discovery), parameterised by an internal
`firstParent` flag, exporting the generator **and** the `selectParents(commit,
firstParent)` helper. Then:

- `walkCommitsByDate` (public primitive) = seed-validation (`INVALID_WALK_INPUT`
  contract, kept in the wrapper) + delegate to the core with all-parents. Public
  shape **unchanged** → `api.json` unchanged.
- `describe.selectNearest` = `for await` over the core with `firstParent:
  plan.firstParent`, layering its bookkeeping; reach-propagation reuses the
  **same** exported `selectParents`, so no lockstep duplication is possible.

- **+** One walk loop in the codebase; `firstParent` stays **internal** (no
  public widening).
- **+** `describe` **sheds** `makeCommitReader`, `toWalkCommit`, `WalkCommit`,
  `WalkState`, the manual `enqueue`/`shift`, *and* `finishDepth` (the cap’s
  two-phase dance collapses to single-pass consumption — see below).
- **+** Reach/parent selection has a single source of truth (`selectParents`).
- **−** One new internal module + a thin wrapper (rule-of-two, but that *is* the
  consolidation 23.4l asks for, and the core is internal, not speculative public
  surface).

### C — Weigh and decline (à la 23.4k)

Keep `describe`'s bespoke loop; record that the substrate is already shared
(ADR-259) and the loop shells are "only" rule-of-two, with `describe`'s being
entangled enough that extraction isn't worth the indirection.

- **+** Zero churn; `describe` stays a single self-consistent algorithm.
- **−** Leaves two date-walk loops indefinitely; contradicts the *integrate,
  don't defer* default once a clean, behaviour-preserving fold exists. The fold
  in B is a **net simplification** (it removes more than it adds), so "decline"
  here would be declining an improvement, not avoiding over-design.

## Recommendation — Option B

A clean, behaviour-preserving consolidation exists that **reduces** `describe`'s
complexity while unifying the loop, and it keeps `firstParent` off the public
surface. That tips the *integrate-don't-defer* balance toward doing it. (This is
the opposite reading from 23.4k, which declined because the convergence proved
the accessors *unneeded*; here the third consumer validated the shared walk and a
fold genuinely simplifies the holdout.)

The fold-vs-decline call, and the *where does `firstParent` live* call, are
load-bearing and go to the user as an ADR before implementation.

## Design of the recommended approach (B)

### Internal core — `primitives/internal/commit-date-walk.ts`

```ts
export const selectParents = (
  commit: Commit,
  firstParent: boolean,
): ReadonlyArray<ObjectId> =>
  firstParent ? commit.data.parents.slice(0, 1) : commit.data.parents;

export interface CommitDateWalkOptions {
  readonly from: ReadonlyArray<ObjectId>;
  readonly until?: ReadonlyArray<ObjectId>;
  readonly shallow?: ReadonlySet<ObjectId>;
  readonly firstParent?: boolean;
  readonly ignoreMissing?: boolean;
  readonly verifyHash?: boolean;
}

// Generic date-priority traversal. No seed validation (the public wrapper owns
// that contract); seeds are assumed already resolved. Yields each reachable
// commit once, newest committer-date first, via the shared priority queue.
export async function* commitDateWalk(
  ctx: Context,
  options: CommitDateWalkOptions,
): AsyncIterable<Commit> { /* queue/seen/until/read + pop loop + selectParents */ }
```

The body is `walkCommitsByDate`'s current loop verbatim, minus the seed
assertion, plus `selectParents(commit, firstParent)` at the parent-enqueue step.
The abort check (`ctx.signal?.aborted`) is kept — `describe` gains abort support
for free (harmless, strictly additive to its behaviour).

### Public primitive — `walkCommitsByDate` becomes a thin wrapper

```ts
export async function* walkCommitsByDate(ctx, options: WalkCommitsByDateOptions) {
  assertValidSeeds(options.from);          // unchanged public contract
  yield* commitDateWalk(ctx, options);     // firstParent omitted → all-parents
}
```

`WalkCommitsByDateOptions` is **unchanged** (no `firstParent`). `api.json`
unchanged. `log` and every other consumer are untouched.

### `describe.selectNearest` — single-pass consumer

The cap’s two phases collapse because the candidate set is **final the moment the
cap is hit** (no further candidates are added), so the winner can be chosen there
and the remaining commits stream straight into depth-finishing:

```
best = undefined
for await (commit of commitDateWalk(ctx, { from: [target], firstParent })):
  oid = commit.id
  if best === undefined:                       // collecting
    counter += 1
    named = nameMap.get(oid)
    if named && named.priority >= minPriority:
      if candidates.length >= maxCandidates:    // cap hit at this commit
        best = [...candidates].sort(compareCandidates)[0]
        bumpBestDepth(best, oid); propagateReach(commit)   // == old finishDepth seed
        continue
      candidates.push({ name, commitOid: oid, depth: counter-1, foundOrder })
      reachSet(oid).add(foundOrder)
    else if named: sawUnannotated = true
    incrementUnreached(candidates, reach.get(oid))
    propagateReach(commit)
  else:                                         // finishing winner's depth
    bumpBestDepth(best, oid); propagateReach(commit)
if best === undefined: best = [...candidates].sort(compareCandidates)[0]  // ≤ cap path
```

`propagateReach(commit)` iterates `selectParents(commit, plan.firstParent)` —
the **same** helper the core walks with — spreading `reach.get(oid)` to each
parent's reach set. `bumpBestDepth(best, oid)` is `incrementUnreached([best],
reach.get(oid))` (increment `best.depth` iff `oid` cannot reach `best`).

**Deleted from `describe.ts`:** `WalkCommit`, `WalkState`, `makeCommitReader`,
`toWalkCommit`, `finishDepth`, and the manual `enqueue`/`shift`/`seen` plumbing.
**Kept:** `candidates`, `reach`, `reachSet`, `incrementUnreached`,
`compareCandidates`, the cap, the sort — all `describe`-specific policy.

### Equivalence argument (why this is byte-for-byte faithful)

Pop order is identical: same `precedes` comparator, same `seen`-gating, same
parent selection (now shared via `selectParents`). The two-phase ↔ single-pass
rewrite preserves the exact depth accounting:

- Pre-cap commits get the same `counter`/candidate-push/`incrementUnreached`/
  reach treatment as old phase 1.
- The cap-hit commit (`gaveUp`) is processed exactly as old `finishDepth`'s seed:
  not pushed, not run through `incrementUnreached`, but counted toward `best.depth`
  and its reach propagated — then the core enqueues its parents on resume (old
  `finishDepth` re-enqueued it explicitly; same queue, same order).
- Post-cap commits get `bumpBestDepth` + reach propagation == old phase 2.
- The no-cap path sorts after the loop with `gaveUp` unset == old fall-through.

The result is robust to the one place the two schemes *do* differ — old
`finishDepth` re-enqueues `gaveUp` to compete by date, the single pass processes
it immediately. `describe`'s output is an **order-independent aggregate**:
`best.depth` is a *sum* over the phase-2 commits that cannot reach the winner
(re-ordering the terms cannot change the total), and `reach` sets are
monotonic and complete for any commit before it is popped (in a causal
date-order walk every child precedes its parent). `describe` never exposes a
commit *stream*, so the literal pop order — including any equal-date tie — is
invisible to `DescribeResult`. (`log`, which *does* expose order, drives
`walkCommitsByDate` unchanged, so its order is untouched.)

This is asserted by keeping every existing `describe` test green: the unit suite
(`describe.test.ts`), the cross-tool `describe-interop.test.ts` (reconstructed
`git describe` line: name, distance, exact, first-parent, candidate cap), and the
parity scenario — none change. `walkCommitsByDate`'s own unit + `history-interop`
+ `log-interop` suites also stay green unchanged (its behaviour is identical).

## Testing & mutation

- **No behaviour change** → existing tests are the oracle; they stay green and
  unmodified (only describe's internals move).
- New internal `commit-date-walk.ts` is exercised transitively by both
  `walkCommitsByDate`'s suite (all-parents path) and `describe`'s suite
  (first-parent path + boundary-free path). A focused unit test on the core is
  added only if mutation reveals a gap the two consumers' suites don't cover
  (e.g. the `selectParents` first-parent slice in isolation, the `shallow`
  boundary which only `walkCommitsByDate` drives).
- **Mutation target 0 survivors** on every touched file. `describe.ts` currently
  carries four `// Stryker disable` equivalent-mutant annotations on its bespoke
  walk; several (the `seen`-seed, the re-enqueue guard) **disappear with the
  deleted code** — a suppression reduction. Any survivor on the core is killed by
  the order-sensitive describe/log tests or a focused unit test, never a new
  suppression.
- No property-test obligation: the touched code is a traversal/aggregator, not a
  parse/serialize pair; the priority queue already has
  `priority-queue.properties.test.ts`. If mutation shows the core's frontier
  invariants are under-pinned, a composition-style property (case 2) is the
  fallback before any suppression.

## Faithfulness & invariants

- Git-observable behaviour unchanged: no SHA, ref, reflog, on-disk state,
  refusal, or structured-output change. `describe` returns the identical
  `DescribeResult`; `walkCommitsByDate` yields the identical stream.
- `api.json` unchanged — the core is internal (relative-import only, off every
  barrel), `firstParent` stays out of the public options type.
- Hexagonal layering preserved: the core is an application-tier internal
  primitive beside `read-commit.ts`/`peel.ts`; it imports only `domain/*` +
  `ports/context` + `readObject`, exactly like its siblings.

## Out of scope / follow-ups

- Promoting `firstParent` to the **public** `walkCommitsByDate` if a real public
  consumer (e.g. a future `shortlog --first-parent`) appears — additive, deferred
  until demanded (YAGNI).
- A strict `--date-order` mode (forged reverse-causal dates) remains deferred per
  ADR-261; this consolidation does not touch the lazy-vs-strict scope.
