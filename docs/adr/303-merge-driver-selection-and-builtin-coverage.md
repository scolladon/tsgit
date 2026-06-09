# ADR-303: Merge driver selection and built-in coverage

## Status

Accepted (at `e9a15c7d`)

## Context

Once the `merge` attribute is resolved for a path (ADR-302), the merge machinery must map it
to an actual merge strategy. Git recognises three **configless built-in** drivers selectable
by name — `text` (the default 3-way line merge), `binary` (≡ `-merge`: no content merge,
take *ours*, declare conflict), and `union` (keep both sides, no conflict markers) — plus
**external** drivers configured as `[merge "<name>"] driver = <command>`.

tsgit's content merge (`domain/merge/three-way-content.ts`) is a hand-rolled algorithm, not
an xdiff port. It already carries a documented limitation: on **overlapping** edits it falls
back to a **whole-file** conflict rather than git's per-region output. Git's `union` is
implemented inside xdiff (`XDL_MERGE_FAVOR_UNION`) and produces tight per-region both-sides
output — which tsgit cannot reproduce byte-for-byte without first doing the per-region merge
rework.

## Decision

This feature implements **`text`, `binary`, and external `driver=<command>` drivers.
`union` is deferred** to a backlog follow-up tied to the per-region merge rework, so it lands
byte-exact from day one rather than shipping a known-divergent approximation now.

Driver selection from the resolved `merge` attribute value:

| `merge` value                       | strategy                                            |
|-------------------------------------|-----------------------------------------------------|
| `'unspecified'` / `true` / `'text'` | built-in text → `mergeContent` (today's default)    |
| `false` (incl. via `binary` macro) / `'binary'` | take *ours*, declare conflict           |
| `'union'`                           | **deferred** → falls back to built-in text for now  |
| `'<name>'` with `[merge "<name>"].driver` | external command (ADR-304)                    |
| `'<name>'` without a configured `driver`  | fall back to built-in text (git's behaviour)  |

The `binary` outcome reuses the existing `{status:'conflict', conflictType:'binary',
markedBytes: ours}` shape that `mergeContent` already emits for binary content — so the
conflict materialisation in `merge` / `apply-merge-to-worktree` is unchanged. Crucially the
content merger is only invoked when both sides changed differently (trivial cases are
resolved upstream in `mergeTrees`), matching git's invocation point for `ll_merge`.

`[merge "<driver>"]` config (`name`, `driver`, `recursive`) is parsed into `ParsedConfig`.
`recursive` is **parsed but inert** — tsgit merges against a single base, so there is no
recursive inner merge to redirect (documented non-goal).

## Consequences

### Positive

- Full coverage of git's *configless* behaviour the merge feature actually needs (`text` +
  `binary`), plus the headline external-driver capability.
- `binary` reuses an existing outcome — no new conflict-materialisation code.
- Deferring `union` keeps the PR byte-faithful; when `union` lands it is exact, not an
  approximation that would have to be corrected later.

### Negative

- `merge=union` silently degrades to a text merge until the follow-up lands (documented;
  the only non-faithful built-in, and only for the union opt-in).

### Neutral

- `recursive` is recorded for forward-compatibility but does nothing until tsgit grows
  recursive (multi-base) merge.
