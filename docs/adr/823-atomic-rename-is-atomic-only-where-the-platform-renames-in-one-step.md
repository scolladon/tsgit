---
subjects:
  - src/ports/file-system.ts
  - src/adapters/node/node-file-system.ts
---
# 823 — `atomicRename` is atomic only where the platform renames in one step

- **Status:** accepted
- **Date:** 2026-09-06
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-O) · **Supersedes/Refines:** refines ADR-813

## Context

The node adapter's Windows arm replaces an empty directory destination in two steps, removing the
empty directory and then renaming, because the platform's own rename refuses to replace a directory.
`atomicRename` delegates to `rename`, so for that one arrangement on that one platform it is no
longer a single operation. Git's own Windows compatibility layer performs the same removal and retry
in the same place. No caller of `atomicRename` in the library renames a directory; every caller
promotes a lock or temporary file onto a file.

## Options considered

1. **Scope the atomicity claim in the port JSDoc** — atomic wherever the platform's rename honours
   the kind rules and for every non-replacing arrangement everywhere; the emulated
   empty-directory replacement is two steps, as git's is (designer's recommendation) — pros: the
   text stays true / cons: the word carries a stated exception.
2. **Make `atomicRename` refuse the replacing arrangement** — pros: the word stays literally true /
   cons: a behavioural split between `rename` and `atomicRename` that no adapter has, on an
   arrangement nothing calls.
3. **Say nothing** — cons: a false guarantee on a public port.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The port states exactly which
arrangements are one syscall. If the destination is filled between the emptiness check and the
removal, the removal fails and the caller sees `DIRECTORY_NOT_EMPTY`, the same refusal the check
would have produced.

## Consequences

`atomicRename` keeps delegating. The race degrades into the correct refusal rather than a wrong
success, and the only loss the window can cause is an empty directory removed before a rename that
then fails. Callers that need a one-step directory replacement on Windows have none, exactly as git
has none.
