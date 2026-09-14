---
subjects:
  - src/application/primitives/update-ref.ts
  - src/application/primitives/types.ts
  - src/application/primitives/ref-store.ts
  - src/application/primitives/reftable-transaction.ts
  - src/application/primitives/atomic-write.ts
  - src/domain/refs/packed-refs.ts
  - src/application/commands/fetch.ts
  - src/application/commands/branch.ts
  - src/application/commands/tag.ts
  - src/application/commands/remote.ts
  - src/application/commands/commit.ts
  - src/application/commands/merge.ts
  - src/application/commands/reset.ts
  - src/application/commands/abort-merge.ts
  - src/application/commands/cherry-pick.ts
  - src/application/commands/revert.ts
  - src/application/commands/internal/abort-sequencer-reset.ts
---
# 871 — `updateRef` dereferences symbolic refs and deletes as git's ref transaction does

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (Ref write and delete semantics, and memory-adapter parity: U3, U4, U5, U6, O1, O3; gap G2) · **Supersedes/Refines:** refines ADR-226 and ADR-864 (its null-id delete note moves here)

## Context

`updateRef` never follows a symbolic ref. `updateRef('refs/heads/s', id)` with `s → x` replaces
`s` with a direct ref, and `updateRef('HEAD', id)` detaches `HEAD`. Its delete path removes the
loose file of whatever name it is given, refuses an absent ref `REF_NOT_FOUND`, refuses a
packed-only ref `UNSUPPORTED_OPERATION` (`delete-packed-ref`) — which `fetch --prune` catches and
skips — and leaves a loose-and-packed ref's packed value behind, so the ref resurrects. It writes no
`logs/HEAD` entry when it deletes the branch `HEAD` points at, and it takes no lock.

git's ref transaction, pinned against git 2.55.0 (design matrices S, X, R, Q):

- An update is split at each symbolic hop until a non-symbolic ref: the terminal's value changes,
  every symref walked gets a log-only entry (logged even when the value does not change), and the
  compare-and-swap reads the terminal's value while refusals name the given ref (S1–S12). The walk
  has no depth cap; a name met twice refuses `multiple updates … not allowed` (S13, S14).
  `--no-deref` acts on the name itself, reading a symref's old value from its referent (S15–S21,
  S27, S28), and refuses a null old value on a dangling symref (`dangling symref already exists`).
- When `HEAD` names a ref the update touches, `logs/HEAD` gains an entry — on writes and on deletes
  alike, for `-d` and the null id (S1, S22–S26, X2, X3, X9, X11, X12, X15).
- A delete of an absent ref succeeds (X1). A delete through a symref deletes the target and keeps
  the symref (X4, X8); `--no-deref` deletes the symref (X6, X7, X10).
- A delete takes the loose ref's lock and `packed-refs.lock` — even for an absent ref — and refuses
  when either is held (X13, Q5); a non-delete never takes `packed-refs.lock` (Q6). When the name is
  packed, `packed-refs` is rewritten without it and its `^` line, under git's canonical header,
  sorted, with every other line and peeled value copied and nothing peeled (Q1–Q3, Q7–Q11).
- The two backends log three shapes differently: the old id of a `HEAD` entry coupled through a
  walked symref is the null id on the files backend and the resolved value on reftable (S23, S24,
  X11); a delete of an absent target still writes its split log-only entries (`0{40} 0{40}`) on the
  files backend and none on reftable (X5, X14, X16); a `--no-deref` delete of a symref removes its log
  on the files backend and keeps it, with a deletion entry, on reftable (X6).
- A null new id deletes, exactly as `-d` does, and is never verified (the `!is_null_oid` guard).
- Commands keep their own refusals before deleting (R1–R4); `branch -D`, `tag -d` and `remote remove`
  delete a symref as itself (R5, R6, R10); `branch -f`, `tag -f`, `notes` and `push`'s tracking
  update write through one (R7, R14, R15); `fetch --prune` never deletes a symref and deletes
  packed-only tracking refs (R8); `remote rename` moves packed-only tracking refs, rewriting
  `packed-refs` without them and writing the new names loose (R9, R18).
- Renaming the branch `HEAD` names writes two `logs/HEAD` entries on both backends —
  `<id> 0{40} Branch: renamed <from> to <to>`, then `0{40} <id> Branch: renamed …` (R11, R12, R17).
  tsgit's `branch.rename` writes none today.

## Options considered

Symbolic refs on the write path (U5):

