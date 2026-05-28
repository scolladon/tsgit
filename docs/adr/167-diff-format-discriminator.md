# ADR-167: `diff` API surface — `format` discriminator + `PatchResult` shape

## Status

Accepted (at `<sha-after-merge>`)

## Context

`repo.diff` currently returns `TreeDiff`. Phase 20.3 needs to add
patch-text output without breaking that contract. Three surface shapes
surfaced:

1. **Discriminator on options.** `repo.diff({ format: 'patch' })` →
   `PatchResult`; the existing call `repo.diff()` keeps its return
   type. TypeScript overloads narrow the return type per `format`.
2. **Separate method.** `repo.diffPatch(...)` is a sibling to
   `repo.diff(...)`. Same args, different return.
3. **Always return both.** `repo.diff()` → `{ tree, patch? }`. Patch
   is computed lazily, gated by a flag.

The trade-off is: does opting into patch text touch the existing
caller surface? Option 1 doesn't (existing callers untouched), 2
clutters the facade with parallel methods, 3 forces every caller
through a wrapper object.

## Decision

Take **option 1**: a `format?: 'tree' | 'patch'` discriminator on
`DiffOptions`, defaulting to `'tree'`. The TypeScript overload narrows
the return type:

```ts
function diff(ctx, opts?: DiffOptions & { format?: 'tree' }): Promise<TreeDiff>;
function diff(ctx, opts:  DiffOptions & { format: 'patch' }):  Promise<PatchResult>;

interface PatchResult {
  readonly format: 'patch';
  readonly text: string;
  readonly diff: TreeDiff;
}
```

`PatchResult` bundles the structured view inside the patch result so
consumers that need both ("show file list + show patch text") receive
both from one call.

## Consequences

### Positive

- Existing callers compile unchanged. No SemVer breakage, no
  deprecation cycle. New callers opt in by passing `format: 'patch'`.
- One name (`diff`) covers both shapes. Documentation tells one story
  ("call `diff`; pass `format: 'patch'` if you want the text").
- The `format` literal on `PatchResult` makes the discriminator
  *available on the return* too — consumers that hold a `DiffResult`
  union narrow safely with `result.format === 'patch'`.
- Bundling `TreeDiff` inside `PatchResult` removes the
  two-call pattern (`diff` + `diff({ format: 'patch' })`) that every
  UI consumer would otherwise need.

### Negative

- TypeScript overloads add cognitive cost in `diff.ts`. The function
  body must handle both branches; the type narrowing belongs to the
  signature, not the runtime. Tests must cover both narrowing paths
  end-to-end.
- Future `format: 'stat' | 'numstat' | ...` variants enlarge the
  return union. Each new variant ships its own overload — manageable
  until 4+ formats, at which point a registry shape would simplify.

### Neutral

- `pathPrefix` and `contextLines` live on `DiffOptions` regardless of
  `format`. When `format !== 'patch'` they are simply ignored. Acceptable
  — they're additive opt-ins.
- The `format` field on `PatchResult` (`'patch'`) is redundant when
  callers asked for `format: 'patch'`. Keeping it makes the return
  type a proper discriminated union.

## Alternatives considered

- **Option 2 (separate method).** Rejected: parallel facades drift.
  Every shared option (`from`, `to`, `detectRenames`, `pathPrefix`,
  `contextLines`) would have to be repeated on both methods or refactored
  into a shared options object — which is exactly what option 1 is.
- **Option 3 (always both).** Rejected: forces every existing caller
  through a wrapper. Either we change every `diff()` call site or we
  ship a SemVer-major break. Neither is acceptable for an additive
  feature.
