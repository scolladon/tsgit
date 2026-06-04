# ADR-260: De-leak the snapshot wiring internals; defer source accessors

## Status

Accepted (at `dd50478e`)

## Context

The 23.4 API review (finding S7) flagged the lazy-snapshot read surface
(`repo.snapshot.*`) on two axes:

1. **Leaked wiring.** The legacy `src/index.ts` barrel re-exports the snapshot
   *factory functions* (`createIndexSnapshot`, `createTreeSnapshot`,
   `createWorkdirSnapshot`, `createStashSnapshot`, `createSnapshotFactory`) and
   their dependency-injection shapes (`IndexSnapshotDeps`, `TreeSnapshotDeps`,
   `WorkdirSnapshotDeps`, `SnapshotFactoryDeps`). These are internal composition
   details — consumers read snapshots through `repo.snapshot.*` and never
   hand-wire a resolver stack — yet they sit on the public barrel.

2. **Ergonomics.** The review asked whether to add first-class source accessors
   (`repo.tree(rev)` / `repo.index` / `repo.workdir` / `repo.stash`) so callers
   need not spell `repo.snapshot.*` for the common sources.

The review also confirmed the **name** `snapshot` is correct and must not be
renamed (git's model is "snapshots, not deltas"; the iteration-stability
invariant *is* database snapshot isolation). The backlog framed the accessors as
a *"consider"*, bounded by the over-design caution that governs all of 23.4
(*"force nothing until the right shape is evident from the full surface"* —
23.4j) and closed with **"No rename — only the leaked exports go."**

Two frictions surfaced while weighing the accessors:

- **`repo.stash` collides** with the existing stash *command* namespace
  (`repo.stash.{push,list,apply,pop,drop}`); it cannot be a plain source getter
  without reshaping shipped porcelain.
- **`repo.tree(rev)` is not an alias.** `repo.snapshot.tree(oid)` takes a
  resolved tree `ObjectId`; `repo.tree(rev)` would take a revision string and
  must rev-parse + peel-to-tree — the heart of 23.4c (`readFileAt(rev, path)`)
  and 23.4e (the `rev` vocabulary). Building it here preempts two
  not-yet-designed items.

## Decision

**Deliverable 1 — de-leak the wiring (do now).**

- Drop the nine wiring re-exports from `src/index.ts`. The barrel keeps every
  public type a `repo.snapshot.*` consumer must name — `SnapshotFactory`,
  `StashSnapshot`, `WorkdirSnapshotOptions`, `Snapshot`/`SnapshotEntry`/
  `SnapshotOptions`/`TreeSnapshot`/`IndexSnapshot`/`WorkdirSnapshot`,
  `TreeEntry`/`IndexEntry`/`WorkdirEntry`, and the `join`/`innerJoin`/
  `requireSnapshot` helpers.
- Demote the four `*Deps` interfaces to module-local (non-exported) — they are
  pure DI shapes with zero external referents once the barrel re-export is gone.
- Keep the `create*` factory functions exported **from their own modules**
  (`repository.ts` and the unit tests consume them by direct path); only their
  advertisement on the barrel and their `*Deps` types go.

This is breaking for the legacy barrel surface, which the 23.4 window allows
without a deprecation cycle. It is otherwise behaviour-preserving — no SHA, ref,
reflog, on-disk state, refusal, or output change — and does not touch
`reports/api.json` (`src/index.ts` is not a typedoc entry point).

**Deliverable 2 — source accessors: defer all four.**

Do **not** add `repo.tree(rev)` / `repo.index` / `repo.workdir` / `repo.stash`
in this slice. Reasons: the `repo.stash` collision; `repo.tree(rev)`
preempting 23.4c/e; and `repo.index`/`repo.workdir` being thin getters whose
final shape belongs to the read-model convergence capstone (23.4j), which is
explicitly gated on the over-design caution. Bare-property getters would also be
*less capable* than the methods they shadow (they cannot carry
`SnapshotOptions` / `WorkdirSnapshotOptions`), so they would introduce a
duplicate, asymmetric surface. The accessors are **deferred, not dropped** —
recorded as a backlog follow-up so the weigh is revisited once the command set
has proven the read model out.

## Consequences

### Positive

- The public barrel stops advertising un-callable-by-design wiring; the snapshot
  surface is exactly `repo.snapshot.*` + the named types a consumer needs.
- The `*Deps` shapes become truly private — intent-revealing encapsulation, not
  just a barrel omission.
- Minimal, mostly-subtractive diff; no new surface to maintain or later reshape;
  `reports/api.json` unchanged.
- The accessor shape stays open for 23.4j to decide holistically, avoiding a
  premature, asymmetric `repo.index`/`repo.workdir` duplication and a
  `repo.tree(rev)` that would preempt 23.4c/e.

### Negative

- Callers keep spelling `repo.snapshot.index()` / `repo.snapshot.workdir()`
  rather than a shorter `repo.index` / `repo.workdir`. Accepted: the saving is
  one word and the deferred accessors remain on the backlog.
- Removing the leaked barrel exports breaks any (undocumented, non-entry-point)
  consumer that imported them from `@scolladon/tsgit`'s legacy main. Accepted:
  they were never part of the supported surface and the 23.4 window permits the
  break.

### Neutral

- The `snapshot` name is reaffirmed, not changed.
- The `create*` factories remain reachable by direct module path for internal
  wiring and tests; only their public advertisement changes.
