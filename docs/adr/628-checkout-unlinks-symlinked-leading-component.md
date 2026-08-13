# 628 — Checkout writes unlink a symlinked leading component at the command layer

- **Status:** accepted
- **Date:** 2026-08-13
- **Design:** docs/design/git-parity-containment.md (DC-6) · **Supersedes/Refines:** refines [ADR-341](341-always-unlink-before-regular-working-tree-write.md)

## Context

Pinned (git 2.55.0): checking out `dir/file` where `dir` is a symlink — outside-pointing
or intra-repo — **unlinks the symlink, creates a real directory, and writes inside the
repo**. tsgit today diverges in both sub-cases: it refuses when the link resolves
outside a root and silently writes **through** the link when it resolves inside.

## Options considered

1. **Adapter keeps the parent-realpath refusal as a backstop; the command layer unlinks
   the symlinked component first, beside ADR-341's `rmIfExists`** (design
   recommendation).
2. The adapter itself unlinks a symlinked leading component during `mkdir` — puts
   working-tree policy in the adapter, which cannot know whether the caller is a
   checkout or an arbitrary write.
3. Adapter backstop only, command-layer parity deferred — leaves a known divergence in
   the pillar that must stay faithful.

## Decision

**adopted-as-recommended (no user judgment).** Option 1. The shared working-tree writer
detects a symlinked leading component (ADR-626's shared scan), unlinks it, creates the
real directory, then writes — matching git's pins for both the outside-pointing and the
intra-repo link. The adapter's write-guard refusal stays: any write that would actually
land outside every root still throws `PERMISSION_DENIED` before touching disk.

## Consequences

- Both divergent sub-cases become git-identical; the outside target stays byte-identical
  (interop-pinned).
- Working-tree policy stays in the command layer; the adapter remains policy-free.
- An arbitrary (non-checkout) write through a symlinked parent that stays inside the
  roots keeps working — only the checkout path unlinks.
