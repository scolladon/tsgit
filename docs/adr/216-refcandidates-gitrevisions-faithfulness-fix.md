# ADR-216: fix `refCandidates` to the full gitrevisions ref-DWIM ladder

## Status

Accepted (at `5fa805d6`)

## Context

`src/domain/refs/ref-candidates.ts` advertises itself as "the gitrevisions
ref-DWIM ladder" shared by `rev-parse` and `merge`'s `resolveTarget`, but
diverges from the canonical 6-rule order (gitrevisions §"Specifying revisions")
in three ways:

| gitrevisions rule | tsgit today |
|---|---|
| 1. `$GIT_DIR/<name>` (HEAD, MERGE_HEAD, **refs/stash** via verbatim) | ✅ `base` verbatim |
| 2. `refs/<name>` | ❌ missing — blocks `stash` / `stash@{N}` |
| 3. `refs/tags/<name>` | present, **after** heads |
| 4. `refs/heads/<name>` | present, **before** tags (order swapped) |
| 5. `refs/remotes/<name>` | ✅ |
| 6. `refs/remotes/<name>/HEAD` | ❌ missing |

This is a genuine faithfulness gap, not a design choice. `stash` does not depend
on it (it owns an index-addressed reflog reader, ADR-213), but the project
mandate is git-faithfulness everywhere.

## Decision

Fix all three divergences in the one shared helper so both consumers
(`rev-parse`, `merge`) inherit the correct behaviour:

```
refCandidates(base) = [
  base,                              // rule 1 (verbatim: full paths, HEAD, refs/stash)
  `refs/${base}`,                    // rule 2  (NEW)
  `refs/tags/${base}`,               // rule 3  (now before heads)
  `refs/heads/${base}`,              // rule 4  (now after tags)
  `refs/remotes/${base}`,            // rule 5
  `refs/remotes/${base}/HEAD`,       // rule 6  (NEW)
]
```

This unlocks `rev-parse stash@{N}`, `rev-parse stash`, and `merge stash` for
free, and aligns ambiguous-name resolution (a name that is both a tag and a
branch now resolves to the **tag** first, like git).

## Consequences

### Positive

- gitrevisions-faithful ref resolution across `rev-parse` and `merge`; `stash`
  becomes addressable through the standard DWIM path even though its verbs stay
  index-typed.

### Negative

- Behavioural: the heads↔tags swap changes which ref a tag-and-branch-collision
  name resolves to; existing `rev-parse`/`merge` tests that encode the old order
  must be updated, and new candidates touch resolution-order tests + mutation
  coverage.

### Neutral

- Lower-priority candidates only fire when higher ones miss, so non-colliding
  names resolve exactly as before.

## Alternatives considered

1. **Additive only (`refs/<name>`), defer order/coverage** — rejected by the
   user in favour of the complete fix; the partial fix would leave two known
   divergences in a helper that claims gitrevisions fidelity.
2. **Defer entirely / resolve `stash` only inside the stash command** — rejected:
   leaves the documented faithfulness gap unaddressed and `rev-parse stash@{N}`
   broken for users.
