# ADR-263: `merge` becomes a `repo.merge.{run,continue,abort}` namespace

## Status

Accepted (at `63342156`)

Supersedes [ADR-172](172-flat-abort-continue-surface.md).

## Context

`merge` is a multi-verb porcelain: the merge itself plus the in-progress verbs
`--continue` / `--abort`. It is exposed as **three flat methods** —
`repo.merge(opts)`, `repo.continueMerge(opts?)`, `repo.abortMerge()` — decided by
ADR-172 (Phase 20.4), which predicted Phase 22 would follow with more flat
`abort*`/`continue*` pairs.

That prediction did **not** hold. Phase 22 shipped `cherryPick` (ADR-217),
`revert`, and `rebase` (ADR-230) each as a **frozen, non-callable nested
namespace** (`repo.cherryPick.{run,continue,skip,abort}`, …), per the ADR-181 /
193 namespace convention. `merge` is now the **only** multi-verb porcelain that
is not a verb group, and the lone surface where `repo.merge.` autocomplete does
not reveal its in-progress verbs.

ADR-172's chief objection to a namespace was typing: `repo.merge` was a *callable
function*, and turning it into a callable object with `.abort` / `.continue`
properties needs a TypeScript intersection the `BindCtx` helper can't express.
ADR-193 settled the convention as a **non-callable** namespace — so this
objection no longer applies: `repo.merge` becomes a plain frozen object, never
invoked directly.

This is sequenced inside the 23.4 breaking window (no release-bundling), so the
migration is clean.

## Decision

Ship a frozen, non-callable nested namespace `repo.merge` with verbs **`run` /
`continue` / `abort`**, bound via `bindMergeNamespace(ctx, guard)` mirroring
`bindRebaseNamespace` / `bindCherryPickNamespace`.

```ts
interface MergeNamespace {
  readonly run: (input: MergeRunInput) => Promise<MergeResult>;
  readonly continue: (input?: MergeContinueInput) => Promise<MergeContinueResult>;
  readonly abort: () => Promise<MergeAbortResult>;
}
```

- **No `skip` verb.** Unlike the history-rewrite namespaces (which replay a list
  of commits), a merge applies a single integration — there is nothing to skip.
  The three verbs map exactly to git `merge` / `merge --continue` /
  `merge --abort`.
- **Symbol renames for verb parity:** the impl functions become `mergeRun` /
  `mergeContinue` / `mergeAbort` (cf. `rebaseRun` / `rebaseContinue` / …); the
  public types become `MergeRunInput` (was `MergeOptions`), `MergeContinueInput`
  (was `ContinueMergeOptions`), `MergeContinueResult` (was `ContinueMergeResult`),
  `MergeAbortResult` (was `AbortMergeResult`). `MergeResult` /
  `MergeConflictDescriptor` keep their names.
- **Clean break, no aliases.** The flat `repo.merge` / `repo.abortMerge` /
  `repo.continueMerge` methods and the `merge` / `abortMerge` / `continueMerge`
  barrel functions are removed outright — consistent with the siblings, which
  were born as namespaces and never carried a flat form.
- **File layout** keeps three small impl files (`merge.ts`, `continue-merge.ts`,
  `abort-merge.ts`) plus the `internal/merge-namespace.ts` binder, rather than
  collapsing into one large file — `merge.ts` is already ~700 lines and the three
  verbs are distinct concerns. The binder delivers the surface parity; a
  single-file layout is incidental to the siblings, not a contract.

## Consequences

### Positive

- Identical idiom to the four sibling multi-verb namespaces; one binding pattern;
  the verb group reads cohesively and is discoverable via `repo.merge.`
  autocomplete.
- Removes the last flat-vs-namespace inconsistency in the porcelain surface.

### Negative

- Breaking: every caller of `repo.merge(...)` / `repo.abortMerge()` /
  `repo.continueMerge(...)` migrates to the `.run` / `.abort` / `.continue` form.
  Bounded by the 23.4 window.

### Neutral

- `pull` stays a flat command — it is a single fetch+integrate verb whose
  in-progress state is a *merge's* state, resolved through `repo.merge.continue` /
  `repo.merge.abort`.
- The doc-coverage check (`check-doc-coverage.ts`) already recognises
  `commands.\w+Namespace` bindings, so `merge` stays enforced; `abortMerge` /
  `continueMerge` drop out of the required set, and their standalone doc pages
  fold into `merge.md` (single page per namespace, as for `rebase`).
