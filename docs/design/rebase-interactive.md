# Design — `rebase --interactive`

## Goal

Add interactive editing to `repo.rebase.run` — the `pick` / `reword` / `edit` /
`squash` / `fixup` / `drop` instruction set of `git rebase -i`. This is the
final Phase 22 history-rewrite item and the v2.0 capstone: it lands on top of
the non-interactive rebase (22.3, `design/rebase-non-interactive.md`) and reuses
its detached-HEAD merge-backend model (ADR-228), its byte-faithful
`.git/rebase-merge/` state (ADR-229), its namespace (ADR-230), and the shared
`applyMergeToWorktree` replay primitive (ADR-215).

## Faithfulness is the prime directive (ADR-226)

Every observable byte must match real `git rebase -i` (the merge backend, the
only backend since 2.26). Verified against git 2.54 (`GIT_*` scrubbed, signing
off): the per-instruction `HEAD` reflog subjects, the leading fast-forward fold,
the on-disk todo grammar (`<verb> <oid> # <subject>`), the `edit`-stop `amend`
file, the squash/fixup combined-message template and `current-fixups`, the final
combined commit's tree+author+message, and the cherry-pick-equivalent drop set.
Pinned by cross-tool interop (a tsgit `-i` stop finished by `git rebase
--continue`, and vice-versa) and unit goldens.

The one necessary, ADR-gated divergence is structural, not behavioural: a library
has **no `$EDITOR`**. git opens the editor twice — once on the todo, once per
reword/squash message. tsgit receives the *post-edit* todo and messages as data
(see ADR-233 / ADR-234). Everything git derives from that data afterward is
reproduced faithfully.

## Verified behaviour (the model the implementation replicates)

### The todo and `done` grammar carry the verb

`git-rebase-todo`, `git-rebase-todo.backup`, and `done` lines are
`<verb> <full-oid> # <subject>` for every verb (`pick`, `reword`, `edit`,
`squash`, `fixup`, `drop`) — the existing `domain/rebase/todo` grammar only
matched `pick`. `drop` lines are written to `done` too.

### Fast-forward fold (`skip_unnecessary_picks`)

After `checkout <onto>`, git fast-forwards the **maximal leading run of `pick`
instructions whose commits linearly continue from HEAD** and folds them into the
single `rebase (start): checkout <ontoName>` reflog entry — whose **target oid is
the last folded commit**, not `onto`. The `onto` file still records the true
`onto`. The fold stops at the first non-`pick` verb or the first pick that does
not continue.

A commit `C` "linearly continues" the running detached HEAD `H` iff
`C.parents[0] === H`. This single predicate drives **all** fast-forwarding:

| situation | `C.parents[0] === H`? | outcome |
|---|---|---|
| leading `pick`, onto = fork | yes | folded into `start` (no own reflog) |
| `pick` after a drop/reword/amend | no | cherry-pick → `rebase (pick): <subj>` |
| `reword`/`edit` whose base is unchanged | yes | `rebase: fast-forward` then the action |
| `edit` continued with no tree change | yes (next commit) | trailing commits stay original oids |

Consequence: an all-`pick` interactive rebase onto the fork is a **complete
no-op** — every commit folds into `start`, history is byte-identical. tsgit must
reproduce this; recreating untouched commits (fresh committer timestamps → new
oids) would diverge on every `-i` invocation.

### Per-verb semantics + reflog (verified, git 2.54)

Let `H` be the running detached HEAD, `C` the instruction's source commit.

- **`pick C`** — replay `C` onto `H`. If `C.parents[0] === H`: fast-forward
  (`rebase: fast-forward`, keep `C`'s oid). Else: 3-way cherry-pick through
  `applyMergeToWorktree` (`rebase (pick): <subject>`, new oid). Already covered
  by 22.3's `replayOne`; interactive adds the fast-forward branch.
- **`reword C`** — produce the commit exactly like `pick`, then amend its message
  to the caller-supplied text. Two reflog entries:
  - base fast-forwards → `rebase: fast-forward` (the commit) then
    `rebase (reword): <new subject>` (the amend, new oid);
  - base does not → `rebase (reword): <original subject>` (the cherry-pick, new
    oid) then `rebase (reword): <new subject>` (the amend, new oid).
- **`edit C`** — produce the commit like `pick` (fast-forward or cherry-pick),
  then **stop** (voluntary, conflict-free) with an `amend` file = the produced
  oid. `continue`:
  - index unchanged vs HEAD → no new commit; resume the todo (trailing picks may
    fast-forward, keeping their oids);
  - index changed → amend (new commit, `rebase (continue): <subject>`), resume.
- **`squash C`** — meld `C` into `H`: recommit `H`'s tree + `C`'s changes onto
  `H.parents[0]`, with the combined message; reflog `rebase (squash): <subject>`
  (new oid, replaces `H`). Author = the squash group's first commit (preserved
  via `author-script`); committer = current identity.
