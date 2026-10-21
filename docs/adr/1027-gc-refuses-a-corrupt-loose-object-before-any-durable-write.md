---
subjects:
  - src/application/commands/internal/gc-pipeline.ts
  - src/application/commands/maintenance.ts
---
# 1027 — gc refuses a corrupt loose object before any durable write

- **Status:** accepted
- **Date:** 2026-10-21
- **Design:** docs/design/gc-size-lying-loose-blob.md (D1, D5, G1–G3) · **Supersedes/Refines:** refines ADR-731 and ADR-732 (the gc task's write order)

## Context

Pinned on git 2.55.0: when `gc`, `repack` or `pack-objects` must read a loose blob whose body
overruns its header's size claim past the 32-byte header window, the run exits 128 with
`error: corrupt loose object '<oid>'` and `fatal: loose object <oid> (stored in <path>) is
corrupt`, and `git maintenance run --task=gc` exits 1 adding `error: task 'gc' failed`. Nothing
durable changes: no pack is registered, not even the normal pack git had already built before the
cruft `pack-objects` refused, `.mtimes` is not written and every loose file stays. The only
residue is a `tmp_pack_XXXXXX` file in `objects/pack`. tsgit's gc today writes and registers the
normal pack, then the cruft pack with the liar's real bytes, and refuses only on its post-write
verify, so a `git fsck` afterwards exits 5. With `gc.cruftPacks=false` git never reads an
unreachable, unexpired liar and exits 0; tsgit refused it from `verifyPacked`.

## Options considered

1. **Refuse the whole task before any durable write** (recommended) — pros: git's pinned
   outcome on data and on-disk state; the task failure carries the refusal / cons: every pack
   must be staged and installed only once all builds succeed.
2. **Refuse, keep today's write order** — pros: smaller change / cons: an honest normal pack
   stays registered where git registers nothing.
3. **Skip the liar and pack the rest** — cons: git never does this; a reachable object goes
   missing from the new pack.
4. **Write the real streamed bytes** — cons: today's behaviour; the pack entry is corrupt under
   `git fsck`.

## Decision

**User-ratified: option 1.** The gc task refuses the run as a whole when a pack build meets a
loose object git's whole-object read refuses. Every pack the run produces — cruft, promisor and
normal — is built, or staged outside the registered pack set, before any of them is installed;
a refusal during any build leaves the registered pack set, the `.mtimes` sidecars and every loose
file exactly as they were. The staging mechanism (build all in memory, or write each into the
quarantine and install all at the end) is the plan's call, bounded by `bench:memory`.

A survivor that this run never packed (`gc.cruftPacks=false`) is neither read nor verified, as
git never reads it: the task succeeds and the object stays loose.

Recorded divergence: tsgit leaves no `tmp_pack_*` litter. git's file is a crash artefact of a
process that died mid-write, with a random name and partial content; it is not reproducible and
tsgit's own litter sweep would remove it.

## Consequences

`maintenance` reports the refusal through `tasksFailed[{ task: 'gc', code, data }]` with no
change to its shape. `verifyPacked` verifies only the objects in a pack this run wrote. Interop
rows pin the on-disk census (registered packs, `.mtimes`, loose files) on both twins after the
refusal, and the exit 0 of the `gc.cruftPacks=false` and expired cases.
