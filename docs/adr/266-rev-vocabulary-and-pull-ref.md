# ADR-266: Standardise the commit-ish parameter on `rev`; `pull` takes a `ref`

## Status

Accepted (at `7f761e4c`)

## Context

The 23.4 API review (finding **S3**) found the "which commit-ish" parameter
spelled five different ways across the command surface: `rev` (`blame`), `from`
(`log`, `diff`), `target` (`merge`, `reset`), `input` (`describe`, `show`), and
`branch` (`pull`). One idea, five names — needless surface to memorise.

The standardisation target is **`rev`** for a single commit-ish, with
**`from`/`to`** reserved for genuine two-endpoint **ranges** (so `diff` keeps
`from`/`to`; `log`'s single-start `from` becomes `rev`). Seven of the eight are
unambiguous renames.

`pull` is the exception. Its parameter is **not** a general commit-ish: it is a
**remote branch short-name** that `pull` resolves as
`refs/remotes/<remote>/<branch>`. A caller cannot pass an oid, `HEAD~3`, or an
arbitrary rev there — only a name that exists as a branch on the remote. Folding
it into `rev` would advertise a capability the parameter does not have. Three
ways to treat it:

1. **Keep `branch`** — honest, but leaves a fifth name standing, partly defeating
   the standardisation.
2. **Rename to `rev`** — maximal uniformity, but misrepresents a ref name as an
   arbitrary commit-ish.
3. **Rename to `ref`** — accurate (it *is* a ref name), at the cost of a second
   vocabulary word alongside `rev`.

## Decision

Adopt a **two-word vocabulary** with precise, non-overlapping meanings:

- **`rev`** — a **commit-ish**: anything that resolves to a commit (full/abbrev
  oid, `HEAD`, `~`/`^` navigation, tag, branch, reflog selector). Used by
  `blame`, `log`, `merge`, `reset`, `describe`, `show`.
- **`from`/`to`** — the two endpoints of a **commit/tree range**. Used by `diff`.
- **`ref`** — a **literal ref name** (not peeled, not navigated). Used by `pull`,
  whose `branch` field is renamed **`ref`**.

So `pull`'s `branch` becomes **`ref`** (option 3), not `rev`. The distinction is
load-bearing: `rev` promises commit-ish resolution; `ref` promises only that the
name is looked up as a ref. Conflating them under `rev` would be the misleading
outcome option 2 warned against, and `branch` (option 1) leaves the surface
inconsistent. `ref` is the smallest honest vocabulary that still removes the
five-name sprawl.

All renames are **breaking** (renamed fields/positional params), which the 23.4
window permits with no release-bundling and **no compat aliases**, matching the
clean breaks 23.4a and 23.4d already took. The change is otherwise
**behaviour-preserving**: no SHA, ref, reflog, on-disk state, refusal, or result
shape moves.

## Consequences

### Positive

- One word (`rev`) for a commit-ish everywhere it is one; `from`/`to` unambiguously
  signals a range; `ref` accurately names `pull`'s remote-branch input.
- The `rev`/`ref` split documents an API contract: `rev` inputs accept the full
  rev-parse grammar, `ref` inputs do not — the name tells the caller what is legal.
- Removes the five-name sprawl S3 flagged without overstating any parameter's
  capability.

### Negative

- Two vocabulary words instead of one — a caller must learn that `pull` is `ref`,
  not `rev`. Mitigated: `pull` is the *only* `ref` consumer, and its parameter
  genuinely differs in kind.
- Breaking for every caller of `log`/`merge`/`reset`/`pull` option fields and the
  `describe`/`show` signatures. Acceptable inside the 23.4 breaking window.

### Neutral

- `diff` is named in S3 but does not rename — it is the canonical owner of the
  reserved `from`/`to` range words.
- `checkout`'s `target`, `branch.rename`'s `from`/`to`, and the
  `revert`/`cherryPick`/`rebase` `revisions` arrays are out of scope (distinct
  concepts; see the design doc's scope boundaries).
