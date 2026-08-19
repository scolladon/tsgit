# 671 — Trust options are named for what they do, not for git's config keys

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D3) · **Refines:** ADR-657

## Context

git sources `safe.directory` and `safe.bareRepository` from **global and system** config — a
location the FS port deliberately cannot reach, and must not: a repository that could allowlist
itself is no gate at all (measured — git ignores a repository-local `safe.directory`). The
allowlist must therefore arrive as an `openRepository` argument. That makes the surface faithful
in **effect** and divergent in **location**, the same class ADR-657 already ratified.

## Options considered

1. **`trust?: 'ownership' | 'always'` + `trustedDirectories?: ReadonlyArray<string>`** as
   sibling top-level options (design recommendation) — pros: each field independent; reads
   correctly at the call site / cons: two fields.
2. **One union option** — `trust?: 'ownership' | 'always' | { allow: [...] }` — pros: one field
   / cons: the common case (default policy plus one allowlist entry) requires constructing a
   union arm, and it fuses "the policy" with "exceptions to it", which git keeps separate.
3. **Name them after git** — `safeDirectory?: ReadonlyArray<string>` — pros: familiar / cons:
   imports a config-key name into an argument API and invites the reader to expect the
   *location* semantics too — precisely what this diverges on.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

Both fields live at the top level of `OpenRepositoryOptions`, beside `hooks`, `command` and
`ceilingDirs` — the other trust-shaped knobs — not under `config`. Each carries a
WARNING-register JSDoc matching `hooks` / `command` / `unsafeRawAdapters`.

ADR-657's precedent is followed: tsgit names arguments after what they do.

## Consequences

- The allowlist is unreachable from repository config by construction, which is the security
  property, not a side effect.
- `reports/api.json` and the `openRepository` reference page gain the option group.
- ADR-675's `bareRepositories` joins the same group and follows the same naming rule.
