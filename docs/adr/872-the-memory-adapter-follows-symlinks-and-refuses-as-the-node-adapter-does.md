---
subjects:
  - src/adapters/memory/memory-file-system.ts
  - src/ports/file-system.ts
---
# 872 — The memory adapter follows symlinks and refuses as the Node adapter does

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (Ref write and delete semantics, and memory-adapter parity: U1, U2; gap G1) · **Supersedes/Refines:** refines ADR-868 (its memory-adapter note moves here), ADR-815 and ADR-818; keeps ADR-811

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
  ADR-811 kept memory's); `mkdir` follows its leaf (Y12); `rm` of any directory and `readlink` of a
  non-link fall to the default arm (Y13, Y14); opening a directory for reading succeeds (Y15); the hop
  limit is the platform's — 32 on macOS, 40 on Linux (Y16).

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
`rename`, `atomicRename`, `rmRecursive`, `chmod` and every create surface walk intermediates only;
their leaf behaviour is unchanged (ADR-815, ADR-818). A create files its key at the walked path, so
nothing is ever filed beneath a symlink key and the pairwise-disjoint key sets ADR-818 records hold.

Refusals taken from the Node adapter: a loop → `PERMISSION_DENIED` on every surface, `exists`
included; a read of a directory → `PERMISSION_DENIED`; `readdir` of a missing path or a dangling
link → `FILE_NOT_FOUND`; any surface addressing a path beneath a regular file → `NOT_A_DIRECTORY`,
`exists` included.

Not taken, recorded: Y10 and Y11 keep ADR-811's `NOT_A_DIRECTORY`; Y13–Y15 are default-arm or
non-errno outcomes and the port documents memory's answers for Y13 and Y14; the hop limit stays 40.
`mkdir` on a symlink leaf keeps `NOT_A_DIRECTORY` pending the user (design O2: the Node adapter follows
it, the decision keeps write leaves no-follow).

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

Residual: a `..` inside a link text after a symlinked component is collapsed lexically, where POSIX
resolves it physically.

ADR-868's memory-adapter note now points here.
