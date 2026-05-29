# ADR-189: Multi-base `mergeBase` — single array-returning API

## Status

Accepted (at `c232f238a1b7b45c9513b09b4c11c78aa6da430b`)

## Context

The merge-base primitive must grow from "one best common ancestor of two commits" to cover Git's `--all` (every best common ancestor) and `--octopus` (n-way) modes. The existing signature is:

```ts
mergeBase(ctx: Context, a: ObjectId, b: ObjectId): Promise<ObjectId | undefined>
```

Three shapes were considered:

- **A** — keep `mergeBase(a,b)` unchanged; add `mergeBases(a,b)` and `octopusMergeBases(commits)`.
- **B** — keep `mergeBase(a,b)`; add one `mergeBases(commits, { octopus? })`.
- **C** — replace with a single `mergeBase(commits, opts)` returning an array (breaking).

## Decision

Adopt **C**. The primitive becomes a single, array-returning function whose two flags mirror the Git CLI exactly:

```ts
mergeBase(
  ctx: Context,
  commits: readonly ObjectId[],
  options?: { readonly all?: boolean; readonly octopus?: boolean },
): Promise<readonly ObjectId[]>
```

- `commits[0]` is `one`, `commits[1..]` are the others. Empty `commits` is rejected with `invalidWalkInput`.
- Default (`all` falsy): return at most one base — the lexicographically smallest of the reduced set (or `[]` when unrelated). Mirrors `git merge-base` printing the first.
- `all: true`: return the full reduced set of best common ancestors (`git merge-base --all`).
- `octopus: true`: iterative pairwise fold across all commits (`git merge-base --octopus`); `all` still controls truncation.
- Result is always `readonly ObjectId[]`, sorted lexicographically for determinism.

The single consumer, `application/commands/merge.ts`, migrates to `const [base] = await mergeBase(ctx, [ourId, theirId])` — `base` stays `ObjectId | undefined`, so the downstream `=== ourId` / `=== theirId` logic is unchanged.

## Consequences

### Positive

- One function covers all four CLI behaviours (default / `--all` / `--octopus` / `--octopus --all`); 1:1 with Git's flag surface.
- No second/third export to learn; the array return type is honest about multiplicity (criss-cross yields >1 base).
- `commits: readonly ObjectId[]` naturally carries both the 2-commit and n-commit cases.

### Negative

- Breaking change to the primitive and to `repo.primitives.mergeBase`; every call site and the existing unit tests are rewritten in this PR.
- Callers wanting a single base must destructure (`const [base] = …`).

### Neutral

- Lexicographic tie-breaking for the single-base case inherits the prior behaviour (the old impl sorted); not re-litigated here.
- Pre-v1 library, no external consumers — the breakage is contained to this repo.
