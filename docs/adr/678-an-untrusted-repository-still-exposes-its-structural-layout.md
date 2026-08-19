# 678 — An untrusted repository still exposes its structural layout

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D10) · **Refines:** ADR-658

## Context

`repo.layout` is a synchronous, frozen read of resolved layout data (ADR-658). The trust gate
raises a new question: what does it expose when the repository is untrusted?

The constraint is measured: **`git init` succeeds inside an alien-owned repository**
(`Reinitialized existing Git repository in …`, exit 0), and `git init` in a fresh alien-owned
directory succeeds too. tsgit's `init` and `clone` must bootstrap the same way, so the refusal
cannot live in `openRepository` itself.

## Options considered

1. **The structural layout plus `untrusted: true`** — `core.bare` / `core.worktree` not applied
   (design recommendation) — pros: preserves the bootstrap route; the layout values are derived
   from discovery alone, so a caller reading them reads paths the attacker's config never
   touched, and `untrusted: true` sits in the same object saying so / cons: a new flag.
2. **`openRepository` throws** — pros: nothing untrusted is ever handed out / cons: measurably
   wrong — it removes the only route to the `init` behaviour git permits.
3. **`repo.layout` throws or returns `undefined` when untrusted** — pros: forces the caller to
   handle it / cons: turns a synchronous frozen-data read into a partial function, and hides the
   one fact a caller debugging a refusal most needs.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

`RepositoryLayout` and `RepositoryLayoutInput` gain `untrusted?: true` and `implicitBare?: true`,
following the existing `workTreeConfigBogus?: true` present-only-when-true idiom one line above
them. Flags rather than a `route` field: `route` is a resolution-time discriminant with no
meaning to a consumer, while these two are verdicts a consumer acts on.

Critically, an untrusted layout carries **only** what discovery produced. Stage 2 is skipped, so
`core.worktree` never reaches work-tree resolution and the containment root set contains no
attacker-named path — this is what structurally closes the root-set collapse to `/`.

## Consequences

- Both flags are additive and exposed through `repo.layout`; `reports/api.json` is regenerated.
- `init` and `clone` keep working on foreign-owned and fresh directories, matching git.
- The pair-with is ADR-679: the layout says *untrusted*, and the config scope reads empty.
