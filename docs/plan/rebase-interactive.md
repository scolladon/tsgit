# Implementation plan — `rebase --interactive`

TDD per slice (Red → Green → Refactor), atomic conventional commit per slice,
`npm run validate` green before every commit. Bottom-up: domain grammar → state
→ engine verbs → wiring → interop. The interactive engine is built as a **parallel
path** beside the shipped non-interactive replay; consolidating the two replay
loops is deferred to the architecture-refactor pass (Step 7) under the
interop+mutation safety net.

Decisions in force: ADR-233 (inline instruction list), ADR-234 (inline
messages), ADR-235 (full fast-forward fold), ADR-236 (`stopped` variant),
ADR-237 (fully faithful squash/fixup chains).

Reference reflog/state facts (verified git 2.54) live in
`design/rebase-interactive.md` §"Verified behaviour".

---

## Slice 1 — domain: widen the todo grammar to six verbs

`src/domain/rebase/todo.ts`, `todo.test.ts`, `todo.properties.test.ts`.

- **Red**: add cases — `serializeRebaseTodo`/`parseRebaseTodo` round-trip each
  verb (`pick|reword|edit|squash|fixup|drop`); a `drop <oid> # <subj>` line
  parses with `action:'drop'`; an unknown verb still throws
  `INVALID_SEQUENCER_TODO` with the offending line in `.data`.
- **Green**: add `export type RebaseTodoAction = 'pick'|'reword'|'edit'|'squash'|'fixup'|'drop'`;
  `RebaseTodoEntry` gains `readonly action: RebaseTodoAction`; regex →
  `/^(pick|reword|edit|squash|fixup|drop) (\S+) # (.*)$/`; serialize emits
  `${action} ${oid} # ${subject}\n`.
- **Ripple (same slice, keep green)**: `rebase-state.ts` `RebaseStop`/write/read
  and `rebase.ts` `buildTodoEntries`/`PlannedPick` now carry `action`; the
  non-interactive builder sets `action:'pick'`. `todo-help.ts` is unaffected
  (consumes `serializeRebaseTodo`).
- **Property**: extend the existing round-trip arbitrary to pick a verb from the
  six (`numRuns:200`); `parse(serialize(x)) ≡ x`.
- Commit: `feat(rebase): widen todo grammar to the six interactive verbs`.

## Slice 2 — domain: squash combined-message builder + strip

`src/domain/rebase/squash-message.ts` (new) + `.test.ts` + `.properties.test.ts`;
re-export from `domain/rebase/index.ts`.

- **Red**: `buildCombinedMessage(['m1','m2'])` returns git's template
  (`# This is a combination of 2 commits.\n# This is the 1st commit message:\n\nm1\n\n# This is the commit message #2:\n\nm2\n`);
  `stripCombinedMessage(template)` drops `#`-comment lines and collapses to the
  cleaned body; single-message build for fixup (`# This is a combination of 1 …`?
  — git uses the running form only for ≥2; a 1-member group cleans to the lone
  message). Pin the exact bytes against the §"Verified behaviour" goldens.
