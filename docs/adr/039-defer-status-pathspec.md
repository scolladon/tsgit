# ADR-039: `status` pathspec filtering deferred from §14.2

## Status

Accepted (at `49a147e`)

## Context

BACKLOG §14.2 lists `add`, `rm`, `checkout`, AND "`status` filters"
as the scope. The first three commands take a `paths` argument and
mutate (or read against) something concrete the pathspec can filter:
working tree, index, source tree. `status` is different — it's a
read-only summary of the entire working tree state, with no `paths`
argument today.

Adding a `paths` filter to `status` means:

- New `repo.status({ paths })` option.
- Pathspec compilation in the status flow.
- A filter applied during the existing index-vs-working-tree scan
  AND the §14.3 untracked enumeration walk.

The walker hot path already does directory pruning via the ignore
predicate; adding a second predicate (pathspec) would mean composing
two predicates per leaf, with subtle semantics around "what does it
mean for a directory to be 'partially matched' by a pathspec?"

The CLI equivalent — `git status -- '*.ts'` — is rare in practice;
the common workflow is to look at the full status output and reason
about it. Callers needing a filtered view today can filter the
returned `ChangeEntry[]` array client-side, which is one `filter()`
call.

## Decision

Defer `status` pathspec filtering. §14.2 ships pathspec for `add`,
`rm`, `checkout`; `status` stays parameter-free. The BACKLOG entry is
marked accepted with a note that the `status` filter is a follow-up
(small ticket; trivial once the `compilePathspec` infrastructure
ships).

## Consequences

### Positive

- Smaller, more focused PR. Three commands changing rather than four.
- The `status` walk stays simple — exactly the §14.3 shape, no
  second-predicate composition logic.
- Callers who NEED a filtered view filter the result themselves —
  one line of TypeScript.

### Negative

- BACKLOG §14.2 is not fully closed by this PR. We tick it with the
  note "minus `status` filter — see ADR-039". A follow-up
  ticket adds the missing piece.
- A caller running `repo.status()` against a huge working tree still
  walks the whole thing even if they only care about a small slice.
  Acceptable for v1; revisit when the perf delta is measured (see
  Phase 15 bench fixtures).

### Neutral

- The `compilePathspec` + `matchesPathspec` primitives shipped in
  §14.2 are reusable when `status` does get the filter — no
  duplicate domain work.
