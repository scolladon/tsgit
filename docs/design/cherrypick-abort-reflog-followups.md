# Design — `cherry-pick` faithfulness + test follow-ups

## Goal

Two narrow follow-ups surfaced while shipping `revert` (22.2), both pre-decided
by ADR-224. No new behaviour is invented; both are alignment to git's verified
behaviour and to the mutation-resistant test conventions.

1. **`cherryPick.abort` reflog faithfulness.** Align the branch-update reflog
   message to git's `reset: moving to <full-oid>`. The shipped `cherryPickAbort`
   (22.1) writes a bespoke `cherry-pick: aborted`, which is a divergence from
   real git; `revertAbort` already writes the faithful message (ADR-224). This
   is behaviour-preserving except the reflog string.

2. **`CHERRY_PICK_MERGE_NO_MAINLINE` display-message mutant.** Close the
   surviving `StringLiteral` mutant on the rendered message in `domain/error.ts`
   by asserting the rendered string in a `cherryPickMergeNoMainline` helper test,
   mirroring the existing `revertMergeNoMainline` assertion.

## Part 1 — `cherryPick.abort` reflog (verified, not hypothesized)

### What real git writes

`git cherry-pick --abort` hard-resets the working tree, index, and branch to the
pre-sequence `HEAD`; the branch update *is* a reset internally. Verified against
git 2.54 (signing off, scrubbed `GIT_*` env):

- **Range partial-apply (branch moved):** a first clean pick commits, the second
  conflicts and stops. `--abort` resets the branch back to the pre-sequence
  `HEAD` and writes the reflog entry **`reset: moving to <full-oid>`** — byte-
  identical to what `git reset --hard <oid>` produces.
- **Lone conflict (branch did not move):** `--abort` resets to the *same* oid the
  branch already points at; git writes **no** reflog entry (the ref value is
  unchanged).

This matches ADR-224's recorded verification: both `git cherry-pick --abort` and
`git revert --abort` write `reset: moving to <full-oid>`; git writes no bespoke
`cherry-pick: aborted` / `revert: aborted` line.

### What tsgit currently does

`cherryPickAbort` (`application/commands/cherry-pick.ts`) computes
`target = seqHead ?? resolveRef(branch)`, hard-resets to it, then calls
`updateRef(ctx, branch, target, { reflogMessage: 'cherry-pick: aborted' })`.
`revertAbort` is identical except it passes
`reflogMessage: \`reset: moving to ${target}\``.

### Decision — mirror `revertAbort` exactly

Replace the `cherryPick.abort` reflog message with
`` `reset: moving to ${target}` `` so the two abort paths emit the identical,
git-faithful string. This is precisely the follow-up ADR-224 deferred ("the
cherry-pick divergence … logged as a follow-up to align `cherry-pick --abort` to
the same faithful message"). The reset target, state-clearing, and return value
are unchanged.

### Out of scope — the no-op reflog skip (logged as a follow-up)

tsgit's `updateRef` writes a reflog entry unconditionally, including when
`old === new`. Real git skips the entry in the no-move case (verified above). So
in the lone-conflict abort, tsgit writes `reset: moving to <oid>` where git
writes nothing — a faithfulness gap **shared with `revertAbort`** and blessed by
ADR-224's unconditional-write precedent. Aligning the message here does not widen
that gap. Making the reflog write conditional on a real ref move touches both
abort paths (and possibly other `updateRef` callers), so it is a separate,
cross-cutting change tracked in `docs/BACKLOG.md`, never folded into this PR.

### Faithfulness pin

ADR-224 noted that once the message is faithful, "a reflog-parity interop
assertion is possible". The current `cherry-pick-interop` suite asserts
tree/index/HEAD readback but never exercises abort, so the divergence shipped
unpinned. We add the pin: a new case drives a range partial-apply through real
git and through tsgit's `cherryPick.run` + `cherryPick.abort` over the same seed,
then asserts both branch reflogs' top entry reads the identical
`reset: moving to <full-oid>` (real git as oracle, reusing the suite's scrubbed-
`GIT_*` readback technique). The lone-conflict (no-move) case keeps its existing
unit assertion, updated to the faithful string; it is deliberately *not* added to
interop because the no-op-skip gap above would make tsgit and git disagree there
until the separate follow-up lands.

## Part 2 — `CHERRY_PICK_MERGE_NO_MAINLINE` display-message mutant

### The gap

`domain/error.ts` renders both mainline-missing codes:

```
case 'CHERRY_PICK_MERGE_NO_MAINLINE':
  return `commit ${data.commit} is a merge but no -m option was given`;
case 'REVERT_MERGE_NO_MAINLINE':
  return `commit ${data.commit} is a merge but no -m option was given`;
```

`test/unit/domain/commands/error.test.ts` asserts the *rendered* `revert`
message (`expect(sut.message).toBe(...)`), killing the StringLiteral mutant on
the `REVERT_MERGE_NO_MAINLINE` arm. There is no equivalent assertion for the
`cherryPickMergeNoMainline` helper, so the StringLiteral mutant on the
`CHERRY_PICK_MERGE_NO_MAINLINE` arm survives — no test reads the rendered string,
only the `.data` shape (asserted via the cherry-pick command tests).

### Decision — mirror the revert helper test, then DRY the rendering branch

Add a `cherryPickMergeNoMainline` helper test that asserts both `.data` and the
rendered `.message` (`CHERRY_PICK_MERGE_NO_MAINLINE: commit <oid> is a merge but
no -m option was given`), mirroring the `revertMergeNoMainline` block. The
`.message` assertion kills the targeted `StringLiteral` mutant.

Mutation testing then surfaced a *second*, pre-existing survivor the backlog did
not name: a `ConditionalExpression`/fall-through mutant — removing the
`CHERRY_PICK_MERGE_NO_MAINLINE` case's `return` falls through to the adjacent
`REVERT_MERGE_NO_MAINLINE` case, which returns the **byte-identical** string, so
the mutant is provably equivalent. Rather than annotate it with an
`// equivalent-mutant:` comment, we eliminate it honestly by **merging the two
identical cases** into one shared-body branch
(`case CHERRY_PICK_…: case REVERT_…: return …`). This DRYs the duplicated literal,
mirrors git's own single message for both refusals, keeps the `default` `never`
exhaustiveness check intact (both codes remain handled), and leaves the region at
a clean 0-survivor state with no suppression. Both helper tests still assert the
full, code-prefixed message, so the shared `StringLiteral` mutant stays killed.

## Test conventions

Both changes follow the project conventions: GWT describe/it split, AAA body,
`sut` variable, 100% coverage held, 0 killable mutants. The error-message
assertion uses `toBe` on the full rendered string (the message is the
`code: rendered` form produced by `TsgitError`). The interop pin reuses the
existing `cherry-pick-interop` readback technique (scrubbed `GIT_*` env, real
git as oracle).

## Files touched

- `src/application/commands/cherry-pick.ts` — abort `reflogMessage` string + the
  abort doc comment (mirror `revert`'s).
- `test/unit/application/commands/cherry-pick.test.ts` — update the lone-abort
  reflog assertion to the faithful string.
- `test/integration/cherry-pick-interop.test.ts` — add the range-abort
  reflog-parity pin.
- `test/unit/domain/commands/error.test.ts` — add the `cherryPickMergeNoMainline`
  rendered-message assertion.
- `src/domain/error.ts` — merge the two identical `…_MERGE_NO_MAINLINE` rendering
  cases into one shared-body branch (kills the equivalent fall-through mutant).
- `docs/BACKLOG.md` — flip 22.2a; log the no-op reflog-skip follow-up.
