# Plan — `describe` candidate-selection faithfulness

Implements the design (Option A, ADR-276): reproduce git's `gave_up` candidate
freeze + winner-only depth finalisation in `selectNearest`, omitting the
observationally-inert cond 2. Localised to `src/application/commands/describe.ts`;
no shared-core / `api.json` change.

## Touched files

- `src/application/commands/describe.ts` — rewrite `selectNearest`; add
  `pickNearest` + `finishWinner` helpers.
- `test/unit/application/commands/describe.test.ts` — flip the default-budget
  case; add freeze/finalise/natural-end/isolation cases.
- `test/integration/describe-interop.test.ts` — add the default assertion to the
  `candidate-cap` scenario; add the convergence scenario.

No domain change, no new module, no barrel/`api.json` touch.

---

## Slice 1 — Faithful candidate freeze + winner finalisation `fix(describe): …`

### Red

Edit `describe.test.ts`:

1. **Flip the existing default-budget case** (`Given a newer-dated tag farther
   than an older nearer tag across a merge` → `When describe runs with the default
   candidate budget`): assert `sut.name === 'side'`, `sut.distance === 3` (was
   `near`/`2`). Update the block comment to state git's early-termination keeps
   the first-met `side` by default too (the 23.4n fix). Keep the `--candidates=1`
   case (`side`/`3`) unchanged.
2. **Add** `Given two equal-frozen-depth candidates / When the cap freezes the
   set / Then the first-met (newer-dated) candidate wins` — a merge where two tags
   tie on frozen depth; assert the newer-dated (lower found-order) wins.
