# Plan — magic-literal sweep

> The plan is the implementation script AND the knowledge handoff. Each part starts from
> its Context block (real files/symbols) and lands as one atomic behavior-preserving commit.
> Design: `docs/design/magic-literal-sweep.md`. ADRs: 453 (concern-colocated + R4
> tests-keep-own-oracles), 454 (unify operation vocabulary), 455 (reflog builders).

## Scope notes (audited during planning)

The backlog names five literal families. Two are **already centralized** — verified, no
genuine work remains (extracting the lone one-off literals would violate the design's
"don't extract single-site literals" non-goal):

- **F4 conflict-marker tokens** — `src/domain/merge/conflict-markers.ts` already exists and
  owns the marker construction (`writeConflictMarkers`, the `<`/`=`/`>`/`|` repeats). The
  only other mention (`commit-message.ts:67`) is a JSDoc comment, not a code literal.
  DC5 is effectively pre-satisfied.
- **F5 walk caps** — `src/application/primitives/types.ts` already centralizes 14 named
  `MAX_*` caps (`MAX_WALK_SEEDS`, `MAX_WALK_QUEUE_SIZE`, `MAX_PEEL_DEPTH`,
  `MAX_SYMBOLIC_REF_DEPTH`, …). A targeted scan of the walk/traversal primitives found
  **zero** genuine inline cap literals.

Genuine sweep work = **F1 (state-marker filenames)**, **F3 (operation-label vocabulary)**,
**F2 (reflog messages)**. Four parts below.

## Sizing rules

