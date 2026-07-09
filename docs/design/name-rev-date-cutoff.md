# Design — `name-rev` date cutoff (26.4b)

> Extends `design/name-rev.md` §2.6 (deferred "the date cutoff (perf only,
> observationally inert)"). This doc covers **only** the cutoff; the flood-walk
> algorithm, selection comparator, ref filtering, and output shape are unchanged
> and already pinned by ADRs 283–285 and `name-rev-interop`.

## Problem

`nameRev` (`src/application/commands/name-rev.ts`) floods the **entire** ancestry
of every qualifying ref via a reverse-reachability walk down parents (`walkRef` →
`expandParents`), keeping the best name for each commit reached. On a deep history
with many refs this reads every reachable commit from every ref — O(N) per ref.

Canonical `git name-rev` prunes each walk at a **date cutoff**: a commit older
than every named target (minus a one-day slop) can never *be* a target and can
never improve the target's name, so descending into it is wasted work. Adding the
cutoff changes **only how many commits are read**, never the returned
`NameRevResult` — this is **pure perf**, pinned by the existing byte-identical
`name-rev-interop` suite plus a new `bench:summary` delta.

Verified against `builtin/name-rev.c` at git **v2.55.0** (the locally installed
interop peer) — source quoted below, semantics probed against the real binary in
a throwaway repo (matrix in §3).

## 1. Git's cutoff (v2.55.0, `builtin/name-rev.c`)

### 1.1 The pinned source

```c
#define CUTOFF_DATE_SLOP 86400   /* one day, in seconds */

static timestamp_t generation_cutoff = GENERATION_NUMBER_INFINITY;
static timestamp_t cutoff = TIME_MAX;

static void set_commit_cutoff(struct commit *commit)
{
	if (cutoff > commit->date)
		cutoff = commit->date;

	if (generation_cutoff) {
		timestamp_t generation = commit_graph_generation(commit);
		if (generation_cutoff > generation)
			generation_cutoff = generation;
	}
}

static void adjust_cutoff_timestamp_for_slop(void)
{
	if (cutoff) {
		/* check for underflow */
		if (cutoff > TIME_MIN + CUTOFF_DATE_SLOP)
			cutoff = cutoff - CUTOFF_DATE_SLOP;
		else
			cutoff = TIME_MIN;
	}
}

static int commit_is_before_cutoff(struct commit *commit)
{
	if (generation_cutoff < GENERATION_NUMBER_INFINITY)
		return generation_cutoff &&
			commit_graph_generation(commit) < generation_cutoff;
	return commit->date < cutoff;
}
```

`name_rev()` consults it in exactly two places — at the **seed tip** and at each
**parent** before descending:

```c
static void name_rev(struct commit *start_commit, ...)
{
	repo_parse_commit(the_repository, start_commit);
	if (commit_is_before_cutoff(start_commit))
		return;                       /* seed tip pruned: ref names nothing */
	/* ... record name for start_commit ... */
	/* for each parent: */
		repo_parse_commit(the_repository, parent);
		if (commit_is_before_cutoff(parent))
			continue;                 /* parent pruned: do not descend */
}
```

`cmd_name_rev()` finalises the cutoff **before any ref walk begins**:

```c
for (; argc; argc--, argv++) {          /* over the targets to be named */
	/* ... resolve oid → commit ... */
	if (commit)
		set_commit_cutoff(commit);
	add_object_array(object, *argv, &revs);
}
adjust_cutoff_timestamp_for_slop();     /* cutoff = min(targetDate) - 86400 */
refs_for_each_ref(..., name_ref, &data);/* only now: the flood walk over refs */
name_tips(&string_pool);
```

### 1.2 What this means for tsgit

Three load-bearing facts, all pinned in §3:

1. **The cutoff is derived from the TARGET commits, not the refs.** git names any
   number of targets in one run and takes `cutoff = min(targetDate) − 1 day`.
   tsgit's `nameRev` names exactly **one** commit (`target = resolveCommit(...)`),
   so the cutoff is simply `targetCommitDate − 86400`, computed **once, before**
   the ref loop in `nameRev`.

2. **The comparison is strict `<`.** `commit->date < cutoff` prunes; a commit
   *at* the cutoff survives. Equal-dated commits are never pruned relative to
   each other by this test.