3. **Add** `Given the winner is finalised past its frozen depth / Then the
   reported distance exceeds the freeze-point depth` — the `side` 2→3 lift
   (assert `distance === 3` while another candidate's structural distance is `2`),
   guarding winner-only finalisation.
4. **Add** `Given a lightweight tag keeps the name count above the qualifying set
   / When describe runs annotated-only / Then the walk runs to the end and reports
   the nearest annotated tag` — a lightweight tag on a distinct commit makes
   `candidates.length < totalNames` forever, so cond 1's `totalNames` branch never
   fires; assert the nearest annotated tag at its exact distance (no premature
   freeze).
5. **Add** `--tags` boundary case if not already covered: a lightweight tag is
   collected under `--tags` (`priority 1 >= minPriority 1`) — kills the `>=`→`>`
   mutant on the qualifying guard.

Run `npx vitest run test/unit/application/commands/describe.test.ts` →
cases 1–3 fail (current code returns the exhaustively-nearest tag / un-lifted
depth); 4–5 should pass already (guard against accidental regressions).

### Green

Rewrite `selectNearest` in `describe.ts`:

```ts
const selectNearest = async (
  ctx, target, nameMap, plan, minPriority,
): Promise<SelectionOutcome> => {
  const totalNames = nameMap.size;
  const reach = new Map<ObjectId, Set<number>>();
  const candidates: Candidate[] = [];
  let counter = 0;
  let sawUnannotated = false;
  let winner: Candidate | undefined;

  for await (const commit of commitDateWalk(ctx, {
    from: [target],
    firstParent: plan.firstParent,
  })) {
    const oid = commit.id;

    // Finishing phase (git's finish_depth_computation): the candidate set is
    // frozen; advance only the winner's depth, still spreading reachability.
    if (winner !== undefined) {
      finishWinner(reach, commit, winner, plan.firstParent);
      continue;
    }

    // git's gave_up_on: every slot or every name is taken. Sort the candidates on
    // their frozen partial depths, pick the winner, finalise it from here.
    if (candidates.length === plan.maxCandidates || candidates.length === totalNames) {
      winner = pickNearest(candidates);
      if (winner === undefined) break;
      finishWinner(reach, commit, winner, plan.firstParent);
      continue;
    }

    counter += 1;
    const named = nameMap.get(oid);
    if (named !== undefined && named.priority >= minPriority) {
      const index = candidates.length;
      candidates.push({ name: named.name, commitOid: oid, depth: counter - 1, foundOrder: index });
      reachSet(reach, oid).add(index);
    } else if (named !== undefined) {
      sawUnannotated = true;
    }
    incrementUnreached(candidates, reach.get(oid));
    propagateReach(reach, commit, plan.firstParent);
  }

  return { best: winner ?? pickNearest(candidates), sawUnannotated };
};
```

Add helpers (beside the existing ones):

```ts
/** git's `compare_pt`: nearest (smallest depth), then earliest found order. */
const pickNearest = (candidates: ReadonlyArray<Candidate>): Candidate | undefined =>
  [...candidates].sort(compareCandidates)[0];

/** Advance only the winner's depth, then keep spreading reachability. */
const finishWinner = (
  reach: Map<ObjectId, Set<number>>,
  commit: Commit,
  winner: Candidate,
  firstParent: boolean,
): void => {
  incrementUnreached([winner], reach.get(commit.id));
  propagateReach(reach, commit, firstParent);
};
```

`incrementUnreached`, `propagateReach`, `reachSet`, `compareCandidates`,
`Candidate`, `SelectionOutcome` are unchanged. Remove the old `[...candidates]
.sort(compareCandidates)[0]` inline (now `pickNearest`). Drop the old
`candidates.length < plan.maxCandidates` collection guard (cond 1 enforces the cap
at the loop head, exactly as git's top-of-loop `gave_up` check makes its
`match_cnt < max_candidates` redundant).

Re-run the unit file → all green.

### Refactor

- Keep `selectNearest` ≤ ~30 lines by factoring `finishWinner`/`pickNearest`
  (done above). Early returns, no nesting > 2.
- Confirm the doc comment on `selectNearest` describes freeze-then-finalise.
- `npm run validate` → commit `fix(describe): freeze candidates at git's gave_up point`.

---

## Slice 2 — Cross-tool faithfulness pins `test(describe): …`

### Add (interop, real git)

In `describe-interop.test.ts`:

1. **`candidate-cap` default assertion** — in the existing
   `Given a newer-dated tag farther than an older nearer tag` block, add
   `it('Then default describe spends the budget on the farther first-met tag,
   matching git')`: `expect(render(await describeCmd(ctx))).toBe(gitDescribe(dir))`.
   Update the block comment (the default case is now exercised and faithful).
2. **Convergence scenario** (`ay`/`bee`/`old`) — a new `beforeAll`-built repo:
   `base → old(tag) → P`, branch `abr` off `P` with `A(tag ay)`, second commit
   `B(tag bee)` off `P` on main, then `merge --no-ff abr`. `ay` newer-dated than
   `bee`; `old` two commits behind the merge-base. Assert
   `render(await describeCmd(ctx)) === gitDescribe(dir)` (real git fires cond 2
   and reports `ay-2`; tsgit walks the full set and still reports `ay-2`) — pins
   that omitting cond 2 does not regress.

Run `npx vitest run test/integration/describe-interop.test.ts` → green (requires
the `git` binary; the suite `skipIf(!GIT_AVAILABLE)`).

### Validate & commit

`npm run validate` → commit
`test(describe): pin candidate-selection faithfulness against git`.

---

## Review focus (Step 6)

- **TypeScript**: `winner: Candidate | undefined` flow; `reach.get(oid)`
  possibly-undefined into `incrementUnreached` (already `Set<number> | undefined`);
  no `any`; immutability (candidates mutated in place is existing, documented).
- **Security**: none new — no FS/URL/path surface touched; pure in-memory walk.
- **Tests**: cond-1 `||` and each `===` operand isolated; `>= minPriority`
  boundary; `counter - 1`; the freeze/finalise split (2→3 lift); natural-end path;
  found-order tie-break; `winner === undefined` short-circuit (totalNames 0 /
  always / no-names refusals stay green).

## Mutation (Step 8)

`./node_modules/.bin/stryker run --mutate src/application/commands/describe.ts`.
Expect survivors only where provably equivalent (document inline). The
freeze/finalise rewrite should be fully killable by the new tests; no new
suppressions. The pre-existing `// Stryker disable` on `computeDirty`'s `--broken`
catch is untouched (out of scope).

## Done when

- `describe` default pick byte-faithful to `git describe` (23.4n);
  `--candidates=1` / `--first-parent` / filters / refusals unchanged.
- `npm run validate` green; 0 killable mutants on `describe.ts`.
- BACKLOG 23.4n flipped `[x]`; 26.4a present; docs refreshed.
