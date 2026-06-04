# ADR-265: `pull`'s reflog action moves to an internal channel; public `reflogLabel` is dropped

## Status

Accepted (at `63342156`)

Supersedes the public-field half of
[ADR-197](197-pull-oid-passthrough-merge-reflog-label.md).

## Context

ADR-197 gave `MergeOptions` a public `reflogLabel?: string` — the library
analogue of `GIT_REFLOG_ACTION`. Its sole purpose is internal: `pull` sets
`reflogLabel: 'pull'` so a pull-initiated fast-forward / merge reflog reads
`pull: Fast-forward` / `pull: Merge made by the 'tsgit' strategy.` instead of a
direct merge's `merge <target>: …`.

The 23.4 API review (finding **S5**) flags this as a leak: `reflogLabel` has **no
`git merge` CLI analogue**. git sets `GIT_REFLOG_ACTION` from the *parent*
porcelain (pull/rebase/…), never from an end-user `git merge` flag — so exposing
it as a public merge option is *less* faithful than not. It is pure
implementation coupling between two sibling commands.

The faithful reflog behaviour (resolved-OID passthrough, whole-prefix
replacement) from ADR-197 must be retained — only the public field is in question.

## Decision

Drop `reflogLabel` from the public option (`MergeRunInput`). Thread the reflog
action through an **internal-only third argument** to `mergeRun`:

```ts
// merge.ts — NOT re-exported from application/commands/index.ts
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

- The reflog sites read `internal.reflogAction ?? \`merge ${input.target}\``
  (whole-prefix replacement preserved from ADR-197).
- `repo.merge.run` binds `(input) => mergeRun(ctx, input)` — end users never see
  the third argument.
- `pull` imports `mergeRun` and calls
  `mergeRun(ctx, { target, message, … }, { reflogAction: 'pull' })`.
- `MergeInternalOptions` is **not** re-exported from the commands barrel, so it
  never reaches `src/index.ts`, `reports/api.json`, or the typedoc surface.
  `merge` and `pull` are same-tier siblings in `application/commands/`, so this is
  in-layer composition, not a leak.

Alternatives considered and rejected:

- **Context-carried `GIT_REFLOG_ACTION`** — most literally git-faithful, but it
  mutates the shared frozen `Context` per call and is heavy wiring for a single
  consumer; the env-var model buys nothing here over a direct argument.
- **Keep `reflogLabel` but tag it `@internal`** — only cosmetically hides the
  field; it still physically exists on the runtime option object, so the leak is
  not actually removed.

## Consequences

### Positive

- The public merge surface carries no option without a `git merge` analogue;
  more faithful, smaller surface.
- `pull` stays genuine composition over `merge` (the 20.4 state machine still
  resolves pull conflicts for free); byte-faithful `pull: …` reflog retained.

### Negative

- Breaking: any caller passing `reflogLabel` to `merge` loses the knob (it was an
  unusual, non-git power feature). Bounded by the 23.4 window.

### Neutral

- The ADR-197 resolved-OID passthrough and whole-prefix-replacement semantics are
  retained verbatim; only the field's *visibility* changes.
