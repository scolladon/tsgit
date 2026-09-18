# Upgrade to v5

v5 is a faithfulness release. Every change below moves a surface that used to answer its own way onto the answer the `git` binary gives — object reads that git streams, ref updates that git verifies and dereferences, reflog expiry that reads git's own configuration keys and clocks, and a memory adapter that resolves symlinks and refuses the way the Node one does. Nothing here was added for its own sake: each item is a place tsgit and git disagreed, and git won.

There are no renamed exports and no removed commands. The breaking part is behaviour — calls that used to throw may now succeed, calls that used to succeed may now refuse, and a few return values changed shape at the margins. Read the sections that cover the surfaces you use; if you only read and write objects, the first section is enough.

## Object reads

**A loose blob whose stored header lies about its size is now readable.** `readObject`, `readBlob`, `catFile`, `streamBlob` and `checkout` all serve its real inflated bytes instead of refusing, because that is what git's streaming tier does. `verifyHash: true` still refuses it with `OBJECT_HASH_MISMATCH`, and a size-lying commit, tree or tag still refuses `INVALID_OBJECT_HEADER` — git only streams blobs. If you relied on a read throwing for such an object, gate on `verifyHash` instead.

**`catFile` and `catFileBatch` report the stored header's size claim.** The `size` on an entry is now what the loose header says, matching `git cat-file --batch` and `git cat-file -s`. For every honest object that is the content length, so nothing changes; only a corrupt header makes the two differ. `readObjectMetadata` is unchanged and stays content-derived — use it when you want the real byte count.

**`streamBlob` against a loose non-blob refuses at the `await`, not at the first chunk.** `UNEXPECTED_OBJECT_TYPE` now arrives when you await the call rather than when you start pulling from the returned stream. Callers that wrapped only the iteration in `try`/`catch` need to move the handler up to the call itself.

## `updateRef` and ref writes

This is the largest group. `updateRef` was a thin compare-and-swap over one ref file; it is now git's ref transaction — it verifies the object it is about to point at, walks symbolic refs, and deletes the way `git update-ref` deletes.

**`updateRef` verifies its target before the compare-and-swap.** A missing object refuses `OBJECT_NOT_FOUND`; bytes that do not hash to the id given refuse `OBJECT_HASH_MISMATCH`; a commit or tag git's own parser rejects refuses `INVALID_COMMIT` or `INVALID_TAG`; and a non-commit written to `HEAD` or `refs/heads/*` refuses `UNEXPECTED_OBJECT_TYPE` with `expected: 'commit'`. The type rule keys off the name you passed, not what a symref resolves to. If you pass a wrong `expected` *and* a bad target, you now get the target refusal rather than `REF_UPDATE_CONFLICT`. Deletes and symbolic writes are not verified. Budget for one extra object read and hash per verified update.

**A symlinked ref whose link text is not a valid `refs/`-prefixed name is read through.** Previously such a `HEAD` refused `INVALID_REF`; now the linked file's own content decides, exactly as git's `read_ref_internal` does — a raw object id reads as a direct ref, a `ref: …` line as a symbolic one. A `commit` through such a `HEAD` then replaces the link with a regular file when it was direct, or advances the named branch when it was symbolic.

**`updateRef(name, <null id>, …)` deletes the ref.** Writing the all-zeroes id used to store a ref holding the null id; it is now the same delete as `delete: true`, matching `git update-ref <ref> 0{40}` — compare-and-swap honoured, the ref's own reflog removed, no target verification. If you were using the null id as a tombstone value, switch to an explicit delete or to a real id.

