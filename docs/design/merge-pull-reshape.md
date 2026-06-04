# Design — merge/pull reshape

## Goal

An **API-foundation ergonomics** pass, surfaced by the 23.4 API review
(findings **S1 + S2 + S5**). It makes the merge family consistent with every
other multi-verb porcelain and removes two surface warts on `merge` / `pull`:

1. **S1 — namespace parity.** `rebase`, `cherryPick`, and `revert` are each a
   frozen nested namespace (`repo.rebase.{run,continue,skip,abort}`, …), but
   `merge` is **three flat methods** — `repo.merge(opts)`, `repo.continueMerge`,
   `repo.abortMerge`. Merge pre-dates the namespace convention (ADR-172) and is
   now the only multi-verb porcelain that does not read as a verb group. Unify it
   to `repo.merge.{run,continue,abort}`.
2. **S2 — fast-forward tristate.** `MergeOptions` / `PullOptions` carry a boolean
   *pair* `fastForwardOnly?` / `noFastForward?` that encodes a three-valued
   choice. Two of the four boolean combinations are meaningful, one is the
   default, and `{ fastForwardOnly: true, noFastForward: true }` is a
   **contradiction** the type permits. Replace the pair with a single
   `fastForward: 'only' | 'never' | 'allow'`.
3. **S5 — drop `reflogLabel`.** `MergeOptions.reflogLabel` is a public knob whose
   only purpose is internal coupling: `pull` sets it to `'pull'` so the reflog
   reads `pull: Fast-forward` instead of `merge <target>: Fast-forward`
   (ADR-197). It has **no `git merge` CLI analogue** — it models
   `GIT_REFLOG_ACTION`, which git sets from the *parent* porcelain (pull), never
   from an end-user flag. Remove it from the public option; keep the faithful
   behaviour through an internal-only channel.

This is a **breaking** API reshape (`repo.merge` stops being callable;
`repo.abortMerge` / `repo.continueMerge` are removed; the boolean pair is gone).
Breaking changes are unconstrained inside the 23.4 window (no release-bundling),
so the change is clean — **no deprecation shim, no aliases**, mirroring how
`cherryPick` / `rebase` / `revert` were born as namespaces.

## Faithfulness anchors (git)

This reshape changes **only the library's TypeScript surface**. It does **not**
change a single observable git behaviour:

- **No SHA / ref / reflog / on-disk-state change.** The fast-forward ref move,
  the merge-commit parents, `MERGE_HEAD` / `MERGE_MSG` / `ORIG_HEAD`, the
  conflicted-index stages, and every reflog message are produced by the same
  code paths, byte-for-byte. In particular `pull`'s reflog still reads
  `pull: Fast-forward` / `pull: Merge made by the 'tsgit' strategy.` (ADR-197),
  because the reflog action is preserved — just routed through an internal
  channel instead of a public field.