- **`fixup C`** — like `squash` but the combined message keeps the previous
  commit's message (no caller message). Reflog `rebase (fixup): <subject>`.

  **Chains (≥2 consecutive squash/fixup) — fully faithful (ADR-237).** git
  commits *after each* group member with the *running* (still-templated,
  comment-prefixed) message and only **cleans** the message when the group ends,
  so a chain of length _n_ leaves _n_ intermediate commits and _n_ reflog
  entries whose subjects are the commit's first message line at commit time
  (`rebase (fixup): # This is a combination of N commits.`) up to the final,
  cleaned entry. tsgit reproduces this byte-for-byte: the engine threads a
  *running combined message* (template form), commits each member as it is
  processed, and cleans the message only when the next instruction is not a
  squash/fixup (or the todo ends). `current-fixups` / `message-squash` /
  `rewritten-pending` track the in-flight group for cross-tool resume.
- **`drop C`** — skip entirely. No commit, no reflog, no `rewritten-list` entry;
  the line is still written to `done`.

### `edit`/squash stop state — extra files beyond 22.3

A stop (conflict or `edit`) writes the full 22.3 `.git/rebase-merge/` set; the
interactive paths add (verified `od -c`):

| file | when | bytes |
|---|---|---|
| `amend` | `edit` stop, and during a squash/fixup meld | `<oid>\n` — the commit being amended/melded |
| `current-fixups` | inside a squash/fixup group | `<verb> <oid>\n`… one line per group member |
| `message-squash` | squash/fixup stop | the combined-message template (backup of `message`) |
| `rewritten-pending` | squash/fixup group in progress | `<oid>\n` of the to-be-rewritten base |

The combined-message template git writes to `message` (and `message-squash`):

```
# This is a combination of 2 commits.
# This is the 1st commit message:

<msg1>

# This is the commit message #2:

<msg2>
```

`done` records the verbs of completed instructions (`pick`/`edit`/`squash`/…).
`interactive` stays the empty marker it already is (the merge backend writes it
empty for both interactive and non-interactive rebases).

### `--abort` is identical to 22.3

An interactive abort writes the same `rebase (abort): returning to <head-name>`
on `HEAD`, leaves the branch untouched (the replay was detached), and clears the
state dir + `REBASE_HEAD`. No change to `rebaseAbort`.

## API surface (ADR-233, ADR-234)

`run` gains one optional field. Its presence selects the interactive engine;
absence keeps the 22.3 non-interactive path byte-for-byte unchanged.

```ts
type RebaseInteractiveAction =
  | 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

interface RebaseInstruction {
  readonly action: RebaseInteractiveAction;
  /** A commit-ish in the `onto..HEAD` range (resolved via the existing ladder). */
  readonly oid: string;
  /** reword: the new message (required). squash: the combined message
   *  (optional — defaults to git's stripped combination template). Ignored for
   *  pick/edit/fixup/drop. */
  readonly message?: string;
}

interface RebaseRunInput {
  readonly upstream: string;
  readonly onto?: string;
  /** Present → interactive: the post-`$EDITOR` instruction list. */
  readonly interactive?: ReadonlyArray<RebaseInstruction>;
}
```

The instruction list **is** the edited todo: git computes a default
`pick`-everything todo, opens `$EDITOR`, and reads the result back; tsgit takes
that result directly. The caller is responsible for the same invariants git's
editor parse enforces — every instruction's `oid` must lie in the replayed range,
the first non-drop instruction may not be `squash`/`fixup` (nothing to meld into),
and an empty/all-drop list aborts.

### Result type — the `edit` stop (ADR-236)

`edit` introduces a conflict-free stop. The existing `conflict` variant carries
`conflicts: ReadonlyArray<...>`; a new variant keeps the two reasons distinct:

```ts
type RebaseResult =
  | { kind: 'rebased';   commits: ReadonlyArray<RebasedCommit> }
  | { kind: 'up-to-date' }
  | { kind: 'conflict';  commit; conflicts; remaining }
  | { kind: 'stopped';   commit: ObjectId; remaining: number };  // edit
```

`continue` resumes both `conflict` and `stopped`; the resume path reads the
`amend` file to decide amend-or-skip (see `edit` semantics above).

## Refusals (verified, faithful)

All the 22.3 refusals (dirty tree, op-in-progress, unborn, bare, bad commit-ish)
plus interactive-todo validation, surfaced before any state change:

- an instruction `oid` outside the replayed range → `INVALID_OPTION`
  (git: "is not in the list of commits to be rebased");
- the first non-`drop` instruction is `squash`/`fixup` → `INVALID_OPTION`
  (git: "cannot 'squash' without a previous commit");
- an empty or all-`drop` instruction list → `INVALID_OPTION`
  (git: "nothing to do" / "you must edit all merge conflicts"). git actually
  aborts the rebase here; tsgit refuses before detaching, which is observably
  equivalent (no state written).

`reword` with no `message` is rejected (`INVALID_OPTION`) — there is no editor to
prompt; a reword with the original message is just a `pick`.

## Module layout (hexagonal)

Extend, don't fork. New pure-domain grammar + a thin interactive engine beside
the existing command.

