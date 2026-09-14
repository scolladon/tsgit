---
subjects:
  - src/adapters/memory/memory-file-system.ts
  - src/ports/file-system.ts
---
# 872 — The memory adapter follows symlinks and refuses as the Node adapter does

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (Ref write and delete semantics, and memory-adapter parity: U1, U2, O2, O4; gap G1) · **Supersedes/Refines:** refines ADR-868 (its memory-adapter note moves here), ADR-815 and ADR-818; keeps ADR-811

## Context

`MemoryFileSystem` models symbolic links as map keys but resolves a path only lexically. Its
content reads never follow a link; its `stat` follows a leaf link but resolves a relative link text
against the adapter root, not the link's directory; nothing ever resolves a symlinked **intermediate**
component, and its write surfaces refuse anything beneath a link `NOT_A_DIRECTORY`. Its refusal codes
also drift from the Node adapter's, whose codes come from `mapErrno`
(`src/adapters/node/node-file-system.ts:251-282`).

Both adapters were driven through their built entries over the same tree (Node 22, POSIX policy; design
matrix Y):

- The Node adapter follows every intermediate component on reads and writes (Y1, Y2) — writes resolve
  the parent's real path and never follow the leaf (Y3).
- A symlink loop, as a component or a followed leaf, refuses `PERMISSION_DENIED` (`ELOOP`) on every
  surface, and `exists` throws it (Y4); memory reports `UNSUPPORTED_OPERATION` from `stat`, `true`
  from `exists`, and `FILE_NOT_FOUND` or `NOT_A_DIRECTORY` elsewhere.
- A read of a directory refuses `PERMISSION_DENIED` (`EISDIR`) (Y5); memory: `FILE_NOT_FOUND`.
- `readdir` of a missing path refuses `FILE_NOT_FOUND` (`ENOENT`) (Y6); memory: `NOT_A_DIRECTORY`.
- A read, `stat`, `lstat`, `readlink`, `rm`, `rename` source or `rmRecursive` beneath a regular file
  refuses `NOT_A_DIRECTORY` (`ENOTDIR`), and `exists` throws it (Y7, Y8); memory: `FILE_NOT_FOUND`,
  `false`, or a silent success.
