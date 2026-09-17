---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/primitives/reftable-transaction.ts
  - src/application/primitives/resolve-ref.ts
  - src/application/commands/branch.ts
  - src/application/commands/tag.ts
  - src/application/commands/checkout.ts
  - src/application/commands/internal/revision-name.ts
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/application/primitives/atomic-write.ts
  - src/application/primitives/record-ref-update.ts
  - src/application/primitives/internal/empty-directories.ts
  - src/application/primitives/internal/transaction-names.ts
  - src/domain/refs/ref-name-conflict.ts
  - src/application/commands/rev-parse.ts
  - src/application/commands/internal/commit-ish.ts
---
# 874 — The ref store follows git's backends for symlinked refs, ref-path directories and transaction name conflicts

- **Status:** accepted
- **Date:** 2026-09-15 · **Extended:** 2026-09-17
- **Design:** docs/design/session-caches-faithfulness-addendum.md (Ref-store scope folds: SL, ED, PP, DW, TX pins; round two: PR, LD, SU, RN, LS, FK, PO, TN pins) · **Supersedes/Refines:** refines ADR-868 (its symlink rule now covers every loose ref) and ADR-871 (its pruning and refusal data)

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
   `[set f, set f/x]`; its reftable store wrote them all (TX1–TX14).

### Round two (2026-09-17)

The eight residuals round one left behind, folded in by the user on the same terms:

6. **`pack-refs --all` over a read-through link.** git prunes in descending full-name order and
   re-reads each ref it deletes, so a link whose target was pruned first no longer resolves: git
   reports an error, keeps the link and still exits 0. tsgit pruned every duplicate, the link
   included (PR1–PR4).
7. **A log path that cannot be set up.** git writes every log before it renames any lockfile, so
   `there are still logs under '<path>'` leaves the ref unwritten; tsgit wrote the ref and then let
   the append refuse (LD1–LD6).
8. **The availability check for ONE update.** git checks any name it locks that turns out absent,
   whatever the transaction's size. tsgit checked only a regular file at a prefix and a loose ref
   under the name on files, and nothing at all on reftable (SU1–SU9).
9. **`branch -m` across a directory/file boundary.** git frees the source first — log staged, ref
   deleted — then creates the destination; tsgit created first and so refused both directions
   (RN1–RN4).
10. **Listing a chain that does not resolve for reading.** git's iterators drop it silently;
    `branchList` / `tagList` threw (LS1–LS4).
11. **`fsck` over a symlinked loose ref.** git warns `symlinkRef: use deprecated symbolic link for
    symref` per link under `refs/**` and still exits 0; tsgit reported nothing (FK1–FK4).
12. **Refusal priority.** git raises each update's lock-time refusal and its compare-and-swap in
    update order, the batch name check last; tsgit reported the name conflict first (PO1–PO7).
13. **The name a detaching `checkout` or a `tag` target stands for.** git runs both through its
    revision ladder — `checkout` consulting `refs/heads/<name>` ahead of it; tsgit resolved the name
    as given (TN1–TN6).

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

### Round two

6. **Pruning order.** Follow git (chosen). The duplicate probe's existing `lstat` already answers
   whether the leaf is a link, so a repository without one keeps the order-free pooled removal and
   pays nothing; only a repository holding one takes the sequential, descending pass with a re-read
   per link. Sorting every prune unconditionally would serialise a hot path for a state almost no
   repository is in.
7. **Log paths.** Follow git (chosen), by splitting the single reflog writer into a prepare half and
   a commit half and running the prepare half under the write's own lock. Probing the log path
   separately before the write would add a `stat` to every logged write; running the whole append
   first would put the log ahead of the lock's own refusals, which git raises first.
8. **Single-update names.** Follow git (chosen). On files the answer is free — a packed ref at a
   prefix or under the name reads out of the snapshot the write already loads, and every loose
   blocker already refuses through the lock or the rename. On reftable it costs one sorted-names pass
   over the already-loaded stack; seeking to `<name>/` the way git's iterator does needs a codec
   change this fold does not make, and adds no syscall either way.
9. **`branch -m`.** Follow git (chosen), for a nested pair only. Taking git's delete-then-create order
   for every rename would make every destination momentarily absent, for a shape only a nested pair
   needs.
