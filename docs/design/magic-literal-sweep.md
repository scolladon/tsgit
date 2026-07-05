# Design — magic-literal sweep

## Goal

Centralize the magic string/number literals scattered across the command surface into
named, concern-colocated constants. **Behavior-preserving**: every extracted constant
carries a byte-identical value, so nothing observable changes — object SHAs, ref & reflog
contents, on-disk state-file names, refusal conditions, and message formats are untouched.
The win is purely internal: primitive-obsession drops, the canonical spelling of each
literal lives in exactly one place, and a future edit to (say) a reflog prefix is a
one-line change instead of a grep-and-pray sweep.

This is the smell flagged during the Phase 22 history-rewrite work: the same operation
labels, reflog prefixes, and state-marker filenames are re-typed inline across dozens of
command files, each an independent opportunity to drift from git's canonical spelling.

## Requirements (self-supplied — no upstream requirements artifact)

1. **R1 — Zero behavior change.** No object SHA, ref, reflog line, state-file name/content,
   refusal message, or conflict-marker byte differs before vs after. The prime directive
   (git-faithfulness) binds: the sweep *preserves* faithfulness, it does not renegotiate it.
2. **R2 — Single source of truth.** Each in-scope literal family has one canonical
   definition; consumers import it. A drift-prone re-typed literal becomes a compile-time
   reference.
3. **R3 — Concern-colocated placement.** Constants live with their domain concern (the
   `domain/merge/merge-labels.ts` precedent), not in a grab-bag `constants.ts`. Domain
   literals live in `domain/`; application-only orchestration labels may live in
   `application/**/internal/`.
4. **R4 — Mutation integrity preserved.** Tests keep their own hardcoded literal oracles
   (see Non-goals). Production imports the constant; the test still asserts the raw string.
   This is deliberate — sharing the constant with the test would let a `StringLiteral`
   mutant of the constant flip both sides and survive.
5. **R5 — 100% coverage / 0 survivors held.** Every new constant is referenced by a
   consumer (so it is covered); no coverage/mutation suppression is introduced.

## The literal families (in scope)

The backlog names five families. Verified locations (non-exhaustive — the plan enumerates
every site; these anchor the design):

| # | Family | Representative literals | Current homes (sample) | Proposed canonical home |
|---|---|---|---|---|
| F1 | **State-marker filenames** | `MERGE_HEAD`, `ORIG_HEAD`, `MERGE_MSG`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `FETCH_HEAD` | `internal/merge-state.ts`, `internal/revert-state.ts`, `commands/worktree.ts`, `snapshot/snapshot-factory.ts` (`COMMIT_REF_FILES`), `primitives/internal/repo-state.ts` (`{file, operation}` table) | `domain/refs/state-files.ts` (or `application/**/internal/state-files.ts`) — one named table; existing `COMMIT_REF_FILES` / `repo-state` table re-point to it |
| F2 | **Reflog message prefixes / labels** | `reset: moving to `, `revert: `, `commit: `, `commit (initial): `, `commit (amend): `, `commit (merge): `, `branch: Created from `, `cherry-pick: `, `clone: from `, `fetch <remote>: …` | `commands/commit.ts`, `branch.ts`, `cherry-pick.ts`, `revert.ts`, `abort-merge.ts`, `clone.ts`, `fetch.ts` | `domain/reflog/reflog-messages.ts` — prefix constants (+ optional builders, see D3) |
| F3 | **Operation labels** | `'merge'`, `'rebase'`, `'cherry-pick'`, `'revert'`, `'revert --continue'`, `'revert --abort'`, `'cherry-pick --continue'` | `primitives/internal/repo-state.ts` (`PendingOperation` union, twice), `commands/commit.ts`, `cherry-pick.ts`, `revert.ts` (assert / error args) | `domain/sequencer/operation-labels.ts` — the `PendingOperation` vocabulary + the CLI-flavored operation strings used in refusals |
| F4 | **Conflict-marker tokens** | `<<<<<<<`, `\|\|\|\|\|\|\|`, `=======`, `>>>>>>>` | `internal/commit-message.ts`, `domain/merge/*` | `domain/merge/conflict-markers.ts` (or extend `merge-labels.ts`) |
| F5 | **Walk caps** | numeric bounds on history/commit walks | commit/history walk primitives | colocated with the walk primitive that owns the bound |

## Decision — concern-colocated named-constant modules

Follow the established `domain/merge/merge-labels.ts` shape: a small module per concern
exporting `SCREAMING_SNAKE` constants (or a frozen `as const` table where the literals form
a set), each with a *why*-comment tying it to git's canonical spelling. Consumers import
the symbol. This matches the codebase's "organize by feature/domain, many small files"
principle and keeps the domain-boundary rule intact (domain literals stay in `domain/`).

