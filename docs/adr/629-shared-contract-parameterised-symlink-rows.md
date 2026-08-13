# 629 — Shared port contract gains parameterised symlink-escape rows

- **Status:** accepted
- **Date:** 2026-08-13
- **Design:** docs/design/git-parity-containment.md (DC-7) · **Supersedes/Refines:** —

## Context

After the read relaxation the two filesystem adapters deliberately diverge: Node allows
a symlink read escape (git parity); Memory's 40-hop symlink follower still refuses one
(its root confinement is its addressing model). The shared contract's 84-case security
matrix is untouched (both its inputs are lexical), but this new, security-relevant
asymmetry would otherwise be pinned nowhere cross-adapter.

## Options considered

1. Leave the shared contract alone; pin per-adapter behaviour in per-adapter files —
   leaves the most security-relevant asymmetry in the library unpinned cross-adapter.
2. **Add parameterised symlink rows to the contract, expected outcome supplied per
   adapter through `FileSystemContractEnv`** (design recommendation) — the contract
   already carries `getRootDirSibling` for per-adapter inputs.
3. Add the rows and relax Memory so one expectation fits both — changes an adapter with
   no tax to recover purely for table uniformity.

## Decision

**adopted-as-recommended (no user judgment).** Option 2. The contract grows symlink
read-escape rows whose expected outcome (`allowed` for Node, `refused` for Memory) is
declared by each adapter's contract environment. A future adapter — or a future Node
regression — is caught by a shared row, not a per-adapter afterthought.

## Consequences

- The divergence is a documented, contract-pinned property, not an accident.
- The 84 existing lexical rows stay green untouched on both adapters (the regression
  wall for the retained lexical gate).
