---
subjects:
  - src/ports/file-system.ts
  - src/adapters/node/node-file-system.ts
  - src/adapters/memory/memory-file-system.ts
  - src/adapters/browser/browser-file-system.ts
  - src/application/primitives/internal/write-working-tree-file.ts
  - src/application/primitives/apply-changeset.ts
---
# 1013 — FileSystem.write takes a creation mode and resolves the written file stat

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** applies ADR-226

## Context

git's checkout creates a file with `open(O_CREAT|O_EXCL, (mode & 0100) ? 0777 : 0666)`, writes it, `fstat`s the descriptor, and never `chmod`s (design §D1.6). tsgit `chmod`s to fixed 644/755 and ignores the umask (pin T1 vs M1), and pays eight syscalls per file to git's four. The port has no way to pass a creation mode or return the written file's stat.

## Options considered

1. Widen `write`/`writeStream`: `options?: { mode }`, resolve a `FileStat` (recommended).
2. A new optional `createFile` method with a write+chmod+lstat fallback.
3. Node-only chmod-free creation behind a `PathPolicy` flag.

## Decision

**User-ratified — option 1.** **User-ratified fold:** checkout creates files with git's mode, the process umask applied by the platform, and drops the `chmod`.

## Consequences

- Breaking change for third-party `FileSystem` adapters, which must now return a stat from `write`/`writeStream`: a semver-major signal.
- Under umask 027 checkout creates 640/750 files, as git does.
- Windows creation mode and descriptor stat are verified only by CI's Windows legs.
