# ADR-022: `reset --mixed` pathspec scope (Phase 13.2)

## Status

Accepted (at `62336f3b89c7f2bc1d54876ce9c4ffe53b7022e2`)

## Context

Canonical git accepts `git reset --mixed <commit> -- <pathspec>` to
rebuild the index entries for `<pathspec>` only, leaving the
remaining index entries untouched and **not** moving HEAD. This is
the form `git reset -- <path>` (no commit) uses to unstage.

The Phase 13.2 BACKLOG line says only _"clear index entries beyond
the lock-release stub"_ — it doesn't mandate pathspec. The
question is whether to add pathspec support now or defer.

Forces:

- **Surface stability.** Adding `paths` to `ResetOptions` is a
  v1.x-additive change either way (no breakage). Adding it later
  means a follow-up PR; adding it now means a wider blast
  radius in this PR.
- **Pathspec glob support is Phase 14.2.** A pathspec API that
  only accepts literal paths now, then later accepts globs, is a
  half-shipped feature. Users will pass `'*.ts'` and get nothing
  back.
- **HEAD-move semantics differ with pathspec.** `git reset
  <commit> -- <path>` does NOT move HEAD (it's purely an index
  rewrite). `git reset <commit>` (no paths) does. Mixing the two
  in one function makes the result type's `id`/`branch` fields
  conditional on the absence of `paths`. The Phase-13.1 checkout
  surface has exactly this complication — adding it twice doubles
  the testing surface.
- **The Phase 13.3 (`reset --hard`) caller doesn't need pathspec.**
  Hard reset is whole-tree by definition.

## Decision

**Defer pathspec support to Phase 14.2.** Phase 13.2 ships only
the whole-tree form:

```ts
export interface ResetOptions {
  readonly mode: ResetMode;
  readonly target: string;
}
```

No `paths` field added. The current shape stays exactly as it is in
`main`; only the side effect changes.

Phase 14.2 will:

1. Extend `ResetOptions` to a discriminated shape:
   `ResetWholeTreeOptions | ResetPathspecOptions`. Mirror ADR-020's
   "structural discriminator via presence of field" pattern.
2. Add pathspec resolution that consumes glob support (the
   point of Phase 14.2).
3. Adjust `ResetResult` so `id` / `branch` are conditional on
   whole-tree mode.

## Consequences

### Positive

- **Phase 13.2 stays small.** One primitive + a five-line wiring
  change in `reset.ts`. Easy to review, easy to mutation-test, no
  new public surface.
- **Pathspec lands once, complete.** When Phase 14.2 introduces
  glob support, the `reset` API gets it at the same moment as
  `add`, `rm`, `checkout`, `status` — consistent surface, one PR
  reviews it all.
- **No half-feature in v1.x.** Users won't find a `paths` field
  that accepts only literals.

### Negative

- **Users who want to unstage today** can't `repo.reset({ mode:
  'mixed', target: 'HEAD', paths: ['foo.ts'] })`. They can
  approximate via `repo.rm({ cached: true, paths: ['foo.ts'] })`
  (already shipped) or wait for Phase 14.2.
- **The Phase 14.2 plan will need to amend `ResetOptions`** — a
  v1.x-additive change. Mitigated by ADR-020's discriminator
  pattern: existing call sites stay compatible.

### Neutral

- Aligns with how `checkout` shipped (Phase 13.1): whole-tree
  switch in 13.1, path-restore in the same PR but as a separate
  branch of the discriminated union. Phase 14.2 will do the same
  for `reset`.

## Alternatives considered

- **Add pathspec now, literals only.** Rejected — half-feature.
  Users would learn the API, get used to literals, then have to
  re-learn when globs land.
- **Add pathspec now, with full glob support.** Rejected — drags
  Phase 14.2's scope into this phase, blowing up the diff and
  delaying the index-rebuild that 13.3 depends on.