3. **The generation-number branch is irrelevant to tsgit.** When a commit-graph
   is present git prunes on `commit_graph_generation` instead of raw date.
   tsgit has **no commit-graph** (`generation_cutoff` stays
   `GENERATION_NUMBER_INFINITY`), so `commit_is_before_cutoff` always takes the
   `commit->date < cutoff` branch. We reproduce the **date** path only; omitting
   the generation path is faithful because tsgit never populates a generation
   number (there is no observable divergence — see §5). This is recorded as a
   scoped divergence, not a gap.

### 1.3 Why pruning is observationally inert

The result is the `NameRevResult` for the **target** commit. Two invariants make
every pruned commit irrelevant to it:

- **The target is never pruned.** `cutoff = targetDate − 86400 < targetDate`, so
  `commit_is_before_cutoff(target) = (targetDate < cutoff) = false`. The target's
  name is always computed and recorded — it is never a commit the guard skips.
- **A pruned commit is never read into `revNames`, and the target's name is read
  only from `revNames.get(target)`.** A commit older than `cutoff` (whether a
  seed tip or a walked parent) is dropped before it can write any slot. It cannot
  *be* the target (invariant above), and because it is dropped it can never
  record or improve a name for **any** commit — including the target. Whether git
  descends into it or not, `revNames.get(target)` is identical. The seed-tip case
  is the same claim at the ref boundary: a ref whose peeled tip is below the
  cutoff seeds nothing, so it contributes no name anywhere.

**The slop is the correctness margin, not a heuristic.** Naively the boundary
could be `targetDate` itself — a commit strictly older than the target can never
*be* the target. git widens it by one day (`CUTOFF_DATE_SLOP`) to tolerate
**clock skew**: a commit that is a genuine descendant-or-self path to the target
but carries a slightly *earlier-than-expected* committer date (skewed clock) must
not be pruned. The slop guarantees any commit within a day of the target's date
survives, so no reachable naming path is lost even on skewed histories. tsgit
keeps the identical `86400` slop and the identical strict-`<` boundary, so the
prune set — and therefore the output — is byte-identical to git, skew included.
(The interop suite, which pins output against real git, is the proof this holds;
the argument here is the *why*, not the pin.)

## 2. Current tsgit shape (pre-chewed context)

**Files touched (candidate — see §6 decision 1 for where the guard lives):**