### Why not one central `constants.ts`

A single grab-bag module couples every command to one file, violates high-cohesion /
low-coupling, and re-introduces the "junk drawer" smell the sweep is meant to remove. It
also forces application-tier orchestration labels into the domain. Rejected.

### Why the extracted value must be byte-identical, and how it stays that way

The constants are pure relocations of existing literals. The guard against accidental drift
is the existing test + interop suite: parity goldens pin reflog/marker/SHA bytes against
real git, and mutation testing pins each literal's exact spelling — **provided tests keep
their own oracles** (R4). A relocation that changed a byte fails an interop golden or a unit
assertion immediately.

## Decision candidates (for the ADR conversation)

- **DC1 — Placement granularity.** (a) One concern-colocated module per family in its
  domain concern *(recommended — matches `merge-labels.ts`)*; (b) a single central
  `constants.ts`; (c) inline `as const` at each primary consumer with no shared module.
  → *Recommend (a).* Load-bearing: sets the module topology the plan builds against.
- **DC2 — Scope breadth.** (a) Exactly the five named families F1–F5 *(recommended)*;
  (b) F1–F5 **plus** adjacent primitive-obsession found in-flight (e.g. the duplicated
  `PendingOperation` union in `repo-state.ts`, other re-typed unions). → *Recommend (a)
  with a documented follow-up for anything F1–F5 doesn't cover*, honoring the
  "everything in this PR / warn-and-ask before deferring" default — so DC2 really asks:
  *does the duplicated `PendingOperation` union ride along in F3, or split out?*
- **DC3 — Reflog messages: constants vs builders.** Many reflog messages are templated
  (`cherry-pick: ${subject}`, `branch: Created from ${startPoint}`, `fetch ${remote}: …`).
  (a) Extract only the **static prefix** as a constant, keep interpolation at the call site
  *(recommended — smallest diff, preserves each call site's readability)*; (b) introduce
  **message-builder functions** (`revertReflog(subject)`) that own the whole line. → Affects
  how much logic moves into the reflog module.
- **DC4 — Operation-label unification.** The `PendingOperation` union
  (`'merge' | 'rebase' | 'cherry-pick' | 'revert'`) is declared in two spots and echoed as
  error-message args. (a) Single exported union + value table shared by `repo-state`,
  `commit`, `cherry-pick`, `revert` *(recommended)*; (b) leave the type where it is, extract
  only the string literals. → Load-bearing: (a) touches a domain type crossing several
  commands.
- **DC5 — Conflict markers: new module vs extend `merge-labels.ts`.** (a) New
  `domain/merge/conflict-markers.ts` *(recommended — markers are a distinct concern from the
  ours/theirs labels already in `merge-labels.ts`)*; (b) extend `merge-labels.ts`.

## Module location

New modules land in the domain concern they name (F1 refs/state, F2 reflog, F3 sequencer,
F4 merge, F5 with the owning walk primitive). No new outward dependency is introduced; every
module is pure data + optional pure builders, satisfying the domain "zero platform deps"
invariant. No ADR-level boundary change — this is relocation within existing tiers.

## Test plan

- **No new behavior tests.** The change is a pure relocation; the existing unit + integration
  + interop suites are the behavioral gate. Green suite = zero drift (R1).
- **Coverage:** each new constant is referenced by ≥1 consumer, so it is covered by the
  consumer's existing tests. Any new module with a pure builder (DC3-b / DC4-a) gets a
  direct unit test with **hardcoded** expected strings (R4).
- **Mutation:** the sweep must not *lower* the mutation score. Because tests keep their own
  literal oracles, a `StringLiteral` mutant of any relocated constant still flips exactly one
  side and dies on the consumer's test. Re-run the scoped mutation battery over touched files.
- **Interop:** untouched — the reflog/marker/SHA goldens in `test/integration/*-interop.test.ts`
  are the byte-for-byte faithfulness pin; they must stay green with zero golden edits.

## Non-goals

- **Not changing any value.** Byte-identical relocation only.
- **Not touching test literals.** Test assertions keep their own hardcoded expected strings
  as independent oracles — production imports the constant, the test does not. (R4 —
  sharing would create a mutation blind spot.)
- **Not extracting one-off literals** that appear exactly once and carry no drift risk
  (a genuinely single-site string is not primitive-obsession).
- **Not renaming or restructuring** the consuming commands beyond swapping a literal for a
  named import.

## Architecture pass (post-implementation)

Confirm no new module-boundary violation (domain still imports nothing outward; application
constants do not leak into domain). Confirm no import cycle introduced by the new colocated
modules. Behavior-preserving — may be a no-op.
