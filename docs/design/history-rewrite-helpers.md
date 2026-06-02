# Design — centralise the history-rewrite command helpers

## Goal

A pure, behaviour-preserving refactor surfaced by `rebase`'s architecture pass:
three commit-reading one-liners (`readCommitData` / `treeOf` / `subjectOf`) are
now copied **byte-for-byte** into `cherry-pick.ts`, `revert.ts`, and `rebase.ts`,
and a fourth (`requireSymbolicHead`) is copied into `cherry-pick.ts` and
`revert.ts`. Rule-of-three is met for the trio (3 copies) and the helper that
guards a symbolic HEAD (2 copies, both in the abort/skip tails). The bounded
blast radius of the `rebase` PR kept the extraction out of it (YAGNI/KISS); this
item lands it on its own.

Centralise the four into a single shared module, delete the local copies, and
import them. No SHA, ref, reflog, on-disk state, refusal, or message changes —
the four functions are moved verbatim. `npm run validate` stays green throughout.

## The duplication (verified identical)

All three command files declare, character-for-character:

```ts
const readCommitData = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return obj.data;
};

const treeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> =>
  (await readCommitData(ctx, commitId)).tree;

const subjectOf = (message: string): string => message.split('\n')[0] as string;
```

`cherry-pick.ts` and `revert.ts` additionally declare, identically (doc comment
included):

```ts
/** Read the symbolic HEAD branch, refusing a detached HEAD for `verb`. */
const requireSymbolicHead = async (ctx: Context, verb: string): Promise<RefName> => {
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation(verb, 'cannot run with detached HEAD');
  }
  return head.target;
};
```

`rebase.ts` has **no** `requireSymbolicHead` — it replays on a detached HEAD and
reattaches at the end, so it never needs the guard. The backlog's "triplicated …
`requireSymbolicHead`" phrasing is slightly loose; the function is duplicated
across two files, which still satisfies rule-of-three for the family as a whole
(the four helpers move together as one cohesive `history-rewrite` concern).

The three families of usages (`readCommitData`/`treeOf`/`subjectOf`,
`requireSymbolicHead`) total ~40 call-sites across the three files — none change;
only the declaration moves.

## Decision — `internal/history-rewrite.ts`, named exports, verbatim move

The `commands/internal/` directory is the established home for helpers shared by
sibling command modules (`current-identity.ts` — the cherry-pick/revert committer
seam; `abort-sequencer-reset.ts` — the cherry-pick/revert `--abort` tail extracted
by ADR-232 once it reached three consumers). This extraction is the exact same
shape: a shared seam pulled out once the duplication count justified it. It needs
**no new ADR** — it follows the precedent those two files set, and the *decision
to centralise* was already taken by 22.3's architecture pass and recorded in the
backlog. There is no user-judgment fork here.

- **Location:** `src/application/commands/internal/history-rewrite.ts`. The
  backlog's `history-rewrite/internal` descriptor maps onto the flat `internal/`
  convention as `internal/history-rewrite.ts` (no nested sub-directory exists or
  is warranted — every shared helper today is a flat file under `internal/`).
- **Exports:** four named exports — `readCommitData`, `treeOf`, `subjectOf`,
  `requireSymbolicHead`. `subjectOf` is pure (message → first line); the other
  three take `Context`.
- **Move semantics:** verbatim. The bodies, signatures, and the
  `requireSymbolicHead` doc comment are copied exactly; only the local `const`
  declarations in the three files are deleted and replaced by an import.
- **Imports the module needs:** `readObject` (primitive), `unexpectedObjectType`
  (`domain/objects/error`), `readHeadRaw` (`primitives/internal/repo-state`),
  `unsupportedOperation` (`domain`), and the `CommitData` / `Context` / `ObjectId`
  / `RefName` types. All already imported by the three call-sites; relative paths
  shift one level deeper (`../../` → `../../../` for domain/ports, `../` → `../../`
  for primitives) to match `internal/current-identity.ts`.

### Import-cleanup consequence

Removing the local declarations may orphan imports that *only* the moved helpers
used. Each call-site is audited after the move: an import is dropped **only** if
no remaining code in that file references it. Expected per file:

- `unexpectedObjectType` — used only by the moved `readCommitData`; dropped from
  all three command files (now lives in `history-rewrite.ts`).
- `readObject` — `cherry-pick.ts` and `revert.ts` may retain it for other reads;
  `rebase.ts` likewise. Verified per file, not assumed.
- `readHeadRaw` — `cherry-pick.ts`/`revert.ts` may still call it directly
  elsewhere; kept iff still referenced.
- `unsupportedOperation` — `rebase.ts` uses it independently (its refusals); in
  `cherry-pick.ts`/`revert.ts` kept iff still referenced after the move.

The TypeScript strict build + Biome's no-unused-import rule are the backstop: a
stale import fails `npm run check`, a missing one fails `npm run check:types`.

## Alternatives considered (and rejected)

1. **Inline at usage / leave duplicated.** Rejected: rule-of-three is met and the
   backlog explicitly scopes the centralisation; the duplication is a maintenance
   hazard (a faithfulness fix to `readCommitData` would have to be applied thrice).
2. **Co-locate in an existing `internal/*-state.ts`.** Rejected: these are
   commit-shape readers + a HEAD guard, orthogonal to the `*-state` sequencer/marker
   modules; a dedicated `history-rewrite.ts` keeps cohesion high.
3. **A nested `internal/history-rewrite/` directory.** Rejected: YAGNI — one file,
   four tiny functions; the flat `internal/` convention covers it.

## Out of scope (bounded blast radius)

- `isMergeCommit` is also duplicated in `cherry-pick.ts` and `revert.ts`
  (`(cData) => cData.parents.length >= 2`), but with *divergent* doc comments
  ("cannot be picked" vs "cannot be reverted") and only two copies. The backlog
  scopes this item to the four named helpers; `isMergeCommit` is left untouched.
  If the architecture pass (Step 7) judges it worth folding, it is the same
  family and may join — otherwise logged as a backlog follow-up, never widened
  speculatively.

## Testing

`history-rewrite.ts` gets a focused unit test
(`test/unit/application/commands/internal/history-rewrite.test.ts`) mirroring
`current-identity.test.ts`: GWT describe/it split, AAA body, `sut` variable.

- `readCommitData` — Given a commit oid Then returns its `CommitData`; Given a
  non-commit oid (a blob) Then throws `UNEXPECTED_OBJECT_TYPE` (assert the
  `.data` shape, not just the class — kills the StringLiteral/type-arg mutants).
- `treeOf` — Given a commit Then returns its tree oid.
- `subjectOf` — Given a multi-line message Then returns the first line; Given a
  single-line message Then returns it unchanged; Given an empty message Then
  returns `''` (the `split('\n')[0]` always-defined branch).
- `requireSymbolicHead` — Given a symbolic HEAD Then returns the branch
  `RefName`; Given a detached HEAD Then throws `UNSUPPORTED_OPERATION` carrying
  the `verb` + `cannot run with detached HEAD` reason (assert `.data`).

The three command files' existing unit + interop suites are unchanged and remain
the behaviour pins — they exercise every moved helper through its public command,
so a regression in the move shows up there immediately. No example test is
deleted. Coverage stays 100%; mutation target 0 killable survivors on the new
module.

### Property tests

Not applicable. `subjectOf` is "first line of a string" (a single trivial
projection, not a parse/serialize round-trip, matcher, grammar, or counting
invariant); the other three are I/O readers / a HEAD guard — integration-shaped,
not algebraic. None of the four property lenses fit; the parameterised example
sweep above is the clearer tool.

## Files touched

- `src/application/commands/internal/history-rewrite.ts` — **new**; four moved
  helpers.
- `src/application/commands/cherry-pick.ts` — delete the four local declarations,
  import them; prune orphaned imports.
- `src/application/commands/revert.ts` — delete the four local declarations,
  import them; prune orphaned imports.
- `src/application/commands/rebase.ts` — delete the three local declarations
  (`readCommitData`/`treeOf`/`subjectOf`), import them; prune orphaned imports.
- `test/unit/application/commands/internal/history-rewrite.test.ts` — **new**.
- `docs/BACKLOG.md` — flip 22.3a `[ ]` → `[x]`.