- `src/application/commands/name-rev.ts` — the walk. Current signatures:
  - `nameRev(ctx: Context, rev?: string, opts?: NameRevOptions): Promise<NameRevResult>`
    — resolves `target: ObjectId`, builds the ref filter, sorts refs, then
    `for (const ref of refs) await walkRef(ctx, ref, revNames)`. **This is where
    the cutoff is computed** (once, from the target commit's date, before the
    ref loop) and threaded into the walk.
  - `walkRef(ctx, ref, revNames): Promise<void>` — seeds via `seedRef`, LIFO
    stack, pops and calls `expandParents`.
  - `seedRef(ctx, ref, revNames): Promise<Commit | undefined>` — peels the ref,
    builds the seed `RevName`, `accept`s it. **Cutoff seed-tip guard site**
    (git's `commit_is_before_cutoff(start_commit) → return`): a tip commit below
    cutoff is not seeded.
  - `expandParents(ctx, commit, name, revNames): Promise<Commit[]>` — the loop
    over `commit.data.parents`; reads each parent via `readObject`, `accept`s the
    candidate. **Cutoff parent guard site** (git's
    `commit_is_before_cutoff(parent) → continue`): a parent below cutoff is not
    queued.
  - `accept(revNames, oid, candidate): boolean` — unchanged.
- `src/domain/objects/commit.ts` — `Commit.data.committer: AuthorIdentity`;
  `AuthorIdentity.timestamp: number` (`src/domain/objects/author-identity.ts`,
  epoch seconds, `Number.isSafeInteger`-validated). **The commit date is
  `commit.data.committer.timestamp`** — the same field `seedRef` already reads
  for `taggerDate` fallback. git's `commit->date` is the committer timestamp, so
  no new accessor and no annotated-tag tagger date enters the cutoff (see §4).

**The target's date.** `nameRev` resolves `target: ObjectId` via
`resolveCommit`, which peels tags to a commit oid but returns only the oid. To
compute the cutoff the target **commit object** is needed for its committer
timestamp. Two shapes (§6 decision 2): read the target commit once up front, or
fold the date-fetch into resolution. Either way the cutoff is
`targetCommit.data.committer.timestamp − CUTOFF_DATE_SLOP` with the underflow
guard (§4).

**Domain vs command.** The cutoff *predicate* (`commit_is_before_cutoff`) is a
pure function of `(commitDate, cutoff)` and belongs in `domain/name-rev/`
alongside the other pure helpers; the *cutoff value* (min over the single target,
minus slop, underflow-guarded) is a pure arithmetic function too. The
command-layer walk calls them. See §6 decision 1.

## 3. Empirically pinned matrix (git v2.55.0, throwaway repo, signing off)

All rows probed in a `mktemp -d` repo with `GIT_*` scrubbed, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, `commit.gpgsign=false`, deterministic `GIT_*_DATE`. The
output column is `git name-rev --name-only <sha>`; the "walk" column is the
observable claim the bench pins (not stdout).

| # | History | Query | `cutoff` | Output | Inert claim (pinned) |
|---|---------|-------|----------|--------|----------------------|
| 1 | linear c0(1e9) → c1 → c2(+120), annotated `rel` on c2 | c0 | date(c0)−86400 | `tags/rel~2` | c0 is the target ⇒ its own cutoff ⇒ full walk; naming still `rel~2` |
| 2 | same | c2 (tip) | date(c2)−86400 | `tags/rel^0` | — |
| 3 | c0(1e9) c1(1000200000) c2 c3, tag `rel` on c3 | c1 | 1000200000−86400 = 1000113600 | `tags/rel~2` | date(c0)=1e9 < cutoff ⇒ **c0 pruned**; output `rel~2` unchanged whether c0 walked or not |
| 4 | same | c0 | date(c0)−86400 | `tags/rel~3` | querying the old commit uses ITS date ⇒ nothing pruned ⇒ `rel~3` |
| 5 | `oldtag`→old(1e9), `newtag`→new(1000500000) | new | 1000500000−86400 = 1000413600 | `tags/newtag^0` | date(old)=1e9 < cutoff ⇒ **oldtag's seed tip pruned** (`commit_is_before_cutoff(start_commit)`); `newtag^0` unchanged |
| 6 | same | new, `--tags` | same | `newtag^0` | oldtag pruned at seed; irrelevant to the newer target either way |

Row 3 is the canonical inert-perf demonstration: the ancestor `c0`, older than
`c1 − 1 day`, is dropped from the walk yet the named commit `c1` still resolves to
`tags/rel~2`. Row 5 pins the **seed-tip** early-return (a ref whose tip is older
than the target − 1 day is never seeded). Row 4 shows the cutoff is target-derived
(same history, different query ⇒ different cutoff ⇒ different amount walked, same
correctness).

Each row becomes (or is already covered by) an assertion in
`test/integration/name-rev-interop.test.ts` reconstructing `git name-rev` from
the structured `NameRevResult` — the output column must stay byte-identical after
the change.

## 4. Cutoff arithmetic (the underflow guard)

`CUTOFF_DATE_SLOP = 86400`. git's guard:

```
if (cutoff > TIME_MIN + CUTOFF_DATE_SLOP)  cutoff = cutoff - CUTOFF_DATE_SLOP
else                                        cutoff = TIME_MIN
```

TypeScript representation: `timestamp` is a JS `number` (epoch seconds,
`Number.isSafeInteger`-validated on parse). tsgit has no `TIME_MIN`/`TIME_MAX`
sentinels; the faithful mapping is:

- **Seed:** the single target's committer timestamp `t`.
- **Slop + guard:** `cutoff = t - 86400`. The underflow guard matters only when
  `t` is within one day of the minimum representable timestamp — i.e. a commit
  dated at/near epoch-`Number.MIN_SAFE_INTEGER`, which cannot occur for a
  git-parsed committer date (git rejects timestamps outside a sane range;
  `AuthorIdentity` requires `Number.isSafeInteger`). A negative/near-floor date
  is unreachable in a real repo, but the guard is still transcribed for
  faithfulness rather than assumed-away — the design keeps
  `cutoff = t - 86400` with an explicit floor clamp mirroring git's `else`
  branch, so a crafted floor-dated target does not underflow into a wrong-signed
  cutoff (decision 3 weighs how literally to transcribe `TIME_MIN`).
- **`if (cutoff)` outer guard:** git skips the slop subtraction when `cutoff == 0`
  (a target dated exactly at the Unix epoch). tsgit mirrors this: a target dated
  `0` keeps `cutoff = 0`, so only strictly-negative-dated commits (impossible)
  would prune. This is a one-line faithful transcription, isolated-tested.

**Which date.** git's `commit->date` is the **committer** timestamp of the
dereferenced target commit — **not** an annotated tag's tagger date. If the query
resolves through an annotated tag, `resolveCommit` already peels to the commit;
the cutoff uses that **commit's committer timestamp**. This is distinct from the
selection tie-break `taggerDate` (which *does* use the tagger date). The cutoff
never touches tagger dates. Pinned by §3 rows (the tags in the fixtures are
annotated; the cutoff is still the commit date, confirmed by the observed
prune boundaries).

## 5. Faithfulness invariants (prime directive)

- **Output byte-identical.** Every `name-rev-interop` reconstruction (§3, plus the
  existing annotated `^0` / lightweight / branch / `~n` / `~m^2~k` / `undefined`
  cases) stays green and **unchanged in expectations**. This is the sole
  faithfulness proof (parity is cross-adapter only).
- **Pruning boundary matches git.** Strict `<`, one-day slop, target-derived
  cutoff, seed-tip and parent guards at git's two call sites — reproduced exactly.
- **Generation-number path omitted, faithfully.** tsgit has no commit-graph;
  `commit_is_before_cutoff` always takes the date branch. Omitting the
  generation branch produces identical output because tsgit never has a
  generation number to prune on. Recorded as a scoped, output-inert divergence
  (ADR territory — decision 4).
- **No API surface change.** No new option, no new result field, no `api.json`
  churn (§7). The cutoff is an internal walk optimisation.

## 6. Decision candidates

### Decision 1 — Where the cutoff predicate lives (domain vs command)

The pure predicate `commitIsBeforeCutoff(commitDate, cutoff)` and the cutoff
computation `nameRevCutoff(targetDate)` (min-over-single-target − slop, guarded)
are pure functions.

- **(A) New pure helpers in `domain/name-rev/` (`cutoff.ts`), exported from the
  internal barrel; the command walk calls them.** Mirrors the existing
  `is-better-name` / `step` / `ref-pattern` split (pure decisions in domain,
  I/O orchestration in the command). Isolated unit + property surface, 100%
  mutation-testable without I/O.
- (B) Inline the two comparisons and the arithmetic directly in `name-rev.ts`
  (`seedRef` + `expandParents`). Fewer files, but buries a faithfulness-load-
  bearing constant (`86400`, strict `<`, the guard) inside the walk where the
  mutation surface mixes I/O and pure logic, and diverges from the established
  domain/command split for this exact feature.
- (C) Put the predicate in the shared `peelRefToCommit` primitive. Wrong layer —
  peeling has nothing to do with the naming cutoff, and it is shared with
  `describe`, which has its own (different) cutoff story (26.4a).

**Recommendation: (A).** Consistent with `design/name-rev.md` §5's module layout
(pure decisions in `domain/name-rev/`); keeps the constant and the strict-`<`
boundary in a 100%-mutation-clean pure unit with a property test
(monotone-threshold predicate).

### Decision 2 — How the target's commit date is obtained

`nameRev` currently holds only `target: ObjectId` (from `resolveCommit`), not the
commit object.

- **(A) Read the target commit once at the top of `nameRev`
  (`readObject(ctx, target)`), take `data.committer.timestamp`, compute the
  cutoff, then run the existing walk.** One extra object read per `nameRev` call
  (the target is almost always also reached by the walk and cached). Localised,
  explicit, no signature change to `resolveCommit`. Because `resolveCommit` peels
  to `'commit'` (`resolve-rev.ts` → `peel(ctx, …, 'commit')`) and refuses
  otherwise, `readObject(ctx, target)` is **guaranteed** to return a `commit`
  object — no `type === 'commit'` guard (which would be an untestable dead branch)
  is needed; read `data.committer.timestamp` directly.
- (B) Extend `resolveCommit` to return `{ oid, commit }`. Wider blast radius —
  `resolveCommit` is shared by many commands; changing its return shape for one
  caller's convenience is feature envy.
- (C) Reuse the `revNames` map: run the walk first, then read the target's date
  from a walked commit. Circular — the cutoff must be known *before* the walk to
  prune it.

**Recommendation: (A).** One up-front `readObject`; the target commit is on the
hot path anyway. `resolveCommit` stays untouched.

### Decision 3 — Underflow-guard transcription fidelity

git guards `cutoff -= SLOP` against `TIME_MIN` underflow.

- **(A) Transcribe the guard as an explicit clamp:
  `cutoff = t > FLOOR + SLOP ? t - SLOP : FLOOR` with `FLOOR =
  Number.MIN_SAFE_INTEGER` (tsgit's representable floor), plus the `if (cutoff)`
  epoch-zero skip.** Faithful to git's control flow; the guard branch is
  isolated-tested even though a real repo can't reach it (documented as a
  faithfulness transcription, not dead code — it *is* reachable for a crafted
  floor-dated in-memory commit the memory adapter can hold).
- (B) Drop the guard (`cutoff = t - 86400` unconditionally). Simpler, and a
  real git committer date can never underflow a JS `number`. But it diverges
  from git's transcribed control flow and leaves a latent wrong-sign cutoff for a
  crafted floor-dated commit — a silent faithfulness gap the review pass would
  flag.
- (C) Represent timestamps as `BigInt` to match git's `timestamp_t` width. Over-
  engineered; `AuthorIdentity.timestamp` is `number` everywhere and the safe-
  integer bound already covers every real committer date.

**Recommendation: (A).** Keep git's guard structure so the pruning arithmetic is
faithful even at the representable edge, with the guard branch reachable via a
crafted memory-adapter commit (so it is testable, not suppressed). Confirm the
exact `TIME_MIN` mapping against git during implementation and pin the epoch-zero
and floor cases as isolated unit tests.

### Decision 4 — ADR for the generation-number omission?

git prunes on commit-graph generation numbers when available; tsgit has none.

- **(A) A short ADR recording the scoped, output-inert omission of the
  generation-number branch** (like ADR-276 recorded describe's inert breaks).
  Documents *why* reproducing only the date branch is faithful, for the next
  reader who diffs `name-rev.c` against tsgit.
- (B) A note in this design doc only (§1.2 / §5), no ADR. Lighter; the omission
  is genuinely unobservable (no commit-graph ⇒ no generation number to prune on).
- (C) Implement a generation-number cutoff too. Pointless — tsgit has no
  commit-graph subsystem; there is nothing to compute a generation from.

**Recommendation: (B), unless the ADR conversation prefers a paper trail.** The
omission is inert and self-evidently so once the commit-graph absence is stated;
§1.2 and §5 already record it. Escalate to (A) only if the decisions phase wants
the divergence formally ADR-logged for symmetry with 26.4a's ADR-460. **This is a
user decision, not the designer's.**

### Decision 5 — Bench methodology

The backlog requires a `bench:summary` delta demonstrating the win.

- **(A) New `test/bench/name-rev.bench.ts` mirroring `describe.bench.ts`: reuse
  `resolveScaledContext` / `scaledScenario`, place an annotated tag N commits
  below the deep-fixture tip, query a commit near the tip, and benchmark
  `repo.nameRev()`.** With the cutoff the walk touches O(distance) of each ref's
  ancestry instead of O(N); the summary delta is the recorded evidence. Same
  fixture family and skip-in-Stryker guard as `describe.bench.ts`.
- (B) Add a `name-rev` scenario to an existing bench file. Muddies an existing
  file's Given/When; the describe precedent is one bench file per command.
- (C) Micro-bench the pure predicate only. Measures nothing observable — the win
  is fewer object reads across the whole walk, not predicate speed.

**Recommendation: (A).** Directly mirrors 26.4a's `describe.bench.ts`; one bench
file, scaled fixture, `bench:summary` delta as the perf pin. Also add
**read-count unit assertions** (a counting spy over the object reader, as
26.4a's plan did) so the O(distance) claim is pinned deterministically, not only
by the noisy bench.

## 7. Test plan

### Unit (example, GWT/AAA, `sut`, 100% coverage, 0 surviving mutants)

- `domain/name-rev/cutoff.ts` (decision 1A):
  - `commitIsBeforeCutoff(date, cutoff)` — strict `<`: below prunes; **at** cutoff
    survives (isolated boundary test — kills the `<`→`<=` mutant); above survives.
  - `nameRevCutoff(targetDate)` — `t - 86400`; epoch-zero (`t === 0`) keeps `0`
    (the `if (cutoff)` skip, isolated); floor-dated target clamps to the floor
    (the underflow `else` branch, isolated via a crafted value). Each guard its
    own test (magic-value and off-by-one mutants killed by asserting the numeric
    result, not just a boolean).
- `name-rev.ts` walk integration (memory adapter, counting reader spy):
  - a deep linear chain with a tag near the tip: querying near the tip reads
    O(distance) commits, **not** the whole chain (read-count assertion; kills a
    dropped-parent-guard mutant);
  - querying the **oldest** commit reads the full chain (its own cutoff prunes
    nothing) — proves the cutoff is target-derived (decision 2A);
  - a ref whose tip is older than `target − 1 day` is **never seeded** (the tip's
    name is absent from `revNames`), matching git's `commit_is_before_cutoff(
    start_commit) → return` (kills a dropped-seed-guard mutant);
  - a commit exactly one day older than the target (`date === cutoff`) is **still
    walked** (strict `<` boundary at the walk level).

### Property (`*.properties.test.ts`, per CLAUDE.md lens 3 — total function over a grammar)

- `commitIsBeforeCutoff` — **monotone threshold**: for arbitrary
  `(date, cutoff)` integers, `commitIsBeforeCutoff(date, cutoff) === date <
  cutoff`; monotone in `date` (once true for `d`, true for all `d' < d` at fixed
  cutoff). Total, never throws on any safe-integer input.
- `nameRevCutoff` — for arbitrary safe-integer `t > SLOP`, result is exactly
  `t - 86400` and strictly less than `t`; the boundary/epoch cases stay as
  isolated example tests (they document literal git control flow).

### Interop (`test/integration/name-rev-interop.test.ts` — unchanged expectations)

The existing suite is the faithfulness pin: every reconstruction of `git
name-rev` from `NameRevResult` must stay byte-identical after the cutoff lands.
**Add** the §3 inert-demonstration fixtures so the cutoff's pruning is exercised
against real git (row 3: named ancestor with a far-older pruned parent; row 5:
older-tipped ref skipped at seed) — asserting the **same** output git prints, now
with pruning active. No expectation changes; the additions prove pruning does not
alter output on histories where it fires.

### Bench (`test/bench/name-rev.bench.ts`, decision 5A)

Scaled fixture, annotated tag near the tip, `repo.nameRev()` near the tip;
`bench:summary` delta recorded. Skips cleanly in the Stryker sandbox / without a
`git` CLI (via `scaledScenario`).

### Parity (`test/parity/scenarios/name-rev.scenario.ts` — unchanged)

The existing small linear+merge scenario keeps asserting the same
`NameRevResult` across node / memory / browser; the cutoff is inert, so no new
scenario is needed (cross-adapter parity does not prove faithfulness — the
interop suite does).

## 8. Non-goals

- No change to selection (`isBetterName`), step folding (`step.ts`), ref
  filtering (`ref-pattern.ts`), or the `NameRevResult` shape — all pinned by
  ADRs 283–285.
- No public API change: no new `NameRevOptions` field, no new result field, no
  `describe --contains` surface change, **no `api.json` churn**.
- No commit-graph / generation-number subsystem (tsgit has none; §1.2, §5).
- No `describe` cutoff work — 26.4a (ADR-460) is a separate date-ordered walk
  with a different (candidate-selection) termination story; this item does not
  touch `describe.ts` or `commitDateWalk`.

## 9. Surface gates (perf-only checklist)

- No barrel / facade / `repository.test` / doc-coverage / README-count changes
  (no new command, no new option, no new type) — this is an internal walk
  optimisation. Confirm `reports/api.json` is unchanged by the diff.
- `docs/BACKLOG.md`: flip **26.4b** to `[x]` with the ADR (if decision 4A) and
  this design doc referenced.
- New/extended (final split depends on decision 1): the pure cutoff predicate +
  arithmetic (as `domain/name-rev/cutoff.ts` + internal barrel entry under
  decision 1A — **not** re-exported from `domain/objects` / `api.json`; or inline
  under 1B), its unit + property tests, the `name-rev.ts` walk edit (seed-tip and
  parent guards), the interop inert-demonstration fixtures (§3 rows 3 & 5), the
  read-count unit assertions, and `test/bench/name-rev.bench.ts` (decision 5A).
