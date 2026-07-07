# ADR-456: Shared HEAD-branch & default-remote resolution primitives

## Status

Accepted (at `69dabf51`)

## Context

The "current branch name from HEAD" and "default remote name" resolutions are inlined
and duplicated across `pull`, `fetch`, `push`, `branch`, `status`, `submodule`, and
`rebase`. The `refs/heads/` prefix constant is redefined **8×** (as `HEADS_PREFIX`,
`REFS_HEADS_PREFIX`, `SHORT_FORM_PREFIX`) and `'origin'` is scattered as a bare literal.
Surfaced by 24.1a and deferred there as cross-cutting.

A read-only sweep found the HEAD-derivation appears in **three distinct shapes** — full
symbolic ref (`refs/heads/main` | `undefined`), short name (`main` | `undefined`), and
throw-on-detached — so a single "return the short name" primitive is *not* a drop-in for
all consumers.

## Decision

Introduce a small primitive set and migrate every consumer:

- **`branchRefFromHead(head): RefName | undefined`** — pure transform: the full symbolic
  ref when `head.kind === 'symbolic'`, else `undefined`.
- **`currentBranchRef(ctx): Promise<RefName | undefined>`** — `branchRefFromHead(readHeadRaw(ctx))`.
- **`shortBranchName(ref): string`** — domain transform stripping `HEADS_PREFIX`; `stashBranchLabel`
  shares the constant + strip only, keeping its `NO_BRANCH` sentinel.
- **`defaultRemoteName`** — a **pure function over `ParsedConfig`** (`(config, explicit, branch) → string`),
  no I/O; both tracking-aware callers already hold `config`. Resolves
  `explicit ?? branch?.remote ?? <sole remote if config.remote has exactly one> ?? DEFAULT_REMOTE`
  — the sole-remote fallback (ADR-457) makes it git-faithful for `fetch`/`pull`/`push`.
- **Constants**: `HEADS_PREFIX = 'refs/heads/'` homed in `src/domain/refs/`; `DEFAULT_REMOTE = 'origin'`
  in `src/domain/remote.ts`. Imported directly; **not** re-exported through a public barrel (no `api.json` surface).
- **Full consolidation** — migrate all 8 `refs/heads/` constant sites (`pull`, `push`, `branch`,
  `checkout`, `submodule`, `worktree`, `stash-message`, `refspec`), not only the resolution sites.
- **Submodule read path** — migrate `getRefStore(ctx).resolveDirect(HEAD_REF)` → `currentBranchRef`
  (`readHeadRaw`), proven equivalent for HEAD (both parse loose `.git/HEAD`; `resolveDirect`'s
  `missing` variant is unreachable after the existing symbolic assert).

Each consumer keeps its own guard/short/throw/fallback around the shared atom — the only shape
preserving all three HEAD-derivation behaviors byte-for-byte.

Primitive shapes, `defaultRemoteName` purity, and constant homes are **adopted-as-recommended
(no user judgment)**. Full-consolidation scope and the submodule read-path migration are
**ratified user judgment**.

## Consequences

### Positive

- Single source of truth; 8 duplicated constants collapse to 1; submodule joins the common read path.

### Negative

- Touches 10+ files across a refactor commit sequence.

### Neutral

- Internal-only — no public-API / doc-coverage change; behavior-preserving for these primitives.
  The `fetch`/`push` behavior corrections are ADR-457 and ADR-458.