- **`fastForward` maps 1-to-1 onto the existing refusal semantics:**
  - `'only'` ≡ today's `fastForwardOnly: true` — refuse with `NON_FAST_FORWARD`
    when a true merge would be required (git `merge --ff-only`).
  - `'never'` ≡ today's `noFastForward: true` — always create a merge commit even
    when a fast-forward is possible (git `merge --no-ff`).
  - `'allow'` ≡ neither flag set — fast-forward when possible, else a true merge
    (git's default `--ff`).
  - The previously-permitted contradiction `{ fastForwardOnly, noFastForward }`
    is now **unrepresentable**.
- **Refusal conditions are unchanged** — `NON_FAST_FORWARD`, detached-HEAD
  refusal, `NO_OPERATION_IN_PROGRESS`, unsupported conflict types — all fire
  exactly as before; only the option that *requests* `--ff-only` is renamed.

Because the on-disk faithfulness is untouched, the existing interop suites
(`merge-abort-interop`, the merge-state-machine integration, the `merge-*` parity
scenarios, `pull-http-backend`) remain the faithfulness pins — they are updated
only mechanically (call-site `repo.merge(…)` → `repo.merge.run(…)`, boolean →
enum), never in their assertions about git-observable state.

## Surface — before → after

### `merge`

```ts
// before
repo.merge(opts: MergeOptions): Promise<MergeResult>;
repo.continueMerge(opts?: ContinueMergeOptions): Promise<ContinueMergeResult>;
repo.abortMerge(): Promise<AbortMergeResult>;

// after — frozen, non-callable namespace (ADR-193)
repo.merge.run(input: MergeRunInput): Promise<MergeResult>;
repo.merge.continue(input?: MergeContinueInput): Promise<MergeContinueResult>;
repo.merge.abort(): Promise<MergeAbortResult>;
```

```ts
interface MergeRunInput {
  readonly target: string;
  readonly message?: string;
  readonly fastForward?: 'only' | 'never' | 'allow'; // default 'allow'
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  // reflogLabel — REMOVED (internal-only now)
}

interface MergeContinueInput {           // was ContinueMergeOptions
  readonly message?: string;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  readonly noVerify?: boolean;
}

type MergeContinueResult = CommitResult; // was ContinueMergeResult
interface MergeAbortResult {             // was AbortMergeResult
  readonly origHead: ObjectId;
  readonly branch: RefName;
}
```

`merge` has **no `skip` verb** — unlike `rebase`/`cherryPick`/`revert`, a merge
applies a single integration, so there is nothing to skip. The namespace is
`{ run, continue, abort }` (three verbs), matching git's
`merge` / `merge --continue` / `merge --abort`.

### `pull`

```ts
interface PullOptions {
  readonly remote?: string;
  readonly branch?: string;
  readonly fastForward?: 'only' | 'never' | 'allow'; // default 'allow' — was the boolean pair
  readonly prune?: boolean;
  readonly depth?: number;
  readonly message?: string;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}
```

`pull` stays a flat command (`repo.pull(opts)`) — it is a single fetch+integrate
verb with no in-progress sub-state of its own (a pull conflict is resolved
through `repo.merge.continue` / `repo.merge.abort`, exactly as before). Only its
fast-forward option is reshaped.

## Internal reflog channel (S5)

`pull` must keep producing git-faithful reflog messages without a public knob.
The reflog action is threaded through an **internal-only third argument** to the
run function:

```ts
// merge.ts (NOT re-exported from the commands barrel)
interface MergeInternalOptions {
  /** GIT_REFLOG_ACTION analogue. Replaces the default `merge <target>` prefix
   *  at both reflog sites. Set by composing porcelain (pull); never public. */
  readonly reflogAction?: string;
}

export const mergeRun = (
  ctx: Context,
  input: MergeRunInput,
  internal: MergeInternalOptions = {},
): Promise<MergeResult> => { /* … */ };
```

- The namespace binds `run: (input) => mergeRun(ctx, input)` — callers never see
  the third argument.
- `pull` imports `mergeRun` and calls `mergeRun(ctx, { target, message, … }, { reflogAction: 'pull' })`.
- `MergeInternalOptions` is **not** re-exported from
  `application/commands/index.ts`, so it never reaches the public barrel,
  `reports/api.json`, or the typedoc surface. `pull` and `merge` are
  same-tier siblings in `application/commands/`, so this is in-layer coupling,
  not a leak.

This keeps `pull` genuine composition over `merge` (the 20.4 state machine still
works on pull conflicts for free) while removing the public field. It supersedes
the `reflogLabel`-as-public-field half of ADR-197 (the resolved-OID passthrough
and whole-prefix-replacement semantics are retained verbatim).

## File layout

The reshape keeps **three small implementation files** plus a binder, rather than
collapsing into one large `merge.ts`:

- `application/commands/merge.ts` — `mergeRun` (+ the existing tree-merge engine).
- `application/commands/continue-merge.ts` — `mergeContinue`.
- `application/commands/abort-merge.ts` — `mergeAbort`.
- `application/commands/internal/merge-namespace.ts` — **new** `bindMergeNamespace`
  + `MergeNamespace`, mirroring `bindRebaseNamespace` / `bindCherryPickNamespace`.

Rationale: `merge.ts` is already ~695 lines (the three-way tree-merge engine);
folding `continue` (~30 lines) and `abort` (~50 lines) in would push it against
the 800-line ceiling with no headroom, against the "many small files" principle.
The three verbs are genuinely distinct concerns with different dependency sets
(tree-merge engine / commit finalisation / hard-reset recovery). The **binder**
delivers the surface parity — which is the actual requirement — exactly as the
sibling binders do; the siblings' monolithic single-file layout is incidental,
not a contract. (The function/file names already share the `merge` stem, so
file⇄symbol naming stays aligned: `merge.ts` → `mergeRun`, plus the
`continue-merge.ts` / `abort-merge.ts` verb files.)

## Affected files

**Source:**
- `application/commands/merge.ts` — rename `merge` → `mergeRun`; `MergeOptions`
  → `MergeRunInput`; drop `reflogLabel`; add `MergeInternalOptions` + the
  internal third arg; replace the boolean pair with `fastForward` (translate the
  two guard checks: `base === ourId && fastForward !== 'never'` → fast-forward;
  `fastForward === 'only'` → `nonFastForward(...)`).
- `application/commands/continue-merge.ts` — rename `continueMerge` →
  `mergeContinue`; `ContinueMergeOptions` → `MergeContinueInput`;
  `ContinueMergeResult` → `MergeContinueResult`.
- `application/commands/abort-merge.ts` — rename `abortMerge` → `mergeAbort`;
  `AbortMergeResult` → `MergeAbortResult`.
- `application/commands/internal/merge-namespace.ts` — **new** binder + type.
- `application/commands/pull.ts` — `fastForward` enum forwarded to `mergeRun`;
  reflog action via the internal third arg (drop `reflogLabel`).
- `application/commands/index.ts` — re-export the renamed symbols +
  `bindMergeNamespace` / `MergeNamespace`; drop the old names.
- `repository.ts` — `merge` becomes `commands.MergeNamespace` bound via
  `bindMergeNamespace`; remove the flat `merge` / `abortMerge` / `continueMerge`
  bindings + their interface members.

**Tests (mechanical):** `merge.test.ts`, `continue-merge.test.ts`,
`abort-merge.test.ts`, `pull.test.ts`, `repository.test.ts`,
`merge-state-machine.test.ts`, `merge-abort-interop.test.ts`,
`pull-http-backend.test.ts`, and the `merge-ff` / `merge-abort` /
`merge-continue` parity scenarios — call-site + key-list updates only.

**Docs:** `docs/use/commands/merge.md` (fold in the namespace + the abort/continue
verbs, enum), `pull.md` (enum), `docs/use/commands/README.md` (drop the
`abortMerge` / `continueMerge` index rows, delete `abort-merge.md` /
`continue-merge.md` — single page per namespace, as for `rebase`),
`migrate-from-isomorphic-git.md` (call sites), `README.md` (Tier-1 count),
`reports/api.json` (regenerated), `docs/BACKLOG.md` (flip 23.4d).

## Decisions (ADRs)

Three load-bearing choices, each captured as an ADR in the ADR conversation:

1. **Namespace reshape** — `repo.merge.{run,continue,abort}` as a frozen
   non-callable namespace (ADR-193), **superseding ADR-172**. ADR-172 rejected
   the namespace because `repo.merge` was *callable* and a callable-object
   intersection was hard to type; ADR-193's non-callable rule removes that
   objection entirely (`repo.merge` is now a plain object, never invoked).
2. **`fastForward` tristate** — `'only' | 'never' | 'allow'`, default `'allow'`,
   on both `MergeRunInput` and `PullOptions`; the contradictory boolean state is
   made unrepresentable.
3. **Internal reflog channel** — drop public `reflogLabel`; thread the reflog
   action through `MergeInternalOptions`, superseding the public-field half of
   ADR-197.

## Test plan

- **Namespace surface** (`repository.test.ts`): `merge` is a frozen object whose
  `run`/`continue`/`abort` are functions; `abortMerge`/`continueMerge` are gone
  from the top-level key list; `merge` joins the namespace-key set; the guard
  fires on a disposed repo for each verb.
- **`fastForward` enum** (`merge.test.ts`, `pull.test.ts`): isolated tests for
  each value — `'only'` refuses a true merge with `NON_FAST_FORWARD`; `'never'`
  forces a merge commit on a fast-forwardable history; `'allow'` (and omitted)
  fast-forwards. Each guard condition tested independently (mutation-resistant).
- **Internal reflog** (`pull.test.ts`): pull's fast-forward + merge-commit reflog
  messages still read `pull: …` (the existing assertions, re-pointed at the new
  call shape); `merge.run` alone still reads `merge <target>: …`.
- **Faithfulness** (interop/parity, mechanical): unchanged assertions, updated
  call sites.
- **Coverage / mutation:** 100% line/branch/function on every touched file; 0
  killable mutants (the boolean→enum translation and the internal-arg default are
  the new mutation surfaces).