- **Green**: pure builder + strip (reuse `stripComments` semantics where they
  match; the comment markers here are git's fixed template lines).
- **Property**: `stripCombinedMessage(buildCombinedMessage(msgs))` equals the
  msgs joined by git's rule (round-trip lens, `numRuns:200`).
- Commit: `feat(rebase): squash combined-message template + strip`.

## Slice 3 — state: `edit`-stop `amend` file + `stopKind`

`src/application/commands/internal/rebase-state.ts` + unit tests.

- **Red**: `writeRebaseStop` with an `amend` oid writes `.git/rebase-merge/amend`
  = `<oid>\n`; `readRebaseState` surfaces `stopKind:'edit'` when `amend` exists,
  `'conflict'` otherwise, and exposes `amend?: ObjectId`. Byte golden for `amend`.
- **Green**: extend `RebaseStop` (`amend?`), `RebaseState` (`stopKind`, `amend?`),
  write/read; `clearRebaseState` already removes the whole dir.
- Commit: `feat(rebase): persist the edit-stop amend file + stopKind`.

## Slice 4 — state: squash/fixup group files

`rebase-state.ts` + unit tests.

- **Red**: `writeRebaseStop` writes `current-fixups` (`<verb> <oid>\n`…),
  `message-squash` (= the running combined message), `rewritten-pending`
  (`<oid>\n`) when a squash/fixup group is in flight; `readRebaseState` reads them
  back. Byte goldens.
- **Green**: extend the stop/state shapes with the group fields (all optional —
  absent for a plain pick/edit stop).
- Commit: `feat(rebase): persist squash/fixup group state files`.

## Slice 5 — engine: interactive planner + refusals

`src/application/commands/rebase.ts` (+ `commit.ts`/`add.ts` already allow rebase
state); unit tests.

- **Red**: `rebaseRun({ upstream, interactive })` validates before any state
  change — each instruction `oid` resolvable + within `base..head`
  (`INVALID_OPTION`); first non-`drop` is not `squash`/`fixup`
  (`INVALID_OPTION`); non-empty after drops (`INVALID_OPTION`); `reword` carries
  `message` (`INVALID_OPTION`). Assert each `.data.code` with an **isolated**
  test per guard (mutation).
- **Green**: a `planInteractive(ctx, input, base, head)` that resolves each
  instruction (`resolveCommitIsh`/`resolveOidPrefix`), reads its subject, and
  returns `ResolvedInstruction[]`; `rebaseRun` branches on
  `input.interactive !== undefined` *before* the up-to-date/ff short-circuits
  (interactive never short-circuits). Public `RebaseInstruction` /
  `RebaseInteractiveAction` types exported.
- Commit: `feat(rebase): interactive planner + todo validation`.

## Slice 6 — engine: pick + drop + fast-forward fold + `start`

`rebase.ts` + unit tests.

- **Red**: an all-`pick` `-i` onto the fork is a byte-identical no-op (history
  oids unchanged; `rebase (start): checkout <name>` target = last folded commit;
  no per-pick reflog); a `drop` removes its commit and reparents the rest
  (`rebase (pick): <subj>` for the reparented picks); a `pick` that linearly
  continues emits `rebase: fast-forward` keeping the oid; reordered picks
  cherry-pick. Reflog goldens per case.
- **Green**: `detachInteractive` (detach to onto, compute the leading `pick`
  fold via `C.parents[0]===head`, hard-reset worktree to the folded head, record
  one `rebase (start): checkout <ontoName>` at the folded oid); `replayInteractive`
  loop threading `head`, branching pick→(ff | cherry-pick), drop→skip; finish +
  clear state on completion. Result `{kind:'rebased', commits}` (ff'd commit →
  `{source, created:source}`).
- Commit: `feat(rebase): interactive pick/drop replay with fast-forward fold`.

## Slice 7 — engine: reword

`rebase.ts` + unit tests.

- **Red**: reword a fast-forwardable base → `rebase: fast-forward` then
  `rebase (reword): <new subj>`; reword after a drop (non-ff) → `rebase (reword):
  <orig subj>` then `rebase (reword): <new subj>`; the commit's message is the
  supplied one, author preserved, single parent, committer = current identity.
- **Green**: reword = produce the commit (ff or cherry-pick, reflog labelled
  `rebase (reword)` on the cherry-pick branch / `rebase: fast-forward` on ff)
  then amend the message into a new commit with `rebase (reword): <new subj>`.
- Commit: `feat(rebase): reword instruction`.

## Slice 8 — engine: edit stop + continue (amend-or-skip)

`rebase.ts`, `rebase-state.ts` reads; unit tests.

- **Red**: an `edit` produces the commit then returns `{kind:'stopped', commit,
  remaining}` and writes `amend`; `continue` with an unchanged index makes **no**
  new commit and resumes (trailing picks fast-forward, oids preserved, no
  `rebase (continue)` entry); `continue` after staging a change amends → new
  commit with `rebase (continue): <subj>` then resumes; `skip` drops the edited
  commit; the `stopped` result is on the public union.
- **Green**: `replayInteractive` returns `stopped` on `edit`, persisting the full
  stop with `amend = produced oid`; `rebaseContinue` routes on `stopKind`/state:
  `edit` + clean index → resume from current HEAD via the interactive engine;
  `edit` + dirty index → amend (existing continue commit path) then resume;
  conflict stop in interactive mode → the existing commit-the-resolution path,
  then resume via the interactive engine when remaining holds non-pick verbs.
  `rebaseSkip` resumes through the interactive engine when remaining is
  interactive.
- Commit: `feat(rebase): edit stop + interactive continue/skip`.

## Slice 9 — engine: squash + fixup (faithful chains, ADR-237)

`rebase.ts` + unit tests.

- **Red**: `squash` melds into the previous commit with the supplied combined
  message (or git default when omitted), `rebase (squash): <subj>`, author = group
  first member, parent = base's parent, tree = base+member changes; `fixup` keeps
  the base message, `rebase (fixup): <subj>`; a chain `pick A, fixup B, fixup C`
  produces the intermediate `rebase (fixup): # This is a combination of 2
  commits.` then the cleaned `rebase (fixup): A-subject`, final tree = A+B+C; a
  squash/fixup that conflicts mid-group stops with `current-fixups` /
  `message-squash` / `rewritten-pending` written, resumable.
- **Green**: thread a *running group* in `replayInteractive`: on the first
  squash/fixup, the base (current HEAD) becomes the group root; each member melds
  (`applyMergeToWorktree` base=member.parent, ours=HEAD, theirs=member), commits
  with the running template message, advances HEAD, appends `current-fixups`; when
  the next instruction is not squash/fixup (or todo ends), clean the message
  (`stripCombinedMessage`) into the final commit and clear the group files.
- Commit: `feat(rebase): squash/fixup with faithful chains`.

## Slice 10 — wiring + public surface

`commands/index.ts`, `repository.ts`, `src/index.ts` exports; `rebase-namespace.ts`
unchanged shape; unit/type tests.

- **Red**: `repo.rebase.run({ upstream, interactive:[…] })` reachable through the
  facade; `RebaseInstruction`/`RebaseInteractiveAction`/`stopped` result exported
  from the package entry; `api.json` regenerated.
- **Green**: re-export the new types; regenerate `reports/api.json`
  (`check:doc-typedoc` prepush gate).
- Commit: `feat(rebase): expose interactive rebase on repo.rebase.run`.

## Slice 11 — interop (cross-tool parity)

`test/integration/rebase-interop.test.ts` extended (`@writes surface: rebase`).

- **Red/Green**: scripted `git rebase -i` (`GIT_SEQUENCE_EDITOR`/`GIT_EDITOR`)
  vs `repo.rebase.run({interactive})` —
  - `drop`/`reword`/`squash`/`fixup`: resulting `git write-tree` + commit count +
    `HEAD` author parity;
  - all-`pick` no-op: HEAD oid byte-identical on both tools;
  - bidirectional `edit`-stop resume: tsgit `edit` stop finished by `git rebase
    --continue`, and a git `edit` stop finished by `repo.rebase.continue`;
  - fixup-chain commit count + tree parity.
- Commit: `test(rebase): interactive cross-tool interop`.

## Slice 12 — docs + backlog

- `README.md` / `docs/use/` rebase page: document `interactive` + the six verbs,
  inline messages, the `stopped` result; `RUNBOOK.md`/`CONTRIBUTING.md` if they
  reference the rebase surface.
- Flip `docs/BACKLOG.md` **22.4** `[ ] → [x]` with the ADR range + design link;
  note v2.0 ships.
- Commit: `docs(rebase): document interactive rebase; close 22.4`.

---

## Post-implementation (workflow Steps 6–8)

- **Review ×3** (typescript / security / tests), fix-all-until-converged.
- **Architecture refactor (Step 7)** — evaluate unifying `replayInteractive` with
  the non-interactive `replayOne`/`replayFrom` (the fast-forward predicate makes
  the non-interactive replay a special case); behaviour-preserving, re-reviewed,
  re-validated. May be a no-op with justification. Also revisit 22.3a's
  `readCommitData`/`treeOf`/`subjectOf`/`requireSymbolicHead` triplication now
  that rebase.ts grows.
- **Mutation** — 0 killable survivors; annotate provable equivalents inline.
