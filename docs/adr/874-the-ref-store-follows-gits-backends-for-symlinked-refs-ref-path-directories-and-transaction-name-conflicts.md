---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/primitives/atomic-write.ts
  - src/application/primitives/record-ref-update.ts
  - src/application/primitives/reftable-transaction.ts
  - src/domain/refs/index.ts
  - src/application/commands/rev-parse.ts
  - src/application/commands/internal/commit-ish.ts
---
# 874 — The ref store follows git's backends for symlinked refs, ref-path directories and transaction name conflicts

- **Status:** accepted
- **Date:** 2026-09-15
- **Design:** docs/design/session-caches-faithfulness-addendum.md (Ref-store scope folds: SL, ED, PP, DW, TX pins) · **Supersedes/Refines:** refines ADR-868 (its symlink rule now covers every loose ref) and ADR-871 (its pruning and refusal data)

## Context

Five ref-store differences from git 2.55.0 existed before this change set and were folded into it by
the user on 2026-09-15:

1. **A symbolic link as a loose ref.** git's `read_ref_internal` `lstat`s every loose ref: a link whose
   text is a `refs/` refname is a symref, never followed; any other text is read through, and a
   followed `ENOENT` is a missing ref with no packed fallback. The loose iterator `stat`s each link
   entry and drops one that does not resolve. tsgit applied the rule to `HEAD` only; `refs/heads/z →
   refs/heads/side` read as missing and `updateRef` replaced the link (SL1–SL18).
2. **An empty directory at a ref path.** git removes a tree of empty directories at the loose or log
   path and writes; a tree holding anything else refuses, naming a ref under it or the directory.
   tsgit refused `PERMISSION_DENIED` on the lock path (ED1–ED10).
3. **`pack-refs --all`** removes the loose directories its pruning empties, below a refname's first two
   components; tsgit left them (PP1).
4. **DWIM over a chain deeper than the reading cap.** git skips the candidate with a warning and tries
   the next. The brief expected tsgit to throw `REF_CHAIN_TOO_DEEP`; probing showed every tsgit DWIM
   sweep already moves on (DW1–DW6).
5. **Names that collide inside one transaction.** git's `refs_verify_refname_available`, with every
   transaction name as `extras`, refuses creating `d` while deleting `d/x`, two prefix-related
   creates, and a create under an absent delete, on both backends, before anything is written.
   tsgit's files store applied a `[delete d/x, set d]` list in order and wrote the first half of
   `[set f, set f/x]`; its reftable store wrote them all (TX1–TX12).

## Options considered

Per item, three options were weighed: **follow git**, **keep tsgit's answer**, or **record a backlog
entry**.

