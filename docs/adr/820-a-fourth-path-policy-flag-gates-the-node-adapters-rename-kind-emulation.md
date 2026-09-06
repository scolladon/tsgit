---
subjects:
  - src/adapters/node/path-policy.ts
  - src/adapters/node/node-file-system.ts
---
# 820 — A fourth `PathPolicy` flag gates the node adapter's rename-kind emulation

- **Status:** accepted
- **Date:** 2026-09-06
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-K) · **Supersedes/Refines:** refines ADR-046

## Context

On Windows, node's `fs.rename` lets a directory replace a regular file or a symlink and refuses to
replace an empty directory, where POSIX `rename(2)` refuses the first with `ENOTDIR` and performs
the second. The port contract promises POSIX kind rules on the node and memory adapters, so the
node adapter must enforce them itself on that platform, and it needs a way to know which platform
it is on. `PathPolicy` already carries three independent capability flags whose doctrine is that
each says exactly what it gates; `honoursNoFollow` is the precedent for a syscall-semantics flag
living there.

## Options considered

1. **A fourth `PathPolicy` flag, `honoursRenameKinds`** — `true` on `posixPolicy`, `false` on
   `windowsPolicy`, set through `PathPolicyCapabilities` (designer's recommendation) — pros: one
   platform seam, the same shape and naming as `honoursNoFollow`, injectable from any host / cons:
   every hand-built policy in the tests gains a field.
2. **Reuse `honoursNoFollow`** — pros: no new field / cons: encodes a coincidence between `open(2)`'s
   symlink behaviour and `rename(2)`'s kind behaviour, and silently falsifies the carried
   equivalence note that `isSymlinkLeaf` is that flag's only caller.
3. **A separate adapter-internal capability record injected beside `PathPolicy`** — pros: keeps the
   interface about paths / cons: a second platform seam and a fourth constructor parameter for one
   boolean.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** A platform capability that decides
whether the node adapter must fall back to an explicit probe because the platform's own syscall
does not enforce a rule is its own `PathPolicy` flag, named for what the syscall honours. The
rename-kind fallback reads `honoursRenameKinds`; `posixPolicy` sets it `true`, `windowsPolicy`
sets it `false`, and the interface stays internal to the node adapter.

## Consequences

The Windows arm is reachable through dependency injection on every host, which is what lets the
linux mutation runner cover it. `honoursNoFollow` keeps its single caller and its equivalence note.
A policy built by hand in a test must now name the fourth flag; the compiler points at each one.