Each part: one concern, one atomic commit, independently gated. No test-only parts — every
part creates/migrates production code. **R4 (ADR-453):** new constants/builders get a
**direct unit test with hardcoded expected strings**; migrated consumers keep their own
existing literal oracles (never import the constant into the test's expectation). The change
is behavior-preserving — the existing unit + integration + interop suites are the safety net;
byte-for-byte reflog/marker/SHA output must not move.

---

## Part 1 — State-marker filenames (F1)

### Context

Create `src/domain/refs/state-files.ts` (dir exists, 9 files) exporting the git-canonical
state-file names as named constants:
`MERGE_HEAD`, `ORIG_HEAD`, `MERGE_MSG`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`,
`FETCH_HEAD` — each `export const X = 'X'` with a *why*-comment (git's canonical spelling).

Consumers to migrate (swap the inline string for the import):
- `src/application/commands/internal/merge-state.ts` — `mergeHeadPath` (`…/MERGE_HEAD`),
  `origHeadPath` (`…/ORIG_HEAD`), `MERGE_MSG` path.
- `src/application/commands/internal/revert-state.ts` — `revertHeadPath` (`…/REVERT_HEAD`).
- `src/application/commands/worktree.ts` — `${admin}/ORIG_HEAD` (~:164, :192).
- `src/application/primitives/snapshot/snapshot-factory.ts:39` — `COMMIT_REF_FILES` tuple
  (`['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','FETCH_HEAD']`) → build from the constants.
- `src/application/primitives/internal/repo-state.ts:124-132` — `PENDING_MARKERS[].file`
  fields (`'MERGE_HEAD'`, `'CHERRY_PICK_HEAD'`, `'REVERT_HEAD'`, `'REBASE_HEAD'`) → constants.

Faithfulness: values byte-identical; no on-disk state-file name changes. Domain module, zero
outward deps (pure string constants).

### TDD steps

1. **RED** — add `src/domain/refs/state-files.test.ts` (GWT/AAA, `sut` = the module):
   one `it('Then <NAME> equals git's canonical file name')` per constant asserting
   `expect(sut.MERGE_HEAD).toBe('MERGE_HEAD')` etc. — **hardcoded RHS oracle** (kills
   `StringLiteral` mutants deterministically). Run → fails (module absent).
2. **GREEN** — create `state-files.ts` with the constants. Run the new test → passes.
3. **Migrate** each consumer above to import the constant; after each file, run its existing
   tests (which keep their own literal oracles) — they must stay green.
4. **REFACTOR** — confirm no duplicate inline `'MERGE_HEAD'`-family literals remain in the
   touched files; imports clean.

### Gate

`npx vitest run src/domain/refs/state-files.test.ts <touched consumers' tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`; phase-boundary `npm run validate`.

### Commit

`refactor: centralize state-marker filenames into named constants`

---

## Part 2 — Operation-label vocabulary (F3, ADR-454)

### Context

Create `src/domain/sequencer/operation-labels.ts` (dir exists, 2 files) exporting:
- `export const PENDING_OPERATIONS = ['merge', 'rebase', 'cherry-pick', 'revert'] as const`
- `export type PendingOperation = (typeof PENDING_OPERATIONS)[number]`
- the CLI-flavored refusal-string constants used in error/assert args (enumerate exact
  spellings in-part via `grep -rnE "'(revert|cherry-pick)( --(continue|abort|skip|quit))?'"`;
  known set includes `'revert'`, `'revert --continue'`, `'revert --abort'`, `'cherry-pick'`,
  `'cherry-pick --continue'`).

Consumers to migrate:
- `src/application/primitives/internal/repo-state.ts` — the inline union
  `'merge' | 'rebase' | 'cherry-pick' | 'revert'` at the `PENDING_MARKERS` type annotation
  (~:126) **and** the `type PendingOperation` declaration (~:134) → import both; the
  `operation:` field values become the label constants.
- `src/application/commands/commit.ts` — operation-label refusal/branch args.
- `src/application/commands/cherry-pick.ts` — `'cherry-pick'` / `'cherry-pick --continue'`.
- `src/application/commands/revert.ts` — `'revert'` / `'revert --continue'` / `'revert --abort'`.

Removes the duplicated `PendingOperation` union (single source of truth). Values unchanged →
refusal-condition parity holds (ADR-226). Domain module, zero outward deps.

### TDD steps

1. **RED** — `src/domain/sequencer/operation-labels.test.ts`: assert `PENDING_OPERATIONS`
   deep-equals `['merge','rebase','cherry-pick','revert']` (hardcoded), and each refusal
   constant `.toBe('<exact string>')` (hardcoded oracle). Run → fails.
2. **GREEN** — create the module. Run new test → passes.
3. **Migrate** consumers; `check:types` proves the shared `PendingOperation` type unifies
   cleanly; run each consumer's existing tests → green.
4. **REFACTOR** — confirm no residual inline `PendingOperation` union or operation-label
   literal remains in touched files.

### Gate

`npx vitest run src/domain/sequencer/operation-labels.test.ts <touched consumers' tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`; phase-boundary `npm run validate`.

### Commit

`refactor: unify pending-operation vocabulary into shared constants`

---

## Part 3 — Reflog message builders: non-sequencer commands (F2, ADR-455)

### Context

Create `src/domain/reflog/reflog-messages.ts` (dir exists, 6 files) exporting **pure builder
functions** that own each full reflog line. This part covers the non-sequencer builders +
their consumers; Part 4 adds the sequencer builders to the same module.

Builders for this part (exact strings verified in-part; assembled bytes must be identical):
- `resetMovingTo(target)` → `reset: moving to ${target}` (and the static
  `RESET_MOVING_TO_HEAD = 'reset: moving to HEAD'`).
- `branchCreatedFrom(startPoint)` → `branch: Created from ${startPoint}`.
- `branchRenamed(from, to)` → `branch: renamed ${from} to ${to}`.
- `cloneFrom(url)` → `clone: from ${url}`.
- `fetchStoringHead(remote)` → `fetch ${remote}: storing head`.
- `PUSH_UPDATE = 'update by push'`.
- commit builders — `commit (initial): ${s}`, `commit (amend): ${s}`, `commit (merge): ${s}`,
  `commit: ${s}` (enumerate commit.ts's `commitReflogMessage` cases exactly).

Consumers to migrate (non-sequencer):
`src/application/commands/commit.ts` (`commitReflogMessage`, ~:278),
`branch.ts` (~:100, :142), `reset.ts` (~:80), `abort-merge.ts` (~:50),
`internal/abort-sequencer-reset.ts` (~:32), `clone.ts` (~:258, :300), `fetch.ts` (~:332),
`push.ts` (~:514), `worktree.ts` (~:192), `submodule.ts` (~:594).

Faithfulness-critical: the reflog interop goldens in `test/integration/*-interop.test.ts`
pin these bytes against real git — they must stay green with zero golden edits. Domain
module, zero outward deps (pure functions).

### TDD steps

1. **RED** — `src/domain/reflog/reflog-messages.test.ts`: one `it` per builder asserting
   `expect(sut.resetMovingTo('abc123')).toBe('reset: moving to abc123')` etc. — **hardcoded
   expected strings** (R4; independent oracle). Run → fails.
2. **GREEN** — implement the non-sequencer builders. Run new tests → pass.
3. **Migrate** each consumer call site to the builder; after each, run its existing reflog
   tests. Then run the reflog interop tests → must stay green (byte parity).
4. **REFACTOR** — confirm no inline reflog template remains in the touched non-sequencer files.

### Gate

`npx vitest run src/domain/reflog/reflog-messages.test.ts <touched consumers' tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`; phase-boundary `npm run validate`.

### Commit

`refactor: centralize non-sequencer reflog messages into builders`

---

## Part 4 — Reflog message builders: sequencer commands (F2, ADR-455)

### Context

Extend `src/domain/reflog/reflog-messages.ts` (created in Part 3) with the sequencer/merge
builders and migrate their consumers:
- `cherryPickReflog(subject)` → `cherry-pick: ${subject}`;
  `commitCherryPickReflog(subject)` → `commit (cherry-pick): ${subject}`.
- `revertReflog(subject)` → `revert: ${subject}`;
  `commitRevertReflog(subject)` → `commit: ${subject}` (revert.ts:455).
- rebase family — `rebase (start): checkout ${onto}`, `rebase (pick): ${s}`,
  `rebase (finish): ${branch} onto ${onto}`, `rebase (finish): returning to ${branch}`,
  `rebase (continue): ${s}`, `REBASE_FAST_FORWARD = 'rebase: fast-forward'` (enumerate the
  full rebase.ts set exactly, ~:221, :289, :373, :376, :540, :717, :726).
- merge.ts uses a caller-supplied `reflogAction` (~:171, :287) — extract only the genuinely
  static fragments; leave the dynamic action param as-is (do **not** invent a constant for a
  runtime value).

Consumers to migrate: `src/application/commands/cherry-pick.ts` (~:338, :474),
`revert.ts` (~:176, :455), `rebase.ts` (rebase family), `merge.ts` (static fragments only).

### TDD steps

1. **RED** — add `it`s to `reflog-messages.test.ts` for each new sequencer builder, hardcoded
   expected strings. Run → fails.
2. **GREEN** — implement the sequencer builders. Run new tests → pass.
3. **Migrate** the sequencer consumers; after each, run its existing tests; then run the
   cherry-pick / revert / rebase / merge interop goldens → must stay green (byte parity,
   incl. both-merge-direction cases).
4. **REFACTOR** — confirm no inline reflog template remains in the touched sequencer files.

### Gate

`npx vitest run src/domain/reflog/reflog-messages.test.ts <touched consumers' tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`; phase-boundary `npm run validate`.

### Commit

`refactor: centralize sequencer reflog messages into builders`
