# 667 — tsgit accepts every `extensions.*` git knows

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/repository-format-acceptance-gate.md (candidate D2) · **Refines:** ADR-226

## Context

git 2.55.0 knows exactly nine repository extensions. tsgit implements two (`worktreeConfig`,
`partialClone`) and two more are inert (`noop`, `noop-v1`). The remaining five change what a
reader must do: `objectFormat`, `compatObjectFormat`, `refStorage`, `preciousObjects`,
`relativeWorktrees`.

Accepting them unconditionally preserves two measured defects. A real SHA-256 repository is
read as SHA-1 and reported as `OBJECT_HASH_MISMATCH` — *unsupported* misreported as *corrupt*.
A `refStorage = reftable` repository presents as **ref-less** to tsgit's loose + `packed-refs`
reader, so any write path reconciling against "the refs that exist" operates on an empty view
of a populated repository.

## Options considered

1. **Strict allowlist** — accept the four tsgit implements or can safely ignore; refuse the
   other five (design recommendation) — pros: makes the misreads unreachable / cons: a
   deliberate divergence refusing five repositories git opens fine.
2. **Mirror git's known set** — accept all nine — pros: zero divergence at the gate / cons:
   preserves both silent misreads unless the underlying support is built.
3. **Allowlist + an explicit "known to git, unimplemented here" refuse-list** — pros: a
   distinct diagnosis / cons: a third condition and message shape for a distinction the
   caller can already draw from the name in the payload.

## Decision

**Option 2 — ratified by the user, against the design's recommendation, with scope expanded so
that acceptance is not a lie.**

The acceptance gate mirrors git exactly: all nine names are accepted at version 1, and no
extension git knows is refused. The prime directive is honoured with **no divergence at the
gate**. The user rejected the "accept and misread" cost by expanding scope instead of by
diverging: the underlying support is built in the same change.

- `preciousObjects` — honoured today by construction. tsgit has no `gc`, `prune` or `repack`
  command, so "objects are never deleted" holds; verified against the full command surface.
- `objectFormat` — real SHA-256 repository support is built (see the SHA-256 design and its
  ADRs).
- `refStorage` — a reftable ref backend is built (see the reftable design and its ADRs).
- `compatObjectFormat` — git itself refuses this on the measured build
  (`fatal: compatibility hash algorithm support requires Rust`), so there is no behaviour to
  be faithful to. It is accepted at the gate and refused precisely at the point of use.
- `relativeWorktrees` — accepted at the gate; whether it silently misreads is a measurement
  the design revision owes, and it is handled at the point of use if it does.

**The standing rule:** where tsgit cannot yet act on an accepted extension, it refuses
*precisely, at the point of use* — never by silently reading the repository wrong, and never
by refusing to open a repository git opens.

## Consequences

- No `extensions.*` divergence to document, now or later; the gate is a pure faithfulness
  surface.
- The accepted set is no longer a capability statement — support must keep pace with the set,
  or a point-of-use refusal must cover the gap.
- Two subsystems (SHA-256 object format, reftable ref storage) enter this change that no
  backlog entry anticipated.
- Point-of-use refusal codes are a new error family, distinct from the acceptance-gate codes
  of ADR-668.
