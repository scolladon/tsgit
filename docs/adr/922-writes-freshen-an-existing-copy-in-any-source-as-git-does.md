---
subjects:
  - src/application/primitives/write-object.ts
  - src/ports/file-system.ts
  - src/adapters
---
# 922 — Writes freshen an existing copy in any source, as git does

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-10) · **Supersedes/Refines:** refines ADR-915, ADR-226

## Context

git's `write_object_file` calls `odb_freshen_object`: if the object exists in any source (cruft
packs excluded), it bumps the mtime of the holding loose file or `.pack` and skips the write; only
when freshening fails does it write a local loose copy (Pins W1, W2, W2b, W3). The freshen protects
a just-reused object from `gc --prune=<expiry>` in the store that holds it. tsgit has no pre-write
probe today and already writes a duplicate loose copy of objects the primary holds packed.

## Options considered

1. **Probe every source, skip the write, no freshen** (designer recommendation) — cons: loses git's prune protection.
2. **Full git freshen** — a set-mtime capability on the port across node, memory and browser; local loose copy when freshen fails — pros: faithful / cons: a write outside the repository.
3. **Probe the primary only** — cons: duplicates alternate objects.

## Decision

**User-ratified — option 2.** Before deflating, `writeObject` probes every source in order; on a
hit it freshens the holding file (loose file, or the `.pack` — never `.idx`/`.rev`) and skips the
write; if the freshen fails it writes a local loose copy. This applies to the primary as well as
to alternates. The set-mtime operation outside the repository is confined to the alternate's
objects dir (ADR-915).

## Consequences

- A new `FileSystem` port operation (set mtime) in all three adapters, a write-surface audit
  entry, and a security-review sign-off for the out-of-repository mtime write.
- The "probe-before-deflate" half of backlog 31.10 (d-ii) lands here; 31.10 builds on it.
