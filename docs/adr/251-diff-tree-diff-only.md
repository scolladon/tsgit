# ADR-251: `diff` returns `TreeDiff` only — no patch text on the surface

## Status

Accepted (at `010cdce1`)

## Context

`20.3` added `diff({ format: 'patch' })`, returning `PatchResult { format, text,
diff }` — a canonical unified-diff *string* bundled with the structured `TreeDiff` —
plus the rendering knobs `contextLines` (hunk context), `pathPrefix` (the `a/`,`b/`
prefixes), and the `format` selector itself (ADRs 166–169; recursive coupling
ADR-243).

Under ADR-249 a pre-rendered line must not appear on a command surface. The unified
patch *text* and `pathPrefix` are exactly that; `contextLines` only shapes the
rendered hunks; `format` only chooses text-vs-structured.

The complication: `renderPatch` is **not** show-exclusive. `rebase` writes
`.git/rebase-merge/patch` with it (a real, git-faithful on-disk artifact) and
`patch-id` hashes a rendered patch as its internal equivalence key. So the renderer
itself cannot leave `src` — only its *exposure through a command's return value*
is the offender.

## Decision

`diff(ctx, opts?)` returns the structured `TreeDiff` and nothing else:

```ts
interface DiffOptions {
  readonly from?: string;
  readonly to?: string;
  readonly detectRenames?: boolean;
  readonly recursive?: boolean;
  readonly withStat?: boolean;   // ADR-252 — opt-in line counts on each change
  // removed: format, contextLines, pathPrefix
}
diff(ctx, opts?): Promise<TreeDiff>;
```

- **Dropped (cosmetic) — option + surface:** the `format` selector, the
  `PatchResult` wrapper and its `text`, `contextLines`, `pathPrefix`. `DiffFormat`
  and `PatchResult` leave the public command surface.
- **Kept (internal):** `renderPatch` and `materialisePatchFiles` stay in `src` for
  `rebase` and `patch-id`; they are simply unreachable through a command result.
- **Kept (data selectors):** `from`, `to`, `detectRenames`, `recursive` (the
  `git diff-tree -r` flattening; ADR-243's structured behavior), `withStat`.

Patch byte-parity moves from the command to the interop test: `diff-patch-git-parity`
and `diff-patch` reconstruct the patch from the returned `TreeDiff` via
`materialisePatchFiles` + `renderPatch` and compare to live `git diff` + the frozen
golden — the same renderer, driven by the test instead of the command.

## Consequences

### Positive

- `diff` returns one honest, structured shape; no rendered string on the surface.
- The unified-diff renderer is still battle-tested (rebase / patch-id depend on it)
  and still parity-pinned — just from the test.

### Negative

- Breaking: callers using `diff({ format:'patch' }).text` must reconstruct the
  unified diff themselves. (A future `name-rev`-style follow-up could expose
  `renderPatch` as an explicit primitive if demand appears; out of scope here.)

### Neutral

- Supersedes the rendered-`text` exposure of ADRs 166–169 and ADR-243's patch
  coupling; the structured `TreeDiff` and recursive behavior they defined are
  retained. `withStat` counts are ADR-252.