- Other differences sit outside an explicit errno arm or under an earlier record: a non-directory at a
  create surface's immediate parent and a dangling component give `mkdir -p`'s codes (Y10, Y11 —
  ADR-811 kept memory's); `rm` of any directory and `readlink` of a non-link fall to the default arm
  (Y13, Y14); opening a directory for reading succeeds (Y15); the hop limit is the platform's — 32 on
  macOS, 40 on Linux (Y16).
- `mkdir` is the one write surface whose leaf the Node adapter follows (it always passes `recursive:
  true`): a link to a directory succeeds with nothing created, a dangling link refuses `FILE_NOT_FOUND`
  without creating the target, a link to a file `FILE_EXISTS`, a loop `PERMISSION_DENIED`, a link to an
  existing directory outside the root succeeds (Y12, Y17). Memory refuses every link leaf
  `NOT_A_DIRECTORY`.

## Options considered

Symlink resolution (G1, then U1):

1. **Resolve every component, following the leaf on reads and not on writes, with the 40-hop limit**
   (chosen by the user) — pros: every read and write lands where the Node adapter's does, and the
   `FileSystem` contract suite, run against both, pins each surface. Cons: every memory call walks its
   path's segments.
2. **Follow a leaf link on reads only** (G1 as first decided) — cons: a path through a symlinked
   directory still misses on memory and still refuses on write.
3. **Refuse any path beneath a symlinked component explicitly** — cons: refuses what the Node adapter
   serves.

`mkdir` on a symlink leaf (design O2):

1. **Follow the leaf, as the Node adapter does** (chosen by the user) — pros: `mkdir -p` through a link
   behaves the same on both adapters. Cons: the one create surface whose leaf is followed.
2. **Keep `NOT_A_DIRECTORY`** — cons: refuses a no-op Node performs.
3. **Refuse `PERMISSION_DENIED`**, as the other write leaves do — cons: refuses what Node accepts.

Refusal codes (U2):

1. **Take the Node adapter's code wherever an explicit `mapErrno` arm produces it, unless a ratified
   record or the leaf rule decides otherwise** (chosen by the user) — pros: a caller branching on a
   code sees the same code on both adapters for loops, directories, missing directories and paths
   beneath files. Cons: `exists` on a path beneath a file or through a loop now throws on memory, as it
   already does on Node.
2. **Keep memory's codes** — cons: code paths tested only on memory keep branching on codes Node never
   produces.
3. **Align only the loop code** — cons: leaves the other explicit-arm differences.

## Decision

**Option 1 for both.**

One private walk replaces the leaf-only follower: it collapses the requested path lexically (as the
Node adapter's `resolveRead` does), then walks segment by segment; a symlinked component — or the
leaf, on `read`, `readSlice`, `readUtf8`, `stat`, `exists` and `readdir` — is replaced by its link
text, resolved against the link's own directory, and the walk restarts from the root on the joined
path. Every hop is re-checked by the adapter's structural containment, so a followed target outside
the root still refuses `PERMISSION_DENIED` (the contract's `symlinkReadEscape: 'refused'` posture).
More than 40 hops refuse `PERMISSION_DENIED`. `lstat`, `readlink`, `openWithNoFollow`, `rm`,
`rename`, `atomicRename`, `rmRecursive`, `chmod` and every create surface but `mkdir` walk intermediates
only; their leaf behaviour is unchanged (ADR-815, ADR-818). A create files its key at the walked path, so
nothing is ever filed beneath a symlink key and the pairwise-disjoint key sets ADR-818 records hold.

Refusals taken from the Node adapter: a loop → `PERMISSION_DENIED` on every surface, `exists`
included; a read of a directory → `PERMISSION_DENIED`; `readdir` of a missing path or a dangling
link → `FILE_NOT_FOUND`; any surface addressing a path beneath a regular file → `NOT_A_DIRECTORY`,
`exists` included.

`mkdir` follows its leaf: a link to a directory is a no-op, a dangling link refuses `FILE_NOT_FOUND`
and creates nothing, a loop refuses `PERMISSION_DENIED`. A link to a file refuses `NOT_A_DIRECTORY`, the
code ADR-811 keeps for a file where a directory is created, and a link leaving the root refuses
`PERMISSION_DENIED` (containment) where the Node adapter's `mkdir` is a no-op.

**U2 is scoped to read-side and loop codes** (design O4, chosen by the user: keep ADR-811). Every create
surface keeps the memory adapter's own codes — a non-directory at the immediate parent and a dangling
component still refuse `NOT_A_DIRECTORY` (Y10, Y11) — as ADR-811 decided and continues to govern.

The browser adapter is unaffected: OPFS has no symbolic links, and its `symlink` and `readlink` refuse
`UNSUPPORTED_OPERATION`.

## Consequences

A memory-adapter caller reads through a symlinked file or directory where it got `FILE_NOT_FOUND`,
writes through a symlinked directory where it got `NOT_A_DIRECTORY`, sees `exists` false on a dangling
link, and meets the Node adapter's code for a loop, a directory read, a missing `readdir` and a path
beneath a file. Production code whose memory-only tests relied on the old codes surfaces in the
enumerated regression run; the Node adapter already behaved this way.

Comments that name memory's old `readdir` code (`gc-pipeline.ts` `isFanoutDirAbsent`,
`pack-registry.ts` `isMissingPackDir`, `shallow-set.ts`, `loose-oid-cache.ts`, `midx-source.ts`) go
stale; their code accepts both codes and keeps working. The port's `readdir` comment gains
`FILE_NOT_FOUND`, which moves `reports/api.json`.

Residuals, recorded:

- **`rm` of a directory** (Y13): the Node adapter refuses any directory with `UNSUPPORTED_OPERATION`
  (`ERR_FS_EISDIR`, `mapErrno`'s default arm); the memory adapter removes an empty one and refuses a
  non-empty one `DIRECTORY_NOT_EMPTY`. The port documents `rm` as "Remove file or empty directory" — the
  memory adapter's answer — so the difference is Node's, and it is not folded.
- **`readlink` of a non-link** (Y14): the Node adapter refuses `UNSUPPORTED_OPERATION` (`EINVAL`, default
  arm); the memory adapter refuses `FILE_NOT_FOUND`, which is what the port documents ("Throws
  FILE_NOT_FOUND if not a symlink"). Not folded.
- **`openWithNoFollow(dir, 'read')`** (Y15): the Node adapter opens a handle — an operating-system
  outcome, no errno and no mapping; the memory adapter refuses `FILE_NOT_FOUND`. The port documents no
  directory case. Not folded.
- **Hop limit** (Y16): 40, the Linux value; macOS allows 32.
- **`mkdir` through a link leaving the root** (Y17): refused on memory, a no-op on Node.
- **Lexical `..`**: a `..` inside a link text after a symlinked component is collapsed lexically, where
  POSIX resolves it physically.

ADR-868's memory-adapter note now points here.