**`updateRef` dereferences symbolic refs.** Writing or deleting through a symref now changes the ref it points at and leaves the symref in place, as `git update-ref` does. Every symbolic ref walked gets a reflog entry, and so does a `HEAD` that names one; `expected` is compared against the target's value, not the link's; a symref cycle refuses `REF_CYCLE_DETECTED`; there is no depth cap. Pass `noDeref: true` (git's `--no-deref`) to act on the name itself. One detail worth knowing if you read reflogs byte-for-byte: the old id of a `HEAD` entry that came through a symref is the null id on the files backend and the resolved id on reftable, because git's two backends write it differently.

**Deleting the ref `HEAD` names appends to `logs/HEAD`.** Every delete path — `delete: true` and the null id alike — now writes `<old> 0{40} <message>` there. `delete: true` accepts an optional `reflogMessage` to supply that text.

**Deleting a ref that does not exist succeeds.** It used to refuse `REF_NOT_FOUND`; git treats a delete of an absent ref as a no-op, and so does tsgit. The porcelain is unchanged: `branch.delete`, `tag.delete` and `remote.remove` still refuse an unknown name before they get anywhere near the transaction.

**Packed refs can be deleted.** A packed-only or loose-and-packed ref used to refuse `UNSUPPORTED_OPERATION`, or delete the loose copy and resurrect the packed value underneath. Now `packed-refs` is rewritten without the entry, under git's canonical header and sort order.

**Deletes take the same locks git takes.** A held `packed-refs.lock` refuses every delete with `RESOURCE_LOCKED` carrying `resource: 'ref'` and the lock path; a held `<ref>.lock` refuses `REF_LOCKED` with the ref name — including for a ref that does not exist, since git takes the lock before it looks. As a consequence, `fetch({ prune: true })` now deletes packed-only tracking refs, and no longer prunes a symbolic `refs/remotes/<remote>/HEAD`.

## Reflogs

**`reflog({ action: 'expire' })` with neither `ref` nor `all` does nothing.** It returns `{ kind: 'expire', removed: 0, kept: 0 }` instead of expiring `HEAD`'s log. git does not default the target to `HEAD`, so neither does tsgit. Pass `ref: 'HEAD'` explicitly if that was what you wanted.

**The default expiry clocks are 30 days total and 90 days unreachable.** git's documentation says 90/30; git's binary has them the other way round, and the binary is what tsgit matches. Two consequences: reachable entries between 30 and 90 days old now expire on a default expire, and a default expire does no reachability walk at all, because the unreachable cutoff can never bite under these defaults. Pass `expire` and `expireUnreachable` explicitly if you need the documented pair.

**A single-ref `reflog expire` resolves its target the way git does.** Short names go through the same DWIM as everywhere else; a symbolic ref — `HEAD` included — with no log of its own expires its target's log; and a tip naming a missing object now expires by clock instead of throwing `OBJECT_NOT_FOUND`. Several cases that used to produce assorted errors now all refuse `REFLOG_NOT_FOUND` carrying the argument exactly as you passed it: a deleted ref whose log survives, a dangling symref, an unborn `HEAD`, an invalid name (previously `INVALID_REF`), and ref content that does not parse.

**`branch.rename` of the checked-out branch writes the two `logs/HEAD` entries git writes.** It used to write none. You now get `<id> 0{40}` followed by `0{40} <id>`, both messaged `Branch: renamed refs/heads/<from> to refs/heads/<to>`.

**On the reftable backend, `branch.rename` writes git's branch-log shape.** The renamed branch's log is now its own history plus `<id> 0{40}` plus `0{40} <id>`, where it used to be a single `<id> <id>` entry; and a forced rename merges the destination's history by update index instead of replacing it. The files backend is unchanged.

**`remote.rename` carries reflogs across.** A logged tracking ref keeps its history and gains an `<id> <id> remote: renamed <old ref> to <new ref>` entry — previously the history was dropped and replaced with a single `0{40} <id>` entry. An unlogged ref stays unlogged on the files backend. `refs/remotes/<from>/HEAD` is now re-pointed at `refs/remotes/<to>/…` instead of being left behind, with its log written per backend.

## Config

**`gc.reflogExpire`, `gc.reflogExpireUnreachable` and their `gc.<pattern>.*` forms are honoured.** Reflog expiry now reads these keys from the repository-local configuration (no global or system scope, matching how git resolves them here). `refs/stash` never expires unless a pattern or an explicit flag says so. The whole configuration is validated before flags, targets or the repository-settings class are looked at, so a valueless entry anywhere refuses `CONFIG_MISSING_VALUE` and an unparseable date refuses `CONFIG_BAD_DATE_VALUE` — which now carries the offending `key`, `source` file and `line` when it comes from a config entry.

## Adapters

**`MemoryFileSystem` resolves symlinks like POSIX.** Every symlinked path component is followed on reads and writes, and `read`, `readSlice`, `readUtf8`, `stat`, `exists` and `readdir` follow the leaf too, up to 40 hops; relative link text resolves against the link's own directory, where `stat` used to resolve it against the adapter root. In practice: a read through a link returns the target's bytes instead of `FILE_NOT_FOUND`, a write through a symlinked directory lands in the target directory instead of refusing `NOT_A_DIRECTORY`, and `exists` on a dangling link is `false` where it used to be `true` — all three now agreeing with the Node adapter. Write leaves, `lstat`, `readlink`, `rm`, `rename` and `openWithNoFollow` still act on the link itself, and `mkdir` follows its leaf as Node does (a link to a directory is a no-op, a dangling link refuses `FILE_NOT_FOUND`). The browser adapter is unaffected — OPFS has no symlinks.

**`MemoryFileSystem` refuses with the Node adapter's codes.** A symlink loop is `PERMISSION_DENIED` (it was `UNSUPPORTED_OPERATION` out of `stat`, and `exists` now throws it rather than answering); reading a directory is `PERMISSION_DENIED` (was `FILE_NOT_FOUND`); `readdir` of a missing path is `FILE_NOT_FOUND` (was `NOT_A_DIRECTORY`); and any path beneath a regular file is `NOT_A_DIRECTORY` (was `FILE_NOT_FOUND`, and again `exists` now throws). Create-surface codes are unchanged. If you test against the memory adapter and assert error codes, expect to update those assertions — the payoff is that a memory-adapter test now predicts Node behaviour.

**A custom adapter may reject with a plain `{ data: { code: 'OBJECT_NOT_FOUND' } }` object.** Everywhere tsgit classifies "was this object missing?", the check is now on the rejection's shape rather than on it being an instance of `TsgitError`. A duck-typed rejection from your own adapter folds in as a missing object — `catFileBatch` yields a `missing` entry for it, promisor retry fires for it, and so on — instead of escaping as an unrecognised error.

## Commands

**`tag.create` of a lightweight tag verifies its target exists.** A missing object refuses `OBJECT_NOT_FOUND`; any existing object type is accepted. An existing tag name still refuses `TAG_EXISTS`, and it does so before the target is verified — for annotated tags too.

**`clone` refuses an advertisement that points at objects it did not get.** If the remote's HEAD branch or detached `HEAD` names a missing, corrupt or non-commit object, or a tag or remote-tracking ref names a missing or corrupt object, the clone refuses instead of writing a ref that does not resolve.

**`name-rev`'s `refs` and `exclude` patterns use git's `wildmatch` dialect.** Patterns containing `[…]` or `\` are now matched as character classes and escapes rather than as literal text. A pattern that happened to contain a bracket and matched literally before will match differently; escape it with `\` if you meant the character.

**Commands write refs through `HEAD` the way git does.** `commit`, `merge`, `reset`, `cherryPick`, `revert` and their aborts now write through `HEAD` rather than to the branch directly, so a racing update refuses `REF_UPDATE_CONFLICT` with `name: 'HEAD'`. `branch.create({ force })`, `tag.create({ force })`, the `notes` verbs and `push`'s tracking update move a symref's target instead of overwriting the symref. `branch.delete`, `tag.delete` and `remote.remove` still delete a symref itself, which is also what git does.

**`remote.rename` renames packed-only tracking refs.** It used to refuse `UNSUPPORTED_OPERATION`. The new names are written loose and the old lines leave `packed-refs`, exactly as `git remote rename` does.

## Caches and memory

**The cache family's documented ceiling is about 158 MiB, not 136 MiB.** The parsed-object memo's byte valve is now charged at measured cost rather than an estimate (about 37.7 MiB at SHA-1), and at SHA-256 the flat-tree and memo valves are sized so each still admits its full reference workload. No API changed and no default you set moves — only the number you should budget for.

## What's next

| Want to… | Read |
|---|---|
| Look up an error code's payload | [Errors](../use/errors.md) |
| See the full `updateRef` surface | [`updateRef`](../use/primitives/update-ref.md) |
| See reflog expiry's options and refusals | [`reflog`](../use/commands/reflog.md) |
| Come from `isomorphic-git` instead | [Migration guide](migrate-from-isomorphic-git.md) |