1. **Symbolic links.** Follow git (chosen): the read decides by the leaf, so a regular file must not
   pay for the check. Detection alternatives measured by call count: `lstat` before every read (git's
   own sequence, `+1` per successful read), `lstat` only after a failed read (`+1` per miss — misses
   dominate DWIM sweeps and packed repositories — and a link whose text also resolves as a path would
   still be followed), or a no-follow open (`open(O_NOFOLLOW)`, `fstat`, `read`, `close` — the same
   calls `readFile` makes, with a link surfacing as the open's refusal). Keeping tsgit's answer leaves
   `symbolic-ref` and every write through such a link wrong. A backlog entry defers a planted-state
   bug the user folded in.
2. **Empty directories.** Follow git (chosen), removing the tree under the held lock by extending
   `atomicWriteFile`'s pre-rename hook into one that performs the rename; the alternative of retrying
   the whole locked write after removing the tree without the lock opens a window git does not have.
3. **`packRefs` pruning.** Follow git (chosen), reusing the delete path's empty-parent climb once per
   distinct parent.
4. **DWIM.** Follow git — already the behaviour; the options reduce to pinning it with tests (chosen)
   or leaving it unpinned.
5. **Transaction names.** Follow git (chosen) for transactions carrying prefix-related names, on both
   backends. Running the check for every update instead would add reads to every files write and an
   O(R) pass to every reftable create, and on reftable would refuse `branch -m a a/b` and `branch -m
   c/d c`, which git allows through its rename-specific `skip` (TX12). Keeping tsgit's answer leaves a
   half-applied transaction on files.

## Decision

**Follow git's files and reftable backends for all five.**

- `resolveDirect` reads a non-`HEAD` loose ref through `openWithNoFollow(path, 'read')`. A directory or
  `FILE_NOT_FOUND` is no loose ref; `PERMISSION_DENIED` pays one `lstat`, and a link is resolved by
  its text as `HEAD`'s is (ADR-868): `refs/`-prefixed valid text is symbolic, other text is read
  through with no packed fallback. Any other refusal — the browser adapter's unsupported no-follow
  open included — takes the `readUtf8` reader unchanged. The loose walk `stat`s link entries: a
  directory is descended, a failure drops the entry.
- `atomicWriteFile`'s hook runs the rename. `writeLooseRef` renames over a tree of empty directories
  after removing it (git's `remove_dir_recurse`, stopping at the first entry that is not a directory);
  a tree that does not empty refuses `FILE_EXISTS` naming the smallest ref under the name, else
  `DIRECTORY_NOT_EMPTY` naming the loose path. A delete of a ref absent from `packed-refs` does the same
  under its locks before the rewrite. A reflog append over an empty tree removes it and appends.
- `packRefs` climbs `pruneEmptyParents` from each distinct parent of a pruned loose file.
- DWIM is pinned by unit and interop tests; no source changes.
- A domain function applies git's availability order (prefixes shortest first, existing then
  transaction names; then the smallest existing ref under the name; then the smallest transaction
  name under it). It runs when two of a transaction's names are prefix-related, over each absent
  name that does not require an old value: on files before any lock, names with a file at a prefix,
  a directory at the path or an earlier transaction name under them first; on reftable after the
  compare-and-swap under the stack lock, in update order. A conflict above refuses `NOT_A_DIRECTORY`
  and below refuses `FILE_EXISTS`, naming the blocking name's loose path — the data the files store's
  existing refusals carry, a packed or reftable ref included. git returns `TRANSACTION_NAME_CONFLICT`
  for every one of those messages.

Where git's backends differ in which name a two-sided conflict is reported against (TX4, TX6, TX7),
each tsgit backend reports the name its git backend does.

## Consequences

- `symbolicRef`, `resolveRef`, `updateRef`, `branch.delete`, `packRefs` and every enumeration agree
  with git on a symlinked loose ref. Loose reads cost the same calls on POSIX and in memory; Windows
  pays one `lstat` per read or miss inside the adapter; the browser pays one rejected call.
- Writes and deletes over an empty directory succeed; a blocked directory refuses with
  `DIRECTORY_NOT_EMPTY` instead of `PERMISSION_DENIED`.
- `packRefs` leaves no emptied namespace directories.
- A transaction with prefix-related names refuses before anything changes on both backends, and a
  delete of an absent ref in such a transaction can now refuse.

Residuals, recorded in the design: a read-through link whose target `pack-refs` prunes first (git keeps
the link after a reported error); a non-empty log directory (git refuses before writing the ref; tsgit
writes the ref, then the append refuses); refusal priority between a name conflict and a
compare-and-swap mismatch in one transaction; single-update availability checks (files under a
packed-only ref, an absent delete over refs, reftable altogether) and `branch -m` across a
directory/file boundary; `fsck`'s `symlinkRef` warning.

**Migration notes.** A loose ref that is a symbolic link to `refs/…` now reads as a symref and writes
through to its target unless `noDeref` is set. A write over an empty directory at a ref path succeeds
where it refused `PERMISSION_DENIED`, and a non-empty one refuses `DIRECTORY_NOT_EMPTY`. `packRefs`
removes emptied directories under `refs/`. A single `applyRefUpdates` naming both `d` and `d/…`
refuses `FILE_EXISTS` or `NOT_A_DIRECTORY` before any change, on the reftable backend too.
