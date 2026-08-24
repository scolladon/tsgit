---
subjects:
  - src/repository/resolve-layout.ts
  - src/repository/validate-options.ts
---
# 710 — a relative `commonDir` resolves against `cwd`

- **Status:** accepted
- **Date:** 2026-08-24
- **Design:** docs/design/common-dir-open-option.md (candidate D2) · **Refines:** ADR-657

## Context

git resolves a relative `GIT_COMMON_DIR` against the **process cwd** (measured: the
decisive probe is a value that only exists relative to one of the two candidate bases).
On the discovery route git's base is unstable — a `chdir` artefact lets validation and
resolution disagree. The argument needs one stable rule.

## Options considered

1. **Resolve against `cwd`**, exactly like `gitDir`/`workDir` via
   `resolveAgainst(cwd, value, pathPolicy)` (design recommendation) — pros: matches git's
   measured base and the two sibling options / cons: none identified.
2. **Absolute-only, refuse otherwise**, like `ceilingDirs` (ADR-657) — pros: maximally
   explicit / cons: ADR-657 exists because relative ceiling entries are *silently ignored*
   by git; a relative common dir genuinely works, so refusing is strictly less capable.
3. **Resolve against the resolved `gitDir`** — cons: measurably wrong (§1b row 5).

## Decision

**Option 1 — adopted-as-recommended (no user judgment).**

Relative `commonDir` values resolve against `cwd`, the same rule and the same helper the
sibling layout arguments use. git's discovery-route `chdir` artefact is deliberately not
reproduced — a single stable base is the contract of a typed argument.

## Consequences

- The three layout coordinates (`gitDir`, `workDir`, `commonDir`) share one documented
  resolution rule.
- ADR-657 stays scoped to `ceilingDirs`; this ADR records why its absolute-only posture
  does not extend here.