- **`domain/rebase/todo.ts`** — widen the grammar to all six verbs:
  `<verb> <oid> # <subject>`; add a `RebaseTodoAction` type. Keep
  `serialize`/`parse` a round-trip pair (property test).
- **`domain/rebase/squash-message.ts`** *(new)* — the combined-message template
  builder (`# This is a combination of N commits.` …) and the comment-stripping
  reduction to the default squash message. Pure; round-trip-adjacent.
- **`application/commands/internal/rebase-state.ts`** — extend `RebaseStop` /
  `RebaseState` / `writeRebaseStop` / `readRebaseState` with `amend`,
  `current-fixups`, `message-squash`, `rewritten-pending`. Add a `stopKind`
  (`'conflict' | 'edit'`) derived from the `amend` file's presence.
- **`application/commands/rebase.ts`** — add the interactive engine:
  - a planner that resolves the instruction list to `ResolvedInstruction[]`
    (full oid + verb + subject + optional message), validates the refusals;
  - a `replayInteractive` loop that threads `head`, the squash accumulator
    (group members + combined message), and the fast-forward fold;
  - `rebaseRun` branches on `input.interactive`. The non-interactive path is
    refactored to share the fast-forward-aware `replayOne` where it already
    does an equivalent job (behaviour-preserving).
- **`application/commands/internal/rebase-namespace.ts`** — no shape change
  (`run` already takes `RebaseRunInput`); the new `RebaseInstruction` type is
  re-exported from `commands/index.ts`.

Reuses unchanged: `applyMergeToWorktree`, `createCommit`, `mergeBase`,
`walkCommits`, `resolveCommitIsh`, `resolveOidPrefix`, `resolveCurrentIdentity`,
`hardResetWorktreeToCommit`, `synthesizeTreeFromIndex`, `updateRef`,
`recordRefUpdate`, `writeSymbolicRef`, `sanitizeMessage`/`stripComments`,
`computePatchId`, `writeOrigHead`.

## Cherry-pick-equivalent drop in interactive mode

git applies the patch-id pre-drop only to the **default** todo (before the
editor). Once the caller supplies an explicit todo, the listed commits are
applied as written — no implicit patch-id dropping. So `interactive` mode does
**not** run `dropCherryEquivalents`; the caller's list is authoritative. (This
matches git: a commit you explicitly `pick` is applied even if upstream already
has it.)

## Test strategy

GWT describe/it split, AAA body, `sut`, 100% line/branch/function/statement,
0 killable mutants — per `CLAUDE.md`.

**Unit** (`test/unit/.../rebase.test.ts` + state/grammar siblings)
- each verb in isolation: `drop`, `reword` (ff + non-ff, double-reword reflog),
  `edit` (stop → continue no-change → trailing-ff; stop → amend → continue),
  `squash` (ff base fold + non-ff; combined message), `fixup` (keep-message);
- the leading fast-forward fold (`start` target = last folded oid; all-pick
  no-op leaves history byte-identical);
- per-instruction `rebase: fast-forward` vs `rebase (pick)` reflog goldens;
- the `edit`/squash stop state-dir byte goldens (`amend`, `current-fixups`,
  `message-squash`, `done` verb lines);
- refusals (oid out of range, leading squash/fixup, empty list, reword w/o
  message) — each guard isolated for mutation, asserting `.data.code`.

**Property** (`domain/rebase/todo.properties.test.ts` extended;
`squash-message.properties.test.ts` new) — the six-verb todo grammar stays a
`parse(serialize(x)) ≡ x` round-trip (ADR-134); the squash-message template +
strip is a `strip(build(msgs)) ≡ join(msgs)`-style invariant.

**Interop** (`test/integration/rebase-interop.test.ts` extended, `@writes
surface: rebase`)
- `drop`/`reword`/`squash`/`fixup`: resulting tree + commit count + author
  parity vs `git rebase -i` scripted with `GIT_SEQUENCE_EDITOR`/`GIT_EDITOR`;
- bidirectional `edit`-stop resume: a tsgit `edit` stop finished by `git rebase
  --continue`, and a git `edit` stop finished by `repo.rebase.continue` (proves
  the `amend`-file state is git-readable);
- the all-pick no-op leaves HEAD byte-identical on both tools.

## ADRs this design raises

- **ADR-233** — interactive todo is supplied as a `RebaseInstruction[]` data
  list (the post-`$EDITOR` todo), not via an editor callback or an interactive
  stop-to-edit-todo loop.
- **ADR-234** — reword/squash messages are supplied inline (reword required,
  squash optional with the git-default combined template); no message-editing
  stop.
- **ADR-235** — the fast-forward fold + per-instruction fast-forward are
  replicated for byte-faithful reflogs and preserved oids (vs always
  re-creating commits).
- **ADR-236** — `edit` is a new conflict-free `stopped` result variant resumed by
  `continue`, distinguished from `conflict` by the `amend` state file.
- **ADR-237** — squash/fixup chain fidelity: faithful intermediate
  template-message commits vs final-state-only collapse.