10. **Listing.** Follow git (chosen): resolve through the reading walk and drop what it cannot
    resolve. Keeping the throw makes one hand-planted ref fail a whole listing.
11. **`fsck`.** Follow git (chosen), as a `bad-ref` finding carrying `symlinkRef` at `warning`
    severity — the shape the pass's existing findings use — contributing no exit bit.
12. **Refusal priority.** Follow git (chosen) on the files backend, whose prepare loop interleaves;
    the reftable backend already verifies every value first, which is its git counterpart's order.
13. **Target names.** Follow git (chosen), through one shared ladder rather than three copies, with
    the miss reported as `undefined` so each command keeps the refusal it already raises.

## Decision

**Follow git's files and reftable backends for all thirteen.**

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
  a loose ref under them or an earlier ref-changing update under them first; on reftable after the
  compare-and-swap under the stack lock, in update order. A conflict above refuses `NOT_A_DIRECTORY`
  and below refuses `FILE_EXISTS`, naming the blocking name's loose path — the data the files store's
  existing refusals carry, a packed or reftable ref included. git returns `TRANSACTION_NAME_CONFLICT`
  for every one of those messages.

Where git's backends differ in which name a two-sided conflict is reported against (TX4, TX6, TX7,
TX13),
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

### Round two

- `packRefs` prunes its loose duplicates in descending full-name order when any of them is a symbolic
  link, re-reading each link first and keeping one that no longer holds the packed value; a repository
  without one keeps the order-free pooled removal.
- The single reflog writer splits into a prepare half — config, the loggability gate, and the log path
  — and a commit half. The prepare half runs under the ref write's own lock, after the lock's refusals
  and before the rename, so a log path git could not set up refuses `DIRECTORY_NOT_EMPTY` naming that
  path before the ref changes. It touches the path only where git would create a log.
- A single update is name-checked exactly as a transaction's is: on files through the packed snapshot
  the write already loads (a packed ref at a prefix refuses `NOT_A_DIRECTORY`, one under the name
  `FILE_EXISTS`), on reftable through the check that previously ran for prefix-related transactions
  only.
- A branch rename whose names are `/`-bounded prefixes of one another stages the source's log, deletes
  the source, creates the destination and moves the log in — git's own order.
- `branchList` and `tagList` drop an entry whose chain does not resolve for reading.
- `fsck` reports `symlinkRef` at `warning` severity for every loose ref that is a symbolic link,
  contributing no exit bit.
- The files store raises each update's lock-time refusal and compare-and-swap in update order, and its
  batch availability check only afterwards.
- A detaching `checkout` and a `tag` target resolve through the shared revision ladder, `checkout`
  consulting `refs/heads/<name>` first.

Residuals, recorded in the design: a name conflict against an ED3-shaped blocking directory (git
raises the directory at lock time, ahead of the batch check); an update requiring a current value under
a packed blocker (git skips its availability check; the two differ only on a hand-planted state); and
reftable's sorted-names pass where git's iterator seeks.

**Migration notes (round two).** `packRefs` keeps a read-through symbolic link whose target it pruned
first, and reports it in neither count. A ref write whose reflog path is blocked refuses
`DIRECTORY_NOT_EMPTY` instead of writing the ref and then refusing `PERMISSION_DENIED`. A single
`updateRef`, `branch.create`, `symbolicRef` or delete now refuses `NOT_A_DIRECTORY` / `FILE_EXISTS`
where a ref sits above or under the name, on either backend. `branch.rename` accepts a destination
nested with the source. `branchList` and `tagList` omit an entry whose chain does not resolve instead
of throwing. `fsck` reports a `symlinkRef` warning per symlinked loose ref, with no change to the exit
code. A transaction carrying both a name conflict and a compare-and-swap mismatch reports whichever
git reports. `checkout({ detach: true })` and `tag.create`'s target accept a short name.

**Migration notes.** A loose ref that is a symbolic link to `refs/…` now reads as a symref and writes
through to its target unless `noDeref` is set. A write over an empty directory at a ref path succeeds
where it refused `PERMISSION_DENIED`, and a non-empty one refuses `DIRECTORY_NOT_EMPTY`. `packRefs`
removes emptied directories under `refs/`. A single `applyRefUpdates` naming both `d` and `d/…`
refuses `FILE_EXISTS` or `NOT_A_DIRECTORY` before any change, on the reftable backend too.