1. **Dereference by default and add `noDeref`** (chosen by the user) — pros: `updateRef` behaves as
   `git update-ref` does for every pinned row, and a caller can still act on a symref itself. Cons:
   every caller has to be classified, and callers that delete a symref as itself must now say so.
2. **Keep acting on the name, add an opt-in `deref`** — pros: no caller changes. Cons: the primitive
   keeps diverging from its git counterpart by default, and every caller that should dereference
   stays wrong until it opts in.
3. **Keep today's behaviour and record it** — cons: `updateRef('HEAD', id)` keeps detaching `HEAD`.

Deleting an absent ref (U3):

1. **A no-op success, as git** (chosen) — pros: matches `update-ref -d` and the null id. Cons: a
   caller that relied on `REF_NOT_FOUND` must check first.
2. **Keep refusing** — cons: diverges from git's transaction.
3. **An option selecting either** — cons: a knob with no git counterpart.

The coupled `logs/HEAD` entry on a delete (U6):

1. **Every delete path writes it** (chosen) — pros: `-d` and the null id log the same bytes git does.
   Cons: a caller that logged `HEAD` itself has to stop.
2. **The null id only** (ADR-864's note) — cons: `delete: true` diverges from `-d`.
3. **An explicit `logHead` option** — cons: a knob with no git counterpart.

Packed refs on delete (U4):

1. **Rewrite `packed-refs` under `packed-refs.lock`, as git** (chosen) — pros: packed-only and
   loose-and-packed deletes match git, and `fetch --prune`'s skip goes. Cons: an O(packed refs)
   rewrite per packed delete, and two lock files per delete.
2. **Keep refusing `delete-packed-ref`** — cons: `fetch --prune` keeps leaving stale refs; a
   loose-and-packed delete keeps resurrecting the packed value.

Decided within the design, with the choice recorded here:

- **Backend differences** — transcribe each backend's shape (chosen) · take one shape on both, recording
  the other as a residual. Pros of the choice: both backends match their git counterpart byte for byte.
  Cons: a three-field table keyed on `ctx.layout.refStorage` inside `updateRef`.
- **Chain bound** — none but repetition, as git (chosen) · reuse `MAX_SYMBOLIC_REF_DEPTH` · a larger
  constant. A cap would refuse chains git writes through.
- **The loose ref's lock on delete** — taken with `packed-refs.lock` (chosen) · packed lock only. Same
  transaction step and refusal class; without it a held `<ref>.lock` is ignored.
- **`branch.rename`'s `logs/HEAD` entries** (design O1, chosen by the user: option a) — write git's two
  entries · a rename delete that logs nothing, leaving today's zero entries · the delete's entry only. Pros of
  the choice: rename's `logs/HEAD` bytes match git on both backends; it is a fix, not a preserved behaviour.
  Cons: rename's `HEAD` re-point stops going through `writeSymbolicRef`.
- **`remote.rename`'s packed-only refusal** (design O3, chosen by the user: option a) — remove it with U4 ·
  keep it as a residual · a follow-up. The refusal's only stated reason was the missing packed rewrite.
- **Callers that pass `HEAD`'s symbolic target** (`commit`, `merge`, `reset`, `merge --abort`,
  `cherry-pick`, `revert`, the sequencer's abort) — switch to `HEAD`, as git writes (chosen) · keep the
  target. The entries are identical for a direct target; only `HEAD` reproduces git's coupled old id
  through `HEAD → symref → branch` on the files backend, and a refusal then names `HEAD` as git does.

## Decision

**U5, U3, U6 and U4 option 1 each, with the design-level choices above.**

`UpdateRefOptions` gains `noDeref?: boolean` on both arms and an optional `reflogMessage` on the
`delete: true` arm (the message of the `logs/HEAD` and symref entries a delete writes; empty when
omitted). `updateRef` validates the name, (verifies the target — ADR-864 — unless deleting), resolves
the write chain, reads `HEAD` for coupling, checks `expected`, and applies every update in one
`applyRefUpdates` call, so nothing is written before a refusal:

- **The chain** (`internal/ref-write-chain.ts`): walked, the symrefs visited in order and the
  terminal with its value; a visited-name `Set` refuses a repeat with
  `REF_CYCLE_DETECTED { chain }` before any write. With `noDeref`, the name is the terminal and a
  symref's old value is read through the existing read chain, whose failure counts only when
  `expected` is set.
- **The compare-and-swap** reads the terminal's value and names the given ref:
  `REF_UPDATE_CONFLICT { name, expected, actual }`. A `noDeref` null old value on a dangling symref
  refuses with `expected` and `actual` both `'absent'` — the only case where they are equal, from
  which git's `dangling symref already exists` composes. No new code or field.
- **A write** sets the terminal (reflog skipped when unchanged), appends an entry to every walked
  symref, and the coupled `HEAD` entry when `HEAD` names the terminal or a walked symref and is not
  the first link itself.
- **A delete** — `delete: true` or the null id — deletes the terminal, appends `<old> 0{40}` to every
  walked symref and the coupled `HEAD` entry, applying the backend table
  (`internal/ref-transaction-logging.ts`) for the three differences above, and on reftable a
  `noDeref` symref delete keeps its log and gains the deletion entry.
- **Both stores' deletes** are no-ops for an absent ref. The files backend's delete takes
  `<ref>.lock` (`REF_LOCKED { name }`) when the ref's directory exists — a lock cannot exist without
  it, and taking it would create directories git leaves absent — then `packed-refs.lock`
  (`RESOURCE_LOCKED { resource: 'ref', path }`), rewrites `packed-refs` through a pure
  `packedRefsWithout` when the name is packed (header alone for zero refs), then removes the loose
  file and its log. A malformed `packed-refs` refuses `INVALID_PACKED_REFS` before anything is
  committed. The reftable backend's delete keeps a symbolic record's logs.
- **Callers**: the ten call sites that pass `HEAD`'s symbolic target, in seven files, pass `HEAD`; `branch.delete`, `branch.rename`'s delete,
  `tag.delete` and `remote.remove` pass `noDeref: true`; `fetch --prune` skips symbolic tracking refs
  and loses its packed-only catch. Every other caller is unchanged (design caller audit: A 5, B 7,
  C 10, D 4, E 1).

- **`branch.rename`** of the branch `HEAD` names deletes the old name with `noDeref` and
  `reflogMessage: branchRenamed(from, to)` — U6's coupled entry is git's first `logs/HEAD` line — and
  re-points `HEAD` with one `setSymbolic` update carrying the `0{40} <id>` entry, git's second line. A
  rename of any other branch writes no `HEAD` entry.
- **`remote.rename`** drops `assertRenamableTrackingRef` (`rename-packed-tracking-ref`): a packed-only
  tracking ref is written under its new name and deleted from `packed-refs` through U4's locked
  rewrite.

**Still open (design O5, O6):** the reftable backend's renamed-branch log shape (R16, R17), and
`remote.rename`'s reflog outcome and `<remote>/HEAD` re-point (R18, R19).

## Consequences

`updateRef` now does what `git update-ref` does for a symbolic ref, an absent ref, a packed ref and
the branch `HEAD` points at. A caller that passed a symref name to replace it must pass `noDeref`; one
that relied on `REF_NOT_FOUND` from a delete must check first; one that caught `delete-packed-ref`
has nothing to catch. `fetch --prune` deletes packed-only stale tracking refs and stops pruning
`refs/remotes/<remote>/HEAD`. A raced `commit`, `merge`, `reset`, `cherry-pick` or `revert` refuses
with `name: 'HEAD'`. `branch.rename` of the checked-out branch starts writing git's two `logs/HEAD`
entries where it wrote none. `remote.rename` stops refusing `UNSUPPORTED_OPERATION`
(`rename-packed-tracking-ref`) for a packed-only tracking ref: it renames it, leaving `packed-refs`
without the old line and the new name loose, as git does (R18).

Every files-backend delete costs two lock files and, for a packed name, one rewrite of
`packed-refs`. A symref write costs one read and one reflog append per hop.

`UpdateRefOptions` changes shape; `reports/api.json` and `docs/use/primitives/update-ref.md` (whose
signature block documented a `{ oldId?, message? }` shape the type never had) change with it.

Residuals, recorded: empty `refs/…` and `logs/…` directories are not removed after a delete (git
removes them; the port has no directory removal that works on Node); `fetch --prune` and
`remote.remove` delete one ref per transaction, so a batch rewrites `packed-refs` once per packed name
and is not atomic; `packRefs` still writes `packed-refs` without its lock; a `sorted` trait over
unsorted lines makes git miss the ref where tsgit finds it; `remote.rename` still leaves
`refs/remotes/<old>/HEAD` where git re-points it, and still writes a `0{40} <id> remote: renamed <from> to <to>`
entry on each new name instead of moving the old log (open item O6); the reftable backend's rename
branch-log shape is open item O5.

ADR-864's closing note on the null id now points here.
